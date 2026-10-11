// Schedule helpers shared by the schedule routes (moved verbatim from the old
// server.js; date helpers now live in lib/time.js).
const db = require("../db");
const { weekLabel } = require("./time");
const production = require("./production");
const availability = require("./availability");

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"];

// Kept in sync by hand with hueColors() in public/shared.js — this copy is
// authoritative (board chips + JPG export), the client copy only drives the
// workers-page hue-slider preview.
function hueColors(hue) {
  return {
    bg: `oklch(30% 0.06 ${hue})`,
    fg: `oklch(86% 0.10 ${hue})`,
  };
}
function rowToWorker(row) {
  const { bg, fg } = hueColors(row.hue);
  return {
    id: row.id,
    name: row.name,
    hue: row.hue,
    bg,
    fg,
    archived: !!row.archived,
    sortOrder: row.sort_order,
    // M5: part-time pattern (m5-contracts.md section 2).
    daysPerWeek: row.days_per_week == null ? null : Number(row.days_per_week),
    regularDaysOff: availability.parseDaysOff(row.regular_days_off),
  };
}
function rowToJob(row) {
  return { id: row.id, name: row.name, notes: row.notes, archived: !!row.archived };
}

// Prepared once at module load — better-sqlite3 statements are reusable, and
// these run on every board fetch (which the frontend does after each edit).
const selectWeekRow = db.prepare("SELECT * FROM week_rows WHERE id = ?");
// M5 adds the job fields the row indicators need (materials, stage options) and the week.
const ROW_JOB_FIELDS = "wr.week_start, j.materials_in_date, j.materials_ordered_date, j.is_two_pac, j.benchtop";
const selectRowWithJob = db.prepare(
  `SELECT wr.id, wr.job_id, wr.sort_order, j.name AS job_name, j.notes, ${ROW_JOB_FIELDS}
   FROM week_rows wr JOIN jobs j ON j.id = wr.job_id WHERE wr.id = ?`
);
const selectRowAssignments = db.prepare(
  `SELECT a.id AS assignment_id, a.day, w.id AS worker_id, w.name, w.hue
   FROM assignments a JOIN workers w ON w.id = a.worker_id
   WHERE a.week_row_id = ? ORDER BY a.id ASC`
);
const selectRowFlags = db.prepare("SELECT day FROM day_flags WHERE week_row_id = ?");
const selectPanelRows = db.prepare(
  `SELECT wr.id, wr.job_id, wr.sort_order, j.name AS job_name, j.notes, ${ROW_JOB_FIELDS}
   FROM week_rows wr JOIN jobs j ON j.id = wr.job_id
   WHERE wr.week_start = ? AND wr.panel = ?
   ORDER BY wr.sort_order ASC, wr.id ASC`
);
const selectPanelAssignments = db.prepare(
  `SELECT a.week_row_id, a.id AS assignment_id, a.day, w.id AS worker_id, w.name, w.hue
   FROM assignments a
   JOIN workers w ON w.id = a.worker_id
   JOIN week_rows wr ON wr.id = a.week_row_id
   WHERE wr.week_start = ? AND wr.panel = ?
   ORDER BY a.id ASC`
);
const selectPanelFlags = db.prepare(
  `SELECT df.week_row_id, df.day
   FROM day_flags df JOIN week_rows wr ON wr.id = df.week_row_id
   WHERE wr.week_start = ? AND wr.panel = ?`
);

// M5: the week-level facts every row and chip of a week needs (one query each).
function weekContext(weekStart, jobIds) {
  return {
    away: availability.awayForWeek(db, weekStart),
    over: availability.overDaysForWeek(db, weekStart),
    overDays: availability.overDayKeysForWeek(db, weekStart),
    stages: production.currentStages(db, jobIds),
  };
}

function materialsOf(weekRow) {
  if (weekRow.materials_in_date) return "in";
  if (weekRow.materials_ordered_date) return "ordered";
  return null;
}

// assignments/flagRows/ctx are optional pre-fetched groups (see buildWeekPanel);
// single-row callers omit them and this falls back to per-row lookups.
function buildScheduleRow(weekRow, assignments, flagRows, ctx) {
  const c = ctx || weekContext(weekRow.week_start, [weekRow.job_id]);
  const cells = {};
  for (const key of DAY_KEYS) cells[key] = [];
  for (const a of assignments ?? selectRowAssignments.all(weekRow.id)) {
    const { bg, fg } = hueColors(a.hue);
    const awayDays = c.away.get(Number(a.worker_id));
    cells[a.day].push({
      assignmentId: a.assignment_id,
      workerId: a.worker_id,
      name: a.name,
      bg,
      fg,
      away: awayDays ? awayDays[a.day] : null,
      // Only the day(s) beyond their pattern (Todd, 2026-10-11).
      overDays: !!(c.overDays.get(Number(a.worker_id)) && c.overDays.get(Number(a.worker_id)).has(a.day)),
    });
  }
  const flags = {};
  for (const key of DAY_KEYS) flags[key] = false;
  for (const f of flagRows ?? selectRowFlags.all(weekRow.id)) flags[f.day] = true;
  return {
    rowId: weekRow.id,
    jobId: weekRow.job_id,
    jobName: weekRow.job_name,
    notes: weekRow.notes,
    cells,
    flags,
    materials: materialsOf(weekRow),
    productionStage: c.stages.get(Number(weekRow.job_id)) || null,
    stageOptions: production.stagesFor(weekRow),
  };
}

function buildWeekPanel(weekStart, panel, ctx) {
  const weekRows = selectPanelRows.all(weekStart, panel);
  // One query per panel for assignments and one for flags (instead of two per
  // row), grouped by row id here. ORDER BY a.id ASC is preserved per group.
  const assignmentsByRow = new Map();
  for (const a of selectPanelAssignments.all(weekStart, panel)) {
    if (!assignmentsByRow.has(a.week_row_id)) assignmentsByRow.set(a.week_row_id, []);
    assignmentsByRow.get(a.week_row_id).push(a);
  }
  const flagsByRow = new Map();
  for (const f of selectPanelFlags.all(weekStart, panel)) {
    if (!flagsByRow.has(f.week_row_id)) flagsByRow.set(f.week_row_id, []);
    flagsByRow.get(f.week_row_id).push(f);
  }
  return weekRows.map((wr) =>
    buildScheduleRow(wr, assignmentsByRow.get(wr.id) || [], flagsByRow.get(wr.id) || [], ctx)
  );
}

const selectWeekJobIds = db.prepare("SELECT DISTINCT job_id FROM week_rows WHERE week_start = ?");

function buildWeek(weekStart) {
  const ctx = weekContext(weekStart, selectWeekJobIds.all(weekStart).map((r) => r.job_id));
  const away = {};
  for (const [workerId, days] of ctx.away) away[String(workerId)] = days;
  return {
    start: weekStart,
    label: weekLabel(weekStart),
    manufacturing: buildWeekPanel(weekStart, "manufacturing", ctx),
    installing: buildWeekPanel(weekStart, "installing", ctx),
    // M5: who is away which day, and who is over their days this week (m5-contracts.md section 2).
    away,
    overDays: [...ctx.over].sort((a, b) => a - b),
  };
}

function getWeekRowOr404(id, res) {
  const row = selectWeekRow.get(id);
  if (!row) {
    res.status(404).json({ error: "Row not found" });
    return null;
  }
  return row;
}

const selectBacklog = db.prepare(
  `SELECT b.id, b.job_id, j.name, j.notes
   FROM backlog b JOIN jobs j ON j.id = b.job_id
   ORDER BY b.sort_order ASC, b.id ASC`
);

module.exports = {
  DAY_KEYS,
  hueColors,
  rowToWorker,
  rowToJob,
  selectRowWithJob,
  selectBacklog,
  buildScheduleRow,
  buildWeek,
  getWeekRowOr404,
};
