// Invoices: event hooks, the suggested split, issuing, voiding and payment
// marks. See docs/plans/m2-contracts.md sections 2 and 3.
// SCAFFOLD (M2 · 2.2): signatures only. Wave 1 A implements this file.

function notImplemented(name) {
  const e = new Error(`invoices.${name} is not implemented yet`);
  e.status = 501;
  return e;
}

// Hooks never throw and return false until implemented.
function onScheduled(db, jobId, weekStart, req) {
  return false;
}
function onMaterialsOrdered(db, jobId, date, req) {
  return false;
}
function onCompleted(db, jobId, req) {
  return false;
}

function suggestedCents(valueCents, kind) {
  if (valueCents == null) return null;
  const deposit = Math.round(valueCents * 0.1);
  const progress = Math.round(valueCents * 0.5);
  if (kind === "deposit") return deposit;
  if (kind === "progress") return progress;
  if (kind === "final") return valueCents - deposit - progress;
  return null;
}

function standardLine(job, kind) {
  throw notImplemented("standardLine");
}
function linesFor(db, invoice) {
  throw notImplemented("linesFor");
}
function issue(db, id, req) {
  throw notImplemented("issue");
}
function voidInvoice(db, id, reason, req) {
  throw notImplemented("voidInvoice");
}
function waive(db, id, reason, req) {
  throw notImplemented("waive");
}
function markPaid(db, id, paidDate, req) {
  throw notImplemented("markPaid");
}
function unmarkPaid(db, id, req) {
  throw notImplemented("unmarkPaid");
}
function setMyob(db, id, dateOrNull, req) {
  throw notImplemented("setMyob");
}
function isOverdue(inv, today) {
  return inv.status === "issued" && !!inv.due_date && inv.due_date < today;
}

module.exports = {
  onScheduled,
  onMaterialsOrdered,
  onCompleted,
  suggestedCents,
  standardLine,
  linesFor,
  issue,
  voidInvoice,
  waive,
  markPaid,
  unmarkPaid,
  setMyob,
  isOverdue,
};
