// Projects steps and hand-offs (0.2.2, docs/plans/m23-contracts.md). The step ticks, check measure
// bookings and My projects. Every rule lives in lib/projectsteps.js. Viewing needs jobs.view (My
// projects design.view); ticking and booking need users.admin, or jobs.edit with design.view (the
// rule for setting the owner), so the routes take either key and check the pair inside.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const projectsteps = require("../lib/projectsteps");
const projectjobs = require("../lib/projectjobs");
const { HttpError, bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[projectsteps]");
    }
  };
}

function idOf(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  return id;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

function mustWork(req) {
  if (!projectsteps.canWork(req)) throw new HttpError(403, "Forbidden");
}

r.put("/job-records/:id/steps/:step", ["jobs.edit", "users.admin"], handle((req, res) => {
  mustWork(req);
  const id = idOf(req);
  projectsteps.setStep(db, req, id, req.params.step, body(req).done);
  res.json(projectjobs.summary(db, id));
}));

r.get("/job-records/:id/check-measures", "jobs.view", handle((req, res) => {
  const id = idOf(req);
  if (!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(id)) throw notFound();
  res.json({ checkMeasures: projectsteps.checkMeasuresOf(db, id) });
}));

r.post("/job-records/:id/check-measures", ["jobs.edit", "users.admin"], handle((req, res) => {
  mustWork(req);
  const id = idOf(req);
  const cm = projectsteps.bookCheckMeasure(db, req, id, body(req));
  res.status(201).json({ checkMeasure: cm, ...projectjobs.summary(db, id) });
}));

r.patch("/check-measures/:id", ["jobs.edit", "users.admin"], handle((req, res) => {
  mustWork(req);
  const cmId = idOf(req);
  const cm = projectsteps.updateCheckMeasure(db, req, cmId, body(req));
  res.json({ checkMeasure: cm, ...projectjobs.summary(db, cm.jobId) });
}));

r.get("/my-projects", "design.view", handle((req, res) => {
  const all = req.query.all === "1" || req.query.all === "true";
  res.json(projectsteps.myProjects(db, req, { all }));
}));

module.exports = r.router;
