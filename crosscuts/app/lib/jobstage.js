// Job lifecycle stage helpers, called from the board routes (routes/schedule.js)
// and from routes/jobs.js. Each takes (db, jobId, req) and is meant to run
// inside the caller's existing transaction where there is one. They never throw:
// a stage-bookkeeping problem must not break a board edit.
const audit = require("./audit");
const invoices = require("./invoices");
const { sydneyToday, sydneyMonday } = require("./time");

// Stages a row placed on the board moves to on_board. "complete" is here so a
// finished job put back on the board (a return visit) is live again; invoiced,
// lost and archived are left alone.
const PRE_BOARD = new Set(["lead", "quoted", "won", "design_ordering", "ready_to_cut", "complete"]);

function nowIso() {
  return new Date().toISOString();
}

// Set the stage if it actually changes. Writes stage_changed_at and updated_at
// (plus any extra columns, e.g. completed_date) and audits job.stage.
// Returns true when something changed. `extra` keys are trusted column names.
function setStage(db, jobId, to, req, extra) {
  const job = db.prepare("SELECT stage FROM jobs WHERE id = ?").get(jobId);
  if (!job || job.stage === to) return false;
  const now = nowIso();
  const cols = ["stage = ?", "stage_changed_at = ?", "updated_at = ?"];
  const vals = [to, now, now];
  for (const [k, v] of Object.entries(extra || {})) {
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  db.prepare(`UPDATE jobs SET ${cols.join(", ")} WHERE id = ?`).run(...vals, jobId);
  audit.log(req, {
    action: "job.stage",
    entityType: "job",
    entityId: jobId,
    before: { stage: job.stage },
    after: { stage: to },
  });
  return true;
}

// Rows from `fromMonday` (default: this Sydney week's Monday) onwards.
function hasCurrentOrFutureRows(db, jobId, fromMonday) {
  return !!db
    .prepare("SELECT 1 AS x FROM week_rows WHERE job_id = ? AND week_start >= ? LIMIT 1")
    .get(jobId, fromMonday || sydneyMonday());
}

function safely(label, fn) {
  try {
    return fn();
  } catch (e) {
    console.error(`[jobstage] ${label} failed:`, e.message);
    return false;
  }
}

// A row was placed on a week (weekStart, a Monday): pre-board stages (or no
// stage) become on_board. Then, whatever the stage did, the invoice hook gets
// its chance (a deposit may fall due). It runs in its own savepoint and never
// throws.
function onScheduled(db, jobId, req, weekStart) {
  const moved = safely("onScheduled", () => {
    const job = db.prepare("SELECT stage FROM jobs WHERE id = ?").get(jobId);
    if (!job) return false;
    if (job.stage == null || PRE_BOARD.has(job.stage)) return setStage(db, jobId, "on_board", req);
    return false;
  });
  invoices.onScheduled(db, jobId, weekStart, req);
  return moved;
}

// A job went to "To start": an on_board job with no rows from the reference
// Monday (default: the current Sydney Monday) onwards becomes ready_to_cut.
// Any other stage (complete, invoiced, lost, archived, ...) is left alone.
function onSentToBacklog(db, jobId, req, referenceMonday) {
  return safely("onSentToBacklog", () => {
    const job = db.prepare("SELECT stage FROM jobs WHERE id = ?").get(jobId);
    if (!job || job.stage !== "on_board") return false;
    if (hasCurrentOrFutureRows(db, jobId, referenceMonday)) return false;
    return setStage(db, jobId, "ready_to_cut", req);
  });
}

// Finish week "complete": complete + completed_date, unless already complete/invoiced.
// After a successful change the invoice hook runs (the final falls due).
// `completedDate` (a validated Sydney date) is used instead of today when given.
function onFinishedComplete(db, jobId, req, completedDate) {
  return safely("onFinishedComplete", () => {
    const job = db.prepare("SELECT stage FROM jobs WHERE id = ?").get(jobId);
    if (!job || job.stage === "complete" || job.stage === "invoiced") return false;
    const changed = setStage(db, jobId, "complete", req, { completed_date: completedDate || sydneyToday() });
    if (changed) invoices.onCompleted(db, jobId, req);
    return changed;
  });
}

// Design/PM set ready_to_cut: make sure the job waits on the backlog (unless it
// already has current or future rows, or is already there; backlog.job_id is UNIQUE).
function onDesignReadyToCut(db, jobId, req) {
  return safely("onDesignReadyToCut", () => {
    setStage(db, jobId, "ready_to_cut", req);
    if (hasCurrentOrFutureRows(db, jobId)) return false;
    const maxOrder = db.prepare("SELECT MAX(sort_order) AS m FROM backlog").get().m;
    const info = db
      .prepare("INSERT OR IGNORE INTO backlog (job_id, sort_order) VALUES (?, ?)")
      .run(jobId, (maxOrder ?? -1) + 1);
    return info.changes > 0;
  });
}

// Board quick-add: a job typed straight onto the board or the To start list.
// source = board_quick_add; stage given by the caller ('on_board' or 'ready_to_cut').
function createBoardJob(db, req, { name, notes, stage }) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO jobs (name, notes, source, stage, stage_changed_at, updated_at)
       VALUES (?, ?, 'board_quick_add', ?, ?, ?)`
    )
    .run(name, notes || "", stage, now, now);
  const id = info.lastInsertRowid;
  audit.log(req, {
    action: "job.create",
    entityType: "job",
    entityId: id,
    after: { name, source: "board_quick_add", stage },
  });
  return id;
}

module.exports = {
  setStage,
  onScheduled,
  onSentToBacklog,
  onFinishedComplete,
  onDesignReadyToCut,
  createBoardJob,
};
