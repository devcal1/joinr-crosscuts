// The copy to the NAS (docs/plans/backup-contracts.md section 6). SCAFFOLD STUB: Wave 1 B builds it.
//
// copyToNas runs one copy and returns an outcome {status, reason, exitCode, detail}. It never
// throws, never writes backup_runs, raises no bell and decides nothing about when to run: the
// service (index.js) does all of that. `db` is passed in; nothing here requires the database at
// load. `runner` is injectable for tests (default: the rsync runner).

// Not built yet: every call is a failed outcome with reason 'other' and nothing attempted.
async function copyToNas(db, { trigger, signal, now = new Date(), runner } = {}) {
  void db;
  void trigger;
  void signal;
  void now;
  void runner;
  return { status: "failed", reason: "other", exitCode: null, detail: { attempted: false } };
}

module.exports = { copyToNas };
