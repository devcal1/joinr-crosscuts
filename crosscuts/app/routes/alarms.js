// Alarm holders and codes (docs/plans/m13-contracts.md section 7.2). SCAFFOLD (M13 · 2.2): every
// route is declared with its access; the handlers call lib/alarms.js, whose stubs throw
// HttpError(501, "Not built"), so each answers 501 {"error":"Not built"} until Wave 1 C fills in both
// files. The summary answers empty (section 7.2). Literal paths are registered before /:id ones.
//
// alarms.manage is an owner-only key (section 3). No alarm code ever appears in a log line, an error,
// a URL or a GET answer: only POST /slots/:id/reveal answers with one (section 5.3).
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError } = require("../lib/httperror");
const alarms = require("../lib/alarms");

const r = defineRoutes("/api/alarms");

const KEY = "alarms.manage";

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      // sendError hides anything that isn't a 4xx; the scaffold stubs' 501 is answered as it is.
      if (e && e.status === 501) return res.status(501).json({ error: e.message || "Not built" });
      sendError(res, e, "[alarms]");
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

// --- the overview, summary, company and times (literal paths first) ---------------------------

r.get("/", KEY, handle((req, res) => {
  res.json(alarms.overview(db));
}));

r.get("/summary", KEY, handle((req, res) => {
  res.json(alarms.summary(db));
}));

r.put("/company", KEY, handle((req, res) => {
  res.json(alarms.putCompany(db, req, body(req)));
}));

r.put("/times", KEY, handle((req, res) => {
  res.json(alarms.putTimes(db, req, body(req)));
}));

// --- slots ------------------------------------------------------------------------------------

r.post("/slots", KEY, handle((req, res) => {
  res.status(201).json(alarms.createSlot(db, req, body(req)));
}));

r.patch("/slots/:id", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  res.json(alarms.updateSlot(db, req, id, body(req)));
}));

r.post("/slots/:id/remove", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  res.json(alarms.removeSlot(db, req, id, body(req, { emptyOk: true })));
}));

r.post("/slots/:id/restore", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  body(req, { emptyOk: true });
  res.json(alarms.restoreSlot(db, req, id));
}));

r.post("/slots/:id/reveal", KEY, handle((req, res) => {
  const id = idOr404(req.params.id);
  body(req, { emptyOk: true });
  const out = alarms.reveal(db, req, id);
  res.set("Cache-Control", "no-store").json(out);
}));

module.exports = r.router;
