// A job's Materials list: /api/job-records/:id/materials (docs/plans/materials-contracts.md).
// The rules (what a sync may touch, what editing a Joinr line does, how lines become order lines)
// live in lib/materials.js. Viewing needs jobs.view, writing jobs.edit, and turning lines into
// order lines orders.edit (the key that creates order lines).
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const materials = require("../lib/materials");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[materials]");
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

r.get("/job-records/:id/materials", "jobs.view", handle((req, res) => {
  res.json(materials.list(db, jobIdOf(req)));
}));

r.post("/job-records/:id/materials", "jobs.edit", handle((req, res) => {
  res.status(201).json(materials.create(db, req, jobIdOf(req), body(req)));
}));

r.post("/job-records/:id/materials/fill-from-joinr", "jobs.edit", handle((req, res) => {
  res.json(materials.syncFromJoinr(db, req, jobIdOf(req), { action: "material.fill" }));
}));

r.post("/job-records/:id/materials/update-from-joinr", "jobs.edit", handle((req, res) => {
  res.json(materials.syncFromJoinr(db, req, jobIdOf(req), { action: "material.joinr_update" }));
}));

r.post("/job-records/:id/materials/to-orders", "orders.edit", handle((req, res) => {
  res.json(materials.toOrders(db, req, jobIdOf(req), body(req)));
}));

r.patch("/job-records/:id/materials/:lineId", "jobs.edit", handle((req, res) => {
  res.json(materials.update(db, req, jobIdOf(req), req.params.lineId, body(req)));
}));

r.delete("/job-records/:id/materials/:lineId", "jobs.edit", handle((req, res) => {
  res.json(materials.remove(db, req, jobIdOf(req), req.params.lineId));
}));

module.exports = r.router;
