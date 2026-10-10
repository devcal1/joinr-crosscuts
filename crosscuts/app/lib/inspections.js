// Client inspections (two-pac jobs). See docs/plans/m3-contracts.md section 2.
// SCAFFOLD (M3 · 2.2): stubs only; Wave 1 B implements them.
const { HttpError } = require("./httperror");

const STATUSES = ["booked", "done", "cancelled"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function present(row) {
  return notBuilt();
}

function listForJob(db, jobId) {
  return notBuilt();
}

function create(db, jobId, { date, time, host, notes } = {}, req) {
  return notBuilt();
}

function update(db, id, patch, req) {
  return notBuilt();
}

function cancel(db, id, req) {
  return notBuilt();
}

function upcoming(db, from, to) {
  return notBuilt();
}

module.exports = { STATUSES, TIME_RE, present, listForJob, create, update, cancel, upcoming };
