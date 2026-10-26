// Board placement and money triggers (0.2.3, docs/plans/m24-contracts.md section 5): the "Needs
// install date" list on the Scheduling notes wall and its Confirm install date. board.edit (the
// schedule manager). Every rule lives in lib/handoffs.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const handoffs = require("../lib/handoffs");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[handoffs]");
    }
  };
}

r.get("/install-dates/needed", "board.edit", handle((req, res) => {
  res.json({ jobs: handoffs.needsInstall(db) });
}));

r.post("/job-records/:id/confirm-install", "board.edit", handle((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  const changed = handoffs.confirmInstall(db, req, id, b.date);
  const job = db.prepare("SELECT id, name, promised_install_date FROM jobs WHERE id = ?").get(id);
  res.json({ changed, job: { id: job.id, name: job.name, promisedInstallDate: job.promised_install_date } });
}));

module.exports = r.router;
