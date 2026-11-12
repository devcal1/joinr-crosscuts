// Pay runs: people, pay runs, timesheets, suggestions, the summary, public holidays and the pay
// rules (docs/plans/m8-contracts.md section 5).
//
// Every function takes db first and nothing here requires ../db. All hour maths comes from
// ../public/paymaths (the one home of the daily split). Pay runs only read workers, week_rows,
// assignments, jobs and leave, with their own queries; every write runs in one db.transaction with
// its audit row.
const audit = require("./audit");
const settings = require("./settings");
const PayMaths = require("../public/paymaths");
const { bad, notFound, conflict } = require("./httperror");
const { DATE_RE, parseDateUTC, formatDateUTC, addDays, mondayOf, sydneyToday } = require("./time");
const { parseDaysOff } = require("./availability");

const PERSON_NAME_MAX = 100;
const HOLIDAY_NAME_MAX = 80;
const JOB_MAX = 200;
const NOTES_MAX = 2000;
const DAY_NOTE_MAX = 500;
const RULE_MAX_MIN = 720;
const DAY_MAX_MIN = 1440;
const HOLIDAY_SPAN_MAX = 800;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// The typed hour fields of one paper row, in column order.
const HOUR_FIELDS = ["startMin", "finishMin", "lunchMin", "pholMin", "sickMin", "arlMin", "onsiteMin"];
const HOUR_COLS = {
  startMin: "start_min",
  finishMin: "finish_min",
  lunchMin: "lunch_min",
  pholMin: "phol_min",
  sickMin: "sick_min",
  arlMin: "arl_min",
  onsiteMin: "onsite_min",
};
const RULE_KEYS = {
  ordinaryMonThuMin: "pay.ordinary_mon_thu_min",
  ordinaryFriMin: "pay.ordinary_fri_min",
  otBandMin: "pay.ot_band_min",
};
const RULE_LABELS = {
  ordinaryMonThuMin: "Ordinary hours Mon–Thu",
  ordinaryFriMin: "Ordinary hours Fri",
  otBandMin: "Overtime hours before double time",
};
const SUMMARY_FIELDS = ["normalMin", "otMin", "dtMin", "pholMin", "arlMin", "sickMin", "onsiteMin", "workedMin"];

// ---------------------------------------------------------------- helpers ---

function nowIso() {
  return new Date().toISOString();
}

// A timestamp strictly after `prev` (an ISO string or null), so a save in the same millisecond
// still moves updated_at and the stale-sheet check keeps working.
function nextStamp(prev) {
  const now = Date.now();
  const p = prev ? Date.parse(prev) : NaN;
  return new Date(Number.isFinite(p) && now <= p ? p + 1 : now).toISOString();
}

function validDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = parseDateUTC(s);
  return !Number.isNaN(d.getTime()) && formatDateUTC(d) === s;
}

function weekdayOf(date) {
  return WEEKDAYS[parseDateUTC(date).getUTCDay()];
}

function daysBetween(from, to) {
  return Math.round((parseDateUTC(to).getTime() - parseDateUTC(from).getTime()) / 86400000);
}

function userId(req) {
  return (req && req.user && req.user.id) || null;
}

function bool(v) {
  return !!v;
}

// A positive integer id from a body value (number or digit string), else null.
function bodyId(v) {
  const n = typeof v === "string" && /^[1-9]\d*$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function byName(a, b) {
  const x = String(a.name || "").toLowerCase();
  const y = String(b.name || "").toLowerCase();
  if (x < y) return -1;
  if (x > y) return 1;
  return (a.id || 0) - (b.id || 0);
}

// "Mon 5 Oct": the date prefix of the save sentences.
function dayLabel(date) {
  return `${PayMaths.DAY_LABELS[PayMaths.dayKeyOf(date)]} ${PayMaths.shortDate(date)}`;
}

// ------------------------------------------------------------------ rules ---

// The section 3 rules object, from settings.
function rules(db) {
  const s = settings.getAll(db);
  return {
    anchor: s["pay.anchor"],
    ordinaryMonThuMin: Number(s["pay.ordinary_mon_thu_min"]),
    ordinaryFriMin: Number(s["pay.ordinary_fri_min"]),
    otBandMin: Number(s["pay.ot_band_min"]),
  };
}

// fortnightStartFor(today, anchor).
function currentStart(db, today = sydneyToday()) {
  return PayMaths.fortnightStartFor(today, rules(db).anchor);
}

// A run's rules: frozen when finalised, live while open.
function runRules(db, run) {
  if (run.status === "finalised" && run.rules_json) return JSON.parse(run.rules_json);
  return rules(db);
}

// ----------------------------------------------------------------- people ---

const PERSON_SQL = `SELECT p.id, p.worker_id, p.name AS own_name, p.on_pay_run, p.archived, p.first_name, p.surname,
                           w.name AS worker_name, w.archived AS worker_archived
                      FROM pay_people p LEFT JOIN workers w ON w.id = p.worker_id`;

// The pay name (Todd 2026-11-01): "SURNAME, Firstname" once a surname is set, the first name
// falling back to the board (or own) name; just that name until then.
function payName(base, first, surname) {
  const sn = (surname || "").trim();
  if (!sn) return base;
  return `${sn.toUpperCase()}, ${(first || "").trim() || base}`;
}

function personOut(row) {
  const isWorker = row.worker_id != null;
  const base = isWorker ? row.worker_name : row.own_name;
  return {
    id: row.id == null ? null : row.id,
    workerId: isWorker ? row.worker_id : null,
    name: payName(base, row.first_name, row.surname),
    baseName: base,
    firstName: row.first_name || "",
    surname: row.surname || "",
    kind: isWorker ? "worker" : "pay_only",
    onPayRun: row.on_pay_run == null ? true : bool(row.on_pay_run),
    archived: isWorker ? bool(row.worker_archived) : bool(row.archived),
  };
}

function personById(db, id) {
  const row = db.prepare(`${PERSON_SQL} WHERE p.id = ?`).get(id);
  return row ? personOut(row) : null;
}

// The person for a worker, with or without a pay_people row (null for an unknown worker).
function personForWorker(db, workerId) {
  const row = db
    .prepare(
      `SELECT p.id, w.id AS worker_id, NULL AS own_name, p.on_pay_run, p.archived, p.first_name, p.surname,
              w.name AS worker_name, w.archived AS worker_archived
         FROM workers w LEFT JOIN pay_people p ON p.worker_id = w.id
        WHERE w.id = ?`
    )
    .get(workerId);
  return row ? personOut(row) : null;
}

// Inserts the worker's pay_people row when it is missing; returns the person id.
function ensureWorkerRow(db, workerId) {
  const row = db.prepare("SELECT id FROM pay_people WHERE worker_id = ?").get(workerId);
  if (row) return row.id;
  const info = db.prepare("INSERT INTO pay_people (worker_id, on_pay_run) VALUES (?, 1)").run(workerId);
  return Number(info.lastInsertRowid);
}

function listPeople(db, { all = false } = {}) {
  const workers = db
    .prepare(
      `SELECT p.id, w.id AS worker_id, NULL AS own_name, p.on_pay_run, p.archived, p.first_name, p.surname,
              w.name AS worker_name, w.archived AS worker_archived
         FROM workers w LEFT JOIN pay_people p ON p.worker_id = w.id
        WHERE w.archived = 0
        ORDER BY w.sort_order, w.name COLLATE NOCASE, w.id`
    )
    .all();
  const payOnly = db
    .prepare(
      `${PERSON_SQL} WHERE p.worker_id IS NULL ${all ? "" : "AND p.archived = 0"}
        ORDER BY p.name COLLATE NOCASE, p.id`
    )
    .all();
  return [...workers, ...payOnly].map(personOut).sort(byName);
}

// Everyone on the pay run (section 5): active workers whose row is missing or on, then pay-only
// people who are on and not archived.
function onPayRun(db) {
  return listPeople(db).filter((p) => p.onPayRun && !p.archived);
}

function boolField(name, v) {
  if (typeof v !== "boolean") throw bad(`${name} must be true or false`);
  return v;
}

function personName(v) {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t || t.length > PERSON_NAME_MAX) throw bad(`Give a name of 1 to ${PERSON_NAME_MAX} characters`);
  return t;
}

function setWorkerOnPayRun(db, req, workerId, on) {
  const worker = db.prepare("SELECT id, archived FROM workers WHERE id = ?").get(workerId);
  if (!worker || worker.archived) throw notFound();
  const value = boolField("onPayRun", on);
  db.transaction(() => {
    const row = db.prepare("SELECT id, on_pay_run FROM pay_people WHERE worker_id = ?").get(workerId);
    if (row && bool(row.on_pay_run) === value) return; // nothing changes
    // A worker with no row is on the pay run; the first write gives them a row (upsert).
    let id;
    if (row) {
      id = row.id;
      db.prepare("UPDATE pay_people SET on_pay_run = ?, updated_at = ? WHERE id = ?").run(value ? 1 : 0, nowIso(), id);
    } else {
      const info = db.prepare("INSERT INTO pay_people (worker_id, on_pay_run) VALUES (?, ?)").run(workerId, value ? 1 : 0);
      id = Number(info.lastInsertRowid);
    }
    audit.log(req, {
      action: "payperson.update",
      entityType: "pay_person",
      entityId: id,
      before: row ? { workerId, onPayRun: bool(row.on_pay_run) } : null,
      after: { workerId, onPayRun: value },
    });
  })();
  return personForWorker(db, workerId);
}

function addPayOnly(db, req, { name } = {}) {
  const n = personName(name);
  const id = db.transaction(() => {
    const info = db.prepare("INSERT INTO pay_people (name, on_pay_run) VALUES (?, 1)").run(n);
    const newId = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "payperson.create",
      entityType: "pay_person",
      entityId: newId,
      after: { name: n, kind: "pay_only", onPayRun: true },
    });
    return newId;
  })();
  return personById(db, id);
}

// A pay first name and surname (0.2.11, Todd 2026-11-01), for a board worker or a pay-only person.
// Empty text clears a name. The board's worker name is never touched.
function payNameField(v, what) {
  if (v === null) return null;
  if (typeof v !== "string") throw bad(`The ${what} must be text`);
  const t = v.trim();
  if (t.length > PERSON_NAME_MAX) throw bad(`Keep the ${what} to ${PERSON_NAME_MAX} characters`);
  return t || null;
}
function setPayNames(db, req, personId, b) {
  const next = {};
  if (b.firstName !== undefined) next.first_name = payNameField(b.firstName, "first name");
  if (b.surname !== undefined) next.surname = payNameField(b.surname, "surname");
  if (!Object.keys(next).length) return;
  db.transaction(() => {
    const row = db.prepare("SELECT * FROM pay_people WHERE id = ?").get(personId);
    if (!row) throw notFound();
    const before = {};
    const after = {};
    for (const [c, v] of Object.entries(next)) {
      if ((row[c] || null) !== v) {
        before[c] = row[c] || null;
        after[c] = v;
      }
    }
    if (!Object.keys(after).length) return;
    const cols = Object.keys(after);
    db.prepare(`UPDATE pay_people SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
      ...cols.map((c) => after[c]),
      nowIso(),
      personId
    );
    audit.log(req, { action: "payperson.update", entityType: "pay_person", entityId: personId, before, after });
  })();
}
// PUT /people/worker/:workerId: {onPayRun?, firstName?, surname?}. Gives the worker a row if needed.
function updateWorkerPerson(db, req, workerId, body) {
  const b = body && typeof body === "object" ? body : {};
  const worker = db.prepare("SELECT id, archived FROM workers WHERE id = ?").get(workerId);
  if (!worker || worker.archived) throw notFound();
  if (b.onPayRun === undefined && b.firstName === undefined && b.surname === undefined) {
    throw bad("onPayRun must be true or false");
  }
  if (b.firstName !== undefined || b.surname !== undefined) {
    payNameField(b.firstName === undefined ? null : b.firstName, "first name");
    payNameField(b.surname === undefined ? null : b.surname, "surname");
    const id = db.transaction(() => ensureWorkerRow(db, workerId))();
    setPayNames(db, req, id, b);
  }
  if (b.onPayRun !== undefined) return setWorkerOnPayRun(db, req, workerId, b.onPayRun);
  return personForWorker(db, workerId);
}

function updatePerson(db, req, id, body) {
  const b = body && typeof body === "object" ? body : {};
  const row = db.prepare("SELECT * FROM pay_people WHERE id = ?").get(id);
  if (!row) throw notFound();
  const isWorker = row.worker_id != null;
  if (isWorker && (b.name !== undefined || b.archived !== undefined)) {
    throw bad("Board workers are changed on the Workers page");
  }
  const next = {};
  if (b.name !== undefined) next.name = personName(b.name);
  if (b.onPayRun !== undefined) next.onPayRun = boolField("onPayRun", b.onPayRun);
  if (b.archived !== undefined) next.archived = boolField("archived", b.archived);

  const current = { name: row.name, onPayRun: bool(row.on_pay_run), archived: bool(row.archived) };
  const before = {};
  const after = {};
  for (const k of Object.keys(next)) {
    if (next[k] !== current[k]) {
      before[k] = current[k];
      after[k] = next[k];
    }
  }
  setPayNames(db, req, id, b);
  if (Object.keys(after).length) {
    db.transaction(() => {
      db.prepare(
        `UPDATE pay_people SET name = ?, on_pay_run = ?, archived = ?, updated_at = ? WHERE id = ?`
      ).run(
        "name" in after ? after.name : row.name,
        ("onPayRun" in after ? after.onPayRun : current.onPayRun) ? 1 : 0,
        ("archived" in after ? after.archived : current.archived) ? 1 : 0,
        nowIso(),
        id
      );
      audit.log(req, { action: "payperson.update", entityType: "pay_person", entityId: id, before, after });
    })();
  }
  return personById(db, id);
}

// --------------------------------------------------------------- pay days ---

function dayFromRow(r) {
  const d = {};
  for (const f of HOUR_FIELDS) d[f] = r[HOUR_COLS[f]] == null ? null : Number(r[HOUR_COLS[f]]);
  d.job = r.job || "";
  return d;
}

function blankDay() {
  const d = {};
  for (const f of HOUR_FIELDS) d[f] = null;
  d.job = "";
  return d;
}

function isEmptyDay(d) {
  return HOUR_FIELDS.every((f) => d[f] == null) && d.job === "";
}

function sameDay(a, b) {
  return HOUR_FIELDS.every((f) => a[f] === b[f]) && a.job === b.job;
}

// {timesheetId: {date: stored day}} for the given sheet ids.
function storedDays(db, sheetIds) {
  const out = {};
  if (!sheetIds.length) return out;
  const rows = db
    .prepare(`SELECT * FROM pay_days WHERE timesheet_id IN (${sheetIds.map(() => "?").join(",")})`)
    .all(...sheetIds);
  for (const r of rows) {
    (out[r.timesheet_id] = out[r.timesheet_id] || {})[r.date] = dayFromRow(r);
  }
  return out;
}

// The ten rows of a sheet with the split, from {date: stored day}.
function tenDays(startDate, stored, rulesObj) {
  return PayMaths.fortnightDates(startDate).map((date) => {
    const key = PayMaths.dayKeyOf(date);
    const typed = (stored && stored[date]) || blankDay();
    return { date, day: key, ...typed, ...PayMaths.split(typed, key, rulesObj) };
  });
}

// ---------------------------------------------------------------- pay runs ---

function runRowOut(db, run) {
  const c = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(entered), 0) AS entered FROM pay_timesheets WHERE pay_run_id = ?`
    )
    .get(run.id);
  return {
    id: run.id,
    startDate: run.start_date,
    endDate: run.end_date,
    label: PayMaths.fortnightLabel(run.start_date),
    status: run.status,
    myobEnteredDate: run.myob_entered_date || null,
    timesheetCount: Number(c.n) || 0,
    enteredCount: Number(c.entered) || 0,
    finalisedAt: run.finalised_at || null,
  };
}

function loadRun(db, id) {
  return db.prepare("SELECT * FROM pay_runs WHERE id = ?").get(id) || null;
}

function runOr404(db, id) {
  const run = loadRun(db, id);
  if (!run) throw notFound();
  return run;
}

function listRuns(db) {
  return db
    .prepare("SELECT * FROM pay_runs ORDER BY start_date DESC")
    .all()
    .map((r) => runRowOut(db, r));
}

// The run's sheets with their person rows, by name.
function sheetsOf(db, runId) {
  return db
    .prepare(
      `SELECT t.*, p.id AS p_id, p.worker_id, p.name AS own_name, p.on_pay_run, p.archived AS p_archived, p.first_name, p.surname,
              w.name AS worker_name, w.archived AS worker_archived, ru.display_name AS reviewer_name,
              (SELECT status FROM pay_runs WHERE id = t.pay_run_id) AS run_status
         FROM pay_timesheets t
         JOIN pay_people p ON p.id = t.person_id
         LEFT JOIN workers w ON w.id = p.worker_id
         LEFT JOIN users ru ON ru.id = t.reviewed_by
        WHERE t.pay_run_id = ?
        ORDER BY t.name COLLATE NOCASE, t.id`
    )
    .all(runId)
    .map(liveName)
    .sort((a, b) => byName(a, b));
}

// An open run's sheets show the person's current pay name (so a surname added mid-fortnight shows
// at once); a finalised run keeps the name frozen at finalise. stored_name is the column as stored.
function liveName(t) {
  const out = { ...t, stored_name: t.name };
  if (t.run_status === "open") out.name = sheetPerson(t).name;
  return out;
}

function sheetPerson(t) {
  return personOut({
    id: t.p_id,
    worker_id: t.worker_id,
    own_name: t.own_name,
    on_pay_run: t.on_pay_run,
    archived: t.p_archived,
    worker_name: t.worker_name,
    worker_archived: t.worker_archived,
    first_name: t.first_name,
    surname: t.surname,
  });
}

// The admin review tick (0.2.11): {reviewed, reviewedBy, reviewedAt}.
function reviewOut(t) {
  const on = bool(t.admin_reviewed);
  return {
    reviewed: on,
    reviewedBy: on && t.reviewed_by != null ? { id: t.reviewed_by, name: t.reviewer_name || "" } : null,
    reviewedAt: on ? t.reviewed_at || null : null,
  };
}

// ---------------------------------------------------------------- day notes ---
// 0.2.17 (docs/plans/payrun-notes-plan.md): one admin note per person per day, keyed to the person
// and the date, never to a run or a sheet. Nothing here touches pay_timesheets or pay_runs.

// The fortnight a date belongs to, and whether its run exists: {startDate, endDate, label,
// payRunId, status}. Throws the 400s for a bad date, one before the first pay run, one past the end
// of next fortnight, or one that isn't a day of its fortnight.
function dayNoteFortnight(db, date) {
  if (!validDate(date)) throw bad("Pick a day in a pay run fortnight");
  const anchor = rules(db).anchor;
  if (date < anchor) throw bad("That day is before the first pay run");
  const nextEnd = PayMaths.endOf(PayMaths.addDays(currentStart(db), 14));
  if (date > nextEnd) throw bad("That day is too far ahead: notes go up to the end of next fortnight");
  const start = currentStart(db, date);
  if (!PayMaths.fortnightDates(start).includes(date)) throw bad("Pick a day in a pay run fortnight");
  const run = db.prepare("SELECT id, status FROM pay_runs WHERE start_date = ?").get(start);
  return {
    startDate: start,
    endDate: PayMaths.endOf(start),
    label: PayMaths.fortnightLabel(start),
    payRunId: run ? run.id : null,
    status: run ? run.status : "none",
  };
}

// {personId | workerId} -> {id, workerId, name}. Exactly one id; unknown or archived is a 404. A
// board worker with no pay_people row has id null (nothing is inserted here).
function dayNotePerson(db, { personId, workerId } = {}) {
  const hasPerson = personId !== undefined && personId !== null;
  const hasWorker = workerId !== undefined && workerId !== null;
  if (hasPerson === hasWorker) throw bad("Give a personId or a workerId");
  let p;
  if (hasPerson) {
    const id = bodyId(personId);
    p = id ? personById(db, id) : null;
  } else {
    const id = bodyId(workerId);
    p = id ? personForWorker(db, id) : null;
  }
  if (!p || p.archived) throw notFound();
  return { id: p.id, workerId: p.workerId, name: p.name };
}

function dayNoteOut(row) {
  return {
    note: row.note,
    by: row.updated_by != null ? { id: row.updated_by, name: row.by_name || "" } : null,
    updatedAt: row.updated_at,
  };
}

function loadDayNote(db, personId, date) {
  if (personId == null) return null;
  const row = db
    .prepare(
      `SELECT n.note, n.updated_by, n.updated_at, u.display_name AS by_name
         FROM pay_day_notes n LEFT JOIN users u ON u.id = n.updated_by
        WHERE n.person_id = ? AND n.date = ?`
    )
    .get(personId, date);
  return row ? dayNoteOut(row) : null;
}

function dayNoteAnswer(db, person, date, fortnight) {
  const hasSheet =
    fortnight.payRunId != null &&
    person.id != null &&
    !!db.prepare("SELECT 1 FROM pay_timesheets WHERE pay_run_id = ? AND person_id = ?").get(fortnight.payRunId, person.id);
  return { date, person, fortnight: { ...fortnight, hasSheet }, dayNote: loadDayNote(db, person.id, date) };
}

// GET /day-notes?personId|workerId&date. Never inserts.
function getDayNote(db, query) {
  const q = query && typeof query === "object" ? query : {};
  const person = dayNotePerson(db, { personId: q.personId, workerId: q.workerId });
  const fortnight = dayNoteFortnight(db, q.date);
  return dayNoteAnswer(db, person, q.date, fortnight);
}

// PUT /day-notes: {personId | workerId, date, note, updatedAt}. Empty (after trim) removes.
function setDayNote(db, req, body) {
  const b = body && typeof body === "object" ? body : {};
  const done = db.transaction(() => {
    let person = dayNotePerson(db, { personId: b.personId, workerId: b.workerId });
    const fortnight = dayNoteFortnight(db, b.date);
    if (typeof b.note !== "string") throw bad("Day notes must be text");
    const text = b.note.trim();
    if (text.length > DAY_NOTE_MAX) throw bad(`Day notes must be ${DAY_NOTE_MAX} characters or fewer`);
    if (b.updatedAt !== undefined && b.updatedAt !== null && typeof b.updatedAt !== "string") {
      throw bad("updatedAt must be text or null");
    }
    const sent = b.updatedAt === undefined ? null : b.updatedAt;
    if (fortnight.status === "finalised") {
      throw conflict("That fortnight's pay run is finalised; reopen it to change its notes");
    }
    const existing =
      person.id == null
        ? null
        : db.prepare("SELECT note, updated_at FROM pay_day_notes WHERE person_id = ? AND date = ?").get(person.id, b.date);
    if ((existing ? existing.updated_at : null) !== sent) {
      throw conflict("Someone else changed this note; reload it", { dayNote: loadDayNote(db, person.id, b.date) });
    }
    if ((existing ? existing.note : "") === text) return { person, fortnight }; // unchanged: no write, no audit
    if (person.id == null) person = { ...person, id: ensureWorkerRow(db, person.workerId) };
    const uid = userId(req);
    if (!text) {
      db.prepare("DELETE FROM pay_day_notes WHERE person_id = ? AND date = ?").run(person.id, b.date);
    } else if (existing) {
      db.prepare("UPDATE pay_day_notes SET note = ?, updated_by = ?, updated_at = ? WHERE person_id = ? AND date = ?").run(
        text,
        uid,
        nextStamp(existing.updated_at),
        person.id,
        b.date
      );
    } else {
      const stamp = nextStamp(null);
      db.prepare(
        "INSERT INTO pay_day_notes (person_id, date, note, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(person.id, b.date, text, uid, stamp, uid, stamp);
    }
    audit.log(req, {
      action: "payrun.daynote",
      entityType: "pay_person",
      entityId: person.id,
      before: { date: b.date, note: existing ? existing.note : null },
      after: { date: b.date, note: text || null },
    });
    return { person, fortnight };
  })();
  return dayNoteAnswer(db, done.person, b.date, done.fortnight);
}

// Notes in a run's dates, grouped by person: Map(person_id -> [{date, note, by, updatedAt}]), oldest
// day first. One query for the whole run.
function dayNotesForRun(db, run) {
  const dates = PayMaths.fortnightDates(run.start_date);
  const rows = db
    .prepare(
      `SELECT n.person_id, n.date, n.note, n.updated_by, n.updated_at, u.display_name AS by_name
         FROM pay_day_notes n LEFT JOIN users u ON u.id = n.updated_by
        WHERE n.date IN (${dates.map(() => "?").join(",")})
        ORDER BY n.date`
    )
    .all(...dates);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.person_id)) map.set(r.person_id, []);
    map.get(r.person_id).push({ date: r.date, ...dayNoteOut(r) });
  }
  return map;
}

// People with notes in the run but no sheet in it: [{person: {id, workerId, name}, count}].
function waitingDayNotes(db, notes, sheets) {
  const have = new Set(sheets.map((t) => t.person_id));
  const out = [];
  for (const [pid, list] of notes) {
    if (have.has(pid)) continue;
    const p = personById(db, pid);
    if (!p) continue;
    out.push({ person: { id: p.id, workerId: p.workerId, name: p.name }, count: list.length });
  }
  return out.sort((a, b) => byName(a.person, b.person));
}

function getRun(db, id) {
  const run = loadRun(db, id);
  if (!run) return null;
  const r = runRules(db, run);
  const sheets = sheetsOf(db, run.id);
  const stored = storedDays(db, sheets.map((t) => t.id));
  const by = run.finalised_by
    ? db.prepare("SELECT id, display_name FROM users WHERE id = ?").get(run.finalised_by)
    : null;
  const notes = dayNotesForRun(db, run);
  return {
    id: run.id,
    startDate: run.start_date,
    endDate: run.end_date,
    label: PayMaths.fortnightLabel(run.start_date),
    status: run.status,
    finalisedAt: run.finalised_at || null,
    finalisedBy: by ? { id: by.id, name: by.display_name } : null,
    myobEnteredDate: run.myob_entered_date || null,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    timesheets: sheets.map((t) => ({
      id: t.id,
      person: sheetPerson(t),
      name: t.name,
      entered: bool(t.entered),
      signed: bool(t.signed),
      ...reviewOut(t),
      saved: t.saved_at != null,
      totals: PayMaths.totals(tenDays(run.start_date, stored[t.id], r)),
      dayNoteCount: (notes.get(t.person_id) || []).length,
    })),
    waitingDayNotes: waitingDayNotes(db, notes, sheets),
  };
}

function createRun(db, req, { startDate } = {}) {
  const anchor = rules(db).anchor;
  const start = startDate === undefined || startDate === null || startDate === "" ? currentStart(db) : startDate;
  if (typeof start !== "string" || !validDate(start) || !PayMaths.onGrid(start, anchor)) {
    throw bad("That date doesn't start a pay fortnight");
  }
  const id = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM pay_runs WHERE start_date = ?").get(start)) {
      throw conflict("A pay run for that fortnight already exists");
    }
    const end = PayMaths.endOf(start);
    const info = db
      .prepare("INSERT INTO pay_runs (start_date, end_date, status, created_by) VALUES (?, ?, 'open', ?)")
      .run(start, end, userId(req));
    const runId = Number(info.lastInsertRowid);
    const insertSheet = db.prepare("INSERT INTO pay_timesheets (pay_run_id, person_id, name) VALUES (?, ?, ?)");
    const names = [];
    for (const p of onPayRun(db)) {
      const personId = p.id != null ? p.id : ensureWorkerRow(db, p.workerId);
      insertSheet.run(runId, personId, p.name);
      names.push(p.name);
    }
    audit.log(req, {
      action: "payrun.create",
      entityType: "pay_run",
      entityId: runId,
      after: { startDate: start, endDate: end, timesheets: names },
    });
    return runId;
  })();
  return getRun(db, id);
}

function deleteRun(db, req, id) {
  db.transaction(() => {
    const run = runOr404(db, id);
    const saved = db
      .prepare("SELECT COUNT(*) AS n FROM pay_timesheets WHERE pay_run_id = ? AND saved_at IS NOT NULL")
      .get(id).n;
    if (run.status !== "open" || Number(saved) > 0) {
      throw conflict("Only an open pay run with no sheets typed in can be deleted");
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM pay_timesheets WHERE pay_run_id = ?").get(id).n;
    db.prepare(
      "DELETE FROM pay_days WHERE timesheet_id IN (SELECT id FROM pay_timesheets WHERE pay_run_id = ?)"
    ).run(id);
    db.prepare("DELETE FROM pay_timesheets WHERE pay_run_id = ?").run(id);
    // A bonus share paid against this run (only possible if the run was finalised, then reopened)
    // keeps its paid date and loses only the pay-run note, which is all it is (M13 contracts
    // §12.2 item 1), so the delete never fails on the foreign key and says nothing about bonuses.
    db.prepare("UPDATE bonus_shares SET pay_run_id = NULL WHERE pay_run_id = ?").run(id);
    db.prepare("DELETE FROM pay_runs WHERE id = ?").run(id);
    audit.log(req, {
      action: "payrun.delete",
      entityType: "pay_run",
      entityId: id,
      before: { startDate: run.start_date, endDate: run.end_date, timesheetCount: Number(count) },
    });
  })();
}

function finalise(db, req, id) {
  db.transaction(() => {
    const run = runOr404(db, id);
    if (run.status === "finalised") throw conflict("This pay run is already finalised");
    // Freeze each sheet's name as the person's current name.
    for (const t of sheetsOf(db, id)) {
      const name = sheetPerson(t).name;
      if (name && name !== t.stored_name) db.prepare("UPDATE pay_timesheets SET name = ? WHERE id = ?").run(name, t.id);
    }
    const frozenRules = rules(db);
    const now = nowIso();
    db.prepare(
      `UPDATE pay_runs SET status = 'finalised', rules_json = ?, finalised_at = ?, finalised_by = ?,
              updated_at = ? WHERE id = ?`
    ).run(JSON.stringify(frozenRules), now, userId(req), now, id);
    const s = liveSummary(db, loadRun(db, id));
    s.frozen = true;
    db.prepare("UPDATE pay_runs SET summary_json = ? WHERE id = ?").run(JSON.stringify(s), id);
    audit.log(req, {
      action: "payrun.finalise",
      entityType: "pay_run",
      entityId: id,
      after: { startDate: run.start_date, rules: frozenRules, totals: s.totals },
    });
  })();
  return getRun(db, id);
}

function reopen(db, req, id) {
  db.transaction(() => {
    const run = runOr404(db, id);
    if (run.status === "open") throw conflict("This pay run is open");
    if (run.myob_entered_date) throw conflict("Untick Entered in MYOB first");
    const frozen = run.summary_json ? JSON.parse(run.summary_json) : null;
    db.prepare(
      `UPDATE pay_runs SET status = 'open', rules_json = NULL, summary_json = NULL, finalised_at = NULL,
              finalised_by = NULL, updated_at = ? WHERE id = ?`
    ).run(nowIso(), id);
    audit.log(req, {
      action: "payrun.reopen",
      entityType: "pay_run",
      entityId: id,
      before: {
        status: "finalised",
        finalisedAt: run.finalised_at,
        finalisedBy: run.finalised_by,
        totals: frozen ? frozen.totals : null,
      },
      after: { status: "open" },
    });
  })();
  return getRun(db, id);
}

function setMyob(db, req, id, entered) {
  runOr404(db, id);
  const value = boolField("entered", entered);
  db.transaction(() => {
    const run = runOr404(db, id);
    if (run.status !== "finalised") throw conflict("Finalise the pay run first");
    const before = run.myob_entered_date || null;
    const next = value ? before || sydneyToday() : null;
    if (next === before) return;
    db.prepare("UPDATE pay_runs SET myob_entered_date = ?, updated_at = ? WHERE id = ?").run(next, nowIso(), id);
    audit.log(req, {
      action: "payrun.myob",
      entityType: "pay_run",
      entityId: id,
      before: { myobEnteredDate: before },
      after: { myobEnteredDate: next },
    });
  })();
  return getRun(db, id);
}

// -------------------------------------------------------------- timesheets ---

function sheetRow(db, runId, tsId) {
  const row =
    db
      .prepare(
        `SELECT t.*, p.id AS p_id, p.worker_id, p.name AS own_name, p.on_pay_run, p.archived AS p_archived, p.first_name, p.surname,
                w.name AS worker_name, w.archived AS worker_archived, ru.display_name AS reviewer_name,
                (SELECT status FROM pay_runs WHERE id = t.pay_run_id) AS run_status
           FROM pay_timesheets t
           JOIN pay_people p ON p.id = t.person_id
           LEFT JOIN workers w ON w.id = p.worker_id
           LEFT JOIN users ru ON ru.id = t.reviewed_by
          WHERE t.id = ? AND t.pay_run_id = ?`
      )
      .get(tsId, runId);
  return row ? liveName(row) : null;
}

function getTimesheet(db, runId, tsId) {
  const run = loadRun(db, runId);
  if (!run) return null;
  const t = sheetRow(db, runId, tsId);
  if (!t) return null;
  const person = sheetPerson(t);
  const days = tenDays(run.start_date, storedDays(db, [t.id])[t.id], runRules(db, run));
  const dayNotes = {};
  for (const n of dayNotesForRun(db, run).get(t.person_id) || []) {
    dayNotes[n.date] = { note: n.note, by: n.by, updatedAt: n.updatedAt };
  }
  return {
    id: t.id,
    payRunId: run.id,
    runStatus: run.status,
    person,
    name: t.name,
    notes: t.notes || "",
    signed: bool(t.signed),
    entered: bool(t.entered),
    ...reviewOut(t),
    saved: t.saved_at != null,
    updatedAt: t.updated_at,
    days,
    totals: PayMaths.totals(days),
    dayNotes,
    suggestions: run.status === "open" ? suggestionsFor(db, run, person) : {},
  };
}

function addTimesheet(db, req, runId, { personId, workerId } = {}) {
  const tsId = db.transaction(() => {
    const run = runOr404(db, runId);
    if (run.status !== "open") throw conflict("This pay run is finalised");
    const hasPerson = personId !== undefined && personId !== null;
    const hasWorker = workerId !== undefined && workerId !== null;
    if (hasPerson === hasWorker) throw bad("Give a personId or a workerId");
    let pid;
    let name;
    if (hasPerson) {
      const id = bodyId(personId);
      const p = id && personById(db, id);
      if (!p || p.archived) throw notFound();
      pid = p.id;
      name = p.name;
    } else {
      const id = bodyId(workerId);
      const w = id && db.prepare("SELECT id, name, archived FROM workers WHERE id = ?").get(id);
      if (!w || w.archived) throw notFound();
      pid = ensureWorkerRow(db, w.id);
      name = w.name;
    }
    if (db.prepare("SELECT 1 FROM pay_timesheets WHERE pay_run_id = ? AND person_id = ?").get(runId, pid)) {
      throw conflict("That person already has a sheet in this pay run");
    }
    const info = db
      .prepare("INSERT INTO pay_timesheets (pay_run_id, person_id, name) VALUES (?, ?, ?)")
      .run(runId, pid, name);
    const newId = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "timesheet.add",
      entityType: "timesheet",
      entityId: newId,
      after: { payRunId: runId, personId: pid, name },
    });
    return newId;
  })();
  return getTimesheet(db, runId, tsId);
}

function removeTimesheet(db, req, runId, tsId) {
  db.transaction(() => {
    const run = runOr404(db, runId);
    const t = db.prepare("SELECT * FROM pay_timesheets WHERE id = ? AND pay_run_id = ?").get(tsId, runId);
    if (!t) throw notFound();
    if (run.status !== "open") throw conflict("This pay run is finalised");
    const days = db.prepare("SELECT COUNT(*) AS n FROM pay_days WHERE timesheet_id = ?").get(tsId).n;
    if (Number(days) > 0 || (t.notes || "") !== "") throw conflict("Clear the sheet before removing it");
    db.prepare("DELETE FROM pay_timesheets WHERE id = ?").run(tsId);
    audit.log(req, {
      action: "timesheet.remove",
      entityType: "timesheet",
      entityId: tsId,
      before: { payRunId: runId, personId: t.person_id, name: t.name },
    });
  })();
}

// Validates one sent day. Each hour field is null or an integer 0-1440 ("hours out of range");
// the order of start and finish is left to PayMaths.dayProblem, so "Finish must be after start"
// is the sentence for a finish at or before the start. (section 6.3) and returns the stored form.
function parseDay(raw, label) {
  const d = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const f of HOUR_FIELDS) {
    const v = d[f];
    if (v === undefined || v === null) {
      out[f] = null;
      continue;
    }
    if (!Number.isInteger(v) || v < 0 || v > DAY_MAX_MIN) throw bad(`${label}: hours out of range`);
    out[f] = v;
  }
  const problem = PayMaths.dayProblem(out);
  if (problem) throw bad(`${label}: ${problem}`);
  if (d.job === undefined || d.job === null) out.job = "";
  else if (typeof d.job !== "string") throw bad(`${label}: the job must be text`);
  else out.job = d.job.trim();
  if (out.job.length > JOB_MAX) throw bad(`${label}: the job must be ${JOB_MAX} characters or fewer`);
  return out;
}

function saveTimesheet(db, req, runId, tsId, body) {
  const b = body && typeof body === "object" ? body : {};
  db.transaction(() => {
    const run = runOr404(db, runId);
    const t = db.prepare("SELECT * FROM pay_timesheets WHERE id = ? AND pay_run_id = ?").get(tsId, runId);
    if (!t) throw notFound();
    if (run.status !== "open") throw conflict("This pay run is finalised");
    if (b.updatedAt !== t.updated_at) {
      throw conflict("Someone else saved this sheet; reload it", { timesheet: getTimesheet(db, runId, tsId) });
    }

    // Validate everything before writing anything.
    if (!Array.isArray(b.days)) throw bad("days must be a list");
    const dates = new Set(PayMaths.fortnightDates(run.start_date));
    const sent = {};
    for (const raw of b.days) {
      const date = raw && typeof raw === "object" ? raw.date : undefined;
      if (typeof date !== "string" || !DATE_RE.test(date)) throw bad("Each day needs a date");
      if (!dates.has(date)) throw bad(`${date} isn't in this pay run`);
      const label = dayLabel(date);
      if (sent[date]) throw bad(`${label}: this day is in the sheet twice`);
      sent[date] = parseDay(raw, label);
    }
    let notes = t.notes || "";
    if (b.notes !== undefined) {
      if (b.notes !== null && typeof b.notes !== "string") throw bad("Notes must be text");
      notes = b.notes == null ? "" : b.notes.trim();
      if (notes.length > NOTES_MAX) {
        throw bad(`Notes must be ${NOTES_MAX.toLocaleString("en-AU")} characters or fewer`);
      }
    }
    const signed = b.signed === undefined ? bool(t.signed) : boolField("signed", b.signed);
    const entered = b.entered === undefined ? bool(t.entered) : boolField("entered", b.entered);

    // The changes, for the audit row.
    const old = storedDays(db, [tsId])[tsId] || {};
    const before = { days: {} };
    const after = { days: {} };
    for (const date of PayMaths.fortnightDates(run.start_date)) {
      const was = old[date] || blankDay();
      const now = sent[date] && !isEmptyDay(sent[date]) ? sent[date] : blankDay();
      if (!sameDay(was, now)) {
        before.days[date] = isEmptyDay(was) ? null : was;
        after.days[date] = isEmptyDay(now) ? null : now;
      }
    }
    if (notes !== (t.notes || "")) {
      before.notes = t.notes || "";
      after.notes = notes;
    }
    if (signed !== bool(t.signed)) {
      before.signed = bool(t.signed);
      after.signed = signed;
    }
    if (entered !== bool(t.entered)) {
      before.entered = bool(t.entered);
      after.entered = entered;
    }

    // A save that changes nothing writes nothing: no stamp, no "saved", no audit row.
    if (Object.keys(before.days).length === 0 && Object.keys(before).length === 1) return;

    db.prepare("DELETE FROM pay_days WHERE timesheet_id = ?").run(tsId);
    const ins = db.prepare(
      `INSERT INTO pay_days (timesheet_id, date, start_min, finish_min, lunch_min, phol_min, sick_min, arl_min,
                             onsite_min, job)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const date of Object.keys(sent)) {
      const d = sent[date];
      if (isEmptyDay(d)) continue;
      ins.run(tsId, date, ...HOUR_FIELDS.map((f) => d[f]), d.job);
    }
    const stamp = nextStamp(t.updated_at);
    db.prepare(
      `UPDATE pay_timesheets SET notes = ?, signed = ?, entered = ?, saved_at = COALESCE(saved_at, ?),
              updated_at = ? WHERE id = ?`
    ).run(notes, signed ? 1 : 0, entered ? 1 : 0, stamp, stamp, tsId);
    // Changed hours need a fresh admin review (Todd 2026-11-01); notes and ticks don't.
    if (bool(t.admin_reviewed) && Object.keys(before.days).length) {
      db.prepare("UPDATE pay_timesheets SET admin_reviewed = 0, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?").run(tsId);
      before.reviewed = true;
      after.reviewed = false;
    }
    audit.log(req, {
      action: "timesheet.update",
      entityType: "timesheet",
      entityId: tsId,
      before,
      after,
    });
  })();
  return getTimesheet(db, runId, tsId);
}

// An admin's review tick on one sheet (0.2.11). Open runs only. Doesn't touch updated_at, so
// someone typing in the sheet isn't told it was saved meanwhile.
function setReviewed(db, req, runId, tsId, reviewed) {
  const value = boolField("reviewed", reviewed);
  db.transaction(() => {
    const run = runOr404(db, runId);
    const t = db.prepare("SELECT * FROM pay_timesheets WHERE id = ? AND pay_run_id = ?").get(tsId, runId);
    if (!t) throw notFound();
    if (run.status !== "open") throw conflict("This pay run is finalised");
    if (value === bool(t.admin_reviewed)) return;
    db.prepare("UPDATE pay_timesheets SET admin_reviewed = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(
      value ? 1 : 0,
      value ? userId(req) : null,
      value ? nowIso() : null,
      tsId
    );
    audit.log(req, { action: "timesheet.review", entityType: "timesheet", entityId: tsId, before: { reviewed: !value }, after: { reviewed: value } });
  })();
  return getTimesheet(db, runId, tsId);
}

// {date: suggestion} for the run's ten dates (section 5). `run` is a pay_runs row or a run
// object; `person` a person object. Never stored.
function suggestionsFor(db, run, person) {
  const start = run.start_date || run.startDate;
  const end = PayMaths.endOf(start);
  const r = rules(db);
  const dates = PayMaths.fortnightDates(start);
  const out = {};
  for (const date of dates) {
    out[date] = { job: "", pholMin: null, sickMin: null, arlMin: null, reason: null, holidayName: null };
  }

  const holidays = db.prepare("SELECT date, name FROM public_holidays WHERE date >= ? AND date <= ?").all(start, end);
  const holidayOn = {};
  for (const h of holidays) holidayOn[h.date] = h.name;

  const workerId = person && person.workerId;
  const jobsOn = {};
  const leaveOn = {};
  let daysOff = [];
  if (workerId) {
    const w = db.prepare("SELECT regular_days_off FROM workers WHERE id = ?").get(workerId);
    daysOff = parseDaysOff(w && w.regular_days_off);
    const weeks = [mondayOf(start), mondayOf(addDays(start, 7))];
    const rows = db
      .prepare(
        `SELECT wr.week_start, a.day, j.name, j.quote_number
           FROM assignments a
           JOIN week_rows wr ON wr.id = a.week_row_id
           JOIN jobs j ON j.id = wr.job_id
          WHERE a.worker_id = ? AND wr.week_start IN (?, ?)
          ORDER BY wr.week_start, CASE wr.panel WHEN 'manufacturing' THEN 0 ELSE 1 END,
                   wr.sort_order, wr.id, a.id`
      )
      .all(workerId, weeks[0], weeks[1]);
    const offset = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, wknd: 5 }; // Weekend suggests Saturday only
    for (const row of rows) {
      const date = addDays(row.week_start, offset[row.day]);
      const qn = row.quote_number ? String(row.quote_number).trim() : "";
      const text = qn ? `${row.name} (${qn})` : row.name;
      const list = (jobsOn[date] = jobsOn[date] || []);
      if (!list.includes(text)) list.push(text);
    }
    const leave = db
      .prepare(
        `SELECT kind, date_from, date_to FROM leave
          WHERE worker_id = ? AND removed_at IS NULL AND date_from <= ? AND date_to >= ?
          ORDER BY id`
      )
      .all(workerId, end, start);
    for (const l of leave) {
      for (const date of dates) {
        if (date >= l.date_from && date <= l.date_to && (!leaveOn[date] || leaveOn[date] === "other")) leaveOn[date] = l.kind;
      }
    }
  }

  for (const date of dates) {
    const s = out[date];
    const ordinary = PayMaths.ordinaryFor(PayMaths.dayKeyOf(date), r);
    if (jobsOn[date]) s.job = jobsOn[date].join(" / ");
    if (daysOff.includes(PayMaths.dayKeyOf(date))) {
      s.reason = "dayoff"; // a regular day off: no leave or holiday hours (Todd, 2026-10-12)
    } else if (holidayOn[date] !== undefined) {
      s.pholMin = ordinary;
      s.reason = "holiday";
      s.holidayName = holidayOn[date];
    } else if (leaveOn[date] === "leave") {
      s.arlMin = ordinary;
      s.reason = "leave";
    } else if (leaveOn[date] === "sick") {
      s.sickMin = ordinary;
      s.reason = "sick";
    } else if (leaveOn[date] === "other") {
      s.reason = "other";
    }
  }
  return out;
}

// ----------------------------------------------------------------- summary ---

function emptyTotals() {
  const t = {};
  for (const f of SUMMARY_FIELDS) t[f] = 0;
  return t;
}

function liveSummary(db, run) {
  const r = runRules(db, run);
  const sheets = sheetsOf(db, run.id);
  const stored = storedDays(db, sheets.map((t) => t.id));
  const notes = dayNotesForRun(db, run);
  const totals = emptyTotals();
  const rows = sheets
    .map((t) => {
      const tt = PayMaths.totals(tenDays(run.start_date, stored[t.id], r));
      const row = { timesheetId: t.id, name: t.name };
      for (const f of SUMMARY_FIELDS) {
        row[f] = tt[f];
        totals[f] += tt[f];
      }
      row.notes = t.notes || "";
      row.signed = bool(t.signed);
      row.entered = bool(t.entered);
      row.dayNotes = (notes.get(t.person_id) || []).map((n) => ({ date: n.date, note: n.note }));
      return row;
    })
    .sort((a, b) => byName({ name: a.name, id: a.timesheetId }, { name: b.name, id: b.timesheetId }));
  return { payRun: runRowOut(db, run), rules: r, frozen: false, rows, totals };
}

// Section 6.4. A finalised run answers its frozen copy (payRun is the run's current row, so the
// MYOB tick shows); an open run is worked out live.
function summary(db, runId) {
  const run = runOr404(db, runId);
  if (run.status === "finalised" && run.summary_json) {
    const s = JSON.parse(run.summary_json);
    s.payRun = runRowOut(db, run);
    s.frozen = true;
    return s;
  }
  return liveSummary(db, run);
}

// ---------------------------------------------------------------- holidays ---

function holidayOut(h) {
  return { date: h.date, name: h.name, weekday: weekdayOf(h.date) };
}

function listHolidays(db, { from, to } = {}) {
  const today = sydneyToday();
  const f = from === undefined || from === "" ? addDays(today, -31) : from;
  const t = to === undefined || to === "" ? addDays(today, 400) : to;
  if (!validDate(f)) throw bad("from must be a date (YYYY-MM-DD)");
  if (!validDate(t)) throw bad("to must be a date (YYYY-MM-DD)");
  if (t < f) throw bad("to must be on or after from");
  if (daysBetween(f, t) > HOLIDAY_SPAN_MAX) throw bad(`Ask for at most ${HOLIDAY_SPAN_MAX} days of holidays`);
  return db
    .prepare("SELECT date, name FROM public_holidays WHERE date >= ? AND date <= ? ORDER BY date")
    .all(f, t)
    .map(holidayOut);
}

function addHoliday(db, req, { date, name } = {}) {
  if (!validDate(date)) throw bad("Give a valid date");
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || n.length > HOLIDAY_NAME_MAX) throw bad(`Give a name of 1 to ${HOLIDAY_NAME_MAX} characters`);
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM public_holidays WHERE date = ?").get(date)) {
      throw conflict("That date is already a public holiday");
    }
    db.prepare("INSERT INTO public_holidays (date, name, created_by) VALUES (?, ?, ?)").run(date, n, userId(req));
    audit.log(req, { action: "holiday.create", entityType: "holiday", entityId: date, after: { date, name: n } });
  })();
  return holidayOut({ date, name: n });
}

function removeHoliday(db, req, date) {
  if (!validDate(date)) throw notFound();
  db.transaction(() => {
    const h = db.prepare("SELECT date, name FROM public_holidays WHERE date = ?").get(date);
    if (!h) throw notFound();
    db.prepare("DELETE FROM public_holidays WHERE date = ?").run(date);
    audit.log(req, {
      action: "holiday.remove",
      entityType: "holiday",
      entityId: date,
      before: { date: h.date, name: h.name },
    });
  })();
}

// ---------------------------------------------------------------- settings ---

function anchorLocked(db) {
  return !!db.prepare("SELECT 1 FROM pay_runs LIMIT 1").get();
}

function getSettings(db) {
  const r = rules(db);
  return {
    anchor: r.anchor,
    ordinaryMonThuMin: r.ordinaryMonThuMin,
    ordinaryFriMin: r.ordinaryFriMin,
    otBandMin: r.otBandMin,
    anchorLocked: anchorLocked(db),
  };
}

function putSettings(db, req, body) {
  const b = body && typeof body === "object" ? body : {};
  const writes = {};
  for (const k of Object.keys(RULE_KEYS)) {
    if (b[k] === undefined) continue;
    const v = b[k];
    if (!Number.isInteger(v) || v < 0 || v > RULE_MAX_MIN) {
      throw bad(`${RULE_LABELS[k]} must be a whole number of minutes from 0 to ${RULE_MAX_MIN}`);
    }
    writes[RULE_KEYS[k]] = String(v);
  }
  let anchor;
  if (b.anchor !== undefined) {
    if (!validDate(b.anchor) || PayMaths.dayKeyOf(b.anchor) !== "mon") {
      throw bad("The fortnight must start on a Monday");
    }
    anchor = b.anchor;
  }
  db.transaction(() => {
    if (anchor !== undefined && anchor !== rules(db).anchor) {
      if (anchorLocked(db)) throw conflict("The fortnight start can't change once a pay run exists");
      writes["pay.anchor"] = anchor;
    }
    for (const key of Object.keys(writes)) settings.set(db, key, writes[key], req);
  })();
  return getSettings(db);
}

module.exports = {
  // M13 (docs/plans/m13-contracts.md section 1, Problem 3): for the bonus and alarm holders.
  ensureWorkerRow,
  personById,
  rules,
  currentStart,
  listPeople,
  setWorkerOnPayRun,
  addPayOnly,
  updatePerson,
  updateWorkerPerson,
  dayNoteFortnight,
  getDayNote,
  setDayNote,
  listRuns,
  getRun,
  createRun,
  deleteRun,
  finalise,
  reopen,
  setMyob,
  addTimesheet,
  removeTimesheet,
  getTimesheet,
  saveTimesheet,
  setReviewed,
  suggestionsFor,
  summary,
  listHolidays,
  addHoliday,
  removeHoliday,
  getSettings,
  putSettings,
};
