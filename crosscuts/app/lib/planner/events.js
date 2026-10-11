// Hand-made planner events: validation, CRUD, repeats, one-off changes, splits and audit
// (docs/plans/m7-contracts.md section 7). SCAFFOLD STUB (M7 · 2.2): the constants are final; every
// function throws HttpError(501, "Not built"), which routes/planner.js answers as 501 until Wave 1 A
// replaces this file. Nothing under lib/planner/ requires ../../db: every function takes db first.
const { HttpError } = require("../httperror");

const TITLE_MAX = 200;
const NOTES_MAX = 4000;
const SPAN_MAX_DAYS = 92;
const REMINDERS_TIMED = ["start", "min15", "hour1", "day1"];
const REMINDERS_ALL_DAY = ["morning", "day_before"];
const REMINDER_LABELS = {
  start: "At the start",
  min15: "15 minutes before",
  hour1: "1 hour before",
  day1: "1 day before",
  morning: "7:00 on the day",
  day_before: "7:00 the day before",
};

function notBuilt() {
  throw new HttpError(501, "Not built");
}

// Pure (no db): original occurrence start dates of a series row whose span overlaps [from, to].
function occurrenceDates(series, from, to) { return notBuilt(); }          // string[] ascending
function isOccurrence(series, date) { return notBuilt(); }                 // boolean (ignores exceptions)
// Pure: effective occurrences overlapping [from, to], exceptions applied, cancelled dropped.
function expand(series, exceptions, from, to) { return notBuilt(); }

// Reads. Visibility through layers.sqlFilter(user, wanted).
function listOccurrences(db, user, { from, to, layers } = {}) { return notBuilt(); }     // [occurrence item §9.2]
function listForJob(db, user, jobId, { from, to, limit } = {}) { return notBuilt(); }   // {rows, more}
function getSeries(db, user, id) { return notBuilt(); }                                // series object §9.3

// Writes (each one transaction, audited per §11.2).
function create(db, req, body) { return notBuilt(); }
function update(db, req, id, body) { return notBuilt(); }
function remove(db, req, id, { scope, occurrence, updatedAt } = {}) { return notBuilt(); }

// For the sweep: every non-removed series with a reminder, all layers, expanded over [from, to].
function occurrencesForSweep(db, { from, to } = {}) { return notBuilt(); }  // [{event, occ}]

module.exports = {
  TITLE_MAX,
  NOTES_MAX,
  SPAN_MAX_DAYS,
  REMINDERS_TIMED,
  REMINDERS_ALL_DAY,
  REMINDER_LABELS,
  occurrenceDates,
  isOccurrence,
  expand,
  listOccurrences,
  listForJob,
  getSeries,
  create,
  update,
  remove,
  occurrencesForSweep,
};
