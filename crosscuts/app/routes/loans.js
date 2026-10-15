// Loans (docs/plans/m13-contracts.md section 7.3). SCAFFOLD (M13 · 2.2): every route is declared
// with its access; the handlers call lib/loans.js, whose stubs throw HttpError(501, "Not built"), so
// each answers 501 {"error":"Not built"} until Wave 1 D fills in both files. Literal paths are
// registered before /:id ones.
//
// loans.manage is an owner-only key (section 3); the owner can grant it to an Accounts login.
// Every other rule lives in lib/loans.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError } = require("../lib/httperror");
const loans = require("../lib/loans");

const r = defineRoutes("/api/loans");

const KEY = "loans.manage";

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      // sendError hides anything that isn't a 4xx; the scaffold stubs' 501 is answered as it is.
      if (e && e.status === 501) return res.status(501).json({ error: e.message || "Not built" });
      sendError(res, e, "[loans]");
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

// A JSON object body.
function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// --- the list ---------------------------------------------------------------------------------

r.get("/", KEY, handle((req, res) => {
  res.json(loans.list(db, { archived: req.query.archived === "1" }));
}));

r.post("/", KEY, handle((req, res) => {
  res.status(201).json(loans.create(db, req, body(req)));
}));

// --- one loan ---------------------------------------------------------------------------------

r.get("/:id", KEY, handle((req, res) => {
  res.json(loans.get(db, idOr404(req.params.id)));
}));

r.patch("/:id", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  res.json(loans.update(db, req, id, body(req)));
}));

r.get("/:id/interest", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  res.json(loans.interest(db, id, { date: req.query.date, repaymentId: req.query.repaymentId }));
}));

r.get("/:id/statement", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  res.json(loans.statement(db, id, { from: req.query.from, to: req.query.to }));
}));

// --- rates ------------------------------------------------------------------------------------

r.post("/:id/rates", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  res.status(201).json(loans.addRate(db, req, id, body(req)));
}));

r.patch("/:id/rates/:rateId", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  const rateId = idOr404(req.params.rateId);
  res.json(loans.updateRate(db, req, id, rateId, body(req)));
}));

r.delete("/:id/rates/:rateId", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  const rateId = idOr404(req.params.rateId);
  res.json(loans.deleteRate(db, req, id, rateId));
}));

// --- repayments -------------------------------------------------------------------------------

r.post("/:id/repayments", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  res.status(201).json(loans.addRepayment(db, req, id, body(req)));
}));

r.patch("/:id/repayments/:repId", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  const repId = idOr404(req.params.repId);
  res.json(loans.updateRepayment(db, req, id, repId, body(req)));
}));

r.delete("/:id/repayments/:repId", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  const repId = idOr404(req.params.repId);
  res.json(loans.deleteRepayment(db, req, id, repId));
}));

module.exports = r.router;
