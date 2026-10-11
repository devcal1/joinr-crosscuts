// Leave and availability (brief §5.3.4; m5-contracts.md section 2). Whole days, Monday to
// Friday. Scaffold (M5 · 2.2): the reads used by the board are complete and frozen; Wave 1 B
// fills in the writes (signatures binding).
const { addDays, parseDateUTC, formatDateUTC, DATE_RE } = require("./time");
const { bad, notFound } = require("./httperror");
const audit = require("./audit");

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"];

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

// --- Wave 1 B: the lists and the writes (m5-contracts.md sections 2 and 3) ----------------

const KINDS = ["leave", "sick", "other"];
const MAX_LEAVE_DAYS = 366;
const MAX_NOTE = 500;

// A real calendar date in YYYY-MM-DD form, or null.
function validDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  const d = parseDateUTC(v);
  return formatDateUTC(d) === v ? v : null;
}

// Whole days between two valid dates (to - from).
function dayDiff(from, to) {
  return Math.round((parseDateUTC(to) - parseDateUTC(from)) / 86400000);
}

// Monday-to-Friday dates covered by from..to inclusive.
function weekdaysBetween(from, to) {
  let n = 0;
  const total = dayDiff(from, to);
  for (let i = 0; i <= total; i++) {
    const dow = parseDateUTC(addDays(from, i)).getUTCDay();
    if (dow >= 1 && dow <= 5) n++;
  }
  return n;
}

function workerOut(w) {
  return {
    id: Number(w.id),
    name: w.name,
    archived: !!w.archived,
    daysPerWeek: w.days_per_week == null ? null : Number(w.days_per_week),
    regularDaysOff: parseDaysOff(w.regular_days_off),
  };
}

const WORKER_SQL = "SELECT id, name, archived, days_per_week, regular_days_off FROM workers";

// Every worker (archived last), with the part-time pattern.
function listWorkers(db) {
  return db.prepare(`${WORKER_SQL} ORDER BY archived, sort_order, id`).all().map(workerOut);
}

const LEAVE_SQL = `SELECT l.id, l.worker_id, w.name AS worker_name, l.date_from, l.date_to, l.kind, l.note,
       l.created_by, u.display_name AS created_by_name, l.created_at
  FROM leave l
  JOIN workers w ON w.id = l.worker_id
  LEFT JOIN users u ON u.id = l.created_by`;

function leaveOut(r) {
  return {
    id: Number(r.id),
    worker: { id: Number(r.worker_id), name: r.worker_name },
    from: r.date_from,
    to: r.date_to,
    kind: r.kind,
    note: r.note,
    createdBy: r.created_by == null ? null : { id: Number(r.created_by), name: r.created_by_name },
    createdAt: r.created_at,
    days: weekdaysBetween(r.date_from, r.date_to),
  };
}

// Leave that is not removed and overlaps from..to (either bound may be omitted), by start date.
function listLeave(db, opts) {
  const { from, to, workerId } = opts || {};
  const where = ["l.removed_at IS NULL"];
  const args = [];
  if (from) {
    where.push("l.date_to >= ?");
    args.push(from);
  }
  if (to) {
    where.push("l.date_from <= ?");
    args.push(to);
  }
  if (workerId != null) {
    where.push("l.worker_id = ?");
    args.push(Number(workerId));
  }
  return db
    .prepare(`${LEAVE_SQL} WHERE ${where.join(" AND ")} ORDER BY l.date_from, w.name COLLATE NOCASE, l.id`)
    .all(...args)
    .map(leaveOut);
}

function getLeave(db, id) {
  const r = db.prepare(`${LEAVE_SQL} WHERE l.id = ?`).get(id);
  return r ? leaveOut(r) : null;
}

function addLeave(db, req, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const workerId = Number(b.workerId);
  if (!Number.isInteger(workerId) || workerId <= 0 || typeof b.workerId === "boolean") throw bad("workerId is required");
  const from = validDate(b.from);
  const to = validDate(b.to);
  if (!from) throw bad("from must be a date (YYYY-MM-DD)");
  if (!to) throw bad("to must be a date (YYYY-MM-DD)");
  if (from > to) throw bad("from can't be after to");
  if (dayDiff(from, to) + 1 > MAX_LEAVE_DAYS) throw bad(`Leave can't be longer than ${MAX_LEAVE_DAYS} days`);
  if (!KINDS.includes(b.kind)) throw bad("kind must be one of " + KINDS.join(", "));
  let note = "";
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string") throw bad("note must be text");
    note = b.note.trim();
    if (note.length > MAX_NOTE) throw bad(`note can't be longer than ${MAX_NOTE} characters`);
  }
  if (!db.prepare("SELECT 1 FROM workers WHERE id = ?").get(workerId)) throw bad("That worker doesn't exist");
  const userId = req && req.user ? req.user.id : null;
  return db.transaction(() => {
    const info = db
      .prepare("INSERT INTO leave (worker_id, date_from, date_to, kind, note, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(workerId, from, to, b.kind, note, userId);
    const leave = getLeave(db, Number(info.lastInsertRowid));
    audit.log(req, {
      action: "leave.create",
      entityType: "leave",
      entityId: leave.id,
      after: { workerId, from, to, kind: b.kind, note },
    });
    return leave;
  })();
}

function removeLeave(db, req, id) {
  const row = db.prepare("SELECT * FROM leave WHERE id = ? AND removed_at IS NULL").get(id);
  if (!row) throw notFound();
  const userId = req && req.user ? req.user.id : null;
  db.transaction(() => {
    db.prepare("UPDATE leave SET removed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), removed_by = ? WHERE id = ?").run(
      userId,
      id
    );
    audit.log(req, {
      action: "leave.remove",
      entityType: "leave",
      entityId: id,
      before: { workerId: Number(row.worker_id), from: row.date_from, to: row.date_to, kind: row.kind, note: row.note },
    });
  })();
}

// body: {daysPerWeek?, regularDaysOff?}; a key that is absent is left alone.
function setPattern(db, req, workerId, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const row = db.prepare(`${WORKER_SQL} WHERE id = ?`).get(workerId);
  if (!row) throw notFound();
  const sets = [];
  const args = [];
  const before = {};
  const after = {};
  if (Object.prototype.hasOwnProperty.call(b, "daysPerWeek")) {
    const v = b.daysPerWeek;
    if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 4)) {
      throw bad("daysPerWeek must be empty or a whole number from 1 to 4");
    }
    if ((row.days_per_week == null ? null : Number(row.days_per_week)) !== v) {
      before.daysPerWeek = row.days_per_week == null ? null : Number(row.days_per_week);
      after.daysPerWeek = v;
      sets.push("days_per_week = ?");
      args.push(v);
    }
  }
  if (Object.prototype.hasOwnProperty.call(b, "regularDaysOff")) {
    const v = b.regularDaysOff;
    if (!Array.isArray(v)) throw bad("regularDaysOff must be a list of days");
    if (v.length > 4) throw bad("regularDaysOff can have at most 4 days");
    if (!v.every((d) => typeof d === "string" && DAY_KEYS.includes(d))) {
      throw bad("regularDaysOff days must be among " + DAY_KEYS.join(", "));
    }
    if (new Set(v).size !== v.length) throw bad("regularDaysOff can't repeat a day");
    const next = DAY_KEYS.filter((d) => v.includes(d));
    const prev = parseDaysOff(row.regular_days_off);
    if (next.join(",") !== prev.join(",")) {
      before.regularDaysOff = prev;
      after.regularDaysOff = next;
      sets.push("regular_days_off = ?");
      args.push(next.length ? next.join(",") : null);
    }
  }
  if (!Object.keys(b).some((k) => k === "daysPerWeek" || k === "regularDaysOff")) {
    throw bad("Nothing to change");
  }
  if (sets.length) {
    db.transaction(() => {
      db.prepare(`UPDATE workers SET ${sets.join(", ")} WHERE id = ?`).run(...args, workerId);
      audit.log(req, {
        action: "worker.pattern",
        entityType: "worker",
        entityId: workerId,
        before,
        after,
      });
    })();
  }
  return workerOut(db.prepare(`${WORKER_SQL} WHERE id = ?`).get(workerId));
}

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
