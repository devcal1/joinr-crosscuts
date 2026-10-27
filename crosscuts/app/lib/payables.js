// Individual (non-account) invoices to pay (0.2.7, docs/plans/m28-contracts.md section 2). They are
// listed on the Supplier accounts page below the supplier accounts, in their month. Accounts adds and
// edits them (invoices.edit); Paid is ticked by users.admin holders only.
//
// Every function takes db first; nothing here requires ../db. Every write runs in one transaction
// with its audit row.
const { HttpError, bad, notFound, conflict, forbidden, can } = require("./httperror");
const { sydneyToday, parseDateUTC, formatDateUTC } = require("./time");
const audit = require("./audit");
const files = require("./files");
const Periods = require("../public/periods");

const PAYEE_MAX = 100;
const DESC_MAX = 500;
const TOTAL_LIMIT = 1000000000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAY_KEY = "users.admin";

function nowIso() {
  return new Date().toISOString();
}
function userId(req) {
  return req && req.user ? req.user.id : null;
}
function validDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && formatDateUTC(parseDateUTC(s)) === s;
}
function lastPeriod(today) {
  return Periods.addMonths(Periods.currentPeriod(today), 1);
}
function periodOk(p, today) {
  return Periods.validPeriod(p) && p >= Periods.HISTORY_START && p <= lastPeriod(today);
}
function periodOr404(p, today = sydneyToday()) {
  if (!periodOk(p, today)) throw notFound();
  return p;
}

const SELECT = `SELECT p.*, au.display_name AS added_by_name, pu.display_name AS paid_by_name,
         f.id AS f_id, f.original_name AS f_original_name, f.size AS f_size, f.mime AS f_mime,
         f.uploaded_at AS f_uploaded_at, f.uploaded_by AS f_uploaded_by, fu.display_name AS f_uploaded_by_name,
         s.name AS supplier_name
    FROM payables p
    LEFT JOIN users au ON au.id = p.added_by
    LEFT JOIN users pu ON pu.id = p.paid_by
    LEFT JOIN files f ON f.id = p.file_id AND f.removed_at IS NULL
    LEFT JOIN users fu ON fu.id = f.uploaded_by
    LEFT JOIN suppliers s ON s.id = p.supplier_id`;

function toPayable(r) {
  return {
    id: r.id,
    period: r.period,
    payee: r.payee,
    description: r.description,
    amountCents: r.amount_cents == null ? null : Number(r.amount_cents),
    dueDate: r.due_date || null,
    myob: !!r.myob,
    paid: r.paid_date != null,
    paidDate: r.paid_date || null,
    paidBy: r.paid_by == null ? null : { id: r.paid_by, name: r.paid_by_name || null },
    missing: r.amount_cents == null,
    file:
      r.f_id == null
        ? null
        : files.toFile({
            id: r.f_id,
            original_name: r.f_original_name,
            size: r.f_size,
            mime: r.f_mime,
            uploaded_at: r.f_uploaded_at,
            uploaded_by: r.f_uploaded_by,
            uploaded_by_name: r.f_uploaded_by_name,
          }),
    supplier: r.supplier_id == null ? null : { id: r.supplier_id, name: r.supplier_name },
    addedBy: r.added_by == null ? null : { id: r.added_by, name: r.added_by_name || null },
    updatedAt: r.updated_at,
  };
}

function row(db, id) {
  const r = db.prepare(`${SELECT} WHERE p.id = ? AND p.removed_at IS NULL`).get(id);
  if (!r) throw notFound();
  return r;
}

function get(db, id) {
  return toPayable(row(db, id));
}

// Field values from a body; `create` requires the payee.
function parse(b, { create }, today) {
  const out = {};
  if (b.payee !== undefined || create) {
    const t = typeof b.payee === "string" ? b.payee.trim() : "";
    if (!t || t.length > PAYEE_MAX) throw bad(`Give a payee of 1 to ${PAYEE_MAX} characters`);
    out.payee = t;
  }
  if (b.description !== undefined) {
    if (b.description !== null && typeof b.description !== "string") throw bad("The description must be text");
    const t = (b.description || "").trim();
    if (t.length > DESC_MAX) throw bad(`The description must be ${DESC_MAX} characters or fewer`);
    out.description = t;
  }
  if (b.amountCents !== undefined) {
    const t = b.amountCents;
    if (t !== null && !Number.isInteger(t)) throw bad("The amount must be a whole number of cents, or null");
    if (t !== null && (t < -TOTAL_LIMIT || t > TOTAL_LIMIT)) throw bad("The amount is too large");
    out.amount_cents = t;
  }
  if (b.dueDate !== undefined) {
    if (b.dueDate !== null && b.dueDate !== "" && !validDate(b.dueDate)) throw bad("The due date must be a valid YYYY-MM-DD date");
    out.due_date = b.dueDate || null;
  }
  if (b.period !== undefined) {
    if (typeof b.period !== "string" || !periodOk(b.period, today)) {
      throw bad(`Choose a month from ${Periods.label(Periods.HISTORY_START)} to next month`);
    }
    out.period = b.period;
  }
  if (b.myob !== undefined) {
    if (typeof b.myob !== "boolean") throw bad("myob must be true or false");
    out.myob = b.myob ? 1 : 0;
  }
  return out;
}

// A month's individual invoices, oldest due first (no due date last), with Left to pay and the
// missing-figure count.
function month(db, period, today = sydneyToday()) {
  periodOr404(period, today);
  const lines = db
    .prepare(`${SELECT} WHERE p.period = ? AND p.removed_at IS NULL ORDER BY p.due_date IS NULL, p.due_date, p.id`)
    .all(period)
    .map(toPayable);
  let leftCents = 0;
  let totalCents = 0;
  let missing = 0;
  let paid = 0;
  for (const l of lines) {
    if (l.amountCents != null) totalCents += l.amountCents;
    if (!l.paid && l.amountCents != null) leftCents += l.amountCents;
    if (l.missing) missing += 1;
    if (l.paid) paid += 1;
  }
  return { period, lines, counts: { listed: lines.length, missing, paid }, totalCents, leftCents };
}

function create(db, req, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const today = sydneyToday();
  const v = parse(b, { create: true }, today);
  if (!v.period) {
    const fromDue = v.due_date ? v.due_date.slice(0, 7) : null;
    v.period = fromDue && periodOk(fromDue, today) ? fromDue : Periods.currentPeriod(today);
  }
  return db.transaction(() => {
    const now = nowIso();
    const cols = Object.keys(v);
    const info = db
      .prepare(
        `INSERT INTO payables (${cols.join(", ")}, added_by, created_at, updated_at)
         VALUES (${cols.map(() => "?").join(", ")}, ?, ?, ?)`
      )
      .run(...cols.map((c) => v[c]), userId(req), now, now);
    const id = Number(info.lastInsertRowid);
    audit.log(req, { action: "payable.create", entityType: "payable", entityId: id, after: v });
    return get(db, id);
  })();
}

function update(db, req, id, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const v = parse(b, { create: false }, sydneyToday());
  if (!Object.keys(v).length) throw bad("Nothing to update");
  return db.transaction(() => {
    const r = row(db, id);
    const before = {};
    const after = {};
    for (const [c, x] of Object.entries(v)) {
      if (r[c] !== x) {
        before[c] = r[c];
        after[c] = x;
      }
    }
    const cols = Object.keys(after);
    if (cols.length) {
      db.prepare(`UPDATE payables SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
        ...cols.map((c) => after[c]),
        nowIso(),
        id
      );
      audit.log(req, { action: "payable.update", entityType: "payable", entityId: id, before, after });
    }
    return get(db, id);
  })();
}

// Paid is ticked by users.admin holders only (Todd 2026-10-26). {paid, paidDate?}.
function setPaid(db, req, id, body) {
  if (!can(req, PAY_KEY)) throw forbidden();
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (typeof b.paid !== "boolean") throw bad("paid must be true or false");
  const today = sydneyToday();
  let date = null;
  if (b.paid) {
    date = b.paidDate == null || b.paidDate === "" ? today : b.paidDate;
    if (!validDate(date)) throw bad("paidDate must be a valid YYYY-MM-DD date");
    if (date > today) throw bad("paidDate can't be in the future");
  }
  return db.transaction(() => {
    const r = row(db, id);
    if (b.paid && r.paid_date) throw conflict("This invoice is already marked paid");
    if (!b.paid && !r.paid_date) throw conflict("This invoice isn't marked paid");
    db.prepare("UPDATE payables SET paid_date = ?, paid_by = ?, updated_at = ? WHERE id = ?").run(
      date,
      b.paid ? userId(req) : null,
      nowIso(),
      id
    );
    audit.log(req, {
      action: b.paid ? "payable.paid" : "payable.unpaid",
      entityType: "payable",
      entityId: id,
      before: { paidDate: r.paid_date || null },
      after: { paidDate: date },
    });
    return get(db, id);
  })();
}

// Removes (soft) an unpaid individual invoice; a paid one is 409.
function remove(db, req, id) {
  db.transaction(() => {
    const r = row(db, id);
    if (r.paid_date) throw conflict("A paid invoice can't be removed");
    db.prepare("UPDATE payables SET removed_at = ?, removed_by = ?, updated_at = ? WHERE id = ?").run(nowIso(), userId(req), nowIso(), id);
    audit.log(req, { action: "payable.remove", entityType: "payable", entityId: id, before: { payee: r.payee, amountCents: r.amount_cents, period: r.period } });
  })();
}

function attach(db, req, id, accepted) {
  return db.transaction(() => {
    const r = row(db, id);
    const fileId = files.insert(db, accepted, userId(req));
    if (r.f_id != null) files.remove(db, r.f_id, userId(req));
    db.prepare("UPDATE payables SET file_id = ?, updated_at = ? WHERE id = ?").run(fileId, nowIso(), id);
    audit.log(req, { action: "payable.file", entityType: "payable", entityId: id, after: { fileId, name: accepted.originalName } });
    return get(db, id);
  })();
}

function detach(db, req, id) {
  return db.transaction(() => {
    const r = row(db, id);
    if (r.f_id == null) throw notFound();
    files.remove(db, r.f_id, userId(req));
    db.prepare("UPDATE payables SET file_id = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id);
    audit.log(req, { action: "payable.file", entityType: "payable", entityId: id, before: { fileId: r.f_id }, after: null });
    return get(db, id);
  })();
}

// Makes the payee a supplier account, listed from this invoice's month (409 on a name clash, as
// Add supplier). The individual invoice stays where it is and is linked to the new supplier.
function convert(db, req, id, suppliers) {
  const r = row(db, id);
  if (r.supplier_id != null) throw conflict("This payee is already a supplier account");
  const supplier = suppliers.create(db, req, { name: r.payee, fromPeriod: r.period });
  db.transaction(() => {
    db.prepare("UPDATE payables SET supplier_id = ?, updated_at = ? WHERE id = ?").run(supplier.id, nowIso(), id);
    audit.log(req, { action: "payable.convert", entityType: "payable", entityId: id, after: { supplierId: supplier.id, name: supplier.name } });
  })();
  return { payable: get(db, id), supplier };
}

// This month's to pay, for admin's dashboard line: unpaid individual invoices plus supplier lines
// not paid (and not N/A) in the current month. {count, cents}.
function toPayThisMonth(db, today = sydneyToday()) {
  const period = Periods.currentPeriod(today);
  const ind = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM payables WHERE period = ? AND removed_at IS NULL AND paid_date IS NULL")
    .get(period);
  const sup = require("./suppliers").month(db, period, today);
  let n = Number(ind.n) || 0;
  let c = Number(ind.c) || 0;
  // Todd 2026-10-28: lines without a figure are shown separately.
  let noFigure = Number(db.prepare("SELECT COUNT(*) AS n FROM payables WHERE period = ? AND removed_at IS NULL AND paid_date IS NULL AND amount_cents IS NULL").get(period).n) || 0;
  for (const l of sup.lines) {
    if (l.paid || l.state === "na") continue;
    n += 1;
    if (l.totalCents != null) c += l.totalCents;
    else noFigure += 1;
  }
  return { period, count: n, cents: c, noFigure };
}

// Individual invoices without a due date (any month from last month on), for Accounts' Waiting on you.
function noDueDateCount(db, today = sydneyToday()) {
  const from = Periods.addMonths(Periods.currentPeriod(today), -1);
  return Number(
    db.prepare("SELECT COUNT(*) AS n FROM payables WHERE removed_at IS NULL AND paid_date IS NULL AND due_date IS NULL AND period >= ?").get(from).n
  ) || 0;
}

module.exports = {
  HttpError,
  PAY_KEY,
  month,
  get,
  create,
  update,
  setPaid,
  remove,
  attach,
  detach,
  convert,
  toPayThisMonth,
  noDueDateCount,
  periodOr404,
};
