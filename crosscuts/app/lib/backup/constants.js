// Backups: every number, flag, file name and folder (docs/plans/backup-contracts.md section 4.2).
// Requires only lib/config.js (the data folders), never the database.
const path = require("path");
const config = require("../config");

// Absolute, always: 7-Zip runs with its working folder inside staging, so a relative data folder
// (a local run with DB_DIR=../../.dev/...) would send the archive to the wrong place.
const DB_DIR = path.resolve(config.DB_DIR);
const UPLOADS_DIR = path.resolve(config.UPLOADS_DIR);
const CONFIG_DIR = path.resolve(config.CONFIG_DIR);

// The ONLY rsync flags; ci/backup-guard.js pins them. Never --delete, --partial, --inplace, -a, -r ...
const RSYNC_FLAGS = Object.freeze(["--times", "--contimeout=10", "--timeout=120"]);
const RSYNC_LIST_FLAG = "--list-only"; // added for listings only

// 01:30 Sydney, clear of the 02:00-03:00 daylight-saving gap and repeat.
const SLOT_HOUR = 1;
const SLOT_MINUTE = 30;
const COPY_WEEKDAY = 6; // Saturday, in lib/time.js sydneyParts numbering (Mon=1 .. Sun=7)

const CHECK_MS = 60_000;
const CATCH_UP_DELAY_MS = 5 * 60_000;
const RETRY_DELAYS_MIN = Object.freeze([60, 120, 240]);
const MAX_ATTEMPTS = 4; // per slot: the first try plus three retries

const SNAPSHOT_DEADLINE_MS = 10 * 60_000;
const COPY_DEADLINE_MS = 30 * 60_000;
const KILL_GRACE_MS = 5_000;
const MANUAL_GAP_MS = 10 * 60_000; // Back up now: 429 within this long of a good snapshot

const SNAPSHOT_OVERDUE_HOURS = 48;
const COPY_OVERDUE_HOURS = 8 * 24;

const RETAIN = Object.freeze({ dailyDates: 14, monthlyMonths: 12, manual: 10, unverified: 3 });

const SPACE_FACTOR = 3;
const SPACE_FLOOR_BYTES = 256 * 2 ** 20;

const PASSPHRASE_MIN = 12;
const PASSPHRASE_MAX = 1024;
const NAS_PASSWORD_MAX = 256;
const SECRET_MAX_BYTES = 4096;

const PHOTO_BATCH = 500;
const BLOB_BATCH = 50;
const BLOB_BATCH_BYTES = 512 * 2 ** 20;

const LIST_OUTPUT_LIMIT = 16 * 2 ** 20;
const OUTPUT_LIMIT = 8 * 2 ** 20;
const STDERR_LIMIT = 64 * 1024;

const CONFIG_FILES = Object.freeze({
  passphrase: "backup-passphrase",
  nasUrl: "nas-url",
  nasPassword: "nas-password",
});
const CONFIG_MAX_BYTES = 64 * 1024; // a config file larger than this is not put in an archive

const BACKUPS_DIR = path.join(DB_DIR, "backups"); // migrate.js already writes photos-pre-NNN-*.db here
const ARCHIVES_DIR = path.join(BACKUPS_DIR, "archives");
const STAGING_DIR = path.join(BACKUPS_DIR, ".staging"); // mode 700; wiped at start and after every run

const NAS_FOLDERS = Object.freeze(["db", "files", "photos"]); // the copy's order: the archives first, the photos last

const REFUSAL_REASONS = Object.freeze(["auth", "unknown_module", "refused"]);
// The refusal reasons are NOT in NON_RETRYABLE: the refusal lock (section 7.6) gates them instead.
const NON_RETRYABLE = Object.freeze([
  "no_passphrase",
  "passphrase_unusable",
  "no_7zip",
  "no_rsync",
  "nas_off",
  "nas_half",
  "nas_invalid",
]);

// Every reason key a run can record (section 8); sentences.js has a sentence for each.
const SNAPSHOT_REASONS = Object.freeze([
  "no_passphrase",
  "passphrase_unusable",
  "no_7zip",
  "no_space",
  "copy_failed",
  "check_failed",
  "migrations_mismatch",
  "archive_failed",
  "test_failed",
  "timeout",
  "interrupted",
  "other",
]);
const COPY_REASONS = Object.freeze([
  "nas_off",
  "nas_half",
  "nas_invalid",
  "auth",
  "unknown_module",
  "refused",
  "unreachable",
  "timeout", // the copy's own deadline (COPY_DEADLINE_MS)
  "stalled", // rsync exit 30: no data within --timeout
  "broken",
  "nas_io",
  "not_verified",
  "readback_failed",
  "encrypt_failed",
  "no_space", // too little free space to encrypt a batch of private files (retryable, as the snapshot's)
  "no_rsync",
  "no_7zip",
  "interrupted",
  "other",
]);

module.exports = {
  RSYNC_FLAGS,
  RSYNC_LIST_FLAG,
  SLOT_HOUR,
  SLOT_MINUTE,
  COPY_WEEKDAY,
  CHECK_MS,
  CATCH_UP_DELAY_MS,
  RETRY_DELAYS_MIN,
  MAX_ATTEMPTS,
  SNAPSHOT_DEADLINE_MS,
  COPY_DEADLINE_MS,
  KILL_GRACE_MS,
  MANUAL_GAP_MS,
  SNAPSHOT_OVERDUE_HOURS,
  COPY_OVERDUE_HOURS,
  RETAIN,
  SPACE_FACTOR,
  SPACE_FLOOR_BYTES,
  PASSPHRASE_MIN,
  PASSPHRASE_MAX,
  NAS_PASSWORD_MAX,
  SECRET_MAX_BYTES,
  PHOTO_BATCH,
  BLOB_BATCH,
  BLOB_BATCH_BYTES,
  LIST_OUTPUT_LIMIT,
  OUTPUT_LIMIT,
  STDERR_LIMIT,
  CONFIG_FILES,
  CONFIG_MAX_BYTES,
  DB_DIR,
  UPLOADS_DIR,
  CONFIG_DIR,
  BACKUPS_DIR,
  ARCHIVES_DIR,
  STAGING_DIR,
  NAS_FOLDERS,
  REFUSAL_REASONS,
  NON_RETRYABLE,
  SNAPSHOT_REASONS,
  COPY_REASONS,
};
