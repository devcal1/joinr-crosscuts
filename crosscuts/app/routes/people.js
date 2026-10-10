// Other users' names for pickers (the task assignee) and author labels.
// See docs/plans/m4-contracts.md section 4. Only {id, displayName}.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const people = require("../lib/people");

const r = defineRoutes("/api/people");

r.get("/", ["tasks.use", "messages.use"], (req, res) => {
  res.json({ rows: people.withKey(db, "tasks.use") });
});

module.exports = r.router;
