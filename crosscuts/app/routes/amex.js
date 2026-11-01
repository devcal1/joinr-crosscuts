// AMEX (0.2.12): the company card ledger. Every route is declared with its access (the same keys as
// Loans: loans.manage or loans.maintain); the handlers call lib/amex.js and map its errors.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError } = require("../lib/httperror");
const amex = require("../lib/amex");

const r = defineRoutes("/api/amex");

const KEEP = ["loans.manage", "loans.maintain"];

function handle(fn) {
  return (req, res) => {
    if (req.method === "GET") res.set("Cache-Control", "no-store");
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[amex]");
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

r.get("/", KEEP, handle((req, res) => {
  res.json(amex.list(db, { range: req.query.range }));
}));

r.post("/transactions", KEEP, handle((req, res) => {
  res.status(201).json(amex.addTransaction(db, req, body(req)));
}));

r.patch("/transactions/:id", KEEP, handle((req, res) => {
  res.json(amex.updateTransaction(db, req, idOr404(req.params.id), body(req)));
}));

r.delete("/transactions/:id", KEEP, handle((req, res) => {
  res.json(amex.deleteTransaction(db, req, idOr404(req.params.id)));
}));

r.post("/repayments", KEEP, handle((req, res) => {
  res.status(201).json(amex.addRepayment(db, req, body(req)));
}));

r.patch("/repayments/:id", KEEP, handle((req, res) => {
  res.json(amex.updateRepayment(db, req, idOr404(req.params.id), body(req)));
}));

r.delete("/repayments/:id", KEEP, handle((req, res) => {
  res.json(amex.deleteRepayment(db, req, idOr404(req.params.id)));
}));

module.exports = r.router;
