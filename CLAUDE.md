# CLAUDE.md: Crosscuts engineering rules

Read this before changing anything in this repo. The binding interface details are in `docs/plans/m1-contracts.md`, the reasoning is in `docs/plans/m1-plan.md`, and the product brief is `docs/crosscuts-brief.md`. Where this file and the brief disagree, the brief wins. If a contract looks wrong, report it instead of working around it.

## What Crosscuts is

Crosscuts is the successor to the TH Cabinets Umbrel app. It runs on Todd's Umbrel home server, on the workshop LAN and over Tailscale. It serves the schedule board that runs on the workshop TV, the photo library, and (in later milestones) jobs, accounts, design and scheduling pages.

M1 adds personal logins, roles, user admin, jobs and an audit log. The board stays unchanged behind login.

Crosscuts runs alongside the old app until cutover. The old app is the schedule of record until then. Crosscuts starts empty for M1 testing; live data is copied in only at cutover.

## Layout

- `umbrel-app-store.yml`: the store. Store id `crosscuts`.
- `crosscuts/umbrel-app.yml`: the app manifest. App id `crosscuts`, port 4091, `version`.
- `crosscuts/docker-compose.yml`: the app's compose file.
- `crosscuts/app/`: the Docker build context.
  - `db/`: `index.js`, `migrate.js` and `migrations/`.
  - `lib/`: shared modules (auth, permissions, pages, routes, audit, config, password, time).
  - `routes/`: one router per API area.
  - `public/`: HTML, CSS and JS. `public/shell/` holds the shared shell.
  - `server.js`.
- `tools/dev-sqlite-shim.js`: local dev only. Outside the Docker context.
- `ci/smoke.sh`: the smoke test script. Not in the repo yet. The smoke steps are currently inline in `.github/workflows/publish.yml`.
- `docs/`: the brief, plans, and the how-to and reference docs.

## Non-negotiables

1. **Bump `version:`** in `crosscuts/umbrel-app.yml` on every change under `crosscuts/app/`. Umbrel only offers an update when the version changes, and CI fails a push that changes app code without a bump.
2. **Code ships as the published image** `ghcr.io/devcal1/crosscuts-web`. The compose file points at it.
3. **Never rename `photos.db`.** It holds the live schedule.
4. **Data lives at `/data/db`, `/data/uploads` and `/data/config` inside the container.** Never mount anything at `/app/db`, because that is source code. The host layout (`data/db`, `data/uploads`, `data/config`) matches the old app, so cutover is a file copy.
5. **Schema changes are new numbered migrations only** (`NNN_name.sql` or `.js`). Keep them additive unless Todd signs off. Never edit an applied migration: a checksum mismatch stops boot. Before pending migrations run on an existing database, the runner writes a `VACUUM INTO` backup to `data/db/backups/`.
6. **Every `/api` route is declared through `defineRoutes` with an access value** (a feature key, an array of keys, `'login'` or `'public'`). The server refuses to boot if any `/api` route lacks one.
7. **The board files are not redesigned.** Do not edit `schedule.html`, `schedule.css`, `schedule.js` or `workers.html`. Any new visual on the board must be mirrored in `exportJpg()`. `alignPanels()` is shared by `renderWeeks` and `exportJpg`, and stays shared. `.nav` and `--nav-h` are untouched.
8. **Shell CSS classes are prefixed `cc-`**, so they cannot collide with the board's global styles.
9. **Never push without Todd saying so.** Commit locally. A push starts CI and publishes.
10. **The old app is frozen** (`thcabinets-umbrel-store` and `thcabinets-splash`) until cutover. Do not change its code, manifest, image or data, and do not uninstall it.
11. **Umbrel proxy login stays off.** `PROXY_AUTH_ADD: "false"` is set in the compose file, and umbrelOS's per-app "Require Umbrel login" toggle must stay off. Crosscuts does its own login.

Pause and ask Todd before anything that touches stored data (migrations that delete rows, restores, cutover steps).

## Local development

`better-sqlite3` does not build on the Windows dev box, so local runs use `node:sqlite` through a shim. From the repo root, in Git Bash:

```
cd crosscuts/app && DB_DIR=../../.dev/db UPLOADS_DIR=../../.dev/uploads CONFIG_DIR=../../.dev/config node -r ../../tools/dev-sqlite-shim.js server.js
```

`.dev/` is git-ignored. A local run is a quick check only. **CI smoke tests are the real verification.** A local pass does not prove the image works.

## Release flow

1. Todd says push, and the commits go to `main`.
2. CI builds each architecture on a native runner (`ubuntu-24.04` and the arm runner) and smoke-tests the exact image it will publish.
3. Each image is pushed by digest.
4. A final job merges the digests into one manifest. The `latest` tag and `sha-<full commit hash>` tag are both set.
5. Todd clicks **Update** in umbrelOS.

The version guard runs first and fails the build if app code changed without a version bump.
