// Workshop end-of-shift report (0.2.4, docs/plans/m25-contracts.md). Each workshop person, from
// their own login (users.worker_id links it to their board worker), sees today's jobs from this
// week's board rows they are on, adds photos (tagged install or shift), raises issues
// (lib/issues.js) and sends a report. On weekdays at shift.reminder_time (default 16:00; empty is
// off) anyone on an install row today who hasn't sent a report gets a bell reminder.
//
// Every function takes db first; nothing here requires ../db.
const audit = require("./audit");
const notify = require("./notify");
const settings = require("./settings");
const issues = require("./issues");
const jobstage = require("./jobstage");
const { bad, notFound } = require("./httperror");
const { sydneyMonday, sydneyParts, sydneyInstant } = require("./time");

const DAYS = [null, "mon", "tue", "wed", "thu", "fri", null, null];
const NOTE_MAX = 2000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOSED = ["complete", "invoiced", "lost", "archived"];
const userId = (req) => (req && req.user && req.user.id != null ? req.user.id : null);

// Sydney today's date, its Monday and its board day key (null at the weekend).
function dayOf(now = new Date()) {
  const p = sydneyParts(now);
  return { date: p.date, weekStart: sydneyMonday(p.date), day: DAYS[p.weekday] };
}

function workerOf(db, uid) {
  if (uid == null) return null;
  return db.prepare("SELECT w.id, w.name, w.hue FROM users u JOIN workers w ON w.id = u.worker_id WHERE u.id = ?").get(uid) || null;
}

// [{jobId, panel}] for a worker's board rows on one day.
function boardRows(db, workerId, weekStart, day) {
  if (!workerId || !day) return [];
  return db
    .prepare(
      `SELECT DISTINCT wr.job_id AS jobId, wr.panel FROM assignments a JOIN week_rows wr ON wr.id = a.week_row_id
        WHERE a.worker_id = ? AND wr.week_start = ? AND a.day = ? ORDER BY wr.panel, wr.sort_order, wr.id`
    )
    .all(workerId, weekStart, day);
}

// "YYYY-MM-DD HH:MM:SS" (UTC, as photos.created_at) of Sydney midnight on date.
function dayStartUtc(date) {
  return sydneyInstant(date, "00:00").toISOString().replace("T", " ").slice(0, 19);
}

function jobCard(db, req, job, panels, date) {
  const photos = db
    .prepare("SELECT id, filename, thumb_filename, tags FROM photos WHERE job_id = ? AND created_at >= ? ORDER BY id")
    .all(job.id, dayStartUtc(date))
    .map((p) => ({ id: p.id, url: `/photos/${p.filename}`, thumbUrl: `/photos/${p.thumb_filename}`, tags: p.tags }));
  return {
    id: job.id,
    name: job.name,
    clientName: job.client_name || null,
    siteAddress: job.site_address || null,
    pipelineStage: jobstage.pipelineStage(job),
    panels,
    photosToday: photos,
    issues: issues.listFor(db, req, job.id).filter((i) => i.status === "open"),
  };
}

function reportOf(db, uid, date) {
  const r = db.prepare("SELECT * FROM shift_reports WHERE user_id = ? AND date = ?").get(uid, date);
  if (!r) return null;
  return { note: r.note, jobIds: JSON.parse(r.job_ids || "[]"), sentAt: r.sent_at };
}

// The shift page's data. extraIds: jobs the person added by search (shown after the board's).
function today(db, req, extraIds = [], now = new Date()) {
  const { date, weekStart, day } = dayOf(now);
  const uid = userId(req);
  const worker = workerOf(db, uid);
  const rows = boardRows(db, worker && worker.id, weekStart, day);
  const panelsOf = new Map();
  for (const r of rows) {
    if (!panelsOf.has(r.jobId)) panelsOf.set(r.jobId, []);
    panelsOf.get(r.jobId).push(r.panel);
  }
  const report = reportOf(db, uid, date);
  const ids = [...panelsOf.keys()];
  for (const id of [...extraIds, ...(report ? report.jobIds : [])]) if (!ids.includes(id)) ids.push(id);
  const jobs = [];
  for (const id of ids) {
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    if (!job || job.archived) continue;
    jobs.push(jobCard(db, req, job, panelsOf.get(id) || [], date));
  }
  return {
    date,
    worker: worker ? { id: worker.id, name: worker.name, hue: worker.hue } : null,
    installDay: rows.some((r) => r.panel === "installing"),
    jobs,
    report,
  };
}

// Live jobs by name or client, for adding a job not on today's board.
function search(db, q) {
  const t = typeof q === "string" ? q.trim() : "";
  if (t.length < 2) return [];
  const like = `%${t.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  return db
    .prepare(
      `SELECT * FROM jobs WHERE archived = 0 AND (stage IS NULL OR stage NOT IN (${CLOSED.map(() => "?").join(",")}))
          AND (name LIKE ? ESCAPE '\\' OR client_name LIKE ? ESCAPE '\\')
        ORDER BY name COLLATE NOCASE, id LIMIT 20`
    )
    .all(...CLOSED, like, like)
    .map((j) => ({ id: j.id, name: j.name, clientName: j.client_name || null, pipelineStage: jobstage.pipelineStage(j) }));
}

// The tag a shift photo gets: install when the person is on an install row for the job today.
function photoTag(db, req, jobId, now = new Date()) {
  const { weekStart, day } = dayOf(now);
  const worker = workerOf(db, userId(req));
  const rows = boardRows(db, worker && worker.id, weekStart, day);
  return rows.some((r) => r.jobId === jobId && r.panel === "installing") ? "install" : "shift";
}

function liveJob(db, jobId) {
  const job = db.prepare("SELECT id, archived FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw notFound();
  if (job.archived) throw bad("That job is archived");
  return job;
}

// body: {note?, jobIds?}. Sending again the same day replaces the earlier report.
function send(db, req, body, now = new Date()) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!b) throw bad("JSON body required");
  let note = "";
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string") throw bad("note must be text");
    note = b.note.trim();
    if (note.length > NOTE_MAX) throw bad(`A note is ${NOTE_MAX.toLocaleString("en-AU")} characters at most`);
  }
  let jobIds = [];
  if (b.jobIds !== undefined && b.jobIds !== null) {
    if (!Array.isArray(b.jobIds) || !b.jobIds.every((n) => Number.isInteger(n) && n > 0)) throw bad("jobIds must be a list of job ids");
    jobIds = [...new Set(b.jobIds)];
  }
  const { date } = dayOf(now);
  const uid = userId(req);
  return db.transaction(() => {
    for (const id of jobIds) if (!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(id)) throw bad(`No such job: ${id}`);
    const before = reportOf(db, uid, date);
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO shift_reports (user_id, date, note, job_ids, sent_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET note = excluded.note, job_ids = excluded.job_ids, sent_at = excluded.sent_at`
    ).run(uid, date, note, JSON.stringify(jobIds), at);
    const id = db.prepare("SELECT id FROM shift_reports WHERE user_id = ? AND date = ?").get(uid, date).id;
    audit.log(req, { action: "shift.report", entityType: "shift_report", entityId: id, before, after: { date, note, jobIds } });
    return { date, ...reportOf(db, uid, date) };
  })();
}

// ---- the reminder --------------------------------------------------------------------------

function reminderTime(db) {
  const t = settings.get(db, "shift.reminder_time");
  return typeof t === "string" && TIME_RE.test(t) ? t : null;
}

// The people to remind on date: enabled logins holding shift.report, linked to a worker who is on
// an install row that day, with no report sent.
function dueToRemind(db, now = new Date()) {
  const { date, weekStart, day } = dayOf(now);
  if (!day) return [];
  const holders = new Set(notify.usersWithKey(db, "shift.report").map(Number));
  return db
    .prepare(
      `SELECT DISTINCT u.id FROM users u
         JOIN assignments a ON a.worker_id = u.worker_id
         JOIN week_rows wr ON wr.id = a.week_row_id
        WHERE u.disabled = 0 AND u.worker_id IS NOT NULL AND wr.week_start = ? AND a.day = ? AND wr.panel = 'installing'
          AND NOT EXISTS (SELECT 1 FROM shift_reports s WHERE s.user_id = u.id AND s.date = ?)`
    )
    .all(weekStart, day, date)
    .map((r) => Number(r.id))
    .filter((id) => holders.has(id));
}

// Unless force, runs once per weekday at or after the reminder time. Returns {sent, date}.
function runReminder(db, { now = new Date(), force = false } = {}) {
  const { date, day } = dayOf(now);
  return db.transaction(() => {
    if (!force) {
      const t = reminderTime(db);
      if (!t || !day) return { sent: 0, date };
      const p = sydneyParts(now);
      const hm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
      if (hm < t || settings.get(db, "shift.reminder_last_run") === date) return { sent: 0, date };
    }
    const sent = notify.toUsers(
      db,
      dueToRemind(db, now),
      { kind: "shift.reminder", title: "Send your end-of-shift report", body: "Photos of today's install and any issues.", link: "/shift.html", entityType: "reminder", entityId: date },
      { dedupeUnread: true }
    );
    if (!force) settings.set(db, "shift.reminder_last_run", date, null, { audit: false });
    return { sent, date };
  })();
}

let started = false;

// Every 60 s. Off with SHIFT_REMINDER_DISABLED=1.
function start(db) {
  if (process.env.SHIFT_REMINDER_DISABLED === "1" || started) return;
  started = true;
  const timer = setInterval(() => {
    try {
      const { sent, date } = runReminder(db);
      if (sent) console.log(`[shift] reminder for ${date}: ${sent} notification(s) sent`);
    } catch (e) {
      console.error("[shift] reminder failed:", e && e.message ? e.message : e);
    }
  }, 60 * 1000);
  timer.unref();
}

module.exports = { today, search, photoTag, liveJob, send, runReminder, dueToRemind, start, TIME_RE };
