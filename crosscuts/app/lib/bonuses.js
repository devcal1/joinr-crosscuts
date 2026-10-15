// Job bonuses (docs/plans/m13-contracts.md section 4): the rate and share points, one bonus per job
// with its seven checks, confirming (the figures frozen), paying each share, the summary and the
// quoted hours from Joinr. Wave 1 B.
//
// Every function takes db first and nothing here requires ../db. Every write runs in one
// db.transaction with its audit row (entity types bonus and bonus_settings only, section 3.6).
// Money is integer cents, hours are minutes, rates are basis points. Bonuses never touch a pay run
// (Decision 5): a share only records which pay run it went in.
const audit = require("./audit");
const payroll = require("./payroll");
const { bad, notFound, conflict, can } = require("./httperror");
const { DATE_RE, sydneyToday, parseDateUTC, formatDateUTC } = require("./time");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PRICE_MAX = 10000000000; // $100,000,000
const MIN_MAX = 600000;
const POINTS_MAX = 1000;
const RATE_MAX = 10000;
const NOTE_MAX = 1000;
const JOBS_MAX = 50;
const PAY_RUNS_MAX = 26;
const LIST_STATUSES = ["all", "draft", "confirmed", "owed"];

// Section 4.1: the seven checks, equal weight, in this order.
const CHECKS = [
  { key: "drawn", col: "check_drawn", label: "Drawn (Mozaik)" },
  { key: "ordered", col: "check_ordered", label: "Ordered" },
  { key: "assembled", col: "check_assembled", label: "Assembled" },
  { key: "installed", col: "check_installed", label: "Installed" },
  { key: "noFuss", col: "check_no_fuss", label: "No fuss" },
  { key: "onTime", col: "check_on_time", label: "On time" },
  { key: "hours", col: "check_hours", label: "Hours" },
];
const CHECK = new Map(CHECKS.map((c) => [c.key, c]));

// Section 4.4: the four hours (minutes).
const MINUTES = [
  { key: "quotedFactoryMin", col: "quoted_factory_min", label: "Quoted factory hours", quoted: true },
  { key: "quotedInstallMin", col: "quoted_install_min", label: "Quoted install hours", quoted: true },
  { key: "actualFactoryMin", col: "actual_factory_min", label: "Actual factory hours" },
  { key: "actualInstallMin", col: "actual_install_min", label: "Actual install hours" },
];

// Body keys of create and update, in the order they're checked (create adds jobId).
const BODY_KEYS = ["priceCents", "ranBy", "checkedBy", ...MINUTES.map((m) => m.key), "checks", "note"];
const PEOPLE = [
  { key: "ranBy", col: "ran_by", label: "Ran by" },
  { key: "checkedBy", col: "checked_by", label: "Checked by" },
];

// ---------------------------------------------------------------- helpers ---

function nowIso() {
  return new Date().toISOString();
}

function userId(req) {
  return req && req.user && req.user.id != null ? req.user.id : null;
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function validDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && formatDateUTC(parseDateUTC(s)) === s;
}

// "2026-10-03" -> "3 Oct 2026".
function dayLabel(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// A positive integer id from a body value (a number or a digit string), else null.
function bodyId(v) {
  const n = typeof v === "string" && /^[1-9]\d*$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function wholeIn(v, lo, hi) {
  return Number.isSafeInteger(v) && v >= lo && v <= hi;
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

function userRef(id, name) {
  return id == null ? null : { id, name: name == null ? null : name };
}

function byNameCaseBlind(a, b) {
  const x = String(a == null ? "" : a).toLowerCase();
  const y = String(b == null ? "" : b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

// ------------------------------------------------------------------ maths ---

// floor(a / b) for whole a >= 0 and b > 0, exact even where the float quotient would round up to
// the next whole number.
function floorDiv(a, b) {
  let q = Math.floor(a / b);
  while (q * b > a) q -= 1;
  while ((q + 1) * b <= a) q += 1;
  return q;
}

// Half up on whole numbers (section 4.1): roundDiv(n, d) = floor((2n + d) / (2d)) for n >= 0.
function roundDiv(n, d) {
  return floorDiv(2 * n + d, 2 * d);
}

// Possible, earned and lost for price P (cents), rate R (basis points) and t ticks of seven. Each
// is rounded once; null figures without a price.
function figures(priceCents, rateBp, ticked) {
  if (priceCents == null) return { possibleCents: null, earnedCents: null, lostCents: null };
  const possibleCents = roundDiv(priceCents * rateBp, 10000);
  const earnedCents = roundDiv(priceCents * rateBp * ticked, 70000);
  return { possibleCents, earnedCents, lostCents: possibleCents - earnedCents };
}

// Section 4.1's split: holders [{personId, name, points}] in the settings' order. Each holder with
// points above 0 gets floor(earned x p / T); the cents left over go one each to the largest
// remainders (ties: more points, then the settings' order, then the lower person id). Returns the
// holders with points above 0, in the settings' order, each with shareCents; they add up to
// earned exactly (earned 0 or no points: every share 0).
function splitShares(earnedCents, holders) {
  const live = holders
    .map((h, order) => ({ personId: h.personId, name: h.name, points: h.points, order }))
    .filter((h) => h.points > 0);
  const total = live.reduce((s, h) => s + h.points, 0);
  if (!total || !(earnedCents > 0)) {
    for (const h of live) h.shareCents = 0;
  } else {
    let given = 0;
    for (const h of live) {
      const n = earnedCents * h.points;
      h.shareCents = floorDiv(n, total);
      h.rem = n - h.shareCents * total;
      given += h.shareCents;
    }
    const left = earnedCents - given;
    const ranked = [...live].sort(
      (a, b) => b.rem - a.rem || b.points - a.points || a.order - b.order || a.personId - b.personId
    );
    for (let i = 0; i < left; i += 1) ranked[i].shareCents += 1;
  }
  return live.map((h) => ({ personId: h.personId, name: h.name, points: h.points, shareCents: h.shareCents }));
}

// The Hours check's suggestion (section 4.1): actual total at most the quoted total, when all four
// are known; else null.
function suggestedHours(row) {
  const vals = MINUTES.map((m) => row[m.col]);
  if (vals.some((v) => v == null)) return null;
  return row.actual_factory_min + row.actual_install_min <= row.quoted_factory_min + row.quoted_install_min;
}

// The Hours check as it counts: the hand value while set, else the suggestion (unknown: not ticked).
function effectiveHours(row) {
  if (row.check_hours != null) return row.check_hours === 1;
  return suggestedHours(row) === true;
}

function checksOf(row) {
  const out = {};
  for (const c of CHECKS) out[c.key] = c.key === "hours" ? effectiveHours(row) : row[c.col] === 1;
  return out;
}

function tickedOf(checks) {
  return CHECKS.reduce((n, c) => n + (checks[c.key] ? 1 : 0), 0);
}

// ----------------------------------------------------------------- people ---

// {personId, name, archived} for a pay_people id (section 4.2).
function personRef(db, personId) {
  if (personId == null) return null;
  const p = payroll.personById(db, personId);
  if (!p) return { personId, name: null, archived: false };
  return { personId: p.id, name: p.name, archived: p.archived };
}

// A body's person, {personId} or {workerId}, as a pay_people id (section 4.2). A worker without a
// row gets one (payroll.ensureWorkerRow), so call this inside the write's transaction. An archived
// person may be named only when already set (`keep`: the ids already set).
function resolvePerson(db, v, label, keep, extraKeys = []) {
  const err = () => bad(`${label} must be a person from the pay list`);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw err();
  for (const k of Object.keys(v)) {
    if (k !== "personId" && k !== "workerId" && !extraKeys.includes(k)) throw err();
  }
  const hasPerson = v.personId !== undefined;
  const hasWorker = v.workerId !== undefined;
  if (hasPerson === hasWorker) throw err();
  if (hasPerson) {
    const id = bodyId(v.personId);
    const p = id && payroll.personById(db, id);
    if (!p) throw err();
    if (p.archived && !keep.has(p.id)) throw err();
    return p.id;
  }
  const wid = bodyId(v.workerId);
  const w = wid && db.prepare("SELECT id, archived FROM workers WHERE id = ?").get(wid);
  if (!w) throw err();
  const row = db.prepare("SELECT id FROM pay_people WHERE worker_id = ?").get(w.id);
  if (Number(w.archived) !== 0 && !(row && keep.has(row.id))) throw err();
  return row ? row.id : payroll.ensureWorkerRow(db, w.id);
}

// --------------------------------------------------------------- settings ---

function holderRows(db) {
  return db.prepare("SELECT person_id, points FROM bonus_holders ORDER BY sort, person_id").all();
}

// -> {rateBp, holders: [{personId, name, archived, points}], totalPoints}
function settings(db) {
  const s = db.prepare("SELECT rate_bp FROM bonus_settings WHERE id = 1").get();
  const holders = holderRows(db).map((h) => ({ ...personRef(db, h.person_id), points: h.points }));
  return {
    rateBp: s ? s.rate_bp : 0,
    holders,
    totalPoints: holders.reduce((n, h) => n + h.points, 0),
  };
}

// Body {rateBp, holders: [{personId | workerId, points}]}: replaces the rate and the whole list.
function putSettings(db, req, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  for (const k of Object.keys(b)) {
    if (k !== "rateBp" && k !== "holders") throw bad(`Unknown field: ${k}`);
  }
  if (!wholeIn(b.rateBp, 0, RATE_MAX)) {
    throw bad("The bonus rate must be from 0 to 10000 basis points (0% to 100%)");
  }
  if (!Array.isArray(b.holders)) throw bad("Share holders must be a list");
  db.transaction(() => {
    const before = settings(db);
    const keep = new Set(before.holders.map((h) => h.personId));
    const seen = new Set();
    const holders = [];
    for (const h of b.holders) {
      if (!h || typeof h !== "object" || Array.isArray(h)) throw bad("Share holder must be a person from the pay list");
      for (const k of Object.keys(h)) {
        if (k !== "personId" && k !== "workerId" && k !== "points") throw bad(`Unknown field: ${k}`);
      }
      const personId = resolvePerson(db, h, "Share holder", keep, ["points"]);
      if (!wholeIn(h.points, 0, POINTS_MAX)) throw bad("Share points must be whole numbers from 0 to 1000");
      if (seen.has(personId)) throw bad(`${personRef(db, personId).name} is listed twice`);
      seen.add(personId);
      holders.push({ personId, points: h.points });
    }
    const was = { rateBp: before.rateBp, holders: before.holders.map((h) => ({ personId: h.personId, points: h.points })) };
    const now = { rateBp: b.rateBp, holders };
    if (JSON.stringify(was) === JSON.stringify(now)) return;
    db.prepare("DELETE FROM bonus_holders").run();
    const ins = db.prepare("INSERT INTO bonus_holders (person_id, points, sort) VALUES (?, ?, ?)");
    holders.forEach((h, i) => ins.run(h.personId, h.points, i));
    db.prepare("UPDATE bonus_settings SET rate_bp = ?, updated_at = ?, updated_by = ? WHERE id = 1").run(
      b.rateBp,
      nowIso(),
      userId(req)
    );
    audit.log(req, { action: "bonus_settings.update", entityType: "bonus_settings", entityId: 1, before: was, after: now });
  })();
  return settings(db);
}

// -> {people: payroll.listPeople(db)} (current, not archived)
function people(db) {
  return { people: payroll.listPeople(db) };
}

// -> {jobs: [{id, name, stage, archived, hasBonus}]}: up to 50 jobs whose name holds q
// (case-blind), not archived first, newest first.
function jobs(db, req, { q } = {}) {
  const text = typeof q === "string" ? q.trim().toLowerCase() : "";
  const rows = db
    .prepare(
      `SELECT j.id, j.name, j.stage, j.archived,
              EXISTS (SELECT 1 FROM bonuses b WHERE b.job_id = j.id) AS has_bonus
         FROM jobs j
        WHERE instr(lower(j.name), ?) > 0
        ORDER BY j.archived <> 0, j.id DESC
        LIMIT ${JOBS_MAX}`
    )
    .all(text);
  return {
    jobs: rows.map((r) => ({
      id: r.id,
      name: r.name,
      stage: r.stage || null,
      archived: Number(r.archived) !== 0,
      hasBonus: Number(r.has_bonus) !== 0,
    })),
  };
}

// ----------------------------------------------------------------- bonuses ---

const BONUS_SQL = `SELECT b.*, j.name AS job_name, j.archived AS job_archived,
       uc.display_name AS created_by_name, uu.display_name AS updated_by_name,
       uf.display_name AS confirmed_by_name
  FROM bonuses b
  JOIN jobs j ON j.id = b.job_id
  LEFT JOIN users uc ON uc.id = b.created_by
  LEFT JOIN users uu ON uu.id = b.updated_by
  LEFT JOIN users uf ON uf.id = b.confirmed_by`;

function rowOf(db, id) {
  return db.prepare(`${BONUS_SQL} WHERE b.id = ?`).get(id) || null;
}

function rowOr404(db, id) {
  const row = rowOf(db, id);
  if (!row) throw notFound();
  return row;
}

function frozenShares(row) {
  const p = parseJson(row.shares_json);
  const holders = p && Array.isArray(p.holders) ? p.holders : [];
  return { holders, totalPoints: p && Number.isFinite(p.totalPoints) ? p.totalPoints : 0 };
}

function shareRows(db, bonusId) {
  return db
    .prepare(
      `SELECT s.person_id, s.points, s.share_cents, s.paid_date, s.pay_run_id, s.paid_at, s.paid_by,
              pr.start_date AS pay_run_start, u.display_name AS paid_by_name
         FROM bonus_shares s
         LEFT JOIN pay_runs pr ON pr.id = s.pay_run_id
         LEFT JOIN users u ON u.id = s.paid_by
        WHERE s.bonus_id = ?`
    )
    .all(bonusId);
}

// The section 4.3 bonus object. `live` is settings(db) (passed in by list, so it's read once).
function bonusOut(db, row, live) {
  const checks = checksOf(row);
  const ticked = tickedOf(checks);
  const suggested = suggestedHours(row);
  const confirmed = row.status === "confirmed";
  let rateBp;
  let figs;
  let totalPoints;
  let shares;
  let owedCents = 0;
  let setByHand;
  if (confirmed) {
    const frozen = frozenShares(row);
    rateBp = row.rate_bp;
    figs = {
      possibleCents: row.possible_cents,
      earnedCents: row.earned_cents,
      lostCents: row.possible_cents - row.earned_cents,
    };
    totalPoints = frozen.totalPoints;
    const order = new Map(frozen.holders.map((h, i) => [h.personId, i]));
    const frozenName = new Map(frozen.holders.map((h) => [h.personId, h.name]));
    shares = shareRows(db, row.id)
      .sort((a, b) => (order.has(a.person_id) ? order.get(a.person_id) : 1e9) - (order.has(b.person_id) ? order.get(b.person_id) : 1e9)
        || a.person_id - b.person_id)
      .map((s) => {
        const p = personRef(db, s.person_id);
        if (!s.paid_date) owedCents += s.share_cents;
        return {
          personId: s.person_id,
          name: p && p.name != null ? p.name : frozenName.get(s.person_id) || null,
          points: s.points,
          shareCents: s.share_cents,
          paid: s.paid_date
            ? {
                date: s.paid_date,
                payRun: s.pay_run_id == null ? null : { id: s.pay_run_id, startDate: s.pay_run_start || null },
                at: s.paid_at,
                by: userRef(s.paid_by, s.paid_by_name),
              }
            : null,
        };
      });
    // Frozen: the Hours check follows the suggestion when the frozen value is what it suggested.
    setByHand = row.check_hours !== (suggested === true ? 1 : 0);
  } else {
    const s = live || settings(db);
    rateBp = s.rateBp;
    figs = figures(row.price_cents, rateBp, ticked);
    totalPoints = s.totalPoints;
    shares =
      figs.earnedCents == null
        ? []
        : splitShares(figs.earnedCents, s.holders)
            .filter((h) => h.shareCents > 0)
            .map((h) => ({ ...h, paid: null }));
    setByHand = row.check_hours != null;
  }
  return {
    id: row.id,
    job: { id: row.job_id, name: row.job_name, archived: Number(row.job_archived) !== 0 },
    status: row.status,
    priceCents: row.price_cents,
    ranBy: personRef(db, row.ran_by),
    checkedBy: personRef(db, row.checked_by),
    hours: {
      quotedFactoryMin: row.quoted_factory_min,
      quotedInstallMin: row.quoted_install_min,
      actualFactoryMin: row.actual_factory_min,
      actualInstallMin: row.actual_install_min,
      quotedFromJoinr: row.quoted_from_joinr === 1,
    },
    checks,
    hoursCheck: { setByHand, suggested },
    ticked,
    rateBp,
    possibleCents: figs.possibleCents,
    earnedCents: figs.earnedCents,
    lostCents: figs.lostCents,
    totalPoints,
    shares,
    owedCents,
    note: row.note,
    confirmedDate: row.confirmed_date,
    confirmed: confirmed ? { at: row.confirmed_at, by: userRef(row.confirmed_by, row.confirmed_by_name) } : null,
    createdAt: row.created_at,
    createdBy: userRef(row.created_by, row.created_by_name),
    updatedAt: row.updated_at,
    updatedBy: userRef(row.updated_by, row.updated_by_name),
  };
}

// The stored fields, as the create and delete audit rows record them.
function storedFields(row) {
  const checks = {};
  for (const c of CHECKS) checks[c.key] = row[c.col] == null ? null : row[c.col] === 1;
  return {
    jobId: row.job_id,
    status: row.status,
    priceCents: row.price_cents,
    ranBy: row.ran_by,
    checkedBy: row.checked_by,
    quotedFactoryMin: row.quoted_factory_min,
    quotedInstallMin: row.quoted_install_min,
    actualFactoryMin: row.actual_factory_min,
    actualInstallMin: row.actual_install_min,
    quotedFromJoinr: row.quoted_from_joinr === 1,
    checks,
    note: row.note,
  };
}

// -> {bonuses: [bonus]}
function list(db, { status } = {}) {
  const s = status === undefined || status === null || status === "" ? "all" : status;
  if (typeof s !== "string" || !LIST_STATUSES.includes(s)) throw bad(`Unknown status: ${s}`);
  let where = "";
  if (s === "draft") where = "WHERE b.status = 'draft'";
  else if (s === "confirmed") where = "WHERE b.status = 'confirmed'";
  else if (s === "owed") {
    where = `WHERE b.status = 'confirmed'
               AND EXISTS (SELECT 1 FROM bonus_shares s WHERE s.bonus_id = b.id AND s.paid_date IS NULL)`;
  }
  const rows = db.prepare(`${BONUS_SQL} ${where}`).all();
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === "draft" ? -1 : 1;
    if (a.status === "draft") return byNameCaseBlind(a.job_name, b.job_name) || a.id - b.id;
    if (a.confirmed_date !== b.confirmed_date) return a.confirmed_date < b.confirmed_date ? 1 : -1;
    return a.id - b.id;
  });
  const live = settings(db);
  return { bonuses: rows.map((r) => bonusOut(db, r, live)) };
}

// -> bonus (404)
function get(db, id) {
  return bonusOut(db, rowOr404(db, id));
}

// Reads the create/update body keys present (section 4.4), checked in a fixed order. Returns
// {cols: {column: value}} for each key present. `row` is the bonus (null on create): its people
// may stay archived. Call inside the transaction (a worker may get a pay_people row).
function readBody(db, body, row) {
  const cols = {};
  if (has(body, "priceCents")) {
    const v = body.priceCents;
    if (v !== null && !wholeIn(v, 0, PRICE_MAX)) throw bad("The price must be whole cents from $0 to $100,000,000");
    cols.price_cents = v;
  }
  for (const p of PEOPLE) {
    if (!has(body, p.key)) continue;
    const v = body[p.key];
    if (v === null) {
      cols[p.col] = null;
      continue;
    }
    const keep = new Set(row && row[p.col] != null ? [row[p.col]] : []);
    cols[p.col] = resolvePerson(db, v, p.label, keep);
  }
  for (const m of MINUTES) {
    if (!has(body, m.key)) continue;
    const v = body[m.key];
    if (v !== null && !wholeIn(v, 0, MIN_MAX)) throw bad(`${m.label} must be minutes from 0 to 600000`);
    cols[m.col] = v;
  }
  if (has(body, "checks")) {
    const c = body.checks;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw bad("Checks must be an object");
    for (const k of Object.keys(c)) {
      if (!CHECK.has(k)) throw bad(`Unknown field: checks.${k}`);
    }
    for (const def of CHECKS) {
      if (!has(c, def.key)) continue;
      const v = c[def.key];
      if (def.key === "hours" && v === null) {
        cols[def.col] = null;
        continue;
      }
      if (typeof v !== "boolean") throw bad(`${def.label} must be true or false`);
      cols[def.col] = v ? 1 : 0;
    }
  }
  if (has(body, "note")) {
    const v = body.note;
    if (v !== null && typeof v !== "string") throw bad("Note must be text");
    const t = v === null ? "" : v.trim();
    if (t.length > NOTE_MAX) throw bad("Note must be 1000 characters or fewer");
    cols.note = t;
  }
  return cols;
}

// The API name and audit value of a column (people as their person id, checks as booleans).
const COL_KEY = new Map([
  ["price_cents", "priceCents"],
  ["ran_by", "ranBy"],
  ["checked_by", "checkedBy"],
  ["note", "note"],
  ["quoted_from_joinr", "quotedFromJoinr"],
  ...MINUTES.map((m) => [m.col, m.key]),
]);
const CHECK_COL = new Map(CHECKS.map((c) => [c.col, c.key]));

function auditValue(col, v) {
  if (CHECK_COL.has(col) || col === "quoted_from_joinr") return v == null ? null : v === 1;
  return v;
}

// Before/after holding only the changed columns.
function changeSets(row, changes) {
  const before = {};
  const after = {};
  for (const [col, v] of Object.entries(changes)) {
    if (CHECK_COL.has(col)) {
      before.checks = before.checks || {};
      after.checks = after.checks || {};
      before.checks[CHECK_COL.get(col)] = auditValue(col, row[col]);
      after.checks[CHECK_COL.get(col)] = auditValue(col, v);
    } else {
      before[COL_KEY.get(col)] = auditValue(col, row[col]);
      after[COL_KEY.get(col)] = auditValue(col, v);
    }
  }
  return { before, after };
}

// Writes the changed columns with updated_at/by and the bonus.update row; nothing changed: nothing.
function applyChanges(db, req, row, cols) {
  const changes = {};
  for (const [col, v] of Object.entries(cols)) if (row[col] !== v) changes[col] = v;
  if (("quoted_factory_min" in changes || "quoted_install_min" in changes) && !("quoted_from_joinr" in cols)) {
    if (row.quoted_from_joinr === 1) changes.quoted_from_joinr = 0;
  }
  const names = Object.keys(changes);
  if (!names.length) return false;
  const sets = names.map((c) => `${c} = ?`).join(", ");
  db.prepare(`UPDATE bonuses SET ${sets}, updated_at = ?, updated_by = ? WHERE id = ?`).run(
    ...names.map((c) => changes[c]),
    nowIso(),
    userId(req),
    row.id
  );
  const { before, after } = changeSets(row, changes);
  audit.log(req, { action: "bonus.update", entityType: "bonus", entityId: row.id, before, after });
  return true;
}

function checkKeys(body, allowed) {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw bad(`Unknown field: ${k}`);
}

function plainBody(body) {
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

// -> bonus. Body {jobId, ...section 4.4 keys}.
function create(db, req, body) {
  const b = plainBody(body);
  checkKeys(b, ["jobId", ...BODY_KEYS]);
  if (b.jobId === undefined || b.jobId === null) throw bad("jobId is required");
  const jobId = bodyId(b.jobId);
  if (!jobId) throw notFound();
  const id = db.transaction(() => {
    const job = db.prepare("SELECT id, value_cents FROM jobs WHERE id = ?").get(jobId);
    if (!job) throw notFound();
    if (db.prepare("SELECT 1 FROM bonuses WHERE job_id = ?").get(jobId)) throw conflict("This job already has a bonus");
    const cols = readBody(db, b, null);
    // The price from the job's value as stored (inc GST, Problem 2), only for a jobs.value holder.
    if (!has(b, "priceCents") && can(req, "jobs.value")) {
      const v = job.value_cents;
      cols.price_cents = wholeIn(v, 0, PRICE_MAX) ? v : null;
    }
    // Quoted hours left out come from Joinr (section 4.5).
    const leftFactory = !has(b, "quotedFactoryMin");
    const leftInstall = !has(b, "quotedInstallMin");
    let fromJoinr = 0;
    if (leftFactory || leftInstall) {
      const jh = joinrHours(db, jobId);
      if (jh) {
        if (leftFactory) cols.quoted_factory_min = jh.quotedFactoryMin;
        if (leftInstall) cols.quoted_install_min = jh.quotedInstallMin;
        if (leftFactory && leftInstall) fromJoinr = 1;
      }
    }
    const now = nowIso();
    const uid = userId(req);
    // bonuses.id has no AUTOINCREMENT (026) and a draft can be deleted, so a new bonus never
    // takes an id that was used before: past the highest live id and past any id in the audit log.
    const { nextId } = db
      .prepare(
        `SELECT MAX(COALESCE((SELECT MAX(id) FROM bonuses), 0),
                    COALESCE((SELECT MAX(CAST(entity_id AS INTEGER)) FROM audit_log WHERE entity_type = 'bonus'), 0)) + 1 AS nextId`
      )
      .get();
    const data = {
      id: Number(nextId),
      job_id: jobId,
      status: "draft",
      price_cents: null,
      ran_by: null,
      checked_by: null,
      quoted_factory_min: null,
      quoted_install_min: null,
      actual_factory_min: null,
      actual_install_min: null,
      quoted_from_joinr: fromJoinr,
      check_drawn: 0,
      check_ordered: 0,
      check_assembled: 0,
      check_installed: 0,
      check_no_fuss: 0,
      check_on_time: 0,
      check_hours: null,
      note: "",
      ...cols,
      created_at: now,
      created_by: uid,
      updated_at: now,
      updated_by: uid,
    };
    const names = Object.keys(data);
    const info = db
      .prepare(`INSERT INTO bonuses (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
      .run(...names.map((n) => data[n]));
    const newId = Number(info.lastInsertRowid);
    const row = rowOf(db, newId);
    audit.log(req, { action: "bonus.create", entityType: "bonus", entityId: newId, after: storedFields(row) });
    return newId;
  })();
  return get(db, id);
}

function draftOr409(row) {
  if (row.status !== "draft") throw conflict("This bonus is confirmed; reopen it to change it");
}

// -> bonus. Draft only; the keys present change.
function update(db, req, id, body) {
  db.transaction(() => {
    const row = rowOr404(db, id);
    draftOr409(row);
    const b = plainBody(body);
    checkKeys(b, BODY_KEYS);
    applyChanges(db, req, row, readBody(db, b, row));
  })();
  return get(db, id);
}

// -> bonus. The quoted hours from Joinr again.
function fillHours(db, req, id) {
  db.transaction(() => {
    const row = rowOr404(db, id);
    draftOr409(row);
    const jh = joinrHours(db, row.job_id);
    if (!jh) throw conflict("No Joinr hours for this job");
    applyChanges(db, req, row, {
      quoted_factory_min: jh.quotedFactoryMin,
      quoted_install_min: jh.quotedInstallMin,
      quoted_from_joinr: 1,
    });
  })();
  return get(db, id);
}

// -> bonus. Body {confirmedDate?}: freezes the figures and writes the share rows.
function confirm(db, req, id, body) {
  db.transaction(() => {
    const row = rowOr404(db, id);
    if (row.status === "confirmed") throw conflict("This bonus is already confirmed");
    const b = plainBody(body);
    checkKeys(b, ["confirmedDate"]);
    const today = sydneyToday();
    let date = today;
    if (b.confirmedDate !== undefined && b.confirmedDate !== null) {
      if (!validDate(b.confirmedDate)) throw bad("The confirmed date must be a date");
      date = b.confirmedDate;
    }
    if (date > today) throw bad("The confirmed date can't be in the future");
    if (row.price_cents == null) throw bad("Fill in the price before confirming");
    const s = settings(db);
    const checks = checksOf(row);
    const ticked = tickedOf(checks);
    const figs = figures(row.price_cents, s.rateBp, ticked);
    if (figs.earnedCents > 0 && s.totalPoints === 0) throw conflict("Set the share points before confirming");
    const shares = splitShares(figs.earnedCents, s.holders).filter((h) => h.shareCents > 0);
    const sharesJson = {
      holders: s.holders.map((h) => ({ personId: h.personId, name: h.name, points: h.points })),
      totalPoints: s.totalPoints,
    };
    const now = nowIso();
    const uid = userId(req);
    db.prepare(
      `UPDATE bonuses SET status = 'confirmed', confirmed_date = ?, rate_bp = ?, possible_cents = ?, earned_cents = ?,
              check_hours = ?, shares_json = ?, confirmed_at = ?, confirmed_by = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`
    ).run(
      date,
      s.rateBp,
      figs.possibleCents,
      figs.earnedCents,
      checks.hours ? 1 : 0,
      JSON.stringify(sharesJson),
      now,
      uid,
      now,
      uid,
      id
    );
    const ins = db.prepare("INSERT INTO bonus_shares (bonus_id, person_id, points, share_cents) VALUES (?, ?, ?, ?)");
    for (const h of shares) ins.run(id, h.personId, h.points, h.shareCents);
    audit.log(req, {
      action: "bonus.confirm",
      entityType: "bonus",
      entityId: id,
      after: {
        confirmedDate: date,
        rateBp: s.rateBp,
        priceCents: row.price_cents,
        ticked,
        possibleCents: figs.possibleCents,
        earnedCents: figs.earnedCents,
        shares: shares.map((h) => ({ personId: h.personId, shareCents: h.shareCents })),
      },
    });
  })();
  return get(db, id);
}

// -> bonus. Confirmed, nothing paid: back to a draft that follows the current settings.
function reopen(db, req, id) {
  db.transaction(() => {
    const row = rowOr404(db, id);
    if (row.status !== "confirmed") throw conflict("Only a confirmed bonus can be reopened");
    const shares = db.prepare("SELECT person_id, points, share_cents, paid_date FROM bonus_shares WHERE bonus_id = ? ORDER BY person_id").all(id);
    if (shares.some((s) => s.paid_date)) throw conflict("A share of this bonus has been paid; undo that first");
    const frozen = frozenShares(row);
    // The Hours check goes back to following the suggestion when the frozen value is what it
    // suggested; a value that differs was set by hand and stays.
    const suggested = suggestedHours(row);
    const checkHours = row.check_hours === (suggested === true ? 1 : 0) ? null : row.check_hours;
    db.prepare("DELETE FROM bonus_shares WHERE bonus_id = ?").run(id);
    db.prepare(
      `UPDATE bonuses SET status = 'draft', confirmed_date = NULL, rate_bp = NULL, possible_cents = NULL,
              earned_cents = NULL, shares_json = NULL, confirmed_at = NULL, confirmed_by = NULL, check_hours = ?,
              updated_at = ?, updated_by = ?
        WHERE id = ?`
    ).run(checkHours, nowIso(), userId(req), id);
    audit.log(req, {
      action: "bonus.reopen",
      entityType: "bonus",
      entityId: id,
      before: {
        confirmedDate: row.confirmed_date,
        rateBp: row.rate_bp,
        priceCents: row.price_cents,
        possibleCents: row.possible_cents,
        earnedCents: row.earned_cents,
        checkHours: row.check_hours === 1,
        totalPoints: frozen.totalPoints,
        shares: shares.map((s) => ({ personId: s.person_id, points: s.points, shareCents: s.share_cents })),
      },
    });
  })();
  return get(db, id);
}

// -> {ok: true}. Drafts only.
function remove(db, req, id) {
  db.transaction(() => {
    const row = rowOr404(db, id);
    if (row.status !== "draft") throw conflict("Only a draft bonus can be deleted");
    db.prepare("DELETE FROM bonuses WHERE id = ?").run(id);
    audit.log(req, { action: "bonus.delete", entityType: "bonus", entityId: id, before: storedFields(row) });
  })();
  return { ok: true };
}

// --------------------------------------------------------------- paying ---

// The paid date and pay run of a mark-paid body: {date, payRunId}. `notBefore` is the latest
// confirmed date the date is checked against.
function paidInput(db, b, notBefore) {
  const today = sydneyToday();
  let date = today;
  if (b.paidDate !== undefined && b.paidDate !== null) {
    if (!validDate(b.paidDate)) throw bad("The paid date must be a date");
    date = b.paidDate;
  }
  if (date > today) throw bad("The paid date can't be in the future");
  if (notBefore && date < notBefore) {
    throw bad(`The paid date can't be before the bonus was confirmed (${dayLabel(notBefore)})`);
  }
  let payRunId = null;
  if (b.payRunId !== undefined && b.payRunId !== null) {
    const rid = bodyId(b.payRunId);
    if (!rid || !db.prepare("SELECT 1 FROM pay_runs WHERE id = ?").get(rid)) throw bad("No such pay run");
    payRunId = rid;
  }
  return { date, payRunId };
}

function setPaid(db, req, bonusId, share, { date, payRunId }) {
  db.prepare(
    "UPDATE bonus_shares SET paid_date = ?, pay_run_id = ?, paid_at = ?, paid_by = ? WHERE bonus_id = ? AND person_id = ?"
  ).run(date, payRunId, nowIso(), userId(req), bonusId, share.person_id);
  audit.log(req, {
    action: "bonus.paid",
    entityType: "bonus",
    entityId: bonusId,
    after: { personId: share.person_id, shareCents: share.share_cents, paidDate: date, payRunId },
  });
}

// -> bonus. Body {paidDate?, payRunId?} or {undo: true}.
function markPaid(db, req, id, personId, body) {
  db.transaction(() => {
    const row = rowOr404(db, id);
    if (row.status !== "confirmed") throw conflict("Confirm the bonus first");
    const share = db.prepare("SELECT * FROM bonus_shares WHERE bonus_id = ? AND person_id = ?").get(id, personId);
    if (!share) throw notFound();
    const b = plainBody(body);
    checkKeys(b, ["paidDate", "payRunId", "undo"]);
    if (b.undo !== undefined && b.undo !== false) {
      if (b.undo !== true) throw bad("undo must be true or false");
      if (!share.paid_date) throw conflict("This share isn't marked paid");
      db.prepare(
        "UPDATE bonus_shares SET paid_date = NULL, pay_run_id = NULL, paid_at = NULL, paid_by = NULL WHERE bonus_id = ? AND person_id = ?"
      ).run(id, personId);
      audit.log(req, {
        action: "bonus.unpaid",
        entityType: "bonus",
        entityId: id,
        before: { personId, shareCents: share.share_cents, paidDate: share.paid_date, payRunId: share.pay_run_id },
        after: { personId, shareCents: share.share_cents, paidDate: null, payRunId: null },
      });
      return;
    }
    if (share.paid_date) throw conflict("This share is already marked paid");
    setPaid(db, req, id, share, paidInput(db, b, row.confirmed_date));
  })();
  return get(db, id);
}

// The person's owed shares: [{bonus_id, confirmed_date, person_id, share_cents}].
function owedShares(db, personId) {
  return db
    .prepare(
      `SELECT s.bonus_id, s.person_id, s.share_cents, b.confirmed_date
         FROM bonus_shares s JOIN bonuses b ON b.id = s.bonus_id
        WHERE s.person_id = ? AND b.status = 'confirmed' AND s.paid_date IS NULL
        ORDER BY b.confirmed_date DESC, b.id DESC`
    )
    .all(personId);
}

// -> summary. Body {bonusIds, paidDate?, payRunId?}: every share the person is owed, guarded by the
// list the page showed.
function markPersonPaid(db, req, personId, body) {
  db.transaction(() => {
    if (!payroll.personById(db, personId)) throw notFound();
    const b = plainBody(body);
    checkKeys(b, ["bonusIds", "paidDate", "payRunId"]);
    const ids = b.bonusIds;
    if (!Array.isArray(ids) || ids.some((v) => !bodyId(v))) throw bad("bonusIds must be a list of bonus ids");
    if (!ids.length) throw bad("Nothing owed to mark paid");
    const owed = owedShares(db, personId);
    const want = [...new Set(ids.map(bodyId))].sort((x, y) => x - y);
    const have = owed.map((s) => s.bonus_id).sort((x, y) => x - y);
    if (want.length !== ids.length || want.length !== have.length || want.some((v, i) => v !== have[i])) {
      throw conflict("The owed list changed while you were looking; reload it");
    }
    // owed is newest confirmed date first, so the date is checked against the latest.
    const input = paidInput(db, b, owed[0].confirmed_date);
    for (const s of [...owed].reverse()) setPaid(db, req, s.bonus_id, s, input);
  })();
  return summary(db);
}

// ---------------------------------------------------------------- summary ---

// Section 4.6: over confirmed bonuses' share rows only.
function summary(db, today = sydneyToday()) {
  void today;
  const rows = db
    .prepare(
      `SELECT s.bonus_id, s.person_id, s.share_cents, s.paid_date, b.job_id, b.confirmed_date, j.name AS job_name
         FROM bonus_shares s
         JOIN bonuses b ON b.id = s.bonus_id
         JOIN jobs j ON j.id = b.job_id
        WHERE b.status = 'confirmed'
        ORDER BY b.confirmed_date, b.id`
    )
    .all();
  const byPerson = new Map();
  const totals = { earnedCents: 0, paidCents: 0, owedCents: 0 };
  for (const r of rows) {
    let p = byPerson.get(r.person_id);
    if (!p) {
      const ref = personRef(db, r.person_id);
      p = { personId: r.person_id, name: ref.name, archived: ref.archived, earnedCents: 0, paidCents: 0, owedCents: 0, owed: [] };
      byPerson.set(r.person_id, p);
    }
    p.earnedCents += r.share_cents;
    totals.earnedCents += r.share_cents;
    if (r.paid_date) {
      p.paidCents += r.share_cents;
      totals.paidCents += r.share_cents;
    } else {
      p.owedCents += r.share_cents;
      totals.owedCents += r.share_cents;
      p.owed.push({
        bonusId: r.bonus_id,
        jobId: r.job_id,
        jobName: r.job_name,
        confirmedDate: r.confirmed_date,
        shareCents: r.share_cents,
      });
    }
  }
  const peopleOut = [...byPerson.values()].sort((a, b) => byNameCaseBlind(a.name, b.name) || a.personId - b.personId);
  const payRuns = db
    .prepare(`SELECT id, start_date, end_date, status FROM pay_runs ORDER BY start_date DESC LIMIT ${PAY_RUNS_MAX}`)
    .all()
    .map((r) => ({ id: r.id, startDate: r.start_date, endDate: r.end_date, status: r.status }));
  return { people: peopleOut, totals, payRuns };
}

// ------------------------------------------------------------ Joinr hours ---

// Section 4.5: the job's newest accepted or linked intake record's estimatedHours.factory and .site,
// doubled back (Joinr's engine halves them) and in minutes. Each null unless a finite number >= 0
// (and within the column's 600000 minutes); null when there's no record or no estimatedHours.
function joinrHours(db, jobId) {
  const rec = db
    .prepare(
      `SELECT payload FROM joinr_intake
        WHERE job_id = ? AND state IN ('accepted', 'linked')
        ORDER BY last_seen_at DESC, id DESC LIMIT 1`
    )
    .get(jobId);
  if (!rec) return null;
  const p = parseJson(rec.payload);
  const h = p && typeof p === "object" ? p.estimatedHours : null;
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  const minutes = (v) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    const m = Math.round(v * 2 * 60);
    return m <= MIN_MAX ? m : null;
  };
  return { quotedFactoryMin: minutes(h.factory), quotedInstallMin: minutes(h.site) };
}

module.exports = {
  settings,
  putSettings,
  people,
  jobs,
  list,
  get,
  create,
  update,
  fillHours,
  confirm,
  reopen,
  remove,
  markPaid,
  markPersonPaid,
  summary,
  joinrHours,
  // For the local maths checks (section 11.8 B); not used by the routes.
  _maths: { roundDiv, figures, splitShares },
};
