// Loans (docs/plans/m13-contracts.md section 6, changed 2026-10-24 by Todd): each loan's opening
// balance, rate history, payments, month interest and plan; the balance always calculated, a month
// table like Todd's spreadsheet, the plan laid out ahead, the statement.
//
// Every function takes db first and nothing here requires ../db. Every write runs in one
// db.transaction with its audit row (entity type loan only, section 3.6). The route declares only
// loans.manage; every rule about loans lives here.
//
// The maths (section 6.2, changed 2026-10-24):
// - months run from the opening month to the current month (Sydney);
// - interest is charged ONCE per calendar month: the balance at the start of the month (after every
//   earlier month) x the annual rate in force on the 1st / 12, half up to the cent
//   (roundDiv(balance x rate bp, 120000)), and ADDED to the balance. The first month charged is the
//   opening month when the loan opened on the 1st, otherwise the month after it. A month's charge
//   may be typed instead (loan_month_interest) to match a lender statement;
// - a payment takes its TOTAL off the balance. It is split automatically: the interest part is the
//   month's interest still unpaid (earlier payments that month first), the rest is principal. The
//   interest part may be typed (interest_override) to match a statement; that changes only the
//   split, never the balance. The split is stored after every write (principal_cents +
//   interest_cents = the total);
// - no write may take the balance below zero after any payment;
// - the plan (a fixed amount a month, or paid off by a month) is laid out from this month when
//   nothing has been paid this month yet, otherwise from next month, up to 120 months.
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

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PLAN_MONTHS = 120;

// "2026-10" + 2 -> "2026-12".
function addMonths(p, n) {
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}

function monthsBetween(a, b) {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
}

// "2026-10" -> "Oct 26" (the spreadsheet's label); periodWords -> "Oct 2026".
function periodLabel(p) {
  return `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(2, 4)}`;
}
function periodWords(p) {
  return `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
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

// The first month that is charged interest: the opening month when opened on the 1st, else the next.
function firstCharged(openingDate) {
  const p = openingDate.slice(0, 7);
  return openingDate.slice(8) === "01" ? p : addMonths(p, 1);
}

// The month table. loan: {openingBalanceCents, openingDate}; rates: [{fromDate, rateBp}];
// reps: [{id, paidDate, principalCents, interestCents, interestOverride}] (total = principal +
// interest); overrides: Map period -> {interestCents, note}. Pure.
// Returns {months: [...], balanceCents}. Each month: {period, label, startBalanceCents, rateBp,
// charged (false for an uncharged opening month), workedOutInterestCents, interestCents (charged),
// interestOverridden, overrideNote, payments: [...], unpaidInterestCents, endBalanceCents, current}.
// Each payment: the rep with totalCents, its split (principalCents, interestCents), the automatic
// interest part (workedOutInterestCents), unpaidBeforeCents, balanceBeforeCents, balanceAfterCents.
function ledger(loan, rates, reps, overrides, today) {
  const open = loan.openingDate;
  const first = firstCharged(open);
  const byPeriod = new Map();
  let lastP = today.slice(0, 7);
  for (const r of reps.slice().sort(byDateThenId)) {
    const p = r.paidDate.slice(0, 7);
    if (!byPeriod.has(p)) byPeriod.set(p, []);
    byPeriod.get(p).push(r);
    if (p > lastP) lastP = p;
  }
  const cur = today.slice(0, 7);
  const months = [];
  let bal = loan.openingBalanceCents;
  for (let p = open.slice(0, 7); p <= lastP; p = addMonths(p, 1)) {
    const start = bal;
    const rateBp = rateOn(rates, `${p}-01`);
    const charged = p >= first;
    let worked = null;
    let interest = 0;
    let overridden = false;
    let overrideNote = "";
    if (charged) {
      worked = rateBp === null ? null : roundDiv(Math.max(start, 0) * rateBp, 120000);
      const o = overrides && overrides.get(p);
      if (o) {
        interest = o.interestCents;
        overridden = true;
        overrideNote = o.note || "";
      } else interest = worked === null ? 0 : worked;
    }
    bal += interest;
    let unpaid = interest;
    const payments = (byPeriod.get(p) || []).map((r) => {
      const total = r.principalCents + r.interestCents;
      const auto = Math.min(total, unpaid);
      const part = r.interestOverride ? Math.min(r.interestCents, total) : auto;
      const before = bal;
      const unpaidBefore = unpaid;
      unpaid = Math.max(0, unpaid - part);
      bal -= total;
      return {
        ...r,
        totalCents: total,
        principalCents: total - part,
        interestCents: part,
        workedOutInterestCents: auto,
        unpaidBeforeCents: unpaidBefore,
        balanceBeforeCents: before,
        balanceAfterCents: bal,
        rateBp,
      };
    });
    months.push({
      period: p,
      label: periodLabel(p),
      startBalanceCents: start,
      rateBp,
      charged,
      workedOutInterestCents: worked,
      interestCents: interest,
      interestOverridden: overridden,
      overrideNote,
      payments,
      unpaidInterestCents: unpaid,
      endBalanceCents: bal,
      current: p === cur,
    });
  }
  return { months, balanceCents: bal };
}

// 409 when the balance would go below zero after some payment (the first such date).
function checkNotBelowZero(led) {
  for (const m of led.months) {
    for (const r of m.payments) {
      if (r.balanceAfterCents < 0) throw conflict(`That would take the balance below zero on ${dayLabel(r.paidDate)}`);
    }
  }
}

// The even monthly payment that clears balance b in n payments at rateBp (monthly rate bp/120000),
// rounded up to the cent. inFirst: the first payment's month interest is already in b.
function evenPayment(b, rateBp, n, inFirst) {
  if (b <= 0) return 0;
  if (n < 1) n = 1;
  const r = (rateBp || 0) / 120000;
  if (r === 0) return Math.ceil(b / n);
  const f = Math.pow(1 + r, n);
  const t = inFirst ? (b * r * Math.pow(1 + r, n - 1)) / (f - 1) : (b * r * f) / (f - 1);
  return Math.ceil(t - 1e-6);
}

// The plan laid out ahead (pure). plan: {kind: 'amount'|'payoff', amountCents, payoffPeriod}.
// Starts with this month when nothing has been paid this month (its interest is already charged),
// otherwise next month; at most 120 lines; stops when the balance reaches zero.
function project(led, rates, plan, today) {
  if (!plan || !plan.kind) return null;
  const cur = today.slice(0, 7);
  const last = led.months[led.months.length - 1];
  let b = led.balanceCents;
  const thisMonth = last && last.period === cur ? last : null;
  const inFirst = !!thisMonth && thisMonth.payments.length === 0 && b > 0;
  const startP = inFirst ? cur : addMonths(cur, 1);
  const out = {
    kind: plan.kind,
    amountCents: plan.kind === "amount" ? plan.amountCents : null,
    payoffPeriod: plan.kind === "payoff" ? plan.payoffPeriod : null,
    startPeriod: startP,
    paymentCents: 0,
    coversInterest: true,
    paidOffPeriod: null,
    rows: [],
  };
  if (b <= 0) {
    out.paidOffPeriod = last ? last.period : cur;
    return out;
  }
  let pay;
  if (plan.kind === "amount") pay = plan.amountCents;
  else {
    const n = Math.max(1, monthsBetween(startP, plan.payoffPeriod) + 1);
    const rate = rateOn(rates, `${startP}-01`);
    pay = evenPayment(b, rate, n, inFirst);
  }
  out.paymentCents = pay;
  let checked = false;
  for (let k = 0; k < PLAN_MONTHS && b > 0; k++) {
    const p = addMonths(startP, k);
    let unpaid;
    let charged;
    if (k === 0 && inFirst) {
      unpaid = thisMonth.unpaidInterestCents;
      charged = thisMonth.interestCents;
    } else {
      const rate = rateOn(rates, `${p}-01`);
      charged = roundDiv(b * (rate || 0), 120000);
      b += charged;
      unpaid = charged;
      if (!checked) {
        checked = true;
        if (pay <= charged) out.coversInterest = false;
      }
    }
    let total = Math.min(pay, b);
    if (plan.kind === "payoff" && p >= plan.payoffPeriod) total = b;
    const part = Math.min(total, unpaid);
    b -= total;
    out.rows.push({
      period: p,
      label: periodLabel(p),
      thisMonth: p === cur,
      chargedInterestCents: charged,
      principalCents: total - part,
      interestCents: part,
      totalCents: total,
      balanceAfterCents: b,
    });
    if (b <= 0) out.paidOffPeriod = p;
  }
  if (!checked && plan.kind === "amount" && b > 0) out.coversInterest = pay > 0;
  return out;
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
    interestOverride: !!row.interest_override,
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

function overridesOf(db, loanId) {
  const m = new Map();
  for (const r of db.prepare("SELECT period, interest_cents, note FROM loan_month_interest WHERE loan_id = ?").all(loanId)) {
    m.set(r.period, { interestCents: r.interest_cents, note: r.note });
  }
  return m;
}

function maths(row) {
  return { openingBalanceCents: row.opening_balance_cents, openingDate: row.opening_date };
}

function planOf(row) {
  if (!row.plan_kind) return null;
  return { kind: row.plan_kind, amountCents: row.plan_amount_cents, payoffPeriod: row.plan_payoff_period };
}

// The ledger of a stored loan, optionally with changed reps/rates/overrides/opening (a write's check).
function ledgerOf(db, row, today, changes = {}) {
  return ledger(
    changes.loan || maths(row),
    changes.rates || ratesOf(db, row.id),
    changes.reps || repsOf(db, row.id),
    changes.overrides || overridesOf(db, row.id),
    today
  );
}

// After a write: store each automatic split as the month table works it out.
function resync(db, row, today) {
  const led = ledgerOf(db, row, today);
  const upd = db.prepare("UPDATE loan_repayments SET principal_cents = ?, interest_cents = ? WHERE id = ?");
  for (const m of led.months) {
    for (const r of m.payments) {
      if (!r.interestOverride) upd.run(r.principalCents, r.interestCents, r.id);
    }
  }
}

// Inside a write's transaction: refuse (rolling back) when the balance would go below zero, and
// store the splits as worked out.
function settle(db, loanId) {
  const today = sydneyToday();
  const row = loanRow(db, loanId);
  checkNotBelowZero(ledgerOf(db, row, today));
  resync(db, row, today);
}

function paymentOut(r) {
  return {
    id: r.id,
    paidDate: r.paidDate,
    principalCents: r.principalCents,
    interestCents: r.interestCents,
    totalCents: r.totalCents,
    balanceAfterCents: r.balanceAfterCents,
    rateBp: r.rateBp,
    workedOutInterestCents: r.workedOutInterestCents,
    interestOverride: r.interestOverride,
    reference: r.reference,
    note: r.note,
  };
}

// Section 6.1: the loan object, with its month table and plan.
function shape(row, rates, led, today) {
  const fy = fyOf(today);
  const fyStartP = fy.start.slice(0, 7);
  const fyEndP = fy.end.slice(0, 7);
  let fyPrincipal = 0;
  let fyInterest = 0;
  let last = null;
  const repayments = [];
  for (const m of led.months) {
    const inFy = m.period >= fyStartP && m.period <= fyEndP;
    if (inFy) fyInterest += m.interestCents;
    for (const r of m.payments) {
      if (inFy) fyPrincipal += r.principalCents;
      if (!last || r.paidDate > last) last = r.paidDate;
      repayments.push(paymentOut(r));
    }
  }
  const plan = planOf(row);
  return {
    id: row.id,
    name: row.name,
    direction: row.direction,
    otherParty: row.other_party,
    openingBalanceCents: row.opening_balance_cents,
    openingDate: row.opening_date,
    note: row.note,
    archived: !!row.archived,
    balanceCents: led.balanceCents,
    rateBp: rateOn(rates, today),
    lastPaidDate: last,
    fy: { label: fy.label, principalCents: fyPrincipal, interestCents: fyInterest },
    rates,
    months: led.months.map((m) => ({
      period: m.period,
      label: m.label,
      startBalanceCents: m.startBalanceCents,
      rateBp: m.rateBp,
      charged: m.charged,
      interestCents: m.interestCents,
      workedOutInterestCents: m.workedOutInterestCents,
      interestOverridden: m.interestOverridden,
      overrideNote: m.overrideNote,
      unpaidInterestCents: m.unpaidInterestCents,
      endBalanceCents: m.endBalanceCents,
      current: m.current,
      payments: m.payments.map(paymentOut),
    })),
    repayments,
    plan: plan ? project(led, rates, plan, today) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by == null ? null : { id: row.updated_by, name: row.updated_by_name || null },
  };
}

function shapeRow(db, row, today) {
  const rates = ratesOf(db, row.id);
  return shape(row, rates, ledgerOf(db, row, today, { rates }), today);
}

function list(db, { archived = false } = {}, today = sydneyToday()) {
  const rows = db.prepare(`${LOAN_SELECT} WHERE l.archived = ?`).all(archived ? 1 : 0);
  const loans = rows.map((row) => shapeRow(db, row, today));
  loans.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    if (x !== y) return x < y ? -1 : 1;
    return a.id - b.id;
  });
  return { loans };
}

function get(db, id, today = sydneyToday()) {
  return shapeRow(db, loanRow(db, id), today);
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
      if (early) throw conflict(`A payment is dated before that (${dayLabel(early.paidDate)})`);
    }
    const sets = changed.map((f) => `${f.col} = ?`);
    const args = changed.map((f) => (f.key === "archived" ? (next.archived ? 1 : 0) : next[f.key]));
    db.prepare(`UPDATE loans SET ${sets.join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`).run(
      ...args,
      nowIso(),
      userId(req),
      id
    );
    settle(db, id);
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
    settle(db, id);
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
    settle(db, id);
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
    settle(db, id);
    audit.log(req, { action: "loan.rate_delete", entityType: "loan", entityId: id, before: rateOf(row) });
  })();
  return get(db, id);
}

// ---------------------------------------------------------------- payments ---

// totalCents is what was paid; interestCents (optional) types the interest part to match a lender
// statement (null clears it: the split is worked out again).
const REP_KEYS = ["paidDate", "totalCents", "interestCents", "reference", "note"];

function repValue(key, v, loan, today) {
  switch (key) {
    case "paidDate": {
      const d = trimmedDate(v);
      if (!validDate(d)) throw bad("The paid date must be a date");
      if (d > today) throw bad("The paid date can't be in the future");
      if (d < loan.opening_date) throw bad(`A payment can't be before the opening date (${dayLabel(loan.opening_date)})`);
      return d;
    }
    case "totalCents":
      if (!Number.isInteger(v) || v < 1 || v > MAX_CENTS) throw bad("The total paid must be whole cents from $0.01 to $100,000,000");
      return v;
    case "interestCents":
      if (v === null) return null;
      return cents(v, "The interest part must be whole cents from $0 to $100,000,000");
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

// The stored form of a payment: {paidDate, totalCents, interestOverride, interestCents|null, ...}.
function storedRep(r) {
  return {
    paidDate: r.paidDate,
    totalCents: r.principalCents + r.interestCents,
    interestCents: r.interestOverride ? r.interestCents : null,
    reference: r.reference,
    note: r.note,
  };
}

// A stored payment -> the ledger's rep (an unset override stores the whole total as principal
// until resync splits it).
function ledgerRep(id, v) {
  const typed = v.interestCents !== null && v.interestCents !== undefined;
  if (typed && v.interestCents > v.totalCents) throw bad("The interest part can't be more than the total paid");
  return {
    id,
    paidDate: v.paidDate,
    principalCents: typed ? v.totalCents - v.interestCents : v.totalCents,
    interestCents: typed ? v.interestCents : 0,
    interestOverride: typed,
    reference: v.reference,
    note: v.note,
  };
}

function addRepayment(db, req, id, body) {
  const today = sydneyToday();
  const loan = loanRow(db, id);
  notArchived(loan);
  onlyKeys(body, REP_KEYS);
  if (!has(body, "totalCents")) throw bad("Enter the total paid");
  const v = {
    paidDate: repValue("paidDate", body.paidDate, loan, today),
    totalCents: repValue("totalCents", body.totalCents, loan, today),
    interestCents: has(body, "interestCents") ? repValue("interestCents", body.interestCents, loan, today) : null,
    reference: repValue("reference", body.reference, loan, today),
    note: repValue("note", body.note, loan, today),
  };
  const lr = ledgerRep(Number.MAX_SAFE_INTEGER, v);
  db.transaction(() => {
    const reps = repsOf(db, id);
    // The new row sorts after every existing row of its date (a higher id).
    checkNotBelowZero(ledgerOf(db, loan, today, { reps: reps.concat([lr]) }));
    const at = nowIso();
    const by = userId(req);
    const info = db
      .prepare(
        `INSERT INTO loan_repayments (loan_id, paid_date, principal_cents, interest_cents, interest_override, reference, note,
                                      created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, v.paidDate, lr.principalCents, lr.interestCents, lr.interestOverride ? 1 : 0, v.reference, v.note, at, by, at, by);
    touch(db, req, id);
    resync(db, loan, today);
    const newId = Number(info.lastInsertRowid);
    const saved = repOf(repRow(db, id, newId));
    audit.log(req, {
      action: "loan.repayment_add",
      entityType: "loan",
      entityId: id,
      after: { id: newId, ...v, principalCents: saved.principalCents, interestCents: saved.interestCents, interestOverride: saved.interestOverride },
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
  const cur = storedRep(repOf(row));
  const next = { ...cur };
  for (const k of REP_KEYS) if (has(body, k)) next[k] = repValue(k, body[k], loan, today);
  if (REP_KEYS.every((k) => next[k] === cur[k])) return get(db, id, today);
  const lr = ledgerRep(repId, next);
  db.transaction(() => {
    const reps = repsOf(db, id).map((r) => (r.id === repId ? lr : r));
    checkNotBelowZero(ledgerOf(db, loan, today, { reps }));
    db.prepare(
      `UPDATE loan_repayments SET paid_date = ?, principal_cents = ?, interest_cents = ?, interest_override = ?, reference = ?, note = ?,
                                  updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(next.paidDate, lr.principalCents, lr.interestCents, lr.interestOverride ? 1 : 0, next.reference, next.note, nowIso(), userId(req), repId);
    touch(db, req, id);
    resync(db, loan, today);
    audit.log(req, { action: "loan.repayment_update", entityType: "loan", entityId: id, before: cur, after: next });
  })();
  return get(db, id, today);
}

function deleteRepayment(db, req, id, repId) {
  const today = sydneyToday();
  const loan = loanRow(db, id);
  const row = repRow(db, id, repId);
  notArchived(loan);
  db.transaction(() => {
    // Removing a payment only raises later balances, so nothing can go below zero.
    db.prepare("DELETE FROM loan_repayments WHERE id = ?").run(repId);
    touch(db, req, id);
    resync(db, loan, today);
    const r = repOf(row);
    audit.log(req, {
      action: "loan.repayment_delete",
      entityType: "loan",
      entityId: id,
      before: { ...storedRep(r), principalCents: r.principalCents },
    });
  })();
  return get(db, id, today);
}

// ---------------------------------------------------------------- the split for a date ---

// Section 6.2: what a payment on `date` would meet. {date, period, rateBp, charged,
// monthInterestCents, paidBeforeCents, outstandingCents, balanceCents (just before it),
// interestCents (= outstanding: the interest part of a payment at least that big)}.
// repaymentId (a number or the query's string) names a payment being edited, which is left out;
// not one of this loan's payments -> 404.
function interest(db, id, { date, repaymentId } = {}) {
  const today = sydneyToday();
  const loan = loanRow(db, id);
  const d = trimmedDate(date);
  if (!validDate(d)) throw bad("date must be a date");
  if (d < loan.opening_date) throw bad(`A payment can't be before the opening date (${dayLabel(loan.opening_date)})`);
  let repId = null;
  if (repaymentId !== undefined && repaymentId !== null && repaymentId !== "") {
    const n = typeof repaymentId === "number" ? repaymentId : /^[1-9]\d*$/.test(String(repaymentId)) ? Number(repaymentId) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) throw notFound();
    repRow(db, id, n);
    repId = n;
  }
  // A zero phantom payment where the payment would sit shows what it meets.
  const phantomId = repId || Number.MAX_SAFE_INTEGER;
  const reps = repsOf(db, id)
    .filter((r) => r.id !== repId)
    .concat([{ id: phantomId, paidDate: d, principalCents: 0, interestCents: 0, interestOverride: false }]);
  const led = ledgerOf(db, loan, today, { reps });
  const m = led.months.find((x) => x.period === d.slice(0, 7));
  const ph = m.payments.find((r) => r.id === phantomId);
  return {
    date: d,
    period: m.period,
    rateBp: m.rateBp,
    charged: m.charged,
    monthInterestCents: m.interestCents,
    paidBeforeCents: m.interestCents - ph.unpaidBeforeCents,
    outstandingCents: ph.unpaidBeforeCents,
    balanceCents: ph.balanceBeforeCents,
    interestCents: ph.unpaidBeforeCents,
  };
}

// ---------------------------------------------------------------- month interest ---

// PUT {interestCents: n | null, note}: type a month's charged interest (null: back to worked out).
function setMonthInterest(db, req, id, period, body) {
  const today = sydneyToday();
  const loan = loanRow(db, id);
  notArchived(loan);
  onlyKeys(body, ["interestCents", "note"]);
  if (typeof period !== "string" || !PERIOD_RE.test(period)) throw notFound();
  if (!has(body, "interestCents")) throw bad("Enter the interest for the month, or null to work it out");
  const v = body.interestCents === null ? null : cents(body.interestCents, "The interest must be whole cents from $0 to $100,000,000");
  const note = text(body.note, "Note", 500);
  if (period < firstCharged(loan.opening_date) || period > today.slice(0, 7)) {
    throw bad(`${periodWords(period)} isn't charged interest on this loan`);
  }
  const old = db.prepare("SELECT interest_cents, note FROM loan_month_interest WHERE loan_id = ? AND period = ?").get(id, period);
  const before = old ? { period, interestCents: old.interest_cents, note: old.note } : { period, interestCents: null };
  const after = v === null ? { period, interestCents: null } : { period, interestCents: v, note };
  if (JSON.stringify(before) === JSON.stringify(after)) return get(db, id, today);
  db.transaction(() => {
    const ov = overridesOf(db, id);
    if (v === null) ov.delete(period);
    else ov.set(period, { interestCents: v, note });
    checkNotBelowZero(ledgerOf(db, loan, today, { overrides: ov }));
    if (v === null) db.prepare("DELETE FROM loan_month_interest WHERE loan_id = ? AND period = ?").run(id, period);
    else {
      db.prepare(
        `INSERT INTO loan_month_interest (loan_id, period, interest_cents, note, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (loan_id, period) DO UPDATE SET interest_cents = excluded.interest_cents, note = excluded.note,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ).run(id, period, v, note, nowIso(), userId(req));
    }
    touch(db, req, id);
    resync(db, loan, today);
    audit.log(req, { action: "loan.month_interest", entityType: "loan", entityId: id, before, after });
  })();
  return get(db, id, today);
}

// ---------------------------------------------------------------- the plan ---

// {kind: 'amount', amountCents} | {kind: 'payoff', payoffPeriod: 'YYYY-MM'} | {kind: null}.
function planValue(body, today) {
  const kind = body.kind === undefined ? null : body.kind;
  if (kind === null) return null;
  if (kind === "amount") {
    const a = body.amountCents;
    if (!Number.isInteger(a) || a < 1 || a > MAX_CENTS) throw bad("The monthly amount must be whole cents from $0.01 to $100,000,000");
    return { kind, amountCents: a, payoffPeriod: null };
  }
  if (kind === "payoff") {
    const p = typeof body.payoffPeriod === "string" ? body.payoffPeriod.trim() : body.payoffPeriod;
    if (typeof p !== "string" || !PERIOD_RE.test(p)) throw bad("The payoff month must be a month (YYYY-MM)");
    const cur = today.slice(0, 7);
    if (p <= cur) throw bad("The payoff month must be next month or later");
    if (monthsBetween(cur, p) > PLAN_MONTHS) throw bad("The payoff month must be within 10 years");
    return { kind, amountCents: null, payoffPeriod: p };
  }
  throw bad("The plan must be amount, payoff or none");
}

function setPlan(db, req, id, body) {
  const today = sydneyToday();
  const loan = loanRow(db, id);
  notArchived(loan);
  onlyKeys(body, ["kind", "amountCents", "payoffPeriod"]);
  const next = planValue(body, today);
  const cur = planOf(loan);
  if (JSON.stringify(cur) === JSON.stringify(next)) return get(db, id, today);
  db.transaction(() => {
    db.prepare(
      "UPDATE loans SET plan_kind = ?, plan_amount_cents = ?, plan_payoff_period = ?, updated_at = ?, updated_by = ? WHERE id = ?"
    ).run(next ? next.kind : null, next ? next.amountCents : null, next ? next.payoffPeriod : null, nowIso(), userId(req), id);
    audit.log(req, { action: "loan.plan", entityType: "loan", entityId: id, before: cur, after: next });
  })();
  return get(db, id, today);
}

// GET ?kind=&amountCents=&payoffPeriod=: the plan laid out without saving it (the dialog's preview).
function previewPlan(db, id, q = {}) {
  const today = sydneyToday();
  const row = loanRow(db, id);
  const body = { kind: q.kind || null };
  if (q.amountCents !== undefined) body.amountCents = /^\d+$/.test(String(q.amountCents)) ? Number(q.amountCents) : NaN;
  if (q.payoffPeriod !== undefined) body.payoffPeriod = q.payoffPeriod;
  const plan = planValue(body, today);
  const rates = ratesOf(db, id);
  return { plan: plan ? project(ledgerOf(db, row, today, { rates }), rates, plan, today) : null };
}

// ---------------------------------------------------------------- the statement (section 8.2) ---

// Whole months: from the month of `from` to the month of `to` (default: the opening date, today).
// rows: a line per payment (the month label on its first line) and a line for a month with no
// payment (the interest charged, nothing paid).
function statement(db, id, { from, to } = {}) {
  const today = sydneyToday();
  const row = loanRow(db, id);
  const blank = (v) => v === undefined || v === null || v === "";
  const f = blank(from) ? row.opening_date : trimmedDate(from);
  const t = blank(to) ? today : trimmedDate(to);
  if (!validDate(f) || !validDate(t)) throw bad("from and to must be dates");
  if (t < f) throw bad("The statement can't end before it starts");
  const rates = ratesOf(db, id);
  const led = ledgerOf(db, row, today, { rates });
  const fp = f.slice(0, 7);
  const tp = t.slice(0, 7);
  const months = led.months.filter((m) => m.period >= fp && m.period <= tp);
  let start = row.opening_balance_cents;
  for (const m of led.months) if (m.period < fp) start = m.endBalanceCents;
  const rows = [];
  const totals = { interestChargedCents: 0, principalCents: 0, interestCents: 0, totalCents: 0 };
  for (const m of months) {
    totals.interestChargedCents += m.interestCents;
    if (!m.payments.length) {
      rows.push({
        period: m.period, label: m.label, first: true, paidDate: null, reference: "",
        principalCents: null, interestCents: m.interestCents, totalCents: null,
        balanceAfterCents: m.endBalanceCents, interestChargedCents: m.interestCents,
      });
      continue;
    }
    m.payments.forEach((r, i) => {
      totals.principalCents += r.principalCents;
      totals.interestCents += r.interestCents;
      totals.totalCents += r.totalCents;
      rows.push({
        period: m.period, label: m.label, first: i === 0, paidDate: r.paidDate, reference: r.reference,
        principalCents: r.principalCents, interestCents: r.interestCents, totalCents: r.totalCents,
        balanceAfterCents: r.balanceAfterCents, interestChargedCents: i === 0 ? m.interestCents : null,
      });
    });
  }
  // Every rate in force at some point in the period: the one in force on the 1st of the first
  // month, then each that starts inside the period.
  const fromDay = `${fp}-01`;
  const inForce = rates.filter((r) => r.fromDate <= fromDay).pop();
  const periodRates = (inForce ? [inForce] : [])
    .concat(rates.filter((r) => r.fromDate > fromDay && r.fromDate <= t))
    .map((r) => ({ fromDate: r.fromDate, rateBp: r.rateBp }));
  return {
    loan: { id: row.id, name: row.name, direction: row.direction, otherParty: row.other_party, openingDate: row.opening_date },
    from: f,
    to: t,
    fromPeriod: fp,
    toPeriod: tp,
    balanceAtStartCents: start,
    rows,
    totals,
    balanceAtEndCents: months.length ? months[months.length - 1].endBalanceCents : start,
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
  setMonthInterest,
  setPlan,
  previewPlan,
  statement,
  // The pure maths, for a node run (not part of the binding exports).
  _maths: { roundDiv, rateOn, ledger, project, evenPayment, firstCharged, addMonths, fyOf },
};
