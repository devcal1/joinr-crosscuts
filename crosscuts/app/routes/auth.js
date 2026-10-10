// Stub router owned by T1 (see docs/plans/m1-contracts.md, "Server composition").
// Mounted by server.js at /api/auth. Register routes with defineRoutes, e.g.
//   r.get("/thing", "some.key", (req, res) => { ... });
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/auth");

module.exports = r.router;
