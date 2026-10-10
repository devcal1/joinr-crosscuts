// Supplier order lines per job, and the job's materials dates. See
// docs/plans/m3-contracts.md section 2. SCAFFOLD (M3 · 2.2): markMaterialsOrdered
// is final (the Materials ordered button calls it); the rest are stubs that
// Wave 1 B implements. B must not change markMaterialsOrdered's signature or
// return values.
const audit = require("./audit");
const invoices = require("./invoices");
const { HttpError, bad, notFound } = require("./httperror");
const { sydneyToday } = require("./time");

const STATUSES = ["to_order", "ordered", "received", "cancelled"];

function notBuilt() {
  throw new HttpError(501, "Not built");
}

// Set jobs.materials_ordered_date (the "done once" flag) and make the progress
// invoice due. Returns true if it was set now, false if it was already set.
// No job -> 404; invalid date -> 400. Moved from routes/jobs.js (M2).
// invoices.onMaterialsOrdered never throws: its failure is logged and the date
// is still saved (contracts section 11.7).
function markMaterialsOrdered(db, jobId, req, date = sydneyToday()) {
  if (!db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId)) throw notFound();
  if (!invoices.validDate(date)) throw bad("date must be a valid YYYY-MM-DD date");
  return db.transaction(() => {
    const job = db.prepare("SELECT materials_ordered_date FROM jobs WHERE id = ?").get(jobId);
    if (job.materials_ordered_date) return false;
    db.prepare("UPDATE jobs SET materials_ordered_date = ?, updated_at = ? WHERE id = ?").run(
      date,
      new Date().toISOString(),
      jobId
    );
    audit.log(req, {
      action: "job.update",
      entityType: "job",
      entityId: jobId,
      before: { materials_ordered_date: null },
      after: { materials_ordered_date: date },
    });
    invoices.onMaterialsOrdered(db, jobId, date, req);
    return true;
  })();
}

// --- Wave 1 B ---------------------------------------------------------------

function present(row, today) {
  return notBuilt();
}

function jobState(db, jobId) {
  return notBuilt();
}

function listForJob(db, jobId, { includeCancelled = false } = {}) {
  return notBuilt();
}

function list(db, { status, supplier, jobId } = {}) {
  return notBuilt();
}

function suppliers(db, q) {
  return notBuilt();
}

function createLine(db, jobId, { supplier, description, expectedDate, notes } = {}, req) {
  return notBuilt();
}

function updateLine(db, orderId, patch, req) {
  return notBuilt();
}

// Note (contracts section 11.8): a cancel by an orders.mark_ordered holder
// fires the all-ordered rule; a cancel by anyone else never does.
function cancelLine(db, orderId, req) {
  return notBuilt();
}

function refreshMaterialsIn(db, jobId, req) {
  return notBuilt();
}

function upcoming(db, from, to) {
  return notBuilt();
}

module.exports = {
  STATUSES,
  markMaterialsOrdered,
  present,
  jobState,
  listForJob,
  list,
  suppliers,
  createLine,
  updateLine,
  cancelLine,
  refreshMaterialsIn,
  upcoming,
};
