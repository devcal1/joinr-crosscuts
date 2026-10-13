// Drawers (docs/plans/m11-contracts.md sections 4 and 6.1): a job's drawer lines and their grids,
// filling them from Joinr, the Drawer order page (totals, stock row, placing and undoing), the
// drawer name list and the two supplier settings. SCAFFOLD STUB (M11 · 2.2): the signatures are
// binding; every function throws HttpError(501, "Not built") until Wave 1 A replaces this file,
// except summary(), which answers zeros so the dashboard summary (lib/stock.js) works meanwhile.
//
// Every function takes db first and nothing here requires ../db. Sizes come from ../public/drawers.
// Order line statuses change only through lib/orders.js with {via: "drawers"} (section 5.2). Every
// write runs in one db.transaction with its audit row.
const { HttpError } = require("./httperror");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

// Called by lib/intake.js accept() and link() inside their transactions, after the job is written,
// only when the payload's drawers is an array (section 4.5). Returns {created: [orderId], unmapped: [name]}.
function fillFromJoinr(db, jobId, payloadDrawers, req, { quoteNumber } = {}) { return notBuilt(); }

// GET /api/job-records/:id/drawers: {lines, joinr}.
function forJob(db, user, jobId) { return notBuilt(); }
// POST /api/job-records/:id/drawers: {brand, counts, notes?, expectedDate?, checked?} -> {order, job}.
function createForJob(db, req, jobId, body) { return notBuilt(); }
// PUT /api/orders/:id/drawers: {counts, notes?, checked?} -> {order, job}.
function updateGrid(db, req, orderId, body) { return notBuilt(); }
// POST /api/orders/:id/drawers/check: {checked} -> {order, job}.
function setChecked(db, req, orderId, checked) { return notBuilt(); }
// POST /api/orders/:id/drawers/refill -> {order, job}.
function refill(db, req, orderId) { return notBuilt(); }

// GET /api/drawers?brand=: {brand, supplier, rows, waiting, stock, totals, total}.
function board(db, brand) { return notBuilt(); }
// PUT /api/drawers/stock: {brand, counts} -> the board.
function saveStock(db, req, brand, counts) { return notBuilt(); }
// POST /api/drawers/place: {brand, orderedDate?, expectedDate?, orderIds} -> {drawerOrder}.
function place(db, req, body) { return notBuilt(); }
function placedList(db, brand) { return notBuilt(); }                          // [drawerOrder]
function placedGet(db, id) { return notBuilt(); }                              // drawerOrder with grid
function undoPlaced(db, req, id) { return notBuilt(); }                        // {undone: true}
// POST /api/drawers/placed/:id/stock-received: {receivedDate?, deliveryNote?} or {undo: true}.
function stockReceived(db, req, id, body) { return notBuilt(); }               // drawerOrder

function names(db) { return notBuilt(); }                                      // [name]
function addName(db, req, body) { return notBuilt(); }                         // name
function updateName(db, req, id, body) { return notBuilt(); }                  // name
function removeName(db, req, id) { return notBuilt(); }                        // {removed: true}
function unmapped(db) { return notBuilt(); }                                   // [{name, section, qty, jobId, jobName}]

function getSettings(db) { return notBuilt(); }                                // {supplierEdge, supplierDtc}
function saveSettings(db, req, body) { return notBuilt(); }                    // {supplierEdge, supplierDtc}

// For the dashboard (section 11.8): drawer lines to order (checked) and waiting for a check.
function summary(db) { // eslint-disable-line no-unused-vars
  return { toOrder: 0, waiting: 0 };
}

module.exports = {
  fillFromJoinr,
  forJob,
  createForJob,
  updateGrid,
  setChecked,
  refill,
  board,
  saveStock,
  place,
  placedList,
  placedGet,
  undoPlaced,
  stockReceived,
  names,
  addName,
  updateName,
  removeName,
  unmapped,
  getSettings,
  saveSettings,
  summary,
};
