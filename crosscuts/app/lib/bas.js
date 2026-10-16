// BAS sales by month: the financial year, a month's detail, the comparison, the month CSV, the
// month's hand-typed figure and lodging (docs/plans/m9-contracts.md sections 5 and 6, and its
// 2026-10-16 note: sales are entered by hand and invoices no longer count).
//
// Every month's sales (GST included) and its GST are typed in by hand. They live in the
// bas_months hand columns (hand_cents, hand_gst_cents, hand_note); a month with no hand_cents is
// "not entered" and shows blank. Every function takes db first and nothing here requires ../db.
// All month and financial-year arithmetic comes from ../public/periods. Every write (bas_months)
// runs in one db.transaction with its audit row.
const audit = require("./audit");
const Periods = require("../public/periods");
const { bad, notFound, conflict } = require("./httperror");
const { sydneyToday } = require("./time");

const AMOUNT_MAX = 1000000000;
const NOTE_MAX = 500;
const CSV_HEADER = ["Month", "Sales inc GST", "GST", "Ex GST", "Note"];

// ---------------------------------------------------------------- helpers ---

function nowIso() {
  return new Date().toISOString();
}

function userId(req) {
  return (req && req.user && req.user.id) || null;
}

// The first financial year anything can be shown for (FY 2023).
function firstFy() {
  return Periods.fyOf(Periods.HISTORY_START);
}

// A month BAS knows about: HISTORY_START up to the current month.
function inRange(period, today) {
  return period >= Periods.HISTORY_START && period <= Periods.currentPeriod(today);
}

function monthOr404(period, today) {
  if (!Periods.validPeriod(period) || !inRange(period, today)) throw notFound();
}

// A month's figures. Not entered: entered false, every amount null and the note ''.
function figuresOf(row) {
  if (!row || row.hand_cents === null || row.hand_cents === undefined) {
    return { entered: false, salesCents: null, gstCents: null, exGstCents: null, note: "" };
  }
  const gst = row.hand_gst_cents === null || row.hand_gst_cents === undefined ? null : row.hand_gst_cents;
  return {
    entered: true,
    salesCents: row.hand_cents,
    gstCents: gst,
    exGstCents: gst === null ? null : row.hand_cents - gst,
    note: row.hand_note || "",
  };
}

// ------------------------------------------------------------ reading ---

function bmRow(db, period) {
  return db.prepare("SELECT * FROM bas_months WHERE period = ?").get(period) || null;
}

function lodgedBy(db, row) {
  if (!row || !row.lodged_at) return null;
  const u = row.lodged_by ? db.prepare("SELECT id, display_name FROM users WHERE id = ?").get(row.lodged_by) : null;
  return { at: row.lodged_at, by: u ? { id: u.id, name: u.display_name } : null };
}

// One month as the year table and the detail show it. A future month, and a month before
// HISTORY_START (FY 2023's Jul 2022 to May 2023), is never read from the database and is not
// entered; only the future one says future: true. `row` is the month's bas_months row or null.
function monthRow(db, period, today, row) {
  const future = period > Periods.currentPeriod(today);
  const live = !future && period >= Periods.HISTORY_START;
  const bm = live ? row : null;
  return {
    period,
    label: Periods.label(period),
    quarter: Periods.quarterOf(period),
    future,
    figures: figuresOf(bm),
    lodged: lodgedBy(db, bm),
  };
}

function detail(db, period, today) {
  return {
    month: monthRow(db, period, today, bmRow(db, period)),
    prev: period <= Periods.HISTORY_START ? null : Periods.addMonths(period, -1),
    next: period >= Periods.currentPeriod(today) ? null : Periods.addMonths(period, 1),
  };
}

// The sums of a quarter or the year: the months that have been entered. With none entered the
// sums are null; the GST sum is null when any entered month has no GST typed.
function sumOf(rows) {
  const entered = rows.filter((r) => r.figures.entered);
  const lodgedCount = rows.filter((r) => r.lodged).length;
  if (!entered.length) {
    return { salesCents: null, gstCents: null, exGstCents: null, enteredCount: 0, lodgedCount };
  }
  const salesCents = entered.reduce((s, r) => s + r.figures.salesCents, 0);
  const gstCents = entered.some((r) => r.figures.gstCents === null)
    ? null
    : entered.reduce((s, r) => s + r.figures.gstCents, 0);
  return {
    salesCents,
    gstCents,
    exGstCents: gstCents === null ? null : salesCents - gstCents,
    enteredCount: entered.length,
    lodgedCount,
  };
}

// ------------------------------------------------------------ the views ---

// The financial year: all twelve months (future ones blank), the quarters and the year total.
function year(db, fy, today = sydneyToday()) {
  const first = firstFy();
  const current = Periods.fyOf(Periods.currentPeriod(today));
  const y = fy === undefined || fy === null ? current : fy;
  if (!Number.isInteger(y) || y < first) throw bad(`Choose a financial year from ${Periods.fyLabel(first)}`);
  if (y > current) throw bad(`${Periods.fyLabel(y)} hasn't started yet`);
  const rows = new Map(db.prepare("SELECT * FROM bas_months").all().map((r) => [r.period, r]));
  const months = Periods.fyMonths(y).map((p) => monthRow(db, p, today, rows.get(p) || null));
  // The sums leave out the months before HISTORY_START and the future ones (they are never entered).
  const quarters = [1, 2, 3, 4].map((q) => ({
    q,
    label: Periods.quarterLabel(y, q),
    ...sumOf(months.filter((m) => m.quarter === q)),
  }));
  return {
    fy: y,
    label: Periods.fyLabel(y),
    rangeLabel: Periods.fyRangeLabel(y),
    firstFy: first,
    currentFy: current,
    months,
    quarters,
    total: sumOf(months),
  };
}

function month(db, period, today = sydneyToday()) {
  monthOr404(period, today);
  return detail(db, period, today);
}

// Sales inc GST for the same month in each financial year; null where a month isn't entered.
function compare(db, today = sydneyToday()) {
  const first = firstFy();
  const current = Periods.fyOf(Periods.currentPeriod(today));
  const fys = [];
  for (let fy = first; fy <= current; fy++) fys.push(fy);
  const sales = new Map(
    db
      .prepare("SELECT period, hand_cents FROM bas_months WHERE hand_cents IS NOT NULL")
      .all()
      .map((r) => [r.period, r.hand_cents])
  );
  const byFy = {};
  for (const fy of fys) byFy[fy] = Periods.fyMonths(fy);
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const values = {};
    for (const fy of fys) {
      const p = byFy[fy][i];
      values[fy] = inRange(p, today) && sales.has(p) ? sales.get(p) : null;
    }
    rows.push({ monthIndex: i, label: Periods.label(byFy[first][i]).slice(0, 3), values });
  }
  return { fys, rows };
}

// ------------------------------------------------------------------ CSV ---

// Money as plain 1234.56 (no $, no commas); negative -12.00.
function csvMoney(cents) {
  if (cents === null || cents === undefined) return "";
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// A text cell: a leading = + - @ tab or CR gets a ' (so a spreadsheet doesn't run it as a formula).
function csvText(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// RFC 4180: quote a cell holding a comma, a quote, CR or LF; double its quotes.
function csvCell(s) {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cells) {
  return cells.map(csvCell).join(",") + "\r\n";
}

// The financial year as a CSV: one line per month up to the current one, with the figures typed
// for it (blank where not entered).
function csv(db, fy, today = sydneyToday()) {
  const y = year(db, fy, today);
  let out = "﻿" + csvLine(CSV_HEADER);
  for (const m of y.months) {
    if (m.future || m.period < Periods.HISTORY_START) continue;
    const f = m.figures;
    out += csvLine([
      m.label,
      csvMoney(f.salesCents),
      csvMoney(f.gstCents),
      csvMoney(f.exGstCents),
      csvText(f.note),
    ]);
  }
  return { fy: y.fy, label: y.label, text: out };
}

// ------------------------------------------------------------- writing ---

function centsField(v, what) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v)) throw bad(`${what} must be a whole number of cents`);
  if (v < -AMOUNT_MAX || v > AMOUNT_MAX) throw bad("That amount is too large");
  return v;
}

// Types, changes or clears a month's sales: body {salesCents, gstCents, note}. salesCents null
// clears the month (and its GST and note). 0 is a real entry (a month with no sales). A negative
// amount is allowed (net refunds). gstCents null means the GST isn't known.
function setSales(db, req, period, body) {
  const today = sydneyToday();
  if (!Periods.validPeriod(period)) throw notFound();
  if (!inRange(period, today)) {
    throw bad(`Sales go from ${Periods.label(Periods.HISTORY_START)} to this month`);
  }
  const lodgedMsg = "This month is lodged; an admin can reopen it";
  const existing = bmRow(db, period);
  if (existing && existing.lodged_at) throw conflict(lodgedMsg);

  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const salesCents = centsField(b.salesCents, "salesCents");
  let gstCents = centsField(b.gstCents, "gstCents");
  if (salesCents === null && gstCents !== null) throw bad("Enter the sales for the GST to go with");
  if (gstCents !== null && gstCents !== 0 && gstCents < 0 !== salesCents < 0) {
    throw bad("GST must have the same sign as the sales");
  }
  if (gstCents !== null && Math.abs(gstCents) > Math.round(Math.abs(salesCents) / 11)) {
    throw bad("GST can't be more than a tenth of the sales before GST");
  }
  let note = "";
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string") throw bad("note must be text");
    note = b.note.trim();
    if (note.length > NOTE_MAX) throw bad(`The note can be at most ${NOTE_MAX} characters`);
  }
  // Clearing the sales clears their GST and note too: the note belongs to the figure.
  if (salesCents === null) {
    gstCents = null;
    note = "";
  }
  const after = { salesCents, gstCents, note };

  db.transaction(() => {
    const row = bmRow(db, period);
    if (row && row.lodged_at) throw conflict(lodgedMsg);
    const f = figuresOf(row);
    const before = { salesCents: f.salesCents, gstCents: f.gstCents, note: f.note };
    if (before.salesCents === after.salesCents && before.gstCents === after.gstCents && before.note === after.note) {
      return; // nothing changed: no stamp, no audit
    }
    if (!row) {
      db.prepare("INSERT INTO bas_months (period, hand_cents, hand_gst_cents, hand_note) VALUES (?, ?, ?, ?)").run(
        period,
        salesCents,
        gstCents,
        note
      );
    } else if (salesCents === null) {
      // Not lodged (checked above) and nothing entered: the month has no row.
      db.prepare("DELETE FROM bas_months WHERE period = ?").run(period);
    } else {
      db.prepare(
        "UPDATE bas_months SET hand_cents = ?, hand_gst_cents = ?, hand_note = ?, updated_at = ? WHERE period = ?"
      ).run(salesCents, gstCents, note, nowIso(), period);
    }
    audit.log(req, { action: "bas.sales", entityType: "bas_month", entityId: period, before, after });
  })();
  return detail(db, period, today);
}

function lodge(db, req, period, today = sydneyToday()) {
  monthOr404(period, today);
  if (!Periods.ended(period, today)) throw conflict("A month can be lodged once it has ended");
  db.transaction(() => {
    const row = bmRow(db, period);
    if (row && row.lodged_at) throw conflict("This month is already lodged");
    const figures = figuresOf(row);
    if (!figures.entered) throw conflict("Enter this month's sales before lodging it");
    const json = JSON.stringify({ figures });
    const now = nowIso();
    db.prepare("UPDATE bas_months SET lodged_at = ?, lodged_by = ?, lodged_json = ?, updated_at = ? WHERE period = ?").run(
      now,
      userId(req),
      json,
      now,
      period
    );
    audit.log(req, { action: "bas.lodge", entityType: "bas_month", entityId: period, after: figures });
  })();
  return detail(db, period, today);
}

function reopen(db, req, period) {
  const today = sydneyToday();
  monthOr404(period, today);
  db.transaction(() => {
    const row = bmRow(db, period);
    if (!row || !row.lodged_at) throw conflict("This month isn't lodged");
    const before = figuresOf(row);
    if (before.entered) {
      db.prepare(
        "UPDATE bas_months SET lodged_at = NULL, lodged_by = NULL, lodged_json = NULL, updated_at = ? WHERE period = ?"
      ).run(nowIso(), period);
    } else {
      // Lodged before sales had to be entered (nothing typed): no figure and no longer lodged, so no row.
      db.prepare("DELETE FROM bas_months WHERE period = ?").run(period);
    }
    audit.log(req, { action: "bas.reopen", entityType: "bas_month", entityId: period, before });
  })();
  return detail(db, period, today);
}

module.exports = { year, month, compare, csv, setSales, lodge, reopen };
