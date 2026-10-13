// The monthly stock order (docs/plans/m11-contracts.md section 7): the stock list, each month's
// Have (the Workshop Manager) and Order (Ordering), the supplier groups' ordered and received dates,
// and the dashboard summary (section 11.8). SCAFFOLD STUB (M11 · 2.2): the signatures are binding;
// every function throws HttpError(501, "Not built") until Wave 1 B replaces this file.
//
// Every function takes db first and nothing here requires ../db. Month arithmetic comes from
// ../public/periods. Every write runs in one db.transaction with its audit row.
const { HttpError } = require("./httperror");
const { sydneyToday } = require("./time");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function items(db, { all = false } = {}) { return notBuilt(); }                    // [item]
function createItem(db, req, body) { return notBuilt(); }                          // item
function updateItem(db, req, id, body) { return notBuilt(); }                      // item
function reorderItems(db, req, ids) { return notBuilt(); }                         // [item]

function months(db) { return notBuilt(); }                                         // [{period, state}]
// The month view of section 7.1; a month with no record yet is its empty view (nothing written).
function month(db, period, today = sydneyToday()) { return notBuilt(); }           // month view
function saveHave(db, req, period, lines, today = sydneyToday()) { return notBuilt(); }
function counted(db, req, period, today = sydneyToday()) { return notBuilt(); }
function reopen(db, req, period) { return notBuilt(); }
function saveOrder(db, req, period, lines, today = sydneyToday()) { return notBuilt(); }
// {supplier, orderedDate?, expectedDate?} or {supplier, undo: true}.
function group(db, req, period, body, today = sydneyToday()) { return notBuilt(); }
// {supplier, receivedDate?, deliveryNote?} or {supplier, undo: true}.
function groupReceived(db, req, period, body, today = sydneyToday()) { return notBuilt(); }

// GET /api/stock/summary: only the parts the user's keys allow (section 11.8).
function summary(db, user, today = sydneyToday()) { return notBuilt(); }

module.exports = {
  items,
  createItem,
  updateItem,
  reorderItems,
  months,
  month,
  saveHave,
  counted,
  reopen,
  saveOrder,
  group,
  groupReceived,
  summary,
};
