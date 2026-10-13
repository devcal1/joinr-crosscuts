// Paint orders (docs/plans/m11-contracts.md section 6.3), Wave 1 C. The routes declare the coarse
// access and pass the body to lib/paint.js, where every other rule lives. Literal paths are
// registered before /:id ones.
//
// stock.order runs paint orders; marking one with job lines ordered (or undoing it) also needs
// orders.mark_ordered, checked in lib/paint.js; orders.receive receives it, and may read one order.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError } = require("../lib/httperror");
const paint = require("../lib/paint");

const r = defineRoutes("/api/paint");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[paint]");
    }
  };
}

function idOr404(v) {
  if (typeof v !== "string" || !/^[1-9]\d*$/.test(v)) throw notFound();
  const id = Number(v);
  if (!Number.isSafeInteger(id)) throw notFound();
  return id;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

r.get("/items", "stock.order", handle((req, res) => {
  res.json({ items: paint.items(db, { all: req.query.all === "1" }) });
}));

r.post("/items/reorder", "stock.order", handle((req, res) => {
  res.json({ items: paint.reorderItems(db, req, body(req).ids) });
}));

r.post("/items", "stock.order", handle((req, res) => {
  res.status(201).json(paint.createItem(db, req, body(req)));
}));

r.patch("/items/:id", "stock.order", handle((req, res) => {
  res.json(paint.updateItem(db, req, idOr404(req.params.id), body(req)));
}));

r.get("/settings", "stock.order", handle((req, res) => {
  res.json(paint.getSettings(db));
}));

r.put("/settings", "stock.order", handle((req, res) => {
  res.json(paint.saveSettings(db, req, body(req)));
}));

r.get("/orders", "stock.order", handle((req, res) => {
  const s = req.query.status;
  if (s !== undefined && typeof s !== "string") throw bad("status must be a single value");
  res.json({ orders: paint.list(db, { status: s }) });
}));

r.post("/orders", "stock.order", handle((req, res) => {
  res.status(201).json(paint.create(db, req, body(req)));
}));

r.get("/orders/:id", ["stock.order", "orders.receive"], handle((req, res) => {
  res.json(paint.get(db, idOr404(req.params.id)));
}));

r.put("/orders/:id", "stock.order", handle((req, res) => {
  res.json(paint.update(db, req, idOr404(req.params.id), body(req)));
}));

r.post("/orders/:id/ordered", "stock.order", handle((req, res) => {
  res.json(paint.ordered(db, req, idOr404(req.params.id), body(req)));
}));

r.post("/orders/:id/undo-ordered", "stock.order", handle((req, res) => {
  res.json(paint.undoOrdered(db, req, idOr404(req.params.id)));
}));

r.post("/orders/:id/received", "orders.receive", handle((req, res) => {
  res.json(paint.received(db, req, idOr404(req.params.id), body(req)));
}));

r.post("/orders/:id/cancel", "stock.order", handle((req, res) => {
  res.json(paint.cancel(db, req, idOr404(req.params.id)));
}));

module.exports = r.router;
