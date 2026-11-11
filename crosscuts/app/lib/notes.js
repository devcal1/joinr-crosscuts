// Department notes: a wall per department where its people stick signed notes for each other, laid
// out as five week columns (this week centred), each note with an optional day tag, and give each
// other reacts. See docs/plans/notes-contracts.md.
// The department map below is the one place that says which key opens which department's notes:
// the page gate (lib/pages.js), the API and the tests use it; the menu (public/shell/shell.js)
// repeats the same keys as its static data.
const audit = require("./audit");
const { bad, forbidden, notFound, conflict, can } = require("./httperror");
const { sydneyToday, sydneyMonday, addDays, parseDateUTC, formatDateUTC } = require("./time");

// id -> { label, key }. One feature key per department (lib/permissions.js).
const DEPTS = {
  scheduling: { label: "Scheduling", key: "notes.scheduling" },
  design: { label: "Projects", key: "notes.design" },
  ordering: { label: "Ordering", key: "notes.ordering" },
  accounts: { label: "Accounts", key: "notes.accounts" },
  admin: { label: "Admin", key: "notes.admin" },
  // 0.2.2 (docs/plans/m23-contracts.md section 7): dept_notes allows 'workshop' since migration 043.
  workshop: { label: "Workshop", key: "notes.workshop" },
};
const DEPT_IDS = Object.keys(DEPTS);
const DEPT_KEYS = DEPT_IDS.map((id) => DEPTS[id].key);

const BODY_MAX = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_WEEKS_AHEAD = 104;
const WINDOW_WEEKS = 5;
const REACT_KINDS = ["up", "down", "laugh", "sad"];
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
function shortDate(date) {
  const d = parseDateUTC(date);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}
// Whole weeks from one Monday to another.
function weeksBetween(from, to) {
  return Math.round((parseDateUTC(to) - parseDateUTC(from)) / (7 * 86400000));
}
// "This week", "Last week", "Next week", "2 weeks ago", "In 3 weeks".
function relativeLabel(offset) {
  if (offset === 0) return "This week";
  if (offset === -1) return "Last week";
  if (offset === 1) return "Next week";
  return offset < 0 ? `${-offset} weeks ago` : `In ${offset} weeks`;
}
// A Monday (YYYY-MM-DD) that is this week or later, or a 400 with a plain sentence.
function checkNoteWeek(v, thisWeek) {
  const week = validDate(v);
  if (!week || dow(week) !== 1) throw bad("Choose a week for the note");
  if (week < thisWeek) throw bad("Notes can only go in this week or a later one");
  if (weeksBetween(thisWeek, week) > MAX_WEEKS_AHEAD) throw bad("That week is too far ahead");
  return week;
}
// A weekday date (the optional day tag), or a 400.
function checkDayTag(v) {
  const date = validDate(v);
  if (!date) throw bad("Choose a day for the note");
  if (!isWeekday(date)) throw bad("Notes go on a weekday, Monday to Friday");
  return date;
}
// Where a note goes, from the week (a Monday) and the optional day tag (a weekday date; null or ""
// = the whole week) asked for. A day alone names its own week. A day outside the week is a 400.
// Returns { week, date, tagged }; an untagged note's date is its week's Monday (the 029 CHECKs).
function resolvePlace(weekIn, dayIn, thisWeek) {
  const hasDay = dayIn !== undefined && dayIn !== null && dayIn !== "";
  const hasWeek = weekIn !== undefined && weekIn !== null && weekIn !== "";
  let week;
  let date = null;
  if (hasDay) {
    date = checkDayTag(dayIn);
    week = sydneyMonday(date);
    if (hasWeek && validDate(weekIn) !== week) throw bad("That day is not in the chosen week");
  } else {
    week = hasWeek ? weekIn : thisWeek;
  }
  week = checkNoteWeek(week, thisWeek);
  return { week, date: date || week, tagged: !!date };
}

// ---------- reading ----------

// A stable hue (0-359) for a user: their linked board worker's hue when there is one, otherwise
// derived from the user id, so a person looks the same every time. Same hue -> colour function as the board.
function userHue(workerHue, userId) {
  if (Number.isInteger(workerHue)) return workerHue;
  return ((Number(userId) || 0) * 137) % 360;
}

// react rows for these notes: Map(noteId -> { up: [{id, name, hue}], down: [], laugh: [], sad: [] }),
// each list in the order the reacts were given.
function reactsFor(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = db
    .prepare(
      `SELECT a.note_id, a.user_id, a.kind, u.display_name, w.hue AS worker_hue FROM dept_note_reacts a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN workers w ON w.id = u.worker_id
        WHERE a.note_id IN (${ids.map(() => "?").join(",")})
        ORDER BY a.created_at, a.rowid`
    )
    .all(...ids);
  for (const r of rows) {
    if (!map.has(r.note_id)) map.set(r.note_id, { up: [], down: [], laugh: [], sad: [] });
    map.get(r.note_id)[r.kind].push({ id: r.user_id, name: r.display_name || "Unknown", hue: userHue(r.worker_hue, r.user_id) });
  }
  return map;
}

const SELECT = `SELECT n.*, u.display_name AS author_name, w.hue AS author_hue
  FROM dept_notes n LEFT JOIN users u ON u.id = n.author_id LEFT JOIN workers w ON w.id = u.worker_id`;

function reactSummary(list, user) {
  return { count: list.length, names: list.map((a) => a.name), people: list.map((a) => ({ name: a.name, hue: a.hue })), mine: list.some((a) => a.id === user.id) };
}

function present(row, user, thisWeek, reactList) {
  const lists = reactList || { up: [], down: [], laugh: [], sad: [] };
  const tagged = row.day_tagged === 1;
  const reacts = {};
  for (const k of REACT_KINDS) reacts[k] = reactSummary(lists[k], user);
  return {
    id: row.id,
    dept: row.dept,
    // The day tag: a weekday date, or null for a note that is for the whole week.
    date: tagged ? row.note_date : null,
    dayName: tagged ? DAY_NAMES[dow(row.note_date)] : null,
    weekStart: row.week_start,
    body: row.body,
    author: { id: row.author_id, name: row.author_name || "Unknown", hue: userHue(row.author_hue, row.author_id) },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: row.updated_at !== row.created_at,
    canEdit: row.author_id === user.id && row.week_start >= thisWeek,
    canAck: row.author_id !== user.id,
    canReact: row.author_id !== user.id,
    reacts,
    acks: reacts.up,
  };
}

function presentOne(db, id, user, thisWeek) {
  const row = db.prepare(`${SELECT} WHERE n.id = ?`).get(id);
  return present(row, user, thisWeek, reactsFor(db, [id]).get(id));
}

// Five weeks of one department's notes in one go: `from` is the first week's Monday (default: two
// weeks before this one, which centres this week). Each week's notes: whole-week notes first, then
// by day tag, then in the order posted.
function list(db, req, deptId, opts = {}) {
  const dept = deptFor(req, deptId);
  const user = req.user;
  const today = sydneyToday();
  const thisWeek = sydneyMonday(today);
  const centred = addDays(thisWeek, -7 * (WINDOW_WEEKS >> 1));
  let from = centred;
  if (opts.from !== undefined && opts.from !== null && opts.from !== "") {
    from = validDate(opts.from);
    if (!from) throw bad("from must be a date (YYYY-MM-DD)");
    if (dow(from) !== 1) throw bad("from must be a Monday");
  }
  const last = addDays(from, 7 * (WINDOW_WEEKS - 1));
  const rows = db
    .prepare(
      `${SELECT} WHERE n.dept = ? AND n.week_start BETWEEN ? AND ? AND n.removed_at IS NULL
        ORDER BY n.week_start, n.day_tagged, n.note_date, n.id`
    )
    .all(dept.id, from, last);
  const reacts = reactsFor(db, rows.map((r) => r.id));
  const weeks = [];
  for (let i = 0; i < WINDOW_WEEKS; i++) {
    const weekStart = addDays(from, 7 * i);
    const offset = weeksBetween(thisWeek, weekStart);
    weeks.push({
      weekStart,
      heading: `Week of ${shortDate(weekStart)}`,
      sub: relativeLabel(offset),
      offset,
      current: offset === 0,
      past: offset < 0,
      canAdd: offset >= 0,
      notes: rows.filter((r) => r.week_start === weekStart).map((r) => present(r, user, thisWeek, reacts.get(r.id))),
    });
  }
  return {
    dept: dept.id,
    deptLabel: dept.label,
    today,
    thisWeek,
    from,
    to: addDays(last, 6),
    label: `${shortDate(from)} – ${shortDate(addDays(last, 6))}`,
    centred: from === centred,
    prev: addDays(from, -7),
    next: addDays(from, 7),
    weeks,
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

// POST: a week (a Monday; default this week) and an optional day tag (a weekday date; none = the
// whole week). A day alone names its own week. Only this week or later.
function create(db, req, deptId, date, body, week) {
  const dept = deptFor(req, deptId);
  const text = cleanBody(body);
  const thisWeek = sydneyMonday(sydneyToday());
  const place = resolvePlace(week, date, thisWeek);
  return db.transaction(() => {
    const info = db
      .prepare("INSERT INTO dept_notes (dept, note_date, week_start, day_tagged, body, author_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(dept.id, place.date, place.week, place.tagged ? 1 : 0, text, req.user.id);
    const id = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "note.create",
      entityType: "dept_note",
      entityId: id,
      after: { dept: dept.id, date: place.tagged ? place.date : null, weekStart: place.week, body: text },
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

function tagOf(row) {
  return row.day_tagged === 1 ? row.note_date : null;
}

// PATCH: new text, a new week, a new day tag (null removes it), or any of them. A change of week
// alone keeps the same weekday tag in the new week. A week may only be this one or a later one;
// a note keeping its week may change its tag to any weekday of that week.
function update(db, req, id, changes, updatedAt) {
  return db.transaction(() => {
    const { row, thisWeek } = ownEditable(db, req, id);
    if (updatedAt !== undefined && updatedAt !== null && updatedAt !== row.updated_at) {
      throw conflict("This note was changed somewhere else; reload it");
    }
    const hasBody = changes.body !== undefined;
    const hasDate = changes.date !== undefined;
    const hasWeek = changes.week !== undefined && changes.week !== null && changes.week !== "";
    if (!hasBody && !hasDate && !hasWeek) throw bad("Nothing to change");
    const text = hasBody ? cleanBody(changes.body) : row.body;
    let week = row.week_start;
    let day = tagOf(row);
    if (hasWeek && changes.week !== row.week_start) {
      week = checkNoteWeek(changes.week, thisWeek);
      if (day && !hasDate) day = addDays(week, dow(day) - 1);
    }
    if (hasDate) {
      if (changes.date === null || changes.date === "") day = null;
      else if (changes.date !== day) {
        day = checkDayTag(changes.date);
        if (sydneyMonday(day) !== week) {
          if (hasWeek) throw bad("That day is not in the chosen week");
          week = checkNoteWeek(sydneyMonday(day), thisWeek);
        }
      }
    }
    if (day && sydneyMonday(day) !== week) throw bad("That day is not in the chosen week");
    if (text === row.body && week === row.week_start && day === tagOf(row)) return presentOne(db, row.id, req.user, thisWeek);
    const now = new Date().toISOString();
    // Always move updated_at, even on a same-millisecond save, so a stale copy is noticed.
    const stamp = now === row.updated_at ? new Date(Date.parse(now) + 1).toISOString() : now;
    db.prepare("UPDATE dept_notes SET body = ?, note_date = ?, week_start = ?, day_tagged = ?, updated_at = ? WHERE id = ?").run(
      text, day || week, week, day ? 1 : 0, stamp, row.id
    );
    audit.log(req, {
      action: "note.update",
      entityType: "dept_note",
      entityId: row.id,
      before: { dept: row.dept, date: tagOf(row), weekStart: row.week_start, body: row.body },
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
      before: { dept: row.dept, date: tagOf(row), weekStart: row.week_start, body: row.body },
    });
  })();
}

// ---------- reacts ----------

// Give (on = true) or take back (on = false) the caller's react of one kind (up, down, laugh, sad)
// on a note. Allowed in any week, past included, for anyone who can open the note's department;
// never on your own note (403). Idempotent: asking for the state you are already in changes and
// records nothing. A thumbs-up is audited as note.ack / note.unack (as before), the others as
// note.react / note.unreact. Nobody is notified of any of them.
function react(db, req, id, kind, on) {
  if (!REACT_KINDS.includes(kind)) throw bad("Unknown react");
  return db.transaction(() => {
    const row = liveNote(db, req, id);
    if (row.author_id === req.user.id) {
      const e = forbidden();
      e.message = "You can't react to your own note";
      throw e;
    }
    const has = db.prepare("SELECT 1 FROM dept_note_reacts WHERE note_id = ? AND user_id = ? AND kind = ?").get(row.id, req.user.id, kind);
    if (on && !has) {
      db.prepare("INSERT INTO dept_note_reacts (note_id, user_id, kind, created_at) VALUES (?, ?, ?, ?)").run(
        row.id, req.user.id, kind, new Date().toISOString()
      );
      audit.log(req, kind === "up"
        ? { action: "note.ack", entityType: "dept_note", entityId: row.id, after: { dept: row.dept } }
        : { action: "note.react", entityType: "dept_note", entityId: row.id, after: { dept: row.dept, react: kind } });
    } else if (!on && has) {
      db.prepare("DELETE FROM dept_note_reacts WHERE note_id = ? AND user_id = ? AND kind = ?").run(row.id, req.user.id, kind);
      audit.log(req, kind === "up"
        ? { action: "note.unack", entityType: "dept_note", entityId: row.id, before: { dept: row.dept } }
        : { action: "note.unreact", entityType: "dept_note", entityId: row.id, before: { dept: row.dept, react: kind } });
    }
    return presentOne(db, row.id, req.user, sydneyMonday(sydneyToday()));
  })();
}

module.exports = {
  DEPTS, DEPT_IDS, DEPT_KEYS, BODY_MAX, REACT_KINDS, deptOf, deptFor, list, create, update, remove, react,
};
