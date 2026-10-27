// Workshop > Maintenance (0.2.6, docs/plans/m27-contracts.md section 4). Every route is
// maintenance.manage (the workshop manager, admin and the owner); the rules live in
// lib/maintenance.js and lib/recurring.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const maintenance = require("../lib/maintenance");
const recurring = require("../lib/recurring");
const { bad, notFound, sendError } = require("../lib/httperror");
const { sydneyToday } = require("../lib/time");

const r = defineRoutes("/api/maintenance");
const KEY = "maintenance.manage";

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[maintenance]");
    }
  };
}

function idOr404(v) {
  if (typeof v !== "string" || !/^[1-9]\d*$/.test(v)) throw notFound();
  return Number(v);
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// 200 {today, items}.
r.get("/", KEY, handle((req, res) => {
  res.json(maintenance.list(db));
}));

// 200 {date, made, belled}: make due occurrences and run the overdue bell now. Body {today?}: as of
// that Sydney date, never before the real today (for checks). Registered before /:id.
r.post("/run", KEY, handle((req, res) => {
  const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  let today;
  if (b.today !== undefined && b.today !== null) {
    if (!recurring.validDate(b.today)) throw bad("today must be a date (YYYY-MM-DD)");
    if (b.today < sydneyToday()) throw bad("today can't be before today");
    today = b.today;
  }
  res.json(recurring.run(db, { today }));
}));

r.post("/occurrences/:taskId/done", KEY, handle((req, res) => {
  res.json(maintenance.confirm(db, req, idOr404(req.params.taskId), req.body));
}));

r.post("/occurrences/:taskId/reopen", KEY, handle((req, res) => {
  res.json(maintenance.reopen(db, req, idOr404(req.params.taskId)));
}));

r.get("/:id", KEY, handle((req, res) => {
  res.json(maintenance.get(db, idOr404(req.params.id)));
}));

r.post("/", KEY, handle((req, res) => {
  res.status(201).json(maintenance.create(db, req, body(req)));
}));

r.patch("/:id", KEY, handle((req, res) => {
  res.json(maintenance.update(db, req, idOr404(req.params.id), body(req)));
}));

r.post("/:id/pause", KEY, handle((req, res) => {
  res.json(maintenance.setActive(db, req, idOr404(req.params.id), false, req.body));
}));

r.post("/:id/resume", KEY, handle((req, res) => {
  res.json(maintenance.setActive(db, req, idOr404(req.params.id), true, req.body));
}));

r.delete("/:id", KEY, handle((req, res) => {
  maintenance.remove(db, req, idOr404(req.params.id));
  res.status(204).end();
}));

module.exports = r.router;
