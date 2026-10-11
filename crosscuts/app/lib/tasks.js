// Tasks: the shared queue (Todd <-> accounts, and tasks on jobs) and the weekday
// morning reminder. See docs/plans/m4-contracts.md sections 2 and 4.
// countsFor (the menu bar count) was built in the scaffold and is frozen.
//
// Every user with tasks.use sees every task (plan decision 1). Editing is for the
// creator, the assignee or an admin, with a stale-edit check on updated_at.
const audit = require("./audit");
const files = require("./files");
const notify = require("./notify");
const people = require("./people");
const settings = require("./settings");
const { bad, notFound, forbidden, conflict } = require("./httperror");
const { DATE_RE, parseDateUTC, formatDateUTC, sydneyParts, sydneyToday } = require("./time");

const TITLE_MAX = 200;
const NOTES_MAX = 10000;
const VIEWS = ["mine", "raised", "open", "done", "job"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const REMINDER_CHECK_MS = 60 * 1000;
const REMINDER_HOUR = 7; // Sydney, weekdays (Todd, M4 decision 4)
const REMINDER_TITLES = 5;

// {open, overdue}: the user's assigned open tasks, and those due before `today`.
function countsFor(db, userId, today) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS open,
              COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END), 0) AS overdue
         FROM tasks WHERE assignee_id = ? AND status = 'open'`
    )
    .get(today, userId);
  return { open: Number(row.open) || 0, overdue: Number(row.overdue) || 0 };
}

// ---------------------------------------------------------------- helpers ---

function nowIso() {
  return new Date().toISOString();
}

function isAdmin(user) {
  return !!(user && Array.isArray(user.roles) && user.roles.includes("admin"));
}

// "2026-10-14" -> "14 Oct". Pure string work: no timezone involved.
function dMon(date) {
  const [, m, d] = String(date).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

function validDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = parseDateUTC(s);
  return !Number.isNaN(d.getTime()) && formatDateUTC(d) === s; // rejects 2026-02-31
}

function parseId(v) {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function textField(label, v, { max, required = false }) {
  if (v === undefined || v === null) {
    if (required) throw bad(`${label} is required`);
    return "";
  }
  if (typeof v !== "string") throw bad(`${label} must be a string`);
  const t = v.trim();
  if (required && !t) throw bad(`${label} is required`);
  if (t.length > max) throw bad(`${label} must be ${max.toLocaleString("en-AU")} characters or fewer`);
  return t;
}

function parseDue(v) {
  if (v === undefined || v === null || v === "") return null;
  if (!validDate(v)) throw bad("dueDate must be a valid YYYY-MM-DD date");
  return v;
}

function parseAssignee(db, v) {
  const id = parseId(v);
  if (!id) throw bad("assigneeId is required");
  if (!people.withKey(db, "tasks.use").some((p) => Number(p.id) === id)) {
    throw bad("That person can't be given tasks");
  }
  return id;
}

function parseJob(db, v) {
  if (v === undefined || v === null || v === "") return null;
  const id = parseId(v);
  if (!id) throw bad("jobId must be a job id");
  if (!db.prepare("SELECT id FROM jobs WHERE id = ?").get(id)) throw bad("That job doesn't exist");
  return id;
}

const SELECT = `SELECT t.*, a.display_name AS assignee_name, c.display_name AS creator_name,
         d.display_name AS done_by_name, j.name AS job_name
    FROM tasks t
    JOIN users a ON a.id = t.assignee_id
    JOIN users c ON c.id = t.created_by
    LEFT JOIN users d ON d.id = t.done_by
    LEFT JOIN jobs j ON j.id = t.job_id`;

function loadRow(db, id) {
  const row = db.prepare(`${SELECT} WHERE t.id = ?`).get(id);
  if (!row) throw notFound();
  return row;
}

function canEditRow(user, row) {
  return isAdmin(user) || Number(row.created_by) === Number(user.id) || Number(row.assignee_id) === Number(user.id);
}

function filesOf(db, taskId) {
  return db
    .prepare(
      `SELECT f.*, u.display_name AS uploaded_by_name
         FROM task_files tf
         JOIN files f ON f.id = tf.file_id
         LEFT JOIN users u ON u.id = f.uploaded_by
        WHERE tf.task_id = ? AND f.removed_at IS NULL
        ORDER BY f.id`
    )
    .all(taskId)
    .map(files.toFile);
}

function present(db, user, row, today) {
  const comments = db
    .prepare(
      "SELECT COUNT(*) AS n FROM comments WHERE entity_type = 'task' AND entity_id = ? AND removed_at IS NULL"
    )
    .get(row.id).n;
  const following = !!db
    .prepare("SELECT 1 FROM follows WHERE user_id = ? AND entity_type = 'task' AND entity_id = ?")
    .get(user.id, row.id);
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    dueDate: row.due_date || null,
    overdue: row.status === "open" && !!row.due_date && row.due_date < today,
    assignee: { id: row.assignee_id, name: row.assignee_name },
    createdBy: { id: row.created_by, name: row.creator_name },
    job: row.job_id == null ? null : { id: row.job_id, name: row.job_name },
    doneAt: row.done_at || null,
    doneBy: row.done_by == null ? null : { id: row.done_by, name: row.done_by_name || "Unknown" },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    files: filesOf(db, row.id),
    commentCount: Number(comments) || 0,
    following,
    canEdit: canEditRow(user, row),
  };
}

function follow(db, userId, taskId) {
  db.prepare("INSERT OR IGNORE INTO follows (user_id, entity_type, entity_id) VALUES (?, 'task', ?)").run(userId, taskId);
}

function link(id) {
  return `/tasks.html?task=${id}`;
}

function dueNote(date) {
  return date ? `Due ${dMon(date)}.` : "";
}

// A later timestamp than `prev` (even inside the same millisecond), so the stale-edit
// check never sees two different versions with one updated_at.
function nextStamp(prev) {
  const now = Date.now();
  const p = Date.parse(prev);
  return new Date(Number.isFinite(p) && p >= now ? p + 1 : now).toISOString();
}

// ------------------------------------------------------------------ reads ---

// view: mine (default) | raised | open | done | job. Open lists put overdue first, then by due date
// (no date last), then id.
function list(db, user, opts) {
  const o = opts || {};
  const view = o.view === undefined || o.view === null || o.view === "" ? "mine" : o.view;
  if (!VIEWS.includes(view)) throw bad(`view must be one of ${VIEWS.join(", ")}`);
  const today = sydneyToday();
  let limit = o.limit === undefined || o.limit === null || o.limit === "" ? null : Number(o.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw bad("limit must be a positive whole number");
  const cap = view === "done" ? 200 : 500;
  limit = Math.min(limit === null ? (view === "done" ? 50 : cap) : limit, cap);

  const queueOrder = `ORDER BY (t.due_date IS NOT NULL AND t.due_date < ?) DESC, (t.due_date IS NULL), t.due_date, t.id`;
  let sql;
  let args;
  if (view === "mine") {
    sql = `${SELECT} WHERE t.assignee_id = ? AND t.status = 'open' ${queueOrder} LIMIT ?`;
    args = [user.id, today, limit];
  } else if (view === "raised") {
    sql = `${SELECT} WHERE t.created_by = ? AND t.status = 'open' ${queueOrder} LIMIT ?`;
    args = [user.id, today, limit];
  } else if (view === "open") {
    sql = `${SELECT} WHERE t.status = 'open' ${queueOrder} LIMIT ?`;
    args = [today, limit];
  } else if (view === "done") {
    sql = `${SELECT} WHERE t.status IN ('done','cancelled') ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`;
    args = [limit];
  } else {
    const jobId = parseId(o.jobId);
    if (!jobId) throw bad("jobId is required for the job view");
    sql = `${SELECT} WHERE t.job_id = ? ORDER BY (t.status = 'open') DESC, t.updated_at DESC, t.id DESC LIMIT ?`;
    args = [jobId, limit];
  }
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => present(db, user, row, today));
}

function get(db, user, id) {
  return present(db, user, loadRow(db, id), sydneyToday());
}

// ----------------------------------------------------------------- writes ---

function create(db, req, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("JSON body required");
  const user = req.user;
  const title = textField("title", body.title, { max: TITLE_MAX, required: true });
  const notes = textField("notes", body.notes, { max: NOTES_MAX });
  const assigneeId = parseAssignee(db, body.assigneeId);
  const dueDate = parseDue(body.dueDate);
  const jobId = parseJob(db, body.jobId);
  const id = db.transaction(() => {
    const ts = nowIso();
    const info = db
      .prepare(
        `INSERT INTO tasks (title, notes, assignee_id, created_by, job_id, due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(title, notes, assigneeId, user.id, jobId, dueDate, ts, ts);
    const taskId = Number(info.lastInsertRowid);
    follow(db, user.id, taskId);
    follow(db, assigneeId, taskId);
    audit.log(req, {
      action: "task.create",
      entityType: "task",
      entityId: taskId,
      after: { title, assigneeId, dueDate, jobId },
    });
    if (Number(assigneeId) !== Number(user.id)) {
      notify.toUser(db, assigneeId, {
        kind: "task.assigned",
        title: `${user.displayName} gave you a task`,
        body: [title, dueNote(dueDate)].filter(Boolean).join(" "),
        link: link(taskId),
        entityType: "task",
        entityId: taskId,
      });
    }
    return taskId;
  })();
  return get(db, user, id);
}

function update(db, req, id, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("JSON body required");
  const user = req.user;
  if (typeof body.updatedAt !== "string" || !body.updatedAt) throw bad("updatedAt is required");
  const row = loadRow(db, id);
  if (!canEditRow(user, row)) throw forbidden();
  if (row.status !== "open") throw conflict("This task is closed");
  if (body.updatedAt !== row.updated_at) {
    throw conflict("Someone else changed this task. Reload to see it.", { task: get(db, user, id) });
  }

  const changes = {};
  const before = {};
  if (body.title !== undefined) {
    const v = textField("title", body.title, { max: TITLE_MAX, required: true });
    if (v !== row.title) {
      before.title = row.title;
      changes.title = v;
    }
  }
  if (body.notes !== undefined) {
    const v = textField("notes", body.notes, { max: NOTES_MAX });
    if (v !== row.notes) {
      before.notes = row.notes;
      changes.notes = v;
    }
  }
  if (body.assigneeId !== undefined) {
    const v = Number(body.assigneeId) === Number(row.assignee_id) ? row.assignee_id : parseAssignee(db, body.assigneeId);
    if (Number(v) !== Number(row.assignee_id)) {
      before.assigneeId = row.assignee_id;
      changes.assigneeId = v;
    }
  }
  if (body.dueDate !== undefined) {
    const v = parseDue(body.dueDate);
    if (v !== (row.due_date || null)) {
      before.dueDate = row.due_date || null;
      changes.dueDate = v;
    }
  }
  if (body.jobId !== undefined) {
    const v = parseJob(db, body.jobId);
    if (v !== (row.job_id == null ? null : row.job_id)) {
      before.jobId = row.job_id == null ? null : row.job_id;
      changes.jobId = v;
    }
  }
  if (Object.keys(changes).length === 0) return get(db, user, id);

  db.transaction(() => {
    const next = {
      title: changes.title !== undefined ? changes.title : row.title,
      notes: changes.notes !== undefined ? changes.notes : row.notes,
      assignee_id: changes.assigneeId !== undefined ? changes.assigneeId : row.assignee_id,
      due_date: changes.dueDate !== undefined ? changes.dueDate : row.due_date || null,
      job_id: changes.jobId !== undefined ? changes.jobId : row.job_id == null ? null : row.job_id,
    };
    // The WHERE re-checks updated_at, so the stale check holds even without the transaction.
    const info = db
      .prepare(
        `UPDATE tasks SET title = ?, notes = ?, assignee_id = ?, due_date = ?, job_id = ?, updated_at = ?
          WHERE id = ? AND updated_at = ?`
      )
      .run(next.title, next.notes, next.assignee_id, next.due_date, next.job_id, nextStamp(row.updated_at), id, row.updated_at);
    if (info.changes !== 1) throw conflict("Someone else changed this task. Reload to see it.", { task: get(db, user, id) });
    audit.log(req, { action: "task.update", entityType: "task", entityId: id, before, after: changes });
    if (changes.assigneeId !== undefined) {
      follow(db, changes.assigneeId, id);
      if (Number(changes.assigneeId) !== Number(user.id)) {
        notify.toUser(db, changes.assigneeId, {
          kind: "task.assigned",
          title: `${user.displayName} gave you a task`,
          body: [next.title, dueNote(next.due_date)].filter(Boolean).join(" "),
          link: link(id),
          entityType: "task",
          entityId: id,
        });
      }
    }
  })();
  return get(db, user, id);
}

// action: 'done' | 'reopen' | 'cancel'
function setStatus(db, req, id, action) {
  const user = req.user;
  if (!["done", "reopen", "cancel"].includes(action)) throw bad("Unknown action");
  db.transaction(() => {
    const row = loadRow(db, id);
    const ts = nextStamp(row.updated_at);
    if (action === "done") {
      if (row.status !== "open") throw conflict("This task isn't open");
      db.prepare("UPDATE tasks SET status = 'done', done_at = ?, done_by = ?, updated_at = ? WHERE id = ?").run(
        nowIso(),
        user.id,
        ts,
        id
      );
      audit.log(req, { action: "task.done", entityType: "task", entityId: id, before: { status: "open" }, after: { status: "done" } });
      if (Number(row.created_by) !== Number(user.id)) {
        notify.toUser(db, row.created_by, {
          kind: "task.done",
          title: `${user.displayName} finished a task`,
          body: row.title,
          link: link(id),
          entityType: "task",
          entityId: id,
        });
      }
    } else if (action === "reopen") {
      if (row.status !== "done") throw conflict("Only a finished task can be reopened");
      db.prepare("UPDATE tasks SET status = 'open', done_at = NULL, done_by = NULL, updated_at = ? WHERE id = ?").run(ts, id);
      audit.log(req, { action: "task.reopen", entityType: "task", entityId: id, before: { status: "done" }, after: { status: "open" } });
      if (Number(row.assignee_id) !== Number(user.id)) {
        notify.toUser(db, row.assignee_id, {
          kind: "task.reopened",
          title: `${user.displayName} reopened a task`,
          body: row.title,
          link: link(id),
          entityType: "task",
          entityId: id,
        });
      }
    } else {
      if (!isAdmin(user) && Number(row.created_by) !== Number(user.id)) throw forbidden();
      if (row.status !== "open") throw conflict("This task isn't open");
      db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(ts, id);
      audit.log(req, { action: "task.cancel", entityType: "task", entityId: id, before: { status: "open" }, after: { status: "cancelled" } });
    }
  })();
  return get(db, user, id);
}

// Throws 404, 403 or 409 unless the user may attach a file to the task now. The route calls it
// before the upload is checked; attach() repeats it inside the transaction.
function assertCanAttach(db, user, id) {
  const row = loadRow(db, id);
  if (!canEditRow(user, row)) throw forbidden();
  if (row.status !== "open") throw conflict("This task is closed");
  return row;
}

// Links an accepted file (lib/files accept()) to the task. The caller discards the file when this throws.
function attach(db, req, id, accepted) {
  const user = req.user;
  db.transaction(() => {
    assertCanAttach(db, user, id);
    const fileId = files.insert(db, accepted, user.id);
    db.prepare("INSERT INTO task_files (task_id, file_id) VALUES (?, ?)").run(id, fileId);
    audit.log(req, {
      action: "task.attach",
      entityType: "task",
      entityId: id,
      after: { fileId, name: accepted.originalName, size: accepted.size },
    });
  })();
  return get(db, user, id);
}

// Soft-removes an attachment: the uploader, the task's creator or an admin.
function detach(db, req, id, fileId) {
  const user = req.user;
  db.transaction(() => {
    const row = loadRow(db, id);
    const file = db
      .prepare(
        `SELECT f.* FROM task_files tf JOIN files f ON f.id = tf.file_id
          WHERE tf.task_id = ? AND f.id = ? AND f.removed_at IS NULL`
      )
      .get(id, fileId);
    if (!file) throw notFound();
    const uploader = file.uploaded_by != null && Number(file.uploaded_by) === Number(user.id);
    if (!(isAdmin(user) || uploader || Number(row.created_by) === Number(user.id))) throw forbidden();
    files.remove(db, file.id, user.id);
    audit.log(req, {
      action: "task.detach",
      entityType: "task",
      entityId: id,
      before: { fileId: file.id, name: file.original_name },
    });
  })();
  return get(db, user, id);
}

// ---------------------------------------------------------- the reminder ---

// The Sydney date to remind for, or null: a weekday (Mon-Fri), 07:00 or later, and not already
// run today. `lastRun` is the setting tasks.reminder_last_run.
function reminderDue(now, lastRun) {
  const p = sydneyParts(now);
  if (p.weekday < 1 || p.weekday > 5) return null;
  if (p.hour < REMINDER_HOUR) return null;
  return p.date === lastRun ? null : p.date;
}

// One task.reminder alert for each enabled tasks.use holder with open tasks due today or earlier.
// Unless `force`, it obeys reminderDue and records today so it runs once; the alerts and the record
// commit together. `force` (the admin route) runs regardless and records nothing.
function runReminder(db, { now = new Date(), force = false } = {}) {
  const today = sydneyToday(now);
  return db.transaction(() => {
    if (!force && !reminderDue(now, settings.get(db, "tasks.reminder_last_run"))) return { sent: 0, date: today };
    const due = db.prepare(
      `SELECT title, due_date FROM tasks
        WHERE assignee_id = ? AND status = 'open' AND due_date IS NOT NULL AND due_date <= ?
        ORDER BY due_date, id`
    );
    let sent = 0;
    for (const p of people.withKey(db, "tasks.use")) {
      const rows = due.all(p.id, today);
      if (!rows.length) continue;
      const shown = rows.slice(0, REMINDER_TITLES).map((t) => `${t.title} (due ${dMon(t.due_date)})`);
      const more = rows.length - shown.length;
      notify.toUser(db, p.id, {
        kind: "task.reminder",
        title: `${rows.length} ${rows.length === 1 ? "task" : "tasks"} due today or overdue`,
        body: shown.join("; ") + (more > 0 ? ` and ${more} more` : ""),
        link: "/tasks.html?view=mine",
        entityType: "reminder",
        entityId: today,
      });
      sent++;
    }
    if (!force) settings.set(db, "tasks.reminder_last_run", today, null, { audit: false });
    return { sent, date: today };
  })();
}

let reminderStarted = false;

// The timer: every 60 s, runReminder decides whether it is time. Off with REMINDER_DISABLED=1.
function startReminder(db) {
  if (process.env.REMINDER_DISABLED === "1") return;
  if (reminderStarted) return;
  reminderStarted = true;
  try {
    // A fresh install or an upgrade must not send a reminder on the day it starts.
    if (settings.get(db, "tasks.reminder_last_run") == null) {
      const today = sydneyToday();
      settings.set(db, "tasks.reminder_last_run", today, null, { audit: false });
      console.log(`[tasks] first start: reminder_last_run seeded to ${today}, nothing sent`);
    }
  } catch (e) {
    console.error("[tasks] seeding reminder_last_run failed:", e && e.message ? e.message : e);
  }
  const timer = setInterval(() => {
    try {
      const { sent, date } = runReminder(db, { now: new Date() });
      if (sent) console.log(`[tasks] reminder for ${date}: ${sent} notification(s) sent`);
    } catch (e) {
      console.error("[tasks] reminder failed:", e && e.message ? e.message : e);
    }
  }, REMINDER_CHECK_MS);
  timer.unref();
}

module.exports = {
  countsFor,
  list,
  get,
  create,
  update,
  setStatus,
  assertCanAttach,
  attach,
  detach,
  runReminder,
  reminderDue,
  startReminder,
};
