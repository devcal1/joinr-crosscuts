// The vehicles register (0.2.7, docs/plans/m28-contracts.md section 1). Accounts keeps rego and
// insurance (invoices.edit; accounts.view sees); the workshop manager books and confirms bookings
// (maintenance.manage). The rules live in lib/vehicles.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const vehicles = require("../lib/vehicles");
const { bad, notFound, sendError, can } = require("../lib/httperror");

const r = defineRoutes("/api");
const VIEW = ["accounts.view", "maintenance.manage"];
const EDIT = "invoices.edit";
const BOOK = "maintenance.manage";

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[vehicles]");
    }
  };
}
function idOr404(v) {
  if (typeof v !== "string" || !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) throw notFound();
  return Number(v);
}
function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// 200 {today, vehicles, bookings, canEdit, canBook}. ?all=1 lists inactive vehicles too.
r.get("/vehicles", VIEW, handle((req, res) => {
  res.json({ ...vehicles.list(db, { all: req.query.all === "1" }), canEdit: can(req, EDIT), canBook: can(req, BOOK) });
}));

r.post("/vehicles", EDIT, handle((req, res) => {
  res.status(201).json(vehicles.create(db, req, body(req)));
}));

r.get("/vehicles/:id", VIEW, handle((req, res) => {
  res.json(vehicles.getVehicle(db, idOr404(req.params.id)));
}));

r.patch("/vehicles/:id", EDIT, handle((req, res) => {
  res.json(vehicles.update(db, req, idOr404(req.params.id), body(req)));
}));

r.post("/vehicles/:id/bookings", BOOK, handle((req, res) => {
  res.status(201).json(vehicles.addBooking(db, req, idOr404(req.params.id), body(req)));
}));

r.patch("/vehicle-bookings/:id", BOOK, handle((req, res) => {
  res.json(vehicles.updateBooking(db, req, idOr404(req.params.id), body(req)));
}));

r.post("/vehicle-bookings/:id/done", BOOK, handle((req, res) => {
  res.json(vehicles.setDone(db, req, idOr404(req.params.id), body(req).done));
}));

r.delete("/vehicle-bookings/:id", BOOK, handle((req, res) => {
  vehicles.cancelBooking(db, req, idOr404(req.params.id));
  res.status(204).end();
}));

module.exports = r.router;
