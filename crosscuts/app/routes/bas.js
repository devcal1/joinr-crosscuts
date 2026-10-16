// The BAS sales API (docs/plans/m9-contracts.md section 6, and its 2026-10-16 note: sales are typed
// in by hand, invoices no longer count). Every route is declared with its access;
// the handlers check the path period's shape and pass the database to lib/bas.js, which does the
// work (range checks included) and throws HttpError for 400 / 404 / 409.
//
// accounts.view reads everything; invoices.edit writes; users.admin alone may reopen a lodged
// month. Logged out: 401 and without the key: 403 {"error":"Forbidden"}, both from the auth layer.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { notFound, sendError } = require("../lib/httperror");
const Periods = require("../public/periods");
const bas = require("../lib/bas");

const r = defineRoutes("/api/bas");

const VIEW = "accounts.view";
const EDIT = "invoices.edit";
const ADMIN = "users.admin";

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[bas]");
    }
  };
}

// A :period that isn't 'YYYY-MM' is a 404. (Range checks are lib/bas.js's, section 6.1.)
function periodOr404(v) {
  if (!Periods.validPeriod(v)) throw notFound();
  return v;
}

// Bodies that aren't objects are treated as {}.
function body(req) {
  const b = req.body;
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

// A missing fy means the current one; anything else is checked by lib/bas.js (400).
function fyOf(q) {
  return q === undefined || q === "" ? undefined : /^\d{4}$/.test(String(q)) ? Number(q) : NaN;
}

r.get("/", VIEW, handle((req, res) => {
  res.json(bas.year(db, fyOf(req.query.fy)));
}));

r.get("/compare", VIEW, handle((req, res) => {
  res.json(bas.compare(db));
}));

r.get("/months/:period", VIEW, handle((req, res) => {
  res.json(bas.month(db, periodOr404(req.params.period)));
}));

r.get("/sales.csv", VIEW, handle((req, res) => {
  const out = bas.csv(db, fyOf(req.query.fy));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="BAS sales ${out.label}.csv"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(out.text);
}));

r.put("/months/:period/sales", EDIT, handle((req, res) => {
  res.json(bas.setSales(db, req, periodOr404(req.params.period), body(req)));
}));

r.post("/months/:period/lodge", EDIT, handle((req, res) => {
  res.json(bas.lodge(db, req, periodOr404(req.params.period)));
}));

r.post("/months/:period/reopen", ADMIN, handle((req, res) => {
  res.json(bas.reopen(db, req, periodOr404(req.params.period)));
}));

module.exports = r.router;
