// The snapshot (docs/plans/backup-contracts.md section 5). SCAFFOLD STUB: Wave 1 A builds it.
//
// takeSnapshot runs one snapshot, then retention, then the pre-migration wraps, and returns an
// outcome {status, reason, exitCode, detail}. It never throws, never writes backup_runs, raises
// no bell and decides nothing about when to run: the service (index.js) does all of that.
// `db` is passed in; nothing here requires the database at load.

// Not built yet: every call is a failed outcome with reason 'other'.
async function takeSnapshot(db, { trigger, signal, now = new Date() } = {}) {
  void db;
  void trigger;
  void signal;
  void now;
  return { status: "failed", reason: "other", exitCode: null, detail: {} };
}

// Verified archives in ARCHIVES_DIR, newest first, and the count of .unverified files set aside.
// Not built yet: nothing is listed.
function listArchives() {
  return { archives: [], unverified: 0 };
}

module.exports = { takeSnapshot, listArchives };
