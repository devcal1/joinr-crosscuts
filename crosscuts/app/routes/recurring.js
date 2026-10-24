// Recurring tasks, Admin > Tasks (0.2.0, docs/plans/m20-recurring-tasks.md). Admins only
// (users.admin, as the Users page). The rules and the generation live in lib/recurring.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const recurring = require("../lib/recurring");
const { bad, notFound, sendError } = require("../lib/httperror");
const { sydneyToday } = require("../lib/time");

const r = defineRoutes("/api/recurring");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[recurring]");
    }
  };
}

function idOr404(req) {
  const v = req.params.id;
  if (typeof v !== "string" || !/^[1-9]\d*$/.test(v)) throw notFound();
  return Number(v);
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// 200 {today, rules, people, depts}.
r.get("/", "users.admin", handle((req, res) => {
  res.json(recurring.list(db));
}));

// 200 {date, made}. Body {today?}: run as of that Sydney date, never before the real today (for
// checks). Registered before the /:id routes.
r.post("/run", "users.admin", handle((req, res) => {
  const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  let today;
  if (b.today !== undefined && b.today !== null) {
    if (!recurring.validDate(b.today)) throw bad("today must be a date (YYYY-MM-DD)");
    if (b.today < sydneyToday()) throw bad("today can't be before today");
    today = b.today;
  }
  res.json(recurring.run(db, { today }));
}));

r.get("/:id", "users.admin", handle((req, res) => {
  res.json(recurring.get(db, idOr404(req)));
}));

r.post("/", "users.admin", handle((req, res) => {
  res.status(201).json(recurring.create(db, req, body(req)));
}));

r.patch("/:id", "users.admin", handle((req, res) => {
  res.json(recurring.update(db, req, idOr404(req), body(req)));
}));

r.post("/:id/pause", "users.admin", handle((req, res) => {
  res.json(recurring.setActive(db, req, idOr404(req), false, req.body));
}));

r.post("/:id/resume", "users.admin", handle((req, res) => {
  res.json(recurring.setActive(db, req, idOr404(req), true, req.body));
}));

// 204: no more occurrences; the tasks already made stay.
r.delete("/:id", "users.admin", handle((req, res) => {
  recurring.remove(db, req, idOr404(req));
  res.status(204).end();
}));

module.exports = r.router;
