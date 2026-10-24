// Recurring tasks (0.2.0, docs/plans/m20-recurring-tasks.md). Admins keep the rules on Admin > Tasks
// (users.admin). Each rule is given to ONE person or ONE department and repeats on the Planner's
// choices. Each occurrence becomes a task on (due date - lead days), Sydney time:
//   - a person: a normal task in their Tasks list, and an alert;
//   - a department: one shared task (lib/team-tasks.js, dept_tasks) ticked once for all, and an
//     alert to each member (tasks.use plus the department's notes key).
// recurring_occurrences has UNIQUE (recurring_id, due_date), so an occurrence is made once however
// often the job runs (at boot, hourly, and after a save). Nothing is made for a due date before the
// day the rule was made (or resumed): no backfill. The Planner shows each occurrence on its due date,
// worked out here on read (plannerItems), so nothing is written to planner_events.
const audit = require("./audit");
const notify = require("./notify");
const people = require("./people");
const teamTasks = require("./team-tasks");
const events = require("./planner/events");
const { bad, notFound, conflict } = require("./httperror");
const { DATE_RE, parseDateUTC, formatDateUTC, addDays, sydneyToday } = require("./time");

const TITLE_MAX = 200;
const NOTES_MAX = 4000;
const LEAD_MAX = 60;
const EVERY_MAX = 99;
const REPEATS = ["weekly", "fortnightly", "monthly", "annually", "custom"];
const UNITS = ["day", "week", "month", "year"];
const DEPTS = {
  scheduling: { label: "Scheduling", layer: "scheduling" },
  design: { label: "Projects", layer: "design_pm" },
  ordering: { label: "Ordering", layer: "install" },
  accounts: { label: "Accounts", layer: "accounts" },
  admin: { label: "Admin", layer: "company" },
};
const SYSTEM_LABEL = "Recurring task (automatic)";
const SYSTEM_REQ = Object.freeze({ user: null, ip: null, actorLabel: SYSTEM_LABEL });
const PER_RULE_MAX = 400; // occurrences one run may make for one rule
const RUN_EVERY_MS = 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function nowIso() {
  return new Date().toISOString();
}
function nextStamp(prev) {
  const now = Date.now();
  const p = Date.parse(prev);
  return new Date(Number.isFinite(p) && p >= now ? p + 1 : now).toISOString();
}
function validDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = parseDateUTC(s);
  return !Number.isNaN(d.getTime()) && formatDateUTC(d) === s;
}
function dMon(date) {
  const [, m, d] = String(date).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}
function textField(label, v, { max, required = false }) {
  if (v === undefined || v === null) {
    if (required) throw bad(`${label} is required`);
    return "";
  }
  if (typeof v !== "string") throw bad(`${label} must be text`);
  const t = v.trim();
  if (required && !t) throw bad(`${label} is required`);
  if (t.length > max) throw bad(`${label} must be ${max} characters or fewer`);
  return t;
}

// "Every week", "Every 3 months", "Yearly"...
function repeatWords(r) {
  if (r.repeat === "weekly") return "Every week";
  if (r.repeat === "fortnightly") return "Every fortnight";
  if (r.repeat === "monthly") return "Every month";
  if (r.repeat === "annually") return "Every year";
  const n = Number(r.repeat_every);
  return n === 1 ? `Every ${r.repeat_unit}` : `Every ${n} ${r.repeat_unit}s`;
}

// The series shape lib/planner/events.js works out occurrences from (one day long).
function seriesOf(r) {
  return {
    startDate: r.start_date,
    endDate: r.start_date,
    repeat: r.repeat,
    repeatEvery: r.repeat === "custom" ? Number(r.repeat_every) : null,
    repeatUnit: r.repeat === "custom" ? r.repeat_unit : null,
    repeatUntil: r.end_date || null,
  };
}

// Due dates of a rule in [from, to], never before its start or the day it was made/resumed.
function dueDates(r, from, to) {
  const lo = [from, r.start_date, r.created_from].sort()[2];
  const hi = r.end_date && r.end_date < to ? r.end_date : to;
  if (hi < lo) return [];
  return events.occurrenceDates(seriesOf(r), lo, hi);
}

// The next due date on or after `day` (a live, active rule), or null.
function nextDue(r, day) {
  if (r.deleted_at || !Number(r.active)) return null;
  // Look ahead up to 3 years and a day (covers yearly and every-N-years up to 3).
  const dates = dueDates(r, day, addDays(day, 3 * 366));
  return dates.length ? dates[0] : null;
}

// --------------------------------------------------------------- validation ---

function parseAssignee(db, v) {
  const id = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(id) || id < 1) throw bad("Choose a person or a department");
  if (!people.withKey(db, "tasks.use").some((p) => Number(p.id) === id)) throw bad("That person can't be given tasks");
  return id;
}

// The whole rule from a body (POST) or the body over the existing row (PATCH).
function readRule(db, body, row) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("JSON body required");
  const given = (k) => body[k] !== undefined;
  const pick = (k, col) => (given(k) ? body[k] : row ? row[col] : undefined);
  const title = textField("Title", pick("title", "title"), { max: TITLE_MAX, required: true });
  const notes = textField("Note", pick("notes", "notes"), { max: NOTES_MAX });

  // Assignee: a person or a department, never both.
  let assigneeId = null;
  let dept = null;
  const aGiven = given("assigneeId") || given("dept");
  const aRaw = aGiven ? (body.assigneeId === undefined || body.assigneeId === "" ? null : body.assigneeId) : row ? row.assignee_id : null;
  const dRaw = aGiven ? (body.dept === undefined || body.dept === "" ? null : body.dept) : row ? row.dept : null;
  if (aRaw != null && dRaw != null) throw bad("Give the task to a person or to a department, not both");
  if (aRaw != null) assigneeId = parseAssignee(db, aRaw);
  else if (dRaw != null) {
    if (typeof dRaw !== "string" || !DEPTS[dRaw]) throw bad("Unknown department");
    dept = dRaw;
  } else throw bad("Choose a person or a department");

  const repeat = pick("repeat", "repeat");
  if (!REPEATS.includes(repeat)) throw bad("repeat must be weekly, fortnightly, monthly, annually or custom");
  let repeatEvery = null;
  let repeatUnit = null;
  if (repeat === "custom") {
    repeatEvery = pick("repeatEvery", "repeat_every");
    repeatUnit = pick("repeatUnit", "repeat_unit");
    if (!Number.isInteger(repeatEvery) || repeatEvery < 1 || repeatEvery > EVERY_MAX) throw bad("repeatEvery must be a whole number from 1 to 99");
    if (!UNITS.includes(repeatUnit)) throw bad("repeatUnit must be day, week, month or year");
  } else if ((given("repeatEvery") && body.repeatEvery !== null) || (given("repeatUnit") && body.repeatUnit !== null)) {
    throw bad("repeatEvery and repeatUnit only go with repeat custom");
  }

  const startDate = pick("startDate", "start_date");
  if (!validDate(startDate)) throw bad("Choose a start date (the first due date)");
  let endDate = pick("endDate", "end_date");
  if (endDate === "" || endDate === undefined) endDate = null;
  if (endDate !== null) {
    if (!validDate(endDate)) throw bad("endDate must be a date");
    if (endDate < startDate) throw bad("The end date can't be before the start date");
  }
  let leadDays = pick("leadDays", "lead_days");
  if (leadDays === undefined || leadDays === null || leadDays === "") leadDays = 0;
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > LEAD_MAX) throw bad("Show it 0 to 60 days before it is due");
  return { title, notes, assigneeId, dept, repeat, repeatEvery, repeatUnit, startDate, endDate, leadDays };
}

// -------------------------------------------------------------------- reads ---

const SELECT = `SELECT r.*, u.display_name AS assignee_name FROM recurring_tasks r
    LEFT JOIN users u ON u.id = r.assignee_id`;

function loadRow(db, id) {
  const row = db.prepare(`${SELECT} WHERE r.id = ? AND r.deleted_at IS NULL`).get(id);
  if (!row) throw notFound();
  return row;
}

function present(db, row, today) {
  const last = db
    .prepare("SELECT MAX(due_date) AS d, COUNT(*) AS n FROM recurring_occurrences WHERE recurring_id = ?")
    .get(row.id);
  const nd = nextDue(row, today);
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    assignee: row.assignee_id == null ? null : { id: row.assignee_id, name: row.assignee_name || "Unknown" },
    dept: row.dept || null,
    deptLabel: row.dept ? DEPTS[row.dept].label : null,
    repeat: row.repeat,
    repeatEvery: row.repeat_every == null ? null : Number(row.repeat_every),
    repeatUnit: row.repeat_unit || null,
    repeatText: repeatWords(row),
    startDate: row.start_date,
    endDate: row.end_date || null,
    leadDays: Number(row.lead_days),
    active: Number(row.active) === 1,
    nextDue: nd,
    nextShows: nd ? addDays(nd, -Number(row.lead_days)) : null,
    lastDue: last.d || null,
    made: Number(last.n) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function list(db) {
  const today = sydneyToday();
  const rules = db
    .prepare(`${SELECT} WHERE r.deleted_at IS NULL ORDER BY r.active DESC, r.title COLLATE NOCASE, r.id`)
    .all()
    .map((row) => present(db, row, today));
  return {
    today,
    rules,
    people: people.withKey(db, "tasks.use").map((p) => ({ id: p.id, name: p.displayName })),
    depts: Object.keys(DEPTS).map((id) => ({ id, label: DEPTS[id].label })),
  };
}

function get(db, id) {
  return present(db, loadRow(db, id), sydneyToday());
}

// ------------------------------------------------------------------- writes ---

function auditShape(c) {
  return {
    title: c.title,
    assigneeId: c.assigneeId,
    dept: c.dept,
    repeat: c.repeat,
    repeatEvery: c.repeatEvery,
    repeatUnit: c.repeatUnit,
    startDate: c.startDate,
    endDate: c.endDate,
    leadDays: c.leadDays,
  };
}

function create(db, req, body) {
  const c = readRule(db, body, null);
  const today = sydneyToday();
  const id = db.transaction(() => {
    const ts = nowIso();
    const info = db
      .prepare(
        `INSERT INTO recurring_tasks (title, notes, assignee_id, dept, repeat, repeat_every, repeat_unit, start_date,
           end_date, lead_days, active, created_from, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
      )
      .run(c.title, c.notes, c.assigneeId, c.dept, c.repeat, c.repeatEvery, c.repeatUnit, c.startDate, c.endDate,
        c.leadDays, today, req.user.id, req.user.id, ts, ts);
    const newId = Number(info.lastInsertRowid);
    audit.log(req, { action: "recurring_task.create", entityType: "recurring_task", entityId: newId, after: auditShape(c) });
    return newId;
  })();
  run(db, { ruleId: id });
  return get(db, id);
}

function staleCheck(db, row, body) {
  if (body && typeof body.updatedAt === "string" && body.updatedAt !== row.updated_at) {
    throw conflict("Someone else changed this recurring task. Reload to see it.", { rule: get(db, row.id) });
  }
}

function update(db, req, id, body) {
  const row = loadRow(db, id);
  staleCheck(db, row, body);
  const c = readRule(db, body, row);
  const before = auditShape({
    title: row.title, assigneeId: row.assignee_id, dept: row.dept, repeat: row.repeat, repeatEvery: row.repeat_every,
    repeatUnit: row.repeat_unit, startDate: row.start_date, endDate: row.end_date, leadDays: row.lead_days,
  });
  db.transaction(() => {
    db.prepare(
      `UPDATE recurring_tasks SET title = ?, notes = ?, assignee_id = ?, dept = ?, repeat = ?, repeat_every = ?,
         repeat_unit = ?, start_date = ?, end_date = ?, lead_days = ?, updated_by = ?, updated_at = ? WHERE id = ?`
    ).run(c.title, c.notes, c.assigneeId, c.dept, c.repeat, c.repeatEvery, c.repeatUnit, c.startDate, c.endDate,
      c.leadDays, req.user.id, nextStamp(row.updated_at), id);
    audit.log(req, { action: "recurring_task.update", entityType: "recurring_task", entityId: id, before, after: auditShape(c) });
  })();
  run(db, { ruleId: id });
  return get(db, id);
}

// Pause or resume. Resuming starts again from today: nothing is made for the paused days.
function setActive(db, req, id, active, body) {
  const row = loadRow(db, id);
  staleCheck(db, row, body);
  if ((Number(row.active) === 1) === active) return get(db, id);
  const today = sydneyToday();
  db.transaction(() => {
    if (active) {
      db.prepare("UPDATE recurring_tasks SET active = 1, created_from = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(today > row.created_from ? today : row.created_from, req.user.id, nextStamp(row.updated_at), id);
    } else {
      db.prepare("UPDATE recurring_tasks SET active = 0, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(req.user.id, nextStamp(row.updated_at), id);
    }
    audit.log(req, {
      action: active ? "recurring_task.resume" : "recurring_task.pause",
      entityType: "recurring_task",
      entityId: id,
      before: { active: !active },
      after: { active },
    });
  })();
  if (active) run(db, { ruleId: id });
  return get(db, id);
}

// Delete: no more occurrences; the tasks already made stay as they are.
function remove(db, req, id) {
  const row = loadRow(db, id);
  db.transaction(() => {
    db.prepare("UPDATE recurring_tasks SET deleted_at = ?, active = 0, updated_by = ?, updated_at = ? WHERE id = ?")
      .run(nowIso(), req.user.id, nextStamp(row.updated_at), id);
    audit.log(req, { action: "recurring_task.delete", entityType: "recurring_task", entityId: id, before: { title: row.title } });
  })();
}

// --------------------------------------------------------------- generation ---

// One occurrence: the task (person or department), the occurrence row, follows and the alert, all
// in one transaction. Returns the task id, or null when it was already made or can't be made.
function makeOccurrence(db, r, due) {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM recurring_occurrences WHERE recurring_id = ? AND due_date = ?").get(r.id, due)) return null;
    const when = `Due ${dMon(due)}.`;
    let taskId;
    if (r.assignee_id != null) {
      // A person who has left (disabled) or lost tasks.use gets nothing; the rule waits.
      if (!people.withKey(db, "tasks.use").some((p) => Number(p.id) === Number(r.assignee_id))) return null;
      const ts = nowIso();
      const creator = r.created_by != null ? r.created_by : r.assignee_id;
      const info = db
        .prepare(
          `INSERT INTO tasks (title, notes, assignee_id, created_by, job_id, due_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
        )
        .run(r.title, r.notes || "", r.assignee_id, creator, due, ts, ts);
      taskId = Number(info.lastInsertRowid);
      db.prepare("INSERT OR IGNORE INTO follows (user_id, entity_type, entity_id) VALUES (?, 'task', ?)").run(r.assignee_id, taskId);
      notify.toUser(db, r.assignee_id, {
        kind: "task.assigned",
        title: `Recurring task: ${r.title}`,
        body: when,
        link: `/tasks.html?task=${taskId}`,
        entityType: "task",
        entityId: taskId,
      });
    } else {
      taskId = teamTasks.insertDept(db, { team: r.dept, title: r.title, notes: r.notes, dueDate: due, createdLabel: SYSTEM_LABEL });
      const members = teamTasks.memberIds(db, r.dept);
      for (const m of members) db.prepare("INSERT OR IGNORE INTO follows (user_id, entity_type, entity_id) VALUES (?, 'task', ?)").run(m, taskId);
      notify.toUsers(db, members, {
        kind: "task.assigned",
        title: `Recurring task for the ${teamTasks.teamLabel(r.dept)}: ${r.title}`,
        body: when,
        link: `/tasks.html?task=${taskId}`,
        entityType: "task",
        entityId: taskId,
      });
    }
    db.prepare("INSERT INTO recurring_occurrences (recurring_id, due_date, task_id, created_at) VALUES (?, ?, ?, ?)").run(r.id, due, taskId, nowIso());
    audit.log(SYSTEM_REQ, {
      action: "task.create",
      entityType: "task",
      entityId: taskId,
      actorLabel: SYSTEM_LABEL,
      after: { title: r.title, recurringId: r.id, dueDate: due, assigneeId: r.assignee_id == null ? null : r.assignee_id, team: r.dept || null },
    });
    return taskId;
  })();
}

// Make every occurrence whose show day (due - lead) has come. opts.ruleId: just that rule.
// opts.today: run as of that Sydney date (the admin run route; never before the real today).
// Returns {date, made}.
function run(db, opts = {}) {
  const today = opts.today || sydneyToday();
  const rules = opts.ruleId
    ? db.prepare("SELECT * FROM recurring_tasks WHERE id = ? AND deleted_at IS NULL AND active = 1").all(opts.ruleId)
    : db.prepare("SELECT * FROM recurring_tasks WHERE deleted_at IS NULL AND active = 1 ORDER BY id").all();
  let made = 0;
  for (const r of rules) {
    const dates = dueDates(r, r.created_from, addDays(today, Number(r.lead_days))).slice(0, PER_RULE_MAX);
    for (const due of dates) if (makeOccurrence(db, r, due) != null) made++;
  }
  return { date: today, made };
}

let started = false;

// At boot and every hour. RECURRING_DISABLED=1 turns it off.
function start(db) {
  if (process.env.RECURRING_DISABLED === "1" || started) return;
  started = true;
  const tick = () => {
    try {
      const { made, date } = run(db);
      if (made) console.log(`[recurring] ${date}: ${made} task(s) made`);
    } catch (e) {
      console.error("[recurring] run failed:", e && e.message ? e.message : e);
    }
  };
  tick();
  const timer = setInterval(tick, RUN_EVERY_MS);
  timer.unref();
}

// ------------------------------------------------------------------ planner ---

// The Planner's items for recurring tasks in [from, to] (lib/planner/auto.js): each occurrence on
// its due date, all day. A person's on their own Personal layer (only they see it); a department's
// on its layer (Projects: Projects, Ordering: Install & hardware, Admin: Company-wide) for the
// department's members who see that layer. Made occurrences carry their task's state (done, or
// overdue in red); later ones are worked out from the rule while it is live and active.
function plannerItems(db, user, { from, to, today, layers, item }) {
  const out = [];
  if (!user) return out;
  const eff = new Set(layers);
  const rules = db.prepare("SELECT * FROM recurring_tasks").all();
  if (!rules.length) return out;
  const tasksUse = user.perms && (user.perms instanceof Set ? user.perms.has("tasks.use") : false);
  // Made occurrences sit on their task's due date (someone may have moved it); the rule's own
  // dates fill in the ones not made yet.
  const madeIn = db.prepare("SELECT due_date FROM recurring_occurrences WHERE recurring_id = ? AND due_date BETWEEN ? AND ?");
  const personOcc = db.prepare(
    `SELECT o.task_id, t.status, COALESCE(t.due_date, o.due_date) AS d FROM recurring_occurrences o
       JOIN tasks t ON t.id = o.task_id
      WHERE o.recurring_id = ? AND COALESCE(t.due_date, o.due_date) BETWEEN ? AND ?`
  );
  const deptOcc = db.prepare(
    `SELECT o.task_id, t.status, COALESCE(t.due_date, o.due_date) AS d FROM recurring_occurrences o
       JOIN dept_tasks t ON t.id = o.task_id
      WHERE o.recurring_id = ? AND COALESCE(t.due_date, o.due_date) BETWEEN ? AND ?`
  );
  for (const r of rules) {
    let layer;
    if (r.assignee_id != null) {
      if (Number(r.assignee_id) !== Number(user.id) || !eff.has("personal")) continue;
      layer = "personal";
    } else {
      layer = DEPTS[r.dept].layer;
      if (!eff.has(layer) || !teamTasks.isMember(user, r.dept)) continue;
    }
    const shown = [];
    for (const o of (r.assignee_id != null ? personOcc : deptOcc).all(r.id, from, to)) {
      if (o.status === "cancelled") continue;
      shown.push({ d: o.d, taskId: o.task_id, status: o.status });
    }
    if (!r.deleted_at && Number(r.active) === 1) {
      const made = new Set(madeIn.all(r.id, from, to).map((o) => o.due_date));
      for (const d of dueDates(r, from, to)) if (!made.has(d)) shown.push({ d, taskId: null, status: "planned" });
    }
    for (const o of shown) {
      out.push(item({
        id: `a:recurring:${r.id}:${o.taskId != null ? "t" + o.taskId : o.d}`,
        source: "recurring_task",
        sourceLabel: "Recurring task",
        layer,
        title: `${o.status === "done" ? "Done: " : ""}${r.title}`,
        start: o.d,
        link: o.taskId != null && tasksUse ? `/tasks.html?task=${o.taskId}` : null,
        overdue: o.status === "open" && o.d < today,
      }));
    }
  }
  return out;
}

module.exports = {
  DEPTS,
  SYSTEM_LABEL,
  list,
  get,
  create,
  update,
  setActive,
  remove,
  run,
  start,
  dueDates,
  plannerItems,
  layerOf: (dept) => (DEPTS[dept] ? DEPTS[dept].layer : null),
  validDate,
};
