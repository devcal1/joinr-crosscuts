// BAS sales by month: the financial year, a month's detail, the comparison, the CSV, hand amounts
// and lodging (docs/plans/m9-contracts.md section 5). SCAFFOLD STUB (M9 · 2.2): the signatures are
// binding; every function throws HttpError(501, "Not built"), which routes/bas.js answers as 501
// until Wave 1 A replaces this file.
//
// Cash basis (m9-plan Decision 1): a month's sales are the invoices with status 'paid' and a
// paid_date inside the month, plus the month's hand amount. Every function takes db first and
// nothing here requires ../db. All month and financial-year arithmetic comes from
// ../public/periods. BAS only reads invoices and jobs; every write (bas_months) runs in one
// db.transaction with its audit row.
const { HttpError } = require("./httperror");
const { sydneyToday } = require("./time");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function year(db, fy, today = sydneyToday()) { return notBuilt(); }              // year object
function month(db, period, today = sydneyToday()) { return notBuilt(); }         // month detail
function compare(db, today = sydneyToday()) { return notBuilt(); }               // comparison
function csv(db, period) { return notBuilt(); }                                  // CSV text (section 6.4)
function setHand(db, req, period, body) { return notBuilt(); }                   // month detail
function lodge(db, req, period, today = sydneyToday()) { return notBuilt(); }    // month detail
function reopen(db, req, period) { return notBuilt(); }                          // month detail

module.exports = { year, month, compare, csv, setHand, lodge, reopen };
