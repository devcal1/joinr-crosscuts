// Business details and invoice numbering settings. Wave 1 B.
// See docs/plans/m2-contracts.md section 4. SCAFFOLD (M2 · 2.2): no routes yet.
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/settings");

module.exports = r.router;
