// Supplier order lines: /api/job-records/:id/orders and /api/orders. Wave 1 B.
// See docs/plans/m3-contracts.md section 4. SCAFFOLD (M3 · 2.2): no routes yet.
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api");

module.exports = r.router;
