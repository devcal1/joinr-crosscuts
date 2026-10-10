// WAVE 0 NO-OP. T4 implements this; the signature is fixed by
// docs/plans/m1-contracts.md ("Audit"):
//   log(req, { action, entityType, entityId, before, after, actorId, actorLabel })
// The real version never throws.
function log(req, entry) {}

module.exports = { log };
