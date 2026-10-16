// Job bonuses (docs/plans/m13-contracts.md section 7.1): every route declared with its access, the
// handlers calling lib/bonuses.js (Wave 1 B). Literal paths are registered before /:id ones.
//
// bonuses.manage is an owner-only key (section 3): the owner holds it, and only the owner can grant
// it. Every other rule lives in lib/bonuses.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError } = require("../lib/httperror");
const bonuses = require("../lib/bonuses");

const r = defineRoutes("/api/bonuses");

const KEY = "bonuses.manage";

function handle(fn) {
  return (req, res) => {
    // Nothing from this area is kept by a browser or a proxy (M13 4.3): every GET, refusals too.
    if (req.method === "GET") res.set("Cache-Control", "no-store");
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[bonuses]");
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

// A JSON object body; routes with an optional body also take an empty one.
function body(req, { emptyOk = false } = {}) {
  const b = req.body;
  if (emptyOk && (b === undefined || b === null || (typeof b === "object" && !Array.isArray(b) && !Object.keys(b).length))) {
    return {};
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// --- the list, settings, people, jobs and summary (literal paths first) -----------------------

r.get("/", KEY, handle((req, res) => {
  res.json(bonuses.list(db, { status: req.query.status }));
}));

r.post("/", KEY, handle((req, res) => {
  res.status(201).json(bonuses.create(db, req, body(req)));
}));

r.get("/settings", KEY, handle((req, res) => {
  res.json(bonuses.settings(db));
}));

r.put("/settings", KEY, handle((req, res) => {
  res.json(bonuses.putSettings(db, req, body(req)));
}));

r.get("/people", KEY, handle((req, res) => {
  res.json(bonuses.people(db));
}));

r.get("/jobs", KEY, handle((req, res) => {
  res.json(bonuses.jobs(db, req, { q: req.query.q }));
}));

r.get("/summary", KEY, handle((req, res) => {
  res.json(bonuses.summary(db));
}));

r.post("/people/:personId/paid", KEY, handle((req, res) => {
  const personId = idOr404(req.params.personId);
  res.json(bonuses.markPersonPaid(db, req, personId, body(req)));
}));

// --- one bonus ----------------------------------------------------------------------------------

r.get("/:id", KEY, handle((req, res) => {
  res.json(bonuses.get(db, idOr404(req.params.id)));
}));

r.patch("/:id", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  res.json(bonuses.update(db, req, id, body(req)));
}));

r.delete("/:id", KEY, handle((req, res) => {
  res.json(bonuses.remove(db, req, idOr404(req.params.id)));
}));

r.post("/:id/joinr-hours", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  body(req, { emptyOk: true });
  res.json(bonuses.fillHours(db, req, id));
}));

r.post("/:id/confirm", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  res.json(bonuses.confirm(db, req, id, body(req, { emptyOk: true })));
}));

r.post("/:id/reopen", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  body(req, { emptyOk: true });
  res.json(bonuses.reopen(db, req, id));
}));

r.post("/:id/shares/:personId/paid", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  const personId = idOr404(req.params.personId);
  res.json(bonuses.markPaid(db, req, id, personId, body(req, { emptyOk: true })));
}));

module.exports = r.router;
