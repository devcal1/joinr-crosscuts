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

Large stages may be split further. Stage 3 can take one clear point per wave, as long as STATUS records which branches are merged and which are still open.

## What gets written at each clear point

Update `docs/plans/STATUS.md` (overwrite the "Now" section and append one line to "History"):
- **Now:** the milestone, the stage just finished, and the next stage.
- **Next action:** the one concrete thing the next session does first, and whether it needs Todd.
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
| **M1** Foundation | logins, roles, user admin, audit, job record, shell, existing features behind login | Built and released as 0.1.0; on-device verification pending |
| **M1.1** Maintenance | Node 20 → 22 in the image; sharp 0.33 → 0.35 (security fixes; breaking, so test photo upload/thumbnails); GitHub Actions to Node-24-native versions | Small; stages 1 and 2 collapse into a short plan |
| **M2** Accounts | invoice table (deposit/progress/final/extras), invoice prompts from job events, Friday 12:00 Sydney round-up, ntfy push to Todd, overdue list | Decide ntfy self-hosted vs ntfy.sh in the plan |
| **Cutover runbook** | `docs/cutover.md` per brief §9a, rehearsed on a fresh copy of the live DB | Written before any cutover date is proposed |
| **M3** Design/PM | pipeline board (pointer-event drag), orders (with "materials ordered" → 50% prompt), client inspections, photos linked to jobs | Includes a new version of the photo tag filter (replacing the abandoned `/api/tags` WIP) |
| **M4** Collaboration | tasks, comments, messaging/channels, notification bell (replaces the dashboard placeholders) | |
| **M5** Scheduling extras | leave and availability, lookahead, production stage capture at Finish week, board indicators (mirrored in `exportJpg`) | Board-touching: extra care and the exportJpg mirror rule |
| **M6** Joinr intake | pull sync of accepted quotes, contract document shared with tenon-quotr, intake inbox vs auto-create | |
| **Backup** | weekly copy to the offsite NAS over Tailscale, with a tested restore runbook | As soon as Todd supplies the NAS details; can slot in anywhere |

Each milestone gets its own `mN-plan.md` at stage 1. Nothing above is approved until that plan is.
