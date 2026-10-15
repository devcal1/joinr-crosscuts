// Alarm holders (docs/plans/m13-contracts.md section 5.2): the panel's user slots, their holders and
// codes (encrypted by lib/alarmcode.js), the alarm company, the weekly times and the leavers.
// Wave 1 C.
//
// Every function takes db first and nothing here requires ../db. Every write runs in one
// db.transaction with its audit row (entity types alarm_slot, alarm_company and alarm_times only,
// section 3.6). No alarm code ever appears in a log line, an error, an audit row or a GET answer:
// a slot carries only code.set / code.readable, the audit row says "set", "changed" or "cleared",
// and only reveal() answers with a code (section 5.3).
const audit = require("./audit");
const payroll = require("./payroll");
const alarmcode = require("./alarmcode");
const { bad, notFound, conflict } = require("./httperror");
const { DATE_RE, sydneyToday, parseDateUTC, formatDateUTC } = require("./time");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
// HH:MM, the same rule as lib/time.js's TIME_RE (which that file doesn't export).
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CODE_RE = /^[0-9]{1,12}$/;
const TYPES = ["office", "staff", "temp"];
const SLOT_KEYS = new Set(["slot", "personId", "workerId", "holderName", "type", "givenDate", "note", "code"]);
const HOLDER_NAME_MAX = 100;
const NOTE_MAX = 500;
const COMPANY = [
  { key: "name", col: "name", max: 200, label: "Company" },
  { key: "accountNumber", col: "account_number", max: 100, label: "Account number" },
  { key: "contactName", col: "contact_name", max: 200, label: "Contact" },
  { key: "phone", col: "phone", max: 50, label: "Phone" },
];
const COMPANY_KEYS = new Map(COMPANY.map((f) => [f.key, f]));

const MSG_HOLDER = "Give the holder: a person or a name";
const MSG_PERSON = "Holder must be a person from the pay list";
const MSG_CODE = "The code must be 1 to 12 digits";
const MSG_SEVEN = "Give all seven days, Monday to Sunday";

// ---------------------------------------------------------------- helpers ---

function nowIso() {
  return new Date().toISOString();
}

function userId(req) {
  return req && req.user && req.user.id != null ? req.user.id : null;
}

function userRef(id, name) {
  return id == null ? null : { id, name: name || null };
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function validDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && formatDateUTC(parseDateUTC(s)) === s;
}

// "2026-10-03" -> "3 Oct 2026".
function dayLabel(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function unknownKeys(body, allowed) {
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) throw bad(`Unknown field: ${k}`);
  }
}

// ------------------------------------------------------------------ slots ---

const SLOT_SQL = `
  SELECT s.*, p.worker_id AS p_worker_id, p.name AS p_name, p.archived AS p_archived,
         w.name AS w_name, w.archived AS w_archived,
         uc.display_name AS code_set_by_name, uu.display_name AS updated_by_name
    FROM alarm_slots s
    LEFT JOIN pay_people p ON p.id = s.person_id
    LEFT JOIN workers w ON w.id = p.worker_id
    LEFT JOIN users uc ON uc.id = s.code_set_by
    LEFT JOIN users uu ON uu.id = s.updated_by`;

function slotRow(db, id) {
  return db.prepare(`${SLOT_SQL} WHERE s.id = ?`).get(id);
}

// The slot as the API shows it (section 5.2): never the code, only whether one is set and readable.
function slotOut(db, row) {
  const isPerson = row.person_id != null;
  const isWorker = isPerson && row.p_worker_id != null;
  const personArchived = isPerson ? !!(isWorker ? row.w_archived : row.p_archived) : null;
  const removedDate = row.removed_date || null;
  const set = row.code_ct != null;
  return {
    id: row.id,
    slot: row.slot,
    personId: isPerson ? row.person_id : null,
    name: isPerson ? (isWorker ? row.w_name : row.p_name) : row.holder_name,
    personArchived,
    type: row.holder_type,
    givenDate: row.given_date || null,
    removedDate,
    note: row.note || "",
    leaver: personArchived === true && removedDate === null,
    code: {
      set,
      readable: set ? alarmcode.readable(db, row) : false,
      setAt: set ? row.code_set_at : null,
      setBy: set ? userRef(row.code_set_by, row.code_set_by_name) : null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: userRef(row.updated_by, row.updated_by_name),
  };
}

function getSlot(db, id) {
  const row = slotRow(db, id);
  if (!row) throw notFound();
  return slotOut(db, row);
}

function slotInUse(db, slot, exceptId) {
  const other = db
    .prepare("SELECT id FROM alarm_slots WHERE slot = ? AND removed_date IS NULL AND id <> ?")
    .get(slot, exceptId == null ? 0 : exceptId);
  if (other) throw conflict(`Slot ${slot} is already in use`);
}

// --- body checks (section 5.2) ---

function slotNumber(v) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 999) {
    throw bad("The slot number must be a whole number from 1 to 999");
  }
  return v;
}

function holderType(v) {
  if (typeof v !== "string" || !TYPES.includes(v)) throw bad("The type must be office, staff or temp");
  return v;
}

function givenDate(v, today) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !validDate(v.trim())) throw bad("Date given must be a date");
  const d = v.trim();
  if (d > today) throw bad("The date given can't be in the future");
  return d;
}

function noteText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") throw bad("Note must be text");
  const t = v.trim();
  if (t.length > NOTE_MAX) throw bad(`Note must be ${NOTE_MAX} characters or fewer`);
  return t;
}

// A code: null (clear) or 1 to 12 digits once trimmed, leading zeros kept. The sentence never
// repeats the value.
function codeValue(v) {
  if (v === null) return null;
  if (typeof v !== "string") throw bad(MSG_CODE);
  const t = v.trim();
  if (!CODE_RE.test(t)) throw bad(MSG_CODE);
  return t;
}

// The holder named in the body: {kind: "person", personId?, workerId?} or {kind: "name", name}, or
// null when the body names none. Exactly one of personId / workerId / holderName.
function holderInput(body) {
  const present = ["personId", "workerId", "holderName"].filter((k) => has(body, k) && body[k] !== undefined);
  if (!present.length) return null;
  if (present.length > 1) throw bad(MSG_HOLDER);
  const k = present[0];
  const v = body[k];
  if (k === "holderName") {
    if (typeof v !== "string" || !v.trim()) throw bad(MSG_HOLDER);
    const t = v.trim();
    if (t.length > HOLDER_NAME_MAX) throw bad(`Holder name must be ${HOLDER_NAME_MAX} characters or fewer`);
    return { kind: "name", name: t };
  }
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw bad(MSG_PERSON);
  return k === "personId" ? { kind: "person", personId: v } : { kind: "person", workerId: v };
}

// Resolves a person holder to a pay_people id (inside the caller's transaction: a worker with no row
// yet gets one). An archived person can't be newly chosen, but stays where already set
// (currentPersonId).
function resolvePerson(db, h, currentPersonId) {
  if (h.personId != null) {
    const p = payroll.personById(db, h.personId);
    if (!p) throw bad(MSG_PERSON);
    if (p.archived && p.id !== currentPersonId) throw bad(MSG_PERSON);
    return p.id;
  }
  const w = db.prepare("SELECT id, archived FROM workers WHERE id = ?").get(h.workerId);
  if (!w) throw bad(MSG_PERSON);
  const existing = db.prepare("SELECT id FROM pay_people WHERE worker_id = ?").get(w.id);
  if (w.archived && !(existing && existing.id === currentPersonId)) throw bad(MSG_PERSON);
  return payroll.ensureWorkerRow(db, w.id);
}

function writeCode(db, req, id, code, stamp) {
  if (code === null) {
    db.prepare(
      `UPDATE alarm_slots SET code_ct = NULL, code_iv = NULL, code_tag = NULL, code_key_id = NULL,
              code_set_at = NULL, code_set_by = NULL WHERE id = ?`
    ).run(id);
    return;
  }
  const enc = alarmcode.encrypt(db, id, code);
  db.prepare(
    `UPDATE alarm_slots SET code_ct = ?, code_iv = ?, code_tag = ?, code_key_id = ?, code_set_at = ?, code_set_by = ?
      WHERE id = ?`
  ).run(enc.ct, enc.iv, enc.tag, enc.keyId, stamp, userId(req), id);
}

// --- the actions ---

function createSlot(db, req, body) {
  const b = isPlainObject(body) ? body : {};
  unknownKeys(b, SLOT_KEYS);
  const today = sydneyToday();
  const slot = slotNumber(b.slot);
  const holder = holderInput(b);
  if (!holder) throw bad(MSG_HOLDER);
  const type = holderType(b.type);
  const given = givenDate(b.givenDate, today);
  const note = noteText(b.note);
  const code = has(b, "code") && b.code !== undefined ? codeValue(b.code) : null;

  const id = db.transaction(() => {
    const personId = holder.kind === "person" ? resolvePerson(db, holder, null) : null;
    slotInUse(db, slot, null);
    const holderName = holder.kind === "name" ? holder.name : null;
    const stamp = nowIso();
    const info = db
      .prepare(
        `INSERT INTO alarm_slots (slot, person_id, holder_name, holder_type, given_date, note,
                                  created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(slot, personId, holderName, type, given, note, stamp, userId(req), stamp, userId(req));
    const newId = Number(info.lastInsertRowid);
    if (code !== null) writeCode(db, req, newId, code, stamp);
    const after = { slot, personId, holderName, type, givenDate: given, note };
    if (code !== null) after.code = "set";
    audit.log(req, { action: "alarm_slot.create", entityType: "alarm_slot", entityId: newId, after });
    return newId;
  })();
  return getSlot(db, id);
}

function updateSlot(db, req, id, body) {
  const row = slotRow(db, id);
  if (!row) throw notFound();
  if (row.removed_date) throw conflict(`Slot ${row.slot} was removed; restore it to change it`);
  const b = isPlainObject(body) ? body : {};
  unknownKeys(b, SLOT_KEYS);
  const today = sydneyToday();
  const next = {};
  if (has(b, "slot") && b.slot !== undefined) next.slot = slotNumber(b.slot);
  const holder = holderInput(b);
  if (has(b, "type") && b.type !== undefined) next.type = holderType(b.type);
  if (has(b, "givenDate") && b.givenDate !== undefined) next.givenDate = givenDate(b.givenDate, today);
  if (has(b, "note") && b.note !== undefined) next.note = noteText(b.note);
  const codeSent = has(b, "code") && b.code !== undefined;
  const code = codeSent ? codeValue(b.code) : undefined;

  db.transaction(() => {
    const current = {
      slot: row.slot,
      personId: row.person_id,
      holderName: row.holder_name,
      type: row.holder_type,
      givenDate: row.given_date || null,
      note: row.note || "",
    };
    if (holder) {
      next.personId = holder.kind === "person" ? resolvePerson(db, holder, row.person_id) : null;
      next.holderName = holder.kind === "name" ? holder.name : null;
    }
    const before = {};
    const after = {};
    for (const k of Object.keys(next)) {
      if (next[k] !== current[k]) {
        before[k] = current[k];
        after[k] = next[k];
      }
    }
    if ("slot" in after) slotInUse(db, after.slot, row.id);

    // The code: only the words, never the value (section 3.6). A code equal to the stored one is
    // still re-encrypted and "changed" (comparing would mean decrypting).
    const hadCode = row.code_ct != null;
    let codeWord = null;
    if (codeSent) {
      if (code === null) codeWord = hadCode ? "cleared" : null;
      else codeWord = hadCode ? "changed" : "set";
    }
    if (!Object.keys(after).length && !codeWord) return; // nothing changed: no write, no audit row

    const stamp = nowIso();
    const merged = { ...current, ...next };
    db.prepare(
      `UPDATE alarm_slots SET slot = ?, person_id = ?, holder_name = ?, holder_type = ?, given_date = ?, note = ?,
              updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(merged.slot, merged.personId, merged.holderName, merged.type, merged.givenDate, merged.note, stamp, userId(req), row.id);
    if (codeWord) {
      writeCode(db, req, row.id, code, stamp);
      after.code = codeWord;
    }
    audit.log(req, { action: "alarm_slot.update", entityType: "alarm_slot", entityId: row.id, before, after });
  })();
  return getSlot(db, id);
}

function removeSlot(db, req, id, body) {
  const row = slotRow(db, id);
  if (!row) throw notFound();
  const b = isPlainObject(body) ? body : {};
  unknownKeys(b, new Set(["removedDate"]));
  if (row.removed_date) throw conflict(`Slot ${row.slot} is already removed`);
  const today = sydneyToday();
  let date = today;
  if (b.removedDate !== undefined && b.removedDate !== null && b.removedDate !== "") {
    if (typeof b.removedDate !== "string" || !validDate(b.removedDate.trim())) throw bad("The removed date must be a date");
    date = b.removedDate.trim();
  }
  if (date > today) throw bad("The removed date can't be in the future");
  if (row.given_date && date < row.given_date) {
    throw bad(`The removed date can't be before the date given (${dayLabel(row.given_date)})`);
  }
  db.transaction(() => {
    const stamp = nowIso();
    const hadCode = row.code_ct != null;
    db.prepare(
      `UPDATE alarm_slots SET removed_date = ?, code_ct = NULL, code_iv = NULL, code_tag = NULL, code_key_id = NULL,
              code_set_at = NULL, code_set_by = NULL, updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(date, stamp, userId(req), row.id);
    const after = { removedDate: date };
    if (hadCode) after.code = "cleared";
    audit.log(req, {
      action: "alarm_slot.remove",
      entityType: "alarm_slot",
      entityId: row.id,
      before: { removedDate: null },
      after,
    });
  })();
  return getSlot(db, id);
}

function restoreSlot(db, req, id) {
  const row = slotRow(db, id);
  if (!row) throw notFound();
  if (!row.removed_date) throw conflict(`Slot ${row.slot} isn't removed`);
  db.transaction(() => {
    slotInUse(db, row.slot, row.id);
    db.prepare("UPDATE alarm_slots SET removed_date = NULL, updated_at = ?, updated_by = ? WHERE id = ?").run(
      nowIso(),
      userId(req),
      row.id
    );
    audit.log(req, {
      action: "alarm_slot.restore",
      entityType: "alarm_slot",
      entityId: row.id,
      before: { removedDate: row.removed_date },
      after: { removedDate: null },
    });
  })();
  return getSlot(db, id);
}

// {code}: the only answer that carries one (the route adds Cache-Control: no-store). Check order as
// section 5.3; the audit row names the slot number only.
function reveal(db, req, id) {
  const row = slotRow(db, id);
  if (!row) throw notFound();
  const code = alarmcode.decrypt(db, row);
  db.transaction(() => {
    audit.log(req, { action: "alarm_slot.reveal", entityType: "alarm_slot", entityId: row.id, after: { slot: row.slot } });
  })();
  return { code };
}

// ---------------------------------------------------- company and times ---

function companyOut(db) {
  const r = db.prepare("SELECT * FROM alarm_company WHERE id = 1").get() || {};
  return {
    name: r.name || "",
    accountNumber: r.account_number || "",
    contactName: r.contact_name || "",
    phone: r.phone || "",
    updatedAt: r.updated_at || null,
  };
}

function putCompany(db, req, body) {
  const b = isPlainObject(body) ? body : {};
  // Any other key is refused, so there is nowhere to put a monitoring password (Decision 6).
  for (const k of Object.keys(b)) if (!COMPANY_KEYS.has(k)) throw bad(`Unknown field: ${k}`);
  const next = {};
  for (const f of COMPANY) {
    if (!has(b, f.key) || b[f.key] === undefined) continue;
    const v = b[f.key];
    if (v !== null && typeof v !== "string") throw bad(`${f.label} must be text`);
    const t = v === null ? "" : v.trim();
    if (t.length > f.max) throw bad(`${f.label} must be ${f.max} characters or fewer`);
    next[f.key] = t;
  }
  const current = companyOut(db);
  const before = {};
  const after = {};
  for (const k of Object.keys(next)) {
    if (next[k] !== current[k]) {
      before[k] = current[k];
      after[k] = next[k];
    }
  }
  if (Object.keys(after).length) {
    db.transaction(() => {
      const m = { ...current, ...after };
      db.prepare(
        `UPDATE alarm_company SET name = ?, account_number = ?, contact_name = ?, phone = ?, updated_at = ?, updated_by = ?
          WHERE id = 1`
      ).run(m.name, m.accountNumber, m.contactName, m.phone, nowIso(), userId(req));
      audit.log(req, { action: "alarm_company.update", entityType: "alarm_company", entityId: 1, before, after });
    })();
  }
  return companyOut(db);
}

function timesOut(db) {
  const rows = db.prepare("SELECT day, arms_at, disarms_at FROM alarm_times ORDER BY day").all();
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return DAY_LABELS.map((label, i) => {
    const r = byDay.get(i + 1) || {};
    return { day: i + 1, label, armsAt: r.arms_at || null, disarmsAt: r.disarms_at || null };
  });
}

function timeValue(v, label, which) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !TIME_RE.test(v.trim())) throw bad(`${label} ${which} must be a time (HH:MM)`);
  return v.trim();
}

function putTimes(db, req, body) {
  const b = isPlainObject(body) ? body : {};
  unknownKeys(b, new Set(["days"]));
  const days = b.days;
  if (!Array.isArray(days) || days.length !== 7) throw bad(MSG_SEVEN);
  const seen = new Set();
  for (const d of days) {
    if (!isPlainObject(d) || typeof d.day !== "number" || !Number.isInteger(d.day) || d.day < 1 || d.day > 7 || seen.has(d.day)) {
      throw bad(MSG_SEVEN);
    }
    seen.add(d.day);
  }
  const next = new Map();
  for (const d of [...days].sort((x, y) => x.day - y.day)) {
    unknownKeys(d, new Set(["day", "armsAt", "disarmsAt"]));
    const label = DAY_LABELS[d.day - 1];
    next.set(d.day, { day: d.day, armsAt: timeValue(d.armsAt, label, "arms at"), disarmsAt: timeValue(d.disarmsAt, label, "disarms at") });
  }
  const current = timesOut(db);
  const before = [];
  const after = [];
  for (const c of current) {
    const n = next.get(c.day);
    if (n.armsAt !== c.armsAt || n.disarmsAt !== c.disarmsAt) {
      before.push({ day: c.day, armsAt: c.armsAt, disarmsAt: c.disarmsAt });
      after.push(n);
    }
  }
  if (after.length) {
    db.transaction(() => {
      const stamp = nowIso();
      const upd = db.prepare("UPDATE alarm_times SET arms_at = ?, disarms_at = ?, updated_at = ?, updated_by = ? WHERE day = ?");
      for (const n of after) upd.run(n.armsAt, n.disarmsAt, stamp, userId(req), n.day);
      audit.log(req, { action: "alarm_times.update", entityType: "alarm_times", entityId: null, before, after });
    })();
  }
  return timesOut(db);
}

// --------------------------------------------------- overview and summary ---

function overview(db) {
  const rows = db
    .prepare(`${SLOT_SQL} ORDER BY (s.removed_date IS NOT NULL), s.slot, s.removed_date DESC, s.id DESC`)
    .all();
  const inUse = rows.filter((r) => !r.removed_date);
  const removed = rows
    .filter((r) => r.removed_date)
    .sort((a, b) => (a.removed_date < b.removed_date ? 1 : a.removed_date > b.removed_date ? -1 : b.id - a.id));
  return {
    slots: [...inUse, ...removed].map((r) => slotOut(db, r)),
    company: companyOut(db),
    times: timesOut(db),
    keyState: alarmcode.keyState(db),
    people: payroll.listPeople(db),
  };
}

// {leavers: [{id, slot, name}]}: slots in use whose holder is a person who has left (a pay-only
// person archived, or a board worker archived), by slot number. Typed names are never leavers.
function summary(db) {
  const rows = db
    .prepare(
      `${SLOT_SQL}
        WHERE s.removed_date IS NULL AND s.person_id IS NOT NULL
          AND ((p.worker_id IS NULL AND p.archived = 1) OR (p.worker_id IS NOT NULL AND w.archived = 1))
        ORDER BY s.slot`
    )
    .all();
  return { leavers: rows.map((r) => ({ id: r.id, slot: r.slot, name: r.p_worker_id != null ? r.w_name : r.p_name })) };
}

module.exports = {
  overview,
  createSlot,
  updateSlot,
  removeSlot,
  restoreSlot,
  reveal,
  putCompany,
  putTimes,
  summary,
};
