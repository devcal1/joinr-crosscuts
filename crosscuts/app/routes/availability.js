// Leave and availability. Wave 1 B. See docs/plans/m5-contracts.md section 3.
// Scaffold (M5 · 2.2): an empty guarded router.
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/availability");

module.exports = r.router;
