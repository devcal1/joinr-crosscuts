// AMEX (0.2.12, Todd 2026-11-02): the company credit card. Charges (transactions) and repayments;
// a repayment covers the ticked transactions, which then count as paid back. No interest.
//
// Every function takes db first. Every write runs in one db.transaction with its audit row (entity
// types amex_transaction and amex_repayment). The route declares loans.manage / loans.maintain; every
// rule about the card lives here.
//
// The statement: charges and repayments merged in date order (on the same date a repayment comes
// after the charges, then by id), with a running balance = charges so far - repayments so far. A
// repayment takes its typed amount off the balance, whatever the ticked transactions add up to.
// Owing now is the balance after everything. A filtered statement starts from the balance of
// everything before its window (the opening balance).
const audit = require("./audit");
const { bad, notFound, conflict } = require("./httperror");
const { DATE_RE, sydneyToday, parseDateUTC, formatDateUTC } = require("./time");

const MAX_CENTS = 10000000000; // $100,000,000
const RANGES = ["year", "12m", "all"];

function nowIso() {
  return new Date().toISOString();
}

function userId(req) {
  return req && req.user && req.user.id != null ? req.user.id : null;
}

function validDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && formatDateUTC(parseDateUTC(s)) === s;
}

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function onlyKeys(body, allowed) {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw bad(`Unknown field: ${k}`);
}

function text(v, label, max, required) {
  if (v === null || v === undefined) v = "";
  if (typeof v !== "string") throw bad(`${label} must be text`);
  const s = v.trim();
  if (required && !s) throw bad(`${label} is required`);
  if (s.length > max) throw bad(`${label} must be ${max} characters or fewer`);
  return s;
}

function amount(v, message) {
  if (!Number.isInteger(v) || v <= 0 || v > MAX_CENTS) throw bad(message);
  return v;
}

function date(v, message) {
  const s = typeof v === "string" ? v.trim() : v;
  if (!validDate(s)) throw bad(message);
  return s;
}

// The first day of a range window, or null for everything.
function windowStart(range, today) {
  if (range === "all") return null;
  if (range === "year") return `${today.slice(0, 4)}-01-01`;
  const y = Number(today.slice(0, 4)) - 1;
  return formatDateUTC(new Date(Date.UTC(y, Number(today.slice(5, 7)) - 1, Number(today.slice(8)) + 1)));
}

function txnOut(r) {
  return {
    id: r.id,
    date: r.txn_date,
    supplier: r.supplier,
    note: r.note,
    amountCents: r.amount_cents,
    repaymentId: r.repayment_id,
    paid: r.repayment_id != null,
  };
}

function loadTxns(db) {
  return db.prepare("SELECT * FROM amex_transactions WHERE removed_at IS NULL ORDER BY txn_date, id").all();
}

function loadReps(db) {
  return db.prepare("SELECT * FROM amex_repayments WHERE removed_at IS NULL ORDER BY paid_date, id").all();
}

function repOut(r, covered) {
  const dates = covered.map((t) => t.txn_date).sort();
  return {
    id: r.id,
    date: r.paid_date,
    amountCents: r.amount_cents,
    note: r.note,
    transactionIds: covered.map((t) => t.id),
    coversCount: covered.length,
    coversFrom: dates.length ? dates[0] : null,
    coversTo: dates.length ? dates[dates.length - 1] : null,
    coveredCents: covered.reduce((s, t) => s + t.amount_cents, 0),
  };
}

// ---------------------------------------------------------------- list ---

function list(db, opts, now) {
  const o = opts || {};
  const range = o.range === undefined || o.range === "" ? "year" : o.range;
  if (!RANGES.includes(range)) throw bad("range must be year, 12m or all");
  const today = sydneyToday(now);
  const start = windowStart(range, today);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const yearEnd = `${today.slice(0, 4)}-12-31`;

  const txns = loadTxns(db);
  const reps = loadReps(db);
  const byRep = new Map();
  for (const t of txns) {
    if (t.repayment_id == null) continue;
    if (!byRep.has(t.repayment_id)) byRep.set(t.repayment_id, []);
    byRep.get(t.repayment_id).push(t);
  }

  // All rows in statement order: charges before a repayment on the same date.
  const all = [];
  for (const t of txns) all.push({ kind: "charge", date: t.txn_date, order: 0, id: t.id, row: t });
  for (const r of reps) all.push({ kind: "repayment", date: r.paid_date, order: 1, id: r.id, row: r });
  all.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.order - b.order || a.id - b.id));

  let balance = 0;
  let opening = 0;
  const statement = [];
  for (const e of all) {
    balance += e.kind === "charge" ? e.row.amount_cents : -e.row.amount_cents;
    if (start && e.date < start) {
      opening = balance;
      continue;
    }
    if (e.kind === "charge") {
      statement.push({ kind: "charge", ...txnOut(e.row), balanceCents: balance });
    } else {
      statement.push({ kind: "repayment", ...repOut(e.row, byRep.get(e.row.id) || []), balanceCents: balance });
    }
  }

  let charged = 0;
  let repaid = 0;
  for (const t of txns) if (t.txn_date >= yearStart && t.txn_date <= yearEnd) charged += t.amount_cents;
  for (const r of reps) if (r.paid_date >= yearStart && r.paid_date <= yearEnd) repaid += r.amount_cents;

  return {
    range,
    from: start,
    today,
    openingCents: start ? opening : null,
    statement,
    transactions: txns.filter((t) => !start || t.txn_date >= start).map(txnOut),
    repayments: reps.filter((r) => !start || r.paid_date >= start).map((r) => repOut(r, byRep.get(r.id) || [])),
    // Every charge not yet paid back, whatever the window (the Record repayment dialog's list).
    unpaid: txns.filter((t) => t.repayment_id == null).map(txnOut),
    owingCents: balance,
    chargedYearCents: charged,
    repaidYearCents: repaid,
  };
}

// ---------------------------------------------------------------- transactions ---

const TXN_FIELDS = ["txnDate", "supplier", "note", "amountCents"];

function txnValues(body, current) {
  const cur = current || {};
  const v = {};
  v.txn_date = has(body, "txnDate") ? date(body.txnDate, "The date must be a real date, like 2026-10-28") : cur.txn_date;
  v.supplier = has(body, "supplier") ? text(body.supplier, "Supplier", 100, true) : cur.supplier;
  v.note = has(body, "note") ? text(body.note, "Note", 200, false) : cur.note || "";
  v.amount_cents = has(body, "amountCents")
    ? amount(body.amountCents, "The amount must be more than $0.00 and a whole number of cents")
    : cur.amount_cents;
  if (v.txn_date === undefined) throw bad("The date is required");
  if (v.supplier === undefined) throw bad("Supplier is required");
  if (v.amount_cents === undefined) throw bad("The amount is required");
  return v;
}

function getTxnRow(db, id) {
  const r = db.prepare("SELECT * FROM amex_transactions WHERE id = ? AND removed_at IS NULL").get(id);
  if (!r) throw notFound();
  return r;
}

function addTransaction(db, req, body) {
  onlyKeys(body, TXN_FIELDS);
  const v = txnValues(body, null);
  const at = nowIso();
  let id;
  db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO amex_transactions (txn_date, supplier, note, amount_cents, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(v.txn_date, v.supplier, v.note, v.amount_cents, userId(req), at, at);
    id = Number(info.lastInsertRowid);
    audit.log(req, { action: "amex.transaction_add", entityType: "amex_transaction", entityId: id, after: txnOut(getTxnRow(db, id)) });
  })();
  return txnOut(getTxnRow(db, id));
}

function updateTransaction(db, req, id, body) {
  onlyKeys(body, TXN_FIELDS);
  db.transaction(() => {
    const cur = getTxnRow(db, id);
    const v = txnValues(body, cur);
    if (cur.repayment_id != null && v.amount_cents !== cur.amount_cents) {
      throw conflict("This transaction has been paid back, so its amount can't change. Delete the repayment first.");
    }
    db.prepare("UPDATE amex_transactions SET txn_date = ?, supplier = ?, note = ?, amount_cents = ?, updated_at = ? WHERE id = ?")
      .run(v.txn_date, v.supplier, v.note, v.amount_cents, nowIso(), id);
    audit.log(req, {
      action: "amex.transaction_update",
      entityType: "amex_transaction",
      entityId: id,
      before: txnOut(cur),
      after: txnOut(getTxnRow(db, id)),
    });
  })();
  return txnOut(getTxnRow(db, id));
}

function deleteTransaction(db, req, id) {
  db.transaction(() => {
    const cur = getTxnRow(db, id);
    if (cur.repayment_id != null) {
      throw conflict("This transaction has been paid back, so it can't be deleted. Delete the repayment first.");
    }
    const at = nowIso();
    db.prepare("UPDATE amex_transactions SET removed_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
    audit.log(req, { action: "amex.transaction_delete", entityType: "amex_transaction", entityId: id, before: txnOut(cur) });
  })();
  return { ok: true };
}

// ---------------------------------------------------------------- repayments ---

function getRepRow(db, id) {
  const r = db.prepare("SELECT * FROM amex_repayments WHERE id = ? AND removed_at IS NULL").get(id);
  if (!r) throw notFound();
  return r;
}

function coveredBy(db, id) {
  return db.prepare("SELECT * FROM amex_transactions WHERE repayment_id = ? AND removed_at IS NULL ORDER BY txn_date, id").all(id);
}

function addRepayment(db, req, body) {
  onlyKeys(body, ["paidDate", "amountCents", "note", "transactionIds"]);
  const paidDate = date(body.paidDate, "The paid date must be a real date, like 2026-10-28");
  const amountCents = amount(body.amountCents, "The amount must be more than $0.00 and a whole number of cents");
  const note = text(body.note, "Note", 200, false);
  const ids = body.transactionIds;
  if (!Array.isArray(ids) || !ids.length) throw bad("Tick at least one transaction this repayment covers");
  if (ids.length > 1000) throw bad("That is too many transactions for one repayment");
  for (const i of ids) if (!Number.isSafeInteger(i) || i < 1) throw bad("transactionIds must be a list of transaction ids");
  if (new Set(ids).size !== ids.length) throw bad("A transaction is ticked twice");

  let id;
  db.transaction(() => {
    const rows = ids.map((i) => db.prepare("SELECT * FROM amex_transactions WHERE id = ? AND removed_at IS NULL").get(i));
    if (rows.some((r) => !r)) throw bad("One of the ticked transactions no longer exists. Reload and try again.");
    if (rows.some((r) => r.repayment_id != null)) throw bad("One of the ticked transactions has already been paid back. Reload and try again.");
    const at = nowIso();
    const info = db
      .prepare("INSERT INTO amex_repayments (paid_date, amount_cents, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(paidDate, amountCents, note, userId(req), at, at);
    id = Number(info.lastInsertRowid);
    const upd = db.prepare("UPDATE amex_transactions SET repayment_id = ?, updated_at = ? WHERE id = ?");
    for (const i of ids) upd.run(id, at, i);
    audit.log(req, {
      action: "amex.repayment_add",
      entityType: "amex_repayment",
      entityId: id,
      after: repOut(getRepRow(db, id), coveredBy(db, id)),
    });
  })();
  return repOut(getRepRow(db, id), coveredBy(db, id));
}

function updateRepayment(db, req, id, body) {
  onlyKeys(body, ["paidDate", "amountCents", "note"]);
  db.transaction(() => {
    const cur = getRepRow(db, id);
    const before = repOut(cur, coveredBy(db, id));
    const paidDate = has(body, "paidDate") ? date(body.paidDate, "The paid date must be a real date, like 2026-10-28") : cur.paid_date;
    const amt = has(body, "amountCents") ? amount(body.amountCents, "The amount must be more than $0.00 and a whole number of cents") : cur.amount_cents;
    const note = has(body, "note") ? text(body.note, "Note", 200, false) : cur.note;
    db.prepare("UPDATE amex_repayments SET paid_date = ?, amount_cents = ?, note = ?, updated_at = ? WHERE id = ?")
      .run(paidDate, amt, note, nowIso(), id);
    audit.log(req, {
      action: "amex.repayment_update",
      entityType: "amex_repayment",
      entityId: id,
      before,
      after: repOut(getRepRow(db, id), coveredBy(db, id)),
    });
  })();
  return repOut(getRepRow(db, id), coveredBy(db, id));
}

// Deleting a repayment un-links its transactions: they are owing again.
function deleteRepayment(db, req, id) {
  db.transaction(() => {
    const cur = getRepRow(db, id);
    const before = repOut(cur, coveredBy(db, id));
    const at = nowIso();
    db.prepare("UPDATE amex_transactions SET repayment_id = NULL, updated_at = ? WHERE repayment_id = ?").run(at, id);
    db.prepare("UPDATE amex_repayments SET removed_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
    audit.log(req, { action: "amex.repayment_delete", entityType: "amex_repayment", entityId: id, before });
  })();
  return { ok: true };
}

module.exports = {
  list,
  addTransaction,
  updateTransaction,
  deleteTransaction,
  addRepayment,
  updateRepayment,
  deleteRepayment,
};
