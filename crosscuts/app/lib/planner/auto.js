// Automatic planner events, worked out on read from their source tables
// (docs/plans/m7-contracts.md section 8). Nothing is stored and the source modules have no hooks:
// each request runs one ranged, indexed query per source the viewer may see and shapes the rows
// here, so an item follows its source on the next load.
//
// Read-only queries of its own; never a source module's write path, never lib/schedule.js, never
// ../../db (db is the first argument). Which layers the viewer sees comes from layers.js only.
//
// Never selected, so never exposed: job values, client names, phones, emails, addresses,
// inspection hosts or notes, order suppliers or descriptions, leave kind or note, invoice amounts.
const layersLib = require("./layers");
const { sydneyToday, parseDateUTC, formatDateUTC, addDays, mondayOf } = require("../time");

const TITLE_MAX = 120; // job and task names inside a title (the full name stays in job.name)
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"];

// The live-job filter for the job-based sources (section 8).
const JOB_LIVE = "j.archived = 0 AND (j.stage IS NULL OR j.stage NOT IN ('lost','archived'))";

const SQL = {
  boardRows: `SELECT wr.id, wr.week_start, wr.panel, wr.sort_order, j.id AS job_id, j.name
      FROM week_rows wr JOIN jobs j ON j.id = wr.job_id
     WHERE wr.week_start >= ? AND wr.week_start <= ?
     ORDER BY wr.week_start, wr.panel, wr.sort_order, wr.id`,
  boardDays: `SELECT DISTINCT a.week_row_id, a.day
      FROM assignments a JOIN week_rows wr ON wr.id = a.week_row_id
     WHERE wr.panel = 'installing' AND wr.week_start >= ? AND wr.week_start <= ?`,
  promised: `SELECT j.id, j.name, j.promised_install_date AS d FROM jobs j
     WHERE j.promised_install_date BETWEEN ? AND ? AND ${JOB_LIVE}`,
  matOrdered: `SELECT j.id, j.name, j.materials_ordered_date AS d FROM jobs j
     WHERE j.materials_ordered_date BETWEEN ? AND ? AND ${JOB_LIVE}`,
  matDue: `SELECT o.job_id, j.name, o.expected_date AS d, COUNT(*) AS lines
      FROM orders o JOIN jobs j ON j.id = o.job_id
     WHERE o.status = 'ordered' AND o.expected_date BETWEEN ? AND ? AND ${JOB_LIVE}
     GROUP BY o.job_id, o.expected_date`,
  matIn: `SELECT j.id, j.name, j.materials_in_date AS d FROM jobs j
     WHERE j.materials_in_date BETWEEN ? AND ? AND ${JOB_LIVE}`,
  inspections: `SELECT i.id, i.job_id, j.name, i.date, i.time
      FROM inspections i JOIN jobs j ON j.id = i.job_id
     WHERE i.status IN ('booked','done') AND i.date BETWEEN ? AND ? AND j.archived = 0`,
  leave: `SELECT l.id, l.date_from, l.date_to, w.name
      FROM leave l JOIN workers w ON w.id = l.worker_id
     WHERE l.removed_at IS NULL AND l.date_to >= ? AND l.date_from <= ? AND w.archived = 0`,
  invoiceDue: `SELECT i.id, i.number, i.due_date, j.id AS job_id, j.name
      FROM invoices i JOIN jobs j ON j.id = i.job_id
     WHERE i.status = 'issued' AND i.due_date BETWEEN ? AND ?`,
  invoicesOverdue: "SELECT COUNT(*) AS n FROM invoices WHERE status = 'issued' AND due_date < ?",
  tasksDue: `SELECT id, title, due_date FROM tasks
     WHERE assignee_id = ? AND status = 'open' AND due_date BETWEEN ? AND ?`,
};

// Prepared statements, once per database handle.
const cache = new WeakMap();
function stmt(db, key) {
  let m = cache.get(db);
  if (!m) {
    m = new Map();
    cache.set(db, m);
  }
  let s = m.get(key);
  if (!s) {
    s = db.prepare(SQL[key]);
    m.set(key, s);
  }
  return s;
}

function has(user, key) {
  const perms = user && user.perms;
  if (perms instanceof Set) return perms.has(key);
  if (Array.isArray(perms)) return perms.includes(key);
  return false;
}

function cut(s) {
  const t = String(s == null ? "" : s);
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

// Weekday (Mon-Fri) runs inside [from, to] (inclusive): [{start, end}] in date order. A weekend
// ends a run; a range of only Saturday and Sunday gives nothing. Pure calendar maths.
function weekdayRuns(from, to) {
  const runs = [];
  if (!from || !to || to < from) return runs;
  let cur = null;
  const d = parseDateUTC(from);
  const end = parseDateUTC(to).getTime();
  while (d.getTime() <= end) {
    const dow = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
    const s = formatDateUTC(d);
    if (dow === 0 || dow === 6) {
      cur = null;
    } else if (cur) {
      cur.end = s;
    } else {
      cur = { start: s, end: s };
      runs.push(cur);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return runs;
}

// The date of a board day key ('mon'..'fri') in the week starting weekStart; null if unknown.
function boardDate(weekStart, day) {
  const i = DAY_KEYS.indexOf(day);
  return i < 0 ? null : addDays(weekStart, i);
}

function item(fields) {
  return {
    id: fields.id,
    source: fields.source,
    sourceLabel: fields.sourceLabel,
    eventId: null,
    occurrence: null,
    layer: fields.layer,
    title: fields.title,
    notes: "",
    allDay: fields.allDay !== false,
    start: fields.start,
    end: fields.end || fields.start,
    startTime: fields.startTime || null,
    endTime: null,
    repeat: "none",
    repeatUntil: null,
    changed: false,
    reminder: null,
    remindLayer: false,
    job: fields.job || null,
    link: fields.link || null,
    createdBy: null,
    updatedAt: null,
    overdue: !!fields.overdue,
    readOnly: true,
    canEdit: false,
  };
}

// Board weeks (Install & hardware): the band, one entry per Monday in [mondayOf(from), to] that has
// rows. Each job once per panel, in the first row's order; installing jobs carry the assigned days
// of that week that fall inside [from, to].
function boardWeeks(db, user, from, to) {
  const lo = mondayOf(from);
  const rows = stmt(db, "boardRows").all(lo, to);
  if (rows.length === 0) return [];
  const jobLink = has(user, "jobs.view");
  const boardLink = has(user, "board.view");
  const linkFor = (jobId) => (jobLink ? `/job.html?id=${jobId}` : boardLink ? "/schedule.html" : null);

  // week_row_id -> Set of dates with someone assigned (installing rows only).
  const daysByRow = new Map();
  const rowWeek = new Map(rows.map((r) => [Number(r.id), r.week_start]));
  for (const a of stmt(db, "boardDays").all(lo, to)) {
    const rowId = Number(a.week_row_id);
    const ws = rowWeek.get(rowId);
    if (!ws) continue;
    const date = boardDate(ws, a.day);
    if (!date || date < from || date > to) continue;
    if (!daysByRow.has(rowId)) daysByRow.set(rowId, new Set());
    daysByRow.get(rowId).add(date);
  }

  const weeks = new Map(); // weekStart -> {weekStart, manufacturing, installing, seen}
  for (const r of rows) {
    let w = weeks.get(r.week_start);
    if (!w) {
      w = { weekStart: r.week_start, manufacturing: [], installing: [], seen: { manufacturing: new Map(), installing: new Map() } };
      weeks.set(r.week_start, w);
    }
    const panel = r.panel === "installing" ? "installing" : r.panel === "manufacturing" ? "manufacturing" : null;
    if (!panel) continue;
    const jobId = Number(r.job_id);
    let entry = w.seen[panel].get(jobId);
    if (!entry) {
      entry = { jobId, name: r.name, link: linkFor(jobId) };
      if (panel === "installing") entry.days = new Set();
      w.seen[panel].set(jobId, entry);
      w[panel].push(entry);
    }
    if (panel === "installing") {
      const ds = daysByRow.get(Number(r.id));
      if (ds) for (const d of ds) entry.days.add(d);
    }
  }
  return [...weeks.values()]
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0))
    .map((w) => ({
      weekStart: w.weekStart,
      manufacturing: w.manufacturing,
      installing: w.installing.map((e) => ({ jobId: e.jobId, name: e.name, link: e.link, days: [...e.days].sort() })),
    }));
}

// The job-dated sources on Install & hardware.
function installEvents(db, user, from, to, out) {
  const jobs = has(user, "jobs.view");
  const job = (id, name) => ({ id: Number(id), name });

  for (const r of stmt(db, "promised").all(from, to)) {
    out.push(item({
      id: `a:promised_install:${r.id}`, source: "promised_install", sourceLabel: "Job", layer: "install",
      title: `Promised install: ${cut(r.name)}`, start: r.d,
      job: job(r.id, r.name), link: jobs ? `/job.html?id=${r.id}` : null,
    }));
  }
  for (const r of stmt(db, "matOrdered").all(from, to)) {
    out.push(item({
      id: `a:materials_ordered:${r.id}`, source: "materials_ordered", sourceLabel: "Orders", layer: "install",
      title: `Materials ordered: ${cut(r.name)}`, start: r.d,
      job: job(r.id, r.name), link: jobs ? `/job.html?id=${r.id}#orders` : null,
    }));
  }
  for (const r of stmt(db, "matDue").all(from, to)) {
    const n = Number(r.lines);
    out.push(item({
      id: `a:materials_due:${r.job_id}:${r.d}`, source: "materials_due", sourceLabel: "Orders", layer: "install",
      title: `Materials due: ${cut(r.name)} (${n} ${n === 1 ? "line" : "lines"})`, start: r.d,
      job: job(r.job_id, r.name), link: jobs ? `/job.html?id=${r.job_id}#orders` : null,
    }));
  }
  for (const r of stmt(db, "matIn").all(from, to)) {
    out.push(item({
      id: `a:materials_in:${r.id}`, source: "materials_in", sourceLabel: "Orders", layer: "install",
      title: `Materials in: ${cut(r.name)}`, start: r.d,
      job: job(r.id, r.name), link: jobs ? `/job.html?id=${r.id}#orders` : null,
    }));
  }
  for (const r of stmt(db, "inspections").all(from, to)) {
    const time = typeof r.time === "string" && r.time ? r.time : null;
    out.push(item({
      id: `a:inspection:${r.id}`, source: "inspection", sourceLabel: "Inspection", layer: "install",
      title: `Inspection: ${cut(r.name)}`, start: r.date, allDay: !time, startTime: time,
      job: job(r.job_id, r.name), link: jobs ? `/job.html?id=${r.job_id}#inspection` : null,
    }));
  }
}

// Who's away (Company-wide): one item per run of weekdays inside both the leave and the range.
// Board workers only (leave is per board worker), archived workers left out, never kind or note.
function leaveEvents(db, user, from, to, out) {
  const link = has(user, "users.admin") ? "/availability.html" : null;
  for (const r of stmt(db, "leave").all(from, to)) {
    const lo = r.date_from > from ? r.date_from : from;
    const hi = r.date_to < to ? r.date_to : to;
    for (const run of weekdayRuns(lo, hi)) {
      out.push(item({
        id: `a:leave:${r.id}:${run.start}`, source: "leave", sourceLabel: "Availability", layer: "company",
        title: `${cut(r.name)} away`, start: run.start, end: run.end, link,
      }));
    }
  }
}

// Invoices (Accounts): each issued invoice due in range, and on today one "N invoices overdue".
function accountsEvents(db, user, from, to, today, out) {
  const accounts = has(user, "accounts.view");
  for (const r of stmt(db, "invoiceDue").all(from, to)) {
    out.push(item({
      id: `a:invoice_due:${r.id}`, source: "invoice_due", sourceLabel: "Accounts", layer: "accounts",
      title: `${r.number || "Invoice"} due: ${cut(r.name)}`, start: r.due_date,
      job: { id: Number(r.job_id), name: r.name },
      link: accounts ? `/accounts.html?invoice=${r.id}` : null,
      overdue: r.due_date < today,
    }));
  }
  if (from <= today && today <= to) {
    const n = Number(stmt(db, "invoicesOverdue").get(today).n) || 0;
    if (n > 0) {
      out.push(item({
        id: `a:invoices_overdue:${today}`, source: "invoices_overdue", sourceLabel: "Accounts", layer: "accounts",
        title: `${n} ${n === 1 ? "invoice" : "invoices"} overdue`, start: today,
        link: accounts ? "/accounts.html?view=overdue" : null, overdue: true,
      }));
    }
  }
}

// Task due dates (the viewer's own Personal layer): open tasks assigned to the viewer.
function taskEvents(db, user, from, to, out) {
  const tasks = has(user, "tasks.use");
  for (const r of stmt(db, "tasksDue").all(user.id, from, to)) {
    out.push(item({
      id: `a:task_due:${r.id}`, source: "task_due", sourceLabel: "Tasks", layer: "personal",
      title: `Task due: ${cut(r.title)}`, start: r.due_date,
      link: tasks ? `/tasks.html?task=${r.id}` : null,
    }));
  }
}

// layers: the effective layer set (visible ∩ requested). today: Sydney date.
// Returns {events: [automatic item §9.2], weeks: [week band §9.2]} (unsorted; the router sorts).
// The layer set is narrowed by the viewer's visible layers again here, so a caller can't widen it.
function listAuto(db, user, { from, to, today, layers } = {}) {
  const events = [];
  let weeks = [];
  if (!user || !from || !to || to < from) return { events, weeks };
  const day = today || sydneyToday();
  const wanted = Array.isArray(layers) ? layers : null;
  const eff = new Set(layersLib.visibleLayers(user).filter((id) => !wanted || wanted.includes(id)));

  if (eff.has("install")) {
    weeks = boardWeeks(db, user, from, to);
    installEvents(db, user, from, to, events);
  }
  if (eff.has("company")) leaveEvents(db, user, from, to, events);
  if (eff.has("accounts")) accountsEvents(db, user, from, to, day, events);
  if (eff.has("personal")) taskEvents(db, user, from, to, events);
  return { events, weeks };
}

module.exports = { listAuto, weekdayRuns };
