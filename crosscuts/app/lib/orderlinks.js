// What an order line belongs to (docs/plans/m11-contracts.md section 5): a job's drawers
// (order_drawers) or a paint order's job line (paint_order_jobs), or nothing. lib/orders.js joins
// these into every line it reads and uses linkOf() for the refusals of section 5.2.
//
// Every function takes db first; nothing here requires ../db.

// {kind: "drawers", brand, drawerOrderId, checked} | {kind: "paint", paintOrderId} | null.
function linkOf(db, orderId) {
  const d = db
    .prepare("SELECT brand, drawer_order_id, checked_at FROM order_drawers WHERE order_id = ?")
    .get(orderId);
  if (d) {
    return { kind: "drawers", brand: d.brand, drawerOrderId: d.drawer_order_id == null ? null : d.drawer_order_id, checked: !!d.checked_at };
  }
  const p = db.prepare("SELECT paint_order_id FROM paint_order_jobs WHERE order_id = ?").get(orderId);
  if (p) return { kind: "paint", paintOrderId: p.paint_order_id };
  return null;
}

// SQL fragments for lib/orders.js's line queries (the line table is aliased `o`).
const JOIN_SQL = `LEFT JOIN order_drawers od ON od.order_id = o.id
  LEFT JOIN paint_order_jobs poj ON poj.order_id = o.id
  LEFT JOIN users uc ON uc.id = od.checked_by`;

const COLUMNS_SQL = `od.brand AS drawer_brand, od.source AS drawer_source, od.checked_at AS drawer_checked_at,
  od.checked_by AS drawer_checked_by, uc.display_name AS drawer_checked_by_name,
  od.drawer_order_id AS drawer_order_id, poj.paint_order_id AS paint_order_id`;

// The present() fields from a joined row: {kind, drawers, paintOrderId}.
function presentLink(row) {
  if (row.drawer_brand != null) {
    return {
      kind: "drawers",
      drawers: {
        brand: row.drawer_brand,
        source: row.drawer_source,
        checked:
          row.drawer_checked_at == null
            ? null
            : { at: row.drawer_checked_at, by: { id: row.drawer_checked_by, name: row.drawer_checked_by_name || null } },
        drawerOrderId: row.drawer_order_id == null ? null : row.drawer_order_id,
      },
      paintOrderId: null,
    };
  }
  if (row.paint_order_id != null) return { kind: "paint", drawers: null, paintOrderId: row.paint_order_id };
  return { kind: null, drawers: null, paintOrderId: null };
}

module.exports = { linkOf, JOIN_SQL, COLUMNS_SQL, presentLink };
