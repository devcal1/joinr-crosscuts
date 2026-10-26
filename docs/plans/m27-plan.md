# M27 plan: Workshop manager (0.2.6)

Part of `workflow-roadmap.md` (read it first). Needs M23 (Workshop department), M24 (all-ordered rule), M25 (shift page) and M26 (Dashboard "waiting on you" tiles).

## Todd's words (2026-10-26, in substance)

The workshop manager, once a fortnight, records what stock we have against a kept list of the total amounts we want; this creates an order list sent to the order manager. They run the maintenance schedule, kept in the Planner, and each item must be confirmed as actioned when due. (Vehicle bookings are in M28 with the vehicles register.)

## Todd's decisions

- Stock is counted on a true **fortnightly** cycle, with a **target** per item; the order amount fills in as target minus have.
- The workshop manager keeps the stock list and the targets.
- Maintenance items are confirmed by the **workshop manager only**.
- Workshop is a department (M23 sets up its notes wall, channel and Planner layer).

## What exists (do not rebuild)

Ordering > Stock order (`lib/stock.js`, `routes/stock.js`, `/stock.html`): one record per calendar month (`stock_orders.period`, YYYY-MM), Have typed by `stock.count`, Finish count bells `stock.order` holders, Ordering types Order, marks supplier groups ordered, prints sheets; Deliveries receives. Admin > Tasks recurring tasks (`lib/recurring.js`, migration 036): Planner repeat rules, occurrences as tasks with Done ticks, overdue in red. Stock orders are not job orders (`orders.job_id` is NOT NULL): keep them separate.

## Build

1. **Targets (migration, additive).** `stock_items.target` (whole number or null). The stock list and targets are editable by `stock.count` holders as well as `stock.order`.
2. **Fortnightly cycle.** Setting `stock.cycle` (`monthly` | `fortnightly`, default fortnightly after this release) and `stock.cycle_start` (a Monday). A fortnight period key `YYYY-MM-DD` (its Monday) in the existing `period TEXT` column; month keys already stored stay readable. Period helpers in `public/periods.js` and `lib/stock.js`. Dashboard "Stock count due" from the second Thursday of the fortnight until done. The board stocktake stays monthly unless Todd says otherwise.
3. **Order amounts.** Order defaults to max(target − have, 0) when Have is saved or the Order tab opens; Ordering can overwrite. Finish count's existing bell to Ordering is the "order list sent" and now says how many lines and suppliers.
4. **Maintenance.** New feature key `maintenance.manage` (workshop_manager, admin, owner; follow `docs/how-to-add-feature-key.md`). `recurring_tasks.kind` (nullable, `maintenance`). Page **Workshop > Maintenance** (`/maintenance.html`): items with repeat, next due, last done (who, when), overdue; add, edit, pause and delete maintenance items (other kinds stay on Admin > Tasks). Occurrences go to the workshop manager(s) on the workshop Planner layer. **Only `maintenance.manage` holders can tick an occurrence done** (Confirm actioned, with an optional note). An occurrence 7 or more days overdue bells admin once a week.
5. **Board and edge tape stock with reservations** (Todd, 2026-10-26). The workshop manager keeps a list of board and **edge tape rolls** in stock.
   - Edge tape rolls join the existing board list (`lib/boards.js`) as a second kind (additive column `kind`: board | edge; edge has width/thickness/colour), counted in **whole rolls**. The workshop manager (stock.count) may edit the list.
   - **Live on hand:** each item shows on hand, reserved and free (on hand − reserved). The fortnightly count resets on hand to what was counted.
   - **Reserve instead of order:** when a job is sent to Ordering (M22/M24), on any boards or edging line of the order list the order manager may choose **Reserve from stock** (pick the stock item and quantity, no more than free) instead of ordering new; the rest of the line can still be ordered. Table `stock_reservations` (job, materials line, stock item, qty, status, reserved by/at, confirmed by/at, cut by/at, released by/at; additive). A reserved line counts as ordered for the all-ordered rule (M24).
   - The workshop manager gets a bell and a **To reserve** list: they label the stock for the job and tick **Reserved** (confirmed).
   - **End of every shift:** the workshop manager selects which jobs have been **cut 100%** (on the M25 shift page and on the To reserve page). Every confirmed reservation for those jobs is then removed from stock (on hand goes down). Recording a job as cut 100% is audited and shows on the job page.
   - Release: the order manager or workshop manager can release a reservation before cutting (back to free stock, audited).
6. **Waiting on you (workshop manager).** Dashboard tile: stock count due, maintenance due or overdue, (M28) vehicle bookings this week, stock to label as reserved, jobs to mark cut 100% at end of shift, deliveries to receive.

## Deliverables

Migration(s) 047+, contract `m27-contracts.md`, how-tos (`how-to-do-the-stocktake.md` updated, new `how-to-maintenance.md`), smoke `ci/smoke-m27-workshop-manager.sh` (fortnight keys alongside month keys, targets, order fill, maintenance access and ticks), version 0.2.6, STATUS.md.

## Open for Todd

Which Monday starts the first fortnight; whether the board stocktake also goes fortnightly.
