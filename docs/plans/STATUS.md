# Crosscuts status

Read this right after `CLAUDE.md`. The stages, numbered steps (e.g. M2 · 3.1) and clear points are defined in `docs/plans/roadmap.md`.

## Now (2026-10-10, clear point)

- **On the device:** 0.1.3 (Node 24, better-sqlite3 12.9.0, sharp 0.35), the old purple look. Verified over Tailscale: board edits save and are audited, and portrait photos upload upright.
- **Local `main`, not pushed (ahead of origin):** M1.1 · 5.1 (Actions on Node-24 majors, `77e9b3a`), and M1.2 House style, built and **approved by Todd 2026-10-10** (`feaabd7`; review page https://claude.ai/artifact/CKpBd4aTFcNNypMECg5W9z). The version in `package.json` is still 0.1.3.
- **Release deferred (Todd, 2026-10-10):** development continues locally with no new version and no Umbrel update for now. Commits accumulate on `main`. When Todd decides to release, there is one version bump (above 0.1.3), one push (Todd OK), CI, the store pin and push (Todd OK), then Update. The release notes then cover everything since 0.1.3: Actions, the house style, the job-page edit-rights fix, and whatever follows. Open release steps: M1.1 · 5.2, M1.2 · 2.1 and 2.2 (device check of the pages, the TV board and a JPG export).
- **Milestones:** M2 Accounts at 1.3 (decisions recorded, awaiting plan approval). M1 CLOSED. M1.1 done except its release step (5.2). M1.2 done except its release (2.1, 2.2) and close (3.1).
- **Next action:** **M2 · 1.3 finish: Todd approves `m2-plan.md` as amended** (decisions are in its §10). Then mark it approved and go to M2 · 2.1 (contracts, `m2-contracts.md`). New pages follow CLAUDE.md "Look and feel" (`tokens.css` and `components.css` `hs-` classes), and `node ci/style-check.js` must pass.
- **Carried LAN check (Todd, on the workshop LAN, Monday 12 Oct):** at `http://umbrel.local:4933`, logged out `/api/workers` is 401 and `/schedule.html` bounces to login; login with "remember this device" works; the board loads. Record the result here.
- **Waiting on Todd:** the LAN check; approval of `m2-plan.md` as amended. Before M2 can be checked on the device, Todd installs the ntfy Umbrel app and the ntfy phone app (a how-to doc comes with the build).
- **Open branches/worktrees:** none.
- **Tools for UI work (local only):** `tools/screenshots/seed.js` (sample data, test admin) and `tools/screenshots/shoot.js` (full-page PNGs of every page through headless Edge). See the comments at the top of each.
- **Deferred findings:**
  - Job values appear in audit before/after. Kept, because `audit.view` is admin-only.
  - Search tiles are not keyboard-focusable (plain divs); worth fixing when the photo pages are next touched (M3).
  - The audit changed-value highlight was not seen in a screenshot (the sample data had no before/after entry).
  - Print/PDF of the board was not checked after the re-theme (the print CSS was kept black on white).
- **Gotchas learned in M1.1/M1.2:**
  - npm 11.19 (Node 24 images) skips install scripts not listed in `package.json` `allowScripts`. The entry names `better-sqlite3@12.9.0` exactly, so **any better-sqlite3 bump must update it**.
  - Some source files mix CRLF and LF: `sed -i` rewrites every line ending. Edit with exact string replacement.
  - The image tag is immutable: a push that publishes needs a version bump, even CI-only changes.

## Facts a fresh session needs

- **Repos:**
  - Code and CI: `devcal1/joinr-crosscuts` (local `C:\Users\todd\Desktop\Claude\code\crosscuts`, branch `main`).
  - Umbrel entry: `devcal1/tenon-umbrel-store`, folder `tenon-joinr-crosscuts/` (local `C:\Users\todd\Desktop\Claude\code\tenon-umbrel-store`, branch `main`). That store also holds LIVE Joinr Backup, Registry and Finance; don't touch their folders.
  - The old app `thcabinets-umbrel-store` is FROZEN and read-only.
- **The app id `tenon-joinr-crosscuts` is permanent.** Changing it wipes the data. Display name "Joinr Crosscuts", port 4933.
- **Released:** `ghcr.io/devcal1/crosscuts-web:0.1.3@sha256:237de19c202059febb58087794c1f98112a307fa05a75f8520ac95653b34e246` (Node 24 + sharp 0.35, CI green on `4b887f3`). Earlier: `0.1.1@sha256:3d312f3e8f22af9e9ff8f288e4d9f15f6eeb210f2368ac0a7b5ab686a50c113c` (better-sqlite3 12.9.0, CI green on `d7e3872`). Previous: `0.1.0@sha256:f27400028b18fed317b8b500ffdabfb4ac349e944fdcc1631959d72dcce65489` (first CI run, `e6a3bf7`). Both amd64 + arm64, public.
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
- 2026-10-10: 0.1.2 fixed for npm 11.19 (allowScripts). M1.1 · 4.1 done locally (0.1.3, sharp 0.35.5, orientation smoke test). Nothing pushed (Todd minimising GitHub use).
- 2026-10-10: Todd chose to release Node 24 and sharp 0.35 combined as 0.1.3 (one push and CI run).
- 2026-10-10: 0.1.3 pushed (Todd OK), CI green, image published; store pin committed locally.
- 2026-10-10: tenon-umbrel-store pushed (`81bfb3e`, Todd OK): 0.1.3 offered. Next: device checks (M1.1 · 4.3).
- 2026-10-10: M1.1 · 4.3 passed on 0.1.3 (portrait photo upright). Next 5.1 (Actions).
- 2026-10-10: M1.1 · 5.1 committed locally. House-style review done; M1.2 plan approved with decisions (board re-themed, worker colours kept, board icons kept).
- 2026-10-10: M1.2 · 1.2 built locally (whole app re-themed, style check in CI, before and after screenshots). Next: Todd's review (1.3).
- 2026-10-10: M1.2 approved by Todd. Release deferred: development continues locally (no version bump, no Umbrel update). Screenshot tools moved to tools/screenshots/. Clear point; next M2 · 1.1 unless Todd says otherwise.
- 2026-10-10: M2 · 1.1 audit and 1.2 plan done (`m2-plan.md`: invoices, prompts, bell, ntfy push, Friday round-up, overdue view; no new feature keys). Six questions put to Todd. Next M2 · 1.3.
- 2026-10-10: M2 · 1.3 decisions recorded (self-hosted ntfy, full-detail push, Materials ordered button, 10-day terms with Joinr due date later, no auto-invoices for old jobs, report library to M4). Awaiting plan approval.
