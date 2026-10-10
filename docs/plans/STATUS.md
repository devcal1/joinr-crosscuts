# Crosscuts status

Read this right after `CLAUDE.md`. The stages, numbered steps (e.g. M2 · 3.1) and clear points are defined in `docs/plans/roadmap.md`.

## Now (2026-10-11, clear point)

- **On the device:** 0.1.3 (Node 24, better-sqlite3 12.9.0, sharp 0.35), the old purple look. Verified over Tailscale: board edits save and are audited, and portrait photos upload upright.
- **Pushed (Todd OK, 2026-10-11): version 0.1.4, `main` at `a2a8335`.** It carries everything since 0.1.3: M1.1 · 5.1 (Actions on Node-24 majors), M1.2 house style, M2 Accounts, M3 Design/PM. **CI green** (run 38093831505: both architectures built and smoke-tested, including the first real runs of the M2 and M3 smoke files; manifest merged). The image is published (digest under Released).
- **Tenon store pin committed locally, NOT pushed:** `tenon-umbrel-store` `bb4cce2` pins `0.1.4@sha256:c8c17630…` and bumps `version: '0.1.4'` and `releaseNotes`. Umbrel offers 0.1.4 only after that push.
- **Milestones:** M3 Design/PM and M2 Accounts: built, reviewed and fixed; now in their release step (5.1 done; 5.2 is the store push). M1 CLOSED. M1.1 done (5.2 passed: CI green on both architectures). M1.2 done except 2.1 (store push), 2.2 (device check) and close (3.1).
- **Release paused (Todd, 2026-10-11):** keep everything local and carry on developing; GitHub gets a future patch. So 0.1.4 is published on ghcr.io but not offered on the Umbrel. **The next push of app code must be 0.1.5 or later** (the 0.1.4 tag exists), so bump the version before that push and re-pin the store to it; the local `bb4cce2` pin is then superseded by the new one (amend or add a commit on top, still local). Joinr-crosscuts `main` is also ahead of origin with STATUS-only commits.
- **Parked release steps (when Todd says push):** push joinr-crosscuts (CI publishes the new version), pin and push the store, Todd clicks Update, then the device checks (M1.2 · 2.2 pages, TV board, a JPG export; M2/M3 · 6.1, including the 011 tag tidy and Business details before the first real invoice) and the carried LAN check.
- **Next action: M4 · 1.1 (Collaboration audit).**
- **Cutover:** the runbook draft is written (`docs/cutover.md`); approach agreed 2026-10-11. It can be rehearsed once 0.1.4 is installed.
- **Carried LAN check (Todd, on the workshop LAN, Monday 12 Oct):** at `http://umbrel.local:4933`, logged out `/api/workers` is 401 and `/schedule.html` bounces to login; login with "remember this device" works; the board loads. Record the result here.
- **Waiting on Todd:** the go-ahead for the next push (paused 2026-10-11); two questions from M3: should a progress invoice wait until the job has a value (today it falls due with no amount), and should the server enforce must-change-password (today only the browser does); the LAN check; the final invoice logo (a placeholder is in `public/assets/invoice-letterhead.png`); the release decision. Before the first real invoice: Todd fills in the business details, bank details and start number (Users page), and Tracy checks a printed sample (`docs/how-to-invoice.md`).
- **Open branches/worktrees:** M3 Wave 1 worktrees agent-ad24acc9a25fb9932 (A), agent-a3f886208de66d9bf (B), agent-a1bb29bdba3aa35eb (C), agent-ab30fd5b02c80db3a (D), all merged: clean up at M3 · 6.2. M2 worktrees under `.claude/worktrees/` (agent-a4d4551cd68dabac8 A, agent-a9b47abdc9dbb6d5f B, agent-a9b852aa6631e1f12 C, agent-ade3a7d8a0117b074 D, agent-aa2c08da9c8390337 E, agent-a8a5dfe6fbdfb4ec2 4.3 fixes), all merged: clean up at M2 · 6.2.
- **Tools for UI work (local only):** `tools/screenshots/seed.js` (sample data, test admin) and `tools/screenshots/shoot.js` (full-page PNGs of every page through headless Edge). See the comments at the top of each.
- **Deferred findings:**
  - **M3 review (4.2, 2026-10-11)**, fix status in brackets:
    1. Major: the job page sends `from` = the stage after its field PATCH, so a concurrent move is overwritten. [fixed in 4.3]
    2. Major: the pipeline's 60-day cap uses `stageChangedAt`, which 003 sets to the cutover time for every backfilled job, so the cap is void for 60 days after cutover. [fixed in 4.3]
    3. Minor: a non-on_board job with current/future board rows (e.g. lost) can be hand-moved, ending ready_to_cut while on the board. [fixed in 4.3]
    4. Minor: the admin derived override, and moves to archived/lost, don't remove a To start row. [fixed in 4.3]
    5. Minor: toggling lines re-sends `materials.in` to scheduling. [fixed in 4.3]
    6. Minor: a future ordered date is accepted and becomes the job's materials date. [fixed in 4.3]
    - Nits: the photos.js diff re-adds 13 unchanged lines (line endings) [kept]; inspection done → booked allowed without notifying [kept].
  - Observation (M1, not M3): `must_change_password` is enforced only by the browser; the API serves a user who hasn't changed a temporary password. As M1 contracts specify. [kept; raise with Todd if wanted]
  - **M2 review (4.2, 2026-10-10)**, fix status in brackets:
    1. Critical: the M2 smoke files ran with a revoked `$SCHED` session (step g). [fixed by the integrator: re-login before the source loop]
    2. Major: the invoices smoke expected a raw ABN and BSB. [fixed in 4.3]
    3. Major: a reprinted issued invoice could change (live contract summary, live client fallbacks). [fixed in 4.3]
    4. Major: the deposit fired for legacy jobs given another row. [fixed in 4.3]
    5. Minor: a hand-set complete overwrote the completed date. [fixed in 4.3]
    6. Minor: waive was terminal. [fixed in 4.3]
    7. Minor: issue could freeze an amount different from the one shown. [fixed in 4.3]
    8. Minor: issue needed no bill-to name. [fixed in 4.3]
    9. Minor: a voided final leaves the job at `invoiced` until the replacement is issued. [kept; noted in the how-to]
    10. Minor: paid showed green and void red on the invoice page. [fixed in 4.3]
    - Nits: the hardcoded "10 days" text, `safeLink` `/` [fixed in 4.3]; future paid dates accepted, and no confirm on Materials ordered [kept].
  - Job values appear in audit before/after. Kept, because `audit.view` is admin-only.
  - Search tiles are not keyboard-focusable (plain divs); worth fixing when the photo pages are next touched (M3).
  - The audit changed-value highlight was not seen in a screenshot (the sample data had no before/after entry).
  - Print/PDF of the board was not checked after the re-theme (the print CSS was kept black on white).
- **Gotchas learned (M1.1 onwards):**
  - npm 11.19 (Node 24 images) skips install scripts not listed in `package.json` `allowScripts`. The entry names `better-sqlite3@12.9.0` exactly, so **any better-sqlite3 bump must update it**.
  - Some source files mix CRLF and LF: `sed -i` rewrites every line ending. Edit with exact string replacement.
  - The image tag is immutable: a push that publishes needs a version bump, even CI-only changes.
  - Agent worktrees (`isolation: worktree`) have been created at an old commit (4b887f3), not `main`'s HEAD. Tell each build agent to check `git log -1` and reset to the intended base commit first, and to junction `crosscuts/app/node_modules` from the main checkout.
  - `jq` and Docker aren't on the dev box: smoke files get `bash -n` locally (or a jq stand-in); CI is their first real run. Python isn't installed either; use node for scripts.

## Facts a fresh session needs

- **Repos:**
  - Code and CI: `devcal1/joinr-crosscuts` (local `C:\Users\todd\Desktop\Claude\code\crosscuts`, branch `main`).
  - Umbrel entry: `devcal1/tenon-umbrel-store`, folder `tenon-joinr-crosscuts/` (local `C:\Users\todd\Desktop\Claude\code\tenon-umbrel-store`, branch `main`). That store also holds LIVE Joinr Backup, Registry and Finance; don't touch their folders.
  - The old app `thcabinets-umbrel-store` is FROZEN and read-only.
- **The app id `tenon-joinr-crosscuts` is permanent.** Changing it wipes the data. Display name "Joinr Crosscuts", port 4933.
- **Released:** `ghcr.io/devcal1/crosscuts-web:0.1.4@sha256:c8c17630dda3ef1d66da0f50547a0b45bea58b3bf21122f204db10d1dea28129` (M1.1 Actions, M1.2, M2, M3; CI green on `a2a8335`; store pin committed, not yet pushed). Before that: `0.1.3@sha256:237de19c202059febb58087794c1f98112a307fa05a75f8520ac95653b34e246` (Node 24 + sharp 0.35, CI green on `4b887f3`). Earlier: `0.1.1@sha256:3d312f3e8f22af9e9ff8f288e4d9f15f6eeb210f2368ac0a7b5ab686a50c113c` (better-sqlite3 12.9.0, CI green on `d7e3872`). Previous: `0.1.0@sha256:f27400028b18fed317b8b500ffdabfb4ac349e944fdcc1631959d72dcce65489` (first CI run, `e6a3bf7`). Both amd64 + arm64, public.
- **Release flow:**
  1. Bump `crosscuts/app/package.json` version.
  2. Get Todd's OK, then push `joinr-crosscuts` `main`.
  3. CI prints the `image:` line in the run summary. GitHub hides logs from logged-out users, so the digest can also be read anonymously from `ghcr.io/v2/devcal1/crosscuts-web/manifests/<version>`.
  4. Pin it in `tenon-joinr-crosscuts/docker-compose.yml`, and bump `version:` and `releaseNotes` in its `umbrel-app.yml`.
  5. Get Todd's OK, then push the Tenon store.
- A paths-filtered workflow doesn't run on a new branch's first push (see the comment in `publish.yml`).

## Decisions on record (don't re-ask)

- Cutover (2026-10-11): users and settings re-created by hand after the load; freeze on the Friday after Finish week; two-week fallback; Todd runs the Umbrel terminal with Claude guiding. See `docs/cutover.md`.
- Invoices: Crosscuts issues them (numbered CC-, GST-inclusive, PDF via print), re-keyed into MYOB; split 10/50/40 (kept 2026-10-11 despite the sample's 30%); quote number on the job and on the line. See `m2-plan.md` §10 and `m2-contracts.md` §10–§11.
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
- 2026-10-10: M2 plan rewritten after Todd's changes: Crosscuts issues numbered tax invoices (new series, GST-inclusive, PDF via print), re-keyed into MYOB; no ntfy/phone push in M2; brief D10/D12 annotated. Awaiting plan approval.
- 2026-10-10: M2 plan approved by Todd (M2 · 1.3 done). Next M2 · 2.1 contracts.
- 2026-10-10: M2 · 2.1 contracts written (`m2-contracts.md`): migration 006, lib signatures, hooks, API, pages, smoke files, waves (2.2 scaffold; 3.1 A+B backend; 3.2 C+D+E pages). Next M2 · 2.2.
- 2026-10-10: M2 · 2.2 scaffold committed: migration 006, `sydneyParts`/`latestFridayNoon`, working minimal `settings`/`notify`, `invoices`/`roundup` stubs, three empty guarded routers mounted, round-up start after listen, smoke-m2 source hook, auth.md keys live. Local shim boot passed (006 applied, FK check ok, helpers checked). Next M2 · 3.1.
- 2026-10-10: M2 · 3.1 Wave 1 done. A invoices backend `worktree-agent-a4d4551cd68dabac8` @ `4193bc7`, local flow pass (smoke file `bash -n` only); B notifications/settings/round-up `worktree-agent-a9b47abdc9dbb6d5f` @ `1993dfe`, local pass. Both merged on `main`; integrator fix: the invoice counter no longer writes a settings.update audit row per issue. Combined local run passed (settings PUT, place → deposit due + bell row, issue CC-0001 with GST, round-up, number lock). Next M2 · 3.2.
- 2026-10-10: M2 · 3.2 Wave 2 done and merged: C accounts/job pages `50b6ad8`, D invoice document `9b6489a`, E bell/dashboard/settings `ef7f1c7` (each: node --check, style check, shim boot, headless-Edge screenshots pass). M2 · 4.1: local end-to-end run on merged main passed (place → deposit, materials ordered → progress, finish week → final, issue CC-0001..3 with exact split and GST, stage invoiced, pages 200, log clean). Next M2 · 4.2 review.
- 2026-10-10: M2 · 4.2 review done (1 critical, 3 major, 6 minor; numbering, locking, money, XSS, access and the round-up all found sound). Finding 1 fixed; contracts §10 records the 4.3 changes. Next M2 · 4.3.
- 2026-10-10: M2 · 4.3 done: review fixes merged (`a39ff10`: migration 007 freezes contract value and invoiced-before at issue, "no other week rows" deposit rule, the expectedTotalCents and bill-to guards, un-waive, completed date kept, teal/neutral badges, safeLink). The integrator added the live job details for waived invoices on the document. `docs/how-to-invoice.md` written. Local end-to-end run passed (no deposit for a second row, the 409 guard, CC-0001..3, reprint frozen after a value change, stage invoiced, pages 200, log clean). Release deferred.
- 2026-10-11: The invoice document now follows Todd's sample: placeholder letterhead banner, Subtotal/Includes GST/Total AUD, a payment advice slip, and the job reference frozen at issue (migration 008, additive; it applied with a backup on an existing dev DB). Prints one A4 page. Sample render: `docs/plans/m2-sample-invoice.png`.
- 2026-10-11: Todd kept the 10/50/40 split. A quote number was added to jobs (migration 009, additive) and appears in the standard invoice line ("Deposit (10%) of quote JRQ22961: …"). Local check passed.
- 2026-10-11: Cutover runbook draft written (`docs/cutover.md`, brief §9a): read-only snapshot via VACUUM INTO inside the old container, load into Crosscuts with the pre-cutover data set aside, count and board checks, the M1 decision-4 list, fallback and decommission. Finding: the load replaces Crosscuts' users and settings, so they are re-created by hand (recommended) or carried over by a tool (Todd to choose). Umbrel paths and container names are still unverified.
- 2026-10-11: Cutover approach agreed by Todd (recorded in `docs/cutover.md`).
- 2026-10-11: M3 · 1.1 audit (three read-only surveys: pipeline/jobs, orders/inspections, photos/tags) and 1.2 plan written (`m3-plan.md`: pipeline board with pointer drag and a stage endpoint, orders firing the shared Materials ordered path once, inspections, Materials in, photos linked to jobs, case-blind tag chips, keyboard search tiles; migration 010 additive; no new keys). Q1–Q5 put to Todd.
- 2026-10-11: M3 plan approved by Todd (M3 · 1.3): only Todd marks lines ordered; leaving Ready to cut leaves "To start"; one-off photo tag tidy (migration 011) signed off; Archived stage and checkbox linked; cards ordered by promised install. Next M3 · 2.1.
- 2026-10-11: M3 · 2.1 contracts written (`m3-contracts.md`). Found `photos.job_id` already exists from 003 (010 adds only its index). Integrator settled §11: Complete/Invoiced pipeline columns capped to 60 days with Show all; a cancel by Todd fires the all-ordered rule, a design_pm cancel never does; admin PATCH override can leave complete/invoiced, and on_board only with no current/future rows. Waves: 2.2 scaffold; 3.1 A/B/C; 3.2 D.
- 2026-10-11: M3 · 2.2 scaffold committed. Local: node --check, bash -n, shim boot on a fresh DB (010/011 applied, Materials ordered 200 then 409), the 011 throwaway check (4 of 6 rewritten, backup present, no other column changed, `lib/tags.js` agrees), 12 moveStage cases incl. rollback, style check: all pass. Note: 003_jobs.js requires app code (lib/time), so its checksum doesn't cover that code (already applied; record only). A progress invoice becomes due even with no job value (amount null): unchanged M2 behaviour.
- 2026-10-11: M3 · 3.1 Wave 1 merged. A pipeline `23c40b7` (61 API checks + 53 headless-Edge drag/keyboard/phone checks pass); B orders/inspections `3c422f4` (smoke file run against the shim: 222 checks pass); C photos/tags `0736ec9` (smoke file 77–80 checks, step-c replay, browser chip/keyboard checks pass). jq isn't installed locally: B and C ran their smoke files through a jq stand-in, so CI is the first real-jq run. Worktrees were created at 4b887f3, not main; each agent moved to the scaffold first. The menu bar overflowed between 1100 and ~1500 px (already below 1366 before M3); fixed in shell.css and measured at 1100–1600 px.
- 2026-10-11: M3 · 3.2 Wave 2 merged: D pages `1b6e9e9` (job page Orders/Inspection/Photos sections with the Materials ordered button moved into Orders, `/orders.html`, scheduling Upcoming, Design tiles live; headless-Edge flows as admin/dpm/sched/show pass; style check passes). Note: the D agent force-closed all msedge processes during clean-up.
- 2026-10-11: M3 · 4.1 local end-to-end run passed (12 steps on a fresh shim: pipeline moves, orders → one progress invoice, placement → deposit, materials in, inspection, photo tidy and privacy, finish week → final, archived, To start removal, page access, audit, clean log). M3 · 4.2 review: 0 critical, 2 major, 4 minor (Deferred findings). Board files, shared.js, invoices and schedule routes confirmed untouched; access, XSS, SQL, 011/tags agreement, smoke jq filters found sound.
- 2026-10-11: M3 · 4.3 done: all six review findings fixed (job page stale `from`, pipeline cap from completedDate/board weeks, rows lock for non-on_board jobs with complete/invoiced → archived exempt (integrator's call after the e2e run caught it), To start removal on archived/lost and the admin override, one materials.in per job, no future order dates); smoke assertions added; contracts §12. Local: node --check, bash -n, style check, 40 targeted assertions, and the 12-step e2e rerun on a fresh shim all pass. Release deferred.
- 2026-10-11: Version 0.1.4 committed and pushed to joinr-crosscuts (`a2a8335`, Todd OK): M1.1 Actions, M1.2, M2, M3 in one release. CI result pending; store not pinned. Clear point.
- 2026-10-11: CI green for 0.1.4 (`a2a8335`, read through the public API); digest `c8c17630…` read from ghcr.io. Store pin committed locally (`bb4cce2`); push waiting on Todd.
- 2026-10-11: Todd paused the release: nothing pushed, the store pin stays local, development continues (next M4 · 1.1). The next pushed app version must be 0.1.5+.
