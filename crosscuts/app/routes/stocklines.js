// Monthly stock order lines: /api/stock-lines (0.2.27, docs/plans/stock-orders-contracts.md). Seeing
// them needs orders.view; the rules, and the per-field keys of a PATCH, are in lib/stocklines.js.
// Ordering a line is not here: only a supplier order does it (POST /api/orders/mark-ordered).
// Literal paths are registered before /:id.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError } = require("../lib/httperror");
const stocklines = require("../lib/stocklines");

const r = defineRoutes("/api/stock-lines");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[stocklines]");
    }
  };
}

function idOr404(v) {
  if (typeof v !== "string" || !/^[1-9]\d*$/.test(v)) throw notFound();
  const id = Number(v);
  if (!Number.isSafeInteger(id)) throw notFound();
  return id;
}

function single(q, k) {
  if (q[k] !== undefined && typeof q[k] !== "string") throw bad(`${k} must be a single value`);
  return q[k];
}

r.get("/months", "orders.view", handle((req, res) => {
  res.json(stocklines.months(db));
}));

r.get("/items", "orders.view", handle((req, res) => {
  res.json(stocklines.items(db));
}));

r.get("/", "orders.view", handle((req, res) => {
  res.json(stocklines.list(db, { month: single(req.query, "month"), status: single(req.query, "status") }));
}));

r.post("/", "orders.view", handle((req, res) => {
  res.status(201).json(stocklines.create(db, req, req.body));
}));

r.patch("/:id", ["orders.view", "orders.mark_ordered", "orders.receive"], handle((req, res) => {
  res.json(stocklines.update(db, req, idOr404(req.params.id), req.body));
}));

r.delete("/:id", "orders.view", handle((req, res) => {
  res.json(stocklines.remove(db, req, idOr404(req.params.id)));
}));

module.exports = r.router;
