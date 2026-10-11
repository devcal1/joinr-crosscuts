// The planner reminder sweep (docs/plans/m7-contracts.md section 10). SCAFFOLD STUB (M7 · 2.2):
// startReminders is a no-op that never throws (server.js calls it after listen); fireAt, runSweep
// and runNow throw HttpError(501, "Not built"), so POST /api/planner/reminders/run answers 501
// until Wave 1 A replaces this file. Never requires ../../db: every function takes db first.
const { HttpError } = require("../httperror");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function fireAt(occ, reminder) { return notBuilt(); }              // Date | null (pure; uses sydneyInstant)
function runSweep(db, { from, to } = {}) { return notBuilt(); }    // {sent}; from/to are Dates; one transaction
function runNow(db, { at, windowMinutes } = {}) { return notBuilt(); } // {sent, from, to} (ISO strings)

// Started once by server.js after listen (PLANNER_REMINDER_DISABLED=1 turns it off). Not built yet.
function startReminders(db) {}

module.exports = { fireAt, runSweep, runNow, startReminders };
