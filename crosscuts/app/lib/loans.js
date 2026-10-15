// Loans (docs/plans/m13-contracts.md section 6): each loan's opening balance, rate history and
// repayments; the balance always calculated, interest worked out once a month, the statement.
// Wave 1 D.
//
// Every function takes db first and nothing here requires ../db. Every write runs in one
// db.transaction with its audit row (entity type loan only, section 3.6). The route declares only
// loans.manage; every rule about loans lives here.
//
// The maths (section 6.2):
// - the balance after a repayment = opening - the principal of it and every repayment before it
//   (by paid date, then id). It is never typed or stored, and no write may take it below zero;
// - the rate on a date = the rate with the latest from date on or before it;
// - interest worked out = roundDiv(balance just before x rate bp, 120000) (annual rate / 12, half
//   up to the cent), only on the first repayment of a calendar month that carries interest: when
//   an earlier repayment that month already has interest above 0, the worked-out figure is 0.
// The typed interest is what is stored and printed; the worked-out figure is shown beside it.
const audit = require("./audit");
const { bad, notFound, conflict } = require("./httperror");
const { DATE_RE, sydneyToday, parseDateUTC, formatDateUTC } = require("./time");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DIRECTIONS = ["lent_to_business", "lent_by_business"];
const MAX_CENTS = 10000000000; // $100,000,000
const MAX_RATE_BP = 5000; // 50%

// ---------------------------------------------------------------- helpers ---

function nowIso() {
  return new Date().toISOString();
}

function userId(req) {
  return req && req.user && req.user.id != null ? req.user.id : null;
}

function validDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && formatDateUTC(parseDateUTC(s)) === s;
}

// "2026-10-03" -> "3 Oct 2026".
function dayLabel(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Half up on whole numbers, n >= 0 (section 4.1's roundDiv). Every product here stays below 2^53:
// a balance is at most 10^10 cents and a rate at most 5000 bp.
function roundDiv(n, d) {
  return Math.floor((2 * n + d) / (2 * d));
}

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function onlyKeys(body, allowed) {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw bad(`Unknown field: ${k}`);
}

function text(v, label, max) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") throw bad(`${label} must be text`);
  const s = v.trim();
  if (s.length > max) throw bad(`${label} must be ${max} characters or fewer`);
  return s;
}

function cents(v, message) {
  if (!Number.isInteger(v) || v < 0 || v > MAX_CENTS) throw bad(message);
  return v;
}

function trimmedDate(v) {
  return typeof v === "string" ? v.trim() : v;
}

// The Australian financial year holding a date: {label: "2026-27", start, end}.
function fyOf(date) {
  const y = Number(date.slice(0, 4));
  const startYear = Number(date.slice(5, 7)) >= 7 ? y : y - 1;
  return {
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    start: `${startYear}-07-01`,
    end: `${startYear + 1}-06-30`,
  };
}

// ---------------------------------------------------------------- the maths (section 6.2) ---

// The rate in force on a date: the rate with the latest from date on or before it, or null.
// rates: [{fromDate, rateBp}] in any order.
function rateOn(rates, date) {
  let best = null;
  for (const r of rates) {
    if (r.fromDate <= date && (!best || r.fromDate > best.fromDate)) best = r;
  }
  return best ? best.rateBp : null;
}

function byDateThenId(a, b) {
  if (a.paidDate !== b.paidDate) return a.paidDate < b.paidDate ? -1 : 1;
  return a.id - b.id;
}

// Each repayment in order with its running balance, the rate that day and the worked-out interest.
// loan: {openingBalanceCents}; rates: [{fromDate, rateBp}]; reps: [{id, paidDate, principalCents,
// interestCents}] in any order. Pure, so the section 11.5 vectors can be run against it directly.
function walk(loan, rates, reps) {
  const rows = reps.slice().sort(byDateThenId);
  let balance = loan.openingBalanceCents;
  const charged = new Set(); // months in which an earlier row already carries interest
  return rows.map((r) => {
    const before = balance;
    const month = r.paidDate.slice(0, 7);
    const rateBp = rateOn(rates, r.paidDate);
    let worked = null;
    if (rateBp !== null) worked = charged.has(month) ? 0 : roundDiv(Math.max(before, 0) * rateBp, 120000);
    if (r.interestCents > 0) charged.add(month);
    balance = before - r.principalCents;
    return { ...r, balanceBeforeCents: before, balanceAfterCents: balance, rateBp, workedOutInterestCents: worked };
  });
}

// The suggestion for a repayment on `date` (a new one, or repaymentId being edited or moved).
function suggest(loan, rates, reps, date, repaymentId) {
  const others = reps.filter((r) => r.id !== repaymentId);
  let balance = loan.openingBalanceCents;
  for (const r of others) if (r.paidDate <= date) balance -= r.principalCents;
  const month = date.slice(0, 7);
  const charged = others
    .filter((r) => r.paidDate.slice(0, 7) === month && r.interestCents > 0)
    .sort(byDateThenId)[0];
  const rateBp = rateOn(rates, date);
  let interestCents = null;
  if (rateBp !== null) interestCents = charged ? 0 : roundDiv(Math.max(balance, 0) * rateBp, 120000);
  return {
    date,
    balanceCents: balance,
    rateBp,
    interestCents,
    alreadyCharged: charged ? { repaymentId: charged.id, date: charged.paidDate } : null,
  };
}

// 409 when some running balance would go below zero (the first such date).
function checkNotBelowZero(loan, reps) {
  for (const r of walk(loan, [], reps)) {
    if (r.balanceAfterCents < 0) throw conflict(`That would take the balance below zero on ${dayLabel(r.paidDate)}`);
  }
}

// ---------------------------------------------------------------- reading ---

const LOAN_SELECT = `SELECT l.*, u.display_name AS updated_by_name FROM loans l LEFT JOIN users u ON u.id = l.updated_by`;

function loanRow(db, id) {
  const row = db.prepare(`${LOAN_SELECT} WHERE l.id = ?`).get(id);
  if (!row) throw notFound();
  return row;
}

function rateOf(row) {
  return { id: row.id, fromDate: row.from_date, rateBp: row.rate_bp, note: row.note };
}

function repOf(row) {
  return {
    id: row.id,
    paidDate: row.paid_date,
    principalCents: row.principal_cents,
    interestCents: row.interest_cents,
    reference: row.reference,
    note: row.note,
  };
}

function ratesOf(db, loanId) {
  return db
    .prepare("SELECT * FROM loan_rates WHERE loan_id = ? ORDER BY from_date, id")
    .all(loanId)
    .map(rateOf);
}

function repsOf(db, loanId) {
  return db
    .prepare("SELECT * FROM loan_repayments WHERE loan_id = ? ORDER BY paid_date, id")
    .all(loanId)
    .map(repOf);
}

function maths(row) {
  return { openingBalanceCents: row.opening_balance_cents, openingDate: row.opening_date };
}

// Section 6.1: the loan object (list form).
function shape(row, rates, reps, today) {
  const fy = fyOf(today);
  let principal = 0;
  let fyPrincipal = 0;
  let fyInterest = 0;
  let last = null;
  for (const r of reps) {
    principal += r.principalCents;
    if (r.paidDate >= fy.start && r.paidDate <= fy.end) {
      fyPrincipal += r.principalCents;
      fyInterest += r.interestCents;
    }
    if (!last || r.paidDate > last) last = r.paidDate;
  }
  return {
    id: row.id,
    name: row.name,
    direction: row.direction,
    otherParty: row.other_party,
    openingBalanceCents: row.opening_balance_cents,
    openingDate: row.opening_date,
    note: row.note,
    archived: !!row.archived,
    balanceCents: row.opening_balance_cents - principal,
    rateBp: rateOn(rates, today),
    lastPaidDate: last,
    fy: { label: fy.label, principalCents: fyPrincipal, interestCents: fyInterest },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by == null ? null : { id: row.updated_by, name: row.updated_by_name || null },
  };
}

function list(db, { archived = false } = {}, today = sydneyToday()) {
  const rows = db.prepare(`${LOAN_SELECT} WHERE l.archived = ?`).all(archived ? 1 : 0);
  const loans = rows.map((row) => shape(row, ratesOf(db, row.id), repsOf(db, row.id), today));
  loans.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    if (x !== y) return x < y ? -1 : 1;
    return a.id - b.id;
  });
  return { loans };
}

function get(db, id, today = sydneyToday()) {
  const row = loanRow(db, id);
  const rates = ratesOf(db, id);
  const reps = repsOf(db, id);
  const loan = shape(row, rates, reps, today);
  loan.rates = rates;
  loan.repayments = walk(maths(row), rates, reps).map((r) => ({
    id: r.id,
    paidDate: r.paidDate,
    principalCents: r.principalCents,
    interestCents: r.interestCents,
    totalCents: r.principalCents + r.interestCents,
    balanceAfterCents: r.balanceAfterCents,
    rateBp: r.rateBp,
    workedOutInterestCents: r.workedOutInterestCents,
    reference: r.reference,
    note: r.note,
  }));
  return loan;
}

// ---------------------------------------------------------------- the loan ---

const LOAN_FIELDS = [
  { key: "name", col: "name" },
  { key: "direction", col: "direction" },
  { key: "otherParty", col: "other_party" },
  { key: "openingBalanceCents", col: "opening_balance_cents" },
  { key: "openingDate", col: "opening_date" },
  { key: "note", col: "note" },
  { key: "archived", col: "archived" },
];

// One loan body value, validated and normalised as stored.
function loanValue(key, v, today) {
  switch (key) {
    case "name": {
      if (typeof v !== "string" || v.trim() === "") throw bad("Name is required");
      const s = v.trim();
      if (s.length > 100) throw bad("Name must be 100 characters or fewer");
      return s;
    }
    case "direction":
      if (!DIRECTIONS.includes(v)) throw bad("Direction must be lent_to_business or lent_by_business");
      return v;
    case "otherParty":
      return text(v, "Other party", 200);
    case "openingBalanceCents":
      return cents(v, "The opening balance must be whole cents from $0 to $100,000,000");
    case "openingDate": {
      const d = trimmedDate(v);
      if (!validDate(d)) throw bad("The opening date must be a date");
      if (d > today) throw bad("The opening date can't be in the future");
      return d;
    }
    case "note":
      return text(v, "Note", 1000);
    case "archived":
      if (typeof v !== "boolean") throw bad("Archived must be true or false");
      return v;
    default:
      throw bad(`Unknown field: ${key}`);
  }
}

// The stored loan fields as the API names them (the audit's after on create).
function storedLoan(row) {
  return {
    name: row.name,
    direction: row.direction,
    otherParty: row.other_party,
    openingBalanceCents: row.opening_balance_cents,
    openingDate: row.opening_date,
    note: row.note,
    archived: !!row.archived,
  };
}

function create(db, req, body) {
  const today = sydneyToday();
  onlyKeys(body, ["name", "direction", "otherParty", "openingBalanceCents", "openingDate", "note"]);
  const v = {
    name: loanValue("name", body.name, today),
    direction: loanValue("direction", body.direction, today),
    otherParty: loanValue("otherParty", body.otherParty, today),
    openingBalanceCents: loanValue("openingBalanceCents", body.openingBalanceCents, today),
    openingDate: loanValue("openingDate", body.openingDate, today),
    note: loanValue("note", body.note, today),
  };
  const id = db.transaction(() => {
    const at = nowIso();
    const by = userId(req);
    const info = db
      .prepare(
        `INSERT INTO loans (name, direction, other_party, opening_balance_cents, opening_date, note, archived,
                            created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
      )
      .run(v.name, v.direction, v.otherParty, v.openingBalanceCents, v.openingDate, v.note, at, by, at, by);
    const newId = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "loan.create",
      entityType: "loan",
      entityId: newId,
      after: { id: newId, ...v, archived: false },
    });
    return newId;
  })();
  return get(db, id, today);
}

function update(db, req, id, body) {
  const today = sydneyToday();
  const row = loanRow(db, id);
  onlyKeys(body, LOAN_FIELDS.map((f) => f.key));
  const next = {};
  for (const f of LOAN_FIELDS) if (has(body, f.key)) next[f.key] = loanValue(f.key, body[f.key], today);
  const cur = storedLoan(row);
  const changed = LOAN_FIELDS.filter((f) => has(next, f.key) && next[f.key] !== cur[f.key]);
  if (!changed.length) return get(db, id, today);
  db.transaction(() => {
    const reps = repsOf(db, id);
    if (has(next, "openingDate") && next.openingDate !== cur.openingDate) {
      const early = reps.find((r) => r.paidDate < next.openingDate); // reps are in date order
      if (early) throw conflict(`A repayment is dated before that (${dayLabel(early.paidDate)})`);
    }
    if (has(next, "openingBalanceCents")) checkNotBelowZero({ openingBalanceCents: next.openingBalanceCents }, reps);
    const sets = changed.map((f) => `${f.col} = ?`);
    const args = changed.map((f) => (f.key === "archived" ? (next.archived ? 1 : 0) : next[f.key]));
    db.prepare(`UPDATE loans SET ${sets.join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`).run(
      ...args,
      nowIso(),
      userId(req),
      id
    );
    const before = {};
    const after = {};
    for (const f of changed) {
      before[f.key] = cur[f.key];
      after[f.key] = next[f.key];
    }
    audit.log(req, { action: "loan.update", entityType: "loan", entityId: id, before, after });
  })();
  return get(db, id, today);
}

// Touches the loan's updated_at/by after a rate or repayment write.
function touch(db, req, id) {
  db.prepare("UPDATE loans SET updated_at = ?, updated_by = ? WHERE id = ?").run(nowIso(), userId(req), id);
}

function notArchived(row) {
  if (row.archived) throw conflict("This loan is archived; restore it to change it");
}

// ---------------------------------------------------------------- rates ---

function rateValue(key, v) {
  switch (key) {
    case "fromDate": {
      const d = trimmedDate(v);
      if (!validDate(d)) throw bad("The from date must be a date");
      return d;
    }
    case "rateBp":
      if (!Number.isInteger(v) || v < 0 || v > MAX_RATE_BP) {
        throw bad("The rate must be from 0 to 5000 basis points (0% to 50%)");
      }
      return v;
    case "note":
      return text(v, "Note", 500);
    default:
      throw bad(`Unknown field: ${key}`);
  }
}

function rateRow(db, loanId, rateId) {
  const row = db.prepare("SELECT * FROM loan_rates WHERE id = ? AND loan_id = ?").get(rateId, loanId);
  if (!row) throw notFound();
  return row;
}

function sameFromDate(db, loanId, fromDate, exceptId) {
  const clash = db
    .prepare("SELECT id FROM loan_rates WHERE loan_id = ? AND from_date = ? AND id <> ?")
    .get(loanId, fromDate, exceptId || 0);
  if (clash) throw conflict(`There is already a rate from ${dayLabel(fromDate)}`);
}

function addRate(db, req, id, body) {
  const loan = loanRow(db, id);
  notArchived(loan);
  onlyKeys(body, ["fromDate", "rateBp", "note"]);
  const v = {
    fromDate: rateValue("fromDate", body.fromDate),
    rateBp: rateValue("rateBp", body.rateBp),
    note: rateValue("note", body.note),
  };
  db.transaction(() => {
    sameFromDate(db, id, v.fromDate, 0);
    const info = db
      .prepare(
        "INSERT INTO loan_rates (loan_id, from_date, rate_bp, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, v.fromDate, v.rateBp, v.note, nowIso(), userId(req));
    touch(db, req, id);
    audit.log(req, {
      action: "loan.rate_add",
      entityType: "loan",
      entityId: id,
      after: { id: Number(info.lastInsertRowid), ...v },
    });
  })();
  return get(db, id);
}

function updateRate(db, req, id, rateId, body) {
  const loan = loanRow(db, id);
  const row = rateRow(db, id, rateId);
  notArchived(loan);
  onlyKeys(body, ["fromDate", "rateBp", "note"]);
  const cur = rateOf(row);
  const next = { ...cur };
  for (const k of ["fromDate", "rateBp", "note"]) if (has(body, k)) next[k] = rateValue(k, body[k]);
  if (next.fromDate === cur.fromDate && next.rateBp === cur.rateBp && next.note === cur.note) return get(db, id);
  db.transaction(() => {
    if (next.fromDate !== cur.fromDate) sameFromDate(db, id, next.fromDate, rateId);
    db.prepare("UPDATE loan_rates SET from_date = ?, rate_bp = ?, note = ? WHERE id = ?").run(
      next.fromDate,
      next.rateBp,
      next.note,
      rateId
    );
    touch(db, req, id);
    audit.log(req, { action: "loan.rate_update", entityType: "loan", entityId: id, before: cur, after: next });
  })();
  return get(db, id);
}

function deleteRate(db, req, id, rateId) {
  const loan = loanRow(db, id);
  const row = rateRow(db, id, rateId);
  notArchived(loan);
  db.transaction(() => {
    db.prepare("DELETE FROM loan_rates WHERE id = ?").run(rateId);
    touch(db, req, id);
    audit.log(req, { action: "loan.rate_delete", entityType: "loan", entityId: id, before: rateOf(row) });
  })();
  return get(db, id);
}

// ---------------------------------------------------------------- repayments ---

const REP_KEYS = ["paidDate", "principalCents", "interestCents", "reference", "note"];

function repValue(key, v, loan, today) {
  switch (key) {
    case "paidDate": {
      const d = trimmedDate(v);
      if (!validDate(d)) throw bad("The paid date must be a date");
      if (d > today) throw bad("The paid date can't be in the future");
      if (d < loan.opening_date) throw bad(`A repayment can't be before the opening date (${dayLabel(loan.opening_date)})`);
      return d;
    }
    case "principalCents":
      return cents(v, "The principal must be whole cents from $0 to $100,000,000");
    case "interestCents":
      return cents(v, "The interest must be whole cents from $0 to $100,000,000");
    case "reference":
      return text(v, "Reference", 100);
    case "note":
      return text(v, "Note", 500);
    default:
      throw bad(`Unknown field: ${key}`);
  }
}

function repRow(db, loanId, repId) {
  const row = db.prepare("SELECT * FROM loan_repayments WHERE id = ? AND loan_id = ?").get(repId, loanId);
  if (!row) throw notFound();
  return row;
}

function bothZero(v) {
  if (v.principalCents === 0 && v.interestCents === 0) throw bad("Enter the principal, the interest or both");
}

function addRepayment(db, req, id, body) {
  const today = sydneyToday();
  const loan = loanRow(db, id);
  notArchived(loan);
  onlyKeys(body, REP_KEYS);
  const v = {
    paidDate: repValue("paidDate", body.paidDate, loan, today),
    principalCents: has(body, "principalCents") ? repValue("principalCents", body.principalCents, loan, today) : 0,
    interestCents: has(body, "interestCents") ? repValue("interestCents", body.interestCents, loan, today) : null,
    reference: repValue("reference", body.reference, loan, today),
    note: repValue("note", body.note, loan, today),
  };
  db.transaction(() => {
    const reps = repsOf(db, id);
    if (v.interestCents === null) {
      const s = suggest(maths(loan), ratesOf(db, id), reps, v.paidDate, null);
      if (s.interestCents === null) {
        throw bad(`No rate covers ${dayLabel(v.paidDate)}: type the interest or add a rate`);
      }
      v.interestCents = s.interestCents;
    }
    bothZero(v);
    // The new row sorts after every existing row of its date (a higher id).
    checkNotBelowZero(maths(loan), reps.concat([{ id: Number.MAX_SAFE_INTEGER, ...v }]));
    const at = nowIso();
    const by = userId(req);
    const info = db
      .prepare(
        `INSERT INTO loan_repayments (loan_id, paid_date, principal_cents, interest_cents, reference, note,
                                      created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, v.paidDate, v.principalCents, v.interestCents, v.reference, v.note, at, by, at, by);
    touch(db, req, id);
    audit.log(req, {
      action: "loan.repayment_add",
      entityType: "loan",
      entityId: id,
      after: { id: Number(info.lastInsertRowid), ...v },
    });
  })();
  return get(db, id, today);
}

function updateRepayment(db, req, id, repId, body) {
  const today = sydneyToday();
  const loan = loanRow(db, id);
  const row = repRow(db, id, repId);
  notArchived(loan);
  onlyKeys(body, REP_KEYS);
  const cur = repOf(row);
  const next = { ...cur };
  for (const k of REP_KEYS) if (has(body, k)) next[k] = repValue(k, body[k], loan, today);
  if (REP_KEYS.every((k) => next[k] === cur[k])) return get(db, id, today);
  bothZero(next);
  db.transaction(() => {
    const reps = repsOf(db, id).map((r) => (r.id === repId ? next : r));
    checkNotBelowZero(maths(loan), reps);
    db.prepare(
      `UPDATE loan_repayments SET paid_date = ?, principal_cents = ?, interest_cents = ?, reference = ?, note = ?,
                                  updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(next.paidDate, next.principalCents, next.interestCents, next.reference, next.note, nowIso(), userId(req), repId);
    touch(db, req, id);
    audit.log(req, { action: "loan.repayment_update", entityType: "loan", entityId: id, before: cur, after: next });
  })();
  return get(db, id, today);
}

function deleteRepayment(db, req, id, repId) {
  const loan = loanRow(db, id);
  const row = repRow(db, id, repId);
  notArchived(loan);
  db.transaction(() => {
    // Removing principal only raises later balances, so nothing can go below zero.
    db.prepare("DELETE FROM loan_repayments WHERE id = ?").run(repId);
    touch(db, req, id);
    audit.log(req, { action: "loan.repayment_delete", entityType: "loan", entityId: id, before: repOf(row) });
  })();
  return get(db, id);
}

// ---------------------------------------------------------------- the suggestion ---

// Section 6.2: {date, balanceCents, rateBp, interestCents, alreadyCharged}. repaymentId (a number
// or the query's string) names a repayment being edited, which is left out; not one of this loan's
// repayments -> 404.
function interest(db, id, { date, repaymentId } = {}) {
  const loan = loanRow(db, id);
  const d = trimmedDate(date);
  if (!validDate(d)) throw bad("date must be a date");
  let repId = null;
  if (repaymentId !== undefined && repaymentId !== null && repaymentId !== "") {
    const n = typeof repaymentId === "number" ? repaymentId : /^[1-9]\d*$/.test(String(repaymentId)) ? Number(repaymentId) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) throw notFound();
    repRow(db, id, n);
    repId = n;
  }
  return suggest(maths(loan), ratesOf(db, id), repsOf(db, id), d, repId);
}

// ---------------------------------------------------------------- the statement (section 8.2) ---

function statement(db, id, { from, to } = {}) {
  const row = loanRow(db, id);
  const blank = (v) => v === undefined || v === null || v === "";
  const f = blank(from) ? row.opening_date : trimmedDate(from);
  const t = blank(to) ? sydneyToday() : trimmedDate(to);
  if (!validDate(f) || !validDate(t)) throw bad("from and to must be dates");
  if (t < f) throw bad("The statement can't end before it starts");
  const rates = ratesOf(db, id);
  const walked = walk(maths(row), rates, repsOf(db, id));
  let start = row.opening_balance_cents;
  for (const r of walked) if (r.paidDate < f) start = r.balanceAfterCents;
  const rows = walked
    .filter((r) => r.paidDate >= f && r.paidDate <= t)
    .map((r) => ({
      paidDate: r.paidDate,
      reference: r.reference,
      principalCents: r.principalCents,
      interestCents: r.interestCents,
      totalCents: r.principalCents + r.interestCents,
      balanceAfterCents: r.balanceAfterCents,
    }));
  const totals = { principalCents: 0, interestCents: 0, totalCents: 0 };
  for (const r of rows) {
    totals.principalCents += r.principalCents;
    totals.interestCents += r.interestCents;
    totals.totalCents += r.totalCents;
  }
  // Every rate in force at some point in the period: the one in force on `from`, then each that
  // starts inside the period.
  const inForce = rates.filter((r) => r.fromDate <= f).pop();
  const periodRates = (inForce ? [inForce] : [])
    .concat(rates.filter((r) => r.fromDate > f && r.fromDate <= t))
    .map((r) => ({ fromDate: r.fromDate, rateBp: r.rateBp }));
  return {
    loan: { id: row.id, name: row.name, direction: row.direction, otherParty: row.other_party, openingDate: row.opening_date },
    from: f,
    to: t,
    balanceAtStartCents: start,
    rows,
    totals,
    balanceAtEndCents: rows.length ? rows[rows.length - 1].balanceAfterCents : start,
    rates: periodRates,
  };
}

module.exports = {
  list,
  get,
  create,
  update,
  addRate,
  updateRate,
  deleteRate,
  addRepayment,
  updateRepayment,
  deleteRepayment,
  interest,
  statement,
  // The pure maths, for the section 11.8 node run (not part of the binding exports).
  _maths: { roundDiv, rateOn, walk, suggest, fyOf },
};
