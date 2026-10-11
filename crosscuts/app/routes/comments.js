// Comments on tasks and jobs, and follows. Wave 1 A.
// See docs/plans/m4-contracts.md section 4. The access value is the loosest of the two
// entity types; lib/comments.js then checks the entity (tasks.use for a task, jobs.view for
// a job, plus messages.use to write on a job).
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const comments = require("../lib/comments");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api/comments");
const ACCESS = ["tasks.use", "jobs.view"];

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[comments]");
    }
  };
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

r.get("/", ACCESS, handle((req, res) => {
  const q = req.query;
  for (const k of ["entityType", "entityId"]) {
    if (typeof q[k] !== "string") throw bad(`${k} is required`);
  }
  res.json(comments.list(db, req.user, q.entityType, q.entityId));
}));

r.post("/", ACCESS, handle((req, res) => {
  const b = body(req);
  res.status(201).json(comments.add(db, req, b.entityType, b.entityId, b.body));
}));

// Registered before /:id.
function followRoute(on) {
  return handle((req, res) => {
    const b = body(req);
    const type = comments.parseType(b.entityType);
    const id = comments.parseEntityId(b.entityId);
    comments.assertAccess(db, req.user, type, id);
    if (on) comments.follow(db, req.user.id, type, id);
    else comments.unfollow(db, req.user.id, type, id);
    res.status(204).end();
  });
}
r.post("/follow", ACCESS, followRoute(true));
r.post("/unfollow", ACCESS, followRoute(false));

r.delete("/:id", ACCESS, handle((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw notFound();
  comments.remove(db, req, id);
  res.status(204).end();
}));

module.exports = r.router;
