// Alarm holders and codes (docs/plans/m13-contracts.md section 7.2). Wave 1 C. Every route declares
// only the coarse access value; every rule lives in lib/alarms.js (and the key in lib/alarmcode.js).
// Literal paths are registered before /:id ones.
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
      // A 4xx answers its sentence; anything else is logged and hidden. Nothing in lib/alarms.js or
      // lib/alarmcode.js throws an error holding a code or the key (section 1, Boundaries).
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
  res.set("Cache-Control", "no-store"); // on the refusals too
  const id = idOr404(req.params.id);
  body(req, { emptyOk: true });
  res.json(alarms.reveal(db, req, id));
}));

module.exports = r.router;
