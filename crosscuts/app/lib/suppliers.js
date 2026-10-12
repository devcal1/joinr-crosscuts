// Supplier accounts: the suppliers Accounts keep and each month's statement lines
// (docs/plans/m9-contracts.md section 7.1). SCAFFOLD STUB (M9 · 2.2): the signatures are binding;
// every function throws HttpError(501, "Not built"), which routes/suppliers.js answers as 501 until
// Wave 1 B replaces this file.
//
// Every function takes db first and nothing here requires ../db. All month arithmetic comes from
// ../public/periods. Every write runs in one db.transaction with its audit row.
const { HttpError } = require("./httperror");
const { sydneyToday } = require("./time");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function list(db, { all = false } = {}) { return notBuilt(); }                       // [supplier]
function create(db, req, { name, fromPeriod } = {}) { return notBuilt(); }           // supplier
function update(db, req, id, body) { return notBuilt(); }                            // supplier
function month(db, period, today = sydneyToday()) { return notBuilt(); }             // month object
function saveLine(db, req, period, supplierId, body) { return notBuilt(); }          // line
// Links an accepted file (lib/files accept()) to the line; the caller discards it when this throws.
function attach(db, req, period, supplierId, accepted) { return notBuilt(); }        // line
function detach(db, req, period, supplierId) { return notBuilt(); }                  // line
// How many suppliers listed in `period` are still Waiting (for the Friday round-up).
function waitingCount(db, period) { return notBuilt(); }                             // number

module.exports = { list, create, update, month, saveLine, attach, detach, waitingCount };
