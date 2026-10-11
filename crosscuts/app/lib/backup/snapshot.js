// The snapshot (docs/plans/backup-contracts.md section 5).
//
// takeSnapshot runs one snapshot, then retention, then the pre-migration wraps, and returns an
// outcome {status, reason, exitCode, detail}. It never throws, never writes backup_runs, raises
// no bell and decides nothing about when to run: the service (index.js) does all of that.
// `db` is passed in; nothing here requires the database at load.
//
// Steps (each failure stops the run with the reason in brackets):
//   1. 7-Zip resolved (no_7zip); the passphrase file is set (no_passphrase / passphrase_unusable).
//   2. ARCHIVES_DIR made; STAGING_DIR emptied and made (mode 700), with snap/ inside.
//   3. Free space >= 3 x (photos.db + photos.db-wal) + 256 MB (no_space; nothing pruned).
//   4. VACUUM INTO staging/snap/photos.db (copy_failed).
//   5. A fresh connection to the copy: journal_mode DELETE, integrity_check ok (check_failed),
//      schema_migrations count equal to the live one (migrations_mismatch); the counts.
//   6. sha256 of the copy.  7. config/ (manifest.js configFileOk), mode 600.
//   8. MANIFEST.txt and README-restore.txt.
//   9. 7z create into STAGING_DIR/<name>, level 5 (archive_failed).
//  10. 7z test with the passphrase (test_failed: kept as ARCHIVES_DIR/<name>.unverified).
//  11. fsync, rename into ARCHIVES_DIR/<name>, fsync the folder.
//  12. Retention (retention.js): detail.pruned.  13. Pre-migration wraps (section 5.5).
//  14. finally: STAGING_DIR emptied (no plaintext copy or config copy outlives the run).
// The signal (or a ToolAbortError) gives 'timeout'; anything unexpected gives 'other', logged
// with a safe code only.
//
// A deadline that falls during the pre-migration wraps (step 13) doesn't undo the snapshot,
// which is already kept: the wrap in progress counts in premigrateFailed (retried next time),
// the rest wait for the next snapshot, and the outcome is still 'succeeded'.
//
// listArchives() (for the service's status, section 9) returns:
//   { archives: [{ name, kind: 'nightly'|'manual'|'premigrate', bytes, made, migration }],
//     archiveBytes, unverified }
// - archives: every verified archive in ARCHIVES_DIR (a regular file whose name passes
//   names.parseArchiveName), newest first by compareArchiveNames, NOT truncated (the status
//   shows the newest 10 and counts the rest);
// - made: the instant in the name as a UTC ISO string (toISOString);
// - migration: the NNN of a pre-migration wrap as a number, else null;
// - archiveBytes: the sum of bytes over `archives`;
// - unverified: the count of regular *.unverified files set aside.
// It never throws: an unreadable folder lists nothing.
const fs = require("fs");
const path = require("path");
const { DB_DIR, CONFIG_DIR, ARCHIVES_DIR, STAGING_DIR, BACKUPS_DIR, SPACE_FACTOR, SPACE_FLOOR_BYTES } = require("./constants");
const { SEVEN_ZIP, ToolMissingError, ToolAbortError, safeErrorCode } = require("./tools");
const secrets = require("./secrets");
const archive = require("./archive");
const names = require("./names");
const manifest = require("./manifest");
const retention = require("./retention");

const LIVE_DB = "photos.db";
const ARCHIVE_LEVEL = 5;

// Thrown inside the run only; turned into an outcome before takeSnapshot returns.
class Stop extends Error {
  constructor(reason, exitCode = null, detail = {}) {
    super(reason);
    this.name = "SnapshotStop";
    this.reason = reason;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

function appVersion() {
  try {
    const v = require("../../package.json").version;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw new Stop("timeout");
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function ms(since) {
  return Math.max(0, Math.round(Date.now() - since));
}

function emptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// Empties STAGING_DIR (keeping the folder). Never throws.
function clearStaging() {
  try {
    for (const entry of fs.readdirSync(STAGING_DIR)) emptyDir(path.join(STAGING_DIR, entry));
  } catch (e) {
    if (e && e.code !== "ENOENT") console.error(`[backup] snapshot: staging not emptied (${safeErrorCode(e)})`);
  }
}

function fsyncFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r+");
    fs.fsyncSync(fd);
  } catch {
    // fsync is best effort (Windows can't fsync some handles)
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // gone either way
      }
    }
  }
}

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // directories can't be opened or fsynced on Windows: ignored
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // gone either way
      }
    }
  }
}

function openDatabase(file, readonly) {
  const Database = require("better-sqlite3");
  return readonly ? new Database(file, { readonly: true, fileMustExist: true }) : new Database(file);
}

function closeQuietly(conn) {
  if (!conn) return;
  try {
    conn.close();
  } catch {
    // already closed
  }
}

function sqlString(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

// Copies the archivable config files into <folder>/config (mode 600). Returns the names copied.
function copyConfig(folder) {
  const out = path.join(folder, manifest.CONFIG_FOLDER);
  const copied = [];
  let entries;
  try {
    entries = fs.readdirSync(CONFIG_DIR);
  } catch (e) {
    if (e && e.code === "ENOENT") return copied;
    throw e;
  }
  for (const name of entries.sort()) {
    if (!manifest.configNameOk(name)) continue;
    let st;
    try {
      st = fs.lstatSync(path.join(CONFIG_DIR, name));
    } catch {
      continue;
    }
    if (!manifest.configFileOk(name, st)) continue;
    if (copied.length === 0) fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    const dest = path.join(out, name);
    fs.copyFileSync(path.join(CONFIG_DIR, name), dest, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dest, 0o600);
    copied.push(name);
  }
  return copied;
}

// 7z create, then 7z test, then rename into ARCHIVES_DIR (steps 9-11). Returns the timings and
// the archive's size; throws Stop (archive_failed / test_failed / no_7zip / timeout).
async function packAndKeep({ folder, entries, name, passphrase, signal }) {
  const staged = path.join(STAGING_DIR, name);
  const kept = path.join(ARCHIVES_DIR, name);
  const started = Date.now();
  let made;
  try {
    made = await archive.create({ archive: staged, cwd: folder, entries, passphrase, level: ARCHIVE_LEVEL, signal });
  } catch (e) {
    throw toolStop(e);
  }
  if (made.code !== 0) throw new Stop("archive_failed", made.code, { archive: name });
  checkAbort(signal);
  let tested;
  try {
    tested = await archive.test({ archive: staged, passphrase, signal });
  } catch (e) {
    throw toolStop(e);
  }
  if (tested.code !== 0) {
    try {
      fs.renameSync(staged, `${kept}${retention.UNVERIFIED_SUFFIX}`);
    } catch (e) {
      console.error(`[backup] snapshot: unverified archive not set aside (${safeErrorCode(e)})`);
    }
    throw new Stop("test_failed", tested.code, { archive: name });
  }
  checkAbort(signal);
  fsyncFile(staged);
  fs.renameSync(staged, kept);
  fsyncDir(ARCHIVES_DIR);
  return { archiveMs: ms(started), archiveBytes: sizeOf(kept) };
}

function toolStop(e) {
  if (e instanceof Stop) return e;
  if (e instanceof ToolAbortError) return new Stop("timeout");
  if (e instanceof ToolMissingError) return new Stop("no_7zip");
  return e;
}

// The manifest and readme into `folder`.
function writeTexts(folder, fields) {
  fs.writeFileSync(path.join(folder, manifest.MANIFEST_NAME), manifest.manifestText(fields), { mode: 0o600 });
  fs.writeFileSync(path.join(folder, manifest.README_NAME), manifest.readmeText(), { mode: 0o600 });
}

function entriesFor(dbFile, configFiles) {
  const entries = [dbFile, manifest.MANIFEST_NAME, manifest.README_NAME];
  if (configFiles.length > 0) entries.push(manifest.CONFIG_FOLDER);
  return entries;
}

// ---- retention (step 12) ------------------------------------------------------------------------
function prune(now) {
  let list;
  try {
    list = fs.readdirSync(ARCHIVES_DIR);
  } catch (e) {
    console.error(`[backup] snapshot: retention skipped (${safeErrorCode(e)})`);
    return 0;
  }
  const { remove } = retention.retain(list, now);
  const doomed = remove.concat(retention.pruneUnverified(list));
  let pruned = 0;
  for (const name of doomed) {
    const file = path.join(ARCHIVES_DIR, name);
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      fs.unlinkSync(file);
      pruned += 1;
    } catch (e) {
      console.error(`[backup] snapshot: an old archive was not removed (${safeErrorCode(e)})`);
    }
  }
  return pruned;
}

// ---- pre-migration wraps (step 13, section 5.5) -------------------------------------------------
function pendingWraps() {
  let list;
  try {
    list = fs.readdirSync(BACKUPS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const source of list.sort()) {
    const wrap = names.premigrateArchiveName(source);
    if (!wrap) continue;
    try {
      if (!fs.lstatSync(path.join(BACKUPS_DIR, source)).isFile()) continue;
    } catch {
      continue;
    }
    if (fs.existsSync(path.join(ARCHIVES_DIR, wrap))) continue;
    out.push({ source, wrap });
  }
  return out;
}

async function wrapOne({ source, wrap }, passphrase, signal) {
  const sourcePath = path.join(BACKUPS_DIR, source);
  const folder = path.join(STAGING_DIR, `wrap-${wrap.replace(/\.7z$/, "")}`);
  emptyDir(folder);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  try {
    // integrity_check on a read-only connection to the source, which is never moved or changed.
    let conn;
    let facts;
    try {
      conn = openDatabase(sourcePath, true);
      const ok = conn.pragma("integrity_check", { simple: true });
      if (ok !== "ok") throw new Stop("check_failed");
      facts = manifest.dbFacts(conn);
    } finally {
      closeQuietly(conn);
    }
    checkAbort(signal);
    const copy = path.join(folder, source);
    fs.copyFileSync(sourcePath, copy, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(copy, 0o600);
    const sha = await manifest.sha256File(copy);
    const configFiles = copyConfig(folder);
    const instant = names.parseArchiveName(wrap).instant;
    writeTexts(folder, {
      kind: "premigrate",
      made: names.sydneyStamp(instant).iso,
      appVersion: appVersion(),
      databaseFile: source,
      databaseBytes: sizeOf(copy),
      databaseSha256: sha,
      migrationCount: facts.migrationCount,
      migrationHighest: facts.migrationHighest,
      counts: facts.counts,
      configFiles,
    });
    checkAbort(signal);
    await packAndKeep({ folder, entries: entriesFor(source, configFiles), name: wrap, passphrase, signal });
  } finally {
    try {
      emptyDir(folder);
    } catch {
      // the finally of takeSnapshot empties the staging folder again
    }
  }
}

async function wrapAll(passphrase, signal) {
  let wrapped = 0;
  let failed = 0;
  const todo = pendingWraps();
  for (let i = 0; i < todo.length; i++) {
    if (signal && signal.aborted) {
      failed += todo.length - i;
      break;
    }
    try {
      await wrapOne(todo[i], passphrase, signal);
      wrapped += 1;
    } catch (e) {
      failed += 1;
      const why = e instanceof Stop ? e.reason : safeErrorCode(e);
      console.error(`[backup] snapshot: pre-migration wrap failed (${why})`);
    }
  }
  return { premigrateWrapped: wrapped, premigrateFailed: failed };
}

// ---- the snapshot ---------------------------------------------------------------------------
async function run(db, { trigger, signal, now }, detail) {
  // 1. The tools and the passphrase.
  if (SEVEN_ZIP === null) throw new Stop("no_7zip");
  const pp = secrets.readPassphrase();
  if (pp.state === "missing") throw new Stop("no_passphrase");
  if (pp.state !== "set" || typeof pp.value !== "string") throw new Stop("passphrase_unusable");
  const passphrase = pp.value;
  checkAbort(signal);

  // 2. The folders.
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
  emptyDir(STAGING_DIR);
  fs.mkdirSync(STAGING_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(STAGING_DIR, 0o700);
  } catch {
    // Windows: modes don't apply
  }
  const snap = path.join(STAGING_DIR, "snap");
  fs.mkdirSync(snap, { mode: 0o700 });

  // 3. Space.
  const live = path.join(DB_DIR, LIVE_DB);
  const needBytes = SPACE_FACTOR * (sizeOf(live) + sizeOf(`${live}-wal`)) + SPACE_FLOOR_BYTES;
  const st = fs.statfsSync(DB_DIR);
  const freeBytes = Number(st.bavail) * Number(st.bsize);
  if (!(freeBytes >= needBytes)) throw new Stop("no_space", null, { needBytes, freeBytes });
  checkAbort(signal);

  const name = names.dbArchiveName(now, trigger === "manual");
  if (fs.existsSync(path.join(ARCHIVES_DIR, name))) throw new Stop("other", null, { archive: name });

  // 4. VACUUM INTO (blocks the event loop for its duration: plan trap 6).
  const copy = path.join(snap, manifest.DB_FILE);
  let t = Date.now();
  try {
    db.exec(`VACUUM INTO ${sqlString(copy)}`);
  } catch (e) {
    console.error(`[backup] snapshot: database copy failed (${safeErrorCode(e)})`);
    throw new Stop("copy_failed");
  }
  detail.vacuumMs = ms(t);
  checkAbort(signal);

  // 5. A fresh connection to the copy.
  t = Date.now();
  let liveCount;
  try {
    liveCount = Number(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n);
  } catch (e) {
    console.error(`[backup] snapshot: live migration count unreadable (${safeErrorCode(e)})`);
    throw new Stop("migrations_mismatch");
  }
  let facts;
  let conn;
  try {
    try {
      conn = openDatabase(copy, false);
      conn.pragma("journal_mode = DELETE");
      const ok = conn.pragma("integrity_check", { simple: true });
      if (ok !== "ok") throw new Stop("check_failed");
    } catch (e) {
      if (e instanceof Stop) throw e;
      console.error(`[backup] snapshot: copy check failed (${safeErrorCode(e)})`);
      throw new Stop("check_failed");
    }
    try {
      facts = manifest.dbFacts(conn);
    } catch (e) {
      console.error(`[backup] snapshot: copy count failed (${safeErrorCode(e)})`);
      throw new Stop("check_failed");
    }
  } finally {
    closeQuietly(conn);
  }
  if (facts.migrationCount !== liveCount) throw new Stop("migrations_mismatch");
  detail.checkMs = ms(t);
  detail.counts = manifest.detailCounts(facts.counts);
  detail.migrations = facts.migrationCount;
  checkAbort(signal);

  // 6. sha256.  7. config/.  8. The texts.
  detail.dbBytes = sizeOf(copy);
  const sha = await manifest.sha256File(copy);
  const configFiles = copyConfig(snap);
  writeTexts(snap, {
    kind: trigger === "manual" ? "manual" : "nightly",
    made: names.sydneyStamp(now).iso,
    appVersion: appVersion(),
    databaseFile: manifest.DB_FILE,
    databaseBytes: detail.dbBytes,
    databaseSha256: sha,
    migrationCount: facts.migrationCount,
    migrationHighest: facts.migrationHighest,
    counts: facts.counts,
    configFiles,
  });
  checkAbort(signal);

  // 9-11. Create, test, keep.
  detail.archive = name;
  const packed = await packAndKeep({
    folder: snap,
    entries: entriesFor(manifest.DB_FILE, configFiles),
    name,
    passphrase,
    signal,
  });
  detail.archiveBytes = packed.archiveBytes;
  detail.archiveMs = packed.archiveMs;
  // The plaintext copy goes now; step 14 empties the rest.
  emptyDir(snap);

  // 12. Retention.  13. The wraps.
  detail.pruned = prune(now);
  Object.assign(detail, await wrapAll(passphrase, signal));
}

// One snapshot, then retention, then the pre-migration wraps. Never throws. `signal` is the
// service's deadline signal (SNAPSHOT_DEADLINE_MS). Returns an outcome (section 1).
async function takeSnapshot(db, { trigger, signal, now = new Date() } = {}) {
  const started = Date.now();
  const detail = {};
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  let outcome;
  try {
    await run(db, { trigger, signal, now: at }, detail);
    outcome = {
      status: "succeeded",
      reason: null,
      exitCode: null,
      detail: {
        archive: detail.archive,
        archiveBytes: detail.archiveBytes,
        dbBytes: detail.dbBytes,
        counts: detail.counts,
        migrations: detail.migrations,
        vacuumMs: detail.vacuumMs,
        checkMs: detail.checkMs,
        archiveMs: detail.archiveMs,
        durationMs: ms(started),
        pruned: detail.pruned,
        premigrateWrapped: detail.premigrateWrapped,
        premigrateFailed: detail.premigrateFailed,
      },
    };
  } catch (e) {
    let stop = toolStop(e);
    if (!(stop instanceof Stop)) {
      if (signal && signal.aborted) {
        stop = new Stop("timeout");
      } else {
        console.error(`[backup] snapshot: unexpected error (${safeErrorCode(e)})`);
        stop = new Stop("other");
      }
    }
    const kept = {};
    for (const k of ["archive", "vacuumMs", "checkMs", "dbBytes"]) if (detail[k] !== undefined) kept[k] = detail[k];
    outcome = {
      status: "failed",
      reason: stop.reason,
      exitCode: Number.isInteger(stop.exitCode) ? stop.exitCode : null,
      detail: { ...kept, ...stop.detail, durationMs: ms(started) },
    };
  } finally {
    clearStaging();
  }
  return outcome;
}

// See the top of this file for the shape. Never throws.
function listArchives() {
  const archives = [];
  let archiveBytes = 0;
  let unverified = 0;
  let list = [];
  try {
    list = fs.readdirSync(ARCHIVES_DIR);
  } catch {
    return { archives, archiveBytes, unverified };
  }
  for (const name of list) {
    let st;
    try {
      st = fs.lstatSync(path.join(ARCHIVES_DIR, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (name.endsWith(retention.UNVERIFIED_SUFFIX)) {
      unverified += 1;
      continue;
    }
    const p = names.parseArchiveName(name);
    if (!p) continue;
    const m = p.kind === "premigrate" ? names.PREMIGRATE_ARCHIVE_RE.exec(name) : null;
    archives.push({
      name,
      kind: p.kind,
      bytes: st.size,
      made: p.instant.toISOString(),
      migration: m ? Number(m[1]) : null,
    });
    archiveBytes += st.size;
  }
  archives.sort((a, b) => names.compareArchiveNames(b.name, a.name));
  return { archives, archiveBytes, unverified };
}

module.exports = { takeSnapshot, listArchives };
