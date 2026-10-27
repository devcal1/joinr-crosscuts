# Board placement and money triggers: contract (0.2.3, Todd 2026-10-26)

Plan: `m24-plan.md` (part of `workflow-roadmap.md`). Builds on 0.2.2 (`m23-contracts.md`). Everything before still holds except where a section below changes it. CLAUDE.md applies: additive migration, `defineRoutes` with an access value, house style, board layout untouched (data only).

Code: migration `045_order_list_deposit.sql`; `lib/handoffs.js`, `lib/boardrows.js`, `routes/handoffs.js`; changes to `lib/invoices.js`, `lib/orders.js`, `lib/projectjobs.js`, `lib/jobstage.js`, `lib/tasks.js`, `lib/settings.js`, `routes/settings.js`, `routes/schedule.js` (the add uses `lib/boardrows.js`), `routes/jobs.js`, `server.js`; pages `public/users.html|js`, `public/notes.html|css`, `public/schedulingdash.js`, `public/pipeline.js`, `public/jobs.js`, `public/job.js`. Test: `ci/smoke-m24-board-money.sh`.

## 1. Board lead setting

`board.lead_weeks` (whole number 0 to 12, default 2) in `lib/settings.js`. `GET /api/settings` answers `board: {leadWeeks}`; `PUT /api/settings` takes `{board: {leadWeeks}}` (users.admin; else 400 "Board lead weeks must be a whole number from 0 to 12"). On Admin > Users, Business details, **Board lead (weeks)**. 0 = don't place automatically.

## 2. Auto-place at Send to Ordering

Inside the send transaction, after the move to Ordering: when the lead is above 0 and the job has no week row this week or later, a row is added in the **manufacturing** panel in the week of Monday(today, Sydney) + 7 × lead days, nobody assigned, at the bottom of that week's panel, through `lib/boardrows.js addRow` (the same path as the board's own add, so `jobstage.onScheduled` moves the job to On board). Audited `board.autoplace` `{weekStart, rowId, panel, leadWeeks}`. The send answer gains `placed: {weekStart, rowId} | null` and `depositDue: bool`.

Send is now also allowed from On board and Ready to cut (a later revision of a placed job); the job only moves to Ordering from Won or Projects.

## 3. 10% at Send to Ordering

Migration 045 adds `invoices.due_trigger` (NULL or `order_list_sent`), because 006's CHECK on `due_reason` can't take a new value. At Send to Ordering, a job with no deposit in any status gets one (`due_reason` NULL, `due_trigger 'order_list_sent'`; pending if the job has no value, as before), announced with the body "The order list was sent to Ordering." Raised before the board row, so the placement fallback (`onScheduled`, `due_reason 'scheduled'`) finds it and stays quiet; that fallback still covers jobs placed without a list (quick-adds). A re-send never raises a second deposit.

## 4. On board (ordering) and all ordered

- Every job object carries `boardOrdering`: stage `on_board` with at least one `to_order` line; then `orderingProgress` is filled too. The Pipeline's On board tile reads "On board (ordering) · n/m ordered", the Jobs list "On board (ordering)", the job page's details line "On board (ordering): n of m ordered". Hand moves stay locked as for any on-board job.
- The first time the all-ordered rule fires for a job (`lib/orders.js`: the last to_order line ordered, or cancelled by an orders.mark_ordered holder; this already sets `materials_ordered_date` and makes the 50% due):
  - a job still at `design_ordering` (Projects or Ordering) moves to **Ready to cut** (audited stage move; it joins To start). A job on the board stays there.
  - every holder of `board.edit` except the actor gets kind `job.all_ordered`, "All ordered for X. Requested install D Mon YYYY: set the install date." ("not given" when there is none), linking to `/notes.html?dept=scheduling#needsInstall`.

## 5. Needs install date

- `GET /api/install-dates/needed` (board.edit) → `{jobs: [{id, name, clientName, pipelineStage, requestedInstallDate, latestEta}]}`: live jobs (not archived, not complete/invoiced/lost/archived) with at least one live order line, none to order, and no promised install date; by requested date (none last), then name. `latestEta` is the latest expected date of the ordered and received lines.
- `POST /api/job-records/:id/confirm-install` `{date}` (board.edit): sets `promised_install_date` (the confirmed date; it is the Planner's Promised install). Bad date 400, unknown job 404. Audited `job.update` with `via: "confirm_install"`. → `{changed, job: {id, name, promisedInstallDate}}`.
- Shown under the Scheduling notes wall for board.edit holders, one row per job with **Confirm install date** (a dialog with the requested date filled in).

## 6. ETA nudge

The weekday 7:00 task reminder (`lib/tasks.js runReminder`) also counts, over live jobs, ordered lines with no expected date and lines to order or ordered past their expected date. When either is above 0, each holder of `orders.mark_ordered` gets one unread kind `orders.eta_nudge` per day ("N ordered lines have no expected date; M lines are past the expected date"), linking to `/orders.html`. `runReminder` answers `etaNudges` (how many were sent).

## 7. Access summary

| Route | Access |
|---|---|
| `PUT /api/settings` `{board}` | users.admin |
| `GET /api/install-dates/needed` | board.edit |
| `POST /api/job-records/:id/confirm-install` | board.edit |

## 8. Open for Todd's look

- The default lead of 2 weeks: confirmed by Todd 2026-10-27.
- A placed job moves to On board at once, shown as On board (ordering): confirmed by Todd 2026-10-27.
