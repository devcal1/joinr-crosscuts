// Board and edge tape reservations and "cut 100%" (0.2.6, docs/plans/m27-contracts.md section 5).
// Reserving is the order manager's (orders.mark_ordered); ticking Reserved and recording jobs cut
// 100% the workshop manager's (stock.count); releasing either's. The rules live in
// lib/reservations.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const reservations = require("../lib/reservations");
const { notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[reservations]");
    }
  };
}

function idOr404(v) {
  if (typeof v !== "string" || !/^[1-9]\d*$/.test(v)) throw notFound();
  return Number(v);
}

const BOTH = ["stock.count", "orders.mark_ordered"];

r.get("/reservations", BOTH, handle((req, res) => {
  res.json(reservations.page(db, req));
}));

r.post("/reservations/:id/confirm", "stock.count", handle((req, res) => {
  res.json(reservations.confirm(db, req, idOr404(req.params.id)));
}));

r.post("/reservations/:id/release", BOTH, handle((req, res) => {
  res.json(reservations.release(db, req, idOr404(req.params.id)));
}));

r.post("/workshop/cut", "stock.count", handle((req, res) => {
  res.json(reservations.cut(db, req, req.body));
}));

// The job page's Stock reservations block (and the cut 100% line): anyone who sees the job.
r.get("/job-records/:id/reservations", ["jobs.view", "stock.count", "orders.mark_ordered"], handle((req, res) => {
  res.json(reservations.forJob(db, req, idOr404(req.params.id)));
}));

r.post("/job-records/:id/reservations", "orders.mark_ordered", handle((req, res) => {
  res.status(201).json(reservations.reserve(db, req, idOr404(req.params.id), req.body));
}));

module.exports = r.router;
