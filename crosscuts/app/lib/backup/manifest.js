// MANIFEST.txt and README-restore.txt, and the facts that go in them
// (docs/plans/backup-contracts.md section 5.2).
//
// An archive holds:
//   photos.db            the verified copy (journal_mode DELETE); a pre-migration wrap holds
//                        photos-pre-NNN-<stamp>.db instead
//   MANIFEST.txt         key: value lines, never a secret (parsed back by tools/restore.js)
//   README-restore.txt   fixed text: how to open it
//   config/              every regular file in CONFIG_DIR except backup-passphrase, dotfiles,
//                        *.new and files over CONFIG_MAX_BYTES (configFileOk below)
//
// Pure apart from sha256File (reads one file). Requires no database: dbFacts takes an open
// connection. tools/restore.js requires this module too, so it stays free of the service.
const fs = require("fs");
const crypto = require("crypto");
const { CONFIG_FILES, CONFIG_MAX_BYTES } = require("./constants");
const { PREMIGRATE_SOURCE_RE, FILE_NAME_RE } = require("./names");

const TITLE = "Crosscuts database archive";
const MANIFEST_NAME = "MANIFEST.txt";
const README_NAME = "README-restore.txt";
const DB_FILE = "photos.db";
const CONFIG_FOLDER = "config";
const KINDS = ["nightly", "manual", "premigrate"];

// The tables counted, in this order, when they exist (an old-app file has no users or files).
const COUNT_TABLES = ["users", "jobs", "week_rows", "photos", "files"];

const RESTORE_DOC = "https://github.com/devcal1/joinr-crosscuts/blob/main/docs/restore.md";

// ---- what goes in config/ -----------------------------------------------------------------------
// A config file name that may go in an archive (and come back out of one): a plain name (no
// dotfile, no separator, no comma, so the manifest list stays one line), never backup-passphrase,
// never a helper's half-placed *.new. The caller also checks it is a regular file (lstat) of at
// most CONFIG_MAX_BYTES.
function configNameOk(name) {
  return (
    typeof name === "string" &&
    FILE_NAME_RE.test(name) &&
    name !== CONFIG_FILES.passphrase &&
    !/\.new$/i.test(name)
  );
}

function configFileOk(name, lstat) {
  return configNameOk(name) && !!lstat && lstat.isFile() && lstat.size <= CONFIG_MAX_BYTES;
}

// The database file an archive may hold: photos.db, or a migrate.js pre-migration file.
function databaseFileOk(name) {
  return name === DB_FILE || (typeof name === "string" && PREMIGRATE_SOURCE_RE.test(name));
}

// ---- facts from a database ----------------------------------------------------------------------
function tableExists(conn, name) {
  const row = conn.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return !!row && Number(row.n) > 0;
}

// {counts: {users, jobs, week_rows, photos, files} (only the tables that exist),
//  migrationCount, migrationHighest} (0 and 0 without schema_migrations).
function dbFacts(conn) {
  const counts = {};
  for (const t of COUNT_TABLES) {
    if (tableExists(conn, t)) counts[t] = Number(conn.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n);
  }
  let migrationCount = 0;
  let migrationHighest = 0;
  if (tableExists(conn, "schema_migrations")) {
    const row = conn.prepare("SELECT COUNT(*) AS n, MAX(version) AS hi FROM schema_migrations").get();
    migrationCount = Number(row.n) || 0;
    migrationHighest = Number(row.hi) || 0;
  }
  return { counts, migrationCount, migrationHighest };
}

// The counts as a run's detail names them (section 5.3): missing tables count 0.
function detailCounts(counts) {
  const c = counts || {};
  return {
    users: c.users || 0,
    jobs: c.jobs || 0,
    weekRows: c.week_rows || 0,
    photos: c.photos || 0,
    files: c.files || 0,
  };
}

// sha256 of a file, streamed. Resolves the hex digest.
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// ---- MANIFEST.txt -------------------------------------------------------------------------------
function oneLine(v) {
  return String(v === undefined || v === null ? "" : v).replace(/[\r\n]+/g, " ");
}

function countsText(counts) {
  const c = counts || {};
  return COUNT_TABLES.filter((t) => Number.isInteger(c[t])).map((t) => `${t} ${c[t]}`).join(", ");
}

// fields: {kind, made (ISO with offset), appVersion, databaseFile, databaseBytes, databaseSha256,
//          migrationCount, migrationHighest, counts: {users, jobs, week_rows, photos, files},
//          configFiles: [names]}
function manifestText(fields) {
  const f = fields || {};
  const lines = [
    TITLE,
    `kind: ${oneLine(f.kind)}`,
    `made: ${oneLine(f.made)}`,
    `app version: ${oneLine(f.appVersion)}`,
    `database file: ${oneLine(f.databaseFile)}`,
    `database bytes: ${oneLine(f.databaseBytes)}`,
    `database sha256: ${oneLine(f.databaseSha256)}`,
    `migration count: ${oneLine(f.migrationCount)}`,
    `migration highest: ${oneLine(f.migrationHighest)}`,
    `counts: ${countsText(f.counts)}`,
    `config files: ${(Array.isArray(f.configFiles) ? f.configFiles : []).map(oneLine).join(", ")}`,
  ];
  return `${lines.map((l) => l.replace(/\s+$/, "")).join("\n")}\n`;
}

function wholeNumber(text) {
  return /^\d{1,15}$/.test(text) ? Number(text) : null;
}

// {kind, made, appVersion, databaseFile, databaseBytes, databaseSha256, migrationCount,
//  migrationHighest, counts: {users, jobs, week_rows, photos, files (those present)},
//  configFiles: [names]} or null when anything is missing or out of shape.
function parseManifest(text) {
  if (typeof text !== "string" || text.length > 64 * 1024) return null;
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] !== TITLE) return null;
  const kv = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const m = /^([a-z0-9 ]+):(?: (.*))?$/.exec(line);
    if (!m || Object.prototype.hasOwnProperty.call(kv, m[1])) return null;
    kv[m[1]] = (m[2] || "").trim();
  }
  const kind = kv.kind;
  if (!KINDS.includes(kind)) return null;
  const made = kv.made;
  if (typeof made !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/.test(made)) return null;
  const appVersion = kv["app version"];
  if (typeof appVersion !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(appVersion)) return null;
  const databaseFile = kv["database file"];
  if (!databaseFileOk(databaseFile)) return null;
  const databaseBytes = wholeNumber(kv["database bytes"] || "");
  const databaseSha256 = kv["database sha256"];
  const migrationCount = wholeNumber(kv["migration count"] || "");
  const migrationHighest = wholeNumber(kv["migration highest"] || "");
  if (databaseBytes === null || migrationCount === null || migrationHighest === null) return null;
  if (typeof databaseSha256 !== "string" || !/^[0-9a-f]{64}$/.test(databaseSha256)) return null;
  if (typeof kv.counts !== "string") return null;
  const counts = {};
  if (kv.counts !== "") {
    for (const part of kv.counts.split(",")) {
      const m = /^\s*([a-z_]+) (\d{1,15})\s*$/.exec(part);
      if (!m || !COUNT_TABLES.includes(m[1]) || Object.prototype.hasOwnProperty.call(counts, m[1])) return null;
      counts[m[1]] = Number(m[2]);
    }
  }
  if (typeof kv["config files"] !== "string") return null;
  const configFiles = kv["config files"] === "" ? [] : kv["config files"].split(",").map((s) => s.trim());
  if (!configFiles.every(configNameOk)) return null;
  return {
    kind,
    made,
    appVersion,
    databaseFile,
    databaseBytes,
    databaseSha256,
    migrationCount,
    migrationHighest,
    counts,
    configFiles,
  };
}

// ---- README-restore.txt -------------------------------------------------------------------------
function readmeText() {
  return [
    "Crosscuts database archive",
    "",
    "This is an encrypted Crosscuts database archive (7-Zip, AES-256, file names hidden).",
    "",
    "The passphrase is the Joinr Backup passphrase, kept in the password manager (and on paper).",
    "",
    "On Windows: open it with 7-Zip. Right-click the archive, choose 7-Zip, then Extract files,",
    "and enter the passphrase.",
    "",
    "On the Umbrel: use the restore tool in the Crosscuts image (node tools/restore.js), with",
    "Crosscuts stopped.",
    "",
    "The full runbook is docs/restore.md in the joinr-crosscuts repository:",
    RESTORE_DOC,
    "",
    "Never put the database file from this archive in place of a running database.",
    "",
  ].join("\n");
}

module.exports = {
  TITLE,
  MANIFEST_NAME,
  README_NAME,
  DB_FILE,
  CONFIG_FOLDER,
  COUNT_TABLES,
  configNameOk,
  configFileOk,
  databaseFileOk,
  dbFacts,
  detailCounts,
  sha256File,
  manifestText,
  parseManifest,
  readmeText,
};
