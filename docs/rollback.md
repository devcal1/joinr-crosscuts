# Rolling back a release

A release has two parts that can be undone separately: the **app image** (the code) and the **database** (the data). Read this whole page first.

**Decide first.** Did the release add a migration (a new file in `crosscuts/app/db/migrations/`)?

- **Yes:** restore the database too, using the full sequence below.
- **No:** an image rollback alone is usually enough. Confirm with an engineer first.

**Warning: anything entered since the backup is lost.** That includes board edits, jobs, users, logins and audit entries. Photos uploaded after the backup stay on disk but disappear from the app.

**Other backups.** Besides the pre-migration files below, Crosscuts keeps encrypted nightly archives of the database on the Umbrel (`data/db/backups/archives/`) and copies them to the NAS every week. Each pre-migration file is also archived and copied there. To restore from one of those archives, or after losing the Umbrel, see [restore.md](restore.md).

## Order of steps

1. **A1 to A3:** prepare the rollback commit in the **tenon-umbrel-store** repo (repo access needed).
2. **B1 to B5:** stop the app and restore the database (Umbrel terminal or SSH needed).
3. **A4:** push tenon-umbrel-store, once Todd says so. There is no CI to wait for, because the older image is already published.
4. **B6 to B7:** click Update, start the app, and check it.

Do not click Update before step B5. Otherwise the older image starts on the newer database, which is unsafe.

## Part A: the image

The Umbrel pulls the image named in `tenon-joinr-crosscuts/docker-compose.yml` in the `tenon-umbrel-store` repo (`devcal1/tenon-umbrel-store`). That line pins the image by tag and digest, like `ghcr.io/devcal1/crosscuts-web:<version>@sha256:<digest>`. A rollback re-pins the previous tag and digest there, under a new manifest version. Nothing in this repo changes.

- **A1.** Find the previous known-good line. In `tenon-umbrel-store`, run `git log -p -- tenon-joinr-crosscuts/docker-compose.yml` and take the `image:` line from before the bad release, exactly as written (tag and digest). The run summary of that version's CI run in this repo shows the same line. Version tags are immutable, so that tag and digest still exist in `ghcr.io/devcal1/crosscuts-web`.
- **A2.** In `tenon-joinr-crosscuts/docker-compose.yml`, paste that line over the current `image:` line.
- **A3.** Bump `version:` in `tenon-joinr-crosscuts/umbrel-app.yml` to a **new, higher** number (not the old one), write a `releaseNotes:` line saying it is a rollback, and commit. Umbrel only offers an update when the manifest version differs from the installed one, so a rollback is still a new manifest version.
- **A4.** Push `tenon-umbrel-store`, only when Todd says so. Umbrel polls for changes roughly every five minutes.

Notes:

- The manifest version and the image tag can differ during a rollback. That is fine. Keep the manifest version rising.
- Do not release the bad code's version number again. `crosscuts/app/package.json` in this repo keeps its higher version, and the next fix must bump it, because the bad version's tag already exists and cannot be rebuilt.
- To fix forward instead: `git revert` the bad commit in this repo, bump `version` in `crosscuts/app/package.json`, push, and follow the release flow in [CLAUDE.md](../CLAUDE.md). Ask an engineer which fits.

## Part B: the database

Before pending migrations run on an existing database, the app writes `data/db/backups/photos-pre-NNN-<timestamp>.db`. `NNN` is the first migration pending on that start. A brand-new install has no backup.

To go back past an upgrade, use the backup from that upgrade: the one whose `NNN` is the lowest migration it applied. It holds the database from before any of those migrations ran. A newer schema on an older image is unsafe, so always restore in that case.

1. **[Umbrel web UI]** Stop Crosscuts.
2. **[Umbrel terminal or SSH]** Go to the Crosscuts `data/db` folder. Check the path with `ls` before doing anything else. On a standard umbrelOS install the app data is usually under `/home/umbrel/umbrel/app-data/tenon-joinr-crosscuts/`. This path has not been verified yet.
3. **[Umbrel terminal or SSH]** List the backups with `ls -l backups/` and choose the `photos-pre-NNN-…db` file for the upgrade you are undoing. (The `archives/` folder there holds the encrypted archives, restored with [restore.md](restore.md) instead.)
4. **[Umbrel terminal or SSH]** Keep the current database. Rename `photos.db` to `photos-before-restore.db`, and rename any `photos.db-wal` and `photos.db-shm` files the same way. Rename them; do not delete them.
5. **[Umbrel terminal or SSH]** Copy the chosen backup to `photos.db`. The restored file must keep the name `photos.db`. Check its ownership against the other files in the folder with `ls -l`.
6. **[Umbrel web UI]** Click **Update** (after A4), then start Crosscuts if it has not started.
7. **Check.** Log in, open the board, and confirm the expected users and jobs are there.

If the restored database has no users, the setup page works again until someone creates an admin. Keep `photos-before-restore.db` until the restore is confirmed, and remove it only with Todd's say-so.
