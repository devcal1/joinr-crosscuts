// The backup service (docs/plans/backup-contracts.md sections 7, 9 and 11): start (the sweep, the
// seeding, the timer), status, requestRun (Back up now), the single flight, recording in
// backup_runs, and the bells.
//
// Safety rules (the board shares this process):
//   - every export never throws, and every promise is caught: an unhandled rejection would stop
//     the board;
//   - the timer is setInterval(...).unref(), and each job has its own deadline (AbortSignal.timeout);
//   - one flight at a time (a snapshot, a copy, or a snapshot then a copy), shared by the timer and
//     Back up now;
//   - logs carry kinds, triggers, slots, reasons, exit codes, counts, bytes, durations and archive
//     names only: never a secret, an address, a path or anything a tool printed. The status JSON
//     reports each config file's STATE only.
//
// Nothing here requires the database at load: `db` arrives through start(db) and status(db).
const fs = require("fs");
const path = require("path");
const C = require("./constants");
const tools = require("./tools");
const secrets = require("./secrets");
const sentences = require("./sentences");
const schedule = require("./schedule");
const names = require("./names");
const snapshot = require("./snapshot");
const copy = require("./copy");
const ledger = require("./ledger");
const settings = require("../settings");
const notify = require("../notify");
const audit = require("../audit");
const { sydneyToday } = require("../time");

const disabled = () => process.env.BACKUP_DISABLED === "1";
const scheduleDisabled = () => process.env.BACKUP_SCHEDULE_DISABLED === "1";

const RUN_WINDOW_DAYS = 9; // a copy slot spans 7 days; the runs that can settle or retry it are newer
const RECENT = 10;
const LINK = "/users.html#backups";

let started = false;
let processStartedAt = new Date();
let timer = null;
let flight = null; // the promise of the flight in progress, or null
let current = null; // {kind, trigger, startedAt} of the job in progress

function safe(e) {
  return tools.safeErrorCode(e);
}

// ---- detail: counts, bytes, durations, archive names and states only ----------------------------

const NUMBER_KEYS = {
  snapshot: [
    "archiveBytes",
    "dbBytes",
    "migrations",
    "vacuumMs",
    "checkMs",
    "archiveMs",
    "durationMs",
    "pruned",
    "premigrateWrapped",
    "premigrateFailed",
    "needBytes",
    "freeBytes",
  ],
  copy: ["sent", "alreadyThere", "missingAfter", "bytes", "durationMs", "total", "needBytes", "freeBytes"],
};
const COUNT_KEYS = ["users", "jobs", "weekRows", "photos", "files"];
const FOLDER_KEYS = ["local", "alreadyThere", "sent", "missingAfter", "vanished", "changed", "bytes", "encrypted"];
const FILE_STATES = ["missing", "not_usable", "set"];

function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function isArchiveName(v) {
  return typeof v === "string" && (names.DB_ARCHIVE_RE.test(v) || names.PREMIGRATE_ARCHIVE_RE.test(v));
}

function pickNumbers(src, keys) {
  const out = {};
  for (const k of keys) {
    const n = num(src[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

// Unknown keys dropped; every value checked for its type (a string only where it is an archive
// name or a file state).
function cleanDetail(kind, raw) {
  const d = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = pickNumbers(d, NUMBER_KEYS[kind] || []);
  if (kind === "snapshot") {
    if (isArchiveName(d.archive)) out.archive = d.archive;
    if (d.counts && typeof d.counts === "object") out.counts = pickNumbers(d.counts, COUNT_KEYS);
  } else if (kind === "copy") {
    if (typeof d.attempted === "boolean") out.attempted = d.attempted;
    if (d.folders && typeof d.folders === "object") {
      out.folders = {};
      for (const f of C.NAS_FOLDERS) {
        if (d.folders[f] && typeof d.folders[f] === "object") out.folders[f] = pickNumbers(d.folders[f], FOLDER_KEYS);
      }
    }
    if (d.files && typeof d.files === "object") {
      const files = {};
      for (const k of ["nasUrl", "nasPassword"]) if (FILE_STATES.includes(d.files[k])) files[k] = d.files[k];
      out.files = files;
    }
    if (FILE_STATES.includes(d.passphraseState)) out.passphraseState = d.passphraseState;
  }
  return out;
}

function parseDetail(kind, text) {
  try {
    return cleanDetail(kind, JSON.parse(text || "{}"));
  } catch {
    return {};
  }
}

// ---- runs ---------------------------------------------------------------------------------------

const RUN_COLUMNS =
  "id, kind, trigger, slot, attempt, started_at, finished_at, status, reason, exit_code, detail, requested_by";

function toRun(row) {
  const kind = row.kind === "copy" ? "copy" : "snapshot";
  return {
    id: Number(row.id),
    kind,
    trigger: row.trigger,
    slot: row.slot || null,
    attempt: Number(row.attempt) || 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    status: row.status,
    reason: row.reason || null,
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    detail: parseDetail(kind, row.detail),
  };
}

function sentenceOf(run) {
  return run.kind === "copy" ? sentences.copySentence(run) : sentences.snapshotSentence(run);
}

// The API shape (section 9): {id, kind, trigger, startedAt, finishedAt, status, reason, exitCode,
// sentence, detail}.
function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    kind: run.kind,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    reason: run.reason,
    exitCode: run.exitCode,
    sentence: sentenceOf(run),
    detail: run.detail,
  };
}

function one(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row ? toRun(row) : null;
}

// What the schedule needs for one kind, from a few small queries (the table only grows).
function readKind(db, kind, now) {
  const since = new Date(now.getTime() - RUN_WINDOW_DAYS * 86_400_000).toISOString();
  const recent = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM backup_runs WHERE kind = ? AND started_at >= ? ORDER BY started_at DESC, id DESC`)
    .all(kind, since)
    .map(toRun);
  const last = one(db, `SELECT ${RUN_COLUMNS} FROM backup_runs WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT 1`, kind);
  const lastSuccess = one(
    db,
    `SELECT ${RUN_COLUMNS} FROM backup_runs WHERE kind = ? AND status = 'succeeded'
      ORDER BY finished_at DESC, id DESC LIMIT 1`,
    kind
  );
  let newestAttempted = null;
  let oldestAttempted = null;
  if (kind === "copy") {
    const tried = `SELECT ${RUN_COLUMNS} FROM backup_runs
      WHERE kind = 'copy' AND status <> 'running' AND json_extract(detail, '$.attempted') = 1`;
    newestAttempted = one(db, `${tried} ORDER BY started_at DESC, id DESC LIMIT 1`);
    oldestAttempted = one(db, `${tried} ORDER BY started_at ASC, id ASC LIMIT 1`);
  }
  return { recent, last, lastSuccess, newestAttempted, oldestAttempted };
}

function insertRun(db, { kind, trigger, slot, attempt, requestedBy, startedAt }) {
  const info = db
    .prepare(
      `INSERT INTO backup_runs (kind, trigger, slot, attempt, started_at, status, detail, requested_by)
       VALUES (?, ?, ?, ?, ?, 'running', '{}', ?)`
    )
    .run(kind, trigger, slot || null, attempt || 1, startedAt, requestedBy == null ? null : requestedBy);
  return Number(info.lastInsertRowid);
}

function finishRun(db, id, outcome) {
  db.prepare(
    `UPDATE backup_runs SET status = ?, reason = ?, exit_code = ?, detail = ?, finished_at = ? WHERE id = ?`
  ).run(outcome.status, outcome.reason, outcome.exitCode, JSON.stringify(outcome.detail), new Date().toISOString(), id);
}

// A job's outcome, whatever it returned.
function normalise(kind, outcome) {
  const o = outcome && typeof outcome === "object" ? outcome : {};
  const reasons = kind === "copy" ? C.COPY_REASONS : C.SNAPSHOT_REASONS;
  const ok = o.status === "succeeded";
  return {
    status: ok ? "succeeded" : "failed",
    reason: ok ? null : reasons.includes(o.reason) ? o.reason : "other",
    exitCode: Number.isInteger(o.exitCode) ? o.exitCode : null,
    detail: cleanDetail(kind, o.detail),
  };
}

// ---- the states ---------------------------------------------------------------------------------

function snapshotState(passphrase, sevenZip) {
  if (!sevenZip) return "no_7zip";
  if (passphrase === "set") return "ready";
  return passphrase === "missing" ? "off" : "invalid";
}

function seedSlot(db, kind) {
  try {
    return settings.get(db, kind === "copy" ? "backup.copy_seed_slot" : "backup.snapshot_seed_slot");
  } catch {
    return null;
  }
}

// Everything known about one kind at `now`: the schedule's view plus whether its job can run.
function kindView(db, kind, now, env) {
  const rows = readKind(db, kind, now);
  const plan = schedule.evaluate(kind, {
    now,
    runs: rows.recent,
    seedSlot: seedSlot(db, kind),
    processStartedAt,
  });
  let locked = false;
  let canRun;
  if (kind === "snapshot") {
    canRun = env.tools.sevenZip && env.passphrase.state === "set";
  } else {
    locked = env.nas.state === "ready" && schedule.isLocked(rows.newestAttempted ? [rows.newestAttempted] : [], env.nas.mtimes);
    canRun =
      env.nas.state === "ready" &&
      env.passphrase.state === "set" &&
      env.tools.rsync &&
      env.tools.sevenZip &&
      !locked;
  }
  return { rows, plan, locked, canRun };
}

function environment() {
  return { tools: tools.toolsStatus(), passphrase: secrets.passphraseStatus(), nas: secrets.nasStatus() };
}

// ---- bells (section 11.1) -----------------------------------------------------------------------

function bell(db, { kind, entityId, title, body }) {
  try {
    const ids = notify.usersWithKey(db, "users.admin");
    if (ids.length === 0) return;
    notify.toUsers(
      db,
      ids,
      { kind, title, body, link: LINK, entityType: "backup", entityId },
      { dedupeUnread: true }
    );
  } catch (e) {
    console.error(`[backup] bell failed (${safe(e)})`);
  }
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function bellsAfter(db, run, { manual }) {
  if (run.kind === "snapshot") {
    if (run.status === "failed") {
      bell(db, { kind: "backup.failed", entityId: "snapshot", title: "The database snapshot failed", body: sentenceOf(run) });
    } else if (num(run.detail.premigrateFailed) > 0) {
      const n = run.detail.premigrateFailed;
      bell(db, {
        kind: "backup.failed",
        entityId: "premigrate",
        title: "A pre-migration backup could not be archived",
        body: `${plural(n, "pre-migration backup", "pre-migration backups")} could not be archived. The next snapshot tries again. ${sentences.SNAPSHOT_TAIL}`,
      });
    }
    return;
  }
  if (run.status !== "failed") return;
  const refusal = C.REFUSAL_REASONS.includes(run.reason);
  const final = C.NON_RETRYABLE.includes(run.reason);
  const lastTry = !manual && run.attempt >= C.MAX_ATTEMPTS && run.reason !== "interrupted";
  if (refusal || final || lastTry) {
    bell(db, { kind: "backup.failed", entityId: "copy", title: "The copy to the NAS failed", body: sentenceOf(run) });
  }
}

const OVERDUE = {
  snapshot: {
    title: "No good database snapshot for 2 days",
    none: "No database snapshot has succeeded since backups were switched on.",
  },
  copy: {
    title: "No proven copy on the NAS for 8 days",
    none: "No copy to the NAS has been proved yet.",
  },
};

function overdueOf(kind, rows, now, state, seededAt) {
  const runs = [rows.lastSuccess, kind === "copy" ? rows.oldestAttempted : null].filter(Boolean);
  return schedule.isOverdue(kind, { runs, now, state, seededAt });
}

// On each tick: at most one overdue bell per Sydney day per kind.
function checkOverdue(db, now) {
  const env = environment();
  let seededAt = null;
  try {
    seededAt = settings.get(db, "backup.seeded_at");
  } catch {
    seededAt = null;
  }
  const today = sydneyToday(now);
  for (const kind of ["snapshot", "copy"]) {
    try {
      const rows = readKind(db, kind, now);
      const state = kind === "copy" ? env.nas.state : snapshotState(env.passphrase.state, env.tools.sevenZip);
      if (!overdueOf(kind, rows, now, state, seededAt)) continue;
      const key = `backup.overdue_alerted_${kind}`;
      if (settings.get(db, key) === today) continue;
      settings.set(db, key, today, null, { audit: false });
      const body = rows.last ? sentenceOf(rows.last) : OVERDUE[kind].none;
      bell(db, { kind: "backup.overdue", entityId: kind, title: OVERDUE[kind].title, body });
      console.log(`[backup] ${kind} overdue: bell raised`);
    } catch (e) {
      console.error(`[backup] overdue check failed (${safe(e)})`);
    }
  }
}

// ---- one job ------------------------------------------------------------------------------------

function seconds(msValue) {
  const n = num(msValue);
  return n === undefined ? "?" : `${(n / 1000).toFixed(1)} s`;
}

function logRun(run) {
  const where = run.slot ? `${run.trigger}, ${run.slot}` : run.trigger;
  const d = run.detail;
  if (run.status === "succeeded") {
    if (run.kind === "snapshot") {
      console.log(
        `[backup] snapshot succeeded (${where}): ${d.archive || "archive"}, ${sentences.formatBytes(d.archiveBytes)}, vacuum ${
          num(d.vacuumMs) === undefined ? "?" : `${d.vacuumMs} ms`
        }, ${seconds(d.durationMs)}` +
          (num(d.pruned) ? `, ${d.pruned} pruned` : "") +
          (num(d.premigrateWrapped) ? `, ${d.premigrateWrapped} pre-migration wrapped` : "") +
          (num(d.premigrateFailed) ? `, ${d.premigrateFailed} pre-migration failed` : "")
      );
    } else {
      console.log(
        `[backup] copy succeeded (${where}): ${num(d.sent) || 0} sent, ${num(d.alreadyThere) || 0} already there, ${sentences.formatBytes(
          num(d.bytes) || 0
        )}, ${seconds(d.durationMs)}`
      );
    }
    return;
  }
  const exit = run.exitCode == null ? "" : `, exit ${run.exitCode}`;
  console.error(`[backup] ${run.kind} failed (${where}): ${run.reason}${exit}`);
}

// Records and runs one job; resolves the finished run (camel case), or null if it could not even be
// recorded. Never rejects.
async function runJob(db, kind, { trigger, slot = null, attempt = 1, requestedBy = null }) {
  const startedAt = new Date().toISOString();
  let id;
  try {
    id = insertRun(db, { kind, trigger, slot, attempt, requestedBy, startedAt });
  } catch (e) {
    console.error(`[backup] ${kind} not started: the run could not be recorded (${safe(e)})`);
    return null;
  }
  current = { kind, trigger, startedAt };
  let outcome;
  try {
    const signal = AbortSignal.timeout(kind === "copy" ? C.COPY_DEADLINE_MS : C.SNAPSHOT_DEADLINE_MS);
    outcome =
      kind === "copy"
        ? await copy.copyToNas(db, { trigger, signal, now: new Date(startedAt) })
        : await snapshot.takeSnapshot(db, { trigger, signal, now: new Date(startedAt) });
  } catch (e) {
    console.error(`[backup] ${kind} threw (${safe(e)})`);
    outcome = { status: "failed", reason: "other", exitCode: null, detail: {} };
  }
  const result = normalise(kind, outcome);
  try {
    finishRun(db, id, result);
  } catch (e) {
    console.error(`[backup] ${kind} result not recorded (${safe(e)})`);
  }
  current = null;
  const run = {
    id,
    kind,
    trigger,
    slot,
    attempt,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...result,
  };
  logRun(run);
  bellsAfter(db, run, { manual: trigger === "manual" });
  return run;
}

// Runs `body` as the one flight. The caller has checked `flight` is null in the same synchronous
// step, so nothing can start between the check and this.
function fly(body) {
  const p = (async () => {
    try {
      await body();
    } catch (e) {
      console.error(`[backup] flight failed (${safe(e)})`);
    } finally {
      current = null;
      flight = null;
    }
  })();
  flight = p;
  return p;
}

// ---- the timer (section 7.3) --------------------------------------------------------------------

function timerJob(kind, view) {
  return {
    trigger: view.plan.trigger,
    slot: view.plan.slot,
    attempt: view.plan.attempts + 1,
  };
}

function dueNow(db, kind, now, env) {
  const view = kindView(db, kind, now, env);
  return view.canRun && view.plan.due ? view : null;
}

async function tick(db) {
  if (flight) return;
  const now = new Date();
  const env = environment();
  const snap = dueNow(db, "snapshot", now, env);
  const cp = snap ? null : dueNow(db, "copy", now, env);
  if (snap || cp) {
    await fly(async () => {
      if (snap) {
        await runJob(db, "snapshot", timerJob("snapshot", snap));
        // Saturday 01:30: the copy follows in the same flight when it is due too.
        const again = dueNow(db, "copy", new Date(), environment());
        if (again) await runJob(db, "copy", timerJob("copy", again));
      } else {
        await runJob(db, "copy", timerJob("copy", cp));
      }
    });
  }
  checkOverdue(db, new Date());
}

function startTimer(db) {
  if (timer) return;
  timer = setInterval(() => {
    try {
      tick(db).catch((e) => console.error(`[backup] tick failed (${safe(e)})`));
    } catch (e) {
      console.error(`[backup] tick failed (${safe(e)})`);
    }
  }, C.CHECK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

// ---- start (section 7.4) ------------------------------------------------------------------------

// A run cut short by the last stop is marked `interrupted`, finished now. The schedule then waits
// at least the first retry delay (1 h) before trying that slot again, and two interrupted runs in a
// row count as one real attempt (schedule.js retryAt, realAttemptRuns), so a run that takes the app
// down can't loop on every restart.
function sweepInterrupted(db) {
  const info = db
    .prepare(
      `UPDATE backup_runs SET status = 'failed', reason = 'interrupted', finished_at = ? WHERE status = 'running'`
    )
    .run(new Date().toISOString());
  const n = Number(info.changes) || 0;
  if (n > 0) console.log(`[backup] ${n} run(s) cut short by the last stop marked interrupted`);
}

function emptyStaging() {
  let entries = [];
  try {
    entries = fs.readdirSync(C.STAGING_DIR);
  } catch (e) {
    if (e && e.code !== "ENOENT") console.error(`[backup] staging not emptied (${safe(e)})`);
    return;
  }
  for (const name of entries) {
    try {
      fs.rmSync(path.join(C.STAGING_DIR, name), { recursive: true, force: true });
    } catch (e) {
      console.error(`[backup] staging not emptied (${safe(e)})`);
    }
  }
}

function seed(db, now) {
  if (settings.get(db, "backup.seeded_at") != null) return;
  settings.set(db, "backup.seeded_at", now.toISOString(), null, { audit: false });
  settings.set(db, "backup.snapshot_seed_slot", schedule.snapshotSlot(now), null, { audit: false });
  settings.set(db, "backup.copy_seed_slot", schedule.copySlot(now), null, { audit: false });
  console.log("[backup] first start: slots seeded, nothing run");
}

// After listen. BACKUP_DISABLED=1: nothing at all. Returns a promise that never rejects.
function start(db) {
  if (disabled()) return Promise.resolve();
  if (started) return Promise.resolve();
  started = true;
  processStartedAt = new Date();
  for (const [what, step] of [
    ["sweep", () => sweepInterrupted(db)],
    ["staging", () => emptyStaging()],
    ["seeding", () => seed(db, processStartedAt)],
  ]) {
    try {
      step();
    } catch (e) {
      console.error(`[backup] start: ${what} failed (${safe(e)})`);
    }
  }
  return tools
    .probeVersions()
    .catch(() => ({ sevenZip: null, rsync: null }))
    .then((v) => {
      console.log(`[backup] 7-Zip: ${v.sevenZip || "missing"}; rsync: ${v.rsync || "missing"}; schedule ${scheduleDisabled() ? "off" : "on"}`);
      if (!scheduleDisabled()) startTimer(db);
    })
    .catch((e) => console.error(`[backup] start failed (${safe(e)})`));
}

// ---- status (section 9) -------------------------------------------------------------------------

function iso(d) {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

function status(db) {
  try {
    const now = new Date();
    const env = environment();
    const enabled = !disabled();
    const scheduleOn = enabled && !scheduleDisabled();
    let seededAt = null;
    try {
      seededAt = settings.get(db, "backup.seeded_at");
    } catch {
      seededAt = null;
    }

    const snap = kindView(db, "snapshot", now, env);
    const cp = kindView(db, "copy", now, env);
    const snapState = snapshotState(env.passphrase.state, env.tools.sevenZip);
    const copyState = cp.locked ? "locked" : env.nas.state;

    const timing = (view) => {
      if (!scheduleOn || !view.canRun) return { nextAt: null, retryAt: null };
      return { nextAt: iso(view.plan.nextAt), retryAt: iso(view.plan.retryAt) };
    };

    const listed = snapshot.listArchives();
    const archives = (listed.archives || []).slice(0, RECENT).map((a) => ({
      name: a.name,
      kind: a.kind,
      bytes: a.bytes,
      made: a.made,
      migration: a.migration == null ? null : a.migration,
    }));
    let blobs = { tracked: 0, proven: 0 };
    try {
      blobs = ledger.counts(db);
    } catch (e) {
      console.error(`[backup] status: ledger unreadable (${safe(e)})`);
    }
    const recent = db
      .prepare(`SELECT ${RUN_COLUMNS} FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(RECENT)
      .map((row) => publicRun(toRun(row)));

    return {
      enabled,
      scheduleOn,
      tools: env.tools,
      running: current ? { ...current } : null,
      snapshot: {
        state: snapState,
        passphrase: env.passphrase.state,
        last: publicRun(snap.rows.last),
        lastSuccess: publicRun(snap.rows.lastSuccess),
        ...timing(snap),
        overdue: overdueOf("snapshot", snap.rows, now, snapState, seededAt),
      },
      copy: {
        state: copyState,
        files: { nasUrl: env.nas.url, nasPassword: env.nas.password },
        locked: cp.locked,
        last: publicRun(cp.rows.last),
        lastSuccess: publicRun(cp.rows.lastSuccess),
        ...timing(cp),
        overdue: overdueOf("copy", cp.rows, now, env.nas.state, seededAt),
      },
      archives,
      totals: {
        archives: (listed.archives || []).length,
        archiveBytes: num(listed.archiveBytes) || 0,
        unverified: num(listed.unverified) || 0,
        blobsTracked: blobs.tracked,
        blobsProven: blobs.proven,
      },
      recent,
    };
  } catch (e) {
    console.error(`[backup] status failed (${safe(e)})`);
    return null;
  }
}

// ---- Back up now (section 7.7) ------------------------------------------------------------------

// The section 8 sentence for a state the snapshot can't run in, without the failure tail.
function cannotRunSentence(reason) {
  const s = sentences.snapshotSentence({ status: "failed", reason, exitCode: null, detail: {} });
  const tail = ` ${sentences.SNAPSHOT_TAIL}`;
  return s.endsWith(tail) ? s.slice(0, -tail.length) : s;
}

async function requestRun(db, req) {
  try {
    // 1. A flight is running: join it.
    if (flight) return { status: 202, body: { running: true, joined: true } };
    // 2. The kill switch.
    if (disabled()) return { status: 409, body: { error: sentences.DISABLED } };
    // 3. The snapshot can't run.
    const env = environment();
    if (!env.tools.sevenZip) return { status: 409, body: { error: cannotRunSentence("no_7zip") } };
    if (env.passphrase.state === "missing") return { status: 409, body: { error: cannotRunSentence("no_passphrase") } };
    if (env.passphrase.state !== "set") return { status: 409, body: { error: cannotRunSentence("passphrase_unusable") } };
    // 4. The refusal lock holds: the whole button waits until the NAS files are placed again.
    const now = new Date();
    const nasReady = env.nas.state === "ready";
    if (nasReady) {
      const rows = readKind(db, "copy", now);
      if (schedule.isLocked(rows.newestAttempted ? [rows.newestAttempted] : [], env.nas.mtimes)) {
        return { status: 409, body: { error: sentences.FIX_FIRST } };
      }
    }
    // 5. A good snapshot less than 10 minutes ago.
    const lastGood = one(
      db,
      `SELECT ${RUN_COLUMNS} FROM backup_runs WHERE kind = 'snapshot' AND status = 'succeeded'
        ORDER BY finished_at DESC, id DESC LIMIT 1`
    );
    const finished = lastGood ? Date.parse(lastGood.finishedAt) : NaN;
    if (Number.isFinite(finished)) {
      const waitMs = finished + C.MANUAL_GAP_MS - now.getTime();
      if (waitMs > 0) {
        const retryAfterSeconds = Math.ceil(waitMs / 1000);
        return {
          status: 429,
          body: { error: sentences.tooSoonSentence(Math.ceil(retryAfterSeconds / 60)), retryAfterSeconds },
        };
      }
    }
    // 6. Start the flight (nothing awaited since the check in step 1).
    if (flight) return { status: 202, body: { running: true, joined: true } };
    const requestedBy = req && req.user && Number.isInteger(Number(req.user.id)) ? Number(req.user.id) : null;
    fly(async () => {
      await runJob(db, "snapshot", { trigger: "manual", requestedBy });
      // The copy runs even if the snapshot failed: it still sends whatever else the NAS lacks.
      // The NAS files are read again in case the helper changed them meanwhile.
      if (!nasReady || secrets.nasStatus().state !== "ready") return;
      await runJob(db, "copy", { trigger: "manual", requestedBy });
    }).catch(() => {});
    audit.log(req, { action: "backup.run", entityType: "backup", entityId: "run" });
    return { status: 202, body: { running: true, joined: false, copy: nasReady } };
  } catch (e) {
    console.error(`[backup] Back up now failed (${safe(e)})`);
    return { status: 500, body: { error: "Server error" } };
  }
}

module.exports = { start, status, requestRun };
