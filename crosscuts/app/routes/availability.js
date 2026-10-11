// Leave and availability: /api/availability. See docs/plans/m5-contracts.md section 3.
// The rules (dates, kinds, patterns) live in lib/availability.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const availability = require("../lib/availability");
const { addDays, sydneyToday, DATE_RE, parseDateUTC, formatDateUTC } = require("../lib/time");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api/availability");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[availability]");
    }
  };
}

function idOr404(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  return id;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// An optional query value that must be one real YYYY-MM-DD date.
function dateParam(q, name, fallback) {
  const v = q[name];
  if (v === undefined || v === "") return fallback;
  if (typeof v !== "string" || !DATE_RE.test(v) || formatDateUTC(parseDateUTC(v)) !== v) {
    throw bad(`${name} must be a date (YYYY-MM-DD)`);
  }
  return v;
}

r.get("/", "scheduling.view", handle((req, res) => {
  const q = req.query;
  const today = sydneyToday();
  const from = dateParam(q, "from", addDays(today, -30));
  const to = dateParam(q, "to", addDays(today, 180));
  let workerId = null;
  if (q.workerId !== undefined && q.workerId !== "") {
    workerId = typeof q.workerId === "string" ? Number(q.workerId) : NaN;
    if (!Number.isInteger(workerId) || workerId <= 0) throw bad("workerId must be a worker id");
  }
  res.json({
    workers: availability.listWorkers(db),
    leave: availability.listLeave(db, { from, to, workerId }),
  });
}));

r.post("/leave", "leave.edit", handle((req, res) => {
  res.status(201).json(availability.addLeave(db, req, body(req)));
}));

r.delete("/leave/:id", "leave.edit", handle((req, res) => {
  availability.removeLeave(db, req, idOr404(req));
  res.status(204).end();
}));

r.patch("/workers/:id", "leave.edit", handle((req, res) => {
  res.json(availability.setPattern(db, req, idOr404(req), body(req)));
}));

module.exports = r.router;
