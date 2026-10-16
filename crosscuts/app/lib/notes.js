// Department notes: a weekly sheet per department where its people leave signed notes for each
// other. See docs/plans/notes-contracts.md. The department map below is the one place that says
// which key opens which department's notes: the page gate (lib/pages.js), the API and the tests
// use it; the menu (public/shell/shell.js) repeats the same keys as its static data.
const audit = require("./audit");
const { bad, forbidden, notFound, conflict, can } = require("./httperror");
const { sydneyToday, sydneyMonday, addDays, weekLabel } = require("./time");

// id -> { label, key }. No new permission keys: each department uses the key its own pages use.
const DEPTS = {
  scheduling: { label: "Scheduling", key: "scheduling.view" },
  design: { label: "Design/PM", key: "design.view" },
  ordering: { label: "Ordering", key: "orders.view" },
  accounts: { label: "Accounts", key: "accounts.view" },
  admin: { label: "Admin", key: "users.admin" },
};
const DEPT_IDS = Object.keys(DEPTS);
const DEPT_KEYS = DEPT_IDS.map((id) => DEPTS[id].key);

const BODY_MAX = 2000;
const OLDER_DEFAULT = 4; // weeks (that have notes) per "Older weeks" press
const OLDER_MAX = 12;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The department row for an id, or a 400. Does not check the user's key.
function deptOf(id) {
  if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(DEPTS, id)) {
    throw bad("Unknown department");
  }
  return { id, ...DEPTS[id] };
}

// The department row if the user holds its key, else 400 (unknown) or 403.
function deptFor(req, id) {
  const d = deptOf(id);
  if (!can(req, d.key)) throw forbidden();
  return d;
}

function present(row, user, thisWeek) {
  return {
    id: row.id,
    dept: row.dept,
    weekStart: row.week_start,
    body: row.body,
    author: { id: row.author_id, name: row.author_name || "Unknown" },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: row.updated_at !== row.created_at,
    canEdit: row.author_id === user.id && row.week_start === thisWeek,
  };
}

const SELECT = `SELECT n.*, u.display_name AS author_name
  FROM dept_notes n LEFT JOIN users u ON u.id = n.author_id`;

function weekOf(db, user, dept, weekStart, thisWeek) {
  const rows = db
    .prepare(`${SELECT} WHERE n.dept = ? AND n.week_start = ? AND n.removed_at IS NULL ORDER BY n.id DESC`)
    .all(dept, weekStart);
  return {
    weekStart,
    label: weekLabel(weekStart),
    current: weekStart === thisWeek,
    notes: rows.map((r) => present(r, user, thisWeek)),
  };
}

// Is there any live note in this department in a week before `weekStart`?
function olderExists(db, dept, weekStart) {
  return !!db
    .prepare("SELECT 1 FROM dept_notes WHERE dept = ? AND week_start < ? AND removed_at IS NULL LIMIT 1")
    .get(dept, weekStart);
}

// List a department's notes. No `before`: {weeks: [this week, last week], more, next}. With
// `before` (a Monday, exclusive): up to `limit` earlier weeks that have notes, newest first.
// `more` says older notes exist beyond the weeks returned; `next` is the cursor for the next press.
function list(db, req, deptId, opts = {}) {
  const dept = deptFor(req, deptId);
  const user = req.user;
  const thisWeek = sydneyMonday(sydneyToday());
  const base = { dept: dept.id, deptLabel: dept.label, thisWeek };
  const before = opts.before;
  if (before === undefined || before === null || before === "") {
    const lastWeek = addDays(thisWeek, -7);
    return {
      ...base,
      weeks: [weekOf(db, user, dept.id, thisWeek, thisWeek), weekOf(db, user, dept.id, lastWeek, thisWeek)],
      more: olderExists(db, dept.id, lastWeek),
      next: lastWeek,
    };
  }
  if (typeof before !== "string" || !DATE_RE.test(before) || Number.isNaN(Date.parse(before))) {
    throw bad("before must be a date (YYYY-MM-DD)");
  }
  let limit = OLDER_DEFAULT;
  if (opts.limit !== undefined && opts.limit !== null && opts.limit !== "") {
    limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw bad("limit must be a positive whole number");
    limit = Math.min(limit, OLDER_MAX);
  }
  const starts = db
    .prepare(
      `SELECT DISTINCT week_start FROM dept_notes
        WHERE dept = ? AND week_start < ? AND removed_at IS NULL ORDER BY week_start DESC LIMIT ?`
    )
    .all(dept.id, before, limit)
    .map((r) => r.week_start);
  const oldest = starts.length ? starts[starts.length - 1] : before;
  return {
    ...base,
    weeks: starts.map((s) => weekOf(db, user, dept.id, s, thisWeek)),
    more: olderExists(db, dept.id, oldest),
    next: oldest,
  };
}

function cleanBody(v) {
  if (typeof v !== "string") throw bad("Write something to leave a note");
  const text = v.replace(/\r\n?/g, "\n").trim();
  if (!text) throw bad("Write something to leave a note");
  if (text.length > BODY_MAX) throw bad(`Notes are ${BODY_MAX.toLocaleString("en-AU")} characters at most`);
  return text;
}

function create(db, req, deptId, body) {
  const dept = deptFor(req, deptId);
  const text = cleanBody(body);
  const thisWeek = sydneyMonday(sydneyToday());
  return db.transaction(() => {
    const info = db
      .prepare("INSERT INTO dept_notes (dept, week_start, body, author_id) VALUES (?, ?, ?, ?)")
      .run(dept.id, thisWeek, text, req.user.id);
    const id = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "note.create",
      entityType: "dept_note",
      entityId: id,
      after: { dept: dept.id, weekStart: thisWeek, body: text },
    });
    return present(db.prepare(`${SELECT} WHERE n.id = ?`).get(id), req.user, thisWeek);
  })();
}

// The live note row if the user may see its department, else 404 / 403. Only the author may
// change a note, and only in the week it was written (409 with a plain sentence after that).
function ownEditable(db, req, id) {
  const nid = Number(id);
  const row = Number.isInteger(nid) && nid > 0 ? db.prepare("SELECT * FROM dept_notes WHERE id = ?").get(nid) : null;
  if (!row || row.removed_at) throw notFound();
  deptFor(req, row.dept);
  if (row.author_id !== req.user.id) throw forbidden();
  const thisWeek = sydneyMonday(sydneyToday());
  if (row.week_start !== thisWeek) {
    throw conflict("That week is over, so the note can no longer be changed or removed");
  }
  return { row, thisWeek };
}

function update(db, req, id, body, updatedAt) {
  return db.transaction(() => {
    const { row, thisWeek } = ownEditable(db, req, id);
    if (updatedAt !== undefined && updatedAt !== null && updatedAt !== row.updated_at) {
      throw conflict("This note was changed somewhere else; reload it");
    }
    const text = cleanBody(body);
    const now = new Date().toISOString();
    // Always move updated_at, even on a same-millisecond save, so a stale copy is noticed.
    const stamp = now === row.updated_at ? new Date(Date.parse(now) + 1).toISOString() : now;
    db.prepare("UPDATE dept_notes SET body = ?, updated_at = ? WHERE id = ?").run(text, stamp, row.id);
    audit.log(req, {
      action: "note.update",
      entityType: "dept_note",
      entityId: row.id,
      before: { dept: row.dept, weekStart: row.week_start, body: row.body },
      after: { dept: row.dept, weekStart: row.week_start, body: text },
    });
    return present(db.prepare(`${SELECT} WHERE n.id = ?`).get(row.id), req.user, thisWeek);
  })();
}

function remove(db, req, id) {
  db.transaction(() => {
    const { row } = ownEditable(db, req, id);
    db.prepare("UPDATE dept_notes SET removed_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    audit.log(req, {
      action: "note.remove",
      entityType: "dept_note",
      entityId: row.id,
      before: { dept: row.dept, weekStart: row.week_start, body: row.body },
    });
  })();
}

module.exports = { DEPTS, DEPT_IDS, DEPT_KEYS, BODY_MAX, deptOf, deptFor, list, create, update, remove };
