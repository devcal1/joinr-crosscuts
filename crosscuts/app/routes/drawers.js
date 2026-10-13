// Drawers (docs/plans/m11-contracts.md section 6.1): a job's drawer grids, the Drawer order page,
// placed drawer orders, the drawer name list and the supplier settings. Every route is declared
// with its access value; the handlers only parse the request and call lib/drawers.js. Literal
// paths are registered before /:id ones.
//
// The finer rules live in lib/drawers.js: checking a grid needs jobs.edit; placing and undoing a
// drawer order also need orders.mark_ordered (they mark job lines ordered).
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError } = require("../lib/httperror");
const drawers = require("../lib/drawers");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[drawers]");
    }
  };
}

// Positive integer path ids only; anything else is a 404.
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

// ?brand= as a single string ('' when absent); lib/drawers.js checks it is a known brand.
function brandParam(req) {
  const b = req.query.brand;
  if (b !== undefined && typeof b !== "string") throw bad("brand must be a single value");
  return b || "";
}

// --- a job's drawer lines --------------------------------------------------------------------

r.get("/job-records/:id/drawers", "jobs.view", handle((req, res) => {
  res.json(drawers.forJob(db, req.user, idOr404(req.params.id)));
}));

r.post("/job-records/:id/drawers", "orders.edit", handle((req, res) => {
  res.status(201).json(drawers.createForJob(db, req, idOr404(req.params.id), body(req)));
}));

r.put("/orders/:id/drawers", "orders.edit", handle((req, res) => {
  res.json(drawers.updateGrid(db, req, idOr404(req.params.id), body(req)));
}));

r.post("/orders/:id/drawers/check", "jobs.edit", handle((req, res) => {
  const b = body(req);
  res.json(drawers.setChecked(db, req, idOr404(req.params.id), b.checked === undefined ? true : b.checked));
}));

r.post("/orders/:id/drawers/refill", "orders.edit", handle((req, res) => {
  res.json(drawers.refill(db, req, idOr404(req.params.id)));
}));

// --- the Drawer order page -------------------------------------------------------------------

r.get("/drawers/placed", "stock.order", handle((req, res) => {
  res.json({ placed: drawers.placedList(db, brandParam(req)) });
}));

r.get("/drawers/placed/:id", "stock.order", handle((req, res) => {
  res.json(drawers.placedGet(db, idOr404(req.params.id)));
}));

r.post("/drawers/placed/:id/undo", "stock.order", handle((req, res) => {
  res.json(drawers.undoPlaced(db, req, idOr404(req.params.id)));
}));

r.post("/drawers/placed/:id/stock-received", "orders.receive", handle((req, res) => {
  res.json(drawers.stockReceived(db, req, idOr404(req.params.id), body(req)));
}));

r.get("/drawers/names", "stock.order", handle((req, res) => {
  res.json({ names: drawers.names(db) });
}));

r.post("/drawers/names", "stock.order", handle((req, res) => {
  res.status(201).json(drawers.addName(db, req, body(req)));
}));

r.patch("/drawers/names/:id", "stock.order", handle((req, res) => {
  res.json(drawers.updateName(db, req, idOr404(req.params.id), body(req)));
}));

r.delete("/drawers/names/:id", "stock.order", handle((req, res) => {
  res.json(drawers.removeName(db, req, idOr404(req.params.id)));
}));

r.get("/drawers/unmapped", "stock.order", handle((req, res) => {
  res.json({ unmapped: drawers.unmapped(db) });
}));

r.get("/drawers/settings", "stock.order", handle((req, res) => {
  res.json(drawers.getSettings(db));
}));

r.put("/drawers/settings", "stock.order", handle((req, res) => {
  res.json(drawers.saveSettings(db, req, body(req)));
}));

r.put("/drawers/stock", "stock.order", handle((req, res) => {
  const b = body(req);
  res.json(drawers.saveStock(db, req, b.brand, b.counts));
}));

r.post("/drawers/place", "stock.order", handle((req, res) => {
  res.status(201).json(drawers.place(db, req, body(req)));
}));

r.get("/drawers", "stock.order", handle((req, res) => {
  res.json(drawers.board(db, brandParam(req)));
}));

module.exports = r.router;
