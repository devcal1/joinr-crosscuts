# Crosscuts status

Read this right after `CLAUDE.md`. The stages and clear points are defined in `docs/plans/roadmap.md`.

## Now (2026-10-10)

- **Milestone:** M1 Foundation. **Stage 5 (Release) is done; stage 6 (Verify on the Umbrel) is in progress.**
- **Next action:** Todd installs "Joinr Crosscuts" from the Tenon store. Then, with Todd:
  1. Run `/setup.html` on port 4933 to create Todd's admin account.
  2. Confirm "Require Umbrel login" is OFF for the app.
  3. Over BOTH the LAN (`umbrel.local:4933`) and Tailscale (`100.111.185.96:4933`), check:
     - logged out, `/api/workers` returns 401 and `/schedule.html` returns 302 to `/login.html`
     - login with "remember this device" works
     - the board loads
     - a non-admin role gets 403 where expected
  4. Confirm the gateway passes `Host` through: a POST from the browser must not get "Cross-origin request refused".
  5. Then mark M1 closed below and move to M1.1 stage 1.
- **Waiting on Todd:** the install, and the on-device checks above.
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
- Follow-ups agreed in principle, each as its own release with Todd's OK: Node 22, sharp 0.35, and Actions versions. That is M1.1.

## History

- 2026-10-10: M1 audit and plan approved; contracts written; Wave 0 plus T1–T7 built in parallel and merged; independent review (2 major, 6 minor) fixed; joinr-crosscuts pushed; CI green; 0.1.0 published; moved to the Tenon store and pushed. Now at M1 stage 6.
