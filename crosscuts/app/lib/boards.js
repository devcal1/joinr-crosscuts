// The board stocktake and its value (docs/plans/m11-contracts.md section 8): the board list and
// prices (Ordering), each month's count (the Workshop Manager), confirming the value, and the
// Stock value page for Accounts. SCAFFOLD STUB (M11 · 2.2): the signatures are binding; every
// function throws HttpError(501, "Not built") until Wave 1 B replaces this file.
//
// Prices and values reach only stock.order holders (withPrices); Accounts reads stockValue() only.
// Every function takes db first and nothing here requires ../db. Every write runs in one
// db.transaction with its audit row.
const { HttpError } = require("./httperror");
const { sydneyToday } = require("./time");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function list(db, { all = false, withPrices = false } = {}) { return notBuilt(); }      // [board]
function create(db, req, body) { return notBuilt(); }                                   // board
function update(db, req, id, body) { return notBuilt(); }                               // board
function reorder(db, req, ids) { return notBuilt(); }                                   // [board]

function counts(db, { withValues = false } = {}) { return notBuilt(); }                 // [{period, status, valueCents?}]
function count(db, period, { withPrices = false } = {}, today = sydneyToday()) { return notBuilt(); }
function saveLines(db, req, period, lines, today = sydneyToday()) { return notBuilt(); }
function counted(db, req, period, today = sydneyToday()) { return notBuilt(); }
function reopenCount(db, req, period) { return notBuilt(); }
// {adjustmentCents?, adjustmentNote?}
function value(db, req, period, body) { return notBuilt(); }
function reopen(db, req, period) { return notBuilt(); }

// GET /api/stockvalue: {months}.
function stockValue(db) { return notBuilt(); }

module.exports = { list, create, update, reorder, counts, count, saveLines, counted, reopenCount, value, reopen, stockValue };
