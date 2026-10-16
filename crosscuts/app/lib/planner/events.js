// Hand-made planner events: validation, CRUD, repeats, one-off changes, splits and audit
// (docs/plans/m7-contracts.md section 7). Built in M7 · 3.1 Wave 1 A.
//
// A repeating event is one row (a series); its occurrences are worked out when asked, never stored,
// arithmetically from the first one that can overlap the range (never by looping from the start).
// Dates are Sydney YYYY-MM-DD and times Sydney HH:MM wall clock; all the maths here is calendar
// maths on date strings, never instants (only the bell needs instants: reminders.js).
//
// Visibility, posting and editing are decided by ./layers only. Nothing under lib/planner/ requires
// ../../db: every function takes db as its first argument. Personal events are audited without their
// content (section 11.2), and nothing here logs a title, notes or a job name.
const audit = require("../audit");
const layers = require("./layers");
const { bad, notFound, forbidden, conflict, HttpError } = require("../httperror");
const { DATE_RE, parseDateUTC, formatDateUTC, addDays } = require("../time");

const TITLE_MAX = 200;
const NOTES_MAX = 4000;
const SPAN_MAX_DAYS = 92;
const REMINDERS_TIMED = ["start", "min15", "hour1", "day1"];
const REMINDERS_ALL_DAY = ["morning", "day_before"];
const REMINDER_LABELS = {
  start: "At the start",
  min15: "15 minutes before",
  hour1: "1 hour before",
  day1: "1 day before",
  morning: "7:00 on the day",
  day_before: "7:00 the day before",
};

const REPEATS = ["none", "weekly", "fortnightly", "monthly", "annually"];
const STEP_DAYS = { weekly: 7, fortnightly: 14 };
const STEP_MAX_SPAN = { weekly: 7, fortnightly: 14, monthly: 28, annually: 28 };
const STEP_SENTENCE = {
  weekly: "A weekly event can't last longer than a week",
  fortnightly: "A fortnightly event can't last longer than two weeks",
  monthly: "A monthly event can't last longer than 28 days",
  annually: "An annual event can't last longer than 28 days",
};
const SCOPES = ["one", "later", "all"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_MIN = "2000-01-01";
const DATE_MAX = "2099-12-31";
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE = "Someone else changed this event. Reload to see it.";
// The body fields a PATCH may carry (updatedAt, scope and occurrence are not fields).
const FIELDS = [
  "layer", "title", "notes", "allDay", "startDate", "endDate", "startTime", "endTime",
  "repeat", "repeatUntil", "reminder", "remindLayer", "jobId",
];
// The fields a one-off change ("this one") may carry.
const ONE_OFF_FIELDS = ["title", "notes", "startDate", "endDate", "startTime", "endTime"];
const ID_CHUNK = 400;

// ------------------------------------------------------------------ calendar maths ---

function isDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && formatDateUTC(parseDateUTC(s)) === s;
}

// A real date inside the range the planner accepts.
function isPlannerDate(s) {
  return isDate(s) && s >= DATE_MIN && s <= DATE_MAX;
}

function daysBetween(a, b) {
  return Math.round((parseDateUTC(b) - parseDateUTC(a)) / DAY_MS);
}

function ymd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

function daysInMonth(y, m) {
  // m is 1-12; day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Whole months from a's month to b's month (days ignored).
function monthsBetween(a, b) {
  const A = ymd(a), B = ymd(b);
  return (B.y - A.y) * 12 + (B.m - A.m);
}

// The monthly occurrence n months after the series start: day min(repeatDay, days in that month).
function monthlyDate(start, n, repeatDay) {
  const S = ymd(start);
  const idx = S.y * 12 + (S.m - 1) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  const d = Math.min(repeatDay, daysInMonth(y, m));
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

// An annual event is stored as a monthly one that steps 12 months (migration 027: repeat = 'monthly',
// repeat_months = 12). These two translate at the edge, so the rest of the code, the API and the page
// only ever see 'annually'.
function rowRepeat(row) {
  return row.repeat === "monthly" && row.repeat_months === 12 ? "annually" : row.repeat;
}

function storedRepeat(repeat) {
  return repeat === "annually" ? { repeat: "monthly", repeatMonths: 12 } : { repeat, repeatMonths: 1 };
}

function toMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(n) {
  return `${pad2(Math.floor(n / 60))}:${pad2(n % 60)}`;
}

// ------------------------------------------------------------------ series shape ---

// A series in plain camelCase from a planner_events row (or an object already in that shape).
function norm(series) {
  const s = series || {};
  const pick = (snake, camel) => (s[snake] !== undefined ? s[snake] : s[camel]);
  const startDate = pick("start_date", "startDate");
  const endDate = pick("end_date", "endDate") || startDate;
  let repeat = pick("repeat", "repeat") || "none";
  if (repeat === "monthly" && pick("repeat_months", "repeatMonths") === 12) repeat = "annually";
  let repeatDay = pick("repeat_day", "repeatDay");
  if ((repeat === "monthly" || repeat === "annually") && (repeatDay === undefined || repeatDay === null)) repeatDay = ymd(startDate).d;
  return {
    startDate,
    endDate,
    span: daysBetween(startDate, endDate) + 1,
    repeat,
    repeatUntil: pick("repeat_until", "repeatUntil") || null,
    repeatDay: repeatDay === undefined || repeatDay === null ? null : Number(repeatDay),
    startTime: pick("start_time", "startTime") || null,
    endTime: pick("end_time", "endTime") || null,
    title: pick("title", "title"),
    notes: pick("notes", "notes") || "",
  };
}

// Original occurrence start dates of a series row whose span overlaps [from, to], ascending.
// Pure: no db. Worked out from the first occurrence that can overlap the range.
function occurrenceDates(series, from, to) {
  const s = norm(series);
  const out = [];
  if (!s.startDate || to < from) return out;
  const L = s.span;
  const lastStart = s.repeatUntil && s.repeatUntil < to ? s.repeatUntil : to;
  if (s.repeat === "none") {
    if (s.startDate <= to && s.endDate >= from) out.push(s.startDate);
    return out;
  }
  const earliest = addDays(from, -(L - 1)); // an occurrence starting before this ends before from
  if (STEP_DAYS[s.repeat]) {
    const step = STEP_DAYS[s.repeat];
    let n = Math.max(0, Math.ceil(daysBetween(s.startDate, earliest) / step));
    for (;; n++) {
      const start = addDays(s.startDate, n * step);
      if (start > lastStart) break;
      if (addDays(start, L - 1) >= from) out.push(start);
    }
    return out;
  }
  if (s.repeat === "monthly") {
    let n = Math.max(0, monthsBetween(s.startDate, earliest) - 1);
    for (;; n++) {
      const start = monthlyDate(s.startDate, n, s.repeatDay);
      if (start > lastStart) break;
      if (addDays(start, L - 1) >= from) out.push(start);
    }
    return out;
  }
  if (s.repeat === "annually") {
    // Every 12 months from the start: the same month and day, the day clamped to the month's length
    // (29 Feb falls on 28 Feb in a year that isn't a leap year), as the monthly rule does.
    let n = Math.max(0, Math.floor(monthsBetween(s.startDate, earliest) / 12) - 1);
    for (;; n++) {
      const start = monthlyDate(s.startDate, n * 12, s.repeatDay);
      if (start > lastStart) break;
      if (addDays(start, L - 1) >= from) out.push(start);
    }
    return out;
  }
  return out;
}

// Whether `date` is an occurrence start of the series on its rule (>= start, <= repeat_until).
// Ignores exceptions (a cancelled occurrence is still "on the rule").
function isOccurrence(series, date) {
  if (!isDate(date)) return false;
  const s = norm(series);
  if (!s.startDate || date < s.startDate) return false;
  if (s.repeat === "none") return date === s.startDate;
  if (s.repeatUntil && date > s.repeatUntil) return false;
  if (STEP_DAYS[s.repeat]) return daysBetween(s.startDate, date) % STEP_DAYS[s.repeat] === 0;
  if (s.repeat === "monthly") return monthlyDate(s.startDate, monthsBetween(s.startDate, date), s.repeatDay) === date;
  if (s.repeat === "annually") {
    const n = monthsBetween(s.startDate, date);
    return n % 12 === 0 && monthlyDate(s.startDate, n, s.repeatDay) === date;
  }
  return false;
}

function normException(ex) {
  const pick = (snake, camel) => (ex[snake] !== undefined ? ex[snake] : ex[camel]);
  const v = (x) => (x === undefined ? null : x);
  return {
    occurrence: pick("occurrence_date", "occurrence"),
    cancelled: !!pick("cancelled", "cancelled"),
    title: v(pick("title", "title")),
    notes: v(pick("notes", "notes")),
    startDate: v(pick("start_date", "startDate")),
    endDate: v(pick("end_date", "endDate")),
    startTime: v(pick("start_time", "startTime")),
    endTime: v(pick("end_time", "endTime")),
  };
}

function hasOverride(ex) {
  return ex.title !== null || ex.notes !== null || ex.startDate !== null || ex.startTime !== null;
}

// The effective occurrence for original start `d` (exception `ex` applied, if any).
function effective(s, d, ex) {
  const moved = ex && ex.startDate !== null;
  const timed = ex && ex.startTime !== null;
  return {
    occurrence: d,
    start: moved ? ex.startDate : d,
    end: moved ? ex.endDate : addDays(d, s.span - 1),
    startTime: timed ? ex.startTime : s.startTime,
    endTime: timed ? ex.endTime : s.endTime,
    title: ex && ex.title !== null ? ex.title : s.title,
    notes: ex && ex.notes !== null ? ex.notes : s.notes,
    changed: !!ex && hasOverride(ex),
  };
}

// Effective occurrences overlapping [from, to]: exceptions applied, cancelled ones dropped. Pure.
// A moved occurrence shows on its new dates (and only there); an exception whose key is no longer
// an occurrence of the series (after a split or a shortened repeat) is ignored.
function expand(series, exceptions, from, to) {
  const s = norm(series);
  const byDate = new Map();
  for (const raw of exceptions || []) {
    const ex = normException(raw);
    if (ex.occurrence) byDate.set(ex.occurrence, ex);
  }
  const keys = new Set(occurrenceDates(series, from, to));
  for (const ex of byDate.values()) {
    if (ex.startDate !== null && isOccurrence(series, ex.occurrence)) keys.add(ex.occurrence);
  }
  const out = [];
  for (const d of keys) {
    const ex = byDate.get(d);
    if (ex && ex.cancelled) continue;
    const occ = effective(s, d, ex);
    if (occ.start <= to && occ.end >= from) out.push(occ);
  }
  out.sort((a, b) =>
    a.start !== b.start ? (a.start < b.start ? -1 : 1) : a.occurrence < b.occurrence ? -1 : a.occurrence > b.occurrence ? 1 : 0
  );
  return out;
}

// ------------------------------------------------------------------ shaping ---

function has(user, key) {
  if (!user) return false;
  const p = user.perms;
  if (p instanceof Set) return p.has(key);
  if (Array.isArray(p)) return p.includes(key);
  return false;
}

function jobOf(row) {
  return row.job_id == null ? null : { id: row.job_id, name: row.job_name == null ? "" : row.job_name };
}

function jobLink(user, row) {
  return row.job_id != null && has(user, "jobs.view") ? `/job.html?id=${row.job_id}` : null;
}

const LAYER_ORDER = new Map(layers.LAYERS.map((id, i) => [id, i]));

// The router's order (section 9.1): start, all-day first, startTime, layer, title, id.
function compareItems(a, b) {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  if (!!a.allDay !== !!b.allDay) return a.allDay ? -1 : 1;
  const at = a.startTime || "", bt = b.startTime || "";
  if (at !== bt) return at < bt ? -1 : 1;
  const al = LAYER_ORDER.get(a.layer), bl = LAYER_ORDER.get(b.layer);
  if (al !== bl) return al - bl;
  const t = String(a.title || "").localeCompare(String(b.title || ""));
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// One hand-made occurrence item (section 9.2) for the viewer.
function occItem(user, row, occ) {
  return {
    id: `e:${row.id}:${occ.occurrence}`,
    source: "event",
    sourceLabel: null,
    eventId: row.id,
    occurrence: occ.occurrence,
    layer: row.layer,
    title: occ.title,
    notes: occ.notes,
    allDay: !!row.all_day,
    start: occ.start,
    end: occ.end,
    startTime: row.all_day ? null : occ.startTime,
    endTime: row.all_day ? null : occ.endTime,
    repeat: rowRepeat(row),
    repeatUntil: row.repeat_until || null,
    changed: occ.changed,
    reminder: row.reminder || null,
    remindLayer: !!row.remind_layer,
    job: jobOf(row),
    link: jobLink(user, row),
    createdBy: { id: row.owner_id, name: row.owner_name == null ? "" : row.owner_name },
    updatedAt: row.updated_at,
    overdue: false,
    readOnly: false,
    canEdit: layers.canEdit(user, row),
  };
}

const SERIES_SELECT = `SELECT e.*, u.display_name AS owner_name, j.name AS job_name, ub.display_name AS updated_by_name
    FROM planner_events e
    JOIN users u ON u.id = e.owner_id
    LEFT JOIN jobs j ON j.id = e.job_id
    LEFT JOIN users ub ON ub.id = e.updated_by`;

function loadRow(db, id) {
  return db.prepare(`${SERIES_SELECT} WHERE e.id = ? AND e.removed_at IS NULL`).get(id) || null;
}

function exceptionsOf(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const part = ids.slice(i, i + ID_CHUNK);
    const rows = db
      .prepare(
        `SELECT * FROM planner_exceptions WHERE event_id IN (${part.map(() => "?").join(",")})
          ORDER BY event_id, occurrence_date`
      )
      .all(...part);
    for (const r of rows) {
      if (!out.has(r.event_id)) out.set(r.event_id, []);
      out.get(r.event_id).push(r);
    }
  }
  return out;
}

// The series object (section 9.3). Exceptions are those still keyed to an occurrence of the series.
function present(db, user, row) {
  const exs = (exceptionsOf(db, [row.id]).get(row.id) || [])
    .map(normException)
    .filter((ex) => isOccurrence(row, ex.occurrence));
  return {
    id: row.id,
    layer: row.layer,
    title: row.title,
    notes: row.notes,
    allDay: !!row.all_day,
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: row.start_time || null,
    endTime: row.end_time || null,
    repeat: rowRepeat(row),
    repeatUntil: row.repeat_until || null,
    repeatDay: row.repeat_day == null ? null : row.repeat_day,
    splitFromId: row.split_from_id == null ? null : row.split_from_id,
    reminder: row.reminder || null,
    remindLayer: !!row.remind_layer,
    job: jobOf(row),
    link: jobLink(user, row),
    createdBy: { id: row.owner_id, name: row.owner_name == null ? "" : row.owner_name },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by == null ? null : { id: row.updated_by, name: row.updated_by_name == null ? "" : row.updated_by_name },
    canEdit: layers.canEdit(user, row),
    exceptions: exs.map((ex) => ({
      occurrence: ex.occurrence,
      cancelled: ex.cancelled,
      title: ex.title,
      notes: ex.notes,
      startDate: ex.startDate,
      endDate: ex.endDate,
      startTime: ex.startTime,
      endTime: ex.endTime,
    })),
  };
}

// ------------------------------------------------------------------ reads ---

// The series rows that can have an occurrence in [from, to] (section 7.5), plus their exceptions.
// `filter` is a {clause, args} SQL fragment over alias e; `extra` narrows further.
function loadRange(db, { from, to, filter, extra }) {
  const where = [
    "e.removed_at IS NULL",
    filter.clause,
    `((e.repeat = 'none' AND e.start_date <= ? AND e.end_date >= ?)
      OR (e.repeat <> 'none' AND e.start_date <= ?
          AND (e.repeat_until IS NULL OR e.repeat_until >= date(?, '-91 days')))
      OR e.id IN (SELECT event_id FROM planner_exceptions
                   WHERE cancelled = 0 AND start_date <= ? AND end_date >= ?))`,
  ];
  const args = [...filter.args, to, from, to, from, to, from];
  if (extra) {
    where.push(extra.clause);
    args.push(...extra.args);
  }
  const rows = db.prepare(`${SERIES_SELECT} WHERE ${where.join(" AND ")} ORDER BY e.id`).all(...args);
  const exs = exceptionsOf(db, rows.map((r) => r.id));
  return rows.map((row) => ({ row, exceptions: exs.get(row.id) || [] }));
}

function assertRange(from, to) {
  if (!isDate(from) || !isDate(to)) throw bad("from and to must be dates (YYYY-MM-DD)");
  if (to < from) throw bad("to must be on or after from");
}

// The viewer's hand-made occurrences in [from, to] on the effective layers (never empty).
function listOccurrences(db, user, { from, to, layers: wanted } = {}) {
  assertRange(from, to);
  const filter = layers.sqlFilter(user, wanted);
  if (filter.clause === "0") return [];
  const out = [];
  for (const { row, exceptions } of loadRange(db, { from, to, filter })) {
    for (const occ of expand(row, exceptions, from, to)) out.push(occItem(user, row, occ));
  }
  return out;
}

// The job's hand-made occurrences the viewer can see in [from, to], sorted, at most `limit`.
function listForJob(db, user, jobId, { from, to, limit = 20 } = {}) {
  assertRange(from, to);
  const filter = layers.sqlFilter(user);
  if (filter.clause === "0") return { rows: [], more: false };
  const all = [];
  for (const { row, exceptions } of loadRange(db, { from, to, filter, extra: { clause: "e.job_id = ?", args: [jobId] } })) {
    for (const occ of expand(row, exceptions, from, to)) all.push(occItem(user, row, occ));
  }
  all.sort(compareItems);
  return { rows: all.slice(0, limit), more: all.length > limit };
}

// One series, or 404 when missing, removed or not visible (never 403).
function getSeries(db, user, id) {
  const row = loadRow(db, id);
  if (!row || !layers.canSee(user, row)) throw notFound();
  return present(db, user, row);
}

// Every non-removed series with a reminder (all layers, no viewer), expanded over [from, to]; only
// occurrences whose effective start date is inside [from, to].
function occurrencesForSweep(db, { from, to } = {}) {
  assertRange(from, to);
  const out = [];
  const filter = { clause: "e.reminder IS NOT NULL", args: [] };
  for (const { row, exceptions } of loadRange(db, { from, to, filter })) {
    // One bad row must not stop every reminder (M7 · 4.3): it is skipped and logged by id only.
    let occs;
    try {
      occs = expand(row, exceptions, from, to);
    } catch (e) {
      const code = e && typeof e.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "error";
      console.error(`[planner] reminder skipped for event ${Number(row.id)}: ${code}`);
      continue;
    }
    for (const occ of occs) {
      if (occ.start >= from && occ.start <= to) out.push({ event: row, occ });
    }
  }
  return out;
}

// ------------------------------------------------------------------ validation ---

function parseTitle(v) {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) throw bad("Title is required");
  if (t.length > TITLE_MAX) throw bad("Title is too long (200 characters at most)");
  return t;
}

function parseNotes(v) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw bad("Notes must be text");
  const t = v.replace(/\s+$/, "");
  if (t.length > NOTES_MAX) throw bad("Notes are too long (4,000 characters at most)");
  return t;
}

function parseDate(v, name) {
  if (!isPlannerDate(v)) throw bad(`${name} must be a date (YYYY-MM-DD)`);
  return v;
}

function parseTime(v, name) {
  if (typeof v !== "string" || !TIME_RE.test(v)) throw bad(`${name} must be a time (HH:MM)`);
  return v;
}

// Positive integer (a number or a digit string), else NaN.
function parseIdValue(v) {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : NaN;
}

function parseJobId(db, v) {
  if (v === null || v === "") return null;
  const id = parseIdValue(v);
  if (Number.isNaN(id) || !db.prepare("SELECT id FROM jobs WHERE id = ?").get(id)) throw bad("Unknown job");
  return id;
}

// Span and time checks shared by series and one-off changes (section 7.4).
function checkWhen({ allDay, startDate, endDate, startTime, endTime }) {
  if (endDate < startDate) throw bad("endDate can't be before startDate");
  if (daysBetween(startDate, endDate) + 1 > SPAN_MAX_DAYS) throw bad("An event can last 92 days at most");
  if (allDay) {
    if (startTime !== null || endTime !== null) throw bad("An all-day event has no times");
    return;
  }
  if (toMinutes(endTime) <= toMinutes(startTime)) throw bad("The end time must be after the start time");
  if (endDate !== startDate) throw bad("A timed event starts and ends on the same day");
}

// The end time when none is given: start + `minutes`, capped at 23:59.
function defaultEnd(startTime, minutes) {
  return fromMinutes(Math.min(toMinutes(startTime) + minutes, 23 * 60 + 59));
}

// The base of an edit in camelCase from a row.
function baseOf(row) {
  return {
    layer: row.layer,
    title: row.title,
    notes: row.notes,
    allDay: !!row.all_day,
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: row.start_time || null,
    endTime: row.end_time || null,
    repeat: rowRepeat(row),
    repeatUntil: row.repeat_until || null,
    repeatDay: row.repeat_day == null ? null : row.repeat_day,
    reminder: row.reminder || null,
    remindLayer: !!row.remind_layer,
    jobId: row.job_id == null ? null : row.job_id,
  };
}

// A whole series from `base` (null when creating) and `body`, validated as a whole (section 7.4,
// the 400s only; the 403s are the caller's). Returns the candidate in camelCase.
function buildSeries(db, user, base, body) {
  const creating = base === null;
  const given = (k) => body[k] !== undefined;
  const b = base || {};

  const title = creating || given("title") ? parseTitle(body.title) : b.title;
  const notes = creating || given("notes") ? parseNotes(body.notes) : b.notes;

  let layer;
  if (given("layer") && body.layer !== null) layer = body.layer;
  else layer = creating ? layers.defaultLayer(user) : b.layer;
  if (!layers.LAYERS.includes(layer)) throw bad("Unknown layer");

  let allDay;
  if (given("allDay")) {
    if (typeof body.allDay !== "boolean") throw bad("allDay must be true or false");
    allDay = body.allDay;
  } else if (creating) {
    throw bad("allDay must be true or false");
  } else {
    allDay = b.allDay;
  }
  const allDayChanged = !creating && allDay !== b.allDay;

  const startDate = creating || given("startDate") ? parseDate(body.startDate, "startDate") : b.startDate;
  let endDate;
  if (given("endDate") && body.endDate !== null) endDate = parseDate(body.endDate, "endDate");
  else if (!allDay) endDate = startDate;
  else if (creating) endDate = startDate;
  else if (given("startDate")) endDate = addDays(startDate, b.allDay ? daysBetween(b.startDate, b.endDate) : 0);
  else endDate = b.allDay ? b.endDate : startDate;

  let startTime = null, endTime = null;
  if (allDay) {
    // Times sent with an all-day event are a 400; times left over from a timed base are dropped.
    const st = given("startTime") && body.startTime !== "" ? body.startTime : null;
    const et = given("endTime") && body.endTime !== "" ? body.endTime : null;
    if (st !== null || et !== null) throw bad("An all-day event has no times");
  } else {
    startTime = creating || given("startTime") || allDayChanged
      ? parseTime(given("startTime") ? body.startTime : undefined, "startTime")
      : b.startTime;
    if (given("endTime") && body.endTime !== null) endTime = parseTime(body.endTime, "endTime");
    else if (!creating && !allDayChanged && !given("startTime")) endTime = b.endTime;
    else {
      const minutes = !creating && !allDayChanged && b.startTime && b.endTime ? toMinutes(b.endTime) - toMinutes(b.startTime) : 60;
      endTime = defaultEnd(startTime, minutes);
    }
  }
  checkWhen({ allDay, startDate, endDate, startTime, endTime });

  let repeat = creating ? "none" : b.repeat;
  if (given("repeat") && body.repeat !== null) repeat = body.repeat;
  if (!REPEATS.includes(repeat)) throw bad("repeat must be one of none, weekly, fortnightly, monthly, annually");

  let repeatUntil = null;
  if (repeat !== "none") {
    const raw = given("repeatUntil") ? body.repeatUntil : creating || b.repeat === "none" ? null : b.repeatUntil;
    if (raw !== null && raw !== "") {
      if (!isPlannerDate(raw)) throw bad("repeatUntil must be a date (YYYY-MM-DD)");
      if (raw < startDate) throw bad("repeatUntil can't be before the start date");
      repeatUntil = raw;
    }
  }

  let repeatDay = null;
  if (repeat === "monthly" || repeat === "annually") {
    const keep = !creating && (b.repeat === "monthly" || b.repeat === "annually") && startDate === b.startDate && b.repeatDay != null;
    repeatDay = keep ? b.repeatDay : ymd(startDate).d;
    const S = ymd(startDate);
    if (Math.min(repeatDay, daysInMonth(S.y, S.m)) !== S.d) repeatDay = S.d;
  }
  if (repeat !== "none" && daysBetween(startDate, endDate) + 1 > STEP_MAX_SPAN[repeat]) {
    throw bad(STEP_SENTENCE[repeat]);
  }

  let reminder;
  if (given("reminder")) reminder = body.reminder === "" ? null : body.reminder;
  else reminder = creating || allDayChanged ? null : b.reminder;
  if (reminder !== null) {
    if (allDay && !REMINDERS_ALL_DAY.includes(reminder)) throw bad("That reminder doesn't fit an all-day event");
    if (!allDay && !REMINDERS_TIMED.includes(reminder)) throw bad("That reminder doesn't fit a timed event");
  }

  let remindLayer;
  if (given("remindLayer") && body.remindLayer !== null) {
    if (typeof body.remindLayer !== "boolean") throw bad("remindLayer must be true or false");
    remindLayer = body.remindLayer;
    if (remindLayer && layer === "personal") throw bad("Personal events can't remind anyone else");
    if (remindLayer && reminder === null) throw bad("Choose a reminder first");
  } else {
    // Not asked for: kept where it still fits (moving to Personal or dropping the reminder ends it).
    remindLayer = creating ? false : b.remindLayer && layer !== "personal" && reminder !== null;
  }

  // Without jobs.view the job is checked before it is looked up: any change is a 403, so the answer
  // never says whether a job id exists (M7 · 4.3). Sending the current value back is no change.
  const baseJob = creating ? null : b.jobId;
  if (given("jobId") && !has(user, "jobs.view")) {
    const asked = body.jobId === null || body.jobId === "" ? null : parseIdValue(body.jobId);
    if (asked !== baseJob) throw new HttpError(403, "You can't link a job");
  }
  const jobId = given("jobId") ? parseJobId(db, body.jobId) : baseJob;

  return {
    layer, title, notes, allDay, startDate, endDate, startTime, endTime,
    repeat, repeatUntil, repeatDay, reminder, remindLayer, jobId,
  };
}

// The camelCase fields that differ between two series candidates (repeatDay included).
function diff(a, b) {
  const keys = [...FIELDS, "repeatDay"];
  return keys.filter((k) => (a[k] === undefined ? null : a[k]) !== (b[k] === undefined ? null : b[k]));
}

function pickFields(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k] === undefined ? null : obj[k];
  return out;
}

// The 403s after the field 400s: the layer (posting, and canEdit with the new layer) and the job.
function checkWriteRights(user, ownerId, base, cand) {
  if (base === null || cand.layer !== base.layer) {
    if (!layers.postableLayers(user).includes(cand.layer)) throw new HttpError(403, "You can't add events to that layer");
    if (base !== null && !layers.canEdit(user, { layer: cand.layer, owner_id: ownerId })) {
      throw new HttpError(403, "You can't add events to that layer");
    }
  }
  const jobChanged = base === null ? cand.jobId !== null : cand.jobId !== base.jobId;
  if (jobChanged && !has(user, "jobs.view")) throw new HttpError(403, "You can't link a job");
}

// ------------------------------------------------------------------ audit ---

// Personal events are audited without their content (section 11.2).
function redacted(fields, extra) {
  return { layer: "personal", fields, ...(extra || {}) };
}

function logEvent(req, action, id, { personal, fields, before, after, extra }) {
  if (personal) {
    audit.log(req, {
      action,
      entityType: "planner_event",
      entityId: id,
      before: before === undefined ? undefined : redacted(fields),
      after: redacted(fields, extra),
    });
  } else {
    audit.log(req, { action, entityType: "planner_event", entityId: id, before, after });
  }
}

// ------------------------------------------------------------------ writes ---

function nowIso() {
  return new Date().toISOString();
}

// A later timestamp than `prev`, even inside the same millisecond (the lib/tasks.js rule).
function nextStamp(prev) {
  const now = Date.now();
  const p = Date.parse(prev);
  return new Date(Number.isFinite(p) && p >= now ? p + 1 : now).toISOString();
}

function requireBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("JSON body required");
  return body;
}

function insertSeries(db, ownerId, actorId, c, ts, splitFromId) {
  const st = storedRepeat(c.repeat);
  const info = db
    .prepare(
      `INSERT INTO planner_events (layer, owner_id, title, notes, job_id, all_day, start_date, end_date,
         start_time, end_time, repeat, repeat_months, repeat_until, repeat_day, split_from_id, reminder,
         remind_layer, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      c.layer, ownerId, c.title, c.notes, c.jobId, c.allDay ? 1 : 0, c.startDate, c.endDate,
      c.startTime, c.endTime, st.repeat, st.repeatMonths, c.repeatUntil, c.repeatDay, splitFromId, c.reminder,
      c.remindLayer ? 1 : 0, ts, ts, actorId
    );
  return Number(info.lastInsertRowid);
}

function create(db, req, body) {
  requireBody(body);
  const user = req.user;
  const cand = buildSeries(db, user, null, body);
  checkWriteRights(user, user.id, null, cand);
  const id = db.transaction(() => {
    const newId = insertSeries(db, user.id, user.id, cand, nowIso(), null);
    const after = pickFields(cand, FIELDS);
    logEvent(req, "planner.event.create", newId, {
      personal: cand.layer === "personal",
      fields: Object.keys(after),
      after,
    });
    return newId;
  })();
  return present(db, user, loadRow(db, id));
}

// Steps 1-4 of the PATCH/DELETE check order (section 7.4): 404, 403, updatedAt/scope/occurrence,
// 409. Returns {row, repeating, scope, occurrence}.
function guard(db, user, id, { scope, occurrence, updatedAt }) {
  const row = loadRow(db, id);
  if (!row || !layers.canSee(user, row)) throw notFound();
  if (!layers.canEdit(user, row)) throw forbidden();
  if (typeof updatedAt !== "string" || !updatedAt) throw bad("updatedAt is required");
  const repeating = row.repeat !== "none";
  let sc = "all", occ = null;
  if (repeating) {
    if (!SCOPES.includes(scope)) throw bad("scope must be one, later or all");
    sc = scope;
    if (sc !== "all") {
      if (!isPlannerDate(occurrence)) throw bad("occurrence must be a date (YYYY-MM-DD)");
      const ex = db
        .prepare("SELECT cancelled FROM planner_exceptions WHERE event_id = ? AND occurrence_date = ?")
        .get(id, occurrence);
      if (!isOccurrence(row, occurrence) || (ex && ex.cancelled)) throw bad("That date isn't an occurrence of this event");
      occ = occurrence;
      // "This and all later" from the first occurrence is the whole series.
      if (sc === "later" && occ === row.start_date) sc = "all";
    }
  }
  if (updatedAt !== row.updated_at) throw conflict(STALE, { event: present(db, user, row) });
  return { row, repeating, scope: sc, occurrence: occ };
}

// Sets the series' updated_at/updated_by (any write to it or its exceptions), or 409.
function touch(db, user, row, ts) {
  const info = db
    .prepare("UPDATE planner_events SET updated_at = ?, updated_by = ? WHERE id = ? AND updated_at = ?")
    .run(ts, user.id, row.id, row.updated_at);
  if (info.changes !== 1) throw conflict(STALE, { event: present(db, user, loadRow(db, row.id) || row) });
}

function update(db, req, id, body) {
  requireBody(body);
  const user = req.user;
  const g = guard(db, user, id, { scope: body.scope, occurrence: body.occurrence, updatedAt: body.updatedAt });
  if (g.scope === "one") return updateOne(db, req, g, body);
  return g.scope === "later" ? split(db, req, g, body) : updateWhole(db, req, g, body);
}

// Scope one: upsert that occurrence's exception with the changed one-off fields (section 7.2).
function updateOne(db, req, g, body) {
  const user = req.user;
  const row = g.row;
  const s = norm(row);
  const base = baseOf(row);
  // Any non-one-off field that differs from the series is refused.
  for (const k of FIELDS) {
    if (ONE_OFF_FIELDS.includes(k) || body[k] === undefined) continue;
    let v = body[k];
    if (k === "jobId") v = v === null || v === "" ? null : parseIdValue(v);
    if (k === "reminder" && v === "") v = null;
    if (k === "repeatUntil" && v === "") v = null;
    if (v !== base[k]) throw bad("Change that for this and all later occurrences");
  }
  const D = g.occurrence;
  const exRow = db.prepare("SELECT * FROM planner_exceptions WHERE event_id = ? AND occurrence_date = ?").get(row.id, D);
  const ex = exRow ? normException(exRow) : null;
  const cur = effective(s, D, ex);
  const allDay = !!row.all_day;
  const given = (k) => body[k] !== undefined;

  const title = given("title") ? parseTitle(body.title) : cur.title;
  const notes = given("notes") ? parseNotes(body.notes) : cur.notes;
  const startDate = given("startDate") ? parseDate(body.startDate, "startDate") : cur.start;
  let endDate;
  if (given("endDate") && body.endDate !== null) endDate = parseDate(body.endDate, "endDate");
  else if (!allDay) endDate = startDate;
  else endDate = given("startDate") ? addDays(startDate, daysBetween(cur.start, cur.end)) : cur.end;
  let startTime = null, endTime = null;
  if (allDay) {
    const st = given("startTime") && body.startTime !== "" ? body.startTime : null;
    const et = given("endTime") && body.endTime !== "" ? body.endTime : null;
    if (st !== null || et !== null) throw bad("An all-day event has no times");
  } else {
    startTime = given("startTime") ? parseTime(body.startTime, "startTime") : cur.startTime;
    if (given("endTime") && body.endTime !== null) endTime = parseTime(body.endTime, "endTime");
    else if (given("startTime")) endTime = defaultEnd(startTime, toMinutes(cur.endTime) - toMinutes(cur.startTime));
    else endTime = cur.endTime;
  }
  checkWhen({ allDay, startDate, endDate, startTime, endTime });

  // Stored as NULL where equal to the series' value for this occurrence.
  const seriesEnd = addDays(D, s.span - 1);
  const next = {
    title: title === row.title ? null : title,
    notes: notes === row.notes ? null : notes,
    startDate: startDate === D && endDate === seriesEnd ? null : startDate,
    endDate: startDate === D && endDate === seriesEnd ? null : endDate,
    startTime: allDay || (startTime === row.start_time && endTime === row.end_time) ? null : startTime,
    endTime: allDay || (startTime === row.start_time && endTime === row.end_time) ? null : endTime,
  };
  const prev = ex || { title: null, notes: null, startDate: null, endDate: null, startTime: null, endTime: null };
  const effBefore = { title: cur.title, notes: cur.notes, startDate: cur.start, endDate: cur.end, startTime: cur.startTime, endTime: cur.endTime };
  const effAfter = { title, notes, startDate, endDate, startTime, endTime };
  const changedKeys = ONE_OFF_FIELDS.filter((k) => effBefore[k] !== effAfter[k]);
  const storedSame = ONE_OFF_FIELDS.every((k) => prev[k] === next[k]);
  if (storedSame) return present(db, user, row);

  db.transaction(() => {
    const ts = nextStamp(row.updated_at);
    touch(db, user, row, ts);
    if (next.title === null && next.notes === null && next.startDate === null && next.startTime === null) {
      db.prepare("DELETE FROM planner_exceptions WHERE event_id = ? AND occurrence_date = ?").run(row.id, D);
    } else {
      db.prepare(
        `INSERT INTO planner_exceptions (event_id, occurrence_date, cancelled, title, notes, start_date, end_date,
           start_time, end_time, updated_at, updated_by)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id, occurrence_date) DO UPDATE SET cancelled = 0, title = excluded.title,
           notes = excluded.notes, start_date = excluded.start_date, end_date = excluded.end_date,
           start_time = excluded.start_time, end_time = excluded.end_time,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ).run(row.id, D, next.title, next.notes, next.startDate, next.endDate, next.startTime, next.endTime, ts, user.id);
    }
    logEvent(req, "planner.event.occurrence.update", row.id, {
      personal: row.layer === "personal",
      fields: changedKeys,
      after: { occurrence: D, changed: pickFields(effAfter, changedKeys) },
    });
  })();
  return present(db, user, loadRow(db, row.id));
}

// Scope all (or later at the first occurrence, or any edit of a non-repeating event).
function updateWhole(db, req, g, body) {
  const user = req.user;
  const row = g.row;
  const base = baseOf(row);
  const cand = buildSeries(db, user, base, body);
  checkWriteRights(user, row.owner_id, base, cand);
  const changed = diff(base, cand);
  if (changed.length === 0) return present(db, user, row);
  // A one-off change keeps the shape it was made in (times on a timed series, dates on an all-day
  // one), so switching All day on the whole series clears them too (M7 · 4.3).
  const clears = changed.includes("startDate") || changed.includes("repeat") || changed.includes("repeatDay")
    || changed.includes("allDay");
  const visible = changed.filter((k) => k !== "repeatDay" || !changed.includes("startDate"));
  const st = storedRepeat(cand.repeat);
  db.transaction(() => {
    const ts = nextStamp(row.updated_at);
    const info = db
      .prepare(
        `UPDATE planner_events SET layer = ?, title = ?, notes = ?, job_id = ?, all_day = ?, start_date = ?,
           end_date = ?, start_time = ?, end_time = ?, repeat = ?, repeat_months = ?, repeat_until = ?,
           repeat_day = ?, reminder = ?, remind_layer = ?, updated_at = ?, updated_by = ?
         WHERE id = ? AND updated_at = ? AND removed_at IS NULL`
      )
      .run(
        cand.layer, cand.title, cand.notes, cand.jobId, cand.allDay ? 1 : 0, cand.startDate, cand.endDate,
        cand.startTime, cand.endTime, st.repeat, st.repeatMonths, cand.repeatUntil, cand.repeatDay, cand.reminder,
        cand.remindLayer ? 1 : 0, ts, user.id, row.id, row.updated_at
      );
    if (info.changes !== 1) throw conflict(STALE, { event: present(db, user, loadRow(db, row.id) || row) });
    let cleared = 0;
    if (clears) {
      cleared = Number(db.prepare("DELETE FROM planner_exceptions WHERE event_id = ?").run(row.id).changes) || 0;
    }
    const after = pickFields(cand, visible);
    if (cleared > 0) after.exceptionsCleared = cleared;
    logEvent(req, "planner.event.update", row.id, {
      personal: base.layer === "personal" || cand.layer === "personal",
      fields: visible,
      before: pickFields(base, visible),
      after,
      extra: cleared > 0 ? { exceptionsCleared: cleared } : undefined,
    });
  })();
  return present(db, user, loadRow(db, row.id));
}

// Scope later at occurrence D after the first: split the series in one transaction (section 7.3).
function split(db, req, g, body) {
  const user = req.user;
  const row = g.row;
  const D = g.occurrence;
  const s = norm(row);
  const rowBase = baseOf(row);
  // The second half before the edits: the series from D, the same length, rule and end.
  const base = { ...rowBase, startDate: D, endDate: addDays(D, s.span - 1) };
  const cand = buildSeries(db, user, base, body);
  checkWriteRights(user, row.owner_id, base, cand);
  const changed = diff(base, cand).filter((k) => k !== "repeatDay" || !diff(base, cand).includes("startDate"));
  if (changed.length === 0) return present(db, user, row);
  const cut = addDays(D, -1);
  const newId = db.transaction(() => {
    const ts = nextStamp(row.updated_at);
    const info = db
      .prepare(
        `UPDATE planner_events SET repeat_until = ?, updated_at = ?, updated_by = ?
          WHERE id = ? AND updated_at = ? AND removed_at IS NULL`
      )
      .run(cut, ts, user.id, row.id, row.updated_at);
    if (info.changes !== 1) throw conflict(STALE, { event: present(db, user, loadRow(db, row.id) || row) });
    // The new series keeps the original's owner (section 17, point 9).
    const id2 = insertSeries(db, row.owner_id, user.id, cand, ts, row.id);
    logEvent(req, "planner.event.split", row.id, {
      personal: rowBase.layer === "personal" || cand.layer === "personal",
      fields: changed,
      before: { repeatUntil: rowBase.repeatUntil },
      after: { repeatUntil: cut, newEventId: id2, from: D, changed: pickFields(cand, changed) },
      extra: { newEventId: id2 },
    });
    return id2;
  })();
  return present(db, user, loadRow(db, newId));
}

function remove(db, req, id, { scope, occurrence, updatedAt } = {}) {
  const user = req.user;
  const g = guard(db, user, id, { scope, occurrence, updatedAt });
  const row = g.row;
  const personal = row.layer === "personal";
  db.transaction(() => {
    const ts = nextStamp(row.updated_at);
    if (g.scope === "one") {
      touch(db, user, row, ts);
      db.prepare(
        `INSERT INTO planner_exceptions (event_id, occurrence_date, cancelled, updated_at, updated_by)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(event_id, occurrence_date) DO UPDATE SET cancelled = 1,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ).run(row.id, g.occurrence, ts, user.id);
      logEvent(req, "planner.event.occurrence.delete", row.id, {
        personal,
        fields: ["cancelled"],
        after: { occurrence: g.occurrence },
      });
      return;
    }
    if (g.scope === "later") {
      const cut = addDays(g.occurrence, -1);
      const info = db
        .prepare(
          `UPDATE planner_events SET repeat_until = ?, updated_at = ?, updated_by = ?
            WHERE id = ? AND updated_at = ? AND removed_at IS NULL`
        )
        .run(cut, ts, user.id, row.id, row.updated_at);
      if (info.changes !== 1) throw conflict(STALE, { event: present(db, user, loadRow(db, row.id) || row) });
      logEvent(req, "planner.event.delete", row.id, {
        personal,
        fields: ["repeatUntil"],
        before: { repeatUntil: row.repeat_until || null },
        after: { scope: "later", from: g.occurrence },
        extra: { scope: "later" },
      });
      return;
    }
    const info = db
      .prepare(
        `UPDATE planner_events SET removed_at = ?, removed_by = ?, updated_at = ?, updated_by = ?
          WHERE id = ? AND updated_at = ? AND removed_at IS NULL`
      )
      .run(ts, user.id, ts, user.id, row.id, row.updated_at);
    if (info.changes !== 1) throw conflict(STALE, { event: present(db, user, loadRow(db, row.id) || row) });
    logEvent(req, "planner.event.delete", row.id, {
      personal,
      fields: [],
      after: { scope: "all" },
      extra: { scope: "all" },
    });
  })();
}

module.exports = {
  TITLE_MAX,
  NOTES_MAX,
  SPAN_MAX_DAYS,
  REMINDERS_TIMED,
  REMINDERS_ALL_DAY,
  REMINDER_LABELS,
  occurrenceDates,
  isOccurrence,
  expand,
  listOccurrences,
  listForJob,
  getSeries,
  create,
  update,
  remove,
  occurrencesForSweep,
};
