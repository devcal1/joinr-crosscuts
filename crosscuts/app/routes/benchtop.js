// Benchtop designer (0.2.0, docs/plans/m21-benchtop-designer.md). Access follows the stone orders:
// jobs.view sees and prints a job's plan, jobs.edit changes it and freezes revisions, design.view
// has the list on the Benchtops page, and the material and edge-finish lists are changed by admins
// only (users.admin). Every rule lives in lib/benchtop.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError } = require("../lib/httperror");
const benchtop = require("../lib/benchtop");
const settings = require("../lib/settings");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[benchtop]");
    }
  };
}

function idOr404(v) {
  if (typeof v !== "string" || !/^[1-9]\d{0,14}$/.test(v)) throw notFound();
  return Number(v);
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// The letterhead lines, as the stone order prints: name, address, phone and email only.
function business() {
  const b = settings.business(db);
  return { tradingName: b.tradingName, legalName: b.legalName, address: b.address, phone: b.phone, email: b.email };
}

// --- a job's plan ----------------------------------------------------------------------------------

r.get("/job-records/:id/benchtop-plan", "jobs.view", handle((req, res) => {
  res.json(benchtop.forJob(db, idOr404(req.params.id)));
}));

r.post("/job-records/:id/benchtop-plan", "jobs.edit", handle((req, res) => {
  res.status(201).json(benchtop.create(db, req, idOr404(req.params.id), body(req)));
}));

// --- the lists (literal paths before /:id) ---------------------------------------------------------

r.get("/benchtop-plans", "design.view", handle((req, res) => {
  res.json({ plans: benchtop.list(db) });
}));

r.get("/benchtop-lists", ["jobs.view", "design.view"], handle((req, res) => {
  res.json(benchtop.lists(db));
}));

r.post("/benchtop-lists/:kind", "users.admin", handle((req, res) => {
  const kind = req.params.kind;
  if (kind !== "materials" && kind !== "finishes") throw notFound();
  res.status(201).json(benchtop.listCreate(db, req, kind, body(req)));
}));

r.patch("/benchtop-lists/:kind/:id", "users.admin", handle((req, res) => {
  const kind = req.params.kind;
  if (kind !== "materials" && kind !== "finishes") throw notFound();
  res.json(benchtop.listUpdate(db, req, kind, idOr404(req.params.id), body(req)));
}));

// --- one plan --------------------------------------------------------------------------------------

r.get("/benchtop-plans/:id", "jobs.view", handle((req, res) => {
  res.json(benchtop.get(db, idOr404(req.params.id)));
}));

r.put("/benchtop-plans/:id", "jobs.edit", handle((req, res) => {
  res.json(benchtop.update(db, req, idOr404(req.params.id), body(req)));
}));

// 200 {letter, created}: the revision to print (a new letter only when something changed).
r.post("/benchtop-plans/:id/print", "jobs.edit", handle((req, res) => {
  res.json(benchtop.print(db, req, idOr404(req.params.id), business()));
}));

r.get("/benchtop-plans/:id/revisions/:letter", "jobs.view", handle((req, res) => {
  const letter = req.params.letter;
  if (typeof letter !== "string" || !/^[A-Z]{1,3}$/.test(letter)) throw notFound();
  res.json(benchtop.revision(db, idOr404(req.params.id), letter));
}));

module.exports = r.router;
