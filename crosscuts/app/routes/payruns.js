// The pay-runs API (docs/plans/m8-contracts.md section 6). Every route is declared with its access;
// the handlers check path ids and pass the database to lib/payroll.js, which does the work and
// throws HttpError for 400 / 404 / 409. Literal paths (/people, /holidays, /settings) are
// registered before /:id.
//
// accounts.view reads everything; invoices.edit writes; users.admin alone may reopen a finalised
// pay run. Logged out: 401 and without the key: 403 {"error":"Forbidden"}, both from the auth layer.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { notFound, sendError } = require("../lib/httperror");
const payroll = require("../lib/payroll");
const PayMaths = require("../public/paymaths");

const r = defineRoutes("/api/payruns");

const VIEW = "accounts.view";
const EDIT = "invoices.edit";
const ADMIN = "users.admin";

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[payruns]");
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

// Bodies that aren't objects are treated as {}.
function body(req) {
  const b = req.body;
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

// ------------------------------------------------------------ pay runs ---

// {startDate, endDate, label, payRunId} for one grid Monday.
function fortnight(start, payRuns) {
  const run = payRuns.find((p) => p.startDate === start);
  return {
    startDate: start,
    endDate: PayMaths.endOf(start),
    label: PayMaths.fortnightLabel(start),
    payRunId: run ? run.id : null,
  };
}

r.get("/", VIEW, handle((req, res) => {
  const payRuns = payroll.listRuns(db);
  const current = payroll.currentStart(db);
  res.json({
    payRuns,
    current: fortnight(current, payRuns),
    next: fortnight(PayMaths.addDays(current, 14), payRuns),
    rules: payroll.rules(db),
  });
}));

r.post("/", EDIT, handle((req, res) => {
  res.status(201).json(payroll.createRun(db, req, { startDate: body(req).startDate }));
}));

// -------------------------------------------------------------- people ---

r.get("/people", VIEW, handle((req, res) => {
  res.json({ people: payroll.listPeople(db, { all: req.query.all === "1" }) });
}));

r.post("/people", EDIT, handle((req, res) => {
  res.status(201).json(payroll.addPayOnly(db, req, { name: body(req).name }));
}));

r.put("/people/worker/:workerId", EDIT, handle((req, res) => {
  res.json(payroll.setWorkerOnPayRun(db, req, idOr404(req.params.workerId), body(req).onPayRun));
}));

r.patch("/people/:id", EDIT, handle((req, res) => {
  res.json(payroll.updatePerson(db, req, idOr404(req.params.id), body(req)));
}));

// ------------------------------------------------------------ holidays ---

r.get("/holidays", VIEW, handle((req, res) => {
  res.json({ holidays: payroll.listHolidays(db, { from: req.query.from, to: req.query.to }) });
}));

r.post("/holidays", EDIT, handle((req, res) => {
  const b = body(req);
  res.status(201).json(payroll.addHoliday(db, req, { date: b.date, name: b.name }));
}));

r.delete("/holidays/:date", EDIT, handle((req, res) => {
  payroll.removeHoliday(db, req, req.params.date);
  res.status(204).end();
}));

// ------------------------------------------------------------ settings ---

r.get("/settings", VIEW, handle((req, res) => {
  res.json(payroll.getSettings(db));
}));

r.put("/settings", EDIT, handle((req, res) => {
  res.json(payroll.putSettings(db, req, body(req)));
}));

// ------------------------------------------------------ one pay run (/:id) ---

r.get("/:id", VIEW, handle((req, res) => {
  const run = payroll.getRun(db, idOr404(req.params.id));
  if (!run) throw notFound();
  res.json(run);
}));

r.delete("/:id", EDIT, handle((req, res) => {
  payroll.deleteRun(db, req, idOr404(req.params.id));
  res.status(204).end();
}));

r.post("/:id/finalise", EDIT, handle((req, res) => {
  res.json(payroll.finalise(db, req, idOr404(req.params.id)));
}));

r.post("/:id/reopen", ADMIN, handle((req, res) => {
  res.json(payroll.reopen(db, req, idOr404(req.params.id)));
}));

r.post("/:id/myob", EDIT, handle((req, res) => {
  res.json(payroll.setMyob(db, req, idOr404(req.params.id), body(req).entered));
}));

r.get("/:id/summary", VIEW, handle((req, res) => {
  res.json(payroll.summary(db, idOr404(req.params.id)));
}));

// ---------------------------------------------------------- timesheets ---

r.post("/:id/timesheets", EDIT, handle((req, res) => {
  const b = body(req);
  res.status(201).json(
    payroll.addTimesheet(db, req, idOr404(req.params.id), { personId: b.personId, workerId: b.workerId })
  );
}));

r.get("/:id/timesheets/:tsId", VIEW, handle((req, res) => {
  const ts = payroll.getTimesheet(db, idOr404(req.params.id), idOr404(req.params.tsId));
  if (!ts) throw notFound();
  res.json(ts);
}));

r.put("/:id/timesheets/:tsId", EDIT, handle((req, res) => {
  res.json(payroll.saveTimesheet(db, req, idOr404(req.params.id), idOr404(req.params.tsId), body(req)));
}));

r.delete("/:id/timesheets/:tsId", EDIT, handle((req, res) => {
  payroll.removeTimesheet(db, req, idOr404(req.params.id), idOr404(req.params.tsId));
  res.status(204).end();
}));

module.exports = r.router;
