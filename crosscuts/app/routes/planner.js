// The Staff planner API (docs/plans/m7-contracts.md section 9). Thin and complete: it parses the
// request, calls lib/planner/* and shapes errors. Visibility, posting and editing are decided by
// lib/planner/layers.js only; the hand-made events are lib/planner/events.js (Wave 1 A), the
// automatic ones lib/planner/auto.js (Wave 1 B) and the bell lib/planner/reminders.js (Wave 1 A).
// Until those land, their scaffold stubs throw HttpError(501, "Not built") and these routes answer
// 501 {"error":"Not built"}.
//
// Logged out: 401 and without the key: 403 {"error":"Forbidden"}, both from the auth layer.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { bad, notFound, sendError } = require("../lib/httperror");
const { DATE_RE, sydneyToday, parseDateUTC, formatDateUTC, addDays } = require("../lib/time");
const layers = require("../lib/planner/layers");
const events = require("../lib/planner/events");
const auto = require("../lib/planner/auto");
const reminders = require("../lib/planner/reminders");

const r = defineRoutes("/api/planner");

const RANGE_MAX_DAYS = 62;
const JOB_DAYS = 90; // today to today + 89 (section 9.1)
const JOB_LIMIT = 20;
const WINDOW_MAX = 360;
const DAY_MS = 24 * 60 * 60 * 1000;

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      // sendError hides anything that isn't a 4xx; the scaffold stubs' 501 is answered as it is.
      if (e && e.status === 501) return res.status(501).json({ error: e.message || "Not built" });
      sendError(res, e, "[planner]");
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

function isDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && formatDateUTC(parseDateUTC(s)) === s;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// A query value that must be one string (or absent).
function single(q, key) {
  const v = q[key];
  if (v !== undefined && typeof v !== "string") throw bad(`${key} must be a single value`);
  return v;
}

// The effective layer set for GET /events: the visible layers, narrowed by ?layers=a,b when given.
// An unknown id is a 400; ids the viewer can't see are dropped silently (it only narrows).
function effectiveLayers(user, raw) {
  const visible = layers.visibleLayers(user);
  if (raw === undefined) return visible;
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of wanted) {
    if (!layers.LAYERS.includes(id)) throw bad(`Unknown layer: ${id}`);
  }
  return visible.filter((id) => wanted.includes(id));
}

const LAYER_ORDER = new Map(layers.LAYERS.map((id, i) => [id, i]));

// start, then all-day before timed, then startTime, then the layer order, then title, then id.
function compareItems(a, b) {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  if (!!a.allDay !== !!b.allDay) return a.allDay ? -1 : 1;
  const at = a.startTime || "", bt = b.startTime || "";
  if (at !== bt) return at < bt ? -1 : 1;
  const al = LAYER_ORDER.has(a.layer) ? LAYER_ORDER.get(a.layer) : LAYER_ORDER.size;
  const bl = LAYER_ORDER.has(b.layer) ? LAYER_ORDER.get(b.layer) : LAYER_ORDER.size;
  if (al !== bl) return al - bl;
  const t = String(a.title || "").localeCompare(String(b.title || ""));
  if (t !== 0) return t;
  const ai = String(a.id), bi = String(b.id);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

// 200 {today, layers, default, canEdit} (section 9.4).
r.get("/layers", "planner.view", handle((req, res) => {
  res.json({ today: sydneyToday(), ...layers.describe(req.user) });
}));

// 200 {from, to, today, events, weeks}: hand-made occurrences plus automatic items, sorted.
r.get("/events", "planner.view", handle((req, res) => {
  const q = req.query;
  const from = q.from, to = q.to;
  if (!isDate(from) || !isDate(to)) throw bad("from and to must be dates (YYYY-MM-DD)");
  if (to < from) throw bad("to must be on or after from");
  const days = Math.round((parseDateUTC(to) - parseDateUTC(from)) / DAY_MS) + 1;
  if (days > RANGE_MAX_DAYS) throw bad(`Ask for ${RANGE_MAX_DAYS} days at most`);
  const wanted = effectiveLayers(req.user, single(q, "layers"));
  const today = sydneyToday();
  let list = [], weeks = [];
  if (wanted.length > 0) {
    const handMade = events.listOccurrences(db, req.user, { from, to, layers: wanted });
    const automatic = auto.listAuto(db, req.user, { from, to, today, layers: wanted });
    list = [...(handMade || []), ...((automatic && automatic.events) || [])];
    weeks = (automatic && automatic.weeks) || [];
  }
  list.sort(compareItems);
  res.json({ from, to, today, events: list, weeks });
}));

// 200 the series object; 404 when missing, removed or not visible (never 403).
r.get("/events/:id", "planner.view", handle((req, res) => {
  res.json(events.getSeries(db, req.user, idOr404(req.params.id)));
}));

// 200 the series object (the new series after a split). Body {updatedAt, scope?, occurrence?, ...}.
r.patch("/events/:id", "planner.edit", handle((req, res) => {
  const id = idOr404(req.params.id);
  res.json(events.update(db, req, id, body(req)));
}));

// 204. ?scope&occurrence&updatedAt (updatedAt URL-encoded).
r.delete("/events/:id", "planner.edit", handle((req, res) => {
  const id = idOr404(req.params.id);
  const q = req.query;
  events.remove(db, req, id, {
    scope: single(q, "scope"),
    occurrence: single(q, "occurrence"),
    updatedAt: single(q, "updatedAt"),
  });
  res.status(204).end();
}));

// 201 the series object.
r.post("/events", "planner.edit", handle((req, res) => {
  res.status(201).json(events.create(db, req, body(req)));
}));

// 200 {rows, more}: the job's hand-made occurrences the viewer can see, today to today + 89
// (Sydney), at most 20. 404 when the job doesn't exist (checked here, before the library).
r.get("/job/:jobId", "planner.view", handle((req, res) => {
  const jobId = idOr404(req.params.jobId);
  if (!db.prepare("SELECT 1 AS ok FROM jobs WHERE id = ?").get(jobId)) throw notFound();
  const today = sydneyToday();
  res.json(events.listForJob(db, req.user, jobId, { from: today, to: addDays(today, JOB_DAYS - 1), limit: JOB_LIMIT }));
}));

// 200 {sent, from, to}. Body {at?: ISO, windowMinutes?: 1-360}, default now and 360. Runs the sweep
// for (at - windowMinutes, at] without moving the stored mark. `at` reaches runNow as a Date.
r.post("/reminders/run", "users.admin", handle((req, res) => {
  const b = req.body === undefined || req.body === null ? {} : req.body;
  if (typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  let at = new Date();
  if (b.at !== undefined && b.at !== null) {
    const ms = typeof b.at === "string" ? Date.parse(b.at) : NaN;
    if (Number.isNaN(ms)) throw bad("at must be an ISO time");
    at = new Date(ms);
  }
  let windowMinutes = WINDOW_MAX;
  if (b.windowMinutes !== undefined && b.windowMinutes !== null) {
    const w = b.windowMinutes;
    if (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > WINDOW_MAX) {
      throw bad(`windowMinutes must be 1 to ${WINDOW_MAX}`);
    }
    windowMinutes = w;
  }
  res.json(reminders.runNow(db, { at, windowMinutes }));
}));

module.exports = r.router;
