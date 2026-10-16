// Client inspections (two-pac jobs). See docs/plans/m3-contracts.md section 2.
// Booking, moving and cancelling notify scheduling.view holders (not the actor)
// and are audited. Dates are Sydney YYYY-MM-DD, times Sydney HH:MM.
const audit = require("./audit");
const invoices = require("./invoices");
const notify = require("./notify");
const { bad, notFound, conflict } = require("./httperror");

const STATUSES = ["booked", "done", "cancelled"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const HOST_MAX = 200;
const NOTES_MAX = 2000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const SELECT_BASE = `SELECT i.*, j.name AS job_name, u.display_name AS created_by_name
  FROM inspections i
  JOIN jobs j ON j.id = i.job_id
  LEFT JOIN users u ON u.id = i.created_by`;

function nowIso() {
  return new Date().toISOString();
}

// "2034-11-14" -> "14 Nov". Pure string work: no timezone involved.
function dMon(date) {
  const [, m, d] = String(date).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

function when(date, time) {
  return `${dMon(date)}${time ? ` ${time}` : ""}`;
}

function present(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    jobName: row.job_name,
    date: row.date,
    time: row.time || null,
    host: row.host,
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by == null ? null : row.created_by,
    createdByName: row.created_by_name || null,
  };
}

function load(db, id) {
  return db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(id);
}

function listForJob(db, jobId) {
  if (!db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId)) throw notFound();
  return db
    .prepare(`${SELECT_BASE} WHERE i.job_id = ? ORDER BY i.date DESC, (i.time IS NULL), i.time DESC, i.id DESC`)
    .all(jobId)
    .map(present);
}

function textField(label, v, max) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw bad(`${label} must be a string`);
  const t = v.trim();
  if (t.length > max) throw bad(`${label} must be ${max} characters or fewer`);
  return t;
}

function parseDate(v) {
  if (!invoices.validDate(v)) throw bad("date must be a valid YYYY-MM-DD date");
  return v;
}

// null / "" -> null; HH:MM (24 h) -> itself; anything else -> 400.
function parseTime(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !TIME_RE.test(v)) throw bad("time must be HH:MM (24 hour)");
  return v;
}

function notifyScheduling(db, req, { kind, title, jobId, id }) {
  notify.toKey(
    db,
    "scheduling.view",
    { kind, title, link: `/job.html?id=${jobId}#inspection`, entityType: "inspection", entityId: id },
    { exceptUserId: req && req.user ? req.user.id : null }
  );
}

function create(db, jobId, { date, time, host, notes } = {}, req) {
  const job = db.prepare("SELECT id, name FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw notFound();
  const d = parseDate(date);
  const t = parseTime(time);
  let h = textField("host", host, HOST_MAX);
  if (!h) h = (req && req.user && req.user.displayName) || "";
  const n = textField("notes", notes, NOTES_MAX);
  return db.transaction(() => {
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO inspections (job_id, date, time, host, notes, status, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'booked', ?, ?, ?)`
      )
      .run(jobId, d, t, h, n, now, now, req && req.user ? req.user.id : null);
    const id = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "inspection.create",
      entityType: "inspection",
      entityId: id,
      after: { job_id: jobId, date: d, time: t, host: h, notes: n, status: "booked" },
    });
    notifyScheduling(db, req, {
      kind: "inspection.booked",
      title: `Inspection booked: ${job.name}, ${when(d, t)}`,
      jobId,
      id,
    });
    return present(load(db, id));
  })();
}

function update(db, id, patch, req) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("JSON body required");
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined;
  const row = load(db, id);
  if (!row) throw notFound();

  const next = {};
  if (has("status")) {
    if (patch.status === "cancelled") throw bad("Use cancel");
    if (patch.status !== "booked" && patch.status !== "done") throw bad("status must be booked or done");
    next.status = patch.status;
  }
  if (has("date")) next.date = parseDate(patch.date);
  if (has("time")) next.time = parseTime(patch.time);
  if (has("host")) next.host = textField("host", patch.host, HOST_MAX);
  if (has("notes")) next.notes = textField("notes", patch.notes, NOTES_MAX);
  if (row.status === "cancelled") throw conflict("Cancelled inspections can't be changed");

  const changes = {};
  for (const [col, v] of Object.entries(next)) {
    if (v !== (row[col] === undefined ? null : row[col])) changes[col] = v;
  }
  const cols = Object.keys(changes);
  if (!cols.length) return present(row);

  return db.transaction(() => {
    db.prepare(`UPDATE inspections SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
      ...cols.map((c) => changes[c]),
      nowIso(),
      id
    );
    const before = {};
    const after = {};
    for (const c of cols) {
      before[c] = row[c];
      after[c] = changes[c];
    }
    audit.log(req, { action: "inspection.update", entityType: "inspection", entityId: id, before, after });
    const finalStatus = "status" in changes ? changes.status : row.status;
    if (finalStatus === "booked" && ("date" in changes || "time" in changes)) {
      const d = "date" in changes ? changes.date : row.date;
      const t = "time" in changes ? changes.time : row.time;
      notifyScheduling(db, req, {
        kind: "inspection.moved",
        title: `Inspection moved: ${row.job_name}, ${when(d, t)}`,
        jobId: row.job_id,
        id,
      });
    }
    return present(load(db, id));
  })();
}

function cancel(db, id, req) {
  const row = load(db, id);
  if (!row) throw notFound();
  if (row.status === "cancelled") throw conflict("Already cancelled");
  return db.transaction(() => {
    db.prepare("UPDATE inspections SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), id);
    audit.log(req, {
      action: "inspection.cancel",
      entityType: "inspection",
      entityId: id,
      before: { status: row.status },
      after: { status: "cancelled" },
    });
    notifyScheduling(db, req, {
      kind: "inspection.cancelled",
      title: `Inspection cancelled: ${row.job_name}, ${dMon(row.date)}`,
      jobId: row.job_id,
      id,
    });
    return present(load(db, id));
  })();
}

module.exports = { STATUSES, TIME_RE, present, listForJob, create, update, cancel };
