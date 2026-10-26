# M24 plan: Board placement and money triggers (0.2.3)

Part of `workflow-roadmap.md`. Needs M23 (requested install date, order manager alert).

## Goal

Sending the order list starts manufacture on the board and raises the 10% deposit; finishing the ordering raises the 50%, moves the job to Ready to cut and asks the schedule manager for an install date.

## Build

1. **Board lead setting.** `board.lead_weeks` in `lib/settings.js` (whole number 0 to 12, default 2), on an Admin "Board settings" field (users.admin). 0 means "don't place automatically".
2. **Auto-place at Send to Ordering.** If the job has no current or future board row, create one in the manufacturing panel in the week of Monday(today) + lead weeks, with nobody assigned, through the same code path the board's own add uses (so `jobstage.onScheduled` runs). The board layout is untouched; this is data only. Audit `board.autoplace`.
3. **On board (ordering).** A job on the board with to_order lines left displays as "On board (ordering)" on the Pipeline, jobs list and job page. Hand moves stay locked as for any on-board job.
4. **10% at Send to Ordering.** The deposit falls due at Send to Ordering with a new due reason `order_list_sent` (additive). The existing board-placement trigger stays as a fallback for jobs that reach the board without a list (quick-adds). Raised once only.
5. **All ordered.** When the last to_order line is ordered (existing rule in `lib/orders.js`; the 50% already falls due here):
   - move the job to Ready to cut if it is still at Projects/Ordering (not when already on the board);
   - bell holders of board.edit: "All ordered for X. Requested install DATE: set the install date."
6. **Needs install date list.** On the Scheduling notes wall: jobs with everything ordered and no Promised install date, with requested date, latest ETA and a Confirm install date dialog (sets `promised_install_date`, which stays the confirmed date on the Planner). board.edit.
7. **ETA nudge.** In the 7:00 weekday sweep (`lib/tasks.js`), bell orders.mark_ordered holders with the counts of ordered lines with no expected date and of lines past their expected date and not received, linking to Orders.

## Deliverables

Migration 044 if any column is needed (due reason is free text checked in code; check `invoices` CHECK first, and if it is a CHECK, use a new nullable column instead of changing it), contract `m24-contracts.md`, how-to updates (project jobs, invoices, board), smoke `ci/smoke-m24-board-money.sh`, version 0.2.3, STATUS.md.

## Risks

Stage and invoice side effects: write the smoke first for each trigger (sent, placed, all ordered, quick-add fallback, re-send after revision B must not raise a second deposit).
