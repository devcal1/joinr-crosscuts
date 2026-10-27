// Workshop end-of-shift report and job issues (0.2.4, docs/plans/m25-contracts.md). The shift page
// is shift.report; reading a job's issues is any of jobs.view, design.view or shift.report; resolving
// is checked in lib/issues.js (project owner, board.edit or admin). Every rule lives in lib/shift.js
// and lib/issues.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const shift = require("../lib/shift");
const issues = require("../lib/issues");
const photostore = require("../lib/photostore");
const { normaliseTags } = require("../lib/tags");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[shift]");
    }
  };
}

function idParam(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
}

// ?add=1,2: jobs added by search, shown after the board's.
r.get("/shift/today", "shift.report", handle((req, res) => {
  const add = String(req.query.add || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  res.json(shift.today(db, req, add));
}));

r.get("/shift/jobs", "shift.report", handle((req, res) => {
  res.json({ jobs: shift.search(db, req.query.q) });
}));

r.post("/shift/report", "shift.report", handle((req, res) => {
  res.json(shift.send(db, req, req.body));
}));

// Photos for one job, several at once (field "photos"), tagged install or shift.
r.post("/shift/jobs/:id/photos", "shift.report", (req, res) => {
  photostore.upload.array("photos", 30)(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    const files = req.files || [];
    try {
      const jobId = idParam(req.params.id);
      shift.liveJob(db, jobId);
      if (!files.length) throw bad("No photos uploaded");
      const tags = normaliseTags(shift.photoTag(db, req, jobId));
      const stored = await photostore.store(db, req, files, { tags, jobId });
      const created = stored.created.map((id) => {
        const p = db.prepare("SELECT id, filename, thumb_filename, tags FROM photos WHERE id = ?").get(id);
        return { id: p.id, url: `/photos/${p.filename}`, thumbUrl: `/photos/${p.thumb_filename}`, tags: p.tags };
      });
      res.status(created.length ? 201 : 500).json({ created, failed: stored.failed });
    } catch (e) {
      photostore.discard(files);
      sendError(res, e, "[shift]");
    }
  });
});

r.get("/job-records/:id/issues", ["jobs.view", "design.view", "shift.report"], handle((req, res) => {
  const id = idParam(req.params.id);
  res.json({ issues: issues.listFor(db, req, id), canResolve: issues.canResolve(db, req, id) });
}));

r.post("/job-records/:id/issues", "shift.report", handle((req, res) => {
  res.status(201).json(issues.raise(db, req, idParam(req.params.id), req.body));
}));

r.post("/issues/:id/resolve", ["board.edit", "design.view", "users.admin"], handle((req, res) => {
  res.json(issues.resolve(db, req, idParam(req.params.id), req.body));
}));

// Runs the end-of-shift reminder now, whatever the time (for the smoke test and admins).
r.post("/shift/reminder/run", "users.admin", handle((req, res) => {
  res.json(shift.runReminder(db, { force: true }));
}));

module.exports = r.router;
