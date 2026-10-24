// Department notes: a week wall per department where its people stick signed notes for each
// other, one column per weekday, and give each other a thumbs-up. See docs/plans/notes-contracts.md.
// The department map below is the one place that says which key opens which department's notes:
// the page gate (lib/pages.js), the API and the tests use it; the menu (public/shell/shell.js)
// repeats the same keys as its static data.
const audit = require("./audit");
const { bad, forbidden, notFound, conflict, can } = require("./httperror");
const { sydneyToday, sydneyMonday, addDays, parseDateUTC, formatDateUTC, weekLabel } = require("./time");

// id -> { label, key }. One feature key per department (lib/permissions.js).
const DEPTS = {
  scheduling: { label: "Scheduling", key: "notes.scheduling" },
  design: { label: "Projects", key: "notes.design" },
  ordering: { label: "Ordering", key: "notes.ordering" },
  accounts: { label: "Accounts", key: "notes.accounts" },
  admin: { label: "Admin", key: "notes.admin" },
};
const DEPT_IDS = Object.keys(DEPTS);
const DEPT_KEYS = DEPT_IDS.map((id) => DEPTS[id].key);

const BODY_MAX = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LOCKED = "That week is over, so the note can no longer be changed or removed";

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

// ---------- dates ----------

// A real calendar date, YYYY-MM-DD, or null.
function validDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  const d = parseDateUTC(v);
  if (Number.isNaN(d.getTime()) || formatDateUTC(d) !== v) return null;
  return v;
}
// 0 = Sunday .. 6 = Saturday.
function dow(date) {
  return parseDateUTC(date).getUTCDay();
}
function isWeekday(date) {
  const n = dow(date);
  return n >= 1 && n <= 5;
}
function dayLabel(date) {
  const d = parseDateUTC(date);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}
// Today if it is a weekday (Sydney), else the next Monday.
function defaultDate(today) {
  return isWeekday(today) ? today : addDays(today, dow(today) === 6 ? 2 : 1);
}
// The date a new note or a move may go to: a real weekday, today or later. 400 with a plain sentence.
function checkNoteDate(v, today) {
  const date = validDate(v);
  if (!date) throw bad("Choose a day for the note");
  if (!isWeekday(date)) throw bad("Notes go on a weekday, Monday to Friday");
  if (date < today) throw bad("Notes can only go on today or a later day");
  return date;
}

// ---------- reading ----------

// ack rows for these notes: Map(noteId -> [{id, name}]) in the order they were given.
function acksFor(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = db
    .prepare(
      `SELECT a.note_id, a.user_id, u.display_name FROM dept_note_acks a
         JOIN users u ON u.id = a.user_id
        WHERE a.note_id IN (${ids.map(() => "?").join(",")})
        ORDER BY a.created_at, a.rowid`
    )
    .all(...ids);
  for (const r of rows) {
    if (!map.has(r.note_id)) map.set(r.note_id, []);
    map.get(r.note_id).push({ id: r.user_id, name: r.display_name || "Unknown" });
  }
  return map;
}

const SELECT = `SELECT n.*, u.display_name AS author_name
  FROM dept_notes n LEFT JOIN users u ON u.id = n.author_id`;

function present(row, user, thisWeek, ackList) {
  const list = ackList || [];
  return {
    id: row.id,
    dept: row.dept,
    date: row.note_date,
    weekStart: row.week_start,
    body: row.body,
    author: { id: row.author_id, name: row.author_name || "Unknown" },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: row.updated_at !== row.created_at,
    canEdit: row.author_id === user.id && row.week_start >= thisWeek,
    canAck: row.author_id !== user.id,
    acks: { count: list.length, names: list.map((a) => a.name), mine: list.some((a) => a.id === user.id) },
  };
}

function presentOne(db, id, user, thisWeek) {
  const row = db.prepare(`${SELECT} WHERE n.id = ?`).get(id);
  return present(row, user, thisWeek, acksFor(db, [id]).get(id));
}

// One department's week (a Monday): the five days with their notes, posted order, and the Mondays
// either side. `week` is optional (the current week).
function list(db, req, deptId, opts = {}) {
  const dept = deptFor(req, deptId);
  const user = req.user;
  const today = sydneyToday();
  const thisWeek = sydneyMonday(today);
  let week = thisWeek;
  if (opts.week !== undefined && opts.week !== null && opts.week !== "") {
    week = validDate(opts.week);
    if (!week) throw bad("week must be a date (YYYY-MM-DD)");
    if (dow(week) !== 1) throw bad("week must be a Monday");
  }
  const rows = db
    .prepare(`${SELECT} WHERE n.dept = ? AND n.week_start = ? AND n.removed_at IS NULL ORDER BY n.id`)
    .all(dept.id, week);
  const acks = acksFor(db, rows.map((r) => r.id));
  const days = [];
  for (let i = 0; i < 5; i++) {
    const date = addDays(week, i);
    days.push({
      date,
      name: DAY_NAMES[i + 1],
      label: dayLabel(date),
      today: date === today,
      canAdd: date >= today,
      notes: rows.filter((r) => r.note_date === date).map((r) => present(r, user, thisWeek, acks.get(r.id))),
    });
  }
  // The days the add form offers: today and later in this week, else (a weekend, looking at the
  // current week) next week's five days; nothing for a past week.
  let formDays = days.filter((d) => d.canAdd).map((d) => ({ date: d.date, label: d.label }));
  if (!formDays.length && week >= thisWeek) {
    formDays = [0, 1, 2, 3, 4].map((i) => ({ date: addDays(week, 7 + i), label: dayLabel(addDays(week, 7 + i)) }));
  }
  return {
    dept: dept.id,
    deptLabel: dept.label,
    today,
    thisWeek,
    weekStart: week,
    heading: `Week of ${dayLabel(week)}`,
    label: weekLabel(week),
    current: week === thisWeek,
    past: week < thisWeek,
    prev: addDays(week, -7),
    next: addDays(week, 7),
    canAdd: week >= thisWeek,
    formDays,
    defaultDate: formDays.some((d) => d.date === defaultDate(today)) ? defaultDate(today) : formDays.length ? formDays[0].date : null,
    days,
  };
}

// ---------- writing ----------

function cleanBody(v) {
  if (typeof v !== "string") throw bad("Write something to leave a note");
  const text = v.replace(/\r\n?/g, "\n").trim();
  if (!text) throw bad("Write something to leave a note");
  if (text.length > BODY_MAX) throw bad(`Notes are ${BODY_MAX.toLocaleString("en-AU")} characters at most`);
  return text;
}

function weekOfDate(date) {
  return sydneyMonday(date);
}

function create(db, req, deptId, date, body) {
  const dept = deptFor(req, deptId);
  const text = cleanBody(body);
  const today = sydneyToday();
  const day = date === undefined || date === null || date === "" ? defaultDate(today) : checkNoteDate(date, today);
  const thisWeek = sydneyMonday(today);
  const week = weekOfDate(day);
  return db.transaction(() => {
    const info = db
      .prepare("INSERT INTO dept_notes (dept, note_date, week_start, body, author_id) VALUES (?, ?, ?, ?, ?)")
      .run(dept.id, day, week, text, req.user.id);
    const id = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "note.create",
      entityType: "dept_note",
      entityId: id,
      after: { dept: dept.id, date: day, weekStart: week, body: text },
    });
    return presentOne(db, id, req.user, thisWeek);
  })();
}

// The live note row if the user may see its department, else 404 / 403.
function liveNote(db, req, id) {
  const nid = Number(id);
  const row = Number.isInteger(nid) && nid > 0 ? db.prepare("SELECT * FROM dept_notes WHERE id = ?").get(nid) : null;
  if (!row || row.removed_at) throw notFound();
  deptFor(req, row.dept);
  return row;
}

// The live note row for its author to change: nobody else (403), and only while its week is the
// current week or a later one (409 with a plain sentence after that).
function ownEditable(db, req, id) {
  const row = liveNote(db, req, id);
  if (row.author_id !== req.user.id) throw forbidden();
  const thisWeek = sydneyMonday(sydneyToday());
  if (row.week_start < thisWeek) throw conflict(LOCKED);
  return { row, thisWeek };
}

// PATCH: new text, a new day, or both. A day may move only to a weekday that is today or later.
function update(db, req, id, changes, updatedAt) {
  return db.transaction(() => {
    const { row, thisWeek } = ownEditable(db, req, id);
    if (updatedAt !== undefined && updatedAt !== null && updatedAt !== row.updated_at) {
      throw conflict("This note was changed somewhere else; reload it");
    }
    const hasBody = changes.body !== undefined;
    const hasDate = changes.date !== undefined;
    if (!hasBody && !hasDate) throw bad("Nothing to change");
    const text = hasBody ? cleanBody(changes.body) : row.body;
    let day = row.note_date;
    if (hasDate && changes.date !== row.note_date) day = checkNoteDate(changes.date, sydneyToday());
    if (text === row.body && day === row.note_date) return presentOne(db, row.id, req.user, thisWeek);
    const week = weekOfDate(day);
    const now = new Date().toISOString();
    // Always move updated_at, even on a same-millisecond save, so a stale copy is noticed.
    const stamp = now === row.updated_at ? new Date(Date.parse(now) + 1).toISOString() : now;
    db.prepare("UPDATE dept_notes SET body = ?, note_date = ?, week_start = ?, updated_at = ? WHERE id = ?").run(
      text, day, week, stamp, row.id
    );
    audit.log(req, {
      action: "note.update",
      entityType: "dept_note",
      entityId: row.id,
      before: { dept: row.dept, date: row.note_date, weekStart: row.week_start, body: row.body },
      after: { dept: row.dept, date: day, weekStart: week, body: text },
    });
    return presentOne(db, row.id, req.user, thisWeek);
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
      before: { dept: row.dept, date: row.note_date, weekStart: row.week_start, body: row.body },
    });
  })();
}

// ---------- thumbs-up ----------

// Give (on = true) or take back (on = false) the caller's thumbs-up on a note. Allowed in any week,
// past included, for anyone who can open the note's department; never on your own note (403).
// Idempotent: asking for the state you are already in changes and records nothing.
function acknowledge(db, req, id, on) {
  return db.transaction(() => {
    const row = liveNote(db, req, id);
    if (row.author_id === req.user.id) {
      const e = forbidden();
      e.message = "You can't acknowledge your own note";
      throw e;
    }
    const has = db.prepare("SELECT 1 FROM dept_note_acks WHERE note_id = ? AND user_id = ?").get(row.id, req.user.id);
    if (on && !has) {
      db.prepare("INSERT INTO dept_note_acks (note_id, user_id, created_at) VALUES (?, ?, ?)").run(
        row.id, req.user.id, new Date().toISOString()
      );
      audit.log(req, { action: "note.ack", entityType: "dept_note", entityId: row.id, after: { dept: row.dept } });
    } else if (!on && has) {
      db.prepare("DELETE FROM dept_note_acks WHERE note_id = ? AND user_id = ?").run(row.id, req.user.id);
      audit.log(req, { action: "note.unack", entityType: "dept_note", entityId: row.id, before: { dept: row.dept } });
    }
    return presentOne(db, row.id, req.user, sydneyMonday(sydneyToday()));
  })();
}

module.exports = {
  DEPTS, DEPT_IDS, DEPT_KEYS, BODY_MAX, deptOf, deptFor, defaultDate, list, create, update, remove, acknowledge,
};
