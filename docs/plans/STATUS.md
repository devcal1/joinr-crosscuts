# Crosscuts status

Read this right after `CLAUDE.md`. The stages, numbered steps (e.g. M2 · 3.1) and clear points are defined in `docs/plans/roadmap.md`.

## Now (2026-10-10)

- **Milestone:** **M1 Foundation is CLOSED** (2026-10-10), on the Tailscale checks; one LAN re-check is carried (below). **Next step: M1.1 · 1.1 (Plan).**
- **M1 · 6.1 results:** installed; `/api/auth/status` reports `setupNeeded:false`, so Todd's admin account exists. Logged-out requests get the app's own 401/302 (not an Umbrel login redirect), so Umbrel proxy login is not in front of the app.
- **M1 · 6.2 results (Tailscale, `100.111.185.96:4933`), all PASS:**
  - logged out: `/api/workers` 401, `/schedule.html` 302 to `/login.html?next=/schedule.html`, `/` 302 to login
  - Todd's admin login works and he sees everything (the login POST passing proves the gateway passes `Host` through)
  - test user "Showroom" (showroom role) sees only photo search; the admin page and workers are blocked
- **Carried LAN check (needs Todd on the workshop LAN, due before M1.1 · 2.2, the first M1.1 release):** at `http://umbrel.local:4933`, logged out `/api/workers` is 401 and `/schedule.html` bounces to login; login with "remember this device" works; the board loads. Record the result here.
- **M1.1 · 1.1 drafted:** `docs/plans/m1.1-plan.md`. Order Node 22 → sharp 0.35 → Actions, as 0.1.1 / 0.1.2 / 0.1.3. The sharp upload pipeline tested identical under 0.33.5 and 0.35.5. The CI-only release bumps the version but is not pinned in the store.
- **Next action:** Todd approves (or amends) `m1.1-plan.md`; then M1.1 · 2.1 (Node 22 build), no Todd needed until 2.2.
- **Waiting on Todd:** approval of `m1.1-plan.md`; the LAN check above; disable the "Showroom" test user on the Users page (the app has no delete, only "Disable account"; Claude cannot sign in to the live app).
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
- **Released:** `ghcr.io/devcal1/crosscuts-web:0.1.0@sha256:f27400028b18fed317b8b500ffdabfb4ac349e944fdcc1631959d72dcce65489` (amd64 + arm64, public). The first CI run was green on commit `e6a3bf7`.
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
- Follow-ups agreed in principle, each as its own release with Todd's OK: Node 22, sharp 0.35, and Actions versions. That is M1.1 (steps in the roadmap).

## History

- 2026-10-10: M1 audit and plan approved; contracts written; Wave 0 plus T1–T7 built in parallel and merged; independent review (2 major, 6 minor) fixed; joinr-crosscuts pushed; CI green; 0.1.0 published; moved to the Tenon store and pushed. Now at M1 stage 6.
- 2026-10-10: Roadmap now numbers every step (e.g. M1 · 6.1, M1.1 · 2.2) with ✂ clear points; M1.1 has its own step list, one release per upgrade. App not yet installed; next step M1 · 6.1.
- 2026-10-10: M1 · 6.1 and 6.2 done on Tailscale (logged-out 401/302, admin login, showroom role limited to photo search). **M1 closed**; LAN re-check carried. Next step M1.1 · 1.1.
- 2026-10-10: M1.1 · 1.1 plan drafted (`m1.1-plan.md`), awaiting Todd's approval.
