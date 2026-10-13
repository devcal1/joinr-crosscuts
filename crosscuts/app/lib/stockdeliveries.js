// Stock and paint deliveries for the Deliveries page (docs/plans/m11-contracts.md section 9): the
// monthly stock order's supplier groups, paint orders and drawer stock rows that are ordered and
// not yet received, and those received in the last 14 days. lib/orders.js deliveries() adds this
// as `stock` and adds its counts to its own. Wave 1 B.
//
// Read only; takes db first and nothing here requires ../db. The receive actions are each owner's
// own routes (section 9): stock groups in lib/stock.js, paint orders in lib/paint.js, the drawer
// stock row in lib/drawers.js.
const { sydneyToday, addDays } = require("./time");
const Periods = require("../public/periods");
const Drawers = require("../public/drawers");

function person(id, name) {
  return id == null ? null : { id, name: name || null };
}

function brandLabel(id) {
  const b = Drawers.brand(id);
  return b ? b.label : String(id || "").toUpperCase();
}

// A placed drawer order's stock row has something in it (grid_json.stock, section 4.3).
function hasStock(gridJson) {
  try {
    const g = JSON.parse(gridJson);
    return Array.isArray(g && g.stock) && g.stock.some((c) => c && c.qty > 0);
  } catch (_) {
    return false;
  }
}

// Every entry, waiting or received, as section 9's object (received ones add receivedDate and
// receivedBy). Each source row carries the same column names.
function entry(type, r, today) {
  const out = {
    type,
    id: r.id,
    label: r.label,
    supplier: r.supplier,
    orderedDate: r.ordered_date || null,
    expectedDate: r.expected_date || null,
    overdue: !r.received_date && !!r.expected_date && r.expected_date < today,
    deliveryNote: r.delivery_note || "",
    link: r.link,
  };
  if (r.received_date) {
    out.receivedDate = r.received_date;
    out.receivedBy = person(r.received_by, r.received_by_name);
  }
  return out;
}

// The entries for every stock group, paint order and drawer stock row that is ordered (waiting,
// received_date null) or received on or after `since`.
function rows(db, since, today) {
  const out = [];
  const groups = db
    .prepare(
      `SELECT o.period, g.supplier, g.ordered_date, g.expected_date, g.received_date, g.received_by,
              g.delivery_note, u.display_name AS received_by_name
         FROM stock_order_groups g
         JOIN stock_orders o ON o.id = g.stock_order_id
         LEFT JOIN users u ON u.id = g.received_by
        WHERE g.received_date IS NULL OR g.received_date >= ?`
    )
    .all(since);
  for (const g of groups) {
    const id = `${g.period}:${g.supplier}`;
    const label = `Stock order ${Periods.longLabel(g.period)}`;
    out.push(entry("stock", { ...g, id, label, link: `/stock.html?period=${g.period}` }, today));
  }
  const paints = db
    .prepare(
      `SELECT p.id, p.supplier, p.ordered_date, p.expected_date, p.received_date, p.received_by, p.delivery_note,
              u.display_name AS received_by_name
         FROM paint_orders p
         LEFT JOIN users u ON u.id = p.received_by
        WHERE p.status = 'ordered' OR (p.status = 'received' AND p.received_date >= ?)`
    )
    .all(since);
  for (const p of paints) {
    out.push(entry("paint", { ...p, label: `Paint order ${p.id}`, link: `/paint.html?id=${p.id}` }, today));
  }
  const drawers = db
    .prepare(
      `SELECT d.id, d.brand, d.supplier, d.ordered_date, d.expected_date, d.grid_json,
              d.stock_received_date AS received_date, d.stock_received_by AS received_by,
              d.stock_delivery_note AS delivery_note, u.display_name AS received_by_name
         FROM drawer_orders d
         LEFT JOIN users u ON u.id = d.stock_received_by
        WHERE d.stock_received_date IS NULL OR d.stock_received_date >= ?`
    )
    .all(since);
  for (const d of drawers) {
    if (!hasStock(d.grid_json)) continue;
    const label = `Drawer stock (${brandLabel(d.brand)})`;
    out.push(entry("drawer_stock", { ...d, label, link: `/drawers.html?placed=${d.id}` }, today));
  }
  return out;
}

function stockDeliveries(db, today = sydneyToday()) {
  const all = rows(db, addDays(today, -13), today);
  const items = all
    .filter((e) => !e.receivedDate)
    .sort(
      (a, b) =>
        (a.expectedDate === null) - (b.expectedDate === null) ||
        (a.expectedDate || "").localeCompare(b.expectedDate || "") ||
        a.label.localeCompare(b.label) ||
        String(a.id).localeCompare(String(b.id))
    );
  const recent = all
    .filter((e) => e.receivedDate)
    .sort((a, b) => b.receivedDate.localeCompare(a.receivedDate) || a.label.localeCompare(b.label));
  return {
    items,
    recent,
    counts: {
      today: items.filter((e) => e.expectedDate === today).length,
      overdue: items.filter((e) => e.overdue).length,
    },
  };
}

module.exports = { stockDeliveries };
