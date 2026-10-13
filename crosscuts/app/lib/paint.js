// Paint orders (docs/plans/m11-contracts.md section 6.3): the paint list, paint orders and their
// lines, the job lines that become order lines on their jobs (Decision 6), and the litres factor.
// SCAFFOLD STUB (M11 · 2.2): the signatures are binding; every function throws
// HttpError(501, "Not built") until Wave 1 C replaces this file.
//
// Order line statuses change only through lib/orders.js with {via: "paint"} (section 5.2). Every
// function takes db first and nothing here requires ../db. Every write runs in one db.transaction
// with its audit row.
const { HttpError } = require("./httperror");
const { sydneyToday } = require("./time");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function items(db, { all = false } = {}) { return notBuilt(); }                    // [item]
function createItem(db, req, body) { return notBuilt(); }                          // item
function updateItem(db, req, id, body) { return notBuilt(); }                      // item
function reorderItems(db, req, ids) { return notBuilt(); }                         // [item]

function list(db, { status } = {}) { return notBuilt(); }                          // [paintOrder]
function create(db, req, body, today = sydneyToday()) { return notBuilt(); }       // paintOrder (draft)
function get(db, id) { return notBuilt(); }                                        // paintOrder with lines
function update(db, req, id, body) { return notBuilt(); }                          // paintOrder
function ordered(db, req, id, body, today = sydneyToday()) { return notBuilt(); }  // paintOrder
function undoOrdered(db, req, id) { return notBuilt(); }                           // paintOrder
// {receivedDate?, deliveryNote?} or {undo: true}.
function received(db, req, id, body, today = sydneyToday()) { return notBuilt(); } // paintOrder
function cancel(db, req, id) { return notBuilt(); }                                // paintOrder

function getSettings(db) { return notBuilt(); }                                    // {litresPerKg}
function saveSettings(db, req, body) { return notBuilt(); }                        // {litresPerKg}

module.exports = {
  items,
  createItem,
  updateItem,
  reorderItems,
  list,
  create,
  get,
  update,
  ordered,
  undoOrdered,
  received,
  cancel,
  getSettings,
  saveSettings,
};
