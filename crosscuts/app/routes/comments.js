// Comments on tasks and jobs, and follows. Wave 1 A.
// See docs/plans/m4-contracts.md section 4. Scaffold (M4 · 2.2): an empty guarded router.
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/comments");

module.exports = r.router;
