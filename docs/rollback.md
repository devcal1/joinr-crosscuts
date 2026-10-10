# Rolling back a release

A release has two parts that can be undone separately: the **app image** (the code) and the **database** (the data). Read this whole page first.

**Decide first.** Did the release add a migration (a new file in `crosscuts/app/db/migrations/`)?

- **Yes:** restore the database too, using the full sequence below.
- **No:** an image rollback alone is usually enough. Confirm with an engineer first.

**Warning: anything entered since the backup is lost.** That includes board edits, jobs, users, logins and audit entries. Photos uploaded after the backup stay on disk but disappear from the app. The offsite NAS backup is **not decided yet**, so the local backups are the only copies.

## Order of steps

1. **A1 to A3:** prepare the rollback commit (repo access needed).
2. **B1 to B5:** stop the app and restore the database (Umbrel terminal or SSH needed).
3. **A4:** push, once Todd says so, and wait for CI.
4. **B6 to B7:** click Update, start the app, and check it.

Do not click Update before step B5. Otherwise the older image starts on the newer database, which is unsafe.

## Part A: the image

The Umbrel pulls the image named in `crosscuts/docker-compose.yml`, which currently says `ghcr.io/devcal1/crosscuts-web:latest`. A rollback is a commit that points that line at a known-good `sha-` tag.

- **A1.** Find the known-good commit hash. Check that the image tag `sha-<full commit hash>` exists under `ghcr.io/devcal1/crosscuts-web`.
- **A2.** In `crosscuts/docker-compose.yml`, change the image line to `ghcr.io/devcal1/crosscuts-web:sha-<full commit hash>`.
- **A3.** Bump `version:` in `crosscuts/umbrel-app.yml` to a new number, and commit. Umbrel only offers an update for a new version, so a rollback is still a new version.
- **A4.** Push, only when Todd says so.

Notes:

- Changing `umbrel-app.yml` starts the publish workflow, which rebuilds the current code and moves `latest` to it. Umbrel is not affected while the compose file pins the `sha-` tag. Do not switch back to `latest` until the bad code is fixed.
- The alternative is to `git revert` the bad commit, bump the version and push, so CI builds good code. Ask an engineer which fits.

## Part B: the database

Before pending migrations run on an existing database, the app writes `data/db/backups/photos-pre-NNN-<timestamp>.db`. `NNN` is the first migration pending on that start. A brand-new install has no backup.

To go back past an upgrade, use the backup from that upgrade: the one whose `NNN` is the lowest migration it applied. It holds the database from before any of those migrations ran. A newer schema on an older image is unsafe, so always restore in that case.

1. **[Umbrel web UI]** Stop Crosscuts.
2. **[Umbrel terminal or SSH]** Go to the Crosscuts `data/db` folder. Check the path with `ls` before doing anything else. On a standard umbrelOS install the app data is usually under `/home/umbrel/umbrel/app-data/crosscuts/`. This path has not been verified yet.
3. **[Umbrel terminal or SSH]** List the backups with `ls -l backups/` and choose the one for the upgrade you are undoing.
4. **[Umbrel terminal or SSH]** Keep the current database. Rename `photos.db` to `photos-before-restore.db`, and rename any `photos.db-wal` and `photos.db-shm` files the same way. Rename them; do not delete them.
5. **[Umbrel terminal or SSH]** Copy the chosen backup to `photos.db`. The restored file must keep the name `photos.db`. Check its ownership against the other files in the folder with `ls -l`.
6. **[Umbrel web UI]** Click **Update** (after A4 and CI), then start Crosscuts if it has not started.
7. **Check.** Log in, open the board, and confirm the expected users and jobs are there.

If the restored database has no users, the setup page works again until someone creates an admin. Keep `photos-before-restore.db` until the restore is confirmed, and remove it only with Todd's say-so.
