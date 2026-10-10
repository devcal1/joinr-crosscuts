# Crosscuts roadmap: milestones, stages and clear points

This document says how the build is cut into pieces small enough to finish in one session each, and where it is safe to `/clear` the conversation before going on. The rule is simple:

**Nothing may live only in the conversation.** At every clear point the work is committed, and `docs/plans/STATUS.md` says exactly where things stand and what happens next. A fresh session that reads `CLAUDE.md` and then `STATUS.md` must be able to carry on without asking Todd anything already answered.

## Every milestone runs the same six stages

| # | Stage | Who | Ends when (= clear point) |
|---|---|---|---|
| 1 | **Audit and plan** | lead and read-only subagents | `docs/plans/mN-plan.md` is written, Todd has approved it, and his answers are recorded in its "Decisions" section |
| 2 | **Contracts and scaffold** | lead plus one subagent | `docs/plans/mN-contracts.md` (names, schemas, API shapes, file ownership) is committed, and any shared stubs and migrations are on `main` |
| 3 | **Parallel build** | subagents in worktrees | each task's branch is committed and its report is summarised in STATUS (branch, commit, pass/fail). Merged branches are listed. |
| 4 | **Integrate and review** | lead plus a review subagent | everything is merged on `main`, an independent review has run, its findings are fixed or consciously deferred (listed in STATUS), and a local end-to-end run passes |
| 5 | **Release** | lead, with Todd's express permission for each individual push | CI is green, the image is published, and the Tenon store is pinned to the new `version@digest` and pushed |
| 6 | **Verify on the Umbrel** | Todd and the lead | Todd installs or updates, the milestone's on-device checks pass (LAN and Tailscale), and `STATUS.md` marks the milestone closed |

## Numbered steps and clear points

Each stage is cut into numbered steps: stage 2's steps are 2.1, 2.2 and so on, then stage 3 starts at 3.1. A step is always named with its milestone, e.g. **M2 · 3.1**. STATUS's "Next action" always names the step.

✂ marks a clear point: commit, update STATUS, then `/clear` (or stop for the day). A step with no ✂ runs straight on into the next one in the same session. A step marked **Todd** can't finish without him; the session stops there and STATUS says what he needs to do.

### Standard steps (M2 onwards)

| Step | What happens | Ends with |
|---|---|---|
| **1.1** Audit | read-only subagents survey the code and the brief section for the milestone | findings in a draft `mN-plan.md`, committed ✂ |
| **1.2** Plan | lead writes the plan, with the open questions for Todd listed at the end | plan committed, questions put to Todd. **Todd** ✂ |
| **1.3** Decisions | Todd's answers are recorded in the plan's "Decisions" section | plan marked approved, committed ✂ |
| **2.1** Contracts | `mN-contracts.md`: names, schemas, API shapes, file ownership, and the **list of waves for stage 3** (which become steps 3.1, 3.2, ...) | contracts committed ✂ |
| **2.2** Scaffold | shared stubs, feature keys and migrations on `main` | local boot passes, committed ✂ |
| **3.1, 3.2, ...** Build waves | one step per wave from the contracts; subagents in worktrees | every branch in the wave committed and listed in STATUS (branch, commit, pass/fail) ✂ |
| **4.1** Integrate | all branches merged on `main` | local end-to-end run passes, committed ✂ |
| **4.2** Review | an independent review subagent runs | findings listed in STATUS ✂ |
| **4.3** Fix | findings fixed or consciously deferred (reason in STATUS) | local end-to-end run passes again, committed ✂ |
| **5.1** Publish | version bumped, Todd OKs the push, CI runs | CI green, `image:` line recorded in STATUS. **Todd** (push OK) ✂ |
| **5.2** Pin | Tenon store: compose pinned to `version@digest`, `version:` and `releaseNotes` bumped | Todd OKs the push, store pushed. **Todd** ✂ |
| **6.1** On-device checks | Todd updates in umbrelOS; the milestone's checks run over LAN and Tailscale | checks recorded in STATUS. **Todd** (no ✂, straight on) |
| **6.2** Close | milestone marked closed in STATUS; merged worktrees cleaned up; next milestone's 1.1 set as the next action | committed ✂ |

### M1 Foundation: remaining steps

Stages 1–5 are done (0.1.0 released, Tenon store pushed).

| Step | What happens | Ends with |
|---|---|---|
| **M1 · 6.1** Install and set up | Todd installs "Joinr Crosscuts" from the Tenon store, runs `/setup.html` on port 4933 to create his admin account, and confirms "Require Umbrel login" is OFF | app answers on port 4933. **Todd** (no ✂, straight on) |
| **M1 · 6.2** On-device checks | over BOTH the LAN (`umbrel.local:4933`) and Tailscale (`100.111.185.96:4933`): logged out, `/api/workers` gives 401 and `/schedule.html` gives 302 to `/login.html`; login with "remember this device" works; the board loads; a non-admin role gets 403 where expected; a browser POST does not get "Cross-origin request refused" (the gateway passes `Host` through) | results recorded in STATUS. **Todd** ✂ |
| **M1 · 6.3** Close M1 | M1 marked closed; old `.claude/worktrees/` cleaned up; next action set to M1.1 · 1.1 | committed ✂ |

### M1.1 Maintenance steps

M1.1 is four small upgrades, each its own release (decision on record), so it uses its own stage list instead of the standard six. Stage 1 is the plan; stages 2 to 5 are one upgrade each, in the order set by `m1.1-plan.md`. Todd chose Node 24 over 22 (2026-10-10), which needs the database library upgraded first as its own release.

| Step | What happens | Ends with |
|---|---|---|
| **M1.1 · 1.1** Plan | short `m1.1-plan.md`: what each upgrade changes, the breaking changes (sharp especially), how a CI-only change releases, the checks per release | Todd approves. **Todd** ✂ |
| **M1.1 · 2.1** better-sqlite3 12.9.0: build | better-sqlite3 pinned to 12.9.0 on Node 20, version bumped (0.1.1), smoke check added | committed ✂ |
| **M1.1 · 2.2** better-sqlite3: release | push (Todd OK), CI green, Tenon store pinned and pushed (Todd OK) | **Todd** ✂ |
| **M1.1 · 2.3** better-sqlite3: verify | Todd updates; login, board, one board edit and its audit entry checked over LAN and Tailscale (plus the carried M1 LAN check) | **Todd** ✂ |
| **M1.1 · 3.1** Node 24: build | base image to Node 24, version bumped (0.1.2), smoke check added, local run | committed ✂ |
| **M1.1 · 3.2** Node 24: release | as 2.2 | **Todd** ✂ |
| **M1.1 · 3.3** Node 24: verify | Todd updates; login, board and photo pages checked over LAN and Tailscale | **Todd** ✂ |
| **M1.1 · 4.1** sharp 0.35: build | sharp upgraded (0.1.3), breaking changes handled, rotated-photo smoke test added, photo upload and thumbnails tested locally | committed ✂ |
| **M1.1 · 4.2** sharp 0.35: release | as 2.2 | **Todd** ✂ |
| **M1.1 · 4.3** sharp 0.35: verify | Todd updates; uploads a portrait phone photo and checks its thumbnail on the device | **Todd** ✂ |
| **M1.1 · 5.1** Actions: build | GitHub Actions moved to Node-24-native versions, version bumped (0.1.4) | committed ✂ |
| **M1.1 · 5.2** Actions: release | push (Todd OK); CI green on both architectures; not pinned in the store (same app code as 0.1.3) | **Todd** ✂ |
| **M1.1 · 6.1** Close M1.1 | M1.1 marked closed; next action set to M2 · 1.1 | committed ✂ |

### M1.2 House style steps

The whole app is re-themed to the house style (`docs/plans/style-plan.md`, approved 2026-10-10). It ships as one release, 0.1.4, which also carries the M1.1 · 5.1 Actions upgrade, so M1.1 · 5.2 happens at M1.2 · 2.2.

| Step | What happens | Ends with |
|---|---|---|
| **M1.2 · 1.1** Plan | review of every page; `style-plan.md`; decisions on the board, worker colours and icons | Todd approves. **Todd** ✂ (done 2026-10-10) |
| **M1.2 · 1.2** Build | foundations (tokens, shared components, menu bar, the "No access" page); every page; the board and `exportJpg()`; `ci/style-check.sh` in CI; before and after screenshots | committed ✂ |
| **M1.2 · 1.3** Review | Todd looks at the before and after screenshots; changes made | **Todd** ✂ |
| **M1.2 · 2.1** Release | version 0.1.4; push (Todd OK); CI green; Tenon store pinned and pushed (Todd OK) | **Todd** ✂ |
| **M1.2 · 2.2** Verify | Todd updates; the pages, the TV board and a JPG export checked on the device | **Todd** ✂ |
| **M1.2 · 3.1** Close | M1.1 and M1.2 marked closed; next action set to M2 · 1.1 | committed ✂ |

### Later milestones

M2 onwards use the standard steps above. The number of build waves (3.1, 3.2, ...) is fixed at step 2.1 and written into that milestone's contracts. The cutover runbook and the backup job get their own step lists in their plans.

## What gets written at each clear point

Update `docs/plans/STATUS.md` (overwrite the "Now" section and append one line to "History"):
- **Now:** the milestone, the step just finished and the next step, by number (e.g. "M2 · 3.1 done; next M2 · 3.2").
- **Next action:** the step number and the one concrete thing the next session does first, and whether it needs Todd.
- **Waiting on Todd:** questions or actions outstanding.
- **Open branches/worktrees:** anything not yet merged.
- **Deferred findings:** review findings not fixed, with the reason.
- **Facts a fresh session needs** that aren't in CLAUDE.md (rarely; prefer putting them in CLAUDE.md).

Then commit locally. **Nothing is ever pushed, to any repo and docs included, without Todd's express permission for that push.** A clear point needs only a local commit; the next session can see it.

## To resume after `/clear`

Todd pastes:

> Resume Crosscuts. Read CLAUDE.md, then docs/plans/STATUS.md, and continue from "Next action". Don't redo finished stages or re-ask recorded decisions.

## Milestone order

This follows brief §9. The reasoning: money first, because it is the reason for the app; then the job pipeline that feeds it; then the cross-cutting messaging that both need; then board extras; then Joinr. Cutover happens when Todd judges Crosscuts sufficient, likely after M2 or M3.

| Milestone | Scope | Notes |
|---|---|---|
| **M1** Foundation | logins, roles, user admin, audit, job record, shell, existing features behind login | **Closed 2026-10-10** (0.1.0, verified over Tailscale; LAN re-check carried in STATUS) |
| **M1.1** Maintenance | better-sqlite3 11 → 12.9, then Node 20 → 24 in the image; sharp 0.33 → 0.35 (security fixes; breaking, so test photo upload/thumbnails); GitHub Actions to Node-24-native versions | Small; its own step list above (one release per upgrade) |
| **M1.2** House style | every page, the menu bar and the board re-themed to the house style (brand guide, Offcuts as reference); a CI style check keeps future pages on it | One release (0.1.4) with the M1.1 Actions upgrade |
| **M2** Accounts | invoice table (deposit/progress/final/extras), invoice prompts from job events, Friday 12:00 Sydney round-up, ntfy push to Todd, overdue list | Decide ntfy self-hosted vs ntfy.sh in the plan |
| **Cutover runbook** | `docs/cutover.md` per brief §9a, rehearsed on a fresh copy of the live DB | Written before any cutover date is proposed |
| **M3** Design/PM | pipeline board (pointer-event drag), orders (with "materials ordered" → 50% prompt), client inspections, photos linked to jobs | Includes a new version of the photo tag filter (replacing the abandoned `/api/tags` WIP) |
| **M4** Collaboration | tasks, comments, messaging/channels, notification bell (replaces the dashboard placeholders) | |
| **M5** Scheduling extras | leave and availability, lookahead, production stage capture at Finish week, board indicators (mirrored in `exportJpg`) | Board-touching: extra care and the exportJpg mirror rule |
| **M6** Joinr intake | pull sync of accepted quotes, contract document shared with tenon-quotr, intake inbox vs auto-create | |
| **Backup** | weekly copy to the offsite NAS over Tailscale, with a tested restore runbook | As soon as Todd supplies the NAS details; can slot in anywhere |

Each milestone gets its own `mN-plan.md` at stage 1. Nothing above is approved until that plan is.
