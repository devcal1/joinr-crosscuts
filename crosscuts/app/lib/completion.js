// Installed, then confirmed (0.2.5, docs/plans/m26-contracts.md section 3). Finish week's
// "Installed" outcome records jobs.installed_date and asks the project manager to confirm; it no
// longer completes the job. Confirm complete (the project owner, or an admin) runs the existing
// completion path (jobstage.onFinishedComplete: stage complete, completed_date, final 40% due).
// An admin's hand-set Complete (PATCH stage) still completes at once.
//
// Every function takes db first; nothing here requires ../db.
const audit = require("./audit");
const notify = require("./notify");
const jobstage = require("./jobstage");
const { can, notFound, forbidden, conflict } = require("./httperror");
const { sydneyToday } = require("./time");

const DONE = ["complete", "invoiced", "lost", "archived"];
const userId = (req) => (req && req.user && req.user.id != null ? req.user.id : null);

// Installed and waiting for the project manager to confirm complete.
function awaitingConfirm(job) {
  return !!job && !!job.installed_date && !DONE.includes(job.stage);
}

// Finish week -> Installed. Inside the caller's transaction. Returns true when it recorded the
// date (false when already installed or already finished).
function markInstalled(db, req, jobId, date = sydneyToday()) {
  const job = db.prepare("SELECT id, name, stage, installed_date, project_owner_id FROM jobs WHERE id = ?").get(jobId);
  if (!job || DONE.includes(job.stage) || job.installed_date) return false;
  db.prepare("UPDATE jobs SET installed_date = ?, updated_at = ? WHERE id = ?").run(date, new Date().toISOString(), jobId);
  audit.log(req, { action: "job.installed", entityType: "job", entityId: jobId, before: { installed_date: null }, after: { installed_date: date } });
  const ids = job.project_owner_id != null ? [job.project_owner_id] : notify.usersWithKey(db, "design.view");
  notify.toUsers(
    db,
    ids,
    {
      kind: "job.installed",
      title: `${job.name} installed: confirm complete`,
      link: `/project.html?id=${jobId}#confirmComplete`,
      entityType: "job",
      entityId: jobId,
    },
    { exceptUserId: userId(req) }
  );
  return true;
}

function canConfirm(req, job) {
  if (can(req, "users.admin")) return true;
  return job.project_owner_id != null && Number(job.project_owner_id) === Number(userId(req));
}

// What the job and project pages need for the Confirm complete line.
function stateOf(db, req, jobId) {
  const job = db.prepare("SELECT id, stage, installed_date, completed_date, project_owner_id FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw notFound();
  const openIssues = db.prepare("SELECT COUNT(*) AS n FROM job_issues WHERE job_id = ? AND status = 'open'").get(jobId).n;
  return {
    installedDate: job.installed_date || null,
    completedDate: job.completed_date || null,
    awaitingConfirm: awaitingConfirm(job),
    canConfirm: awaitingConfirm(job) && canConfirm(req, job),
    openIssues,
  };
}

// Confirm complete. Open issues don't block it (the page warns). Returns the new state.
function confirmComplete(db, req, jobId) {
  return db.transaction(() => {
    const job = db.prepare("SELECT id, stage, installed_date, project_owner_id FROM jobs WHERE id = ?").get(jobId);
    if (!job) throw notFound();
    if (!awaitingConfirm(job)) throw conflict("This job isn't waiting to be confirmed complete");
    if (!canConfirm(req, job)) throw forbidden();
    jobstage.onFinishedComplete(db, jobId, req, undefined, { via: "confirm_complete" });
    return stateOf(db, req, jobId);
  })();
}

module.exports = { awaitingConfirm, markInstalled, stateOf, confirmComplete, DONE };
