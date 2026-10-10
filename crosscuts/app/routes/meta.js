const { defineRoutes, listRoutes } = require("../lib/routes");

const r = defineRoutes("/api/meta");

// Every registered API route with its access rule. CI uses this to enumerate
// the routes for the logged-out sweep.
r.get("/routes", "users.admin", (req, res) => {
  res.json(listRoutes());
});

module.exports = r.router;
