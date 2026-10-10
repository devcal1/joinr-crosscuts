// The Friday 12:00 Sydney invoice round-up. See docs/plans/m2-contracts.md
// section 2. SCAFFOLD (M2 · 2.2): shouldRun is final; run and start are
// placeholders that Wave 1 B implements.
const { latestFridayNoon } = require("./time");

// The Friday date to run for, or null if this Friday's round-up already ran.
function shouldRun(now, lastRun) {
  const friday = latestFridayNoon(now);
  return friday === lastRun ? null : friday;
}

function run(db, { force = false, now = new Date() } = {}) {
  return { sent: 0, summary: null };
}

function start(db) {
  if (process.env.ROUNDUP_DISABLED === "1") return;
  // Wave 1 B: seed roundup.last_run on first start, then check every 60 s.
}

module.exports = { shouldRun, run, start };
