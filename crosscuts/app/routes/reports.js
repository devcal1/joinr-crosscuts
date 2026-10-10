// The report library. Wave 1 C.
// See docs/plans/m4-contracts.md section 4. Scaffold (M4 · 2.2): an empty guarded router.
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/reports");

module.exports = r.router;
