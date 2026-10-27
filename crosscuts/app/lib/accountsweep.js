// The 7:00 weekday accounts sweep (0.2.7, docs/plans/m28-contracts.md sections 1 and 3):
// - rego and insurance bells to invoices.edit holders, 30 and 7 days before expiry (lib/vehicles.js);
// - one "N invoices need follow-up" bell to invoices.edit holders when any overdue invoice has had no
//   contact within its own interval.
// Checked every minute; runs once a weekday from 7:00 Sydney (ACCOUNTS_SWEEP_DISABLED=1 turns it off).
const settings = require("./settings");
const notify = require("./notify");
const vehicles = require("./vehicles");
const followup = require("./followup");
const { sydneyParts, sydneyToday } = require("./time");

const HOUR = 7;
const LAST = "accounts.sweep_last_run";
const CHECK_MS = 60 * 1000;

function due(now, lastRun) {
  const p = sydneyParts(now);
  if (p.weekday < 1 || p.weekday > 5 || p.hour < HOUR) return null;
  return p.date === lastRun ? null : p.date;
}

// {force, today, now}. Without force it obeys due() and records the day.
function run(db, { force = false, today, now = new Date() } = {}) {
  const day = today || sydneyToday(now);
  if (!force) {
    if (!due(now, settings.get(db, LAST))) return { date: day, ran: false, vehicleBells: 0, followUp: 0, belled: 0 };
    settings.set(db, LAST, day, null, { audit: false });
  }
  const vehicleBells = vehicles.bellExpiries(db, day);
  const n = followup.needingFollowUp(db, day).length;
  let belled = 0;
  if (n > 0) {
    belled = notify.toKey(db, "invoices.edit", {
      kind: "invoice.followup",
      title: `${n} ${n === 1 ? "invoice needs" : "invoices need"} follow-up`,
      body: "Overdue with no contact within the follow-up interval.",
      link: "/accounts.html?view=overdue",
    });
  }
  return { date: day, ran: true, vehicleBells, followUp: n, belled };
}

let started = false;
function start(db) {
  if (process.env.ACCOUNTS_SWEEP_DISABLED === "1" || started) return;
  started = true;
  try {
    // A fresh install or an upgrade doesn't sweep on the day it starts (as the task reminder).
    if (settings.get(db, LAST) == null) settings.set(db, LAST, sydneyToday(), null, { audit: false });
  } catch (e) {
    console.error("[accounts] seeding the sweep's last run failed:", e && e.message ? e.message : e);
  }
  const timer = setInterval(() => {
    try {
      const out = run(db);
      if (out.ran) console.log(`[accounts] sweep for ${out.date}: ${out.vehicleBells} vehicle bell(s), ${out.followUp} to follow up`);
    } catch (e) {
      console.error("[accounts] sweep failed:", e && e.message ? e.message : e);
    }
  }, CHECK_MS);
  timer.unref();
}

module.exports = { due, run, start };
