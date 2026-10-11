// Leave and availability (brief §5.3.4; m5-contracts.md section 2). Whole days, Monday to
// Friday. Scaffold (M5 · 2.2): the reads used by the board are complete and frozen; Wave 1 B
// fills in the writes (signatures binding).
const { addDays } = require("./time");
const { HttpError } = require("./httperror");

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"];

const notBuilt = () => {
  throw new HttpError(501, "Not built");
};

// 'fri' / 'mon,fri' -> ['mon','fri'] (known keys only, in week order).
function parseDaysOff(text) {
  const set = new Set(String(text || "").split(",").map((s) => s.trim().toLowerCase()));
  return DAY_KEYS.filter((d) => set.has(d));
}

// Map workerId -> {mon..fri: 'leave'|'sick'|'other'|'off'|null} for workers with at least one
// away day in the week starting on the Monday weekStart. Leave beats a regular day off.
function awayForWeek(db, weekStart) {
  const dates = DAY_KEYS.map((_, i) => addDays(weekStart, i));
  const out = new Map();
  const slot = (workerId) => {
    const id = Number(workerId);
    if (!out.has(id)) out.set(id, { mon: null, tue: null, wed: null, thu: null, fri: null });
    return out.get(id);
  };
  for (const w of db
    .prepare("SELECT id, regular_days_off FROM workers WHERE regular_days_off IS NOT NULL AND regular_days_off <> ''")
    .all()) {
    for (const d of parseDaysOff(w.regular_days_off)) slot(w.id)[d] = "off";
  }
  const leave = db
    .prepare(
      `SELECT worker_id, date_from, date_to, kind FROM leave
        WHERE removed_at IS NULL AND date_from <= ? AND date_to >= ?
        ORDER BY id`
    )
    .all(dates[4], dates[0]);
  for (const l of leave) {
    DAY_KEYS.forEach((d, i) => {
      if (l.date_from <= dates[i] && l.date_to >= dates[i]) slot(l.worker_id)[d] = l.kind;
    });
  }
  return out;
}

// Map workerId -> days_per_week, for workers that have one.
function daysPerWeek(db) {
  const out = new Map();
  for (const w of db.prepare("SELECT id, days_per_week FROM workers WHERE days_per_week IS NOT NULL").all()) {
    out.set(Number(w.id), Number(w.days_per_week));
  }
  return out;
}

// Worker ids assigned on more distinct days that week (both panels) than their days_per_week.
function overDaysForWeek(db, weekStart) {
  const limits = daysPerWeek(db);
  const out = new Set();
  if (!limits.size) return out;
  const rows = db
    .prepare(
      `SELECT a.worker_id, COUNT(DISTINCT a.day) AS n
         FROM assignments a JOIN week_rows wr ON wr.id = a.week_row_id
        WHERE wr.week_start = ?
        GROUP BY a.worker_id`
    )
    .all(weekStart);
  for (const r of rows) {
    const limit = limits.get(Number(r.worker_id));
    if (limit != null && Number(r.n) > limit) out.add(Number(r.worker_id));
  }
  return out;
}

function listWorkers(db) { notBuilt(); }
function listLeave(db, opts) { notBuilt(); }
function addLeave(db, req, body) { notBuilt(); }
function removeLeave(db, req, id) { notBuilt(); }
function setPattern(db, req, workerId, body) { notBuilt(); }

module.exports = {
  DAY_KEYS,
  parseDaysOff,
  awayForWeek,
  daysPerWeek,
  overDaysForWeek,
  listWorkers,
  listLeave,
  addLeave,
  removeLeave,
  setPattern,
};
