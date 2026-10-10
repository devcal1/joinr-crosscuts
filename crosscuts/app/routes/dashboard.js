// Stub router owned by T5 (see docs/plans/m1-contracts.md, "Server composition").
// Mounted by server.js at /api/dashboard. Register routes with defineRoutes, e.g.
//   r.get("/thing", "some.key", (req, res) => { ... });
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/dashboard");

module.exports = r.router;
