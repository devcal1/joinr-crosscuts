// The private-file ledger, backup_blobs (docs/plans/backup-contracts.md sections 2 and 6.7).
//
// One row per private file ever encrypted for the NAS: its size then, the size of its encrypted
// blob, and when a copy last sent it and last saw it on the NAS at that size. The staging blob is
// deleted after every batch, so this row is all the Umbrel keeps: a later missing or wrong-size
// blob on the NAS is simply encrypted and sent again. Rows are never deleted by the app.
//
// `db` is passed in (better-sqlite3, or the node:sqlite shim locally); nothing here requires the
// database at load. Times are ISO instants, as the migration's own defaults write them.

function iso() {
  return new Date().toISOString();
}

function names(storedNames) {
  return (Array.isArray(storedNames) ? storedNames : []).filter((n) => typeof n === "string" && n !== "");
}

const COLUMNS = "stored_name, source_bytes, blob_bytes, encrypted_at, sent_at, proven_at";

// The row, or null.
function get(db, storedName) {
  const row = db.prepare(`SELECT ${COLUMNS} FROM backup_blobs WHERE stored_name = ?`).get(storedName);
  return row || null;
}

// Every row, by stored name (one query for a whole folder's plan).
function rowsByName(db) {
  const map = new Map();
  for (const row of db.prepare(`SELECT ${COLUMNS} FROM backup_blobs`).all()) map.set(row.stored_name, row);
  return map;
}

// A fresh blob was made. A blob of a different size than the one last proven is not proven yet.
function recordEncrypted(db, storedName, sourceBytes, blobBytes) {
  db.prepare(
    `INSERT INTO backup_blobs (stored_name, source_bytes, blob_bytes, encrypted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(stored_name) DO UPDATE SET
       source_bytes = excluded.source_bytes,
       proven_at = CASE WHEN backup_blobs.blob_bytes = excluded.blob_bytes THEN backup_blobs.proven_at ELSE NULL END,
       blob_bytes = excluded.blob_bytes,
       encrypted_at = excluded.encrypted_at`
  ).run(storedName, sourceBytes, blobBytes, iso());
}

function stamp(db, column, storedNames) {
  const list = names(storedNames);
  if (list.length === 0) return;
  const at = iso();
  const stmt = db.prepare(`UPDATE backup_blobs SET ${column} = ? WHERE stored_name = ?`);
  db.transaction(() => {
    for (const n of list) stmt.run(at, n);
  })();
}

// sent_at = now: a copy handed these blobs to rsync and rsync took them (exit 0, 23 or 24).
function markSent(db, storedNames) {
  stamp(db, "sent_at", storedNames);
}

// proven_at = now: a copy saw these on the NAS at blob_bytes.
function markProven(db, storedNames) {
  stamp(db, "proven_at", storedNames);
}

// {tracked, proven}
function counts(db) {
  const row = db.prepare("SELECT COUNT(*) AS tracked, COUNT(proven_at) AS proven FROM backup_blobs").get() || {};
  return { tracked: Number(row.tracked) || 0, proven: Number(row.proven) || 0 };
}

module.exports = { get, rowsByName, recordEncrypted, markSent, markProven, counts };
