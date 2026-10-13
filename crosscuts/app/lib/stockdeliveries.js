// Stock and paint deliveries for the Deliveries page (docs/plans/m11-contracts.md section 9): the
// monthly stock order's supplier groups, paint orders and drawer stock rows that are ordered and
// not yet received, and those received in the last 14 days. lib/orders.js deliveries() adds this
// as `stock` and adds its counts to its own.
//
// SCAFFOLD STUB (M11 · 2.2): the signature is binding. Until Wave 1 B replaces this file it answers
// an empty list (not 501), so the Deliveries page and the M10 smoke keep working meanwhile.
const { sydneyToday } = require("./time");

function stockDeliveries(db, today = sydneyToday()) { // eslint-disable-line no-unused-vars
  return { items: [], recent: [], counts: { today: 0, overdue: 0 } };
}

module.exports = { stockDeliveries };
