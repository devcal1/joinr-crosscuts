// Automatic planner events, worked out on read from their source tables
// (docs/plans/m7-contracts.md section 8). SCAFFOLD STUB (M7 · 2.2): listAuto throws
// HttpError(501, "Not built"), which routes/planner.js answers as 501 until Wave 1 B replaces this
// file. Read-only queries of its own; never a source module's write path, never ../../db.
const { HttpError } = require("../httperror");

// layers: the effective layer set (visible ∩ requested). today: Sydney date.
// Returns {events: [automatic item §9.2], weeks: [week band §9.2]}.
function listAuto(db, user, { from, to, today, layers } = {}) {
  throw new HttpError(501, "Not built");
}

module.exports = { listAuto };
