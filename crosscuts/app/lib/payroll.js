// Pay runs: people, pay runs, timesheets, suggestions, the summary, public holidays and the pay
// rules (docs/plans/m8-contracts.md section 5). SCAFFOLD STUB (M8 · 2.2): the signatures are
// binding; every function throws HttpError(501, "Not built"), which routes/payruns.js answers as 501
// until Wave 1 A replaces this file.
//
// Every function takes db first and nothing here requires ../db. All hour maths comes from
// ../public/paymaths (the one home of the daily split). Pay runs only read workers, week_rows,
// assignments, jobs and leave, with their own queries; every write runs in one db.transaction with
// its audit row.
const { HttpError } = require("./httperror");
const { sydneyToday } = require("./time");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

// The section 3 rules object, from settings.
function rules(db) { return notBuilt(); }
// fortnightStartFor(today, anchor).
function currentStart(db, today = sydneyToday()) { return notBuilt(); }

// People
function listPeople(db, { all = false } = {}) { return notBuilt(); }           // [person]
function setWorkerOnPayRun(db, req, workerId, on) { return notBuilt(); }       // person
function addPayOnly(db, req, { name } = {}) { return notBuilt(); }             // person
function updatePerson(db, req, id, body) { return notBuilt(); }                // person

// Pay runs
function listRuns(db) { return notBuilt(); }                                   // [run row], newest first
function getRun(db, id) { return notBuilt(); }                                 // run object or null
function createRun(db, req, { startDate } = {}) { return notBuilt(); }         // run object
function deleteRun(db, req, id) { return notBuilt(); }
function finalise(db, req, id) { return notBuilt(); }                          // run object
function reopen(db, req, id) { return notBuilt(); }                            // run object
function setMyob(db, req, id, entered) { return notBuilt(); }                  // run object

// Timesheets
function addTimesheet(db, req, runId, { personId, workerId } = {}) { return notBuilt(); } // timesheet
function removeTimesheet(db, req, runId, tsId) { return notBuilt(); }
function getTimesheet(db, runId, tsId) { return notBuilt(); }                  // timesheet or null
function saveTimesheet(db, req, runId, tsId, body) { return notBuilt(); }      // timesheet
function suggestionsFor(db, run, person) { return notBuilt(); }                // {date: suggestion}

// Summary
function summary(db, runId) { return notBuilt(); }                             // section 6.4

// Holidays and settings
function listHolidays(db, { from, to } = {}) { return notBuilt(); }
function addHoliday(db, req, { date, name } = {}) { return notBuilt(); }
function removeHoliday(db, req, date) { return notBuilt(); }
function getSettings(db) { return notBuilt(); }                                // section 6.6
function putSettings(db, req, body) { return notBuilt(); }                     // section 6.6

module.exports = {
  rules,
  currentStart,
  listPeople,
  setWorkerOnPayRun,
  addPayOnly,
  updatePerson,
  listRuns,
  getRun,
  createRun,
  deleteRun,
  finalise,
  reopen,
  setMyob,
  addTimesheet,
  removeTimesheet,
  getTimesheet,
  saveTimesheet,
  suggestionsFor,
  summary,
  listHolidays,
  addHoliday,
  removeHoliday,
  getSettings,
  putSettings,
};
