// BAS sales by month: the financial year, a month's detail, the comparison, the CSV, hand amounts
// and lodging (docs/plans/m9-contracts.md section 5).
//
// Cash basis (m9-plan Decision 1): a month's sales are the invoices with status 'paid' and a
// paid_date inside the month, plus the month's hand amount. Every function takes db first and
// nothing here requires ../db. All month and financial-year arithmetic comes from
// ../public/periods. BAS only reads invoices and jobs; every write (bas_months) runs in one
// db.transaction with its audit row.
const audit = require("./audit");
const Periods = require("../public/periods");
const { bad, notFound, conflict } = require("./httperror");
const { sydneyToday } = require("./time");

const HAND_MAX = 1000000000;
const NOTE_MAX = 500;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const KIND_WORDS = { deposit: "Deposit", progress: "Progress", final: "Final", extra: "Extra" };
const CSV_HEADER = ["Invoice", "Client", "Job", "Kind", "Issued", "Paid", "Total inc GST", "GST", "Ex GST", "Entered in MYOB"];

// ---------------------------------------------------------------- helpers ---

function nowIso() {
  return new Date().toISOString();
}

function userId(req) {
  return (req && req.user && req.user.id) || null;
}

// '2026-09-03' -> '3 Sep 2026'.
function dayLabel(s) {
  if (!s) return "";
  const [y, m, d] = String(s).split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
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

function emptyFigures() {
  return {
    invoiceCount: 0,
    invoiceCents: 0,
    invoiceGstCents: 0,
    handCents: null,
    handGstCents: null,
    handNote: "",
    salesCents: 0,
    gstCents: 0,
    exGstCents: 0,
    notInMyobCount: 0,
    kind: "empty",
  };
}

// ------------------------------------------------------------ reading ---

function bmRow(db, period) {
  return db.prepare("SELECT * FROM bas_months WHERE period = ?").get(period) || null;
}

// The month's paid invoices as invoice rows (section 6.2), by paid date then number.
function liveInvoices(db, period) {
  return db
    .prepare(
      `SELECT i.id, i.number, i.kind, i.bill_to_name, i.issue_date, i.paid_date, i.total_cents, i.gst_cents,
              i.myob_entered_date, i.job_id, j.name AS job_name, j.client_name
         FROM invoices i
         LEFT JOIN jobs j ON j.id = i.job_id
        WHERE i.status = 'paid' AND i.paid_date >= ? AND i.paid_date <= ?
        ORDER BY i.paid_date, i.number, i.id`
    )
    .all(Periods.firstDay(period), Periods.lastDay(period))
    .map((r) => {
      const total = r.total_cents || 0;
      const gst = r.gst_cents || 0;
      return {
        id: r.id,
        number: r.number,
        kind: r.kind,
        client: r.bill_to_name || r.client_name || "",
        job: { id: r.job_id, name: r.job_name || "" },
        issueDate: r.issue_date,
        paidDate: r.paid_date,
        totalCents: total,
        gstCents: gst,
        exGstCents: total - gst,
        myobEnteredDate: r.myob_entered_date || null,
      };
    });
}

function handOf(row) {
  return {
    handCents: row && row.hand_cents !== null && row.hand_cents !== undefined ? row.hand_cents : null,
    handGstCents: row && row.hand_gst_cents !== null && row.hand_gst_cents !== undefined ? row.hand_gst_cents : null,
    handNote: (row && row.hand_note) || "",
  };
}

// A month's figures from its invoice rows and its hand fields (section 5).
function figuresOf(invoices, hand) {
  const invoiceCents = invoices.reduce((s, i) => s + i.totalCents, 0);
  const invoiceGstCents = invoices.reduce((s, i) => s + i.gstCents, 0);
  const hasHand = hand.handCents !== null;
  const salesCents = invoiceCents + (hasHand ? hand.handCents : 0);
  const gstCents = hasHand && hand.handGstCents === null ? null : invoiceGstCents + (hand.handGstCents || 0);
  let kind = "empty";
  if (invoices.length && hasHand) kind = "mixed";
  else if (invoices.length) kind = "invoices";
  else if (hasHand) kind = "imported";
  return {
    invoiceCount: invoices.length,
    invoiceCents,
    invoiceGstCents,
    handCents: hand.handCents,
    handGstCents: hand.handGstCents,
    handNote: hand.handNote,
    salesCents,
    gstCents,
    exGstCents: gstCents === null ? null : salesCents - gstCents,
    notInMyobCount: invoices.filter((i) => !i.myobEnteredDate).length,
    kind,
  };
}

function frozenOf(row) {
  if (!row || !row.lodged_json) return null;
  try {
    const f = JSON.parse(row.lodged_json);
    return { figures: f.figures || emptyFigures(), invoices: Array.isArray(f.invoices) ? f.invoices : [] };
  } catch (_) {
    return { figures: emptyFigures(), invoices: [] };
  }
}

function lodgedBy(db, row) {
  if (!row || !row.lodged_at) return null;
  const u = row.lodged_by ? db.prepare("SELECT id, display_name FROM users WHERE id = ?").get(row.lodged_by) : null;
  return { at: row.lodged_at, by: u ? { id: u.id, name: u.display_name } : null };
}

function money(cents) {
  return cents === null || cents === undefined ? "not known" : Periods.dollars(cents);
}

// What changed in a lodged month since it was lodged, as sentences (section 5). Compared: each
// invoice's id, paidDate, totalCents and gstCents, and the three hand fields.
function changesOf(db, frozen, live) {
  const out = [];
  const liveById = new Map(live.invoices.map((i) => [i.id, i]));
  const frozenById = new Map(frozen.invoices.map((i) => [i.id, i]));
  const name = (i) => i.number || `Invoice ${i.id}`;
  for (const f of frozen.invoices) {
    const l = liveById.get(f.id);
    if (!l) {
      // Gone from this month: unmarked paid, or its paid date moved to another month.
      const now = db.prepare("SELECT status, paid_date FROM invoices WHERE id = ?").get(f.id);
      if (now && now.status === "paid" && now.paid_date && now.paid_date !== f.paidDate) {
        out.push(`${name(f)}'s paid date moved from ${dayLabel(f.paidDate)} to ${dayLabel(now.paid_date)}`);
      } else {
        out.push(`${name(f)} is no longer paid in this month`);
      }
      continue;
    }
    if (l.paidDate !== f.paidDate) {
      out.push(`${name(f)}'s paid date moved from ${dayLabel(f.paidDate)} to ${dayLabel(l.paidDate)}`);
    }
    if (l.totalCents !== f.totalCents) {
      out.push(`${name(f)}'s total changed from ${money(f.totalCents)} to ${money(l.totalCents)}`);
    }
    if (l.gstCents !== f.gstCents) {
      out.push(`${name(f)}'s GST changed from ${money(f.gstCents)} to ${money(l.gstCents)}`);
    }
  }
  for (const l of live.invoices) {
    if (!frozenById.has(l.id)) out.push(`${name(l)} was marked paid in this month after lodging`);
  }
  const fh = frozen.figures;
  const lh = live.figures;
  const fCents = fh.handCents === undefined ? null : fh.handCents;
  const fGst = fh.handGstCents === undefined ? null : fh.handGstCents;
  if (fCents !== lh.handCents) {
    if (fCents === null) out.push(`A hand amount of ${money(lh.handCents)} was added`);
    else if (lh.handCents === null) out.push(`The hand amount of ${money(fCents)} was removed`);
    else out.push(`The hand amount changed from ${money(fCents)} to ${money(lh.handCents)}`);
  } else if (fGst !== lh.handGstCents) {
    out.push(`The hand amount's GST changed from ${money(fGst)} to ${money(lh.handGstCents)}`);
  }
  if ((fh.handNote || "") !== lh.handNote) out.push("The hand amount's note changed");
  return out;
}

// Everything about one month: {row (month row), live {figures, invoices}, frozen, changes}.
function load(db, period, today) {
  const future = period > Periods.currentPeriod(today);
  if (future) {
    return {
      row: {
        period,
        label: Periods.label(period),
        quarter: Periods.quarterOf(period),
        future: true,
        figures: emptyFigures(),
        live: emptyFigures(),
        lodged: null,
        changed: false,
      },
      live: { figures: emptyFigures(), invoices: [] },
      frozen: null,
      changes: [],
    };
  }
  const bm = bmRow(db, period);
  const invoices = liveInvoices(db, period);
  const live = { figures: figuresOf(invoices, handOf(bm)), invoices };
  const frozen = frozenOf(bm);
  const changes = frozen ? changesOf(db, frozen, live) : [];
  return {
    row: {
      period,
      label: Periods.label(period),
      quarter: Periods.quarterOf(period),
      future: false,
      figures: frozen ? frozen.figures : live.figures,
      live: live.figures,
      lodged: frozen ? lodgedBy(db, bm) : null,
      changed: changes.length > 0,
    },
    live,
    frozen,
    changes,
  };
}

function detail(db, period, today) {
  const m = load(db, period, today);
  return {
    month: m.row,
    invoices: m.live.invoices,
    lodgedInvoices: m.frozen ? m.frozen.invoices : null,
    changes: m.changes,
    prev: period <= Periods.HISTORY_START ? null : Periods.addMonths(period, -1),
    next: period >= Periods.currentPeriod(today) ? null : Periods.addMonths(period, 1),
  };
}

// The sums of a quarter or the year: each month's figures (frozen when lodged).
function sumOf(rows) {
  const anyNullGst = rows.some((r) => r.figures.gstCents === null);
  const salesCents = rows.reduce((s, r) => s + r.figures.salesCents, 0);
  const gstCents = anyNullGst ? null : rows.reduce((s, r) => s + r.figures.gstCents, 0);
  return {
    salesCents,
    gstCents,
    exGstCents: gstCents === null ? null : salesCents - gstCents,
    invoiceCount: rows.reduce((s, r) => s + r.figures.invoiceCount, 0),
    lodgedCount: rows.filter((r) => r.lodged).length,
  };
}

// ------------------------------------------------------------ the views ---

function year(db, fy, today = sydneyToday()) {
  const first = firstFy();
  const current = Periods.fyOf(Periods.currentPeriod(today));
  const y = fy === undefined || fy === null ? current : fy;
  if (!Number.isInteger(y) || y < first) throw bad(`Choose a financial year from ${Periods.fyLabel(first)}`);
  if (y > current) throw bad(`${Periods.fyLabel(y)} hasn't started yet`);
  const months = Periods.fyMonths(y).map((p) => load(db, p, today).row);
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

function compare(db, today = sydneyToday()) {
  const first = firstFy();
  const current = Periods.fyOf(Periods.currentPeriod(today));
  const fys = [];
  for (let fy = first; fy <= current; fy++) fys.push(fy);
  const byFy = {};
  for (const fy of fys) byFy[fy] = Periods.fyMonths(fy);
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const values = {};
    for (const fy of fys) {
      const p = byFy[fy][i];
      values[fy] = inRange(p, today) ? load(db, p, today).row.figures.salesCents : null;
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

function csv(db, period) {
  const today = sydneyToday();
  monthOr404(period, today);
  const bm = bmRow(db, period);
  const invoices = liveInvoices(db, period);
  let out = "﻿" + csvLine(CSV_HEADER);
  for (const i of invoices) {
    out += csvLine([
      csvText(i.number),
      csvText(i.client),
      csvText(i.job.name),
      csvText(KIND_WORDS[i.kind] || i.kind),
      i.issueDate || "",
      i.paidDate || "",
      csvMoney(i.totalCents),
      csvMoney(i.gstCents),
      csvMoney(i.exGstCents),
      i.myobEnteredDate || "",
    ]);
  }
  const hand = handOf(bm);
  if (hand.handCents !== null) {
    const ex = hand.handGstCents === null ? null : hand.handCents - hand.handGstCents;
    out += csvLine([
      "",
      csvText(hand.handNote),
      "",
      "Hand amount",
      "",
      "",
      csvMoney(hand.handCents),
      csvMoney(hand.handGstCents),
      csvMoney(ex),
      "",
    ]);
  }
  return out;
}

// ------------------------------------------------------------- writing ---

function centsField(v, what) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v)) throw bad(`${what} must be a whole number of cents`);
  if (v < -HAND_MAX || v > HAND_MAX) throw bad("That amount is too large");
  return v;
}

function setHand(db, req, period, body) {
  const today = sydneyToday();
  if (!Periods.validPeriod(period)) throw notFound();
  if (!inRange(period, today)) {
    throw bad(`Hand amounts go from ${Periods.label(Periods.HISTORY_START)} to this month`);
  }
  const lodgedMsg = "This month is lodged; an admin can reopen it";
  const existing = bmRow(db, period);
  if (existing && existing.lodged_at) throw conflict(lodgedMsg);

  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const handCents = centsField(b.handCents, "handCents");
  if (handCents === 0) throw bad("Enter an amount, or clear it");
  let handGstCents = centsField(b.handGstCents, "handGstCents");
  if (handCents === null && handGstCents !== null) throw bad("Enter an amount for the GST to go with");
  if (handGstCents !== null && Math.abs(handGstCents) > Math.round(Math.abs(handCents) / 11)) {
    throw bad("GST can't be more than a tenth of the amount before GST");
  }
  let handNote = "";
  if (b.handNote !== undefined && b.handNote !== null) {
    if (typeof b.handNote !== "string") throw bad("handNote must be text");
    handNote = b.handNote.trim();
    if (handNote.length > NOTE_MAX) throw bad(`The note can be at most ${NOTE_MAX} characters`);
  }
  // Clearing the amount clears its GST and note too: the note belongs to the hand amount.
  if (handCents === null) {
    handGstCents = null;
    handNote = "";
  }
  const after = { handCents, handGstCents, handNote };

  db.transaction(() => {
    const row = bmRow(db, period);
    if (row && row.lodged_at) throw conflict(lodgedMsg);
    const before = handOf(row);
    if (
      before.handCents === after.handCents &&
      before.handGstCents === after.handGstCents &&
      before.handNote === after.handNote
    ) {
      return; // nothing changed: no stamp, no audit
    }
    if (!row) {
      db.prepare("INSERT INTO bas_months (period, hand_cents, hand_gst_cents, hand_note) VALUES (?, ?, ?, ?)").run(
        period,
        handCents,
        handGstCents,
        handNote
      );
    } else if (handCents === null) {
      // Not lodged (checked above) and no hand amount: the month has no row.
      db.prepare("DELETE FROM bas_months WHERE period = ?").run(period);
    } else {
      db.prepare(
        "UPDATE bas_months SET hand_cents = ?, hand_gst_cents = ?, hand_note = ?, updated_at = ? WHERE period = ?"
      ).run(handCents, handGstCents, handNote, nowIso(), period);
    }
    audit.log(req, { action: "bas.hand", entityType: "bas_month", entityId: period, before, after });
  })();
  return detail(db, period, today);
}

function lodge(db, req, period, today = sydneyToday()) {
  monthOr404(period, today);
  if (!Periods.ended(period, today)) throw conflict("A month can be lodged once it has ended");
  db.transaction(() => {
    const row = bmRow(db, period);
    if (row && row.lodged_at) throw conflict("This month is already lodged");
    const invoices = liveInvoices(db, period);
    const figures = figuresOf(invoices, handOf(row));
    const json = JSON.stringify({ figures, invoices });
    const now = nowIso();
    if (row) {
      db.prepare("UPDATE bas_months SET lodged_at = ?, lodged_by = ?, lodged_json = ?, updated_at = ? WHERE period = ?").run(
        now,
        userId(req),
        json,
        now,
        period
      );
    } else {
      db.prepare(
        "INSERT INTO bas_months (period, lodged_at, lodged_by, lodged_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(period, now, userId(req), json, now, now);
    }
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
    const frozen = frozenOf(row);
    if (row.hand_cents === null || row.hand_cents === undefined) {
      // No hand amount and no longer lodged: the month has no row.
      db.prepare("DELETE FROM bas_months WHERE period = ?").run(period);
    } else {
      db.prepare(
        "UPDATE bas_months SET lodged_at = NULL, lodged_by = NULL, lodged_json = NULL, updated_at = ? WHERE period = ?"
      ).run(nowIso(), period);
    }
    audit.log(req, {
      action: "bas.reopen",
      entityType: "bas_month",
      entityId: period,
      before: frozen ? frozen.figures : null,
    });
  })();
  return detail(db, period, today);
}

module.exports = { year, month, compare, csv, setHand, lodge, reopen };
