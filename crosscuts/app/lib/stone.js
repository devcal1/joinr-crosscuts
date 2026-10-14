// Stone orders and the benchtop sheet (docs/plans/m12-contracts.md section 4): a job's stone
// benchtop orders, each sent revision frozen, the list, the Design/PM summary, the suggestions and
// the benchtop sheet. SCAFFOLD STUB (M12 · 2.2): the signatures are binding; every function throws
// HttpError(501, "Not built") until Wave 1 A replaces this file, except summary(), which answers
// zeros so the Design/PM tile can be built against it (section 4.6).
//
// A stone order is not an order line (Decision 1): nothing here touches lib/orders.js. Every
// function takes db first and nothing here requires ../db. Every write runs in one db.transaction
// with its audit row.
const { HttpError } = require("./httperror");
const { sydneyToday } = require("./time");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function forJob(db, req, jobId) { return notBuilt(); }          // {job, orders, prefill, benchtopText}
function create(db, req, jobId, body) { return notBuilt(); }    // order with revisions
function get(db, req, id) { return notBuilt(); }                // order with revisions
function update(db, req, id, body) { return notBuilt(); }       // order with revisions
function send(db, req, id, body) { return notBuilt(); }         // order with revisions
function cancel(db, req, id) { return notBuilt(); }             // order with revisions
function restore(db, req, id) { return notBuilt(); }            // order with revisions
// {orderId, jobId, jobName, revision, sentDate, sentAt, sentBy, form}
function revision(db, req, id, rev) { return notBuilt(); }
function list(db, { status } = {}) { return notBuilt(); }       // [order] (no revisions)

function summary(db, today = sydneyToday()) {
  return { date: today, drafts: 0, changed: 0, installsSoon: 0 };
}

function suggestions(db) { return notBuilt(); }                 // {suppliers, brands}
function benchtopSheet(db, req, jobId) { return notBuilt(); }   // {job, benchtopText}
function benchtopText(db, jobId) { return notBuilt(); }         // string[]

module.exports = {
  forJob,
  create,
  get,
  update,
  send,
  cancel,
  restore,
  revision,
  list,
  summary,
  suggestions,
  benchtopSheet,
  benchtopText,
};
