// Invoices: the table, the invoice object, issue, paid, void, waive. Wave 1 A.
// See docs/plans/m2-contracts.md section 4. SCAFFOLD (M2 · 2.2): no routes yet.
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/invoices");

module.exports = r.router;
