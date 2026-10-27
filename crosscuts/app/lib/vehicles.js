// The vehicles register (0.2.7, docs/plans/m28-contracts.md section 1): rego and insurance dates
// (Accounts, invoices.edit) and service/repair/inspection bookings (the workshop manager,
// maintenance.manage). Dates and bookings only, no costs (Todd 2026-10-26).
//
// Every function takes db first; nothing here requires ../db. Every write runs in one transaction
// with its audit row.
const { bad, notFound, conflict } = require("./httperror");
const { sydneyToday, parseDateUTC, formatDateUTC, addDays } = require("./time");
const audit = require("./audit");
const notify = require("./notify");

const KINDS = ["service", "repair", "inspection", "other"];
const KIND_LABEL = { service: "Service", repair: "Repair", inspection: "Inspection", other: "Booking" };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const THRESHOLDS = [30, 7];
const WHAT_LABEL = { rego: "Rego", insurance: "Insurance" };

const VEHICLE_FIELDS = {
  name: { col: "name", kind: "name" },
  rego: { col: "rego", kind: "text", max: 20 },
  makeModel: { col: "make_model", kind: "text", max: 100 },
  regoExpiry: { col: "rego_expiry", kind: "date" },
  insuranceExpiry: { col: "insurance_expiry", kind: "date" },
  insurer: { col: "insurer", kind: "text", max: 100 },
  policyNumber: { col: "policy_number", kind: "text", max: 60 },
  notes: { col: "notes", kind: "text", max: 1000 },
  active: { col: "active", kind: "bool" },
};
const BOOKING_FIELDS = {
  kind: { col: "kind", kind: "kind" },
  date: { col: "date", kind: "reqdate" },
  time: { col: "time", kind: "time" },
  place: { col: "place", kind: "text", max: 200 },
  notes: { col: "notes", kind: "text", max: 1000 },
};

function nowIso() {
  return new Date().toISOString();
}
function userId(req) {
  return req && req.user ? req.user.id : null;
}
function validDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && formatDateUTC(parseDateUTC(s)) === s;
}
function daysBetween(a, b) {
  return Math.round((parseDateUTC(b).getTime() - parseDateUTC(a).getTime()) / 86400000);
}

function value(key, f, v) {
  switch (f.kind) {
    case "name": {
      const t = typeof v === "string" ? v.trim() : "";
      if (!t || t.length > 100) throw bad("Give the vehicle a name of 1 to 100 characters");
      return t;
    }
    case "text": {
      if (v === null) return "";
      if (typeof v !== "string") throw bad(`${key} must be text`);
      const t = v.trim();
      if (t.length > f.max) throw bad(`${key} is too long (${f.max} characters at most)`);
      return t;
    }
    case "date":
      if (v === null || v === "") return null;
      if (!validDate(v)) throw bad(`${key} must be a valid YYYY-MM-DD date`);
      return v;
    case "reqdate":
      if (!validDate(v)) throw bad(`${key} must be a valid YYYY-MM-DD date`);
      return v;
    case "time":
      if (v === null || v === "") return null;
      if (typeof v !== "string" || !TIME_RE.test(v)) throw bad(`${key} must be HH:MM, or empty`);
      return v;
    case "bool":
      if (typeof v !== "boolean") throw bad(`${key} must be true or false`);
      return v ? 1 : 0;
    case "kind":
      if (!KINDS.includes(v)) throw bad("kind must be service, repair, inspection or other");
      return v;
    default:
      throw new Error("unknown field kind");
  }
}

function parseBody(body, fields, { create }) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const out = {};
  for (const [k, f] of Object.entries(fields)) {
    if (b[k] === undefined) continue;
    out[f.col] = value(k, f, b[k]);
  }
  if (create) {
    for (const [k, f] of Object.entries(fields)) {
      if ((f.kind === "name" || f.kind === "reqdate" || f.kind === "kind") && out[f.col] === undefined) {
        out[f.col] = value(k, f, undefined);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------- shapes ---

function expiryOf(date, today) {
  if (!date) return null;
  const days = daysBetween(today, date);
  return { date, days, expired: days < 0, soon: days >= 0 && days <= 30 };
}

function toBooking(r, today) {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    vehicleName: r.vehicle_name,
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind],
    date: r.date,
    time: r.time || null,
    place: r.place,
    notes: r.notes,
    done: r.done_at != null,
    doneAt: r.done_at || null,
    doneBy: r.done_by == null ? null : { id: r.done_by, name: r.done_by_name || null },
    overdue: r.done_at == null && r.date < today,
  };
}

const BOOKING_SELECT = `SELECT b.*, v.name AS vehicle_name, u.display_name AS done_by_name
    FROM vehicle_bookings b JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN users u ON u.id = b.done_by`;

function toVehicle(r, today, bookings) {
  return {
    id: r.id,
    name: r.name,
    rego: r.rego,
    makeModel: r.make_model,
    regoExpiry: expiryOf(r.rego_expiry, today),
    insuranceExpiry: expiryOf(r.insurance_expiry, today),
    insurer: r.insurer,
    policyNumber: r.policy_number,
    notes: r.notes,
    active: !!r.active,
    updatedAt: r.updated_at,
    bookings,
  };
}

function vehicleRow(db, id) {
  const r = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(id);
  if (!r) throw notFound();
  return r;
}

function bookingRow(db, id) {
  const r = db.prepare(`${BOOKING_SELECT} WHERE b.id = ? AND b.cancelled_at IS NULL`).get(id);
  if (!r) throw notFound();
  return r;
}

function getVehicle(db, id, today = sydneyToday()) {
  const r = vehicleRow(db, id);
  const bookings = db
    .prepare(`${BOOKING_SELECT} WHERE b.vehicle_id = ? AND b.cancelled_at IS NULL ORDER BY b.date DESC, b.time DESC, b.id DESC`)
    .all(id)
    .map((x) => toBooking(x, today));
  return toVehicle(r, today, bookings);
}

// The register: vehicles (active only unless all) each with its open bookings and the last done
// one, plus every open booking by date.
function list(db, { all = false } = {}, today = sydneyToday()) {
  const rows = db
    .prepare(`SELECT * FROM vehicles ${all ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE, id`)
    .all();
  const open = db
    .prepare(`${BOOKING_SELECT} WHERE b.cancelled_at IS NULL AND b.done_at IS NULL ORDER BY b.date, b.time, b.id`)
    .all()
    .map((x) => toBooking(x, today));
  const lastDone = db.prepare(
    `${BOOKING_SELECT} WHERE b.vehicle_id = ? AND b.cancelled_at IS NULL AND b.done_at IS NOT NULL
      ORDER BY b.date DESC, b.id DESC LIMIT 1`
  );
  const vehicles = rows.map((r) => {
    const v = toVehicle(r, today, open.filter((b) => b.vehicleId === r.id));
    const ld = lastDone.get(r.id);
    v.lastDone = ld ? toBooking(ld, today) : null;
    return v;
  });
  const shown = new Set(vehicles.map((v) => v.id));
  return { today, vehicles, bookings: open.filter((b) => shown.has(b.vehicleId)) };
}

// ------------------------------------------------------------ vehicles ---

function create(db, req, body) {
  const v = parseBody(body, VEHICLE_FIELDS, { create: true });
  return db.transaction(() => {
    const now = nowIso();
    const cols = Object.keys(v);
    const info = db
      .prepare(
        `INSERT INTO vehicles (${cols.join(", ")}, created_at, updated_at, updated_by)
         VALUES (${cols.map(() => "?").join(", ")}, ?, ?, ?)`
      )
      .run(...cols.map((c) => v[c]), now, now, userId(req));
    const id = Number(info.lastInsertRowid);
    audit.log(req, { action: "vehicle.create", entityType: "vehicle", entityId: id, after: v });
    return getVehicle(db, id);
  })();
}

function update(db, req, id, body) {
  const v = parseBody(body, VEHICLE_FIELDS, { create: false });
  if (!Object.keys(v).length) throw bad("Nothing to update");
  return db.transaction(() => {
    const row = vehicleRow(db, id);
    const before = {};
    const after = {};
    for (const [c, x] of Object.entries(v)) {
      if (row[c] !== x) {
        before[c] = row[c];
        after[c] = x;
      }
    }
    const cols = Object.keys(after);
    if (cols.length) {
      db.prepare(`UPDATE vehicles SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`).run(
        ...cols.map((c) => after[c]),
        nowIso(),
        userId(req),
        id
      );
      audit.log(req, { action: "vehicle.update", entityType: "vehicle", entityId: id, before, after });
    }
    return getVehicle(db, id);
  })();
}

// ------------------------------------------------------------ bookings ---

function addBooking(db, req, vehicleId, body) {
  const v = parseBody(body, BOOKING_FIELDS, { create: true });
  return db.transaction(() => {
    const veh = vehicleRow(db, vehicleId);
    if (!veh.active) throw conflict("This vehicle is not active");
    const now = nowIso();
    const cols = Object.keys(v);
    const info = db
      .prepare(
        `INSERT INTO vehicle_bookings (vehicle_id, ${cols.join(", ")}, created_by, created_at, updated_at)
         VALUES (?, ${cols.map(() => "?").join(", ")}, ?, ?, ?)`
      )
      .run(vehicleId, ...cols.map((c) => v[c]), userId(req), now, now);
    const id = Number(info.lastInsertRowid);
    audit.log(req, { action: "vehicle_booking.create", entityType: "vehicle", entityId: vehicleId, after: { bookingId: id, ...v } });
    return toBooking(bookingRow(db, id), sydneyToday());
  })();
}

function updateBooking(db, req, id, body) {
  const v = parseBody(body, BOOKING_FIELDS, { create: false });
  if (!Object.keys(v).length) throw bad("Nothing to update");
  return db.transaction(() => {
    const row = bookingRow(db, id);
    const before = {};
    const after = {};
    for (const [c, x] of Object.entries(v)) {
      if (row[c] !== x) {
        before[c] = row[c];
        after[c] = x;
      }
    }
    const cols = Object.keys(after);
    if (cols.length) {
      db.prepare(`UPDATE vehicle_bookings SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
        ...cols.map((c) => after[c]),
        nowIso(),
        id
      );
      audit.log(req, { action: "vehicle_booking.update", entityType: "vehicle", entityId: row.vehicle_id, before: { bookingId: id, ...before }, after });
    }
    return toBooking(bookingRow(db, id), sydneyToday());
  })();
}

// done true: confirmed done (409 if already); false: reopened (409 if not done).
function setDone(db, req, id, done) {
  if (typeof done !== "boolean") throw bad("done must be true or false");
  return db.transaction(() => {
    const row = bookingRow(db, id);
    if (done && row.done_at) throw conflict("This booking is already done");
    if (!done && !row.done_at) throw conflict("This booking isn't done");
    db.prepare("UPDATE vehicle_bookings SET done_at = ?, done_by = ?, updated_at = ? WHERE id = ?").run(
      done ? nowIso() : null,
      done ? userId(req) : null,
      nowIso(),
      id
    );
    audit.log(req, {
      action: done ? "vehicle_booking.done" : "vehicle_booking.reopen",
      entityType: "vehicle",
      entityId: row.vehicle_id,
      after: { bookingId: id },
    });
    return toBooking(bookingRow(db, id), sydneyToday());
  })();
}

// Cancels (soft-removes) an open booking; a done one is 409.
function cancelBooking(db, req, id) {
  db.transaction(() => {
    const row = bookingRow(db, id);
    if (row.done_at) throw conflict("A done booking can't be cancelled");
    db.prepare("UPDATE vehicle_bookings SET cancelled_at = ?, cancelled_by = ?, updated_at = ? WHERE id = ?").run(
      nowIso(),
      userId(req),
      nowIso(),
      id
    );
    audit.log(req, { action: "vehicle_booking.cancel", entityType: "vehicle", entityId: row.vehicle_id, before: { bookingId: id, kind: row.kind, date: row.date } });
  })();
}

// ------------------------------------------------- sweep and counts ---

// Bells invoices.edit holders when an active vehicle's rego or insurance is 30 or fewer, and again
// 7 or fewer, days from expiring (once per vehicle, kind, threshold and expiry date). An expiry
// already past bells nothing new. Returns how many bells were made.
function bellExpiries(db, today = sydneyToday()) {
  const rows = db.prepare("SELECT * FROM vehicles WHERE active = 1").all();
  const had = db.prepare("SELECT 1 FROM vehicle_bells WHERE vehicle_id = ? AND what = ? AND threshold = ? AND expiry = ?");
  const mark = db.prepare("INSERT INTO vehicle_bells (vehicle_id, what, threshold, expiry, belled_at) VALUES (?, ?, ?, ?, ?)");
  let n = 0;
  db.transaction(() => {
    for (const v of rows) {
      for (const [what, date] of [["rego", v.rego_expiry], ["insurance", v.insurance_expiry]]) {
        if (!date) continue;
        const days = daysBetween(today, date);
        if (days < 0) continue;
        // The tightest threshold reached; the looser one is marked too so it never bells late.
        const reached = THRESHOLDS.filter((t) => days <= t);
        if (!reached.length) continue;
        const t = Math.min(...reached);
        if (had.get(v.id, what, t, date)) continue;
        for (const x of reached) if (!had.get(v.id, what, x, date)) mark.run(v.id, what, x, date, nowIso());
        n += notify.toKey(db, "invoices.edit", {
          kind: "vehicle.expiry",
          title: `${WHAT_LABEL[what]} due: ${v.name}${v.rego ? ` (${v.rego})` : ""}`,
          body: `${WHAT_LABEL[what]} expires ${date}, in ${days} ${days === 1 ? "day" : "days"}.`,
          link: "/vehicles.html",
          entityType: "vehicle",
          entityId: v.id,
        });
      }
    }
  })();
  return n;
}

// Rego and insurance expiring within 30 days (or expired) on active vehicles.
function dueSoonCount(db, today = sydneyToday()) {
  const lim = addDays(today, 30);
  return Number(
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM vehicles WHERE active = 1 AND rego_expiry IS NOT NULL AND rego_expiry <= @lim)
              + (SELECT COUNT(*) FROM vehicles WHERE active = 1 AND insurance_expiry IS NOT NULL AND insurance_expiry <= @lim) AS n`
      )
      .get({ lim }).n
  ) || 0;
}

// Open bookings due today or before (the workshop manager's Waiting on you).
function bookingsDueCount(db, today = sydneyToday()) {
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM vehicle_bookings b JOIN vehicles v ON v.id = b.vehicle_id
          WHERE b.cancelled_at IS NULL AND b.done_at IS NULL AND b.date <= ? AND v.active = 1`
      )
      .get(today).n
  ) || 0;
}

module.exports = {
  KINDS,
  KIND_LABEL,
  list,
  getVehicle,
  create,
  update,
  addBooking,
  updateBooking,
  setDone,
  cancelBooking,
  bellExpiries,
  dueSoonCount,
  bookingsDueCount,
};
