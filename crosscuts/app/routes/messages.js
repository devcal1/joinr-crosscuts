// Messages (chat). Wave 1 B.
// See docs/plans/m4-contracts.md section 4. Scaffold (M4 · 2.2): an empty guarded router.
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/messages");

module.exports = r.router;
