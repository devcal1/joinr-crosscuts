// Production stages captured at Finish week (brief §5.3.3, D15; m5-contracts.md section 2).
// Not the job's lifecycle stage (jobs.stage, lib/jobstage.js): this is how far the work got,
// kept per job per finished week. The job's current production stage is its latest row.
const audit = require("./audit");
const { HttpError } = require("./httperror");

const STAGES = ["cut_edge", "kit", "assemble", "inspect", "paint", "install", "return_visit"];
const LABELS = {
  cut_edge: "Cut & edge",
  kit: "Kit",
  assemble: "Assemble",
  inspect: "Inspect",
  paint: "Paint",
  install: "Install",
  return_visit: "Return visit",
};
const SHORT = {
  cut_edge: "CUT",
  kit: "KIT",
  assemble: "ASM",
  inspect: "INSP",
  paint: "PAINT",
  install: "INST",
  return_visit: "RV",
};

// Paint only for two-pac jobs; a return visit only for two-pac jobs with a stone benchtop
// (the painted doors go on after the stone). Unknown spec: every stage.
function stagesFor(job) {
  const twoPac = job ? job.is_two_pac : null;
  if (twoPac === null || twoPac === undefined) return STAGES.slice();
  if (Number(twoPac) === 1) {
    return STAGES.filter((s) => s !== "return_visit" || (job && job.benchtop === "stone"));
  }
  return STAGES.filter((s) => s !== "paint" && s !== "return_visit");
}

// Map jobId -> latest stage key. One query.
function currentStages(db, jobIds) {
  const out = new Map();
  const ids = [...new Set((jobIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT p.job_id, p.stage FROM production_stages p
        WHERE p.job_id IN (${ids.map(() => "?").join(",")})
          AND p.week_start = (SELECT MAX(q.week_start) FROM production_stages q WHERE q.job_id = p.job_id)`
    )
    .all(...ids);
  for (const r of rows) out.set(Number(r.job_id), r.stage);
  return out;
}

// Upserts the stage for (jobId, weekStart). Synchronous; use inside the caller's transaction.
function record(db, req, jobId, weekStart, stage) {
  const job = db.prepare("SELECT id, is_two_pac, benchtop FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw new HttpError(400, `job ${jobId} does not exist`);
  if (!STAGES.includes(stage)) throw new HttpError(400, "stage must be one of " + STAGES.join(", "));
  if (!stagesFor(job).includes(stage)) throw new HttpError(400, "That stage doesn't apply to this job");
  const prev = db
    .prepare("SELECT stage FROM production_stages WHERE job_id = ? AND week_start = ?")
    .get(jobId, weekStart);
  if (prev && prev.stage === stage) return;
  db.prepare(
    `INSERT INTO production_stages (job_id, week_start, stage, recorded_by, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(job_id, week_start) DO UPDATE SET
       stage = excluded.stage, recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at`
  ).run(jobId, weekStart, stage, req && req.user ? req.user.id : null, new Date().toISOString());
  audit.log(req, {
    action: "job.production_stage",
    entityType: "job",
    entityId: jobId,
    before: prev ? { stage: prev.stage, weekStart } : null,
    after: { stage, weekStart },
  });
}

module.exports = { STAGES, LABELS, SHORT, stagesFor, currentStages, record };
