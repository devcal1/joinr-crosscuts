// The pay-run review ping (0.2.11, Todd 2026-11-01): at 2pm Sydney on the last day of a fortnight
// (its second Friday), one bell to every users.admin holder to review the pay run's hours and tick
// each sheet for accounts. Checked every minute; once per fortnight (PAYRUN_PING_DISABLED=1 turns it off).
const settings = require("./settings");
const notify = require("./notify");
const payroll = require("./payroll");
const PayMaths = require("../public/paymaths");
const { sydneyParts } = require("./time");

const HOUR = 14;
const LAST = "payrun.review_ping_last";
const CHECK_MS = 60 * 1000;

// The day to ping for, or null: the fortnight's last Friday, from 2pm, not already pinged.
function due(db, now, lastRun) {
  const p = sydneyParts(now);
  if (p.weekday !== 5 || p.hour < HOUR || p.date === lastRun) return null;
  return PayMaths.endOf(payroll.currentStart(db, p.date)) === p.date ? p.date : null;
}

// {force, now}. Without force it obeys due() and records the day.
function run(db, { force = false, now = new Date() } = {}) {
  const day = sydneyParts(now).date;
  if (!force) {
    if (!due(db, now, settings.get(db, LAST))) return { date: day, ran: false, belled: 0 };
    settings.set(db, LAST, day, null, { audit: false });
  }
  const start = payroll.currentStart(db, day);
  const pr = db.prepare("SELECT id FROM pay_runs WHERE start_date = ?").get(start);
  let body = "No pay run has been started for this fortnight yet.";
  let link = "/payruns.html";
  if (pr) {
    const c = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(admin_reviewed), 0) AS r FROM pay_timesheets WHERE pay_run_id = ?")
      .get(pr.id);
    const left = Number(c.n) - Number(c.r);
    body = left > 0 ? `${left} of ${c.n} sheets still to tick as reviewed for accounts.` : "Every sheet is ticked as reviewed.";
    link = `/payrun.html?id=${pr.id}`;
  }
  const belled = notify.toKey(db, "users.admin", {
    kind: "payrun.review",
    title: `Review the pay run for ${PayMaths.fortnightLabel(start)}`,
    body,
    link,
  });
  return { date: day, ran: true, belled };
}

let started = false;
function start(db) {
  if (process.env.PAYRUN_PING_DISABLED === "1" || started) return;
  started = true;
  try {
    // A fresh install or the upgrade itself doesn't ping on the day it starts (as the accounts sweep).
    if (settings.get(db, LAST) == null) settings.set(db, LAST, sydneyParts().date, null, { audit: false });
  } catch (e) {
    console.error("[payrun] seeding the review ping's last run failed:", e && e.message ? e.message : e);
  }
  const timer = setInterval(() => {
    try {
      const out = run(db);
      if (out.ran) console.log(`[payrun] review ping for ${out.date}: ${out.belled} bell(s)`);
    } catch (e) {
      console.error("[payrun] review ping failed:", e && e.message ? e.message : e);
    }
  }, CHECK_MS);
  timer.unref();
}

module.exports = { due, run, start };
