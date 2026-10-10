# Crosscuts status

Read this right after `CLAUDE.md`. The stages, numbered steps (e.g. M2 · 3.1) and clear points are defined in `docs/plans/roadmap.md`.

## Now (2026-10-10)

- **Milestone:** M1 Foundation. Stages 1–5 done. **M1 · 6.1 done; M1 · 6.2 (on-device checks) in progress.**
- **M1 · 6.1 results (2026-10-10):** installed; `/api/auth/status` reports `setupNeeded:false`, so Todd's admin account exists. Logged-out requests get the app's own 401/302 (not an Umbrel login redirect), which shows Umbrel proxy login is not in front of the app.
- **M1 · 6.2 so far:** over Tailscale (`100.111.185.96:4933`), logged out: `/api/workers` 401, `/schedule.html` 302 to `/login.html?next=/schedule.html`, `/` 302 to login. PASS.
- **Next action (M1 · 6.2, needs Todd):** in the browser, over BOTH `umbrel.local:4933` and `100.111.185.96:4933`: login with "remember this device" (the login POST passing also proves the gateway passes `Host` through); the board loads; create a non-admin test user and confirm it gets 403 / a hidden page where expected. LAN logged-out check too (`umbrel.local` does not resolve from Git Bash on the dev box). Then **M1 · 6.3** closes M1.
- **Waiting on Todd:** the browser checks above.
- **Open branches/worktrees:** none unmerged. Old agent worktrees under `.claude/worktrees/` are merged and can be cleaned up.
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
