// The report library. Wave 1 C.
// See docs/plans/m4-contracts.md section 4. Logic and rules live in lib/reports.js;
// the file itself is served only by GET /api/files/:id (routes/files.js).
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const files = require("../lib/files");
const reports = require("../lib/reports");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api/reports");

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      sendError(res, e, "[reports]");
    }
  };
}

function idOr404(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw notFound();
  return id;
}

function jsonBody(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

r.get("/", "accounts.view", handle((req, res) => {
  for (const k of ["year", "category"]) {
    if (req.query[k] !== undefined && typeof req.query[k] !== "string") throw bad(`${k} must be a single value`);
  }
  res.json(reports.list(db, req.user, { year: req.query.year, category: req.query.category }));
}));

r.post("/", "reports.upload", files.single("file"), handle(async (req, res) => {
  const accepted = await files.accept(req.file); // 400 and the temp file removed when refused
  let report;
  try {
    report = reports.create(db, req, req.body || {}, accepted);
  } catch (e) {
    files.discard(accepted);
    throw e;
  }
  res.status(201).json(report);
}));

r.patch("/:id", "reports.upload", handle((req, res) => {
  const id = idOr404(req);
  res.json(reports.update(db, req, id, jsonBody(req)));
}));

r.delete("/:id", "reports.upload", handle((req, res) => {
  const id = idOr404(req);
  reports.remove(db, req, id);
  res.status(204).end();
}));

module.exports = r.router;
