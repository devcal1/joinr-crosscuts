// Stone orders and the benchtop sheet (docs/plans/m12-contracts.md section 5). Declared in the
// M12 · 2.2 scaffold, filled in by Wave 1 A: each handler checks the path ids and the body's shape
// and passes it to lib/stone.js. Literal paths are registered before /:id ones.
//
// jobs.view sees and prints a job's stone orders, jobs.edit changes them, design.view has the list,
// the summary and the calculator page. Every other rule lives in lib/stone.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError, can } = require("../lib/httperror");
const stone = require("../lib/stone");
const settings = require("../lib/settings");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[stone]");
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

// A JSON object body; send, cancel and restore also take an empty one. The keys each takes are
// checked in lib/stone.js (send: sentDate and expectUpdatedAt; cancel and restore: none).
function body(req, { emptyOk = false } = {}) {
  const b = req.body;
  if (emptyOk && (b === undefined || b === null || (typeof b === "object" && !Array.isArray(b) && !Object.keys(b).length))) {
    return {};
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// The letterhead lines for the prints (section 5): name, address, phone and email only, as the
// paint order. No ABN and no bank details.
function business() {
  const b = settings.business(db);
  return { tradingName: b.tradingName, legalName: b.legalName, address: b.address, phone: b.phone, email: b.email };
}

// --- a job's stone orders and its benchtop sheet ----------------------------------------------

r.get("/job-records/:id/stone", "jobs.view", handle((req, res) => {
  res.json(stone.forJob(db, req, idOr404(req.params.id)));
}));

r.post("/job-records/:id/stone", "jobs.edit", handle((req, res) => {
  res.status(201).json(stone.create(db, req, idOr404(req.params.id), body(req)));
}));

r.get("/job-records/:id/benchtop-sheet", "jobs.view", handle((req, res) => {
  res.json({ ...stone.benchtopSheet(db, req, idOr404(req.params.id)), business: business() });
}));

// --- the list, summary, suggestions and letterhead (literal paths first) ----------------------

r.get("/stone", "design.view", handle((req, res) => {
  const status = req.query.status;
  if (status !== undefined && typeof status !== "string") throw bad("status must be a single value");
  // Without jobs.view the list leaves out the form's client and address details (section 4.4).
  res.json({ orders: stone.list(db, { status: status || "open", withClient: can(req, "jobs.view") }) });
}));

r.get("/stone/summary", "design.view", handle((req, res) => {
  res.json(stone.summary(db));
}));

r.get("/stone/suggestions", "jobs.edit", handle((req, res) => {
  res.json(stone.suggestions(db));
}));

r.get("/stone/letterhead", ["jobs.view", "design.view"], handle((req, res) => {
  res.json({ business: business() });
}));

// --- one stone order ---------------------------------------------------------------------------

r.get("/stone/:id", "jobs.view", handle((req, res) => {
  res.json({ ...stone.get(db, req, idOr404(req.params.id)), business: business() });
}));

r.patch("/stone/:id", "jobs.edit", handle((req, res) => {
  res.json(stone.update(db, req, idOr404(req.params.id), body(req)));
}));

r.post("/stone/:id/send", "jobs.edit", handle((req, res) => {
  res.json(stone.send(db, req, idOr404(req.params.id), body(req, { emptyOk: true })));
}));

r.post("/stone/:id/cancel", "jobs.edit", handle((req, res) => {
  res.json(stone.cancel(db, req, idOr404(req.params.id), body(req, { emptyOk: true })));
}));

r.post("/stone/:id/restore", "jobs.edit", handle((req, res) => {
  res.json(stone.restore(db, req, idOr404(req.params.id), body(req, { emptyOk: true })));
}));

r.get("/stone/:id/revisions/:rev", "jobs.view", handle((req, res) => {
  const id = idOr404(req.params.id);
  const rev = idOr404(req.params.rev);
  res.json({ ...stone.revision(db, req, id, rev), business: business() });
}));

module.exports = r.router;
