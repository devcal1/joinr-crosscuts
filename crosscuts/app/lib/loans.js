// Loans (docs/plans/m13-contracts.md section 6): each loan's opening balance, rate history and
// repayments; the balance always calculated, interest worked out once a month, the statement.
// SCAFFOLD STUB (M13 · 2.2): the signatures are binding; every function throws
// HttpError(501, "Not built") until Wave 1 D replaces this file.
//
// Every function takes db first and nothing here requires ../db. Every write runs in one
// db.transaction with its audit row (entity type loan only, section 3.6).
const { HttpError } = require("./httperror");
const { sydneyToday } = require("./time");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function list(db, { archived = false } = {}, today = sydneyToday()) { return notBuilt(); }  // {loans}
function get(db, id, today = sydneyToday()) { return notBuilt(); }  // loan with rates and repayments (404)
function create(db, req, body) { return notBuilt(); }               // loan
function update(db, req, id, body) { return notBuilt(); }           // loan
function addRate(db, req, id, body) { return notBuilt(); }          // loan
function updateRate(db, req, id, rateId, body) { return notBuilt(); }   // loan
function deleteRate(db, req, id, rateId) { return notBuilt(); }     // loan
function addRepayment(db, req, id, body) { return notBuilt(); }     // loan
function updateRepayment(db, req, id, repId, body) { return notBuilt(); }  // loan
function deleteRepayment(db, req, id, repId) { return notBuilt(); } // loan
function interest(db, id, { date, repaymentId } = {}) { return notBuilt(); }  // section 6.2
function statement(db, id, { from, to } = {}) { return notBuilt(); }          // section 8.2

module.exports = {
  list,
  get,
  create,
  update,
  addRate,
  updateRate,
  deleteRate,
  addRepayment,
  updateRepayment,
  deleteRepayment,
  interest,
  statement,
};
