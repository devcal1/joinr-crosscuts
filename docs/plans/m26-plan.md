# M26 plan: Morning check and completion (0.2.5)

Part of `workflow-roadmap.md`. Needs M23 to M25.

## Goal

The schedule manager has one place each morning to update yesterday's jobs; completion is confirmed by the project manager before the final 40% falls due; everyone sees what is waiting on them.

## Build

1. **Morning check** (Scheduling notes wall section, board.edit). For the previous working day: every job on the board that day, with a production stage pick (the stages in `lib/production.js`) and an optional short note, stored per job per day (migration 046, additive: `production_days(job_id, date, stage, note, set_by, set_at)`). Also listed: rows with nobody on them, Ready to cut jobs not placed, installs this week without a Promised install date, and open job issues (M25). A Done for today button records who and when (setting `board.morning_last_done`).
   - The latest daily stage becomes the job's current production stage, so the board's existing stage label (M5 exception) shows it with no board change. Finish week still records its stage; the later of the two wins.
2. **Installed, then confirmed.** Finish week's "complete" outcome now records the job as installed (`jobs.installed_date`, migration 046) and does not complete it. Only the dialog's label text changes; the layout stays the same. The project owner (else design.view holders) gets a bell: "X installed: confirm complete".
   - **Confirm complete** on the job and project pages (the project owner, or users.admin when the owner is away) runs the existing completion path: stage complete, `completed_date`, final 40% due. Open issues show a warning but don't block confirmation.
   - Pipeline Complete column shows "Awaiting PM confirm" for installed but unconfirmed jobs.
   - **CLAUDE.md:** add this to non-negotiable 7 as a named exception (approved by Todd 2026-10-26: PM confirmation of completion), and mirror it in `exportJpg()`/print only if anything visible changes (it shouldn't).
3. **Waiting on you.** Dashboard "Your work" tiles per role: project manager (steps to do, no requested date, installs to confirm, open issues), order manager (lists to order, missing ETAs), schedule manager (morning check not done, needs install date, open issues), workshop (report not sent today), accounts (invoices due; existing).

## Deliverables

Migration 046, changes in `routes/schedule.js` Finish week path and `lib/jobstage.js`, Morning check UI, Dashboard tiles, contract `m26-contracts.md`, how-to updates, smoke `ci/smoke-m26-morning-complete.sh` (and update existing board smokes that expect Finish week complete to complete the job), version 0.2.5, STATUS.md, CLAUDE.md exception text.

## Risks

Existing smokes and old jobs assume board "complete" completes the job and raises the final invoice; jobs already complete before the release are untouched.
