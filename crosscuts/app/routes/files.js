// Downloads of private files (report library, task attachments, supplier statements). The only way a file
// in <UPLOADS_DIR>/files leaves the server. See docs/plans/m4-contracts.md sections 4 and 8.
// No permission looks exactly like no file (404), so a file's existence isn't confirmed.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const files = require("../lib/files");
const { can } = require("../lib/httperror");

const r = defineRoutes("/api/files");

function notFound(res) {
  res.status(404).json({ error: "Not found" });
}

r.get("/:id", "login", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return notFound(res);
  const row = db.prepare("SELECT * FROM files WHERE id = ? AND removed_at IS NULL").get(id);
  if (!row) return notFound(res);
  const report = db.prepare("SELECT id FROM reports WHERE file_id = ? AND removed_at IS NULL").get(id);
  const task = db.prepare("SELECT task_id FROM task_files WHERE file_id = ?").get(id);
  // A supplier statement (m9-contracts.md section 7.4).
  const statement = db.prepare("SELECT supplier_id FROM supplier_statements WHERE file_id = ?").get(id);
  // 0.2.7: an individual invoice's file (m28-contracts.md section 2).
  const payable = db.prepare("SELECT id FROM payables WHERE file_id = ?").get(id);
  const allowed =
    (report && can(req, "accounts.view")) || (task && can(req, "tasks.use")) || (statement && can(req, "accounts.view")) ||
    (payable && can(req, "accounts.view"));
  if (!allowed) return notFound(res);
  files.send(res, row);
});

module.exports = r.router;
