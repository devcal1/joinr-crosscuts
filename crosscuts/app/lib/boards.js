// The board stocktake and its value (docs/plans/m11-contracts.md section 8): the board list and
// prices (Ordering), each month's count (the Workshop Manager), confirming the value, and the
// Stock value page for Accounts. Wave 1 B.
//
// Prices and values reach only stock.order holders (withPrices); Accounts reads stockValue() only.
// Every function takes db first and nothing here requires ../db. Every write runs in one
// db.transaction with its audit row.
//
// A month (board_counts) is created on its first write and goes open -> counted -> valued. While
// it is open it lists every active board plus any board it already has a line for; once counted it
// lists only its own lines (boards added later appear in the open month only). A line copies the
// board's text when it's first written; a null qty removes the line. Before it's valued the value
// is worked out live from today's prices (provisional); valuing freezes each line's price and the
// month's value_cents = sum of round(qty x price) + the adjustment. Prices are per sheet, ex GST.
const { bad, notFound, conflict } = require("./httperror");
const { sydneyToday } = require("./time");
const audit = require("./audit");
const notify = require("./notify");
const Periods = require("../public/periods");

const SUPPLIER_MAX = 100;
const NAME_MAX = 200;
const FINISH_MAX = 100;
const THICKNESS_MAX = 1000; // mm
const PRICE_MAX = 100000000; // $1,000,000 a sheet
const QTY_MAX = 9999;
const ADJUSTMENT_MAX = 1000000000; // $10,000,000 either way
const NOTE_MAX = 500;
const REORDER_MAX = 5000;

// ---------------------------------------------------------------- helpers ---

function nowIso() {
  return new Date().toISOString();
}

function userId(req) {
  return req && req.user && req.user.id != null ? req.user.id : null;
}

function person(id, name) {
  return id == null ? null : { id, name: name || null };
}

function textField(label, v, max, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw bad(`${label} is required`);
    return "";
  }
  if (typeof v !== "string") throw bad(`${label} must be text`);
  const t = v.trim();
  if (required && !t) throw bad(`${label} is required`);
  if (t.length > max) throw bad(`${label} must be ${max} characters or fewer`);
  return t;
}

function idField(label, v) {
  if (!Number.isSafeInteger(v) || v < 1) throw bad(`${label} must be a positive whole number`);
  return v;
}

// The YYYY-MM month, no later than the current one (sections 7 and 8).
function periodOk(period, today) {
  if (!Periods.validPeriod(period)) throw bad("The month must be YYYY-MM");
  if (period > Periods.currentPeriod(today)) throw bad("That month hasn't started yet");
  return period;
}

// round(qty x price) in cents; null when either is missing.
function lineCents(qty, price) {
  return qty == null || price == null ? null : Math.round(qty * price);
}

// ---------------------------------------------------------- the board list ---

function toBoard(r, withPrices) {
  const out = {
    id: r.id,
    supplier: r.supplier,
    thickness: r.thickness,
    name: r.name,
    finish: r.finish,
    sort: r.sort,
    active: r.active === 1,
  };
  if (withPrices) out.priceCents = r.price_cents;
  return out;
}

function boardRow(db, id) {
  return db.prepare("SELECT * FROM boards WHERE id = ?").get(id);
}

function list(db, { all = false, withPrices = false } = {}) {
  const sql = all
    ? "SELECT * FROM boards ORDER BY sort, id"
    : "SELECT * FROM boards WHERE active = 1 ORDER BY sort, id";
  return db.prepare(sql).all().map((r) => toBoard(r, withPrices));
}

// The fields of a create (every required one) or a patch (only those sent).
function boardFields(body, { create }) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (create || has("name")) out.name = textField("name", b.name, NAME_MAX, { required: true });
  if (create || has("supplier")) out.supplier = textField("supplier", b.supplier, SUPPLIER_MAX);
  if (create || has("finish")) out.finish = textField("finish", b.finish, FINISH_MAX);
  if (create || has("thickness")) {
    const v = b.thickness === undefined ? null : b.thickness;
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > THICKNESS_MAX)) {
      throw bad(`thickness must be a whole number of mm from 1 to ${THICKNESS_MAX}, or empty`);
    }
    out.thickness = v;
  }
  if (create || has("priceCents")) {
    const v = b.priceCents === undefined ? null : b.priceCents;
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > PRICE_MAX)) {
      throw bad("priceCents must be a whole number of cents from 0, or empty");
    }
    out.price_cents = v;
  }
  if (has("active")) {
    if (typeof b.active !== "boolean") throw bad("active must be true or false");
    out.active = b.active ? 1 : 0;
  } else if (create) out.active = 1;
  return out;
}

function create(db, req, body) {
  const f = boardFields(body, { create: true });
  const id = db.transaction(() => {
    const now = nowIso();
    const max = db.prepare("SELECT MAX(sort) AS m FROM boards").get().m;
    const sort = max == null ? 1 : max + 1;
    const info = db
      .prepare(
        `INSERT INTO boards (supplier, thickness, name, finish, price_cents, sort, active, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.supplier, f.thickness, f.name, f.finish, f.price_cents, sort, f.active, now, now, userId(req));
    const newId = Number(info.lastInsertRowid);
    audit.log(req, { action: "board.create", entityType: "board", entityId: newId, after: { ...f, sort } });
    return newId;
  })();
  return toBoard(boardRow(db, id), true);
}

function update(db, req, id, body) {
  const f = boardFields(body, { create: false });
  db.transaction(() => {
    const row = boardRow(db, id);
    if (!row) throw notFound();
    const before = {};
    const after = {};
    for (const [k, v] of Object.entries(f)) {
      if (row[k] !== v) {
        before[k] = row[k];
        after[k] = v;
      }
    }
    if (!Object.keys(after).length) return;
    const cols = Object.keys(after);
    db.prepare(
      `UPDATE boards SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(...cols.map((c) => after[c]), nowIso(), userId(req), id);
    audit.log(req, { action: "board.update", entityType: "board", entityId: id, before, after });
  })();
  return toBoard(boardRow(db, id), true);
}

// ids: some or all of the boards, in their new order; they take the places they held between
// them (as lib/stock.js reorderItems). Returns the whole list, inactive boards included.
function reorder(db, req, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > REORDER_MAX) throw bad("ids must be a list of board ids");
  const seen = new Set();
  for (const [i, v] of ids.entries()) {
    idField(`ids[${i}]`, v);
    if (seen.has(v)) throw bad(`Board ${v} is listed twice`);
    seen.add(v);
  }
  db.transaction(() => {
    const rows = ids.map((id) => {
      const r = boardRow(db, id);
      if (!r) throw bad(`There is no board ${id}`);
      return r;
    });
    const slots = rows.map((r) => r.sort).sort((a, b) => a - b);
    const before = [...rows].sort((a, b) => a.sort - b.sort || a.id - b.id).map((r) => r.id);
    if (before.every((id, i) => id === ids[i])) return;
    const set = db.prepare("UPDATE boards SET sort = ?, updated_at = ?, updated_by = ? WHERE id = ?");
    const now = nowIso();
    ids.forEach((id, i) => set.run(slots[i], now, userId(req), id));
    audit.log(req, { action: "board.reorder", entityType: "board", before: { ids: before }, after: { ids } });
  })();
  return list(db, { all: true, withPrices: true });
}

// -------------------------------------------------------------- the months ---

const COUNT_SQL = `
  SELECT c.*, uc.display_name AS counted_by_name, uv.display_name AS valued_by_name
    FROM board_counts c
    LEFT JOIN users uc ON uc.id = c.counted_by
    LEFT JOIN users uv ON uv.id = c.valued_by`;

function countRow(db, period) {
  return db.prepare(`${COUNT_SQL} WHERE c.period = ?`).get(period) || null;
}

function ensureCount(db, period) {
  const row = countRow(db, period);
  if (row) return row;
  const now = nowIso();
  db.prepare("INSERT INTO board_counts (period, status, created_at, updated_at) VALUES (?, 'open', ?, ?)").run(period, now, now);
  return countRow(db, period);
}

function touch(db, id) {
  db.prepare("UPDATE board_counts SET updated_at = ? WHERE id = ?").run(nowIso(), id);
}

function countedOf(row) {
  return row && row.counted_at ? { at: row.counted_at, by: person(row.counted_by, row.counted_by_name) } : null;
}

function valuedOf(row) {
  return row && row.valued_at ? { at: row.valued_at, by: person(row.valued_by, row.valued_by_name) } : null;
}

// The month's lines in list order: its own lines (with the board's price today), plus (while
// open) the active boards it has no line for. [{boardId, supplier, thickness, name, finish, qty,
// frozen (the line's price_cents), price (the board's), sort}]
function monthLines(db, row) {
  const own = row
    ? db
        .prepare(
          `SELECT l.*, b.price_cents AS board_price, b.sort
             FROM board_count_lines l JOIN boards b ON b.id = l.board_id
            WHERE l.board_count_id = ?`
        )
        .all(row.id)
    : [];
  const out = own.map((r) => ({
    boardId: r.board_id,
    supplier: r.supplier,
    thickness: r.thickness,
    name: r.name,
    finish: r.finish,
    qty: r.qty,
    frozen: r.price_cents,
    price: r.board_price,
    sort: r.sort,
  }));
  if (!row || row.status === "open") {
    const has = new Set(out.map((l) => l.boardId));
    for (const b of db.prepare("SELECT * FROM boards WHERE active = 1").all()) {
      if (has.has(b.id)) continue;
      out.push({
        boardId: b.id,
        supplier: b.supplier,
        thickness: b.thickness,
        name: b.name,
        finish: b.finish,
        qty: null,
        frozen: null,
        price: b.price_cents,
        sort: b.sort,
      });
    }
  }
  return out.sort((a, b) => a.sort - b.sort || a.boardId - b.boardId);
}

// The money of a month: the frozen figures once valued, else worked out live (provisional).
function figures(row, lines) {
  const valued = !!(row && row.status === "valued");
  let subtotal = 0;
  let unpriced = 0;
  const priced = lines.map((l) => {
    const price = valued ? l.frozen : l.price;
    const cents = lineCents(l.qty, price);
    if (cents != null) subtotal += cents;
    if (l.qty > 0 && price == null) unpriced += 1;
    return { line: l, price, cents };
  });
  const adjustment = row ? row.adjustment_cents : 0;
  return {
    priced,
    subtotalCents: subtotal,
    adjustmentCents: adjustment,
    adjustmentNote: row ? row.adjustment_note : "",
    valueCents: valued ? row.value_cents : subtotal + adjustment,
    provisional: !valued,
    unpriced,
  };
}

// [{period, status, counted, valued, valueCents?}], newest first: the months with a record.
// valueCents (stock.order only) is the frozen value, null until valued.
function counts(db, { withValues = false } = {}) {
  return db
    .prepare(`${COUNT_SQL} ORDER BY c.period DESC`)
    .all()
    .map((row) => {
      const out = { period: row.period, status: row.status, counted: countedOf(row), valued: valuedOf(row) };
      if (withValues) out.valueCents = row.status === "valued" ? row.value_cents : null;
      return out;
    });
}

function view(db, period, row, withPrices) {
  const lines = monthLines(db, row);
  const out = {
    period,
    status: row ? row.status : "open",
    counted: countedOf(row),
    valued: valuedOf(row),
  };
  if (!withPrices) {
    out.lines = lines.map((l) => ({
      boardId: l.boardId,
      supplier: l.supplier,
      thickness: l.thickness,
      name: l.name,
      finish: l.finish,
      qty: l.qty,
    }));
    return out;
  }
  const f = figures(row, lines);
  out.lines = f.priced.map(({ line: l, price, cents }) => ({
    boardId: l.boardId,
    supplier: l.supplier,
    thickness: l.thickness,
    name: l.name,
    finish: l.finish,
    qty: l.qty,
    priceCents: price,
    lineCents: cents,
  }));
  out.subtotalCents = f.subtotalCents;
  out.adjustmentCents = f.adjustmentCents;
  out.adjustmentNote = f.adjustmentNote;
  out.valueCents = f.valueCents;
  out.provisional = f.provisional;
  out.unpriced = f.unpriced;
  return out;
}

function count(db, period, { withPrices = false } = {}, today = sydneyToday()) {
  periodOk(period, today);
  return view(db, period, countRow(db, period), withPrices);
}

// {lines: [{boardId, qty}]}: qty 0-9999 in half sheets; null removes the line. Open only.
function saveLines(db, req, period, lines, today = sydneyToday()) {
  periodOk(period, today);
  if (!Array.isArray(lines)) throw bad("lines must be a list");
  const seen = new Set();
  const list = lines.map((l, i) => {
    if (!l || typeof l !== "object" || Array.isArray(l)) throw bad(`lines[${i}] must be an object`);
    const boardId = idField(`lines[${i}].boardId`, l.boardId);
    if (seen.has(boardId)) throw bad(`Board ${boardId} is listed twice`);
    seen.add(boardId);
    if (!("qty" in l)) throw bad(`lines[${i}].qty is required (a number or null)`);
    const q = l.qty;
    if (q !== null && (typeof q !== "number" || !Number.isFinite(q) || q < 0 || q > QTY_MAX || !Number.isInteger(q * 2))) {
      throw bad(`qty must be from 0 to ${QTY_MAX} in whole or half sheets, or empty`);
    }
    return { boardId, qty: q };
  });
  db.transaction(() => {
    const existing = countRow(db, period);
    if (existing && existing.status !== "open") throw conflict("The count is finished");
    const row = ensureCount(db, period);
    const before = {};
    const after = {};
    const lineOf = db.prepare("SELECT * FROM board_count_lines WHERE board_count_id = ? AND board_id = ?");
    for (const { boardId, qty } of list) {
      const line = lineOf.get(row.id, boardId);
      if (!line) {
        const b = boardRow(db, boardId);
        if (!b) throw bad(`There is no board ${boardId}`);
        if (!b.active) throw bad(`${b.name} is no longer on the board list`);
        if (qty === null) continue;
        db.prepare(
          `INSERT INTO board_count_lines (board_count_id, board_id, supplier, thickness, name, finish, qty)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(row.id, boardId, b.supplier, b.thickness, b.name, b.finish, qty);
      } else if (qty === null) {
        db.prepare("DELETE FROM board_count_lines WHERE board_count_id = ? AND board_id = ?").run(row.id, boardId);
      } else if (line.qty !== qty) {
        db.prepare("UPDATE board_count_lines SET qty = ? WHERE board_count_id = ? AND board_id = ?").run(qty, row.id, boardId);
      } else {
        continue;
      }
      before[boardId] = line ? line.qty : null;
      after[boardId] = qty;
    }
    if (!Object.keys(after).length) return;
    touch(db, row.id);
    audit.log(req, { action: "board_count.lines", entityType: "board_count", entityId: period, before, after });
  })();
  return count(db, period, { withPrices: false }, today);
}

function counted(db, req, period, today = sydneyToday()) {
  periodOk(period, today);
  db.transaction(() => {
    const row = ensureCount(db, period);
    if (row.status !== "open") throw conflict("The count is already finished");
    const now = nowIso();
    db.prepare("UPDATE board_counts SET status = 'counted', counted_at = ?, counted_by = ?, updated_at = ? WHERE id = ?").run(
      now,
      userId(req),
      now,
      row.id
    );
    audit.log(req, { action: "board_count.counted", entityType: "board_count", entityId: period, after: { status: "counted" } });
    notify.toKey(
      db,
      "stock.order",
      {
        kind: "boards.counted",
        title: `Board count done: ${Periods.longLabel(period)}`,
        body: "Confirm the stock value.",
        link: `/boards.html?period=${period}`,
        entityType: "board_count",
        entityId: period,
      },
      { exceptUserId: userId(req) }
    );
  })();
  return count(db, period, { withPrices: false }, today);
}

// counted -> open (Ordering), before it's valued.
function reopenCount(db, req, period) {
  const today = sydneyToday();
  periodOk(period, today);
  db.transaction(() => {
    const row = countRow(db, period);
    if (!row || row.status === "open") throw conflict("The count isn't finished");
    if (row.status === "valued") throw conflict("The value is confirmed; an admin can reopen it");
    db.prepare("UPDATE board_counts SET status = 'open', counted_at = NULL, counted_by = NULL, updated_at = ? WHERE id = ?").run(
      nowIso(),
      row.id
    );
    audit.log(req, {
      action: "board_count.reopen_count",
      entityType: "board_count",
      entityId: period,
      before: { status: "counted", counted_at: row.counted_at, counted_by: row.counted_by },
    });
  })();
  return count(db, period, { withPrices: true }, today);
}

// {adjustmentCents?, adjustmentNote?}: counted -> valued, freezing each line's price and the value.
function value(db, req, period, body) {
  const today = sydneyToday();
  periodOk(period, today);
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const adj = b.adjustmentCents === undefined || b.adjustmentCents === null ? 0 : b.adjustmentCents;
  if (!Number.isInteger(adj) || Math.abs(adj) > ADJUSTMENT_MAX) throw bad("adjustmentCents must be a whole number of cents");
  const note = textField("The adjustment note", b.adjustmentNote, NOTE_MAX);
  if (adj !== 0 && !note) throw bad("Give a note for the adjustment");
  db.transaction(() => {
    const row = countRow(db, period);
    if (!row || row.status === "open") throw conflict("Finish the count first");
    if (row.status === "valued") throw conflict("The value is already confirmed");
    const lines = db
      .prepare(
        `SELECT l.board_id, l.qty, b.price_cents
           FROM board_count_lines l JOIN boards b ON b.id = l.board_id
          WHERE l.board_count_id = ?`
      )
      .all(row.id);
    const unpriced = lines.filter((l) => l.qty > 0 && l.price_cents == null).length;
    if (unpriced) throw conflict(`${unpriced} counted board(s) have no price`);
    let subtotal = 0;
    const set = db.prepare("UPDATE board_count_lines SET price_cents = ? WHERE board_count_id = ? AND board_id = ?");
    for (const l of lines) {
      set.run(l.price_cents, row.id, l.board_id);
      subtotal += lineCents(l.qty, l.price_cents) || 0;
    }
    const total = subtotal + adj;
    const now = nowIso();
    db.prepare(
      `UPDATE board_counts SET status = 'valued', valued_at = ?, valued_by = ?, adjustment_cents = ?,
              adjustment_note = ?, value_cents = ?, updated_at = ? WHERE id = ?`
    ).run(now, userId(req), adj, note, total, now, row.id);
    audit.log(req, {
      action: "board_count.value",
      entityType: "board_count",
      entityId: period,
      after: { subtotal_cents: subtotal, adjustment_cents: adj, adjustment_note: note, value_cents: total },
    });
    notify.toKey(
      db,
      "accounts.view",
      {
        kind: "boards.valued",
        title: `Board stock value: ${Periods.longLabel(period)}`,
        link: "/stockvalue.html",
        entityType: "board_count",
        entityId: period,
      },
      { exceptUserId: userId(req) }
    );
  })();
  return count(db, period, { withPrices: true }, today);
}

// valued -> counted (users.admin, as BAS): the frozen prices and value are cleared; the adjustment
// and its note stay, ready for the next confirm.
function reopen(db, req, period) {
  const today = sydneyToday();
  periodOk(period, today);
  db.transaction(() => {
    const row = countRow(db, period);
    if (!row || row.status !== "valued") throw conflict("The value isn't confirmed");
    db.prepare("UPDATE board_count_lines SET price_cents = NULL WHERE board_count_id = ?").run(row.id);
    db.prepare(
      `UPDATE board_counts SET status = 'counted', valued_at = NULL, valued_by = NULL, value_cents = NULL, updated_at = ?
        WHERE id = ?`
    ).run(nowIso(), row.id);
    audit.log(req, {
      action: "board_count.reopen",
      entityType: "board_count",
      entityId: period,
      before: {
        status: "valued",
        valued_at: row.valued_at,
        valued_by: row.valued_by,
        value_cents: row.value_cents,
        adjustment_cents: row.adjustment_cents,
        adjustment_note: row.adjustment_note,
      },
    });
  })();
  return count(db, period, { withPrices: true }, today);
}

// GET /api/stockvalue: {months}, newest first: every counted or valued month. valueCents only for
// valued months (a counted one is "waiting for the value").
function stockValue(db) {
  const months = db
    .prepare(`${COUNT_SQL} WHERE c.status <> 'open' ORDER BY c.period DESC`)
    .all()
    .map((row) => ({
      period: row.period,
      status: row.status,
      valueCents: row.status === "valued" ? row.value_cents : null,
      counted: countedOf(row),
      valued: valuedOf(row),
      adjustmentCents: row.adjustment_cents,
      adjustmentNote: row.adjustment_note,
    }));
  return { months };
}

module.exports = { list, create, update, reorder, counts, count, saveLines, counted, reopenCount, value, reopen, stockValue };
