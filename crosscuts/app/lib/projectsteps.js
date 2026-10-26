// Projects steps and hand-offs (0.2.2, Todd 2026-10-26; docs/plans/m23-contracts.md; migration 042).
//
// The project manager's steps on each job: Drawn, Check measured and Nested are ticks with who and
// when (job_steps; an untick deletes the row and is audited); Order list ready is derived (a
// finalised current revision, lib/projectjobs.js). A check measure can be booked ahead
// (check_measures, like inspections) and shows on the Planner on the Projects layer.
//
// Also here: the step marks the Pipeline tiles and My projects show (D, CM, N, OL), ordering
// progress (n of m ordered), the "needs a project owner" alert (ownerSweep), My projects, and the
// order manager's alert when a list is sent to Ordering.
//
// Every function takes db first; nothing here requires ../db.
const audit = require("./audit");
const notify = require("./notify");
const invoices = require("./invoices");
const jobstage = require("./jobstage");
const { computeEffective } = require("./permissions");
const { bad, notFound, conflict, can } = require("./httperror");

const STEPS = ["drawn", "check_measured", "nested"];
const STEP_LABEL = { drawn: "Drawn", check_measured: "Check measured", nested: "Nested" };
// The text marks on tiles and My projects, in order. OL (order list ready) is derived.
const MARKS = [
  { key: "drawn", mark: "D", label: "Drawn" },
  { key: "check_measured", mark: "CM", label: "Check measured" },
  { key: "nested", mark: "N", label: "Nested" },
  { key: "order_list", mark: "OL", label: "Order list ready" },
];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HOST_MAX = 200;
const NOTES_MAX = 2000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The jobs My projects lists: still with the project manager or on their way to the board.
const LIVE_SHOWN = ["won", "projects", "ordering", "ready_to_cut", "on_board"];
const OWNER_NEEDED = "project.owner_needed";
const SENT_KIND = "project.sent";

const nowIso = () => new Date().toISOString();
const userId = (req) => (req && req.user && req.user.id != null ? req.user.id : null);

function dMon(date) {
  const [, m, d] = String(date).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

function requireJob(db, jobId) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw notFound();
  return job;
}

// Who may tick steps and book check measures: users.admin, or jobs.edit with design.view (the same
// rule as setting the owner).
function canWork(req) {
  return can(req, "users.admin") || (can(req, "jobs.edit") && can(req, "design.view"));
}

// ---- the steps ---------------------------------------------------------------------------------

// {drawn, check_measured, nested}: each {doneAt, doneBy: {id, name} | null} or null.
function stepsOf(db, jobId) {
  const out = { drawn: null, check_measured: null, nested: null };
  const rows = db
    .prepare(
      `SELECT s.step, s.done_at, s.done_by, u.display_name FROM job_steps s LEFT JOIN users u ON u.id = s.done_by
        WHERE s.job_id = ?`
    )
    .all(jobId);
  for (const r of rows) {
    out[r.step] = { doneAt: r.done_at, doneBy: r.done_by == null ? null : { id: r.done_by, name: r.display_name || null } };
  }
  return out;
}

function parseStep(step) {
  if (typeof step !== "string" || !STEPS.includes(step)) throw bad(`step must be one of ${STEPS.join(", ")}`);
  return step;
}

// Tick (done true) or untick (done false) one step. Returns true when something changed.
function setStep(db, req, jobId, step, done) {
  const s = parseStep(step);
  if (typeof done !== "boolean") throw bad("done must be true or false");
  return db.transaction(() => {
    requireJob(db, jobId);
    const row = db
      .prepare(
        `SELECT s.done_at, s.done_by, u.display_name FROM job_steps s LEFT JOIN users u ON u.id = s.done_by
          WHERE s.job_id = ? AND s.step = ?`
      )
      .get(jobId, s);
    if (!!row === done) return false;
    if (done) {
      const at = nowIso();
      db.prepare("INSERT INTO job_steps (job_id, step, done_at, done_by) VALUES (?, ?, ?, ?)").run(jobId, s, at, userId(req));
      audit.log(req, { action: "job.step", entityType: "job", entityId: jobId, before: { step: s, done: false }, after: { step: s, done: true, doneAt: at } });
    } else {
      db.prepare("DELETE FROM job_steps WHERE job_id = ? AND step = ?").run(jobId, s);
      audit.log(req, {
        action: "job.step",
        entityType: "job",
        entityId: jobId,
        before: { step: s, done: true, doneAt: row.done_at, doneBy: row.display_name || null },
        after: { step: s, done: false },
      });
    }
    return true;
  })();
}

// ---- check measures ----------------------------------------------------------------------------

const CM_SELECT = `SELECT c.*, j.name AS job_name, u.display_name AS created_by_name
  FROM check_measures c JOIN jobs j ON j.id = c.job_id LEFT JOIN users u ON u.id = c.created_by`;

function presentCm(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    date: row.date,
    time: row.time || null,
    host: row.host,
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByName: row.created_by_name || null,
  };
}

function checkMeasuresOf(db, jobId) {
  return db
    .prepare(`${CM_SELECT} WHERE c.job_id = ? ORDER BY c.date DESC, (c.time IS NULL), c.time DESC, c.id DESC`)
    .all(jobId)
    .map(presentCm);
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
function parseTime(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !TIME_RE.test(v)) throw bad("time must be HH:MM (24 hour)");
  return v;
}

function bookCheckMeasure(db, req, jobId, b) {
  const job = requireJob(db, jobId);
  const d = parseDate(b.date);
  const t = parseTime(b.time);
  let h = textField("host", b.host, HOST_MAX);
  if (!h) h = (req && req.user && req.user.displayName) || "";
  const n = textField("notes", b.notes, NOTES_MAX);
  return db.transaction(() => {
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO check_measures (job_id, date, time, host, notes, status, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'booked', ?, ?, ?)`
      )
      .run(job.id, d, t, h, n, now, now, userId(req));
    const id = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "check_measure.create",
      entityType: "job",
      entityId: job.id,
      after: { checkMeasureId: id, date: d, time: t, host: h, notes: n, status: "booked" },
    });
    return presentCm(db.prepare(`${CM_SELECT} WHERE c.id = ?`).get(id));
  })();
}

// Change the date, time, host, notes, or status (booked / done / cancelled). A cancelled booking
// can't change. Marking it done also ticks Check measured.
function updateCheckMeasure(db, req, id, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("JSON body required");
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined;
  const row = db.prepare(`${CM_SELECT} WHERE c.id = ?`).get(id);
  if (!row) throw notFound();
  if (row.status === "cancelled") throw conflict("A cancelled check measure can't be changed");
  const next = {};
  if (has("status")) {
    if (!["booked", "done", "cancelled"].includes(patch.status)) throw bad("status must be booked, done or cancelled");
    next.status = patch.status;
  }
  if (has("date")) next.date = parseDate(patch.date);
  if (has("time")) next.time = parseTime(patch.time);
  if (has("host")) next.host = textField("host", patch.host, HOST_MAX);
  if (has("notes")) next.notes = textField("notes", patch.notes, NOTES_MAX);
  const cols = Object.keys(next).filter((c) => next[c] !== (row[c] === undefined ? null : row[c]));
  if (!cols.length) return presentCm(row);
  return db.transaction(() => {
    db.prepare(`UPDATE check_measures SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
      ...cols.map((c) => next[c]),
      nowIso(),
      id
    );
    const before = { checkMeasureId: id };
    const after = { checkMeasureId: id };
    for (const c of cols) {
      before[c] = row[c];
      after[c] = next[c];
    }
    audit.log(req, { action: "check_measure.update", entityType: "job", entityId: row.job_id, before, after });
    if (next.status === "done") setStep(db, req, row.job_id, "check_measured", true);
    return presentCm(db.prepare(`${CM_SELECT} WHERE c.id = ?`).get(id));
  })();
}

function checkMeasureJob(db, id) {
  const row = db.prepare("SELECT job_id FROM check_measures WHERE id = ?").get(id);
  if (!row) throw notFound();
  return row.job_id;
}

// ---- marks and ordering progress ----------------------------------------------------------------

// {ordered, total, latestEta}: the job's live order lines (not cancelled); ordered = ordered or
// received; latestEta = the latest expected date of the lines still to come.
function orderingOf(db, jobId) {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('ordered','received') THEN 1 ELSE 0 END) AS ordered,
              MAX(CASE WHEN status IN ('to_order','ordered') THEN expected_date END) AS eta
         FROM orders WHERE job_id = ? AND status <> 'cancelled'`
    )
    .get(jobId);
  return { ordered: Number(r.ordered) || 0, total: Number(r.total) || 0, latestEta: r.eta || null };
}

// [{mark, label, done}] in D, CM, N, OL order, plus the raw steps and the order list state.
function marksOf(db, jobId) {
  const steps = stepsOf(db, jobId);
  const list = require("./projectjobs").listState(db, jobId);
  const done = {
    drawn: !!steps.drawn,
    check_measured: !!steps.check_measured,
    nested: !!steps.nested,
    order_list: !!(list.current && !list.changed),
  };
  return { marks: MARKS.map((m) => ({ mark: m.mark, label: m.label, done: done[m.key] })), steps, list };
}

// The extra a job object carries on the Pipeline and job pages (routes/jobs.js): marks while the
// job is at Won, Projects or Ordering; ordering progress once it is in Ordering.
function tileFacts(db, job) {
  const shown = jobstage.pipelineStage(job);
  if (!["won", "projects", "ordering"].includes(shown)) return null;
  const { marks } = marksOf(db, job.id);
  return { marks, ordering: shown === "ordering" ? orderingOf(db, job.id) : null };
}

// ---- what is waiting on the project manager --------------------------------------------------

// One short line: the next thing the owner has to do, or who the job is with.
function waitingOn(db, job, facts) {
  const shown = jobstage.pipelineStage(job);
  if (shown === "ordering") return "With Ordering";
  if (shown === "ready_to_cut") return "Ready to cut";
  if (shown === "on_board") return "On the board";
  const { steps, list } = facts;
  if (!steps.drawn) return "Draw";
  if (!steps.check_measured) {
    const booked = db
      .prepare("SELECT date, time FROM check_measures WHERE job_id = ? AND status = 'booked' ORDER BY date, time LIMIT 1")
      .get(job.id);
    return booked ? `Check measure booked ${dMon(booked.date)}${booked.time ? " " + booked.time : ""}` : "Book or tick the check measure";
  }
  if (!steps.nested) return "Nest";
  if (!list.current) return "Finalise the order list";
  if (list.changed) return `Finalise the changes since revision ${list.current.revision}`;
  if (!job.requested_install_date) return "Enter a requested install date";
  if (!list.current.sentAt) return "Send to Ordering";
  return "With Ordering";
}

// ---- My projects -------------------------------------------------------------------------------

// The signed-in user's owned jobs (or everyone's, for users.admin with all), one row each.
function myProjects(db, req, { all = false } = {}) {
  const everyone = !!all && can(req, "users.admin");
  const rows = db
    .prepare(
      `SELECT j.*, u.display_name AS owner_name, w.hue AS owner_hue FROM jobs j
         LEFT JOIN users u ON u.id = j.project_owner_id LEFT JOIN workers w ON w.id = u.worker_id
        WHERE j.archived = 0 AND j.project_owner_id IS NOT NULL ${everyone ? "" : "AND j.project_owner_id = ?"}
        ORDER BY (j.requested_install_date IS NULL), j.requested_install_date, j.name COLLATE NOCASE, j.id`
    )
    .all(...(everyone ? [] : [userId(req)]));
  const out = [];
  for (const j of rows) {
    const shown = jobstage.pipelineStage(j);
    if (!LIVE_SHOWN.includes(shown)) continue;
    const facts = marksOf(db, j.id);
    out.push({
      id: j.id,
      name: j.name,
      clientName: j.client_name || null,
      pipelineStage: shown,
      owner: { id: j.project_owner_id, name: j.owner_name, hue: j.owner_hue == null ? null : j.owner_hue },
      marks: facts.marks,
      requestedInstallDate: j.requested_install_date || null,
      promisedInstallDate: j.promised_install_date || null,
      revision: facts.list.current ? facts.list.current.revision : null,
      revisionChanged: facts.list.current ? !!facts.list.changed : null,
      ordering: shown === "projects" || shown === "won" ? null : orderingOf(db, j.id),
      waitingOn: waitingOn(db, j, facts),
    });
  }
  return { all: everyone, canAll: can(req, "users.admin"), jobs: out };
}

// ---- alerts ------------------------------------------------------------------------------------

// The people who may set an owner: users.admin, or jobs.edit together with design.view.
function ownerSetterIds(db) {
  const users = db.prepare("SELECT id, is_owner FROM users WHERE disabled = 0").all();
  const rolesOf = db.prepare("SELECT role FROM user_roles WHERE user_id = ?");
  const overridesOf = db.prepare("SELECT feature_key, effect FROM permission_overrides WHERE user_id = ?");
  return users
    .filter((u) => {
      const k = computeEffective(rolesOf.all(u.id).map((r) => r.role), overridesOf.all(u.id), Number(u.is_owner) === 1);
      return k.has("users.admin") || (k.has("jobs.edit") && k.has("design.view"));
    })
    .map((u) => u.id);
}

// Every live Won job with no project owner gets one "needs a project owner" alert per person who
// may set it, once (a person already sent one for that job, read or not, isn't sent another).
// Run just after a job becomes Won (soon) and every few minutes (start).
// Returns how many alerts were written.
function ownerSweep(db) {
  const jobs = db
    .prepare("SELECT id, name FROM jobs WHERE stage = 'won' AND project_owner_id IS NULL AND archived = 0")
    .all();
  if (!jobs.length) return 0;
  const ids = ownerSetterIds(db);
  if (!ids.length) return 0;
  const sent = db.prepare(
    "SELECT 1 FROM notifications WHERE user_id = ? AND kind = ? AND entity_type = 'job' AND entity_id = ? LIMIT 1"
  );
  let n = 0;
  db.transaction(() => {
    for (const j of jobs) {
      for (const uid of ids) {
        if (sent.get(uid, OWNER_NEEDED, String(j.id))) continue;
        notify.toUser(db, uid, {
          kind: OWNER_NEEDED,
          title: `${j.name} needs a project owner`,
          link: `/project.html?id=${j.id}`,
          entityType: "job",
          entityId: j.id,
        });
        n++;
      }
    }
  })();
  return n;
}

// On Send to Ordering: the order managers (orders.mark_ordered) are told, except the sender.
function sentAlert(db, req, jobId, { revision, created, suppliers }) {
  const job = db.prepare("SELECT name FROM jobs WHERE id = ?").get(jobId);
  const s = suppliers.length;
  return notify.toKey(
    db,
    "orders.mark_ordered",
    {
      kind: SENT_KIND,
      title: `Order list for ${job ? job.name : "a job"} sent: ${created} ${created === 1 ? "line" : "lines"}, ${s} ${s === 1 ? "supplier" : "suppliers"}`,
      body: `Revision ${revision}`,
      link: `/orders.html?job=${jobId}`,
      entityType: "job",
      entityId: jobId,
    },
    { exceptUserId: userId(req) }
  );
}

// ---- the sweep timer ---------------------------------------------------------------------------

let timer = null;
let queued = false;
function safeSweep(db) {
  try {
    ownerSweep(db);
  } catch (e) {
    console.error(`[projectsteps] owner sweep failed (${(e && e.code) || "error"})`);
  }
}
// A sweep just after the current request (and its transaction) has finished: called wherever a job
// becomes Won, so an owner set in the same request (Accept with an owner) is seen first.
function soon(db) {
  if (queued) return;
  queued = true;
  setImmediate(() => {
    queued = false;
    safeSweep(db);
  });
}
function start(db) {
  if (process.env.OWNER_SWEEP_DISABLED === "1" || timer) return;
  safeSweep(db);
  timer = setInterval(() => safeSweep(db), 5 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  STEPS,
  STEP_LABEL,
  MARKS,
  canWork,
  stepsOf,
  setStep,
  checkMeasuresOf,
  bookCheckMeasure,
  updateCheckMeasure,
  checkMeasureJob,
  orderingOf,
  marksOf,
  tileFacts,
  waitingOn,
  myProjects,
  ownerSetterIds,
  ownerSweep,
  safeSweep,
  soon,
  sentAlert,
  start,
};
