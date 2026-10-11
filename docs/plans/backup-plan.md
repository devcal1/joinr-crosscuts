# Crosscuts — Backup plan: nightly snapshots and an offsite copy to the NAS (2026-10-11)

Status: **draft for Todd (Backup · 1.2).** Nothing here is approved until the "Decisions" section is filled in (Backup · 1.3). Steps: Backup · 1.1 (audit, §1), Backup · 1.2 (this plan and its questions, §11).

Source of truth: brief §6.3 and D17 (weekly copy of the SQLite DB plus `uploads/` to the offsite NAS over Tailscale, several generations, a written and **tested** restore runbook; "not Backblaze"). Prior art, read-only: Joinr Backup (`tenon-quotr/apps/umbrel-backup/`) and Joinr Finance's NAS copy (`fpseven-fin/apps/server/src/nascopy/` and `src/backups/`). Both copy to the same ASUSTOR NAS.

**Scope:**
- a verified, encrypted snapshot of `photos.db`, taken on a timer and on demand;
- an add-only copy of the snapshots, the photos and the private files to the NAS over Tailscale;
- status, alerts and a **Back up now** button for admins;
- a helper that places the NAS password and the passphrase on the Umbrel without them ever passing through a chat or a file on the PC;
- `docs/restore.md`, drilled on the device before the milestone closes.

**Not in scope:**
- any in-app restore (restores stay a runbook step, with the app stopped);
- any deletion on the NAS;
- changes to the old app.

> This repo is public. The NAS's Tailscale address, the rsync account and module names, and every password and passphrase stay out of it, as Finance keeps its NAS details in a git-ignored private doc. This plan names none of them.

## 1. Audit findings (Backup · 1.1)

**Crosscuts today** (checked in the code):
- **Image.** `crosscuts/app/Dockerfile` is `node:24-alpine` with no `USER`, so the app runs as root. It has neither rsync nor 7-Zip.
- **Data.** The compose file in `tenon-umbrel-store/tenon-joinr-crosscuts/docker-compose.yml` mounts `data/uploads`, `data/db` and `data/config`. The `data/` skeleton is rsynced in as uid 1000 at install.
- **Database.** `photos.db` runs in WAL mode (`db/index.js`), so a raw file copy is unsafe. `db/migrate.js` already writes `VACUUM INTO` copies to `data/db/backups/photos-pre-NNN-<stamp>.db` before migrations. These are plain and never pruned. The cutover runbook uses the same `VACUUM INTO` plus `integrity_check` pattern.
- **Secrets are files in `CONFIG_DIR`, never settings rows:**
  - `gemini-api-key` (`lib/gemini.js:7`);
  - `joinr-api-key`, written mode 600 (`lib/joinr-config.js:10-45`);
  - `joinr-base-url`.

  `joinr-config.js` explains why: `app_settings` rows are audited in full and copied into backups.
- **Uploads are write-once:**
  - Photos and thumbnails have UUID names (`routes/photos.js:35`), and editing a photo never rewrites its file.
  - Deleting a photo removes its row and both files (`routes/photos.js:287-306`).
  - Report-library files and task attachments live in `uploads/files/<uuid>.<ext>` (`lib/files.js`). Removing one is soft and the file stays on disk (`lib/files.js:203`, `lib/reports.js:187`).
  - In-progress uploads are named `*.part`.
  - Report categories include payroll, BAS and bank reconciliations (`lib/reports.js:13`).
- **No phone push exists.** The brief mentions ntfy, but Todd dropped phone push in M2 (`m2-plan.md` decision 1), and the code has no ntfy anywhere. The only alert channel is the in-app bell (`lib/notify.js` `toKey` / `toUsers`).
- **Timers to copy the style of:** the Friday round-up (`lib/roundup.js`) and the 7:00 task reminder (`lib/tasks.js` `startReminder`). Both have a 60 s check, an env kill switch, first-start seeding, `unref()`, and their last run kept in `app_settings`. Sydney time helpers are in `lib/time.js`. Timers start in `server.js` after `listen`.
- **Admin settings precedent:** the Joinr section on `/users.html` sits behind `users.admin` (`routes/joinr.js:130-207`).
- **Feature keys are deliberately few** (`docs/how-to-add-feature-key.md`).
- **CI.** `ci/smoke.sh` sources `ci/smoke-mN-*.sh`. The M6 smokes run a stand-in service inside the app container with `docker cp` and `docker exec -d` (`ci/smoke-m6-intake.sh:94-95`), with no extra network or container.
- **Docs that point at this milestone:**
  - `docs/rollback.md` says "The offsite NAS backup is **not decided yet**".
  - `docs/cutover.md` steps 2 and decommission 2 say to copy `$SNAP` to the NAS "once that exists".
- **Manifest.** `umbrel-app.yml` `backupIgnore` lists only `data/db/photos.db-shm`.

**Joinr Backup** (`tenon-quotr/apps/umbrel-backup/`): a separate Umbrel app that backs up Joinr's cloud database.
- **NAS copy:** an rsync daemon module over Tailscale.
  - Flags are only `--times --contimeout=<10> --timeout=<120>` (`src/push.mjs:133`).
  - The password goes in the child's `RSYNC_PASSWORD` (`src/push.mjs:24, 238`).
  - The copy lists the NAS, sends whatever is missing or a different size, newest first, then proves it by listing again.
  - `--delete`, `--partial` and `--inplace` are banned by `test/read-only.test.mjs`.
  - A failed copy never fails the backup, and nothing is ever deleted on the NAS.
- **Archives:** 7-Zip AES-256 with encrypted names (`-mhe=on`; `src/attachments.mjs:353`, `src/lib/manifest.mjs:85`), tested before they are kept. The newest 16 are kept (`src/lib/constants.mjs:31`).
- **Write-once attachments:** encrypted one file at a time and never pruned.
- **Schedule:** Sunday 19:00 Sydney (`constants.mjs:84`), with catch-up.
- **Heartbeat:** an optional healthchecks.io ping.
- **Secrets:** one-line files placed over SSH by `scripts/umbrel-backup-secrets.ps1`.
- **Runbooks:** `docs/runbooks.md` R6, R6a and R6b, and `docs/restore-drill.md`.
- **Lessons learned:**
  - SFTP was rejected because ADM Defender auto-blocked the Umbrel.
  - The rsync account is scoped to one share, with no shell.
  - Tailscale key expiry must be off on both nodes.

**Joinr Finance** (`fpseven-fin`), the closest analogue: a Node + SQLite app that copies to the same NAS from inside its own image.
- **Local snapshots:** nightly at 02:30, by `VACUUM INTO` (`backups/copy.ts`).
  1. Write to a hidden temporary file.
  2. Switch the copy to `journal_mode=DELETE`.
  3. On a fresh connection, check `integrity_check` = ok and that the migration count matches the live database.
  4. fsync, rename atomically, then prune.
- **Space floor:** 2 × (db + wal) + 64 MB (`copy.ts:31`).
- **Retention:** the newest of each of the 14 newest dates, plus the newest of each of the last 12 months (`packages/schema/src/backups.ts:19`).
- **NAS copy** (`nascopy/`), Sunday 03:00 (`schema/src/nasCopy.ts:7-9`):
  - The same three rsync flags, the same list/plan/send/prove flow and fixed failure sentences.
  - A catch-up 5 minutes after start.
  - Retries after 1, 2 and 4 h.
  - A **refusal lock**: after "wrong password" or "no such module", nothing is retried until the secrets are placed again, so repeated bad logins can't get the Umbrel blocked by ADM Defender (RUNBOOK "The refusal lock").
- **No encryption.** Plain SQLite files reach the NAS (RUNBOOK:147), and there is no heartbeat (D132).
- **Secrets:** `data/secrets/nas-url` and `nas-password`, both or neither, read fresh on every run. They are placed by `tools/deploy/nas-secrets.mjs` (`pnpm umbrel:nas-secrets`):
  - a hidden prompt, with a `--prompt-test` rehearsal;
  - values sent on SSH stdin only;
  - mode 600, uid 1000;
  - `--check`, `--remove` and `--dry-run` modes;
  - no docker or sudo needed.

  The manifest's `backupIgnore` skips `data/secrets`.
- **NAS setup:** one rsync account and module per app (RUNBOOK:157, "Never reuse another app's rsync account"). Use the NAS's Tailscale **IP**: MagicDNS names don't resolve inside containers (RUNBOOK:158).
- **Testing:** there is no CI. A manual on-device smoke (`tools/deploy/smoke.mjs`) runs the image's own `rsync --daemon` as a scratch NAS, with `refuse options = delete remove-source-files partial inplace append`.

**Traps found:**
1. **Encryption.** Finance sends plain files, but Crosscuts holds more: client names, addresses and phones; password hashes (scrypt); the business's bank details; the audit log with IP addresses; and payroll and BAS reports in `uploads/files/`. If the database is encrypted but those reports are sent plain, the point is lost.
2. **The passphrase must not sit beside the archives.** umbrelOS's own Backups snapshot all of `app-data`. If a passphrase in `data/config` is not in `backupIgnore`, an umbrelOS backup holds both the archive and its key.
3. **A separate app can't see Crosscuts' data.** An Umbrel app can't mount another app's `app-data`, so a Joinr-Backup-style separate app has no clean way to reach `photos.db`.
4. **Alerts.** With no ntfy, a failure the bell reports is seen only when an admin opens Crosscuts. A dead Umbrel tells nobody.
5. **umbrelOS 2.0:** the `umbrel` SSH user is no longer in the docker group. The helper only writes files, so it's fine. But restore steps, and the existing `docs/cutover.md` commands, need `sudo docker`.
6. **Event loop.** `VACUUM INTO` blocks Node's event loop while it runs. At today's size it's well under a second; the smoke measures it.
7. **Half-written photos.** multer writes photos straight to their final name, so a copy taken mid-upload could catch half a file. The size check in the plan re-sends it next time.

## 2. Recommended architecture: in-app, inside the Crosscuts image

**Recommended: build it into Crosscuts, as Finance did.**
- D2 says one app and one container.
- The snapshot runs on the app's own database handle (no `docker exec`, no second app reaching into another's data).
- Status and alerts use the existing bell, roles and audit.
- There is one release flow.

**Costs:**
- rsync and 7-Zip are added to a public image (a few MB, no secrets).
- Backup code runs in the board's process.

  Mitigations:
  - rsync and 7-Zip run as child processes, so nothing heavy runs in Node.
  - Every promise is caught; the M6 rule applies: an unhandled rejection would stop the board.
  - Timers are `unref`'d, and there is a kill switch.

- Backups stop while the app is stopped. That's acceptable: nothing changes while it's stopped.

**Alternative: a separate "Crosscuts Backup" Umbrel app, like Joinr Backup.** Its run would be isolated from the board, but it can't reach `photos.db` without an Umbrel-unsupported cross-app mount or an export API in Crosscuts. That's more moving parts for no gain. Not recommended.

## 3. How it works, in one paragraph

Every night at 01:30 Sydney, Crosscuts writes a consistent copy of `photos.db` (`VACUUM INTO`), checks it, encrypts it into a 7-Zip archive with a passphrase only Todd holds, tests the archive and keeps it, pruning older ones. On copy days it then sends the NAS whatever the NAS lacks, using a dedicated rsync account and a module private to Crosscuts:
- the archives;
- new photos (plain);
- new private files (each encrypted);
- each pre-migration backup (encrypted, once).

It then lists the NAS back to prove every file arrived at the right size. Nothing on the NAS is ever deleted or changed by the app. Admins see the state and the last result on the Users page and can press **Back up now**. A failure or an overdue copy raises a bell alert, and optionally a heartbeat ping tells Todd's phone when no good run has arrived.

## 4. The snapshot (local)

- **When:** nightly at 01:30 Sydney, outside the 02:00–03:00 daylight-saving gap and repeat. The slot is computed with calendar arithmetic, as Finance's `schedule.ts` does. Also on **Back up now**.
- **Catch-up:** one run 5 minutes after start if the last slot was missed. First-start seeding, as in `roundup.js`, means a fresh install doesn't fire straight away.
- **Steps:** the copy is verified before it is kept, as in Finance `copy.ts`.
  1. Check free space: at least 3 × (db + wal) + 256 MB, or fail with "not enough space" and prune nothing.
  2. `VACUUM INTO` a hidden staging file in `data/db/backups/.staging/`.
  3. Open the copy on a fresh connection, set `journal_mode=DELETE`, and check:
     - `integrity_check` = `ok`;
     - `schema_migrations` count = live count;
     - `users`, `jobs` and `week_rows` counts are recorded.
  4. Write `crosscuts-db-YYYYMMDD-HHmm±HHMM.7z` with `7z a -t7z -mhe=on -p…`. It holds `photos.db`, a `MANIFEST.txt` (app version, migration level, counts, sha256 of the db) and `README-restore.txt` (how to open it, pointing to `docs/restore.md`).
  5. `7z t` with the passphrase.
  6. fsync, rename into `data/db/backups/archives/`, then prune.
  7. Wipe the staging folder (at start and in `finally`).
  8. If anything fails, the files are renamed `.unverified`. They are never counted and never sent.
- **Retention (local):**
  - nightly archives: Finance's rule, the newest of each of the 14 newest dates plus the newest of each of the last 12 months;
  - archives from **Back up now**: the newest 10.

  At today's size (a few MB per archive) that is well under 200 MB.
- **Pre-migration backups** (`photos-pre-NNN-*.db`, written by `migrate.js`) are untouched locally. Each is wrapped once into `crosscuts-premigrate-NNN-<stamp>.7z` in `archives/` so it reaches the NAS. This also puts the cutover's first snapshot (the `photos-pre-002-…` file written at the load) offsite automatically.
- **The passphrase** is passed as Joinr Backup does, unless the contracts find that 7-Zip on Alpine reads it from stdin. It is never logged. The `-p` argument is visible only to root inside the container while 7-Zip runs (an accepted exposure, as Joinr Backup's and Finance's `RSYNC_PASSWORD`).

## 5. The copy to the NAS

- **Target:** `rsync://<account>@<NAS Tailscale IP>/<module>/`, read from `config/nas-url`. The address rule copies Finance `checkNasUrl`: `rsync:` only, no password in it, a module plus at most one subfolder, an IP not a name.
- **Layout on the NAS:**

  | Folder | What goes in it | Form |
  |---|---|---|
  | `db/` | the archives | encrypted |
  | `photos/` | top-level images and thumbnails | plain (question 3) |
  | `files/` | `<stored name>.7z`, one per private file | encrypted |

  Each folder is created by the first send.
- **Flags:** only `--times --contimeout=10 --timeout=120`, plus `--list-only` for listings. A CI guard (`ci/backup-guard.js`) fails the build if `--delete`, `--partial`, `--inplace`, `--remove-source-files`, `--append` or `-a`/`-r` appear in `lib/backup/`.
- **Password:** passed only through `RSYNC_PASSWORD` in a child environment built from scratch (PATH and `LC_ALL=C`), as Finance `runner.ts` does.
- **Plan and proof** (Finance `copy.ts` / `plan.ts`), per folder:
  1. List the NAS.
  2. Send whatever is missing or a different size, newest first, in one rsync run.
  3. List again; every planned file must be there at the planned size.
- **Private files:** each one is encrypted into a staging `.7z` just before it is sent. Its size goes into a small ledger table, and the staging copy is deleted once proven. So a private file is never kept twice on the Umbrel, and a later missing or wrong-size blob on the NAS is re-encrypted and resent.
- **Skipped:** `*.part` files, dotfiles and anything that isn't a regular file.
- **Never sent:** the live `photos.db` and the whole `config/` folder. Every value in `config/` can be re-entered after a restore: the Joinr key can be re-issued in Joinr, the Gemini key re-pasted, and the NAS files placed again. Shipping them would put live API keys on the NAS.
- **Deleted photos stay on the NAS** (add-only). That protects against a mistaken delete. The runbook says how to remove one by hand if a client asks.
- **Failures:** fixed sentences from rsync exit codes, copied from Finance `sentences.ts`:

  | Exit code | Meaning |
  |---|---|
  | 5 | wrong password, or no such module |
  | 35 | the NAS did not answer |
  | 30 | stalled |
  | 10 / 12 | the connection broke |
  | 11 / 23 | the NAS could not store the files |

  rsync's own output is never shown or logged. Every sentence ends "The backups on the Umbrel are not affected."
- **Retries:** after 1, 2 and 4 h for passing reasons. The **refusal lock** applies after a refused password or module: no retry until a NAS file is placed again (its mtime is newer).
- **Limits:** a 30-minute deadline per copy (photos make the first one large), SIGTERM then SIGKILL.
- **Single flight:** one backup run at a time. The snapshot and the copy share the lock. **Back up now** joins a run in flight (409 when locked or not set up, 429 within 10 minutes of a success).
- **NAS retention:** the app keeps everything it sends. Pruning is by hand on the NAS (ADM's Btrfs snapshots are worth enabling on that share). Expected growth: one archive of a few MB per night, plus new photos.

## 6. Secrets and the helper

- **Files in `data/config/`,** each one line, read fresh on every run (no restart to rotate):

  | File | When needed |
  |---|---|
  | `nas-url` | the copy (both or neither with `nas-password`) |
  | `nas-password` | the copy |
  | `backup-passphrase` | the snapshot (at least 12 characters) |
  | `heartbeat-url` | optional, https only |

  `data/config` is already mounted (non-negotiable 4), so the compose file needs no change. The app only reads these files: it never writes, shows, logs or returns them. The API reports each as *missing*, *not usable* or *set*.
- **States:**
  - no passphrase: snapshots off, and the page says so;
  - passphrase but no NAS files: snapshots run, the copy is "not set up";
  - one NAS file only: "half set up".
- **The helper:** `tools/backup-secrets.mjs` in this repo, outside the Docker context like `tools/dev-sqlite-shim.js`. It holds no secrets. It is a port of Finance's `nas-secrets.mjs`:
  - Todd runs it himself in PowerShell; it refuses Git Bash's mintty;
  - a hidden prompt, with a `--prompt-test` rehearsal; the password and passphrase are asked twice;
  - values sent on SSH stdin only, to `umbrel@<Umbrel>` with key auth;
  - written to hidden temporary files with `umask 077`, checked, then moved into `/home/umbrel/umbrel/app-data/tenon-joinr-crosscuts/data/config/` as mode 600, uid 1000, password before address;
  - `--check` (modes and owner only, never contents or size), `--remove` and `--dry-run` modes;
  - no docker or sudo, so umbrelOS 2.0's docker-group change doesn't matter.
- **Manifest (store repo, at Backup · 5.2):** add `data/config/nas-password`, `data/config/backup-passphrase`, `data/config/heartbeat-url` and `data/db/backups/.staging` to `backupIgnore`.
- **Passphrase custody:** Todd's password manager plus a paper copy, kept as he already does for Joinr Backup's. **A lost passphrase makes every archive useless**, so the drill (§9) proves the stored copy opens one.

## 7. Status, alerts and audit

- **Where:** a **Backups** section on `/users.html`, behind `users.admin`, beside the Joinr section. It shows:
  - the state of the snapshot and the copy;
  - the last snapshot (time, size, counts);
  - the last copy's sentence ("Succeeded: 3 sent, 412 already there, proved on the NAS"), and the next run;
  - the newest archives;
  - **Back up now**.

  Routes go through `defineRoutes` with `users.admin` (`GET /api/backup/status`, `POST /api/backup/run`). No new feature key (question 7).
- **Data:** migration `016_backup.sql` (additive) adds:
  - `backup_runs`: id, trigger (`schedule`, `startup`, `manual`), kind, started and finished times, status, reason, exit code, and a detail JSON of counts and bytes, never paths or addresses;
  - `backup_blobs`: the private-file ledger.

  The last run times live in `app_settings`, as the round-up's does.
- **Bell alerts** to every `users.admin` holder, deduped per unread alert (`notify.toUsers` with `dedupeUnread`):
  - `backup.failed`: a snapshot failed, the copy hit the refusal lock, or retries were exhausted;
  - `backup.overdue`: no proven copy for one copy interval plus a day.
- **Heartbeat (optional):** with `heartbeat-url` set, it pings `/start`, success and `/fail`, with a 10 s timeout and one retry. It never affects the outcome. This is Joinr Backup's pattern, and it is the only alarm that fires when the Umbrel itself is dead (question 6).
- **Audit:** `backup.run` for **Back up now** (the actor, no detail). Scheduled runs are in `backup_runs`, not the audit log.
- **Logs:** counts, durations, reason and exit code only.
- **Kill switch:** `BACKUP_DISABLED=1` turns the timers off, as `ROUNDUP_DISABLED` does.

## 8. Image and CI

- **Dockerfile:** `RUN apk add --no-cache rsync 7zip && rsync --version && 7z i >/dev/null` (the exact Alpine binary name, `7z` or `7zz`, is confirmed at 2.2), so the build fails if either is missing. Also fail if `/etc/popt` exists, as Finance's Dockerfile does. Smoke step 0 checks both tools run.
- **Smoke file `ci/smoke-backup.sh`,** sourced by `smoke.sh`:
  - **The stand-in NAS** is `rsync --daemon --port 8873` inside the app container (`docker exec -d`), with a module rooted at `/tmp/fake-nas`, `auth users`, a mode-600 secrets file, and `refuse options = delete remove-source-files partial inplace append`.
  - Config files are written with `docker exec`.
  - `smoke.sh`'s `start_container` gains `-e BACKUP_SCHEDULE_DISABLED=1`, so the timer can't race the checks (ci/ only).
- **The smoke checks:**
  - **Setup states:** no files → "not set up" and no rsync runs; passphrase only → **Back up now** makes an archive that `7z t` accepts with the passphrase and refuses without it, whose listing hides names, and whose `photos.db` passes `integrity_check`.
  - **Copy:** with the NAS files set, the archive, a test photo and an encrypted test attachment arrive and are proven. A second run sends 0. A foreign file on the stand-in NAS is untouched.
  - **Failures:** a wrong password gives the auth sentence, the lock (409) and a bell alert, and placing the file again unlocks it. With the daemon stopped, "did not answer".
  - **Restore drill in CI:** extract the archive, `integrity_check`, and counts equal the live database.
  - **Access:** logged out 401, `users.admin` 200, scheduling role 403.
  - **No leaks:** the password, passphrase and address never appear in any API body, the audit log or `docker logs`.
- **Local runs:** Todd's Windows box has neither rsync nor 7-Zip. A local run checks the page and the "not set up" states only. **CI is the real test.**

## 9. Restore runbook and drill

`docs/restore.md` (new), plain English, Todd at the terminal with Claude reading back:
- **A. Restore the database from an archive on the Umbrel** (a bad edit, a corrupt database).
  1. Stop the app.
  2. Run `sudo docker run --rm --network none -it -v …/data:/data ghcr.io/devcal1/crosscuts-web:<installed version> node tools/restore.js <archive>`. This is a small CLI in the image: it prompts for the passphrase, extracts, checks integrity, renames `photos.db*` to `photos-before-restore-<stamp>.db*` (never deletes), puts the copy in place with the right owner, and prints the counts.
  3. Start the app and check it.

  The same check as `docs/rollback.md` applies: never put an older database under a newer image without the matching image rollback.
- **B. The Umbrel is gone.**
  1. Fetch `db/`, `photos/` and `files/` from the NAS with Todd's own NAS user (SMB or the file manager; the rsync account is upload-only in practice).
  2. Install Crosscuts on the new Umbrel and stop it.
  3. Copy them into `app-data/…/data`.
  4. Run the CLI in a "decrypt files" mode for `files/`, then run A.
  5. Place the NAS files and passphrase again with the helper, then re-enter the Joinr and Gemini keys.
- **C. One photo or file:** fetch it from the NAS (decrypt with 7-Zip on Windows) and copy it into `uploads/`.
- **Drill (Backup · 6.1, then once a quarter, recorded in STATUS):** restore the newest **NAS** archive, not a local one, into a throwaway container on a spare port, as the cutover rehearsal does.
  1. Log in.
  2. Compare the counts with `MANIFEST.txt`.
  3. Open a photo and a private file restored from the NAS.
  4. Remove it all.
- **Doc changes made in the build:**
  - `docs/rollback.md`: replace "not decided yet" with a pointer to `restore.md`.
  - `docs/cutover.md`: step 2 and decommission 2 say the first nightly archive after the load and the encrypted `photos-pre-002` file carry the snapshot offsite (confirm both on the NAS before uninstalling the old app). Add a **Back up now** check after step 4. Change `docker` to `sudo docker` for umbrelOS 2.0.

## 10. Steps (per `roadmap.md`)

| Step | What happens | Needs Todd |
|---|---|---|
| **Backup · 1.1** Audit | prior art and Crosscuts surveyed (§1) | — |
| **Backup · 1.2** Plan | this file; questions in §11 | **Todd** reads and answers ✂ |
| **Backup · 1.3** Decisions | answers recorded below; plan approved | **Todd** ✂ |
| *NAS prep (parallel; due by 6.1)* | on the NAS: a private shared folder; the rsync server on; a new rsync account allowed only on a new module for that folder; Todd's own NAS user given read access; Btrfs snapshots on the share; ADM Defender still admits `100.64.0.0/10`; Tailscale key expiry off on the NAS and the Umbrel | **Todd** (Claude guides) |
| **Backup · 2.1** Contracts | `backup-contracts.md`: files and modules (`lib/backup/` snapshot, copy, schedule, secrets, sentences), migration 016, the API, the Users page section, the CLI, the smoke checks, the waves | ✂ |
| **Backup · 2.2** Scaffold | Dockerfile tools; migration `016_backup.sql`; stub router (`users.admin`); `ci/backup-guard.js` wired into `publish.yml`; the next unreleased version (plus `package-lock.json`): **0.1.7** if nothing is pushed first, since local `db265a4` already took 0.1.7 for the board print fix and both ship in one push; otherwise 0.1.8; local boot | ✂ |
| **Backup · 3.1** Wave 1 | **A** the snapshot, retention and archive (with `tools/restore.js` in the image); **B** the copy: runner, plan, listing, proof, sentences, secrets reader, ledger; **C** the helper `tools/backup-secrets.mjs` and the `docs/restore.md` draft | ✂ |
| **Backup · 3.2** Wave 2 | **D** the schedule, catch-up, retries, lock, routes, Users page section, bell, heartbeat, audit; **E** `ci/smoke-backup.sh` with the in-container rsync daemon | ✂ |
| **Backup · 4.1–4.3** | integrate; independent review (secrets leakage, the add-only guarantee, event-loop stalls, timer safety); fix | ✂ each |
| **Backup · 5.1** Publish | push (Todd OK); CI green; `image:` line recorded | **Todd** ✂ |
| **Backup · 5.2** Pin | store: compose pin, `version:` (the release number), `releaseNotes`, the `backupIgnore` additions | **Todd** (push OK) ✂ |
| **Backup · 6.1** On device | Todd updates; then the checks below | **Todd** |
| **Backup · 6.2** Close | first scheduled copy seen succeeded; rollback and cutover docs final; STATUS closed | ✂ |

The Backup · 6.1 checks:
1. Todd creates the passphrase, then runs the helper: `--prompt-test`, `--dry-run`, place, `--check`.
2. Back up now succeeds, with "proved on the NAS". The NAS folder shows `db/`, `photos/` and `files/`. A second click sends 0.
3. The restore drill (§9), from the NAS.
4. The page and **Back up now** are checked over the LAN and over Tailscale.

## 11. Questions for Todd (Backup · 1.2), with recommended answers

1. **Architecture.** (a) *Recommended:* inside Crosscuts, as Finance does (§2). (b) A separate backup app, as Joinr Backup.
2. **Encryption.** (a) *Recommended:* the database archives and the private files (payroll, BAS, attachments) are encrypted with 7-Zip AES-256; the photos are sent plain. (b) Everything plain, as Finance (simplest; relies on the NAS folder's access list). (c) Everything encrypted, photos too (slower; every photo restore needs the passphrase).
3. **Passphrase.** (a) *Recommended:* a new passphrase just for Crosscuts, at least 12 characters, kept in your password manager and on paper, never in a chat. (b) Reuse Joinr Backup's.
4. **NAS share, account and module.** (a) *Recommended:* a new private shared folder, with its own rsync account and module for Crosscuts (Finance's rule; a wrong password or a lock affects only Crosscuts; payroll files stay apart). (b) A `crosscuts/` subfolder in an existing module, with that app's account.
5. **When.** The snapshot is nightly at 01:30 Sydney either way. (a) *Recommended:* copy to the NAS every night too, straight after the snapshot. This goes beyond D17's "weekly", but the cost is tiny and it cuts the loss window from a week of invoices and board edits to a day. (b) Weekly per D17: Saturday 01:30 (clear of Joinr Backup on Sunday 19:00 and Finance's Sunday 03:00).
6. **Heartbeat.** (a) *Recommended:* support an optional healthchecks.io ping (your Joinr Backup account), because Crosscuts has no phone push and a dead Umbrel otherwise tells nobody. (b) No heartbeat; the bell and the Users page only (Finance's choice).
7. **Who sees it.** (a) *Recommended:* `users.admin`, so you, with no new feature key. (b) A new `backup.view` key.
8. **Retention.** (a) *Recommended:* on the Umbrel, the 14 newest nightly dates, plus one per month for 12 months, plus the newest 10 manual archives. On the NAS, everything; the app never deletes there, and you prune by hand or with NAS snapshots. (b) Different numbers.
9. **Uploads.** (a) *Recommended:* photos and private files go across (add-only); photos deleted in the app stay on the NAS. (b) The database only.
10. **Config folder.** (a) *Recommended:* not backed up. After a disaster you re-enter the Joinr and Gemini keys and re-run the helper. (b) Include it, encrypted.
11. **Before cutover.** (a) *Recommended:* switch it on as soon as the release carrying it is installed, on test data, so the pipe and the restore drill are proven before cutover day. Test archives on the NAS can be pruned by hand after cutover. (b) Wait until cutover.

## Decisions (Backup · 1.3)

*Not yet answered.*
