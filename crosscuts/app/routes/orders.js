// Supplier order lines: /api/job-records/:id/orders and /api/orders. Wave 1 B.
// See docs/plans/m3-contracts.md section 4. The rules (who may mark a line
// ordered, the all-ordered and materials-in rules) live in lib/orders.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const orders = require("../lib/orders");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[orders]");
    }
  };
}

function parseId(v) {
  const id = Number(v);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// The id in the path, or a 404.
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

r.get("/job-records/:id/orders", "jobs.view", handle((req, res) => {
  const id = idOr404(req);
  const all = req.query.all;
  if (all !== undefined && all !== "" && all !== "0" && all !== "1") throw bad("all must be 0 or 1");
  res.json(orders.listForJob(db, id, { includeCancelled: all === "1" }));
}));

r.post("/job-records/:id/orders", "orders.edit", handle((req, res) => {
  const id = idOr404(req);
  const b = body(req);
  res.status(201).json(
    orders.createLine(
      db,
      id,
      { supplier: b.supplier, description: b.description, expectedDate: b.expectedDate, notes: b.notes },
      req
    )
  );
}));

// Registered before the /orders/:id routes.
r.get("/orders/suppliers", "jobs.view", handle((req, res) => {
  res.json(orders.suppliers(db, typeof req.query.q === "string" ? req.query.q : ""));
}));

r.get("/orders", "jobs.view", handle((req, res) => {
  const q = req.query;
  for (const k of ["status", "supplier", "jobId"]) {
    if (q[k] !== undefined && typeof q[k] !== "string") throw bad(`${k} must be a single value`);
  }
  res.json(orders.list(db, { status: q.status, supplier: q.supplier, jobId: q.jobId }));
}));

r.patch("/orders/:id", ["orders.edit", "orders.mark_ordered"], handle((req, res) => {
  const id = idOr404(req);
  res.json(orders.updateLine(db, id, body(req), req));
}));

r.post("/orders/:id/cancel", "orders.edit", handle((req, res) => {
  const id = idOr404(req);
  res.json(orders.cancelLine(db, id, req));
}));

module.exports = r.router;
