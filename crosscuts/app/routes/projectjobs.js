// Project jobs (0.2.1, docs/plans/m22-project-jobs.md). The owner picker, the project page, its job
// notes, the finalised order lists and Send to Ordering. Every rule lives in lib/projectjobs.js.
// Viewing needs jobs.view; setting the owner jobs.edit with design.view (or users.admin); notes and
// finalise jobs.edit; sending orders.edit (the key that creates order lines).
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const projectjobs = require("../lib/projectjobs");
const { HttpError, bad, notFound, sendError, can } = require("../lib/httperror");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[projectjobs]");
    }
  };
}

function jobIdOf(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  return id;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// Setting an owner: users.admin, or jobs.edit together with design.view (Projects).
function canSetOwner(req) {
  return can(req, "users.admin") || (can(req, "jobs.edit") && can(req, "design.view"));
}

r.get("/project-owners", "jobs.view", handle((req, res) => {
  res.json({ owners: projectjobs.owners(db) });
}));

r.put("/job-records/:id/owner", ["jobs.edit", "users.admin"], handle((req, res) => {
  if (!canSetOwner(req)) throw new HttpError(403, "Forbidden");
  const id = jobIdOf(req);
  const b = body(req);
  if (!Object.prototype.hasOwnProperty.call(b, "ownerId")) throw bad("ownerId is required (a user id or null)");
  projectjobs.setOwner(db, req, id, b.ownerId);
  res.json(projectjobs.summary(db, id));
}));

r.get("/job-records/:id/project", "jobs.view", handle((req, res) => {
  const out = projectjobs.summary(db, jobIdOf(req));
  out.can = {
    edit: can(req, "jobs.edit"),
    setOwner: canSetOwner(req),
    send: can(req, "orders.edit"),
    // 0.2.2 (m23-contracts section 2): tick steps and book check measures.
    steps: require("../lib/projectsteps").canWork(req),
  };
  res.json(out);
}));

r.put("/job-records/:id/project/notes", "jobs.edit", handle((req, res) => {
  const id = jobIdOf(req);
  projectjobs.setNotes(db, req, id, body(req).notes);
  res.json(projectjobs.summary(db, id));
}));

r.post("/job-records/:id/project/finalise", "jobs.edit", handle((req, res) => {
  res.status(201).json(projectjobs.finalise(db, req, jobIdOf(req)));
}));

r.get("/job-records/:id/project/order-lists/:rev", "jobs.view", handle((req, res) => {
  res.json(projectjobs.orderList(db, jobIdOf(req), req.params.rev));
}));

r.post("/job-records/:id/project/send", "orders.edit", handle((req, res) => {
  res.json(projectjobs.send(db, req, jobIdOf(req)));
}));

module.exports = r.router;
module.exports.canSetOwner = canSetOwner;
