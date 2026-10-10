// Stub router owned by T3 (see docs/plans/m1-contracts.md, "Server composition").
// Mounted by server.js at /api/job-records. Register routes with defineRoutes, e.g.
//   r.get("/thing", "some.key", (req, res) => { ... });
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/job-records");

module.exports = r.router;
