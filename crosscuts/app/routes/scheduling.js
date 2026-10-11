// The Scheduling page's Upcoming list. Wave 1 B.
// See docs/plans/m3-contracts.md section 4.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const orders = require("../lib/orders");
const inspections = require("../lib/inspections");
const { sendError } = require("../lib/httperror");
const { sydneyToday, sydneyMonday, addDays } = require("../lib/time");
const { buildWeek } = require("../lib/schedule");
const production = require("../lib/production");

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

// M5 Lookahead (docs/plans/m5-contracts.md section 3): the next N weeks as the board builds
// them, plus the To start backlog by promised install date. Read-only; the board's own
// /api/schedule (and its backlog order) is untouched.
const DEFAULT_WEEKS = 4;
const MAX_WEEKS = 6;
const selectToStart = db.prepare(
  `SELECT b.id, b.job_id, j.name, j.promised_install_date, j.materials_in_date, j.materials_ordered_date
   FROM backlog b JOIN jobs j ON j.id = b.job_id
   ORDER BY (NULLIF(j.promised_install_date, '') IS NULL) ASC, NULLIF(j.promised_install_date, '') ASC,
            b.sort_order ASC, b.id ASC`
);

r.get("/lookahead", "scheduling.view", (req, res) => {
  try {
    let weeks = DEFAULT_WEEKS;
    if (req.query.weeks !== undefined) {
      const raw = req.query.weeks;
      weeks = typeof raw === "string" && /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
      if (!(weeks >= 1 && weeks <= MAX_WEEKS)) {
        res.status(400).json({ error: `weeks must be a whole number from 1 to ${MAX_WEEKS}` });
        return;
      }
    }
    const first = sydneyMonday();
    const list = [];
    for (let k = 0; k < weeks; k++) list.push(buildWeek(addDays(first, 7 * k)));
    const backlog = selectToStart.all();
    const stages = production.currentStages(db, backlog.map((b) => b.job_id));
    res.json({
      weeks: list,
      toStart: backlog.map((b) => ({
        backlogId: b.id,
        jobId: b.job_id,
        name: b.name,
        promisedInstallDate: b.promised_install_date || null,
        materials: b.materials_in_date ? "in" : b.materials_ordered_date ? "ordered" : null,
        productionStage: stages.get(Number(b.job_id)) || null,
      })),
    });
  } catch (e) {
    sendError(res, e, "[scheduling]");
  }
});

module.exports = r.router;
