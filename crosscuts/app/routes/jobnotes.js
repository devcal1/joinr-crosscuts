// Notes on a job (docs/plans/jobs-tradify-contracts.md section 4.1). The rules live in lib/jobnotes.js.
const fs = require("fs");
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const jobnotes = require("../lib/jobnotes");
const files = require("../lib/files");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api/job-records");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[job-notes]");
    }
  };
}

function idParam(v) {
  const id = Number(v);
  if (!Number.isInteger(id) || id < 1) throw notFound();
  return id;
}

r.get("/:id/notes", "jobs.view", handle((req, res) => {
  res.json({ notes: jobnotes.list(db, req, idParam(req.params.id)) });
}));

r.post("/:id/notes", "jobs.view", handle((req, res) => {
  res.status(201).json(jobnotes.add(db, req, idParam(req.params.id), req.body));
}));

r.patch("/:id/notes/:noteId", "jobs.view", handle((req, res) => {
  res.json(jobnotes.edit(db, req, idParam(req.params.id), idParam(req.params.noteId), req.body));
}));

r.delete("/:id/notes/:noteId", ["jobs.view", "users.admin"], handle((req, res) => {
  res.json(jobnotes.remove(db, req, idParam(req.params.id), idParam(req.params.noteId)));
}));

// Shaped as routes/tasks.js: files.single stored the upload as <uuid>.part; every way out either
// renames it (files.accept) or removes it before replying.
r.post("/:id/notes/:noteId/files", "jobs.view", files.single("file"), async (req, res) => {
  let accepted = null;
  try {
    const id = idParam(req.params.id);
    const noteId = idParam(req.params.noteId);
    if (!req.file) throw bad("Choose a file");
    jobnotes.assertCanAttach(db, req, id, noteId);
    accepted = await files.accept(req.file);
    const note = jobnotes.attachFile(db, req, id, noteId, accepted);
    accepted = null;
    res.status(201).json(note);
  } catch (e) {
    if (accepted) files.discard(accepted);
    else if (req.file && req.file.path) await fs.promises.rm(req.file.path, { force: true }).catch(() => {});
    sendError(res, e, "[job-notes]");
  }
});

r.delete("/:id/notes/:noteId/files/:fileId", ["jobs.view", "users.admin"], handle((req, res) => {
  res.json(
    jobnotes.removeFile(db, req, idParam(req.params.id), idParam(req.params.noteId), idParam(req.params.fileId))
  );
}));

module.exports = r.router;
