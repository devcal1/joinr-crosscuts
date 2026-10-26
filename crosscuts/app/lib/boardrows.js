// Adding a week row to the board (M24, docs/plans/m24-contracts.md section 2). The one path for a
// new row: the board's own add (POST /api/rows) and the automatic placement at Send to Ordering
// both come here, so the stage and invoice hooks (jobstage.onScheduled) always run. Data only: the
// board layout is untouched. Call inside the caller's transaction.
const jobstage = require("./jobstage");

// weekStart must already be a Monday. Returns the new row id.
function addRow(db, req, jobId, weekStart, panel) {
  const maxOrder = db
    .prepare("SELECT MAX(sort_order) AS m FROM week_rows WHERE week_start = ? AND panel = ?")
    .get(weekStart, panel).m;
  const info = db
    .prepare("INSERT INTO week_rows (job_id, week_start, panel, sort_order) VALUES (?, ?, ?, ?)")
    .run(jobId, weekStart, panel, (maxOrder ?? -1) + 1);
  jobstage.onScheduled(db, jobId, req, weekStart);
  return info.lastInsertRowid;
}

module.exports = { addRow };
