// Job lifecycle stage helpers, called from the board routes (routes/schedule.js)
// and from routes/jobs.js. Each takes (db, jobId, req) and is meant to run
// inside the caller's existing transaction where there is one. The board hooks
// never throw: a stage-bookkeeping problem must not break a board edit.
// The M3 hand-move path (moveStage, addToBacklog, removeFromBacklog; see
// docs/plans/m3-contracts.md section 2) does throw, so a failed move rolls the
// whole request back.
const audit = require("./audit");
const invoices = require("./invoices");
const { bad, notFound, conflict } = require("./httperror");
const { sydneyToday, sydneyMonday } = require("./time");

const STAGES = [
  "lead", "quoted", "won", "design_ordering", "ready_to_cut",
  "on_board", "complete", "invoiced", "lost", "archived",
];
// Stages a user may move a job to by hand; the derived ones are set by the
// board hooks (and later accounts). "lead" is retired (Todd, 2026-10-17): it stays
// in STAGES because migration 003's CHECK allows it and old rows may hold it, but
// nothing can move a job to it. A job still at lead shows and moves as quoted.
const RETIRED_STAGE_MSG = "The Lead stage is no longer used; start jobs at Quoted";
const MANUAL_STAGES = ["quoted", "won", "design_ordering", "ready_to_cut", "lost", "archived"];
const DERIVED_STAGES = ["on_board", "complete", "invoiced"];
// The key date a stage fills on entry when it is still empty.
const STAGE_DATE = { quoted: "quoted_date", won: "won_date", ready_to_cut: "ready_to_cut_date" };

const ON_BOARD_MSG = "This job is on the board; it moves from the board";
const DONE_MSG = "Complete and invoiced jobs can only be archived";

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
function setStage(db, jobId, to, req, extra, auditExtra) {
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
    after: { stage: to, ...(auditExtra || {}) },
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
function onFinishedComplete(db, jobId, req, completedDate, auditExtra) {
  return safely("onFinishedComplete", () => {
    const job = db.prepare("SELECT stage FROM jobs WHERE id = ?").get(jobId);
    if (!job || job.stage === "complete" || job.stage === "invoiced") return false;
    const changed = setStage(db, jobId, "complete", req, { completed_date: completedDate || sydneyToday() }, auditExtra);
    if (changed) invoices.onCompleted(db, jobId, req);
    return changed;
  });
}

// Projects set ready_to_cut: make sure the job waits on the backlog (unless it
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

// --- M3 hand moves (pipeline, job page) ---------------------------------

// The manual stages a job may be moved to from `fromStage` (never fromStage
// itself). Pure; public/pipeline.js and public/job.js mirror it.
function allowedTargets(fromStage) {
  if (fromStage === "on_board") return [];
  if (fromStage === "complete" || fromStage === "invoiced") return ["archived"];
  return MANUAL_STAGES.filter((s) => s !== fromStage);
}

// Put the job at the end of "To start", unless it has current or future week
// rows (backlog.job_id is UNIQUE, so a second add is ignored). Returns true if
// a row was added. Throws on error.
function addToBacklog(db, jobId) {
  if (hasCurrentOrFutureRows(db, jobId)) return false;
  const maxOrder = db.prepare("SELECT MAX(sort_order) AS m FROM backlog").get().m;
  const info = db
    .prepare("INSERT OR IGNORE INTO backlog (job_id, sort_order) VALUES (?, ?)")
    .run(jobId, (maxOrder ?? -1) + 1);
  return info.changes > 0;
}

// Take the job off "To start", unless it has current or future week rows. A
// backlog row is a pointer, not data. Returns true if a row was removed.
// Throws on error.
function removeFromBacklog(db, jobId) {
  if (hasCurrentOrFutureRows(db, jobId)) return false;
  return db.prepare("DELETE FROM backlog WHERE job_id = ?").run(jobId).changes > 0;
}

// The one path for hand moves. `from` (when not undefined) must match the
// job's current stage. `override` is the admin's PATCH (contracts section 3).
// Returns {changed, from, to, toStart}; throws HttpError on a rule break and
// rethrows anything else, after rolling its own savepoint back.
function moveStoredStage(db, jobId, { stage, from } = {}, req, { override = false } = {}) {
  if (typeof stage !== "string" || !STAGES.includes(stage)) {
    throw bad(`stage must be one of ${STAGES.join(", ")}`);
  }
  if (stage === "lead") throw bad(RETIRED_STAGE_MSG);
  if (!MANUAL_STAGES.includes(stage)) {
    throw bad(`stage '${stage}' is set automatically and cannot be changed by hand`);
  }
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw notFound();
  const current = job.stage == null ? null : job.stage;
  if (from !== undefined && from !== current) {
    throw conflict("Someone else has moved this job", { stage: current });
  }
  if (stage === current) return { changed: false, from: current, to: stage, toStart: null };

  if (!override) {
    // A job with current or future week rows is on the board, whatever its stage
    // (e.g. a lost job that still has rows): it moves from the board. Complete and
    // invoiced jobs are exempt: their rows are finished work (Finish week leaves the
    // current week's row), and they can only go to archived anyway.
    const finished = current === "complete" || current === "invoiced";
    if (current === "on_board" || (!finished && hasCurrentOrFutureRows(db, jobId))) throw conflict(ON_BOARD_MSG);
    if (!allowedTargets(current).includes(stage)) throw conflict(DONE_MSG);
  } else if (current === "on_board" && hasCurrentOrFutureRows(db, jobId)) {
    throw conflict(ON_BOARD_MSG);
  }

  return db.transaction(() => {
    const before = { stage: current };
    const after = { stage };
    const cols = {};
    const dateCol = STAGE_DATE[stage];
    if (dateCol && (job[dateCol] == null || job[dateCol] === "")) cols[dateCol] = sydneyToday();
    if (stage === "archived" && Number(job.archived) !== 1) cols.archived = 1;
    else if (current === "archived" && stage !== "archived" && Number(job.archived) !== 0) cols.archived = 0;
    for (const [c, v] of Object.entries(cols)) {
      before[c] = job[c];
      after[c] = v;
    }

    const now = nowIso();
    const sets = ["stage = ?", "stage_changed_at = ?", "updated_at = ?"];
    const vals = [stage, now, now];
    for (const [c, v] of Object.entries(cols)) {
      sets.push(`${c} = ?`);
      vals.push(v);
    }
    db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, jobId);

    let toStart = null;
    if (stage === "ready_to_cut") {
      if (addToBacklog(db, jobId)) toStart = "added";
    } else if (current === "ready_to_cut" || stage === "archived" || stage === "lost") {
      // Leaving ready_to_cut, or going to archived or lost from anywhere, takes the
      // job off To start (a no-op when it has no row, or has current or future rows).
      if (removeFromBacklog(db, jobId)) toStart = "removed";
    }
    if (toStart) after.toStart = toStart;

    audit.log(req, { action: "job.stage", entityType: "job", entityId: jobId, before, after });
    return { changed: true, from: current, to: stage, toStart };
  })();
}

// 0.2.1 (docs/plans/m22-project-jobs.md section 2): the stored stage 'design_ordering' shows as
// Projects (sent_to_ordering_at NULL) or Ordering (set). These two names are accepted as move
// targets alongside the stored stages. Both store design_ordering; 'ordering' sets
// sent_to_ordering_at (when NULL), 'projects' clears it. A plain 'design_ordering' move leaves the
// column as it is, and leaving design_ordering never touches it.
const VIRTUAL_STAGES = ["projects", "ordering"];

function pipelineStage(job) {
  if (!job) return null;
  if (job.stage !== "design_ordering") return job.stage;
  return job.sent_to_ordering_at ? "ordering" : "projects";
}

// Sets or clears sent_to_ordering_at (audited as job.ordering). Returns true when it changed.
function setSentToOrdering(db, jobId, sent, req, auditExtra) {
  const job = db.prepare("SELECT sent_to_ordering_at FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw notFound();
  if (!!job.sent_to_ordering_at === !!sent) return false;
  const now = nowIso();
  const v = sent ? now : null;
  db.prepare("UPDATE jobs SET sent_to_ordering_at = ?, updated_at = ? WHERE id = ?").run(v, now, jobId);
  audit.log(req, {
    action: "job.ordering",
    entityType: "job",
    entityId: jobId,
    before: { sentToOrderingAt: job.sent_to_ordering_at },
    after: { sentToOrderingAt: v, ...(auditExtra || {}) },
  });
  return true;
}

function moveStage(db, jobId, { stage, from } = {}, req, opts = {}) {
  return db.transaction(() => {
    // `from` may be the stored stage or the shown one (projects / ordering).
    let f = from;
    if (VIRTUAL_STAGES.includes(f)) {
      const job = db.prepare("SELECT stage, sent_to_ordering_at FROM jobs WHERE id = ?").get(jobId);
      if (!job) throw notFound();
      if (f !== pipelineStage(job)) throw conflict("Someone else has moved this job", { stage: job.stage });
      f = "design_ordering";
    }
    if (!VIRTUAL_STAGES.includes(stage)) return moveStoredStage(db, jobId, { stage, from: f }, req, opts);
    const r = moveStoredStage(db, jobId, { stage: "design_ordering", from: f }, req, opts);
    const flag = setSentToOrdering(db, jobId, stage === "ordering", req);
    return { ...r, to: stage, changed: r.changed || flag };
  })();
}

module.exports = {
  VIRTUAL_STAGES,
  pipelineStage,
  setSentToOrdering,
  setStage,
  onScheduled,
  onSentToBacklog,
  onFinishedComplete,
  onDesignReadyToCut,
  createBoardJob,
  // M3
  STAGES,
  MANUAL_STAGES,
  RETIRED_STAGE_MSG,
  DERIVED_STAGES,
  STAGE_DATE,
  allowedTargets,
  addToBacklog,
  removeFromBacklog,
  moveStage,
};
