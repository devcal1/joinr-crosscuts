# Backup interface contracts (binding for all Backup subagents)

Read `docs/plans/backup-plan.md` first. Its **Decisions (Backup · 1.3)** section is binding and wins over the plan's earlier text; this file is the *what*. Everything in `m1-contracts.md` … `m6-contracts.md` still holds (timestamps, Sydney dates, `defineRoutes`, audit, `lib/httperror.js`, errors `{error}`). If a contract looks wrong, report it instead of working around it.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), Node 24, no build step. **No new feature keys** (everything is `users.admin`). The board files are not touched.

**Version.** Local `main` is already at **0.1.7** (unpushed: the board print fix, invoices always having a value, password expiry). Backup ships in the same next push, so the build makes **no further bump**. If anything is pushed before Backup is finished, the next push is 0.1.8 and must bump `crosscuts/app/package.json` and the root version in `crosscuts/app/package-lock.json` first.

**This repo is public.** No NAS address, rsync account, module name, password or passphrase may appear anywhere in it: not in code, tests, docs, comments or commit messages. The helper prompts for them. The CI stand-in uses its own throwaway values (§16), which are not the real ones.

## 1. Files and module boundaries

| File | What it is | Owner |
|---|---|---|
| `crosscuts/app/Dockerfile` | adds rsync and 7-Zip (§4.1) | scaffold |
| `db/migrations/016_backup.sql` | §2 | scaffold |
| `lib/settings.js` | five new `DEFAULTS` keys (§2) | scaffold |
| `lib/backup/constants.js` | every number, flag, file name and folder (§4.2), complete | scaffold |
| `lib/backup/secrets.js` | reads the three config files and reports their state (§3.1), complete | scaffold |
| `lib/backup/nasurl.js` | the address rule (§3.2), pure and dependency-free (the helper requires it too), complete | scaffold |
| `lib/backup/tools.js` | finds 7-Zip and rsync, runs a child with no shell (§4.3), complete | scaffold |
| `lib/backup/archive.js` | the 7-Zip calls: create, test, extract (§4.4), complete | scaffold |
| `lib/backup/names.js` | archive and upload name rules, the Sydney stamp (§5.1), complete | scaffold |
| `lib/backup/sentences.js` | every fixed sentence (§8), complete | scaffold |
| `lib/backup/snapshot.js` | stub in the scaffold; the snapshot (§5) | A |
| `lib/backup/retention.js` | local retention, pure (§5.6) | A |
| `lib/backup/manifest.js` | `MANIFEST.txt` and `README-restore.txt` (§5.2) | A |
| `crosscuts/app/tools/restore.js` | the restore CLI, in the image (§13) | A |
| `lib/backup/copy.js` | stub in the scaffold; the copy (§6) | B |
| `lib/backup/rsync.js` | the rsync runner, argv builders, exit-code classifier (§6.3, §6.8) | B |
| `lib/backup/listing.js` | `--list-only` parser, pure (§6.4) | B |
| `lib/backup/plan.js` | what to send, pure (§6.5) | B |
| `lib/backup/ledger.js` | the private-file ledger (§6.7) | B |
| `lib/backup/schedule.js` | slots, settling, retries, the refusal lock, overdue; pure (§7) | D |
| `lib/backup/index.js` | stub in the scaffold; the service: `start`, `status`, `requestRun`, the lock, the timer, recording, bells (§7, §11) | D |
| `routes/backup.js` | `defineRoutes('/api/backup')`, two routes (§9); 501 stubs in the scaffold | scaffold, then D |
| `public/users.{html,js,css}` | the Backups section only (§10) | D |
| `server.js` | mounts `routes/backup.js`; `require('./lib/backup').start(db)` after listen | scaffold |
| `tools/backup-secrets.mjs` | the helper, outside the Docker context (§12) | C |
| `docs/restore.md` (new), `docs/rollback.md`, `docs/cutover.md` | §14 | C |
| `docs/auth.md` | one sentence: Backup adds no key; its section and routes need `users.admin` | scaffold |
| `ci/backup-guard.js` | the flag and logging guard (§16.1) | scaffold |
| `.github/workflows/publish.yml` | runs the guard beside the style check | scaffold |
| `ci/smoke.sh` | the CI-only env, step 0 tool checks, the source line (§16.2) | scaffold |
| `ci/smoke-backup.sh` | the backup smoke (§16.3) | E |

**Why `crosscuts/app/tools/restore.js`.** The plan's runbook runs `node tools/restore.js` inside the installed image (WORKDIR `/app`), so it must sit inside the Docker context. It is an entry point that the server never `require`s, so it doesn't belong in `lib/`. The repo-root `tools/` (the dev shim and the helper) is outside the context and never ships. `.dockerignore` doesn't exclude `tools`, so `COPY . .` picks it up.

**Boundaries.** `snapshot.js` and `copy.js` each run one job and return an **outcome**; they never write `backup_runs`, raise a bell or decide when to run. The service (`index.js`) does all of that. Nothing under `lib/backup/` requires `../../db` at load time: the service receives `db` from `start(db)`, and `snapshot.js`/`copy.js` take `db` as an argument. **`tools/restore.js` must never require `db/index.js` or `server.js`** (opening the live database would run the migrations on the very file being replaced).

**The outcome** (both jobs):
```js
{ status: 'succeeded' | 'failed',
  reason: string | null,        // a reason key from §8, null on success
  exitCode: number | null,      // the tool's exit code where one explains the failure
  detail: object }              // counts, bytes, durations, archive names; never a path, address, value or tool output
```
Both jobs **never throw** for any input or state; every failure is an outcome.

## 2. Migration (scaffold, Backup · 2.2): `016_backup.sql`

```sql
-- Backup (docs/plans/backup-contracts.md section 2). Additive only: two new tables.
CREATE TABLE backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot','copy')),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','startup','manual')),
  slot TEXT,                                          -- Sydney YYYY-MM-DD the timer ran it for; NULL for manual
  attempt INTEGER NOT NULL DEFAULT 1,                 -- 1..4 within a slot; 1 for manual
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  reason TEXT,                                        -- section 8 key; NULL on success
  exit_code INTEGER,
  detail TEXT NOT NULL DEFAULT '{}',                  -- JSON: counts, bytes, durations, archive names only
  requested_by INTEGER REFERENCES users(id)           -- the admin who pressed Back up now; NULL for the timer
);
CREATE INDEX idx_backup_runs_kind ON backup_runs(kind, started_at);
CREATE INDEX idx_backup_runs_slot ON backup_runs(kind, slot);

CREATE TABLE backup_blobs (
  stored_name TEXT PRIMARY KEY,                       -- the private file's name in uploads/files (<uuid>.<ext>)
  source_bytes INTEGER NOT NULL,                      -- its size when it was encrypted
  blob_bytes INTEGER NOT NULL,                        -- the size of <stored_name>.7z as encrypted
  encrypted_at TEXT NOT NULL,
  sent_at TEXT,                                       -- the last copy that sent it
  proven_at TEXT                                      -- the last copy that saw it on the NAS at blob_bytes
);
```

No sentence or message text is stored: the page builds each run's sentence from `reason`, `exit_code` and `detail` (§8), so nothing a tool printed can ever reach a row.

**`lib/settings.js` `DEFAULTS`** gains (all `null`, all written with `{audit: false}`, none exposed by `/api/settings`):
`backup.seeded_at` (ISO, first start), `backup.snapshot_seed_slot`, `backup.copy_seed_slot` (§7.4), `backup.overdue_alerted_snapshot`, `backup.overdue_alerted_copy` (Sydney date of the last overdue bell, §11.1).

The last runs are read from `backup_runs`, not kept in `app_settings` (a refinement of plan §7: the table already holds them).

## 3. Configuration files

### 3.1 `lib/backup/secrets.js` (scaffold, complete)

Three one-line files in `CONFIG_DIR` (`/data/config`), placed by the helper (§12), **read fresh on every call** (no restart to rotate), never written, shown, logged or returned by the app. No environment variable can supply them.

| File | Rule | Needed by |
|---|---|---|
| `backup-passphrase` | the first line with only its line ending dropped (**not trimmed**: Joinr Backup's rule, so it matches the password manager exactly); 12–1024 characters; no control characters | the snapshot |
| `nas-url` | first line, trimmed; passes `checkNasUrl` (§3.2) | the copy |
| `nas-password` | first line, trimmed; 1–256 characters; no control characters | the copy |

A file is **missing** if absent; **not usable** if it is not a regular file (`lstat`; a symlink is not usable), is larger than 4096 bytes, or breaks its rule; else **set**.

```js
function passphraseStatus();   // {state: 'missing'|'not_usable'|'set', mtimeMs: number|null}  (never the value)
function readPassphrase();     // {state, value: string|null}  value only when 'set'; the caller keeps it in local scope
function nasStatus();          // {state: 'off'|'half'|'invalid'|'ready',
                               //  url: 'missing'|'not_usable'|'set', password: 'missing'|'not_usable'|'set',
                               //  mtimes: {url: number|null, password: number|null}}
function readNas();            // nasStatus() plus {url: canonical|null, hasSubfolder: bool, password: string|null}
```
NAS states: both missing → `off`; exactly one missing → `half`; both present but either not usable → `invalid`; else `ready`. Errors reading a file are reported by `safeSystemCode` only (Finance's `errorCode.ts` rule: an allowlisted `code`, else `UNKNOWN`).

### 3.2 `lib/backup/nasurl.js` (scaffold, complete; pure, no requires)

Port of Finance's `checkNasUrl`, tightened to an IP address as the plan requires (MagicDNS names don't resolve inside containers):

`rsync://<account>@<IPv4>[:<port>]/<module>[/<subfolder>][/]`
- account, module and subfolder each `^[A-Za-z0-9][A-Za-z0-9._-]*$`, at most 64 characters, after percent-decoding;
- the host a dotted IPv4 address (four 0–255 parts, no leading zeros); names and IPv6 are refused;
- port 1–65535 (the CI stand-in uses one; the real NAS uses rsync's default);
- no password, query, fragment or whitespace anywhere.

```js
function checkNasUrl(raw);     // {ok: true, url: 'rsync://acct@1.2.3.4[:p]/module[/sub]/', hasSubfolder}
                               // | {ok: false, configured: bool}; NEVER throws, never quotes the input
function isTailscaleIp(host);  // 100.64.0.0/10 (the helper warns otherwise)
```
A subfolder in the address must already exist on the NAS: rsync creates only one folder level on a send (§6.1).

## 4. The image and the tools

### 4.1 Dockerfile (scaffold)

After `WORKDIR /app`, before `COPY package.json`:
```dockerfile
# Backups (docs/plans/backup-contracts.md): rsync for the NAS copy, 7-Zip for the encrypted archives.
# The build fails if either doesn't run, or if a popt alias file could add flags to rsync unseen.
RUN apk add --no-cache rsync 7zip \
 && rsync --version > /dev/null \
 && { 7zz i > /dev/null 2>&1 || 7z i > /dev/null 2>&1; } \
 && test ! -e /etc/popt && test ! -e /etc/popt.d
```
No `USER` change (the app runs as root, as today).

### 4.2 `lib/backup/constants.js` (scaffold, complete)

```js
RSYNC_FLAGS = ['--times', '--contimeout=10', '--timeout=120'];  // the ONLY flags; ci/backup-guard.js pins them
RSYNC_LIST_FLAG = '--list-only';                                  // added for listings only
SLOT_HOUR = 1; SLOT_MINUTE = 30;          // 01:30 Sydney, clear of the 02:00-03:00 daylight-saving gap and repeat
COPY_WEEKDAY = 6;                         // Saturday, in lib/time.js sydneyParts numbering (Mon=1 .. Sun=7)
CHECK_MS = 60_000; CATCH_UP_DELAY_MS = 5 * 60_000;
RETRY_DELAYS_MIN = [60, 120, 240]; MAX_ATTEMPTS = 4;             // per slot: the first try plus three retries
SNAPSHOT_DEADLINE_MS = 10 * 60_000; COPY_DEADLINE_MS = 30 * 60_000; KILL_GRACE_MS = 5_000;
MANUAL_GAP_MS = 10 * 60_000;              // Back up now: 429 within this long of a good snapshot
SNAPSHOT_OVERDUE_HOURS = 48; COPY_OVERDUE_HOURS = 8 * 24;
RETAIN = { dailyDates: 14, monthlyMonths: 12, manual: 10, unverified: 3 };
SPACE_FACTOR = 3; SPACE_FLOOR_BYTES = 256 * 2 ** 20;
PASSPHRASE_MIN = 12; PASSPHRASE_MAX = 1024; NAS_PASSWORD_MAX = 256; SECRET_MAX_BYTES = 4096;
PHOTO_BATCH = 500; BLOB_BATCH = 50; BLOB_BATCH_BYTES = 512 * 2 ** 20;
LIST_OUTPUT_LIMIT = 16 * 2 ** 20; OUTPUT_LIMIT = 8 * 2 ** 20; STDERR_LIMIT = 64 * 1024;
CONFIG_FILES = { passphrase: 'backup-passphrase', nasUrl: 'nas-url', nasPassword: 'nas-password' };
CONFIG_MAX_BYTES = 64 * 1024;             // a config file larger than this is not put in an archive
BACKUPS_DIR = path.join(DB_DIR, 'backups');                 // migrate.js already writes photos-pre-NNN-*.db here
ARCHIVES_DIR = path.join(BACKUPS_DIR, 'archives');
STAGING_DIR = path.join(BACKUPS_DIR, '.staging');           // mode 700; wiped at start and after every run
NAS_FOLDERS = ['db', 'files', 'photos'];                    // the copy's order: the archives first, the photos last
REFUSAL_REASONS = ['auth', 'unknown_module', 'refused'];
NON_RETRYABLE = ['no_passphrase', 'passphrase_unusable', 'no_7zip', 'no_rsync', 'nas_off', 'nas_half', 'nas_invalid'];
// The refusal reasons are NOT in NON_RETRYABLE: the refusal lock (section 7.6) gates them instead.
```

### 4.3 `lib/backup/tools.js` (scaffold, complete)

7-Zip's binary name differs by distribution, so it is **resolved at runtime**, as Joinr Backup's `tools.mjs` does: the env `BACKUP_7Z` if set (**local development only**, e.g. `C:\Program Files\7-Zip\7z.exe`; never set in the compose file), else the first of `7zz`, `7z` found on `PATH`, else `null`. rsync is `rsync` on `PATH`, no override. Resolved once at load.

```js
const SEVEN_ZIP;                       // the resolved name or path, or null
function toolsStatus();                // {sevenZip: bool, rsync: bool}, cached after the first call
async function probeVersions();        // {sevenZip: string|null, rsync: string|null} (first line containing "7-Zip" / "rsync  version")
// Runs one child: spawn(executable, args, {shell: false, cwd, stdio: ['ignore','pipe','pipe']}) with an
// environment built FROM SCRATCH: {PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
// LC_ALL: 'C', ...extraEnv} (no HOME, so rsync reads no ~/.popt; no RSYNC_* from the parent). On Windows
// dev boxes PATH is passed through instead. stdout capped at outputLimit (outTruncated set), stderr at
// STDERR_LIMIT. On signal abort: SIGTERM, then SIGKILL after KILL_GRACE_MS.
// Resolves {code, out, err, outTruncated} for any exit code. Rejects only with ToolMissingError (ENOENT)
// or ToolAbortError ({why: 'deadline'|'stopped'}); their messages name the tool, never an argument.
async function runTool(executable, args, { cwd, extraEnv, signal, outputLimit });
class ToolMissingError extends Error {}
class ToolAbortError extends Error {}
```
**No argument array, environment, `out` or `err` is ever logged, stored, returned to a caller outside `lib/backup/`, or put in an error message.**

### 4.4 `lib/backup/archive.js` (scaffold, complete)

The passphrase reaches 7-Zip as the argument `-p<passphrase>` (the accepted exposure Joinr Backup states: visible to root inside the container while 7-Zip runs; no shell ever sees it). It is never logged. See §18 item 2 on stdin.

```js
// 7z a -t7z -mhe=on -mx=<level> -bsp0 -bso0 -p<pp> -- <archive> <entries...>, run with cwd so entries are
// bare relative names (no absolute path is ever stored in an archive). A named folder is added with its contents.
async function create({ archive, cwd, entries, passphrase, level = 5, signal });   // {code}
async function test({ archive, passphrase, signal });                               // 7z t -bsp0 -bso0 -p<pp> -- <archive>  → {code}
async function extract({ archive, passphrase, outDir, signal });                    // 7z x -bsp0 -bso0 -y -p<pp> -o<outDir> -- <archive> → {code}
```
Any non-zero code is a failure (7-Zip's 1, "warning", included). `-mhe=on` is mandatory on every `create`: names inside are hidden.

## 5. The snapshot (Wave 1 A: `snapshot.js`, `retention.js`, `manifest.js`)

### 5.1 Names (`lib/backup/names.js`, scaffold, complete)

| Kind | Name | Example |
|---|---|---|
| nightly (timer: `schedule` or `startup`) | `crosscuts-db-YYYYMMDD-HHmmss±HHMM.7z` | `crosscuts-db-20261012-013004+1100.7z` |
| manual (Back up now) | `crosscuts-db-YYYYMMDD-HHmmss±HHMM-manual.7z` | `crosscuts-db-20261012-141502+1100-manual.7z` |
| pre-migration wrap | `crosscuts-premigrate-NNN-<source stamp>.7z` | `crosscuts-premigrate-016-20261013T034512.7z` |
| failed verification | `<any of the above>.unverified` | |

The date, time and offset are Sydney wall-clock at the start of the run. The time carries **seconds** (a refinement of the plan's `HHmm`, so two runs in one minute can never collide). The pre-migration stamp is copied verbatim from the `migrate.js` file name `photos-pre-NNN-<YYYYMMDDTHHMMSS>.db` (UTC, as `migrate.js` writes it).

```js
const DB_ARCHIVE_RE = /^crosscuts-db-(\d{8})-(\d{6})([+-]\d{4})(-manual)?\.7z$/;
const PREMIGRATE_ARCHIVE_RE = /^crosscuts-premigrate-(\d{3,})-(\d{8}T\d{6})\.7z$/;
const PREMIGRATE_SOURCE_RE = /^photos-pre-(\d{3,})-(\d{8}T\d{6})\.db$/;
const PHOTO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp|gif)$/i;   // the same rule as server.js PHOTO_PATH
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;                           // and not ending in .part
function sydneyStamp(now);              // {date: 'YYYYMMDD', time: 'HHmmss', offset: '+1100', iso: '2026-10-12T01:30:04+11:00'}
function dbArchiveName(now, manual);
function premigrateArchiveName(sourceName);   // or null if the source name breaks the rule
function parseArchiveName(name);        // {name, kind: 'nightly'|'manual'|'premigrate', localDate: 'YYYYMMDD',
                                        //  localMonth: 'YYYYMM', instant: Date} | null (.unverified → null)
function compareArchiveNames(a, b);     // by instant, then name
function isUploadName(name, kind);      // 'photo' | 'file': the regex, no leading dot, not *.part
```
`sydneyStamp` uses `Intl.DateTimeFormat('en-CA', {timeZone: 'Australia/Sydney', ..., timeZoneName: 'longOffset'})`.

### 5.2 What an archive holds (`manifest.js`)

```
photos.db            the verified copy (journal_mode DELETE)
MANIFEST.txt         key: value lines (below)
README-restore.txt   how to open it (below)
config/              every regular file in CONFIG_DIR except backup-passphrase, dotfiles, *.new and files over 64 KB
```
A pre-migration wrap holds `photos-pre-NNN-<stamp>.db` in place of `photos.db`, plus the same three.

`MANIFEST.txt` (parsed back by the restore CLI; one `key: value` per line, values never secret):
```
Crosscuts database archive
kind: nightly | manual | premigrate
made: 2026-10-12T01:30:04+11:00
app version: 0.1.7
database file: photos.db
database bytes: 2392064
database sha256: <64 hex>
migration count: 16
migration highest: 16
counts: users 9, jobs 120, week_rows 3401, photos 512, files 14
config files: gemini-api-key, joinr-api-key, joinr-base-url, nas-password, nas-url
```
Counts are only for tables that exist (an old-app `photos-pre-002` file has no `users`, no `files` and no `schema_migrations`: count and highest 0).

`README-restore.txt`: fixed text, nothing secret: this is an encrypted Crosscuts database archive; the passphrase is the Joinr Backup passphrase in the password manager (and on paper); on Windows open it with 7-Zip (right-click, 7-Zip, Extract files, enter the passphrase); on the Umbrel use the restore tool in the Crosscuts image; the full runbook is `docs/restore.md` in the joinr-crosscuts repository (`https://github.com/devcal1/joinr-crosscuts/blob/main/docs/restore.md`); never put this file in place of a running database.

```js
function manifestText(fields);     // the text above
function parseManifest(text);      // {kind, made, appVersion, databaseFile, databaseBytes, databaseSha256,
                                   //  migrationCount, migrationHighest, counts: {...}, configFiles: [...]} or null
function readmeText();
```

### 5.3 `takeSnapshot` (`snapshot.js`)

```js
// One snapshot, then retention, then the pre-migration wraps. Never throws. `signal` is the service's
// deadline signal (SNAPSHOT_DEADLINE_MS). Returns an outcome (section 1).
async function takeSnapshot(db, { trigger, signal, now = new Date() });
// Verified archives in ARCHIVES_DIR, newest first: [{name, kind, bytes, made (ISO)}]; plus {unverified: n}.
function listArchives();
```

Steps, in order (each failure stops the run with the reason in brackets):
1. 7-Zip resolved (`no_7zip`); `readPassphrase()` is `set` (`no_passphrase` / `passphrase_unusable`). The service checks both first; the job checks again.
2. Make `ARCHIVES_DIR`; empty and make `STAGING_DIR` (mode 700) and `STAGING_DIR/snap/`.
3. **Space:** `fs.statfsSync(DB_DIR)` free bytes (`bavail × bsize`) ≥ 3 × (size of `photos.db` + size of `photos.db-wal`) + 256 MB, else `no_space` (`detail.needBytes`, `detail.freeBytes`); nothing is pruned.
4. `db.exec("VACUUM INTO '<staging>/snap/photos.db'")` (quotes doubled), timed as `detail.vacuumMs` (`copy_failed`). This blocks the event loop for its duration (plan trap 6); the smoke measures it.
5. On a **fresh connection** to the copy: `journal_mode = DELETE`; `integrity_check` (simple) must be `ok` (`check_failed`); `SELECT COUNT(*) FROM schema_migrations` must equal the live count (`migrations_mismatch`); record the counts (§5.2). Close it. Timed as `detail.checkMs`.
6. sha256 of the copy (streamed).
7. Copy the config files (§5.2) into `snap/config/`, mode 600.
8. Write `MANIFEST.txt` and `README-restore.txt` into `snap/`.
9. `archive.create` into `STAGING_DIR/<name>`, `cwd` = `snap/`, entries `photos.db MANIFEST.txt README-restore.txt` plus `config` when it has files, level 5 (`archive_failed`, exit code kept).
10. `archive.test` with the passphrase (`test_failed`: the archive is renamed to `ARCHIVES_DIR/<name>.unverified`).
11. fsync the archive, rename it into `ARCHIVES_DIR/<name>`, fsync the folder (fsync errors on Windows ignored).
12. Retention (§5.6); `detail.pruned` = files removed.
13. Pre-migration wraps (§5.5).
14. `finally`: empty `STAGING_DIR` (the plaintext copy and the config copies never outlive the run).

A deadline or `ToolAbortError` → `timeout`. Any unexpected error → `other`, logged as `[backup] snapshot: unexpected error (<safe code>)`.

`detail` on success: `{archive, archiveBytes, dbBytes, counts: {users, jobs, weekRows, photos, files}, migrations, vacuumMs, checkMs, archiveMs, durationMs, pruned, premigrateWrapped, premigrateFailed}`.

### 5.4 `.unverified`

A file that fails step 10 is kept as `<name>.unverified` in `ARCHIVES_DIR` for inspection. It is never counted, listed as an archive, sent, or restored by the CLI without `--unverified`. Retention keeps the newest 3 and removes older ones. The plaintext staging copy is always removed (step 14).

### 5.5 Pre-migration wraps

After every successful snapshot, each `BACKUPS_DIR/photos-pre-NNN-<stamp>.db` (written by `migrate.js`) that has no `crosscuts-premigrate-NNN-<stamp>.7z` in `ARCHIVES_DIR` is wrapped once: `integrity_check` on a read-only connection to the source, a staging folder with the source file (copied, not moved), `MANIFEST.txt` (`kind: premigrate`), `README-restore.txt` and `config/`, then create, test and rename as steps 9–11. **The source `.db` is never moved, changed or deleted.** A wrap failure doesn't fail the snapshot: it counts in `detail.premigrateFailed`, is retried by the next snapshot, and raises a bell (§11.1). Wraps are never pruned locally. This also puts the cutover's `photos-pre-002-…` file offsite automatically.

### 5.6 Local retention (`retention.js`, pure; Finance `retention.ts` ported)

```js
// names: every file name in ARCHIVES_DIR. Returns which verified archives to keep and remove.
function retain(names, now);   // {keep: Map<name, 'daily'|'monthly'|'manual'|'premigrate'>, remove: [names, oldest first],
                               //  future: [names dated more than 24 h after now: never removed]}
function pruneUnverified(names);  // the .unverified names to remove (all but the newest RETAIN.unverified by name)
```
- **Nightly:** the newest archive of each Sydney date in the name; the archives of the **14 newest dates that have one** (not the last 14 calendar days, so an outage never eats them); plus, for each calendar month from `now`'s Sydney month back 11 months, the newest nightly dated in that month.
- **Manual:** the newest 10.
- **Pre-migration:** all kept.
- A name that breaks the rules is not an input and is never removed.

Removal is `fs.unlink` on the listed names only, after a successful snapshot only. **Nothing on the NAS is ever pruned** (decision 8).

## 6. The copy to the NAS (Wave 1 B: `copy.js`, `rsync.js`, `listing.js`, `plan.js`, `ledger.js`)

```js
// One copy. Never throws. `signal`: the service's deadline signal (COPY_DEADLINE_MS). `runner`: injectable
// for tests (default runRsync). Returns an outcome (section 1).
async function copyToNas(db, { trigger, signal, now = new Date(), runner });
```

### 6.1 Layout on the NAS

`<base>` = `checkNasUrl(nas-url).url` (ends in `/`).

| Folder | Local source | Sent as | Form |
|---|---|---|---|
| `<base>db/` | verified archives in `ARCHIVES_DIR` (nightly, manual, pre-migration) | the same name | already encrypted |
| `<base>files/` | regular files in `uploads/files/` matching `FILE_NAME_RE` (including soft-removed ones, still on disk) | `<stored name>.7z`, one per file | encrypted per file (§6.6) |
| `<base>photos/` | regular files at the top of `uploads/` matching `PHOTO_NAME_RE` (photos and `-thumb.webp` thumbnails) | the same name | plain (decision 2) |

Skipped everywhere: `*.part`, dotfiles, anything not a regular file (`lstat`), `.unverified`. **Never sent:** the live `photos.db*`, anything in `config/` (it travels only inside the encrypted archives), `backup-passphrase` (in no archive at all), the plain `photos-pre-*.db` files (only their wraps).

Each folder is created by the first send (rsync makes one missing folder level). Nothing on the NAS is ever deleted or renamed by the app. A file the NAS holds at a different size is sent again (rsync writes a hidden temporary and renames it, so a half-written photo is replaced, plan trap 7). Photos deleted in the app stay on the NAS.

### 6.2 Flow (per folder, in `NAS_FOLDERS` order)

0. `readNas()` must be `ready` (else the outcome is the config reason `nas_off`/`nas_half`/`nas_invalid`, `attempted: false`; the service normally never calls it then). rsync and 7-Zip resolved (`no_rsync`, `no_7zip`).
1. **List** the folder (§6.4). Exit 0 → parse. Exit 23 with `No such file or directory` on stderr → the folder doesn't exist yet: empty. Else classify (`list` phase) and stop.
2. **Local set** with sizes (`lstat`), and the **plan** (§6.5).
3. **Send** in batches, newest first: `db/` in one batch; `photos/` up to 500 paths per rsync run; `files/` per §6.6. Exit 0, 23 or 24 → go on to the proof (24 = a source vanished, e.g. a photo deleted meanwhile); anything else → classify (`send` phase) and stop.
4. **Relist** and **prove**: every file sent must be on the NAS at its planned size (`files/`: the ledger's `blob_bytes`). A sent source that no longer exists locally counts as `vanished`, not missing. Missing > 0 → `not_verified`. A relist failure → `readback_failed`.

A failure in one folder stops the copy; folders already proved keep their counts in `detail`. `detail = {attempted, folders: {db: F, files: F, photos: F}, sent, alreadyThere, missingAfter, bytes, durationMs}`, `F = {local, alreadyThere, sent, missingAfter, vanished, bytes}` (`files` adds `encrypted`).

### 6.3 rsync (`rsync.js`)

```js
function listArgs(folderUrl);            // [...RSYNC_FLAGS, '--list-only', '--', folderUrl]
function sendArgs(sources, folderUrl);   // [...RSYNC_FLAGS, '--', ...sources, folderUrl]  (sources: absolute local paths)
async function runRsync(args, { password, signal, outputLimit });  // runTool('rsync', args, {extraEnv: {RSYNC_PASSWORD: password}, ...})
function classify(phase, code, stderr);  // section 6.8
function listingMeansEmpty(code, stderr);
```
**The flags are exactly `RSYNC_FLAGS`, plus `--list-only` for listings. Never** `--delete*`, `--partial`, `--inplace`, `--append*`, `--remove-source-files`, `-a`, `--archive`, `-r`, `--recursive`, `--mkpath`, `--files-from`, `--password-file`, `-e`/`--rsh`, or anything else (`ci/backup-guard.js`, §16.1). The password goes **only** in the child's `RSYNC_PASSWORD`, in the scratch environment of `runTool`. The address goes only in the final argument.

### 6.4 Listing (`listing.js`, pure; Finance `listing.ts` ported)

`parseListing(text, nameOk)` → `[{name, bytes}]`: only lines matching
`/^(-[rwxsStT-]{9})[.+@]?\s+([\d,]+)\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})\s(.+)$/` (regular files); the name is the whole remainder; kept only when `nameOk(name)` (the folder's rule; `files/` names are `<FILE_NAME_RE>.7z`); a name listed twice gets size `NaN` (re-sent and proved, the safe way). A truncated listing (`outTruncated`) is a failure (`other`), never "the NAS lacks these". Listing output limit 16 MB.

### 6.5 Plan (`plan.js`, pure)

`planFolder(local, remote, expectedSize)` → `{alreadyThere: n, toSend: [{name, source, bytes}]}`: a local file is already there when the NAS lists its name at `expectedSize(file)` (the local size; for `files/` the ledger's `blob_bytes`, or "unknown" with no ledger row). Everything else is sent. `toSend` is newest first: `db/` by `compareArchiveNames` reversed, the others by mtime.

### 6.6 Private files: encrypt, send, forget the copy

For each `files/` batch (at most 50 files or 512 MB of source):
1. For each file: `archive.create` into `STAGING_DIR/blobs/<name>.7z` with `cwd` = `uploads/files`, entry = the bare name, level 1; `archive.test`; on either failing → `encrypt_failed` (retryable) and stop.
2. `ledger.recordEncrypted(db, name, sourceBytes, blobBytes)`.
3. A file that had **no** ledger row and whose new `blob_bytes` equals the size the NAS lists is counted `alreadyThere` and not sent (a ledger lost with an older database doesn't cause a re-send).
4. One rsync send of the batch's blobs to `<base>files/`.
5. Delete the batch's staging blobs, whatever happened (a private file is never kept twice on the Umbrel; the ledger holds the size, and a later missing or wrong-size blob is simply encrypted and sent again).

### 6.7 The ledger (`ledger.js`)

```js
function get(db, storedName);                                   // row or null
function recordEncrypted(db, storedName, sourceBytes, blobBytes);
function markSent(db, storedNames);                             // sent_at = now
function markProven(db, storedNames);                           // proven_at = now (after the relist)
function counts(db);                                            // {tracked, proven}
```
Rows are never deleted by the app.

### 6.8 Classifying a failure (Finance `sentences.ts` ported)

stderr is matched **only** against these fixed patterns and is never stored, logged or returned:

| Phase, exit code | Reason |
|---|---|
| any phase, stderr `/max connections/i` | `other` |
| any phase, stderr `/read only|write only/i` | `nas_io` |
| 5 with `/auth failed/i` | `auth` |
| 5 with `/unknown module/i` | `unknown_module` |
| 5 otherwise | `refused` |
| 35 | `unreachable` |
| 10 at the first listing | `unreachable` (connection refused) |
| 10 later, 12 | `broken` |
| 30, or the copy deadline | `timeout` |
| 11 at the first listing | `other` |
| 11 or 23 on a send | `nas_io` (23 on a send goes to the proof first) |
| any failure of the relist | `readback_failed` |
| the proof finds files missing | `not_verified` |
| `ToolMissingError` | `no_rsync` / `no_7zip` |
| anything else | `other` |

A refusal (`auth`, `unknown_module`, `refused`) seen while `nas-url` or `nas-password` changed during the run (mtime differs from the start) is recorded as `other`, so a helper run mid-copy never engages the lock.

## 7. The schedule and the service (Wave 2 D: `schedule.js`, `index.js`)

### 7.1 Slots

- **Snapshot slot:** nightly at 01:30 Sydney. `snapshotSlot(now)` = the Sydney date `D` such that Sydney wall-clock is on or after `D 01:30` and before `D+1 01:30` (if the clock is before 01:30, it is yesterday's date). Computed from `sydneyParts(now)` (hour, minute) and `addDays` (calendar arithmetic, never `+ 24 h`). 01:30 exists on both daylight-saving change days.
- **Copy slot:** Saturday at 01:30 Sydney. `copySlot(now)` = the latest Saturday date whose 01:30 has passed: `back = (weekday − 6 + 7) % 7`, and `back = 7` when it is Saturday before 01:30.
- A run's slot: scheduled runs store `slot`; a manual run counts for `slotOf(kind, started_at)`.

```js
function snapshotSlot(now); function copySlot(now);              // Sydney 'YYYY-MM-DD'
function sydneyInstant(date, hour, minute);                      // the UTC Date of that Sydney wall-clock time
function nextSnapshotAt(now); function nextCopyAt(now);          // the next 01:30 / Saturday 01:30, as a Date
```

### 7.2 Settled, attempts and retries (per kind)

A slot `S` is **settled** when any of these holds:
- (a) `S` ≤ the seed slot for that kind (§7.4);
- (b) a **succeeded** run of that kind, any trigger, has `slotOf(started_at) = S` (so a Back up now after 01:30 settles that night, and a successful Saturday-week manual copy settles the Saturday);
- (c) a failed run for `S` has a reason in `NON_RETRYABLE`;
- (d) `S` already has `MAX_ATTEMPTS` (4) **real attempts**: failed runs for `S` other than `interrupted`.

**Retry gate:** after the *n*-th real attempt for `S` (n = 1..3), the next may start no earlier than that run's `finished_at` + `RETRY_DELAYS_MIN[n−1]` (1 h, 2 h, 4 h). It applies to both kinds, except after a refusal (`auth`, `unknown_module`, `refused`): there the refusal lock (§7.6) is the only gate, so the copy tries again on the first tick after the helper places the files.

### 7.3 Due, the tick and the triggers

A kind is **due** at `now` when the schedule is on (§7.8), its job can run (snapshot: `toolsStatus().sevenZip` and `passphraseStatus().state === 'set'`; copy: `nasStatus().state === 'ready'`, rsync and 7-Zip present, and the refusal lock clear), its current slot is not settled, the retry gate has passed, and the catch-up gate has passed (no timer run before process start + 5 minutes).

**The tick** (every `CHECK_MS`, `setInterval`, `unref()`): if a flight is running, return. Otherwise, if the snapshot is due, run it; then re-check the copy and, if due, run it **in the same flight**; else if only the copy is due, run it. On Saturday at 01:30 this gives snapshot then copy. Then the overdue check (§11.1). Every promise is caught (an unhandled rejection would stop the board); a tick that throws logs `[backup] tick failed (<safe code>)` and the next tick carries on.

**Trigger** of a timer run: `startup` when `sydneyInstant(slot, 1, 30)` is earlier than the process start (the catch-up of a slot missed while the app was stopped), else `schedule`. A run's `attempt` is the slot's real attempts + 1.

### 7.4 First start

`start(db)`, after `listen`, unless `BACKUP_DISABLED=1`:
1. Mark any `backup_runs` row still `running` as `failed`, reason `interrupted`, `finished_at` now (a crash or stop mid-run; not counted as an attempt).
2. Empty `STAGING_DIR`.
3. If `backup.seeded_at` is null: set it to now, `backup.snapshot_seed_slot` = `snapshotSlot(now)` and `backup.copy_seed_slot` = `copySlot(now)`, and log `[backup] first start: slots seeded, nothing run`. A fresh install (or the first start after the cutover load) therefore doesn't fire straight away: the first snapshot is the next 01:30, the first copy the next Saturday (or Back up now sooner).
4. Log the start banner: `[backup] 7-Zip: <version line or "missing">; rsync: <version line or "missing">; schedule on|off`.
5. Unless `BACKUP_SCHEDULE_DISABLED=1`: start the timer.

### 7.5 Single flight

One flight at a time, in memory (`index.js`): a flight is a snapshot, a copy, or a snapshot then a copy. The timer and Back up now share it. While a flight runs, `status().running` = `{kind, trigger, startedAt}` of the job in progress. Each job is recorded: insert the `backup_runs` row (`running`) before it starts, update it with the outcome after; the deadline (`AbortSignal.timeout`) is per job.

### 7.6 The refusal lock

The copy is **locked** when the newest copy run with `detail.attempted = true` (excluding `running`) failed with a reason in `REFUSAL_REASONS` (`auth`, `unknown_module`, `refused`), and neither `nas-url` nor `nas-password` has an mtime later than that run's `started_at`. While locked, the timer never runs the copy and Back up now answers 409 (§9), so repeated bad logins can't get the Umbrel blocked by ADM Defender. **It clears** when the helper places either NAS file again (its mtime is newer); the next tick (or Back up now) then tries once more. The lock is computed, not stored.

```js
function isSettled(kind, slot, runs, seedSlot);
function realAttempts(runs, slot);
function retryAt(runs, slot);            // Date or null
function isLocked(copyRuns, mtimes);
function isOverdue(kind, { runs, now, state, seededAt });   // section 11.1
function triggerFor(slot, processStartedAt);
```
`runs` are `backup_runs` rows of one kind, with `detail` parsed (unknown keys dropped).

### 7.7 Back up now

`requestRun(db, req)` → `{status, body}`, checked in this order:
1. A flight is running → **202** `{running: true, joined: true}` (nothing new starts; the page polls).
2. `BACKUP_DISABLED=1` → **409** "Backups are switched off on this server."
3. The snapshot can't run (7-Zip missing, passphrase missing or not usable) → **409** with the §8 sentence for that state.
4. The NAS is `ready` and the refusal lock holds → **409** with the fix-first sentence (§8). (Integrator's call: the whole button waits, so the lock is seen and fixed, not worked around.)
5. A snapshot **succeeded** less than 10 minutes ago (any trigger, by `finished_at`) → **429** `{error: "A good snapshot was taken less than 10 minutes ago. Try again in N minutes.", retryAfterSeconds}`.
6. Otherwise start a flight: the snapshot (trigger `manual`, `requested_by`, a `-manual` name), then the copy **if the NAS is `ready`** (it runs even if the snapshot failed: it still sends whatever else the NAS lacks). Audit `backup.run` (§11.2). → **202** `{running: true, joined: false, copy: bool}`.

The request returns at once; the run continues in the background (a copy can take up to 30 minutes, longer than any request should wait).

### 7.8 Switches

| Env | Effect |
|---|---|
| `BACKUP_DISABLED=1` | the kill switch: `start` does nothing at all (no sweep, no seeding, no timer); `status().enabled = false`; Back up now 409. As `ROUNDUP_DISABLED`. Not set in the compose file. |
| `BACKUP_SCHEDULE_DISABLED=1` | **CI only** (`ci/smoke.sh`): no timer (no scheduled runs, catch-up, retries or overdue bells); Back up now and the status still work. Never set in the compose file. |
| `BACKUP_7Z` | local development only (§4.3). |

## 8. Sentences (`lib/backup/sentences.js`, scaffold, complete)

Numbers are the only variables. No sentence contains a path, address, account, module, value or tool output.

```js
function snapshotSentence(run);      // from {status, reason, exitCode, detail}
function copySentence(run);
const COPY_TAIL = "The backups on the Umbrel are not affected.";
const SNAPSHOT_TAIL = "The live database is not affected.";
const FIX_FIRST = "The NAS refused the last copy's password or module. Place the NAS files again with the backup helper first: repeated refusals could make the NAS block the Umbrel.";
```

**Snapshot** (failures end with `SNAPSHOT_TAIL`):

| Reason | Sentence |
|---|---|
| success | Succeeded: a {size} archive ({users} users, {jobs} jobs, {weekRows} board rows), tested with the passphrase. |
| `no_passphrase` | Snapshots are off: the backup passphrase is not on the server. Place it with the backup helper. |
| `passphrase_unusable` | The backup passphrase file is not usable (one line, at least 12 characters). Place it again with the backup helper. |
| `no_7zip` | 7-Zip is missing from the app image, so no archive can be made. |
| `no_space` | There is not enough free space on the Umbrel for a snapshot ({need} needed, {free} free). Nothing was pruned. |
| `copy_failed` | The database copy could not be written. |
| `check_failed` | The database copy failed its integrity check, so it was not kept. |
| `migrations_mismatch` | The database copy did not match the live database's migration level, so it was not kept. |
| `archive_failed` | 7-Zip could not make the archive (exit code {code}). |
| `test_failed` | The archive was made but did not open again with the passphrase (7-Zip exit code {code}). It was set aside as unverified. |
| `timeout` | The snapshot took longer than 10 minutes and was stopped. |
| `interrupted` | The snapshot was cut short when the app stopped. |
| `other` | The snapshot failed. |

**Copy** (failures end with `COPY_TAIL`; "(rsync exit code {code})" is added before the full stop when a code is known, for `auth`, `unknown_module`, `refused`, `unreachable`, `timeout`, `broken`, `nas_io`, `readback_failed`, `other`):

| Reason | Sentence |
|---|---|
| success | Succeeded: {sent} sent, {alreadyThere} already there, proved on the NAS. |
| `nas_off` | The copy to the NAS is not set up. |
| `nas_half` | The copy to the NAS is half set up: {nas-url \| nas-password} is missing. Run the backup helper again. |
| `nas_invalid` | {nas-url is not an rsync://account@IP/module address \| nas-password is not usable}. Run the backup helper again. |
| `auth` | The NAS refused the password in nas-password. Check the rsync account on the NAS, then place the password again with the backup helper |
| `unknown_module` | The NAS has no rsync module by the name in nas-url. Check the module on the NAS, then place the address again |
| `refused` | The NAS refused the connection, usually because of a wrong password or module name |
| `unreachable` | The NAS did not answer. Check it is switched on and reachable over Tailscale |
| `timeout` | The copy to the NAS stalled and was stopped. No incomplete file is left under a backup's name on the NAS |
| `broken` | The connection to the NAS broke part way through. No incomplete file is left under a backup's name on the NAS |
| `nas_io` | The NAS could not store or list the files: it may be full, or the rsync account may not be allowed to write the folder |
| `not_verified` | rsync reported success, but {missing} of {total} files are not on the NAS at the right size. |
| `readback_failed` | The files were sent, but the NAS could not be read back, so the copy is not proved |
| `encrypt_failed` | A private file could not be encrypted, so the copy stopped. It will be tried again. |
| `no_rsync` | rsync is missing from the app image, so nothing can be copied. |
| `no_7zip` | 7-Zip is missing from the app image, so the private files can't be encrypted. |
| `interrupted` | The copy was cut short when the app stopped. |
| `other` | The copy to the NAS failed |

## 9. API (`routes/backup.js`, `defineRoutes('/api/backup')`)

| Route | Access | Behaviour |
|---|---|---|
| `GET /status` | `users.admin` | 200 `status(db)` (below) |
| `POST /run` | `users.admin` | §7.7: 202 / 409 / 429, `{error}` on 409 and 429 |

Logged out: 401 (the auth layer). Any other role: 403. The scaffold registers both as 501 stubs; D replaces them.

**`status(db)`**:
```js
{
  enabled: bool,                        // not BACKUP_DISABLED
  scheduleOn: bool,                     // enabled and not BACKUP_SCHEDULE_DISABLED
  tools: { sevenZip: bool, rsync: bool },
  running: null | { kind: 'snapshot'|'copy', trigger, startedAt },
  snapshot: {
    state: 'ready'|'off'|'invalid'|'no_7zip',          // passphrase set / missing / not usable; 7-Zip missing
    passphrase: 'missing'|'not_usable'|'set',
    last: Run|null, lastSuccess: Run|null,
    nextAt: ISO|null,                                    // the next 01:30, or the retry/catch-up gate when due; null when the schedule is off
    retryAt: ISO|null, overdue: bool
  },
  copy: {
    state: 'ready'|'off'|'half'|'invalid'|'locked',
    files: { nasUrl: 'missing'|'not_usable'|'set', nasPassword: 'missing'|'not_usable'|'set' },
    locked: bool, last: Run|null, lastSuccess: Run|null,
    nextAt: ISO|null, retryAt: ISO|null, overdue: bool
  },
  archives: [{ name, kind: 'nightly'|'manual'|'premigrate', bytes, made }],   // newest 10 verified
  totals: { archives: n, archiveBytes: n, unverified: n, blobsTracked: n, blobsProven: n },
  recent: [Run]                                          // the newest 10 runs of both kinds
}
// Run: {id, kind, trigger, startedAt, finishedAt, status, reason, exitCode, sentence, detail}
```
`sentence` is built by `sentences.js`. `detail` holds only counts, bytes, durations and archive names. **No address, account, module, path, file content or value appears in any response.**

## 10. The Users page: Backups section (Wave 2 D)

`public/users.html`, `users.js`, `users.css` additions only, after the Joinr section. House style: `hs-card`, `hs-sectionbar`, `hs-btn`/`hs-btn-primary`, `hs-table`, `hs-pill`; page classes prefixed `bk-`; colours from tokens only (`var(--teal-tint)` for good, `var(--orange-tint)` for failed, locked, overdue and "not set up"; no red); **no icons**; user-visible text via `textContent`; passes `node ci/style-check.js`.

- `<section class="card hs-card" id="backups" aria-labelledby="backupTitle">`, heading **Backups** (the bell links to `/users.html#backups`).
- Intro: "Every night at 1:30 am an encrypted copy of the database is kept on this server. Every Saturday at 1:30 am everything the NAS doesn't have yet is copied to it. The passphrase and the NAS password are placed with the backup helper and are never shown here."
- **Snapshots** (sub-bar): the state ("On", "Off: the backup passphrase is not on the server", "Not usable: …", "7-Zip is missing"); the last snapshot's sentence and time; the next run ("Next: tonight at 1:30 am" / "Next try: 3:45 pm" / "Not scheduled on this server" when `scheduleOn` is false); "Overdue: no good snapshot since …" when `overdue`.
- **Copy to the NAS** (sub-bar): the state ("Not set up", "Half set up: nas-password is missing", "Not usable: …", "Locked: " + the fix-first sentence, "Set up"); the last copy's sentence and time; the next run; overdue as above.
- **Archives on this server**: an `hs-table` (Made, Kind: "Nightly" / "Back up now" / "Before migration NNN", Size), newest 10, and a line with the totals ("14 archives, 31 MB; 2 unverified set aside").
- **Back up now** (`hs-btn-primary`, `id="backupRun"`): `POST /api/backup/run`; disabled while `running`; 202 shows "Backing up…" and polls `GET /api/backup/status` every 3 s until `running` is null, then shows the new sentences; 409/429 show `{error}` in orange in `role="status"`.
- Hint: "Back up now takes a snapshot and, when the NAS is set up, copies to it. It can't run again within 10 minutes of a good snapshot."
- Times in Sydney time with the page's existing `fmtDate`. The section loads with the page; it doesn't poll unless a run is in progress.

## 11. Bell, audit and logs

### 11.1 Bell (to every `users.admin` holder)

`notify.toUsers(db, notify.usersWithKey(db, 'users.admin'), payload, {dedupeUnread: true})`, `entityType: 'backup'`, `link: '/users.html#backups'`, the body is the run's sentence. No ntfy, no phone push, no heartbeat (decision 6).

| Kind | entityId | Title | When |
|---|---|---|---|
| `backup.failed` | `snapshot` | The database snapshot failed | every failed snapshot (any trigger) |
| `backup.failed` | `copy` | The copy to the NAS failed | a copy failure that is a refusal (the lock engages), non-retryable, or a slot's 4th attempt; not a manual copy's passing failure (the page shows it) |
| `backup.failed` | `premigrate` | A pre-migration backup could not be archived | `premigrateFailed > 0` |
| `backup.overdue` | `snapshot` | No good database snapshot for 2 days | snapshot `state ≠ off` and more than 48 h since the newest succeeded snapshot's `finished_at` (none yet: since `backup.seeded_at`) |
| `backup.overdue` | `copy` | No proven copy on the NAS for 8 days | NAS `state ≠ off` and more than 192 h since the newest succeeded copy (none yet: since the oldest attempted copy; none attempted: never) |

Overdue is checked on each tick and bells **at most once per Sydney day per kind** (`backup.overdue_alerted_<kind>`); dedupe then hides repeats while unread. `status()` reports `overdue` whether or not the schedule is on.

### 11.2 Audit

`backup.run` (entity `backup`, id `run`, actor only, no before/after) when Back up now starts a new flight. Not on 202-joined, 409 or 429. Scheduled runs are recorded in `backup_runs`, not the audit log.

### 11.3 Logs

Prefix `[backup]`. **Allowed:** kind, trigger, slot, status, reason, exit code, counts, bytes, durations, archive names, tool version lines, `safeErrorCode` / `safeSystemCode` codes. **Never:** a passphrase, password, address (any part: IP, account, module, port), a config value, a path under `/data`, an argument array, an environment, or anything rsync or 7-Zip printed. `sendError`'s 500 path logs the whole error, so nothing under `lib/backup/` may throw an `Error` whose message holds any of these. Examples: `[backup] snapshot succeeded (schedule, 2026-10-12): crosscuts-db-20261012-013004+1100.7z, 2.1 MB, vacuum 41 ms, 3.2 s`; `[backup] copy failed (manual): auth, exit 5`.

## 12. The helper: `tools/backup-secrets.mjs` (Wave 1 C)

A port of Finance's `tools/deploy/nas-secrets.mjs` (read it and its `lib.mjs`). ESM, Node 24, no dependencies, outside the Docker context. It holds no secrets, addresses or account names. It requires `crosscuts/app/lib/backup/nasurl.js` (via `createRequire`) for the address rule.

```
node tools/backup-secrets.mjs [--host <ssh alias>]                 place the passphrase and both NAS files (prompts)
node tools/backup-secrets.mjs --only nas|passphrase                place one group (e.g. after a refusal lock)
node tools/backup-secrets.mjs --check                              which files are on the Umbrel (mode, owner); never contents or size
node tools/backup-secrets.mjs --remove nas|passphrase|all [--yes]  delete them (the copy or the snapshots are off again)
node tools/backup-secrets.mjs --prompt-test                        rehearse the hidden prompt: read one entry, print only its length
node tools/backup-secrets.mjs ... --dry-run                        print every ssh command; no prompts, nothing sent
```
- `--host` defaults to `umbrel` (an alias in Todd's own `~/.ssh/config`, which is not in this repo); env `CROSSCUTS_SSH_HOST` also works. SSH with `BatchMode=yes` (key auth only).
- Todd runs it himself in PowerShell or Windows Terminal. It refuses a stdin that isn't a TTY (Git Bash's mintty) with Finance's `NOT_A_TERMINAL_MESSAGE` wording.
- **Prompts:** the address (shown as typed; checked with `checkNasUrl`; a warning, not a refusal, when the IP is outside `100.64.0.0/10`); the NAS password, hidden, twice; the passphrase, hidden, twice, at least 12 characters, with the reminder "Use the Joinr Backup passphrase from the password manager. A lost passphrase makes every archive useless." Values are kept exactly as typed except the line ending (the passphrase is never trimmed; the password and address are trimmed).
- **Values travel only on SSH stdin**, never in an argument, an environment variable, a file on the PC or a printed line (the dry-run shows `<stdin: secret>`). No remote command asks for a file's size or contents.
- **Remote steps** (paths built from validated constants): resolve `$HOME`; the folder `$HOME/umbrel/app-data/tenon-joinr-crosscuts/data/config` must exist (else exit 2 "Crosscuts is not installed on the Umbrel"); for each file `umask 077 && rm -f -- .<name>.new && cat > .<name>.new && chmod 600 -- .<name>.new`; verify `stat -c '%a %u'` is `600 1000`; then `mv -f` into place, **`nas-password` before `nas-url`**, the passphrase on its own. No `docker`, no `sudo` (umbrelOS 2.0's `umbrel` user isn't in the docker group, and the helper doesn't need it). The files are owned by uid 1000 because the helper runs as `umbrel`.
- After placing: "Placed. Crosscuts reads them on its next run: press Back up now on the Users page." Re-placing a NAS file clears the refusal lock (§7.6).
- Exit codes: 0 done; 1 failed (nothing changed, or the check named the problem); 2 usage, not a terminal, Crosscuts not installed, SSH unreachable; 130 aborted (Ctrl+C).

## 13. The restore CLI: `crosscuts/app/tools/restore.js` (Wave 1 A)

Runs inside the image with the app **stopped**, the data folder mounted at `/data`:
```
sudo docker run --rm --network none -it -v /home/umbrel/umbrel/app-data/tenon-joinr-crosscuts/data:/data \
  ghcr.io/devcal1/crosscuts-web:<installed version> node tools/restore.js <command> ...
```

| Command | What it does |
|---|---|
| `list` | the archives in `/data/db/backups/archives` (name, kind, size, made); no passphrase |
| `check <archive>` | extract to staging, check, print `MANIFEST.txt` and the counts; changes nothing |
| `db <archive> [--config] [--yes] [--unverified]` | restore the database (below) |
| `files <folder>` | decrypt every `<name>.7z` in `<folder>` into `/data/uploads/files/` |

- **Passphrase:** a hidden prompt on a TTY; otherwise one line read from stdin (CI). Passed to 7-Zip as `-p` (§4.4). Never printed.
- **`db`:** (1) refuse unless the archive's name passes `parseArchiveName` (or `--unverified` for a `.unverified` file); (2) "Have you stopped Crosscuts in umbrelOS? Type YES" (skipped by `--yes`); (3) extract into `/data/db/backups/.staging/restore-<stamp>/` (wiped at the end, and by the app's next start); (4) `MANIFEST.txt` parses, the database file's sha256 matches it, `integrity_check` is `ok`; (5) refuse (exit 3) if the archive's highest migration is **higher** than this image's (`db/migrations`, read with `listMigrations`): "This archive is from a newer Crosscuts. Restore it with an image at least as new." An older archive is fine: the app migrates it up on start, with its usual pre-migration backup; (6) rename `photos.db`, `photos.db-wal` and `photos.db-shm` (whichever exist) to `photos-before-restore-<stamp>.db`, `.db-wal`, `.db-shm` (**never deletes**: the three are renamed as one set, so an old WAL is never paired with the restored file); (7) move the restored file in as `photos.db`, with the mode and owner of the file it replaces, else `0644` and the owner of `/data/db`; (8) with `--config`: each file in the archive's `config/` is written to `/data/config` with **mode 600** and the owner of `/data/config`; an existing file with different contents is first renamed `<name>.before-restore-<stamp>`; (9) print the archive's counts and the restored file's counts side by side.
- **`files`:** for each `<FILE_NAME_RE>.7z`: skip if `/data/uploads/files/<name>` exists (count it); else extract to staging, move into place (`0644`, owner of the folder). Prints counts. Never overwrites.
- Requires only `lib/config.js`, `lib/backup/{constants,tools,archive,names}.js`, `manifest.js`, `db/migrate.js` (`listMigrations` only) and `better-sqlite3`. **Never `db/index.js` or `server.js`.**
- Exit codes: 0 done; 1 failed (nothing changed); 2 usage; 3 refused (newer archive, or not confirmed).

## 14. Docs (Wave 1 C)

- **`docs/restore.md` (new)**, plain English, Todd at the terminal with Claude reading back, `sudo docker` throughout (umbrelOS 2.0):
  - **A. Restore the database from an archive on the Umbrel:** stop the app; `restore.js list`, then `db <archive>`; start; check (login, board, counts against the printed ones). The `docs/rollback.md` rule applies: never put a newer-schema database under an older image (the CLI refuses it).
  - **B. The Umbrel is gone:** fetch `db/`, `photos/` and `files/` from the NAS with Todd's own NAS user (SMB or the ASUSTOR file manager); install Crosscuts on the new Umbrel and stop it; copy `photos/` into `data/uploads/` and the archive and `files/` folder somewhere under `data/`; run `restore.js files …`, then `restore.js db <archive> --config`; place the passphrase and NAS files with the helper; start and check.
  - **C. One photo or file:** fetch it from the NAS (a private file: open the `.7z` with 7-Zip on Windows and the passphrase) and copy it into `uploads/` or `uploads/files/`.
  - **The drill** (Backup · 6.1, then once a quarter, recorded in STATUS): restore the newest **NAS** archive into a throwaway container on a spare port, as the cutover rehearsal does; log in; compare counts with `MANIFEST.txt`; open a photo and a private file restored from the NAS; remove it all (it holds customer data).
  - **The refusal lock:** what it is and how the helper clears it. **Removing a file from the NAS by hand** (a client asks): with Todd's own NAS user; the app never does it. **Never** reuse another app's rsync account; Tailscale key expiry off on both nodes; ADM Defender must still admit `100.64.0.0/10`.
  - No address, account or module name: placeholders like `<NAS Tailscale IP>` only.
- **`docs/rollback.md`:** "The offsite NAS backup is **not decided yet**, so the local backups are the only copies" becomes a pointer: encrypted nightly archives are kept on the Umbrel and copied weekly to the NAS; see `docs/restore.md`. Part B's `docker` commands, if any, become `sudo docker`.
- **`docs/cutover.md`:** step 2's "Once the offsite NAS backup exists, copy it there too" and Decommission 2's "copy it to the offsite NAS once that exists" become: the `photos-pre-002-…` file written at the load is wrapped and sent automatically, and the first nightly archive after the load follows; **before uninstalling the old app, confirm both are on the NAS** (`db/` folder). Add after step 4: "☐ Users page, Backups: press Back up now; the snapshot succeeds and, with the NAS set up, the copy says proved on the NAS." Every `docker` command becomes `sudo docker` (umbrelOS 2.0).
- **`docs/auth.md`** (scaffold): one sentence (§1).

## 15. The store repo at Backup · 5.2 (stated here, not made now)

In `tenon-umbrel-store/tenon-joinr-crosscuts/` (push only with Todd's OK):
- `docker-compose.yml`: the new `image:` line only. No new volume (`data/config` is already mounted) and no `BACKUP_*` env.
- `umbrel-app.yml`: `version: '0.1.7'` (or whatever was released), `releaseNotes` (nightly encrypted snapshots, weekly copy to the NAS, Back up now on the Users page, plus 0.1.7's other changes), and `backupIgnore` gains:
  ```yaml
    - data/config/nas-password
    - data/config/backup-passphrase
    - data/db/backups/.staging
  ```
  beside the existing `data/db/photos.db-shm`. So umbrelOS's own backups never hold the archives' key next to the archives (plan trap 2), nor a half-made plaintext copy.

## 16. CI

### 16.1 `ci/backup-guard.js` (scaffold)

`node ci/backup-guard.js` in `publish.yml`, right after "Check the house style". Dependency-free. Scans `crosscuts/app/lib/backup/**/*.js`, `crosscuts/app/tools/restore.js` and `tools/backup-secrets.mjs` with comments stripped first (Joinr Backup's `codeLines` rule), and fails (exit 1, one line per problem) if:
- a string literal is any of `--delete` (or any `--delete-*`), `--del`, `--partial`, `--partial-dir`, `--inplace`, `--append`, `--append-verify`, `--remove-source-files`, `--remove-sent-files`, `-a`, `--archive`, `-r`, `--recursive`, `--mkpath`, `--files-from`, `--password-file`, `-e`, `--rsh`, `-P`;
- `RSYNC_FLAGS` in `constants.js` is not exactly `['--times', '--contimeout=10', '--timeout=120']`, or `--list-only` appears anywhere but `constants.js`;
- `shell: true` appears, or `exec`, `execSync`, `execFile` or `execFileSync` is taken from `child_process` (children are `spawn` with an argument array only; `db.exec` for `VACUUM INTO` is not a child and is fine);
- a `console.` line mentions `passphrase`, `password`, `nasUrl`, `RSYNC_PASSWORD`, `args`, `.out` or `.err`.

If it fails, fix the code, not the guard.

### 16.2 `ci/smoke.sh` (scaffold)

- `start_container` adds `-e BACKUP_SCHEDULE_DISABLED=1` (all containers; the old image ignores it).
- Step 0 adds: `docker exec "$CONTAINER" sh -c '(7zz i || 7z i) >/dev/null 2>&1'`, `rsync --version`, `test ! -e /etc/popt`, and prints the two version lines.
- After the M6 loop, before step k: `[ -f "$(dirname "$0")/smoke-backup.sh" ] && source "$(dirname "$0")/smoke-backup.sh"`.

### 16.3 `ci/smoke-backup.sh` (Wave 2 E)

Same rules as the M-suites: sourced, no shebang, no `set`, shared helpers and jars (`$ADMIN $SCHED $ACCT $DPM $SHOW`), `step "backup-…"`, no pristine-DB assumption. Helpers prefixed `bk_`. Test values only (e.g. account `ci-cc-backup`, module `ccnas`, port `8873`, a 24-character test passphrase and NAS password), never real ones.

**The stand-in NAS:** inside the app container, as `smoke-m6-intake.sh` runs its fake: `docker exec` writes `/tmp/bk-rsyncd.conf` (`use chroot = no`, `pid file`, module `[ccnas]` with `path = /tmp/fake-nas`, `read only = no`, `uid = root`, `gid = root`, `auth users = ci-cc-backup`, `secrets file = /tmp/bk-rsyncd.secrets` (mode 600), `refuse options = delete remove-source-files partial inplace append`), then `docker exec -d "$CONTAINER" rsync --daemon --no-detach --port=8873 --config=/tmp/bk-rsyncd.conf`, and waits until a `--list-only` answers. Config files are written and removed with `docker exec`.

**`bk_wait`** polls `GET /api/backup/status` every 0.5 s until `running` is null (60 s cap). **`bk_rewind`** moves every `backup_runs` `started_at`/`finished_at` back 11 minutes through `docker exec node` with `better-sqlite3` (CI only), so the 429 rule doesn't block the next Back up now.

Checks, in order:
1. **Access:** logged out `GET /status` and `POST /run` 401; `$ADMIN` 200; `$SCHED`, `$ACCT`, `$DPM`, `$SHOW` 403 on both.
2. **Nothing set up:** `snapshot.state == "off"`, `copy.state == "off"`, `enabled` true, `scheduleOn` false, `tools` both true; `POST /run` 409 with the no-passphrase sentence; no `backup_runs` rows; no `backup.run` audit.
3. **Passphrase not usable** (11 characters): `snapshot.state == "invalid"`; `POST /run` 409.
4. **Passphrase only:** `POST /run` 202 (`joined` false, `copy` false); `bk_wait`; the last snapshot succeeded; no copy row; an archive listed with kind `manual`; the archive file exists; inside the container: `7z t` with the passphrase exits 0; `7z t -p<wrong>` fails; `7z l -p<wrong>` output doesn't contain `photos.db` (names hidden); extracted with the passphrase, `photos.db` passes `integrity_check` and its `users`/`jobs` counts equal the live ones; `MANIFEST.txt` counts match; there's no `config/backup-passphrase` in it. An immediate second `POST /run` → 429 with `retryAfterSeconds`. `GET /api/audit?action=backup.run` has one row with the admin as actor.
5. **Event loop:** during a run, 20 `/healthz` calls each answer within 2 s; the snapshot's `detail.vacuumMs` is printed.
6. **Half set up:** only `nas-url` → `copy.state == "half"`; an address with a host name → `"invalid"`.
7. **The copy:** start the stand-in; place `nas-url` (`rsync://ci-cc-backup@127.0.0.1:8873/ccnas`) and `nas-password`; put a foreign file at `/tmp/fake-nas/photos/foreign-not-ours.jpg` and record its sha256 and mtime; upload a test photo (as admin) and a small PDF to the report library (as acct); `bk_rewind`; `POST /run` 202 (`copy` true); `bk_wait`; the copy succeeded with `missingAfter == 0`; on the stand-in: `db/` holds every verified archive at its local size, `photos/` holds the test photo and its thumbnail (plain, same sha256), `files/` holds `<stored name>.7z` that is not the plain file and that `7z x` with the passphrase turns back into a file with the `files` row's sha256; `backup_blobs` has the file with `proven_at` set; the archive made in this run contains `config/nas-url` and `config/nas-password` and no `config/backup-passphrase`; the foreign file is unchanged.
8. **Second run:** `bk_rewind`; `POST /run`; `bk_wait`; the copy succeeded with `folders.photos.sent == 0`, `folders.files.sent == 0` and `folders.db.sent == 1` (its own new archive only); the foreign file still unchanged; nothing on the stand-in was removed.
9. **Wrong password:** rewrite `nas-password` with a wrong value; `bk_rewind`; `POST /run`; `bk_wait`; the copy failed with reason `auth`, its sentence contains "refused the password" and ends with "The backups on the Umbrel are not affected."; `copy.locked` true and `copy.state == "locked"`; `POST /run` → 409 with the fix-first sentence; the admin has an unread `backup.failed` notification with entity `copy`; write the right password again → `copy.locked` false; `bk_rewind`; `POST /run` → the copy succeeds.
10. **Daemon down:** stop the stand-in (`pkill -f bk-rsyncd`); `bk_rewind`; `POST /run`; `bk_wait`; the copy failed with reason `unreachable`, the sentence starts "The NAS did not answer"; `copy.locked` false.
11. **No leaks:** the test passphrase, the NAS password, the full address, `ci-cc-backup`, `ccnas` and `8873` appear in none of: every `GET /api/backup/status` body seen, `GET /api/audit` (all rows), the admin's `GET /api/notifications`, and `docker logs "$CONTAINER"`.
12. **Restore drill:** a scratch `$WORK/bk-drill/{db,uploads/files,config,in}` with a dummy `db/photos.db` (one table, one row) and the newest archive and the test blob copied into `in/` (`sudo cp`, `docker cp`); `docker run --rm -i --network none -v "$WORK/bk-drill:/data" "$IMAGE" node tools/restore.js db /data/in/<archive> --config --yes` with the passphrase on stdin → exit 0; `db/photos.db` passes `integrity_check` and its counts equal the archive's `MANIFEST.txt`; `db/photos-before-restore-*.db` holds the dummy (never deleted); `config/nas-url` exists with mode 600; `restore.js files /data/in/files` puts the test file back with the right sha256; `restore.js db` with a wrong passphrase exits 1 and changes nothing.
13. **Clean-up:** stop the stand-in; remove `/tmp/fake-nas` and the three config files, so step k sees no backup set-up.

Optional, informational only (never a failure): print whether this image's 7-Zip accepts a passphrase on stdin (§18 item 2).

## 17. Waves and file ownership

**Two build waves** (Backup · 3.1 and 3.2).

| Step | Who | Owns (only these files) | Depends on |
|---|---|---|---|
| **Backup · 2.2 Scaffold** | integrator | `Dockerfile`, `db/migrations/016_backup.sql`, `lib/settings.js` (keys), `lib/backup/{constants,secrets,nasurl,tools,archive,names,sentences}.js` (complete), `lib/backup/{snapshot,copy,index}.js` (stubs with the binding signatures), `routes/backup.js` (two 501 stubs), `server.js`, `ci/backup-guard.js`, `.github/workflows/publish.yml` (guard step), `ci/smoke.sh` (§16.2), `docs/auth.md` | — |
| **Backup · 3.1 Wave 1, A: snapshot and restore** | worktree | `lib/backup/snapshot.js`, `lib/backup/retention.js`, `lib/backup/manifest.js`, `crosscuts/app/tools/restore.js` | scaffold |
| **Backup · 3.1 Wave 1, B: the copy engine** | worktree | `lib/backup/copy.js`, `lib/backup/rsync.js`, `lib/backup/listing.js`, `lib/backup/plan.js`, `lib/backup/ledger.js` | scaffold |
| **Backup · 3.1 Wave 1, C: helper and runbooks** | worktree | `tools/backup-secrets.mjs`, `docs/restore.md`, `docs/rollback.md`, `docs/cutover.md` | scaffold (`nasurl.js`) |
| **Backup · 3.2 Wave 2, D: schedule, service, routes, page, bell** | worktree | `lib/backup/schedule.js`, `lib/backup/index.js`, `routes/backup.js`, `public/users.{html,js,css}` (Backups section only) | A and B merged |
| **Backup · 3.2 Wave 2, E: the smoke** | worktree | `ci/smoke-backup.sh` | A, B merged; written against §9 in parallel with D, rebased on D before merge |
| **Backup · 4.1 Integrate** | integrator | merges; STATUS; `CLAUDE.md` Layout gains `lib/backup/`, `tools/restore.js` (in the image) and `tools/backup-secrets.mjs` | all |

**Merge order:** Wave 1: A, B, C (no shared files; C may merge any time). Wave 2: D, then E. A wave that needs a change in a scaffold file (constants, secrets, nasurl, tools, archive, names, sentences) reports it; the integrator makes the change on `main`.

**Worktree base:** each agent checks `git log -1` and resets to the commit the integrator names (worktrees have been created at an old commit before), and junctions `crosscuts/app/node_modules` from the main checkout.

**Local checks** (every task): `node --check` on every file; `bash -n` on shell; `node ci/style-check.js`; `node ci/backup-guard.js`; a shim boot on a fresh `.dev/<task>/` (`BACKUP_SCHEDULE_DISABLED=1` unless testing the timer). The dev box has Windows 7-Zip (`C:\Program Files\7-Zip\7z.exe`, 26.03) but **no rsync, no Docker and no jq**, so:
- A: runs the snapshot and `restore.js` locally with `BACKUP_7Z` pointed at Windows 7-Zip, and unit-checks `retention.js` and `names.js` with a node script (daylight-saving dates, the 14-dates rule across a gap, the 12-month window, manual 10, future-dated names).
- B: drives `copyToNas` with an injected fake `runner` (scripted listings and exit codes: empty folder 23, auth 5, 35, 10, 23/24 on send, a short relist), and unit-checks `parseListing` and `planFolder`. The real rsync runs first in CI.
- C: `--dry-run` for every mode and `--help`; the address rule against good and bad addresses; never a real address in any test or output.
- D: unit-checks `schedule.js` with a fake clock (01:29 vs 01:30 Sydney on both change days, Saturday before and after 01:30, settling by a manual success, the 1/2/4 h ladder, 4 attempts, the lock and its mtime clearing, seeding, overdue at 48 h and 192 h), the routes' 202/409/429 order, and the page in headless Edge (all states by stubbing `/api/backup/status`).
- E: `bash -n` only; **CI is the real test** of the copy, the archive and the restore drill.

## 18. Findings and to check

**Decided in these contracts** (integrator's calls, for Todd's attention only if he disagrees):
1. Archive names carry seconds (`HHmmss`), so two runs can't collide; the plan said `HHmm`.
2. Back up now returns **202** and runs in the background (the page polls); "joins a run in flight" is a 202 with `joined: true`. A 30-minute copy is too long to hold a request open.
3. While the refusal lock holds, Back up now is refused as a whole (409), not just its copy half.
4. The snapshot also retries after 1, 2 and 4 h (the plan only said so for the copy), within the same four-attempt cap.
5. Config is restored from an archive only with `restore.js db … --config` (case B), so restoring after a bad edit (case A) can't put back an older Joinr key.
6. The plan's 6.1 check "a second click sends 0" is really "sends only its own new archive": every Back up now makes an archive. The smoke asserts that.
7. Last-run times come from `backup_runs`; `app_settings` holds only the seeding and the once-a-day overdue marks.
8. Pre-migration wraps also carry `config/` (decision 10 says "each database archive").
9. `ci/backup-guard.js` is in the scaffold (as the plan's 2.2 says), so it guards Wave 1 from the start; E owns only the smoke.

**To check** (couldn't verify from here):
1. **Alpine's 7-Zip package.** `apk add 7zip` (community repo) and which names it installs (`7zz`, `7z`, or both). The runtime resolution and the Dockerfile's `7zz || 7z` cover either; the first CI build proves the package exists for both architectures.
2. **Passphrase on stdin.** Measured here: Windows 7-Zip 26.03 reads the password from a piped stdin when `-p` is absent, or given bare. But 7-Zip on Linux reads it with `getpass()`, and musl's `getpass` (Alpine) opens `/dev/tty` and fails without one, so stdin very likely doesn't work in the container. **Contracted: `-p<passphrase>` as an argument**, the exposure Joinr Backup accepts. The smoke prints the stdin result as information; if it works, switching is a one-file change in `archive.js`.
3. **rsync creating `db/`, `photos/`, `files/`** on the first send to a daemon module (one level). Expected from rsync's behaviour and Joinr Backup's mirror folder; the CI stand-in proves it, and the NAS at 6.1. A subfolder in `nas-url` must already exist on the NAS.
4. **Exit codes against a stopped daemon:** connection refused should be 10 at the first listing (classified `unreachable`); a silent host 35. The smoke checks the sentence; the real NAS switched off is not tested.
5. **`backupIgnore` with a folder** (`data/db/backups/.staging`): whether umbrelOS accepts a directory path there. Check when pinning at 5.2.
6. **The `umbrel` user can write `app-data/tenon-joinr-crosscuts/data/config/`** (owned by uid 1000 from the skeleton; the app's own files there are root's). `--check` proves it at 6.1, step 1.
7. **Stops leave a WAL:** the app has no SIGTERM handler, so a stop in umbrelOS may leave `photos.db-wal`/`-shm` (hence the restore CLI renames all three). A run cut short by a stop is marked `interrupted` at the next start. Not measured on the device.
8. **`VACUUM INTO` stall** at the live database's size (after cutover). The smoke prints `vacuumMs`; 6.1 reads it from the page's run detail.
9. **ADM Defender and connections.** A first copy with thousands of photos makes one rsync connection per 500 photos plus the listings. Expected to be fine with a correct password; watch the first real copy at 6.1.
10. **The NAS module's own `refuse options`.** Recommended for the NAS prep: `refuse options = delete remove-source-files` on the new module, if ADM lets it be set, so the add-only rule holds on the NAS side too.
11. **Tailscale from inside the container:** Finance reaches the same NAS by IP from its container; assumed the same here.
12. **Test archives after cutover.** Archives of test data stay in `archives/` and age out by retention; on the NAS they stay until Todd prunes them by hand (decision 11). The plain `photos-pre-NNN-*.db` files are still never pruned locally (unchanged `migrate.js` behaviour).
13. **The smoke writes `backup_runs` timestamps directly** (`bk_rewind`) to get past the 429 rule. CI only.
14. **The helper's SSH alias** `umbrel` must exist in Todd's `~/.ssh/config` (as Finance's helper assumes). Checked at 6.1 with `--check`.
