# Crosscuts status

Read this right after `CLAUDE.md`. The stages, numbered steps (e.g. M2 · 3.1) and clear points are defined in `docs/plans/roadmap.md`.

## Now (2026-10-10)

- **Milestone:** **M1.1 Maintenance**, in progress. 1.1, 2.1, 2.2 (0.1.1 in the Tenon store) and 3.1 (0.1.2 Node 24 build, committed locally) are done. **2.3 Tailscale half passed; the LAN half is on Monday 12 Oct. Next: M1.1 · 3.2 (push 0.1.2).** M1 is CLOSED (2026-10-10), with one LAN re-check carried (below).
- **M1 · 6.1 results:** installed; `/api/auth/status` reports `setupNeeded:false`, so Todd's admin account exists. Logged-out requests get the app's own 401/302 (not an Umbrel login redirect), so Umbrel proxy login is not in front of the app.
- **M1 · 6.2 results (Tailscale, `100.111.185.96:4933`), all PASS:**
  - logged out: `/api/workers` 401, `/schedule.html` 302 to `/login.html?next=/schedule.html`, `/` 302 to login
  - Todd's admin login works and he sees everything (the login POST passing proves the gateway passes `Host` through)
  - test user "Showroom" (showroom role) sees only photo search; the admin page and workers are blocked
- **Carried LAN check (needs Todd on the workshop LAN, Monday 12 Oct, together with the LAN half of 2.3 or whichever version is installed by then):** at `http://umbrel.local:4933`, logged out `/api/workers` is 401 and `/schedule.html` bounces to login; login with "remember this device" works; the board loads. Record the result here.
- **M1.1 plan approved** (2026-10-10): `docs/plans/m1.1-plan.md`. Todd chose Node 24 (not 22). The order is better-sqlite3 12.9.0 (on Node 20) → Node 24 → sharp 0.35 → Actions, as 0.1.1 to 0.1.4.
- **M1.1 · 2.1 done:** `better-sqlite3` pinned exactly to 12.9.0 (the last version with Node 20 and Node 24 Alpine binaries); version 0.1.1 in `package.json` and the lockfile. New smoke step 0 checks the Node major in the image against the Dockerfile and the better-sqlite3 version against the lockfile, and prints the SQLite version. Locally checked: the expressions return 12.9.0 / SQLite 3.53.0, the Dockerfile parses to 20, and `bash -n` passes. No Docker on the dev box, so CI is the first real run.
- **M1.1 · 2.2 done:** joinr-crosscuts pushed (`d7e3872`, Todd OK), CI run 38036478402 green on both architectures, 0.1.1 published (the 0.1.1, latest and sha tags all resolve to the same digest). tenon-umbrel-store commit `c092f89` (pin 0.1.1, `version: '0.1.1'`, release notes) pushed (Todd OK).
- **M1.1 · 3.1 done:** `FROM node:24-alpine`, version 0.1.2. Local run on Node 24 through the shim: healthz 200, migrations applied, logged-out `/api/workers` 401 and `/schedule.html` 302 to login. Smoke step 0 will prove Node 24 in the image.
- **M1.1 · 2.3 Tailscale half PASSED (2026-10-10):** Todd updated to 0.1.1, added a job to the board and assigned two workers; the edits saved and appear in the audit log. Logged-out `/api/workers` over Tailscale is 401. The LAN half is due Monday 12 Oct.
- **Next action (needs Todd):** M1.1 · 3.2: push 0.1.2 (Node 24) once Todd confirms the push.
- **Waiting on Todd:** a clear OK to push 0.1.2; the LAN check above.
- **Open branches/worktrees:** none. The nine merged agent worktrees and their branches were removed 2026-10-10.
- **Deferred findings:**
  - Job values appear in audit before/after. Kept, because `audit.view` is admin-only.
  - The dev-only `.dev/` and `node_modules` folders are local and ignored.

## Facts a fresh session needs

- **Repos:**
  - Code and CI: `devcal1/joinr-crosscuts` (local `C:\Users\todd\Desktop\Claude\code\crosscuts`, branch `main`).
  - Umbrel entry: `devcal1/tenon-umbrel-store`, folder `tenon-joinr-crosscuts/` (local `C:\Users\todd\Desktop\Claude\code\tenon-umbrel-store`, branch `main`). That store also holds LIVE Joinr Backup, Registry and Finance; don't touch their folders.
  - The old app `thcabinets-umbrel-store` is FROZEN and read-only.
- **The app id `tenon-joinr-crosscuts` is permanent.** Changing it wipes the data. Display name "Joinr Crosscuts", port 4933.
- **Released:** `ghcr.io/devcal1/crosscuts-web:0.1.1@sha256:3d312f3e8f22af9e9ff8f288e4d9f15f6eeb210f2368ac0a7b5ab686a50c113c` (better-sqlite3 12.9.0, CI green on `d7e3872`). Previous: `0.1.0@sha256:f27400028b18fed317b8b500ffdabfb4ac349e944fdcc1631959d72dcce65489` (first CI run, `e6a3bf7`). Both amd64 + arm64, public.
- **Release flow:**
  1. Bump `crosscuts/app/package.json` version.
  2. Get Todd's OK, then push `joinr-crosscuts` `main`.
  3. CI prints the `image:` line in the run summary. GitHub hides logs from logged-out users, so the digest can also be read anonymously from `ghcr.io/v2/devcal1/crosscuts-web/manifests/<version>`.
  4. Pin it in `tenon-joinr-crosscuts/docker-compose.yml`, and bump `version:` and `releaseNotes` in its `umbrel-app.yml`.
  5. Get Todd's OK, then push the Tenon store.
- A paths-filtered workflow doesn't run on a new branch's first push (see the comment in `publish.yml`).

## Decisions on record (don't re-ask)

- The `/api/tags` WIP was left behind; a new version comes in M3.
- Crosscuts started empty; live data is copied only at cutover.
- The job-stage backfill rule was approved as written. The orphan `day_flags` sweep (migration 005) was approved.
- Moved into the Tenon store (not a separate store). App id `tenon-joinr-crosscuts`, display name "Joinr Crosscuts".
- Stage hooks:
  - Finish-week "not started" sends the job back to `ready_to_cut`.
  - A completed job placed back on the board becomes `on_board`.
  - Deleting a row doesn't change the stage.
- Follow-ups agreed in principle, each as its own release with Todd's OK: Node 24 (chosen over 22 on 2026-10-10, with better-sqlite3 12.9.0 released first), sharp 0.35, and Actions versions. That is M1.1 (steps in the roadmap).

## History

- 2026-10-10: M1 audit and plan approved; contracts written; Wave 0 plus T1–T7 built in parallel and merged; independent review (2 major, 6 minor) fixed; joinr-crosscuts pushed; CI green; 0.1.0 published; moved to the Tenon store and pushed. Now at M1 stage 6.
- 2026-10-10: Roadmap now numbers every step (e.g. M1 · 6.1, M1.1 · 2.2) with ✂ clear points; M1.1 has its own step list, one release per upgrade. App not yet installed; next step M1 · 6.1.
- 2026-10-10: M1 · 6.1 and 6.2 done on Tailscale (logged-out 401/302, admin login, showroom role limited to photo search). **M1 closed**; LAN re-check carried. Next step M1.1 · 1.1.
- 2026-10-10: M1.1 · 1.1 plan drafted (`m1.1-plan.md`), awaiting Todd's approval.
- 2026-10-10: M1.1 plan approved (Node 24). M1.1 · 2.1 done: better-sqlite3 12.9.0, version 0.1.1, smoke step 0 (runtime versions). Next M1.1 · 2.2 (push needs Todd).
- 2026-10-10: 0.1.1 pushed (Todd OK), CI green, image published; store pin committed locally, store push waiting on Todd.
- 2026-10-10: tenon-umbrel-store pushed (`c092f89`, Todd OK): 0.1.1 offered. M1.1 · 2.2 done; next 2.3 on the device.
- 2026-10-10: M1.1 · 3.1 done (0.1.2, Node 24, local only). 2.3 split: Tailscale now, LAN on Monday 12 Oct.
- 2026-10-10: M1.1 · 2.3 Tailscale half passed (board edit + audit on 0.1.1). Showroom test user disabled by Todd.
