// Morning check and completion (0.2.5, docs/plans/m26-contracts.md): the Morning check on the
// Scheduling notes wall (board.edit), Confirm complete on the job and project pages (the project
// owner or an admin; checked in lib/completion.js), and the dashboard's Waiting on you (any login).
// Every rule lives in lib/morning.js, lib/completion.js and lib/mywork.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const morning = require("../lib/morning");
const completion = require("../lib/completion");
const mywork = require("../lib/mywork");
const { notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[morning]");
    }
  };
}

function idParam(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
}

r.get("/morning-check", "board.edit", handle((req, res) => {
  res.json(morning.check(db, req.query.date === undefined ? undefined : String(req.query.date)));
}));

r.put("/morning-check/jobs/:id", "board.edit", handle((req, res) => {
  res.json(morning.setDay(db, req, idParam(req.params.id), req.body));
}));

r.post("/morning-check/done", "board.edit", handle((req, res) => {
  res.json({ done: morning.markDone(db, req, req.body) });
}));

r.get("/job-records/:id/completion", ["jobs.view", "design.view"], handle((req, res) => {
  res.json(completion.stateOf(db, req, idParam(req.params.id)));
}));

r.post("/job-records/:id/confirm-complete", ["design.view", "users.admin"], handle((req, res) => {
  res.json(completion.confirmComplete(db, req, idParam(req.params.id)));
}));

r.get("/my-work", "login", handle((req, res) => {
  res.json(mywork.linesFor(db, req));
}));

module.exports = r.router;
