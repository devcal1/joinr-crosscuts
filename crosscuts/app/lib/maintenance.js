// Workshop > Maintenance (0.2.6, docs/plans/m27-contracts.md section 4). The workshop manager keeps
// the maintenance schedule: each item is a recurring task of kind 'maintenance' given to the Workshop
// department (lib/recurring.js makes the occurrences as Workshop department tasks, alerts the
// workshop manager(s) and shows them on the Workshop Planner layer). Only maintenance.manage holders
// confirm an occurrence actioned (with an optional note); lib/tasks.js refuses the Tasks page's Done
// and Reopen on one to anyone else. An occurrence 7 or more days overdue bells admin once a week.
//
// Every function takes db first; nothing here requires ../db.
const audit = require("./audit");
const notify = require("./notify");
const recurring = require("./recurring");
const { HttpError, bad, notFound, conflict, can } = require("./httperror");
const { sydneyToday, addDays } = require("./time");

const KIND = { kind: "maintenance" };
const NOTE_MAX = 1000;
const OVERDUE_DAYS = 7;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const nowIso = () => new Date().toISOString();

function dMon(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// The body with the Workshop department forced (a maintenance item never goes to a person).
function asWorkshop(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("JSON body required");
  const b = { ...body };
  delete b.assigneeId;
  b.dept = "workshop";
  return b;
}

const OCC_SQL = `SELECT o.id AS occ_id, o.recurring_id, o.due_date AS occ_due, o.task_id, o.note, o.overdue_belled_on,
       t.status, t.due_date, t.done_at, t.done_by, u.display_name AS done_by_name
  FROM recurring_occurrences o
  JOIN dept_tasks t ON t.id = o.task_id
  LEFT JOIN users u ON u.id = t.done_by`;

function occurrence(row, today) {
  const due = row.due_date || row.occ_due;
  const open = row.status === "open";
  return {
    taskId: row.task_id,
    dueDate: due,
    status: row.status,
    overdue: open && due < today,
    daysOverdue: open && due < today ? daysBetween(due, today) : 0,
    done: row.status === "done" ? { at: row.done_at, by: { id: row.done_by, name: row.done_by_name || "Unknown" }, note: row.note || "" } : null,
  };
}

// One item as the page shows it: the rule (lib/recurring's shape), the open occurrences (oldest
// first) and the last one done.
function present(db, rule, today) {
  const occ = db.prepare(`${OCC_SQL} WHERE o.recurring_id = ? ORDER BY COALESCE(t.due_date, o.due_date), o.id`).all(rule.id).map((r) => occurrence(r, today));
  const open = occ.filter((o) => o.status === "open");
  const done = occ.filter((o) => o.status === "done").sort((a, b) => (a.done.at < b.done.at ? 1 : -1));
  return {
    ...rule,
    open,
    lastDone: done.length ? { dueDate: done[0].dueDate, ...done[0].done } : null,
    overdue: open.some((o) => o.overdue),
  };
}

function list(db) {
  const today = sydneyToday();
  const base = recurring.list(db, KIND);
  return { today, items: base.rules.map((r) => present(db, r, today)) };
}

function get(db, id) {
  return present(db, recurring.get(db, id, KIND), sydneyToday());
}

function create(db, req, body) {
  const r = recurring.create(db, req, asWorkshop(body), KIND);
  return get(db, r.id);
}

function update(db, req, id, body) {
  recurring.update(db, req, id, asWorkshop(body), KIND);
  return get(db, id);
}

function setActive(db, req, id, active, body) {
  recurring.setActive(db, req, id, active, body, KIND);
  return get(db, id);
}

function remove(db, req, id) {
  recurring.remove(db, req, id, KIND);
}

// The maintenance occurrence behind a task id, or null.
function occurrenceOf(db, taskId) {
  return (
    db
      .prepare(
        `SELECT o.*, r.title FROM recurring_occurrences o JOIN recurring_tasks r ON r.id = o.recurring_id
          WHERE o.task_id = ? AND r.kind = 'maintenance'`
      )
      .get(taskId) || null
  );
}

// lib/tasks.js: the Tasks page's Done and Reopen on a maintenance occurrence need maintenance.manage.
function guardTaskStatus(db, req, taskId, action) {
  if (action === "cancel") return;
  if (occurrenceOf(db, taskId) && !can(req, "maintenance.manage")) {
    throw new HttpError(403, "Only the workshop manager confirms maintenance actioned");
  }
}

// POST /api/maintenance/occurrences/:taskId/done {note?}: Confirm actioned.
function confirm(db, req, taskId, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  let note = "";
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string") throw bad("note must be text");
    note = b.note.trim();
    if (note.length > NOTE_MAX) throw bad(`A note is ${NOTE_MAX} characters at most`);
  }
  db.transaction(() => {
    const occ = occurrenceOf(db, taskId);
    if (!occ) throw notFound();
    const t = db.prepare("SELECT * FROM dept_tasks WHERE id = ?").get(taskId);
    if (!t) throw notFound();
    if (t.status !== "open") throw conflict("This maintenance is already confirmed actioned");
    const at = nowIso();
    db.prepare("UPDATE dept_tasks SET status = 'done', done_at = ?, done_by = ?, updated_at = ? WHERE id = ?").run(at, req.user.id, at, taskId);
    db.prepare("UPDATE recurring_occurrences SET note = ? WHERE id = ?").run(note, occ.id);
    audit.log(req, {
      action: "maintenance.done",
      entityType: "task",
      entityId: taskId,
      before: { status: "open" },
      after: { status: "done", recurringId: occ.recurring_id, dueDate: t.due_date || occ.due_date, note },
    });
  })();
  return get(db, occurrenceOf(db, taskId).recurring_id);
}

// Undo a confirm (a mistake): back to open, note cleared.
function reopen(db, req, taskId) {
  db.transaction(() => {
    const occ = occurrenceOf(db, taskId);
    if (!occ) throw notFound();
    const t = db.prepare("SELECT * FROM dept_tasks WHERE id = ?").get(taskId);
    if (!t || t.status !== "done") throw conflict("This maintenance isn't confirmed");
    db.prepare("UPDATE dept_tasks SET status = 'open', done_at = NULL, done_by = NULL, updated_at = ? WHERE id = ?").run(nowIso(), taskId);
    db.prepare("UPDATE recurring_occurrences SET note = '' WHERE id = ?").run(occ.id);
    audit.log(req, {
      action: "maintenance.reopen",
      entityType: "task",
      entityId: taskId,
      before: { status: "done", note: occ.note },
      after: { status: "open" },
    });
  })();
  return get(db, occurrenceOf(db, taskId).recurring_id);
}

// Open maintenance occurrences due by `today` ({due, overdue} counts) for the dashboard.
function dueCounts(db, today = sydneyToday()) {
  const rows = db
    .prepare(
      `SELECT COALESCE(t.due_date, o.due_date) AS d FROM recurring_occurrences o
         JOIN recurring_tasks r ON r.id = o.recurring_id
         JOIN dept_tasks t ON t.id = o.task_id
        WHERE r.kind = 'maintenance' AND t.status = 'open'`
    )
    .all();
  return {
    due: rows.filter((r) => r.d === today).length,
    overdue: rows.filter((r) => r.d < today).length,
  };
}

// An occurrence 7 or more days overdue bells users.admin holders, then again a week later while it
// stays open. Returns how many occurrences belled.
function overdueSweep(db, today = sydneyToday()) {
  const cutoff = addDays(today, -OVERDUE_DAYS);
  const rows = db
    .prepare(
      `SELECT o.id, o.recurring_id, o.overdue_belled_on, COALESCE(t.due_date, o.due_date) AS d, r.title, t.id AS task_id
         FROM recurring_occurrences o
         JOIN recurring_tasks r ON r.id = o.recurring_id
         JOIN dept_tasks t ON t.id = o.task_id
        WHERE r.kind = 'maintenance' AND t.status = 'open'
          AND COALESCE(t.due_date, o.due_date) <= ?
          AND (o.overdue_belled_on IS NULL OR o.overdue_belled_on <= ?)`
    )
    .all(cutoff, cutoff);
  let n = 0;
  for (const r of rows) {
    db.transaction(() => {
      notify.toKey(db, "users.admin", {
        kind: "maintenance.overdue",
        title: `Maintenance overdue: ${r.title}`,
        body: `Due ${dMon(r.d)}, ${daysBetween(r.d, today)} days ago, and not yet confirmed actioned.`,
        link: "/maintenance.html",
        entityType: "task",
        entityId: r.task_id,
      });
      db.prepare("UPDATE recurring_occurrences SET overdue_belled_on = ? WHERE id = ?").run(today, r.id);
    })();
    n++;
  }
  return n;
}

module.exports = { list, get, create, update, setActive, remove, confirm, reopen, guardTaskStatus, occurrenceOf, dueCounts, overdueSweep };
