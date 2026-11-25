// The monthly stock order (docs/plans/m11-contracts.md section 7): the stock list, each month's
// Have (the Workshop Manager) and Order (Ordering), the supplier groups' ordered and received dates,
// and the dashboard summary (section 11.8). Wave 1 B.
//
// Every function takes db first and nothing here requires ../db. Month arithmetic comes from
// ../public/periods. Every write runs in one db.transaction with its audit row.
//
// A month's record (stock_orders) is created on its first write. While it is counting, the month
// lists every active item plus any item it already has a line for. Finishing the count writes an
// empty line for every active item that has none, so from then on the month lists exactly its own
// lines (items added to the list later appear in the open month only); reopening the count drops
// the lines that are still empty. Each line copies its item's supplier, code and item text when it
// is first written, and its supplier group is that copied supplier (exact text).
const { bad, notFound, conflict } = require("./httperror");
const { sydneyToday, DATE_RE, parseDateUTC, formatDateUTC } = require("./time");
const audit = require("./audit");
const notify = require("./notify");
const { cutNote } = require("./orders");
const stocklines = require("./stocklines");
const Periods = require("../public/periods");
const settings = require("./settings");

const SUPPLIER_MAX = 200;
const ITEM_MAX = 200;
const CODE_MAX = 100;
const LINK_MAX = 500;
const QTY_MAX = 99999;
const DELIVERY_NOTE_MAX = 500; // as an order line's (m10-contracts.md section 4.2)
const REORDER_MAX = 5000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COUNT_DONE = "The count is finished; ask Ordering to reopen it";
// 0.2.27: stock is ordered on the Orders page now (docs/plans/stock-orders-plan.md); the old Order tab's
// writes are closed. Fortnights already ordered there are received and undone as before.
const ORDERED_ELSEWHERE = "Stock is ordered on the Orders page now";

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

// "2026-10-03" -> "3 Oct 2026".
function dayLabel(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function validDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && formatDateUTC(parseDateUTC(s)) === s;
}

// null / "" / absent -> null; a valid date -> itself; anything else -> 400.
function dateOrNull(label, v) {
  if (v === undefined || v === null || v === "") return null;
  if (!validDate(v)) throw bad(`${label} must be a valid YYYY-MM-DD date`);
  return v;
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

// An http(s) address or "".
function linkField(v) {
  const t = textField("link", v, LINK_MAX);
  if (!t) return "";
  let u;
  try {
    u = new URL(t);
  } catch (_) {
    throw bad("The link must be an http or https address");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw bad("The link must be an http or https address");
  return t;
}

function boolField(label, v) {
  if (typeof v !== "boolean") throw bad(`${label} must be true or false`);
  return v;
}

function idField(label, v) {
  if (!Number.isSafeInteger(v) || v < 1) throw bad(`${label} must be a positive whole number`);
  return v;
}

// A whole number 0..QTY_MAX, or null.
function qtyOrNull(label, v) {
  if (v === null) return null;
  if (!Number.isInteger(v) || v < 0 || v > QTY_MAX) throw bad(`${label} must be a whole number from 0 to ${QTY_MAX}, or empty`);
  return v;
}

// A month (YYYY-MM) or a fortnight (YYYY-MM-DD, its Monday) that has started (section 7;
// m27-contracts.md section 2).
function periodOk(period, today) {
  if (!Periods.validStockPeriod(period)) throw bad("The period must be a month (YYYY-MM) or a fortnight's Monday (YYYY-MM-DD)");
  if (!Periods.stockPeriodStarted(period, today)) throw bad("That period hasn't started yet");
  return period;
}

// ------------------------------------------------------------- the cycle ---

const CYCLES = ["monthly", "fortnightly"];

// {cycle, cycleStart}: the settings, falling back to the defaults when a stored value is unusable.
function cycleOf(db) {
  const c = settings.get(db, "stock.cycle");
  const st = settings.get(db, "stock.cycle_start");
  return {
    cycle: CYCLES.includes(c) ? c : settings.DEFAULTS["stock.cycle"],
    cycleStart: Periods.isMonday(st) ? st : settings.DEFAULTS["stock.cycle_start"],
  };
}

// GET /api/stock/settings.
function cycleSettings(db, today = sydneyToday()) {
  const c = cycleOf(db);
  const current = Periods.currentStockPeriod(today, c.cycle, c.cycleStart);
  return { ...c, current, currentLabel: Periods.stockLabel(current), today };
}

// PUT /api/stock/settings {cycle?, cycleStart?} (stock.order).
function saveCycle(db, req, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (b.cycle !== undefined && !CYCLES.includes(b.cycle)) throw bad("cycle must be monthly or fortnightly");
  if (b.cycleStart !== undefined && !Periods.isMonday(b.cycleStart)) throw bad("cycleStart must be a Monday (YYYY-MM-DD)");
  db.transaction(() => {
    if (b.cycle !== undefined) settings.set(db, "stock.cycle", b.cycle, req);
    if (b.cycleStart !== undefined) settings.set(db, "stock.cycle_start", b.cycleStart, req);
  })();
  return cycleSettings(db);
}

// The order a target suggests: max(target - have, 0), or null without both.
function suggestOf(target, have) {
  if (target == null || have == null) return null;
  return Math.max(target - have, 0);
}

// [{itemId, <field>}] -> [{itemId, value}] (400 on any bad entry or a repeated item).
function lineList(lines, field, label) {
  if (!Array.isArray(lines)) throw bad("lines must be a list");
  const seen = new Set();
  return lines.map((l, i) => {
    if (!l || typeof l !== "object" || Array.isArray(l)) throw bad(`lines[${i}] must be an object`);
    const itemId = idField(`lines[${i}].itemId`, l.itemId);
    if (seen.has(itemId)) throw bad(`Item ${itemId} is listed twice`);
    seen.add(itemId);
    if (!(field in l)) throw bad(`lines[${i}].${field} is required (a number or null)`);
    return { itemId, value: qtyOrNull(label, l[field]) };
  });
}

// ------------------------------------------------------------- the list ---

function toItem(r) {
  return {
    id: r.id,
    supplier: r.supplier,
    code: r.code,
    item: r.item,
    link: r.link,
    sort: r.sort,
    active: r.active === 1,
    target: r.target == null ? null : r.target,
  };
}

function itemRow(db, id) {
  return db.prepare("SELECT * FROM stock_items WHERE id = ?").get(id);
}

function items(db, { all = false } = {}) {
  const sql = all
    ? "SELECT * FROM stock_items ORDER BY sort, id"
    : "SELECT * FROM stock_items WHERE active = 1 ORDER BY sort, id";
  return db.prepare(sql).all().map(toItem);
}

// The fields of a create (every required one) or a patch (only those sent).
function itemFields(body, { create }) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (create || has("supplier")) out.supplier = textField("supplier", b.supplier, SUPPLIER_MAX, { required: true });
  if (create || has("item")) out.item = textField("item", b.item, ITEM_MAX, { required: true });
  if (create || has("code")) out.code = textField("code", b.code, CODE_MAX);
  if (create || has("link")) out.link = linkField(b.link);
  if (create || has("target")) out.target = qtyOrNull("target", b.target === undefined ? null : b.target);
  if (has("active")) out.active = boolField("active", b.active) ? 1 : 0;
  else if (create) out.active = 1;
  return out;
}

function createItem(db, req, body) {
  const f = itemFields(body, { create: true });
  const id = db.transaction(() => {
    const now = nowIso();
    const max = db.prepare("SELECT MAX(sort) AS m FROM stock_items").get().m;
    const sort = max == null ? 1 : max + 1;
    const info = db
      .prepare(
        `INSERT INTO stock_items (supplier, code, item, link, target, sort, active, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.supplier, f.code, f.item, f.link, f.target, sort, f.active, now, now, userId(req));
    const newId = Number(info.lastInsertRowid);
    audit.log(req, { action: "stock_item.create", entityType: "stock_item", entityId: newId, after: { ...f, sort } });
    return newId;
  })();
  return toItem(itemRow(db, id));
}

function updateItem(db, req, id, body) {
  const f = itemFields(body, { create: false });
  db.transaction(() => {
    const row = itemRow(db, id);
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
      `UPDATE stock_items SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(...cols.map((c) => after[c]), nowIso(), userId(req), id);
    audit.log(req, { action: "stock_item.update", entityType: "stock_item", entityId: id, before, after });
  })();
  return toItem(itemRow(db, id));
}

// ids: some or all of the items, in their new order. They take the places in the list they held
// between them, so moving one item up within its group is the two ids swapped, and the whole list
// is every id in order. Returns the whole list, inactive items included.
function reorderItems(db, req, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > REORDER_MAX) throw bad("ids must be a list of item ids");
  const seen = new Set();
  for (const [i, v] of ids.entries()) {
    idField(`ids[${i}]`, v);
    if (seen.has(v)) throw bad(`Item ${v} is listed twice`);
    seen.add(v);
  }
  db.transaction(() => {
    const rows = ids.map((id) => {
      const r = itemRow(db, id);
      if (!r) throw bad(`There is no item ${id}`);
      return r;
    });
    const slots = rows.map((r) => r.sort).sort((a, b) => a - b);
    const before = [...rows].sort((a, b) => a.sort - b.sort || a.id - b.id).map((r) => r.id);
    if (before.every((id, i) => id === ids[i])) return;
    const set = db.prepare("UPDATE stock_items SET sort = ?, updated_at = ?, updated_by = ? WHERE id = ?");
    const now = nowIso();
    ids.forEach((id, i) => set.run(slots[i], now, userId(req), id));
    audit.log(req, { action: "stock_item.reorder", entityType: "stock_item", before: { ids: before }, after: { ids } });
  })();
  return items(db, { all: true });
}

// ------------------------------------------------------------ the months ---

function orderRow(db, period) {
  return db.prepare("SELECT * FROM stock_orders WHERE period = ?").get(period) || null;
}

// The month's record, created on its first write.
function ensureOrder(db, period) {
  const row = orderRow(db, period);
  if (row) return row;
  const now = nowIso();
  db.prepare("INSERT INTO stock_orders (period, created_at, updated_at) VALUES (?, ?, ?)").run(period, now, now);
  return orderRow(db, period);
}

function touch(db, orderId) {
  db.prepare("UPDATE stock_orders SET updated_at = ? WHERE id = ?").run(nowIso(), orderId);
}

function lineRow(db, orderId, itemId) {
  return db.prepare("SELECT * FROM stock_order_lines WHERE stock_order_id = ? AND stock_item_id = ?").get(orderId, itemId);
}

function groupRow(db, orderId, supplier) {
  return db.prepare("SELECT * FROM stock_order_groups WHERE stock_order_id = ? AND supplier = ?").get(orderId, supplier);
}

// The month's lines in list order: its own lines, plus (while counting) the active items it has no
// line for. [{itemId, supplier, code, item, link, have, order, sort}]
function monthLines(db, row) {
  const own = row
    ? db
        .prepare(
          `SELECT l.stock_item_id AS item_id, l.supplier, l.code, l.item, l.have, l.order_qty,
                  i.link, i.sort, i.target
             FROM stock_order_lines l JOIN stock_items i ON i.id = l.stock_item_id
            WHERE l.stock_order_id = ?`
        )
        .all(row.id)
    : [];
  const out = own.map((r) => ({
    itemId: r.item_id,
    supplier: r.supplier,
    code: r.code,
    item: r.item,
    link: r.link,
    have: r.have,
    order: r.order_qty,
    sort: r.sort,
    target: r.target,
  }));
  if (!row || !row.counted_at) {
    const has = new Set(out.map((l) => l.itemId));
    for (const i of db.prepare("SELECT * FROM stock_items WHERE active = 1").all()) {
      if (has.has(i.id)) continue;
      out.push({ itemId: i.id, supplier: i.supplier, code: i.code, item: i.item, link: i.link, have: null, order: null, sort: i.sort, target: i.target });
    }
  }
  return out.sort((a, b) => a.sort - b.sort || a.itemId - b.itemId);
}

function groupRows(db, row) {
  if (!row) return [];
  return db
    .prepare(
      `SELECT g.*, uo.display_name AS ordered_by_name, ur.display_name AS received_by_name
         FROM stock_order_groups g
         LEFT JOIN users uo ON uo.id = g.ordered_by
         LEFT JOIN users ur ON ur.id = g.received_by
        WHERE g.stock_order_id = ?`
    )
    .all(row.id);
}

// Section 7.1's order: counting; counted until Ordering acts (any group ordered, or the month marked
// "nothing to order", section 15.19); nothing once marked; ordering while a group with something to
// order isn't ordered; received when every ordered group is received; else ordered. Once a group is
// ordered, groups with no order quantities count as done.
function stateOf(row, lines, groups) {
  if (!row || !row.counted_at) return "counting";
  if (row.nothing_at) return "nothing";
  if (!groups.length) return "counted";
  const ordered = new Set(groups.map((g) => g.supplier));
  if (lines.some((l) => l.order > 0 && !ordered.has(l.supplier))) return "ordering";
  return groups.every((g) => g.received_date) ? "received" : "ordered";
}

function countedOf(db, row) {
  if (!row || !row.counted_at) return null;
  const u = db.prepare("SELECT display_name FROM users WHERE id = ?").get(row.counted_by);
  return { at: row.counted_at, by: person(row.counted_by, u && u.display_name) };
}

function nothingOf(db, row) {
  if (!row || !row.nothing_at) return null;
  const u = db.prepare("SELECT display_name FROM users WHERE id = ?").get(row.nothing_by);
  return { at: row.nothing_at, by: person(row.nothing_by, u && u.display_name) };
}

function view(db, period, row) {
  const lines = monthLines(db, row);
  const groupsBy = new Map(groupRows(db, row).map((g) => [g.supplier, g]));
  const groups = [];
  const index = new Map();
  for (const l of lines) {
    if (!index.has(l.supplier)) {
      const g = groupsBy.get(l.supplier) || null;
      const out = {
        supplier: l.supplier,
        ordered: g ? { date: g.ordered_date, by: person(g.ordered_by, g.ordered_by_name) } : null,
        expectedDate: g ? g.expected_date || null : null,
        received: g && g.received_date ? { date: g.received_date, by: person(g.received_by, g.received_by_name) } : null,
        deliveryNote: g ? g.delivery_note : "",
        lines: [],
      };
      index.set(l.supplier, out);
      groups.push(out);
    }
    index.get(l.supplier).lines.push({
      itemId: l.itemId, code: l.code, item: l.item, link: l.link, have: l.have, order: l.order,
      target: l.target == null ? null : l.target, suggested: suggestOf(l.target, l.have),
    });
  }
  return {
    period,
    label: Periods.stockLabel(period),
    kind: Periods.isFortnight(period) ? "fortnight" : "month",
    state: stateOf(row, lines, [...groupsBy.values()]),
    counted: countedOf(db, row),
    // 0.2.27: when the count was sent to the monthly order (rule A) and the month its lines went to.
    sent: row && row.sent_at ? { at: row.sent_at, period: row.sent_period } : null,
    nothingToOrder: nothingOf(db, row),
    groups,
  };
}

// [{period, state, counted}], newest first: the months that have a record.
function months(db) {
  return db
    .prepare("SELECT * FROM stock_orders ORDER BY period DESC")
    .all()
    .map((row) => {
      const v = view(db, row.period, row);
      return { period: v.period, label: v.label, state: v.state, counted: v.counted };
    });
}

// The month view of section 7.1; a month with no record yet is its empty view (nothing written).
function month(db, period, today = sydneyToday()) {
  periodOk(period, today);
  return view(db, period, orderRow(db, period));
}

// The line's item for a write: the month's own line, or an active item while counting.
function lineTarget(db, row, itemId) {
  const line = row ? lineRow(db, row.id, itemId) : null;
  if (line) return { line, supplier: line.supplier };
  const item = itemRow(db, itemId);
  if (!item) throw bad(`There is no item ${itemId}`);
  if (row && row.counted_at) throw bad(`${item.item} isn't on this month's order`);
  if (!item.active) throw bad(`${item.item} is no longer on the stock list`);
  return { item, supplier: item.supplier };
}

// Writes one column (have or order_qty) of the month's lines; returns {before, after} by item id
// for the lines that changed. While counting, a line left with neither number is removed.
function writeColumn(db, row, list, col, guard) {
  const before = {};
  const after = {};
  const ins = db.prepare(
    `INSERT INTO stock_order_lines (stock_order_id, stock_item_id, supplier, code, item, have, order_qty)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const { itemId, value } of list) {
    const t = lineTarget(db, row, itemId);
    const old = t.line ? t.line[col] : null;
    if (old === value) continue;
    if (guard) guard(t.supplier);
    before[itemId] = old;
    after[itemId] = value;
    if (!t.line) {
      const i = t.item;
      ins.run(row.id, itemId, i.supplier, i.code, i.item, col === "have" ? value : null, col === "order_qty" ? value : null);
      continue;
    }
    const other = col === "have" ? t.line.order_qty : t.line.have;
    if (!row.counted_at && value === null && other === null) {
      db.prepare("DELETE FROM stock_order_lines WHERE stock_order_id = ? AND stock_item_id = ?").run(row.id, itemId);
    } else {
      db.prepare(`UPDATE stock_order_lines SET ${col} = ? WHERE stock_order_id = ? AND stock_item_id = ?`).run(value, row.id, itemId);
    }
  }
  return { before, after };
}

function saveHave(db, req, period, lines, today = sydneyToday()) {
  periodOk(period, today);
  const list = lineList(lines, "have", "Have");
  db.transaction(() => {
    const existing = orderRow(db, period);
    if (existing && existing.counted_at) throw conflict(COUNT_DONE);
    const row = ensureOrder(db, period);
    const { before, after } = writeColumn(db, row, list, "have");
    if (!Object.keys(after).length) return;
    touch(db, row.id);
    audit.log(req, { action: "stock_order.have", entityType: "stock_order", entityId: period, before, after });
    fillOrders(db, req, row, before);
  })();
  return month(db, period, today);
}

// Order fills in as max(target - have, 0) (m27-contracts.md section 3), on lines with a target and
// a Have whose Order is empty or still what the old Have suggested (so an Order someone typed is
// kept) and whose supplier group isn't ordered. haveBefore: {itemId: old have} for the lines just
// changed; null: every line (at Finish count). Audited stock_order.order_fill.
function fillOrders(db, req, row, haveBefore) {
  const lines = db
    .prepare(
      `SELECT l.stock_item_id AS item_id, l.supplier, l.have, l.order_qty, i.target
         FROM stock_order_lines l JOIN stock_items i ON i.id = l.stock_item_id
        WHERE l.stock_order_id = ? AND i.target IS NOT NULL AND l.have IS NOT NULL`
    )
    .all(row.id);
  const before = {};
  const after = {};
  for (const l of lines) {
    if (haveBefore && !Object.prototype.hasOwnProperty.call(haveBefore, l.item_id)) continue;
    if (groupRow(db, row.id, l.supplier)) continue;
    const was = suggestOf(l.target, haveBefore ? haveBefore[l.item_id] : l.have);
    if (l.order_qty != null && l.order_qty !== was) continue;
    const want = suggestOf(l.target, l.have);
    if (want === l.order_qty) continue;
    if (row.nothing_at && want > 0) continue;
    db.prepare("UPDATE stock_order_lines SET order_qty = ? WHERE stock_order_id = ? AND stock_item_id = ?").run(want, row.id, l.item_id);
    before[l.item_id] = l.order_qty;
    after[l.item_id] = want;
  }
  if (Object.keys(after).length) {
    audit.log(req, { action: "stock_order.order_fill", entityType: "stock_order", entityId: row.period, before, after });
  }
}

// 0.2.27: finishing the count applies rule A (lib/stocklines.js) and marks the count sent. The month view
// carries sentResult {month, added, updated, removed}.
function counted(db, req, period, today = sydneyToday()) {
  periodOk(period, today);
  const sentResult = db.transaction(() => {
    const row = ensureOrder(db, period);
    if (row.counted_at) throw conflict("The count is already finished");
    // Every active item without a line gets an empty one: the month's list is now its own.
    const missing = db
      .prepare(
        `SELECT * FROM stock_items i
          WHERE i.active = 1
            AND NOT EXISTS (SELECT 1 FROM stock_order_lines l WHERE l.stock_order_id = ? AND l.stock_item_id = i.id)`
      )
      .all(row.id);
    const ins = db.prepare(
      `INSERT INTO stock_order_lines (stock_order_id, stock_item_id, supplier, code, item, have, order_qty)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`
    );
    for (const i of missing) ins.run(row.id, i.id, i.supplier, i.code, i.item);
    const now = nowIso();
    db.prepare("UPDATE stock_orders SET counted_at = ?, counted_by = ?, updated_at = ? WHERE id = ?").run(
      now,
      userId(req),
      now,
      row.id
    );
    audit.log(req, { action: "stock_order.counted", entityType: "stock_order", entityId: period, after: { counted_at: now } });
    fillOrders(db, req, row, null);
    // A count finished late, after a newer one was sent, must not replace the newer quantities: it is kept
    // but not sent.
    const stale = laterSent(db, period);
    const result = stale
      ? { month: today.slice(0, 7), added: 0, updated: 0, removed: 0, skipped: true }
      : sendToMonth(db, req, row, today);
    // The alert to Ordering (0.2.27): how many lines the count added or changed on the monthly order.
    const nLines = result.added + result.updated;
    const plural = (n) => `${n} ${n === 1 ? "line" : "lines"}`;
    notify.toKey(
      db,
      "stock.order",
      {
        kind: "stock.counted",
        title: `Stock counted: ${Periods.stockLabel(period)}`,
        body: nLines
          ? `${plural(nLines)} added or changed on the ${Periods.stockLabel(result.month)} stock order.`
          : result.removed
            ? `${plural(result.removed)} taken off the ${Periods.stockLabel(result.month)} stock order.`
            : stale
              ? "Not sent to the stock order: a newer count has already been sent."
              : "Nothing to add to the stock order from the count.",
        link: `/orders.html?stock=${result.month}`,
        entityType: "stock_order",
        entityId: period,
      },
      { exceptUserId: userId(req) }
    );
    return result;
  })();
  return { ...month(db, period, today), sentResult };
}

function laterSent(db, period) {
  return !!db.prepare("SELECT 1 AS x FROM stock_orders WHERE period > ? AND sent_at IS NOT NULL LIMIT 1").get(period);
}

// Rule A for a counted period, then the period is marked sent. Inside the caller's transaction.
function sendToMonth(db, req, row, today) {
  const result = stocklines.applyCount(db, req, row, today);
  const now = nowIso();
  db.prepare("UPDATE stock_orders SET sent_at = ?, sent_period = ?, updated_at = ? WHERE id = ?").run(now, result.month, now, row.id);
  audit.log(req, {
    action: "stock_order.sent",
    entityType: "stock_order",
    entityId: row.period,
    after: { sent_at: now, sent_period: result.month, added: result.added, updated: result.updated, removed: result.removed },
  });
  return result;
}

// POST /api/stock/orders/:period/send (stock.order): a count that was finished before 0.2.27 and not
// ordered (rule G) goes to the monthly order, once. 409 when it isn't counted, was already sent, or a
// later period has been sent (so an old count never replaces a newer one's lines).
function send(db, req, period, today = sydneyToday()) {
  periodOk(period, today);
  const sentResult = db.transaction(() => {
    const row = orderRow(db, period);
    if (!row || !row.counted_at) throw conflict("Finish the count first");
    if (row.sent_at) throw conflict("This count has already been sent to the monthly order");
    if (laterSent(db, period)) {
      throw conflict("A newer count has already been sent to the monthly order");
    }
    return sendToMonth(db, req, row, today);
  })();
  return { ...month(db, period, today), sentResult };
}

function reopen(db, req, period) {
  const today = sydneyToday();
  periodOk(period, today);
  db.transaction(() => {
    const row = orderRow(db, period);
    if (!row || !row.counted_at) throw conflict("The count isn't finished");
    if (row.nothing_at) throw conflict("This month is marked nothing to order; undo that first");
    if (db.prepare("SELECT 1 AS x FROM stock_order_groups WHERE stock_order_id = ? LIMIT 1").get(row.id)) {
      throw conflict("A supplier has already been ordered; undo that first");
    }
    if (laterSent(db, period)) throw conflict("A newer count has already been sent to the monthly order");
    // Stock that has arrived since the count isn't in its Have, so finishing it again would order it twice.
    if (
      row.sent_at &&
      db
        .prepare(
          `SELECT 1 AS x FROM stock_lines s JOIN stock_order_lines l ON l.stock_item_id = s.stock_item_id
            WHERE l.stock_order_id = ? AND s.status = 'received' AND s.deleted_at IS NULL AND s.updated_at >= ? LIMIT 1`
        )
        .get(row.id, row.sent_at)
    ) {
      throw conflict("Some of this stock has been received since the count. Count it again next time.");
    }
    db.prepare("DELETE FROM stock_order_lines WHERE stock_order_id = ? AND have IS NULL AND order_qty IS NULL").run(row.id);
    // 0.2.27: the monthly order keeps its lines; finishing the count again applies rule A again.
    db.prepare("UPDATE stock_orders SET counted_at = NULL, counted_by = NULL, sent_at = NULL, sent_period = NULL, updated_at = ? WHERE id = ?").run(nowIso(), row.id);
    audit.log(req, {
      action: "stock_order.reopen",
      entityType: "stock_order",
      entityId: period,
      before: { counted_at: row.counted_at, counted_by: row.counted_by, sent_at: row.sent_at, sent_period: row.sent_period },
    });
  })();
  return month(db, period, today);
}

// Order can be typed at any time; a line whose supplier group is ordered can't change.
// 0.2.27: closed. Quantities are no longer typed here (the Order tab is gone); a count feeds the monthly
// order on the Orders page (lib/stocklines.js) and Ordering edits it there.
function saveOrder() {
  throw conflict(ORDERED_ELSEWHERE);
}

// {} closes a counted month that needs nothing; {undo: true} takes it back (section 15.19).
// 0.2.27: closed (an empty month needs no action now). Months already marked stay read-only.
function nothingToOrder() {
  throw conflict(ORDERED_ELSEWHERE);
}

function supplierField(b) {
  return textField("supplier", b.supplier, SUPPLIER_MAX, { required: true });
}

// {supplier, orderedDate?, expectedDate?} marks a group ordered (once the count is finished, with
// at least one line to order); {supplier, undo: true} takes it back before it's received.
function group(db, req, period, body, today = sydneyToday()) {
  periodOk(period, today);
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const supplier = supplierField(b);
  if (b.undo === true) {
    db.transaction(() => {
      const row = orderRow(db, period);
      const g = row ? groupRow(db, row.id, supplier) : null;
      if (!g) throw conflict(`${supplier} hasn't been ordered`);
      if (g.received_date) throw conflict(`${supplier} has been received; undo that first`);
      db.prepare("DELETE FROM stock_order_groups WHERE stock_order_id = ? AND supplier = ?").run(row.id, supplier);
      touch(db, row.id);
      audit.log(req, {
        action: "stock_order.group_undo",
        entityType: "stock_order",
        entityId: period,
        before: { supplier, ordered_date: g.ordered_date, expected_date: g.expected_date },
      });
    })();
    return month(db, period, today);
  }
  // 0.2.27: marking a group ordered is closed; stock is ordered on the Orders page (undo above stays).
  throw conflict(ORDERED_ELSEWHERE);
}

// {supplier, receivedDate?, deliveryNote?} or {supplier, undo: true}. Undoing keeps the note, as
// an order line's received -> ordered does.
function groupReceived(db, req, period, body, today = sydneyToday()) {
  periodOk(period, today);
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const supplier = supplierField(b);
  if (b.undo === true) {
    db.transaction(() => {
      const row = orderRow(db, period);
      const g = row ? groupRow(db, row.id, supplier) : null;
      if (!g || !g.received_date) throw conflict(`${supplier} hasn't been received`);
      db.prepare(
        "UPDATE stock_order_groups SET received_date = NULL, received_by = NULL WHERE stock_order_id = ? AND supplier = ?"
      ).run(row.id, supplier);
      touch(db, row.id);
      audit.log(req, {
        action: "stock_order.group_unreceived",
        entityType: "stock_order",
        entityId: period,
        before: { supplier, received_date: g.received_date, received_by: g.received_by },
      });
    })();
    return month(db, period, today);
  }
  const receivedDate = dateOrNull("receivedDate", b.receivedDate) || today;
  if (receivedDate > today) throw bad("The received date can't be in the future");
  let note;
  if (b.deliveryNote !== undefined) note = textField("The delivery note", b.deliveryNote, DELIVERY_NOTE_MAX);
  db.transaction(() => {
    const row = orderRow(db, period);
    const g = row ? groupRow(db, row.id, supplier) : null;
    if (!g) throw conflict(`${supplier} hasn't been ordered`);
    if (g.received_date) throw conflict(`It was already marked received on ${dayLabel(g.received_date)}`);
    if (receivedDate < g.ordered_date) {
      throw bad(`The received date can't be before it was ordered (${dayLabel(g.ordered_date)})`);
    }
    const deliveryNote = note === undefined ? g.delivery_note : note;
    db.prepare(
      `UPDATE stock_order_groups SET received_date = ?, received_by = ?, delivery_note = ?
        WHERE stock_order_id = ? AND supplier = ?`
    ).run(receivedDate, userId(req), deliveryNote, row.id, supplier);
    touch(db, row.id);
    const after = { supplier, received_date: receivedDate, received_by: userId(req) };
    if (deliveryNote !== g.delivery_note) after.delivery_note = deliveryNote;
    audit.log(req, { action: "stock_order.group_received", entityType: "stock_order", entityId: period, after });
    // A new non-empty delivery note tells Ordering, as an order line's does (section 15.20).
    if (deliveryNote && deliveryNote !== g.delivery_note) {
      notify.toKey(
        db,
        "orders.mark_ordered",
        {
          kind: "stock.delivery_note",
          title: `Delivery note: Stock order ${Periods.stockLabel(period)}`,
          body: `${supplier}: ${cutNote(deliveryNote)}`,
          link: `/stock.html?period=${period}`,
          entityType: "stock_order",
          entityId: period,
        },
        { exceptUserId: userId(req) }
      );
    }
  })();
  return month(db, period, today);
}

// ------------------------------------------------------------- summary ---

function holds(user, key) {
  const perms = user && user.perms;
  if (perms instanceof Set) return perms.has(key);
  if (Array.isArray(perms)) return perms.includes(key);
  return false;
}

// The month being counted (section 11.8): this month from the 25th, the previous one on days 1-7,
// otherwise none.
function countMonth(today) {
  const day = Number(today.slice(8, 10));
  const current = Periods.currentPeriod(today);
  if (day >= 25) return current;
  if (day <= 7) return Periods.addMonths(current, -1);
  return null;
}

// The stock count due (m27-contracts.md section 2): {period, label, overdue} or null. Monthly: as
// before (countMonth). Fortnightly: the fortnight before while it isn't counted (overdue), else the
// current fortnight from DUE_FROM days after its Monday (its Thursday; Todd 2026-10-27: the first
// fortnight, from Mon 26 Oct, is due from Thu 29 Oct) until it is counted.
const DUE_FROM = 3;
function stockCountDue(db, today = sydneyToday()) {
  const { cycle, cycleStart } = cycleOf(db);
  const done = (p) => {
    const r = orderRow(db, p);
    return !!(r && r.counted_at);
  };
  if (cycle === "monthly") {
    const p = countMonth(today);
    return p && !done(p) ? { period: p, label: Periods.longLabel(p), overdue: false } : null;
  }
  if (today < cycleStart) return null;
  const cur = Periods.fortnightOf(today, cycleStart);
  const prev = Periods.addStockPeriods(cur, -1);
  if (prev >= cycleStart && !done(prev)) return { period: prev, label: Periods.stockLabel(prev), overdue: true };
  if (today >= Periods.addDays(cur, DUE_FROM) && !done(cur)) return { period: cur, label: Periods.stockLabel(cur), overdue: false };
  return null;
}

// GET /api/stock/summary: only the parts the user's keys allow (section 11.8). Each part is null
// (or an empty list) when the dashboard has nothing to say.
//   stock.count: stockCount, boardCount: {period, label} | null (a count due and not finished).
//   stock.order: drawers {toOrder, waiting}; stockToOrder [{month, label, toOrder}] (0.2.27: the months with
//   stock lines still to order, oldest first); stockToSend [{period, label}] (rule G: counted before 0.2.27,
//   not sent, with an order quantity in a group not ordered). (boardValue was removed 2026-10-17.)
function summary(db, user, today = sydneyToday()) {
  const out = { date: today };
  if (holds(user, "stock.count")) {
    // The board stocktake stays monthly (Todd, 2026-10-27).
    const p = countMonth(today);
    const boardRow = p ? db.prepare("SELECT status FROM board_counts WHERE period = ?").get(p) : null;
    out.stockCount = stockCountDue(db, today);
    out.boardCount = p && !(boardRow && boardRow.status !== "open") ? { period: p, label: Periods.longLabel(p) } : null;
  }
  if (holds(user, "stock.order")) {
    out.drawers = require("./drawers").summary(db);
    out.stockToOrder = stocklines.toOrderMonths(db);
    out.stockToSend = db
      .prepare(
        `SELECT o.period FROM stock_orders o
          WHERE o.counted_at IS NOT NULL AND o.sent_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM stock_orders n WHERE n.period > o.period AND n.sent_at IS NOT NULL)
            AND EXISTS (SELECT 1 FROM stock_order_lines l
                         WHERE l.stock_order_id = o.id AND l.order_qty > 0
                           AND NOT EXISTS (SELECT 1 FROM stock_order_groups g WHERE g.stock_order_id = o.id AND g.supplier = l.supplier))
          ORDER BY o.period`
      )
      .all()
      .map((r) => ({ period: r.period, label: Periods.stockLabel(r.period) }));
  }
  return out;
}

module.exports = {
  cycleOf,
  cycleSettings,
  saveCycle,
  stockCountDue,
  items,
  createItem,
  updateItem,
  reorderItems,
  months,
  month,
  saveHave,
  counted,
  send,
  reopen,
  saveOrder,
  nothingToOrder,
  group,
  groupReceived,
  summary,
};
