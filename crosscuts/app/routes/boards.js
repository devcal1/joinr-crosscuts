// The board stocktake (docs/plans/m11-contracts.md section 8). Declared by the scaffold (M11 · 2.2), built in Wave 1 B; the rules live in
// lib/boards.js. Literal paths are registered before /:id and /:period ones.
//
// Prices and values go only to stock.order holders (withPrices); stock.count holders count without
// them; reopening a valued month needs users.admin.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError, can } = require("../lib/httperror");
const Periods = require("../public/periods");
const boards = require("../lib/boards");

const r = defineRoutes("/api");

const SEE = ["stock.count", "stock.order"];

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[boards]");
    }
  };
}

function idOr404(v) {
  if (typeof v !== "string" || !/^[1-9]\d*$/.test(v)) throw notFound();
  const id = Number(v);
  if (!Number.isSafeInteger(id)) throw notFound();
  return id;
}

function periodOr400(v) {
  if (!Periods.validPeriod(v)) throw bad("The month must be YYYY-MM");
  return v;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

const withPrices = (req) => can(req, "stock.order");

r.get("/boards", SEE, handle((req, res) => {
  // ?all=1 (inactive boards too) is the List tab's, stock.order only, as for stock items.
  res.json({ boards: boards.list(db, { all: req.query.all === "1" && can(req, "stock.order"), withPrices: withPrices(req) }) });
}));

r.post("/boards/reorder", "stock.order", handle((req, res) => {
  res.json({ boards: boards.reorder(db, req, body(req).ids) });
}));

r.post("/boards", "stock.order", handle((req, res) => {
  res.status(201).json(boards.create(db, req, body(req)));
}));

r.get("/boards/counts", SEE, handle((req, res) => {
  res.json({ months: boards.counts(db, { withValues: withPrices(req) }) });
}));

r.get("/boards/counts/:period", SEE, handle((req, res) => {
  res.json(boards.count(db, periodOr400(req.params.period), { withPrices: withPrices(req) }));
}));

// The counter's writes answer the month without prices; a stock.order holder gets them back.
r.put("/boards/counts/:period/lines", "stock.count", handle((req, res) => {
  const period = periodOr400(req.params.period);
  const view = boards.saveLines(db, req, period, body(req).lines);
  res.json(withPrices(req) ? boards.count(db, period, { withPrices: true }) : view);
}));

r.post("/boards/counts/:period/counted", "stock.count", handle((req, res) => {
  const period = periodOr400(req.params.period);
  const view = boards.counted(db, req, period);
  res.json(withPrices(req) ? boards.count(db, period, { withPrices: true }) : view);
}));

r.post("/boards/counts/:period/reopen-count", "stock.order", handle((req, res) => {
  res.json(boards.reopenCount(db, req, periodOr400(req.params.period)));
}));

// Saves the adjustment and its note as they're typed, on a counted month (contracts section 15.13).
r.put("/boards/counts/:period/adjustment", "stock.order", handle((req, res) => {
  res.json(boards.saveAdjustment(db, req, periodOr400(req.params.period), body(req)));
}));

r.post("/boards/counts/:period/value", "stock.order", handle((req, res) => {
  res.json(boards.value(db, req, periodOr400(req.params.period), body(req)));
}));

r.post("/boards/counts/:period/reopen", "users.admin", handle((req, res) => {
  res.json(boards.reopen(db, req, periodOr400(req.params.period)));
}));

r.patch("/boards/:id", "stock.order", handle((req, res) => {
  res.json(boards.update(db, req, idOr404(req.params.id), body(req)));
}));

module.exports = r.router;
