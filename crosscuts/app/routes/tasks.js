// Tasks: the shared queue and tasks on jobs. Wave 1 A.
// See docs/plans/m4-contracts.md section 4. The rules live in lib/tasks.js.
const fs = require("fs");
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const tasks = require("../lib/tasks");
const files = require("../lib/files");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api/tasks");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[tasks]");
    }
  };
}

function parseId(v) {
  const id = Number(v);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function idOr404(req) {
  const id = parseId(req.params.id);
  if (!id) throw notFound();
  return id;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

r.get("/", "tasks.use", handle((req, res) => {
  const q = req.query;
  for (const k of ["view", "jobId", "limit"]) {
    if (q[k] !== undefined && typeof q[k] !== "string") throw bad(`${k} must be a single value`);
  }
  res.json({ rows: tasks.list(db, req.user, { view: q.view, jobId: q.jobId, limit: q.limit }) });
}));

// Registered before the /:id routes.
r.post("/reminder/run", "users.admin", handle((req, res) => {
  res.json(tasks.runReminder(db, { force: true }));
}));

r.get("/:id", "tasks.use", handle((req, res) => {
  res.json(tasks.get(db, req.user, idOr404(req)));
}));

r.post("/", "tasks.use", handle((req, res) => {
  res.status(201).json(tasks.create(db, req, body(req)));
}));

r.patch("/:id", "tasks.use", handle((req, res) => {
  res.json(tasks.update(db, req, idOr404(req), body(req)));
}));

for (const action of ["done", "reopen", "cancel"]) {
  r.post(`/:id/${action}`, "tasks.use", handle((req, res) => {
    res.json(tasks.setStatus(db, req, idOr404(req), action));
  }));
}

// files.single has stored the upload as <uuid>.part; every way out of the handler either
// renames it (files.accept) or removes it.
r.post("/:id/files", "tasks.use", files.single("file"), async (req, res) => {
  let accepted = null;
  try {
    const id = idOr404(req);
    if (!req.file) throw bad("Choose a file");
    tasks.assertCanAttach(db, req.user, id);
    accepted = await files.accept(req.file);
    const task = tasks.attach(db, req, id, accepted);
    accepted = null;
    res.status(201).json(task);
  } catch (e) {
    if (accepted) files.discard(accepted);
    else if (req.file && req.file.path) fs.promises.rm(req.file.path, { force: true }).catch(() => {});
    sendError(res, e, "[tasks]");
  }
});

r.delete("/:id/files/:fileId", "tasks.use", handle((req, res) => {
  const id = idOr404(req);
  const fileId = parseId(req.params.fileId);
  if (!fileId) throw notFound();
  res.json(tasks.detach(db, req, id, fileId));
}));

module.exports = r.router;
