// Dashboard summary endpoints. Mounted by server.js at /api/dashboard.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { sydneyMonday } = require("../lib/time");

const r = defineRoutes("/api/dashboard");

// One-line board summary for the home page: how many rows are on each panel
// of the current Sydney week, plus how many jobs are waiting in the backlog.
r.get("/week", "board.view", (req, res) => {
  const weekStart = sydneyMonday();
  const counts = db
    .prepare("SELECT panel, COUNT(*) AS n FROM week_rows WHERE week_start = ? GROUP BY panel")
    .all(weekStart);
  const byPanel = Object.fromEntries(counts.map((c) => [c.panel, c.n]));
  const backlog = db.prepare("SELECT COUNT(*) AS n FROM backlog").get().n;
  res.json({
    weekStart,
    manufacturing: byPanel.manufacturing || 0,
    installing: byPanel.installing || 0,
    backlog,
  });
});

module.exports = r.router;
