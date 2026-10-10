// Migration runner. See docs/plans/m1-contracts.md ("Database").
//
// Applies every db/migrations/NNN_name.sql|.js whose version is not yet in
// schema_migrations, in numeric order (gaps are fine). Each file runs in its
// own transaction; a .js file exports up(db). Applied files are checksummed
// (sha256, line endings normalised) and an edited one stops boot.
//
// Before the FIRST pending migration, if the DB already holds user tables, a
// restorable copy is written with VACUUM INTO <dbDir>/backups/.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const FILE_RE = /^(\d{3,})_([A-Za-z0-9_]+)\.(sql|js)$/;

function checksumOf(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(text).digest("hex");
}

function listMigrations(dir) {
  const found = [];
  const seen = new Map();
  for (const f of fs.readdirSync(dir)) {
    const m = FILE_RE.exec(f);
    if (!m) continue;
    const version = parseInt(m[1], 10);
    if (seen.has(version)) {
      throw new Error(`Duplicate migration version ${version}: ${seen.get(version)} and ${f}`);
    }
    seen.set(version, f);
    found.push({ version, name: `${m[1]}_${m[2]}`, ext: m[3], file: path.join(dir, f) });
  }
  return found.sort((a, b) => a.version - b.version);
}

function utcStamp() {
  // yyyymmddThhmmss
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
}

function hasUserTables(db) {
  const n = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`
    )
    .get().n;
  return n > 0;
}

function backupBefore(db, dbDir, firstPendingVersion) {
  const dir = path.join(dbDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(
    dir,
    `photos-pre-${String(firstPendingVersion).padStart(3, "0")}-${utcStamp()}.db`
  );
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  console.log(`[migrate] backup written: ${dest}`);
  return dest;
}

function migrate(db, opts = {}) {
  const dbDir = opts.dbDir || require("../lib/config").DB_DIR;
  const dir = opts.migrationsDir || MIGRATIONS_DIR;

  // schema_migrations is created AFTER the pre-migration backup, so a backup
  // of a pre-Crosscuts database is exactly what the old app wrote.
  const hasLedger =
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get().n > 0;
  const applied = new Map(
    hasLedger
      ? db.prepare("SELECT version, name, checksum FROM schema_migrations").all().map((r) => [r.version, r])
      : []
  );
  const all = listMigrations(dir);

  // Edited-after-apply check first, so nothing at all runs against a tampered set.
  for (const mig of all) {
    mig.checksum = checksumOf(mig.file);
    const prior = applied.get(mig.version);
    if (prior && prior.checksum !== mig.checksum) {
      throw new Error(
        `Migration ${mig.name} was edited after it was applied (checksum mismatch). ` +
          `Refusing to boot; add a new migration instead of changing an applied one.`
      );
    }
  }

  const pending = all.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    console.log(`[migrate] up to date (${all.length} migration(s) applied)`);
    return [];
  }

  if (hasUserTables(db)) backupBefore(db, dbDir, pending[0].version);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)"
  );
  for (const mig of pending) {
    try {
      db.transaction(() => {
        if (mig.ext === "sql") {
          db.exec(fs.readFileSync(mig.file, "utf8"));
        } else {
          const mod = require(mig.file);
          if (typeof mod.up !== "function") throw new Error("exports no up(db)");
          mod.up(db);
        }
        insert.run(mig.version, mig.name, mig.checksum);
      })();
    } catch (e) {
      throw new Error(`Migration ${mig.name} failed and was rolled back: ${e.message}`);
    }
    console.log(`[migrate] applied ${mig.name}`);
  }
  return pending.map((m) => m.name);
}

module.exports = { migrate, listMigrations };
