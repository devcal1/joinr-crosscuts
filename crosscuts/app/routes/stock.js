// The monthly stock order (docs/plans/m11-contracts.md section 7) and the ordering dashboard
// summary (section 11.8). Declared by the scaffold (M11 · 2.2), built in Wave 1 B; the rules live
// in lib/stock.js. Literal paths are registered before /:id and /:period ones.
//
// stock.count types Have and finishes the count; stock.order keeps the list and places the order;
// orders.receive marks a supplier group received.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError, can } = require("../lib/httperror");
const Periods = require("../public/periods");
const stock = require("../lib/stock");

const r = defineRoutes("/api/stock");

const SEE = ["stock.count", "stock.order"];

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[stock]");
    }
  };
}

function idOr404(v) {
  if (typeof v !== "string" || !/^[1-9]\d*$/.test(v)) throw notFound();
  const id = Number(v);
  if (!Number.isSafeInteger(id)) throw notFound();
  return id;
}

// A :period that isn't 'YYYY-MM' is 400 (section 7); later-than-this-month is lib/stock.js's.
function periodOr400(v) {
  if (!Periods.validPeriod(v)) throw bad("The month must be YYYY-MM");
  return v;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

r.get("/summary", SEE, handle((req, res) => {
  res.json(stock.summary(db, req.user));
}));

r.get("/items", SEE, handle((req, res) => {
  // ?all=1 (inactive items too) is the List tab's, stock.order only.
  res.json({ items: stock.items(db, { all: req.query.all === "1" && can(req, "stock.order") }) });
}));

r.post("/items/reorder", "stock.order", handle((req, res) => {
  res.json({ items: stock.reorderItems(db, req, body(req).ids) });
}));

r.post("/items", "stock.order", handle((req, res) => {
  res.status(201).json(stock.createItem(db, req, body(req)));
}));

r.patch("/items/:id", "stock.order", handle((req, res) => {
  res.json(stock.updateItem(db, req, idOr404(req.params.id), body(req)));
}));

r.get("/orders", SEE, handle((req, res) => {
  res.json({ months: stock.months(db) });
}));

r.get("/orders/:period", SEE, handle((req, res) => {
  res.json(stock.month(db, periodOr400(req.params.period)));
}));

r.put("/orders/:period/have", "stock.count", handle((req, res) => {
  res.json(stock.saveHave(db, req, periodOr400(req.params.period), body(req).lines));
}));

r.post("/orders/:period/counted", "stock.count", handle((req, res) => {
  res.json(stock.counted(db, req, periodOr400(req.params.period)));
}));

r.post("/orders/:period/reopen", "stock.order", handle((req, res) => {
  res.json(stock.reopen(db, req, periodOr400(req.params.period)));
}));

r.put("/orders/:period/order", "stock.order", handle((req, res) => {
  res.json(stock.saveOrder(db, req, periodOr400(req.params.period), body(req).lines));
}));

r.post("/orders/:period/groups/received", "orders.receive", handle((req, res) => {
  res.json(stock.groupReceived(db, req, periodOr400(req.params.period), body(req)));
}));

r.post("/orders/:period/groups", "stock.order", handle((req, res) => {
  res.json(stock.group(db, req, periodOr400(req.params.period), body(req)));
}));

module.exports = r.router;
