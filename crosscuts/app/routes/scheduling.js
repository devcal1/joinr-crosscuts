// The Scheduling page's Upcoming list. Wave 1 B.
// See docs/plans/m3-contracts.md section 4.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const orders = require("../lib/orders");
const inspections = require("../lib/inspections");
const { sendError } = require("../lib/httperror");
const { sydneyToday, addDays } = require("../lib/time");

const r = defineRoutes("/api/scheduling");

// The next 14 days (today and the 13 after it), Sydney dates.
r.get("/upcoming", "scheduling.view", (req, res) => {
  try {
    const from = sydneyToday();
    const to = addDays(from, 13);
    const { materials, materialsIn } = orders.upcoming(db, from, to);
    res.json({
      from,
      to,
      inspections: inspections.upcoming(db, from, to).map((i) => ({
        id: i.id,
        jobId: i.jobId,
        jobName: i.jobName,
        date: i.date,
        time: i.time,
        host: i.host,
      })),
      materials,
      materialsIn,
    });
  } catch (e) {
    sendError(res, e, "[scheduling]");
  }
});

module.exports = r.router;
