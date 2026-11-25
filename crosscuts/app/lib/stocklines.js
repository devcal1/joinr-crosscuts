// Monthly stock orders on the Orders page (0.2.27, docs/plans/stock-orders-plan.md and
// stock-orders-contracts.md): stock_lines, one row per stock item on a calendar month's order, with no
// job. Lines come from a count (rule A, applyCount) or are added by hand. They are ordered only through
// a supplier order (lib/orders.js markOrderedMany calls planOrder and markOrdered here), received and
// undone through update(), and soft-deleted while still to order.
//
// Every function takes db first and nothing here requires ../db. Every write runs in one
// db.transaction with its audit row (entityType stock_line). Month arithmetic is Periods'; the month a
// line belongs to is a Sydney calendar month ('YYYY-MM').
const audit = require("./audit");
const notify = require("./notify");
const orders = require("./orders");
const purchaseorders = require("./purchaseorders");
const Periods = require("../public/periods");
const { bad, notFound, conflict, forbidden, can } = require("./httperror");
const { sydneyToday } = require("./time");

const STATUSES = ["to_order", "ordered", "received"];
const F = orders.fields;

function nowIso() {
  return new Date().toISOString();
}

function userId(req) {
  return req && req.user && req.user.id != null ? req.user.id : null;
}

function person(id, name) {
  return id == null ? null : { id, name: name || null };
}

function monthOf(today) {
  return today.slice(0, 7);
}

const SELECT = `SELECT l.*, uc.display_name AS created_by_name, ur.display_name AS received_by_name,
    (SELECT so.po_seq FROM supplier_orders so WHERE so.id = l.supplier_order_id) AS po_seq
  FROM stock_lines l
  LEFT JOIN users uc ON uc.id = l.created_by
  LEFT JOIN users ur ON ur.id = l.received_by`;

function loadRow(db, id) {
  return db.prepare(`${SELECT} WHERE l.id = ?`).get(id);
}

// The line object (contracts "Line shape").
function present(row, today = sydneyToday()) {
  return {
    id: row.id,
    month: row.month,
    supplier: row.supplier,
    item: row.item,
    code: row.code || "",
    quantity: Number(row.quantity),
    status: row.status,
    orderedDate: row.ordered_date || null,
    expectedDate: row.expected_date || null,
    receivedDate: row.received_date || null,
    receivedBy: person(row.received_by, row.received_by_name),
    notes: row.notes || "",
    deliveryNote: row.delivery_note || "",
    source: row.source,
    stockItemId: row.stock_item_id == null ? null : row.stock_item_id,
    supplierOrderId: row.supplier_order_id == null ? null : row.supplier_order_id,
    poNumber: row.po_seq == null ? null : purchaseorders.poNumberOf(row.po_seq),
    createdAt: row.created_at,
    createdBy: person(row.created_by, row.created_by_name),
    overdue: (row.status === "to_order" || row.status === "ordered") && !!row.expected_date && row.expected_date < today,
  };
}

function loadLine(db, id, today) {
  const row = loadRow(db, id);
  return row ? present(row, today) : null;
}

// ---------------------------------------------------------------- reads ---

function monthOr400(v, label = "month") {
  if (typeof v !== "string" || !Periods.validPeriod(v)) throw bad(`${label} must be a month (YYYY-MM)`);
  return v;
}

// GET /api/stock-lines/months -> {current, first, last, months: [{month, toOrder, ordered, received}]}.
// A continuous run from the earlier of the first month with a line and this month, to the later of next
// month and the latest month with a line. Deleted lines are in no count.
function months(db, today = sydneyToday()) {
  const current = monthOf(today);
  const rows = db
    .prepare(
      `SELECT month,
              SUM(CASE WHEN status = 'to_order' THEN 1 ELSE 0 END) AS to_order,
              SUM(CASE WHEN status = 'ordered' THEN 1 ELSE 0 END) AS ordered,
              SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) AS received
         FROM stock_lines WHERE deleted_at IS NULL GROUP BY month`
    )
    .all();
  const by = new Map(rows.map((r) => [r.month, r]));
  const keys = [...by.keys()].sort();
  const first = keys.length && keys[0] < current ? keys[0] : current;
  const next = Periods.addMonths(current, 1);
  const last = keys.length && keys[keys.length - 1] > next ? keys[keys.length - 1] : next;
  const out = [];
  for (let m = first; m <= last; m = Periods.addMonths(m, 1)) {
    const r = by.get(m);
    out.push({
      month: m,
      toOrder: r ? Number(r.to_order) || 0 : 0,
      ordered: r ? Number(r.ordered) || 0 : 0,
      received: r ? Number(r.received) || 0 : 0,
    });
  }
  return { current, first, last, months: out };
}

function bySupplierThenId(a, b) {
  const x = a.supplier.toLowerCase();
  const y = b.supplier.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.supplier < b.supplier ? -1 : a.supplier > b.supplier ? 1 : a.id - b.id;
}

// GET /api/stock-lines?month=YYYY-MM[&status=...] or ?status=to_order (every month)
// -> {month, lines, suppliers}. Lines by supplier A-Z, then id; suppliers: their distinct names, A-Z.
function list(db, { month, status } = {}, today = sydneyToday()) {
  if (month === undefined && status === undefined) throw bad("month or status is required");
  const where = ["l.deleted_at IS NULL"];
  const params = [];
  if (month !== undefined) {
    where.push("l.month = ?");
    params.push(monthOr400(month));
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(", ")}`);
    where.push("l.status = ?");
    params.push(status);
  }
  const lines = db
    .prepare(`${SELECT} WHERE ${where.join(" AND ")}`)
    .all(...params)
    .map((r) => present(r, today))
    .sort(bySupplierThenId);
  const seen = new Map();
  for (const l of lines) if (!seen.has(l.supplier.toLowerCase())) seen.set(l.supplier.toLowerCase(), l.supplier);
  return { month: month === undefined ? null : month, lines, suppliers: [...seen.values()] };
}

// GET /api/stock-lines/items: the active stock list for the type-ahead.
function items(db) {
  return db
    .prepare("SELECT id, supplier, code, item FROM stock_items WHERE active = 1 ORDER BY sort, id")
    .all()
    .map((r) => ({ id: r.id, supplier: r.supplier, code: r.code || "", item: r.item }));
}

// ---------------------------------------------------------------- hand lines ---

function body(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// POST /api/stock-lines {month, supplier, item, quantity, notes?, stockItemId?} -> the line (source hand).
function create(db, req, input, today = sydneyToday()) {
  const b = body(input);
  const month = monthOr400(b.month);
  const current = monthOf(today);
  if (month < current || month > Periods.addMonths(current, 1)) throw bad("The month must be this month or next month");
  const supplier = F.textField("supplier", b.supplier, F.SUPPLIER_MAX, { required: true });
  const item = F.textField("item", b.item, F.DESCRIPTION_MAX, { required: true });
  const notes = F.textField("notes", b.notes, F.NOTES_MAX);
  const quantity = F.quantityField(b.quantity);
  if (quantity === null) throw bad("Quantity is required");
  let stockItemId = null;
  let code = "";
  if (b.stockItemId !== undefined && b.stockItemId !== null) {
    if (!Number.isSafeInteger(b.stockItemId) || b.stockItemId < 1) throw bad("stockItemId must be a positive whole number");
    stockItemId = b.stockItemId;
  }
  const id = db.transaction(() => {
    if (stockItemId !== null) {
      const si = db.prepare("SELECT id, code FROM stock_items WHERE id = ?").get(stockItemId);
      if (!si) throw bad(`There is no stock item ${stockItemId}`);
      code = si.code || "";
    }
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO stock_lines (month, supplier, item, code, quantity, status, notes, source, stock_item_id,
                                  created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, 'to_order', ?, 'hand', ?, ?, ?, ?, ?)`
      )
      .run(month, supplier, item, code, quantity, notes, stockItemId, now, userId(req), now, userId(req));
    const newId = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "stock_line.create",
      entityType: "stock_line",
      entityId: newId,
      after: { month, supplier, item, code, quantity, status: "to_order", notes, source: "hand", stock_item_id: stockItemId },
    });
    return newId;
  })();
  return loadLine(db, id, today);
}

// PATCH /api/stock-lines/:id. The route admits orders.edit, orders.mark_ordered or orders.receive; each
// field needs its own key (checked here, the whole patch before anything is written):
//   supplier, item, quantity, notes: orders.edit (supplier, item and quantity only while to_order, else 409)
//   status: ordered>to_order (Undo) orders.mark_ordered; ordered>received and received>ordered orders.receive;
//     to_order>ordered is refused (only a supplier order does it); to_order>received and received>to_order 409
//   expectedDate (while ordered): orders.mark_ordered
//   receivedDate (with the move to received, or on a received line), deliveryNote: orders.receive
function update(db, req, id, patch, today = sydneyToday()) {
  const p = body(patch);
  const has = (k) => Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined;
  const line = db.prepare("SELECT * FROM stock_lines WHERE id = ?").get(id);
  if (!line) throw notFound();
  if (line.deleted_at) throw conflict("This item was deleted");

  // Shape of everything sent (400).
  if (has("status") && !STATUSES.includes(p.status)) throw bad(`status must be one of ${STATUSES.join(", ")}`);
  const text = {};
  if (has("supplier")) text.supplier = F.textField("supplier", p.supplier, F.SUPPLIER_MAX, { required: true });
  if (has("item")) text.item = F.textField("item", p.item, F.DESCRIPTION_MAX, { required: true });
  if (has("quantity")) {
    text.quantity = F.quantityField(p.quantity);
    if (text.quantity === null) throw bad("Quantity is required");
  }
  if (has("notes")) text.notes = F.textField("notes", p.notes, F.NOTES_MAX);
  const expectedIn = has("expectedDate") ? F.dateOrNull("expectedDate", p.expectedDate) : undefined;
  const receivedIn = has("receivedDate") ? F.dateOrNull("receivedDate", p.receivedDate) : undefined;
  if (receivedIn && receivedIn > today) throw bad("The received date can't be in the future");
  const noteIn = has("deliveryNote") ? F.deliveryNoteField(p.deliveryNote) : undefined;

  const changes = {};
  for (const [col, v] of Object.entries(text)) {
    if (col === "quantity" ? Number(line.quantity) !== v : v !== line[col]) changes[col] = v;
  }
  const edits = Object.keys(changes);
  if (edits.length && !can(req, "orders.edit")) throw forbidden();
  if (edits.some((c) => c !== "notes") && line.status !== "to_order") {
    throw conflict("Only an item still to order can change its supplier, item or quantity");
  }

  // Status.
  const statusChange = has("status") && p.status !== line.status ? p.status : null;
  if (has("status") && !statusChange && line.status !== "to_order") {
    const on = line.status === "ordered" ? line.ordered_date : line.received_date;
    throw conflict(`It was already marked ${line.status}${on ? ` on ${orders.dayLabel(on)}` : ""}`);
  }
  let transition = null;
  if (statusChange) {
    const key = `${line.status}>${statusChange}`;
    if (key === "to_order>ordered") throw conflict("Stock is ordered on a supplier order. Use Order on the Stock section.");
    if (key === "to_order>received") throw conflict("Mark it ordered first");
    if (key === "received>to_order") throw conflict("A line can't go from received to to_order. Undo received first.");
    const needs = {
      "ordered>to_order": "orders.mark_ordered",
      "ordered>received": "orders.receive",
      "received>ordered": "orders.receive",
    }[key];
    if (!can(req, needs)) throw forbidden();
    transition = key;
    changes.status = statusChange;
    if (key === "ordered>received") {
      changes.received_date = receivedIn || today;
      changes.received_by = userId(req);
    } else if (key === "ordered>to_order") {
      // Back to To order: the dates, any delivery note and the PO link go.
      changes.ordered_date = null;
      changes.expected_date = null;
      if (line.delivery_note) changes.delivery_note = "";
      changes.supplier_order_id = null;
    } else {
      changes.received_date = null;
      changes.received_by = null;
    }
  } else if (receivedIn !== undefined) {
    if (receivedIn === null) throw bad("receivedDate must be a valid YYYY-MM-DD date");
    if (line.status !== "received") throw conflict("The line hasn't been received yet");
    if (!can(req, "orders.receive")) throw forbidden();
    if (receivedIn !== line.received_date) changes.received_date = receivedIn;
  }
  // The received date can't be before it was ordered.
  const receivedFinal = "received_date" in changes ? changes.received_date : line.received_date;
  if (line.ordered_date && receivedFinal && receivedFinal < line.ordered_date && transition !== "ordered>to_order" && "received_date" in changes) {
    throw bad(`The received date can't be before it was ordered (${orders.dayLabel(line.ordered_date)})`);
  }

  // Expected date: while ordered, orders.mark_ordered.
  if (expectedIn !== undefined && transition !== "ordered>to_order") {
    if ((transition ? changes.status : line.status) !== "ordered") throw conflict("Only an ordered item has an expected date");
    if (!can(req, "orders.mark_ordered")) throw forbidden();
    if (expectedIn !== line.expected_date) changes.expected_date = expectedIn;
  }

  // The delivery note: orders.receive; a non-empty one only on an ordered or received line.
  const noteBefore = line.delivery_note || "";
  const noteChanged = noteIn !== undefined && noteIn !== noteBefore && transition !== "ordered>to_order";
  if (noteChanged && !can(req, "orders.receive")) throw forbidden();
  if (noteIn && noteChanged) {
    const after = changes.status || line.status;
    if (after !== "ordered" && after !== "received") throw conflict("Only an ordered or received line takes a delivery note");
  }
  if (noteChanged) changes.delivery_note = noteIn;

  const cols = Object.keys(changes);
  if (!cols.length) return loadLine(db, id, today);

  db.transaction(() => {
    const ts = nowIso();
    db.prepare(`UPDATE stock_lines SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`).run(
      ...cols.map((c) => changes[c]),
      ts,
      userId(req),
      id
    );
    const statusCols = new Set(["status", "ordered_date", "received_date", "received_by", "supplier_order_id"]);
    const plain = cols.filter((c) => !(transition && statusCols.has(c)) && !(transition === "ordered>to_order" && (c === "expected_date" || c === "delivery_note")));
    if (plain.length) {
      const before = {};
      const after = {};
      for (const c of plain) {
        before[c] = line[c];
        after[c] = changes[c];
      }
      audit.log(req, { action: "stock_line.update", entityType: "stock_line", entityId: id, before, after });
    }
    if (transition) {
      const was = (c) => (c in changes ? changes[c] : line[c]);
      const before = { status: line.status, ordered_date: line.ordered_date, received_date: line.received_date, received_by: line.received_by };
      const after = { status: changes.status, ordered_date: was("ordered_date"), received_date: was("received_date"), received_by: was("received_by") };
      if (transition === "ordered>to_order") {
        before.expected_date = line.expected_date;
        after.expected_date = null;
        before.supplier_order_id = line.supplier_order_id;
        after.supplier_order_id = null;
        if (line.delivery_note) {
          before.delivery_note = line.delivery_note;
          after.delivery_note = "";
        }
      }
      audit.log(req, { action: "stock_line.status", entityType: "stock_line", entityId: id, before, after });
    }
    // A new non-empty delivery note tells Ordering, as a stock group's does.
    if (noteChanged && noteIn) {
      const supplier = "supplier" in changes ? changes.supplier : line.supplier;
      notify.toKey(
        db,
        "orders.mark_ordered",
        {
          kind: "stock.delivery_note",
          title: `Delivery note: Stock order ${Periods.stockLabel(line.month)}`,
          body: `${supplier}: ${orders.cutNote(noteIn)}`,
          link: `/orders.html?stock=${line.month}`,
          entityType: "stock_line",
          entityId: id,
        },
        { exceptUserId: userId(req) }
      );
    }
  })();
  return loadLine(db, id, today);
}

// DELETE /api/stock-lines/:id: soft, to_order only. Returns the line as it was.
function remove(db, req, id, today = sydneyToday()) {
  const line = db.prepare("SELECT * FROM stock_lines WHERE id = ?").get(id);
  if (!line) throw notFound();
  if (line.deleted_at) throw conflict("This item was already deleted");
  if (line.status !== "to_order") throw conflict("This item is already ordered or received. Undo ordered first.");
  db.transaction(() => softDelete(db, req, line, { by: "user" }))();
  return { id, deleted: true };
}

function softDelete(db, req, line, extra) {
  const ts = nowIso();
  db.prepare("UPDATE stock_lines SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(
    ts,
    userId(req),
    ts,
    userId(req),
    line.id
  );
  audit.log(req, {
    action: "stock_line.delete",
    entityType: "stock_line",
    entityId: line.id,
    before: { status: line.status, quantity: Number(line.quantity) },
    after: { deleted: true, month: line.month, supplier: line.supplier, item: line.item, ...(extra || {}) },
  });
}

// ---------------------------------------------------------------- rule A ---

function suggestOf(target, have) {
  if (target == null || have == null) return null;
  return Math.max(target - have, 0);
}

// Rule A (docs/plans/stock-orders-plan.md), called inside counted()'s and send()'s transaction with the
// month's stock_orders row. Returns {month, added, updated, removed}: the Sydney month the lines went to.
function applyCount(db, req, orderRow, today = sydneyToday()) {
  const month = monthOf(today);
  const result = { month, added: 0, updated: 0, removed: 0 };
  const lines = db
    .prepare(
      `SELECT l.stock_item_id AS item_id, l.supplier AS line_supplier, l.have, l.order_qty,
              i.target, i.active, i.supplier, i.code, i.item
         FROM stock_order_lines l JOIN stock_items i ON i.id = l.stock_item_id
        WHERE l.stock_order_id = ?
        ORDER BY i.sort, i.id`
    )
    .all(orderRow.id);
  const grouped = new Set(
    db.prepare("SELECT supplier FROM stock_order_groups WHERE stock_order_id = ?").all(orderRow.id).map((g) => g.supplier)
  );
  const orderedStock = db.prepare(
    "SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_lines WHERE stock_item_id = ? AND status = 'ordered' AND deleted_at IS NULL"
  );
  const orderedOld = db.prepare(
    `SELECT COALESCE(SUM(l.order_qty), 0) AS n
       FROM stock_order_lines l
       JOIN stock_order_groups g ON g.stock_order_id = l.stock_order_id AND g.supplier = l.supplier
      WHERE l.stock_item_id = ? AND l.stock_order_id <> ? AND l.order_qty > 0 AND g.received_date IS NULL`
  );
  const existing = db.prepare(
    "SELECT * FROM stock_lines WHERE stock_item_id = ? AND source = 'count' AND status = 'to_order' AND deleted_at IS NULL ORDER BY id"
  );
  for (const l of lines) {
    if (grouped.has(l.line_supplier)) continue;
    const base = l.order_qty != null ? l.order_qty : suggestOf(l.target, l.have);
    if (base == null) continue;
    const onOrder = Number(orderedStock.get(l.item_id).n) + Number(orderedOld.get(l.item_id, orderRow.id).n);
    // An item taken off the stock list since the count began is not ordered.
    const need = l.active === 1 ? Math.max(0, Math.round((base - onOrder) * 100) / 100) : 0;
    const mine = existing.all(l.item_id);
    if (need > 0 && mine.length) {
      const [keep, ...extra] = mine;
      const before = {};
      const after = {};
      const want = { month, supplier: l.supplier, code: l.code || "", item: l.item, quantity: need };
      for (const [k, v] of Object.entries(want)) {
        const was = k === "quantity" ? Number(keep[k]) : keep[k];
        if (was !== v) {
          before[k] = was;
          after[k] = v;
        }
      }
      if (Object.keys(after).length) {
        const cols = Object.keys(after);
        db.prepare(`UPDATE stock_lines SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`).run(
          ...cols.map((c) => after[c]),
          nowIso(),
          userId(req),
          keep.id
        );
        audit.log(req, { action: "stock_line.update", entityType: "stock_line", entityId: keep.id, before, after: { ...after, via: "count" } });
        result.updated += 1;
      }
      for (const e of extra) {
        softDelete(db, req, e, { via: "count" });
        result.removed += 1;
      }
    } else if (need > 0) {
      const now = nowIso();
      const code = l.code || "";
      const info = db
        .prepare(
          `INSERT INTO stock_lines (month, supplier, item, code, quantity, status, source, stock_item_id,
                                    created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, 'to_order', 'count', ?, ?, ?, ?, ?)`
        )
        .run(month, l.supplier, l.item, code, need, l.item_id, now, userId(req), now, userId(req));
      audit.log(req, {
        action: "stock_line.create",
        entityType: "stock_line",
        entityId: Number(info.lastInsertRowid),
        after: { month, supplier: l.supplier, item: l.item, code, quantity: need, status: "to_order", source: "count", stock_item_id: l.item_id, period: orderRow.period },
      });
      result.added += 1;
    } else {
      for (const e of mine) {
        softDelete(db, req, e, { via: "count" });
        result.removed += 1;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------- ordering ---

// Called by markOrderedMany inside its transaction: every ticked line must exist, be live and still be
// to order (409 otherwise, nothing written). Returns the rows in the given order.
function planOrder(db, ids) {
  return ids.map((id) => {
    const row = db.prepare("SELECT * FROM stock_lines WHERE id = ?").get(id);
    if (!row) throw conflict("An item you ticked no longer exists. Reload and try again.");
    if (row.deleted_at) throw conflict("This item was deleted. Reload and try again.");
    if (row.status !== "to_order") {
      throw conflict(`${row.item} (${row.supplier}) on the ${Periods.stockLabel(row.month)} stock order is no longer to order. Reload and try again.`);
    }
    return row;
  });
}

// Marks the planned lines ordered (and links them to the saved order) after the PO exists.
function markOrdered(db, req, rows, { ordered, expected }, poId) {
  const ts = nowIso();
  for (const row of rows) {
    db.prepare(
      `UPDATE stock_lines SET status = 'ordered', ordered_date = ?, expected_date = ?, supplier_order_id = ?,
              updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(ordered, expected || null, poId, ts, userId(req), row.id);
    audit.log(req, {
      action: "stock_line.status",
      entityType: "stock_line",
      entityId: row.id,
      before: { status: "to_order", ordered_date: null, received_date: null, received_by: null },
      after: { status: "ordered", ordered_date: ordered, received_date: null, received_by: null, expected_date: expected || null, supplier_order_id: poId },
    });
  }
}

// ---------------------------------------------------------------- summary ---

// Dashboard: the months with to_order lines, oldest first.
function toOrderMonths(db) {
  return db
    .prepare("SELECT month, COUNT(*) AS n FROM stock_lines WHERE status = 'to_order' AND deleted_at IS NULL GROUP BY month ORDER BY month")
    .all()
    .map((r) => ({ month: r.month, label: Periods.stockLabel(r.month), toOrder: Number(r.n) || 0 }));
}

module.exports = {
  present,
  loadLine,
  months,
  list,
  items,
  create,
  update,
  remove,
  applyCount,
  planOrder,
  markOrdered,
  toOrderMonths,
};
