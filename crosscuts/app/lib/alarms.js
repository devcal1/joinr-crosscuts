// Alarm holders (docs/plans/m13-contracts.md section 5.2): the panel's user slots, their holders and
// codes (encrypted by lib/alarmcode.js), the alarm company, the weekly times and the leavers.
// SCAFFOLD STUB (M13 · 2.2): the signatures are binding; every function throws
// HttpError(501, "Not built") until Wave 1 C replaces this file, except summary(), which answers
// empty (section 7.2).
//
// Every function takes db first and nothing here requires ../db. Every write runs in one
// db.transaction with its audit row (entity types alarm_slot, alarm_company and alarm_times only,
// section 3.6). No alarm code ever appears in a log line, an error, an audit row or a GET answer.
const { HttpError } = require("./httperror");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function overview(db) { return notBuilt(); }                        // {slots, company, times, keyState, people}
function createSlot(db, req, body) { return notBuilt(); }           // slot
function updateSlot(db, req, id, body) { return notBuilt(); }       // slot
function removeSlot(db, req, id, body) { return notBuilt(); }       // slot
function restoreSlot(db, req, id) { return notBuilt(); }            // slot
function reveal(db, req, id) { return notBuilt(); }                 // {code}
function putCompany(db, req, body) { return notBuilt(); }           // company
function putTimes(db, req, body) { return notBuilt(); }             // times

// {leavers: [{id, slot, name}]}. The scaffold answers empty.
function summary(db) {
  return { leavers: [] };
}

module.exports = {
  overview,
  createSlot,
  updateSlot,
  removeSlot,
  restoreSlot,
  reveal,
  putCompany,
  putTimes,
  summary,
};
