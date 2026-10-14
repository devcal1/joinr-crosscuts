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
const Periods = require("../public/periods");

const SUPPLIER_MAX = 200;
const ITEM_MAX = 200;
const CODE_MAX = 100;
const LINK_MAX = 500;
const QTY_MAX = 99999;
const DELIVERY_NOTE_MAX = 500; // as an order line's (m10-contracts.md section 4.2)
const REORDER_MAX = 5000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COUNT_DONE = "The count is finished; ask Ordering to reopen it";

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

// The YYYY-MM month, no later than the current one (section 7).
function periodOk(period, today) {
  if (!Periods.validPeriod(period)) throw bad("The month must be YYYY-MM");
  if (period > Periods.currentPeriod(today)) throw bad("That month hasn't started yet");
  return period;
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
        `INSERT INTO stock_items (supplier, code, item, link, sort, active, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.supplier, f.code, f.item, f.link, sort, f.active, now, now, userId(req));
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
                  i.link, i.sort
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
  }));
  if (!row || !row.counted_at) {
    const has = new Set(out.map((l) => l.itemId));
    for (const i of db.prepare("SELECT * FROM stock_items WHERE active = 1").all()) {
      if (has.has(i.id)) continue;
      out.push({ itemId: i.id, supplier: i.supplier, code: i.code, item: i.item, link: i.link, have: null, order: null, sort: i.sort });
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

// Section 7.1's order: counting; counted until any group is ordered; ordering while a group with
// something to order isn't ordered; received when every ordered group is received; else ordered.
// A group with no order quantities needs no order (section 15.19): a counted month needing nothing
// at all is "ordered" (done) as soon as the count is finished.
function stateOf(row, lines, groups) {
  if (!row || !row.counted_at) return "counting";
  if (!groups.length) return lines.some((l) => l.order > 0) ? "counted" : "ordered";
  const ordered = new Set(groups.map((g) => g.supplier));
  if (lines.some((l) => l.order > 0 && !ordered.has(l.supplier))) return "ordering";
  return groups.every((g) => g.received_date) ? "received" : "ordered";
}

function countedOf(db, row) {
  if (!row || !row.counted_at) return null;
  const u = db.prepare("SELECT display_name FROM users WHERE id = ?").get(row.counted_by);
  return { at: row.counted_at, by: person(row.counted_by, u && u.display_name) };
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
    index.get(l.supplier).lines.push({ itemId: l.itemId, code: l.code, item: l.item, link: l.link, have: l.have, order: l.order });
  }
  return {
    period,
    state: stateOf(row, lines, [...groupsBy.values()]),
    counted: countedOf(db, row),
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
      return { period: v.period, state: v.state, counted: v.counted };
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
  })();
  return month(db, period, today);
}

function counted(db, req, period, today = sydneyToday()) {
  periodOk(period, today);
  db.transaction(() => {
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
    notify.toKey(
      db,
      "stock.order",
      {
        kind: "stock.counted",
        title: `Stock counted: ${Periods.longLabel(period)}`,
        link: `/stock.html?period=${period}`,
        entityType: "stock_order",
        entityId: period,
      },
      { exceptUserId: userId(req) }
    );
  })();
  return month(db, period, today);
}

function reopen(db, req, period) {
  const today = sydneyToday();
  periodOk(period, today);
  db.transaction(() => {
    const row = orderRow(db, period);
    if (!row || !row.counted_at) throw conflict("The count isn't finished");
    if (db.prepare("SELECT 1 AS x FROM stock_order_groups WHERE stock_order_id = ? LIMIT 1").get(row.id)) {
      throw conflict("A supplier has already been ordered; undo that first");
    }
    db.prepare("DELETE FROM stock_order_lines WHERE stock_order_id = ? AND have IS NULL AND order_qty IS NULL").run(row.id);
    db.prepare("UPDATE stock_orders SET counted_at = NULL, counted_by = NULL, updated_at = ? WHERE id = ?").run(nowIso(), row.id);
    audit.log(req, {
      action: "stock_order.reopen",
      entityType: "stock_order",
      entityId: period,
      before: { counted_at: row.counted_at, counted_by: row.counted_by },
    });
  })();
  return month(db, period, today);
}

// Order can be typed at any time; a line whose supplier group is ordered can't change.
function saveOrder(db, req, period, lines, today = sydneyToday()) {
  periodOk(period, today);
  const list = lineList(lines, "order", "Order");
  db.transaction(() => {
    const row = ensureOrder(db, period);
    const guard = (supplier) => {
      if (groupRow(db, row.id, supplier)) throw conflict(`${supplier} has already been ordered`);
    };
    const { before, after } = writeColumn(db, row, list, "order_qty", guard);
    if (!Object.keys(after).length) return;
    touch(db, row.id);
    audit.log(req, { action: "stock_order.order", entityType: "stock_order", entityId: period, before, after });
  })();
  return month(db, period, today);
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
  const orderedDate = dateOrNull("orderedDate", b.orderedDate) || today;
  if (orderedDate > today) throw bad("The ordered date can't be in the future");
  const expectedDate = dateOrNull("expectedDate", b.expectedDate);
  if (expectedDate && expectedDate < orderedDate) {
    throw bad(`The expected date can't be before it was ordered (${dayLabel(orderedDate)})`);
  }
  db.transaction(() => {
    const row = orderRow(db, period);
    if (!row || !row.counted_at) throw conflict("Finish the count first");
    if (groupRow(db, row.id, supplier)) throw conflict(`${supplier} has already been ordered`);
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM stock_order_lines WHERE stock_order_id = ? AND supplier = ? AND order_qty > 0")
      .get(row.id, supplier).n;
    if (!n) throw bad(`Nothing to order from ${supplier}`);
    db.prepare(
      `INSERT INTO stock_order_groups (stock_order_id, supplier, ordered_date, ordered_by, expected_date)
       VALUES (?, ?, ?, ?, ?)`
    ).run(row.id, supplier, orderedDate, userId(req), expectedDate);
    touch(db, row.id);
    audit.log(req, {
      action: "stock_order.group_ordered",
      entityType: "stock_order",
      entityId: period,
      after: { supplier, ordered_date: orderedDate, expected_date: expectedDate },
    });
  })();
  return month(db, period, today);
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
          title: `Delivery note: Stock order ${Periods.longLabel(period)}`,
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

// GET /api/stock/summary: only the parts the user's keys allow (section 11.8). Each part is null
// (or an empty list) when the dashboard has nothing to say.
//   stock.count: stockCount, boardCount: {period, label} | null (a count due and not finished).
//   stock.order: drawers {toOrder, waiting}; stockToOrder [{period, label, state}] (counted or
//   ordering), boardValue [{period, label}] (counted, the value to confirm); newest first.
function summary(db, user, today = sydneyToday()) {
  const out = { date: today };
  if (holds(user, "stock.count")) {
    const p = countMonth(today);
    const stockRow = p ? orderRow(db, p) : null;
    const boardRow = p ? db.prepare("SELECT status FROM board_counts WHERE period = ?").get(p) : null;
    out.stockCount = p && !(stockRow && stockRow.counted_at) ? { period: p, label: Periods.longLabel(p) } : null;
    out.boardCount = p && !(boardRow && boardRow.status !== "open") ? { period: p, label: Periods.longLabel(p) } : null;
  }
  if (holds(user, "stock.order")) {
    out.drawers = require("./drawers").summary(db);
    out.stockToOrder = db
      .prepare("SELECT * FROM stock_orders WHERE counted_at IS NOT NULL ORDER BY period DESC")
      .all()
      .map((row) => ({ period: row.period, state: view(db, row.period, row).state }))
      .filter((m) => m.state === "counted" || m.state === "ordering")
      .map((m) => ({ period: m.period, label: Periods.longLabel(m.period), state: m.state }));
    out.boardValue = db
      .prepare("SELECT period FROM board_counts WHERE status = 'counted' ORDER BY period DESC")
      .all()
      .map((r) => ({ period: r.period, label: Periods.longLabel(r.period) }));
  }
  return out;
}

module.exports = {
  items,
  createItem,
  updateItem,
  reorderItems,
  months,
  month,
  saveHave,
  counted,
  reopen,
  saveOrder,
  group,
  groupReceived,
  summary,
};
