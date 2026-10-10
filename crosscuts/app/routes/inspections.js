// Client inspections: /api/job-records/:id/inspections and /api/inspections.
// Wave 1 B. See docs/plans/m3-contracts.md section 4. The rules live in
// lib/inspections.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const inspections = require("../lib/inspections");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[inspections]");
    }
  };
}

function idOr404(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  return id;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

r.get("/job-records/:id/inspections", ["jobs.view", "scheduling.view"], handle((req, res) => {
  res.json(inspections.listForJob(db, idOr404(req)));
}));

r.post("/job-records/:id/inspections", "inspections.edit", handle((req, res) => {
  const id = idOr404(req);
  const b = body(req);
  res.status(201).json(
    inspections.create(db, id, { date: b.date, time: b.time, host: b.host, notes: b.notes }, req)
  );
}));

r.patch("/inspections/:id", "inspections.edit", handle((req, res) => {
  res.json(inspections.update(db, idOr404(req), body(req), req));
}));

r.post("/inspections/:id/cancel", "inspections.edit", handle((req, res) => {
  res.json(inspections.cancel(db, idOr404(req), req));
}));

module.exports = r.router;
