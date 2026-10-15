// Job bonuses (docs/plans/m13-contracts.md section 4): the rate and share points, one bonus per job
// with its seven checks, confirming (the figures frozen), paying each share, the summary and the
// quoted hours from Joinr. SCAFFOLD STUB (M13 · 2.2): the signatures are binding; every function
// throws HttpError(501, "Not built") until Wave 1 B replaces this file, except summary(), which
// answers empty (section 7.1).
//
// Every function takes db first and nothing here requires ../db. Every write runs in one
// db.transaction with its audit row (entity types bonus and bonus_settings only, section 3.6).
const { HttpError } = require("./httperror");
const { sydneyToday } = require("./time");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function settings(db) { return notBuilt(); }                        // {rateBp, holders, totalPoints}
function putSettings(db, req, body) { return notBuilt(); }          // settings
function people(db) { return notBuilt(); }                          // {people}
function jobs(db, req, { q } = {}) { return notBuilt(); }           // {jobs: [{id, name, stage, archived, hasBonus}]}
function list(db, { status } = {}) { return notBuilt(); }           // {bonuses: [bonus]}
function get(db, id) { return notBuilt(); }                         // bonus (404)
function create(db, req, body) { return notBuilt(); }               // bonus
function update(db, req, id, body) { return notBuilt(); }           // bonus
function fillHours(db, req, id) { return notBuilt(); }              // bonus
function confirm(db, req, id, body) { return notBuilt(); }          // bonus
function reopen(db, req, id) { return notBuilt(); }                 // bonus
function remove(db, req, id) { return notBuilt(); }                 // {ok: true}
function markPaid(db, req, id, personId, body) { return notBuilt(); }   // bonus
function markPersonPaid(db, req, personId, body) { return notBuilt(); } // summary

// Section 4.6. The scaffold answers empty.
function summary(db, today = sydneyToday()) {
  return { people: [], totals: { earnedCents: 0, paidCents: 0, owedCents: 0 }, payRuns: [] };
}

function joinrHours(db, jobId) { return notBuilt(); }               // {quotedFactoryMin, quotedInstallMin} | null

module.exports = {
  settings,
  putSettings,
  people,
  jobs,
  list,
  get,
  create,
  update,
  fillHours,
  confirm,
  reopen,
  remove,
  markPaid,
  markPersonPaid,
  summary,
  joinrHours,
};
