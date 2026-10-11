#!/usr/bin/env node
// The restore CLI (docs/plans/backup-contracts.md section 13). It runs inside the installed image
// with Crosscuts STOPPED and the data folder mounted at /data:
//
//   sudo docker run --rm --network none -it -v <app-data>/data:/data \
//     ghcr.io/devcal1/crosscuts-web:<installed version> node tools/restore.js <command> ...
//
//   list                                         the archives on this server; no passphrase
//   check <archive>                              extract to staging, check, print MANIFEST.txt
//                                                and the counts; changes nothing
//   db <archive> [--config] [--yes] [--unverified]
//                                                restore the database (and, with --config, the
//                                                config files)
//   files <folder>                               decrypt every <name>.7z in <folder> into
//                                                uploads/files/ (never overwrites)
//
// <archive> is a path, or a bare name looked up in db/backups/archives.
// The passphrase: a hidden prompt on a terminal, else one line read from standard input (CI).
// It goes to 7-Zip as -p (archive.js) and is never printed.
//
// Exit codes: 0 done; 1 failed (nothing changed, unless the message says otherwise); 2 usage;
// 3 refused (an archive from a newer Crosscuts, or the stop was not confirmed).
//
// This file must NEVER require db/index.js or server.js: opening the live database would run the
// migrations on the very file being replaced. It requires only lib/config.js,
// lib/backup/{constants,tools,archive,names,manifest}.js, db/migrate.js (listMigrations only) and
// better-sqlite3.
"use strict";
const fs = require("fs");
const path = require("path");
const { DB_DIR, UPLOADS_DIR, CONFIG_DIR } = require("../lib/config");
const { ARCHIVES_DIR, STAGING_DIR, CONFIG_MAX_BYTES } = require("../lib/backup/constants");
const { SEVEN_ZIP, ToolMissingError, safeErrorCode } = require("../lib/backup/tools");
const archive = require("../lib/backup/archive");
const names = require("../lib/backup/names");
const manifest = require("../lib/backup/manifest");
const { listMigrations } = require("../db/migrate");

const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 };
const UNVERIFIED = ".unverified";
const LIVE = "photos.db";
const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");
const IS_POSIX = typeof process.getuid === "function";

const USAGE = [
  "Usage: node tools/restore.js <command>",
  "",
  "  list                                          list the archives on this server",
  "  check <archive>                               open an archive and check it; changes nothing",
  "  db <archive> [--config] [--yes] [--unverified]",
  "                                                restore the database from an archive",
  "  files <folder>                                put the private files in <folder> back",
  "",
  "Run it with Crosscuts stopped. See docs/restore.md.",
].join("\n");

class CliError extends Error {
  constructor(message, code = EXIT.failed) {
    super(message);
    this.exitCode = code;
  }
}

function say(text) {
  process.stdout.write(`${text}\n`);
}

function warn(text) {
  process.stderr.write(`${text}\n`);
}

// ---- small helpers ------------------------------------------------------------------------------
function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
}

function human(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function openDatabase(file, readonly) {
  const Database = require("better-sqlite3");
  return readonly ? new Database(file, { readonly: true, fileMustExist: true }) : new Database(file);
}

function withDatabase(file, fn) {
  let conn;
  try {
    conn = openDatabase(file, true);
    return fn(conn);
  } finally {
    if (conn) {
      try {
        conn.close();
      } catch {
        // closed
      }
    }
  }
}

function imageHighestMigration() {
  const all = listMigrations(MIGRATIONS_DIR);
  return all.length > 0 ? all[all.length - 1].version : 0;
}

// Mode and owner to give a file put in place.
function chownLike(file, uid, gid) {
  if (!IS_POSIX || !Number.isInteger(uid) || !Number.isInteger(gid)) return;
  try {
    fs.chownSync(file, uid, gid);
  } catch (e) {
    warn(`Warning: the owner of a restored file could not be set (${safeErrorCode(e)}).`);
  }
}

// ---- standard input -----------------------------------------------------------------------------
// Lines from a non-terminal stdin, one at a time; null at the end.
const pipe = { buffer: "", ended: false, waiting: null, started: false };

function startPipe() {
  if (pipe.started) return;
  pipe.started = true;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    pipe.buffer += chunk;
    wakePipe();
  });
  process.stdin.on("end", () => {
    pipe.ended = true;
    wakePipe();
  });
  process.stdin.on("error", () => {
    pipe.ended = true;
    wakePipe();
  });
}

function wakePipe() {
  if (pipe.waiting) {
    const w = pipe.waiting;
    pipe.waiting = null;
    w();
  }
}

async function pipeLine() {
  startPipe();
  for (;;) {
    const at = pipe.buffer.indexOf("\n");
    if (at !== -1) {
      let line = pipe.buffer.slice(0, at);
      pipe.buffer = pipe.buffer.slice(at + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      return line;
    }
    if (pipe.ended) {
      if (pipe.buffer === "") return null;
      const line = pipe.buffer.endsWith("\r") ? pipe.buffer.slice(0, -1) : pipe.buffer;
      pipe.buffer = "";
      return line;
    }
    await new Promise((resolve) => {
      pipe.waiting = resolve;
    });
  }
}

// One line from the terminal in raw mode; `hidden` echoes nothing. Ctrl+C exits 130.
function ttyLine(question, hidden) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let buf = "";
    const done = (value) => {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // not a terminal any more
      }
      stdin.pause();
      process.stderr.write("\n");
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done(buf);
          return;
        }
        if (ch === "\u0003") {
          try {
            stdin.setRawMode(false);
          } catch {
            // not a terminal any more
          }
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u0004" && buf === "") {
          done(null);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length > 0) {
            const chars = [...buf];
            chars.pop();
            buf = chars.join("");
            if (!hidden) process.stderr.write("\b \b");
          }
          continue;
        }
        buf += ch;
        if (!hidden) process.stderr.write(ch);
      }
    };
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function readLine(question, hidden) {
  if (process.stdin.isTTY) return ttyLine(question, hidden);
  return pipeLine();
}

async function askPassphrase() {
  const value = await readLine("Backup passphrase (hidden): ", true);
  if (value === null || value === "") throw new CliError("No passphrase was given. Nothing was changed.");
  return value;
}

async function confirmStopped(yes) {
  if (yes) return;
  const answer = await readLine("Have you stopped Crosscuts in umbrelOS? Type YES: ", false);
  if (answer === null || answer.trim() !== "YES") {
    throw new CliError("Not confirmed. Nothing was changed.", EXIT.refused);
  }
}

// ---- archives -----------------------------------------------------------------------------------
// The archive named on the command line: a path, or a bare name in ARCHIVES_DIR.
function resolveArchive(arg, allowUnverified) {
  if (typeof arg !== "string" || arg === "") throw new CliError("Name an archive.", EXIT.usage);
  const base = path.basename(arg);
  const file = arg === base ? path.join(ARCHIVES_DIR, base) : path.resolve(arg);
  let parsed = names.parseArchiveName(base);
  if (!parsed && allowUnverified && base.endsWith(UNVERIFIED)) {
    parsed = names.parseArchiveName(base.slice(0, -UNVERIFIED.length));
  }
  if (!parsed) {
    if (base.endsWith(UNVERIFIED)) {
      throw new CliError("That archive failed its test when it was made. Add --unverified to use it anyway.", EXIT.usage);
    }
    throw new CliError("That is not a Crosscuts archive name (crosscuts-db-... or crosscuts-premigrate-...).", EXIT.usage);
  }
  const st = lstatOrNull(file);
  if (!st || !st.isFile()) throw new CliError("That archive was not found.");
  return { file, name: base, parsed };
}

function makeStaging() {
  fs.mkdirSync(STAGING_DIR, { recursive: true, mode: 0o700 });
  const dir = path.join(STAGING_DIR, `restore-${stamp()}-${process.pid}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

function removeStaging(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (e) {
    warn(`Warning: the staging folder could not be removed (${safeErrorCode(e)}); Crosscuts removes it on its next start.`);
  }
}

async function extractTo(file, passphrase, outDir) {
  if (SEVEN_ZIP === null) throw new CliError("7-Zip is missing from this image.");
  let r;
  try {
    r = await archive.extract({ archive: file, passphrase, outDir });
  } catch (e) {
    if (e instanceof ToolMissingError) throw new CliError("7-Zip is missing from this image.");
    throw new CliError(`7-Zip could not be run (${safeErrorCode(e)}).`);
  }
  if (r.code !== 0) {
    throw new CliError(`The archive did not open with that passphrase, or is damaged (7-Zip exit code ${r.code}). Nothing was changed.`);
  }
}

// Extracts and checks an archive: the manifest parses, the database file matches its size and
// sha256, integrity_check is ok. Returns {dir, man, dbPath, facts, configFiles}.
async function openArchive(file, passphrase, dir) {
  await extractTo(file, passphrase, dir);
  const manPath = path.join(dir, manifest.MANIFEST_NAME);
  const manStat = lstatOrNull(manPath);
  if (!manStat || !manStat.isFile() || manStat.size > 64 * 1024) throw new CliError("The archive has no MANIFEST.txt.");
  const man = manifest.parseManifest(fs.readFileSync(manPath, "utf8"));
  if (!man) throw new CliError("The archive's MANIFEST.txt could not be read.");
  const dbPath = path.join(dir, man.databaseFile);
  const dbStat = lstatOrNull(dbPath);
  if (!dbStat || !dbStat.isFile()) throw new CliError("The archive does not hold the database file its MANIFEST.txt names.");
  if (dbStat.size !== man.databaseBytes) throw new CliError("The database file's size does not match MANIFEST.txt.");
  const sha = await manifest.sha256File(dbPath);
  if (sha !== man.databaseSha256) throw new CliError("The database file's sha256 does not match MANIFEST.txt.");
  let facts;
  try {
    facts = withDatabase(dbPath, (conn) => {
      const ok = conn.pragma("integrity_check", { simple: true });
      if (ok !== "ok") throw new CliError("The database file failed its integrity check.");
      return manifest.dbFacts(conn);
    });
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`The database file could not be opened (${safeErrorCode(e)}).`);
  }
  const configFiles = [];
  const configDir = path.join(dir, manifest.CONFIG_FOLDER);
  const cst = lstatOrNull(configDir);
  if (cst && cst.isDirectory()) {
    for (const name of fs.readdirSync(configDir).sort()) {
      const st = lstatOrNull(path.join(configDir, name));
      if (manifest.configFileOk(name, st)) configFiles.push(name);
    }
  }
  return { man, dbPath, facts, configFiles };
}

function printCounts(label, counts) {
  const parts = manifest.COUNT_TABLES.filter((t) => Number.isInteger(counts[t])).map((t) => `${t} ${counts[t]}`);
  say(`${label}${parts.length > 0 ? parts.join(", ") : "(none)"}`);
}

function printSideBySide(left, leftLabel, right, rightLabel) {
  const w = 12;
  say(`  ${"table".padEnd(w)}${leftLabel.padStart(12)}${rightLabel.padStart(12)}`);
  for (const t of manifest.COUNT_TABLES) {
    if (!Number.isInteger(left[t]) && !Number.isInteger(right[t])) continue;
    const l = Number.isInteger(left[t]) ? String(left[t]) : "-";
    const r = Number.isInteger(right[t]) ? String(right[t]) : "-";
    say(`  ${t.padEnd(w)}${l.padStart(12)}${r.padStart(12)}${l === r ? "" : "   differs"}`);
  }
}

// ---- list ---------------------------------------------------------------------------------------
function cmdList() {
  let entries;
  try {
    entries = fs.readdirSync(ARCHIVES_DIR);
  } catch {
    entries = [];
  }
  const rows = [];
  const unverified = [];
  for (const name of entries) {
    const st = lstatOrNull(path.join(ARCHIVES_DIR, name));
    if (!st || !st.isFile()) continue;
    if (name.endsWith(UNVERIFIED)) {
      if (names.parseArchiveName(name.slice(0, -UNVERIFIED.length))) unverified.push({ name, bytes: st.size });
      continue;
    }
    const p = names.parseArchiveName(name);
    if (p) rows.push({ name, kind: p.kind, bytes: st.size, made: names.sydneyStamp(p.instant).iso });
  }
  rows.sort((a, b) => names.compareArchiveNames(b.name, a.name));
  if (rows.length === 0) {
    say("No archives on this server.");
  } else {
    say(`${rows.length} archive(s), newest first:`);
    for (const r of rows) say(`  ${r.name}  ${r.kind.padEnd(10)}  ${human(r.bytes).padStart(8)}  made ${r.made}`);
  }
  if (unverified.length > 0) {
    say(`${unverified.length} unverified (set aside; restore one only with --unverified):`);
    for (const u of unverified.sort((a, b) => (a.name < b.name ? 1 : -1))) say(`  ${u.name}  ${human(u.bytes)}`);
  }
  return EXIT.ok;
}

// ---- check --------------------------------------------------------------------------------------
async function cmdCheck(arg, flags) {
  const target = resolveArchive(arg, flags.unverified);
  const passphrase = await askPassphrase();
  let dir;
  try {
    dir = makeStaging();
    const a = await openArchive(target.file, passphrase, dir);
    say(`Archive: ${target.name}`);
    say("Opened with the passphrase; the database file matches MANIFEST.txt (size and sha256); integrity_check ok.");
    say("");
    say("MANIFEST.txt:");
    for (const line of manifest.manifestText(a.man).trimEnd().split("\n")) say(`  ${line}`);
    say("");
    say("Counts (MANIFEST.txt, then the file in the archive):");
    printSideBySide(a.man.counts, "manifest", a.facts.counts, "archive");
    say(`Config files in the archive: ${a.configFiles.length > 0 ? a.configFiles.join(", ") : "none"}`);
    const highest = imageHighestMigration();
    if (a.man.migrationHighest > highest) {
      say(`Note: this archive is from a newer Crosscuts (migration ${a.man.migrationHighest}; this image has ${highest}). Restore it with an image at least as new.`);
    }
    say("Nothing was changed.");
    return EXIT.ok;
  } finally {
    removeStaging(dir);
  }
}

// ---- db -----------------------------------------------------------------------------------------
function readConfigPlan(a, dir, ts) {
  // Everything is read and compared before anything changes.
  const plan = [];
  for (const name of a.configFiles) {
    const from = path.join(dir, manifest.CONFIG_FOLDER, name);
    const data = fs.readFileSync(from);
    if (data.length > CONFIG_MAX_BYTES) continue;
    const to = path.join(CONFIG_DIR, name);
    const st = lstatOrNull(to);
    let action = "write";
    if (st && st.isFile()) {
      const current = fs.readFileSync(to);
      action = current.equals(data) ? "same" : "replace";
    } else if (st) {
      action = "blocked";
    }
    plan.push({ name, data, to, action, aside: `${to}.before-restore-${ts}` });
  }
  return plan;
}

function writeConfig(plan) {
  const cfg = lstatOrNull(CONFIG_DIR);
  const results = [];
  for (const item of plan) {
    if (item.action === "same") {
      try {
        fs.chmodSync(item.to, 0o600);
      } catch {
        // Windows: modes don't apply
      }
      results.push(`${item.name}: already the same`);
      continue;
    }
    if (item.action === "blocked") {
      results.push(`${item.name}: NOT restored (something that is not a file has that name)`);
      continue;
    }
    if (item.action === "replace") fs.renameSync(item.to, item.aside);
    const tmp = path.join(CONFIG_DIR, `.${item.name}.restore-${process.pid}`);
    fs.writeFileSync(tmp, item.data, { mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    if (cfg) chownLike(tmp, cfg.uid, cfg.gid);
    fs.renameSync(tmp, item.to);
    results.push(`${item.name}: ${item.action === "replace" ? "restored (the old one kept as .before-restore)" : "restored"}`);
  }
  return results;
}

async function cmdDb(arg, flags) {
  const target = resolveArchive(arg, flags.unverified);
  await confirmStopped(flags.yes);
  const passphrase = await askPassphrase();
  let dir;
  try {
    dir = makeStaging();
    const a = await openArchive(target.file, passphrase, dir);

    const highest = imageHighestMigration();
    if (a.man.migrationHighest > highest) {
      throw new CliError(
        `This archive is from a newer Crosscuts (migration ${a.man.migrationHighest}; this image has ${highest}). Restore it with an image at least as new. Nothing was changed.`,
        EXIT.refused
      );
    }

    const ts = stamp();
    const live = path.join(DB_DIR, LIVE);
    const set = ["", "-wal", "-shm"].map((suffix) => ({
      from: `${live}${suffix}`,
      to: path.join(DB_DIR, `photos-before-restore-${ts}.db${suffix}`),
    }));
    const present = set.filter((s) => lstatOrNull(s.from) !== null);
    if (set.some((s) => lstatOrNull(s.to) !== null)) throw new CliError("A photos-before-restore file with this time already exists. Try again in a second. Nothing was changed.");
    const configPlan = flags.config ? readConfigPlan(a, dir, ts) : [];
    if (flags.config && configPlan.some((p) => p.action === "replace" && lstatOrNull(p.aside) !== null)) {
      throw new CliError("A config .before-restore file with this time already exists. Try again in a second. Nothing was changed.");
    }

    // The mode and owner of the file being replaced, else 0644 and the owner of the folder.
    const oldStat = lstatOrNull(live);
    const dirStat = lstatOrNull(DB_DIR);
    const mode = oldStat && oldStat.isFile() ? oldStat.mode & 0o777 : 0o644;
    const owner = oldStat && oldStat.isFile() ? oldStat : dirStat;

    // Rename the live set as one (never delete), then move the restored file in.
    const done = [];
    try {
      for (const s of present) {
        fs.renameSync(s.from, s.to);
        done.push(s);
      }
      fs.renameSync(a.dbPath, live);
    } catch (e) {
      for (const s of done.reverse()) {
        try {
          fs.renameSync(s.to, s.from);
        } catch {
          warn("Warning: a renamed database file could not be put back; see the photos-before-restore files.");
        }
      }
      throw new CliError(`The restored database could not be put in place (${safeErrorCode(e)}). Nothing was changed.`);
    }
    try {
      fs.chmodSync(live, mode);
    } catch {
      // Windows: modes don't apply
    }
    if (owner) chownLike(live, owner.uid, owner.gid);

    say(`Restored ${target.name} as photos.db.`);
    if (present.length > 0) {
      say(`The previous database was kept, renamed: ${present.map((s) => path.basename(s.to)).join(", ")}.`);
    } else {
      say("There was no previous database.");
    }

    let configFailed = false;
    if (flags.config) {
      try {
        const results = writeConfig(configPlan);
        say(results.length > 0 ? `Config files: ${results.join("; ")}.` : "Config files: none in the archive.");
      } catch (e) {
        configFailed = true;
        warn(`The database was restored, but the config files could not all be written (${safeErrorCode(e)}).`);
      }
    } else if (a.configFiles.length > 0) {
      say(`Config files were not restored (add --config to restore: ${a.configFiles.join(", ")}).`);
    }

    let after = {};
    try {
      after = withDatabase(live, (conn) => manifest.dbFacts(conn)).counts;
    } catch (e) {
      warn(`The restored database could not be counted (${safeErrorCode(e)}).`);
    }
    say("");
    say("Counts (MANIFEST.txt, then the restored photos.db):");
    printSideBySide(a.man.counts, "archive", after, "restored");
    say("");
    say("Start Crosscuts in umbrelOS, log in, and check the board and these counts.");
    return configFailed ? EXIT.failed : EXIT.ok;
  } finally {
    removeStaging(dir);
  }
}

// ---- files --------------------------------------------------------------------------------------
async function cmdFiles(arg) {
  if (typeof arg !== "string" || arg === "") throw new CliError("Name a folder.", EXIT.usage);
  const folder = path.resolve(arg);
  const fst = lstatOrNull(folder);
  if (!fst || !fst.isDirectory()) throw new CliError("That folder was not found.");
  const blobs = [];
  for (const entry of fs.readdirSync(folder).sort()) {
    if (!entry.endsWith(".7z")) continue;
    const base = entry.slice(0, -3);
    if (!names.isUploadName(base, "file")) continue;
    const st = lstatOrNull(path.join(folder, entry));
    if (st && st.isFile()) blobs.push({ entry, base });
  }
  if (blobs.length === 0) {
    say("No <name>.7z private files in that folder. Nothing was changed.");
    return EXIT.ok;
  }
  const target = path.join(UPLOADS_DIR, "files");
  fs.mkdirSync(target, { recursive: true });
  const tst = lstatOrNull(target);
  const passphrase = await askPassphrase();

  let restored = 0;
  let already = 0;
  let dir;
  try {
    dir = makeStaging();
    for (const b of blobs) {
      const dest = path.join(target, b.base);
      if (lstatOrNull(dest) !== null) {
        already += 1;
        continue;
      }
      const out = path.join(dir, `f-${restored + already}`);
      fs.mkdirSync(out, { mode: 0o700 });
      try {
        await extractTo(path.join(folder, b.entry), passphrase, out);
      } catch (e) {
        say(`${restored} restored, ${already} already there; stopped at a file that did not open.`);
        throw e;
      }
      const got = path.join(out, b.base);
      const gst = lstatOrNull(got);
      if (!gst || !gst.isFile()) {
        say(`${restored} restored, ${already} already there; stopped at a .7z that does not hold its file.`);
        throw new CliError("A .7z did not hold the file its name says.");
      }
      // Staging and uploads may be different volumes: copy beside the target, then rename.
      const tmp = path.join(target, `.${b.base}.restore-${process.pid}`);
      fs.copyFileSync(got, tmp, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(tmp, 0o644);
      if (tst) chownLike(tmp, tst.uid, tst.gid);
      if (lstatOrNull(dest) !== null) {
        fs.unlinkSync(tmp);
        already += 1;
      } else {
        fs.renameSync(tmp, dest);
        restored += 1;
      }
      fs.rmSync(out, { recursive: true, force: true });
    }
  } finally {
    removeStaging(dir);
  }
  say(`${restored} restored, ${already} already there (never overwritten).`);
  return EXIT.ok;
}

// ---- main ---------------------------------------------------------------------------------------
function parseArgs(argv) {
  const flags = { config: false, yes: false, unverified: false };
  const positional = [];
  for (const a of argv) {
    if (a === "--config") flags.config = true;
    else if (a === "--yes") flags.yes = true;
    else if (a === "--unverified") flags.unverified = true;
    else if (a === "--help" || a === "-h") return { help: true };
    else if (a.startsWith("--")) throw new CliError(`Unknown option ${a.replace(/[^A-Za-z0-9-]/g, "")}.\n\n${USAGE}`, EXIT.usage);
    else positional.push(a);
  }
  return { flags, positional };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    say(USAGE);
    return EXIT.ok;
  }
  const [command, arg, ...rest] = parsed.positional;
  const { flags } = parsed;
  const extra = rest.length > 0;
  switch (command) {
    case "list":
      if (arg !== undefined || flags.config || flags.yes || flags.unverified) break;
      return cmdList();
    case "check":
      if (extra || flags.config || flags.yes) break;
      return cmdCheck(arg, flags);
    case "db":
      if (extra) break;
      return cmdDb(arg, flags);
    case "files":
      if (extra || flags.config || flags.yes || flags.unverified) break;
      return cmdFiles(arg);
    default:
      break;
  }
  throw new CliError(USAGE, EXIT.usage);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    if (e instanceof CliError) {
      warn(e.message);
      process.exitCode = e.exitCode;
    } else {
      warn(`The restore failed (${safeErrorCode(e)}). Nothing was changed unless a line above says so.`);
      process.exitCode = EXIT.failed;
    }
  })
  .finally(() => {
    // A piped stdin that is still open must not keep the process alive.
    try {
      if (pipe.started) process.stdin.destroy();
      else process.stdin.pause();
    } catch {
      // nothing to stop
    }
  });
