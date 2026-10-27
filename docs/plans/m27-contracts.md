# Workshop manager: contract (0.2.6, Todd 2026-10-26)

Plan: `m27-plan.md` (part of `workflow-roadmap.md`). Builds on 0.2.5 (`m26-contracts.md`). Everything before still holds except where a section below changes it. CLAUDE.md applies: additive migration, `defineRoutes` with an access value, house style, board layout untouched.

Code: migration `048_workshop_manager.sql` (the plan said 047+; M26 took 047); `lib/maintenance.js`, `lib/reservations.js`, `routes/maintenance.js`, `routes/reservations.js`; changes to `public/periods.js`, `lib/settings.js`, `lib/stock.js`, `routes/stock.js`, `lib/boards.js`, `routes/boards.js`, `lib/recurring.js`, `lib/tasks.js`, `lib/orders.js`, `lib/mywork.js`, `lib/permissions.js`, `lib/pages.js`, `server.js`; pages `public/maintenance.html|js|css`, `public/reserve.html|js|css`, `public/jobreserve.js|css` (on `job.html`), `public/shiftcut.js` (on `shift.html`), `public/stock.html|js`, `public/boards.js`, `public/shell/shell.js`. Test: `ci/smoke-m27-workshop-manager.sh`; `ci/smoke.sh` (key counts, the workshop_manager preset) and `ci/smoke-m11-stock.sh` (the workshop manager may now edit the lists) updated.

## 1. Data

Migration 048, additive only:
- `stock_items.target` (whole number >= 0, or NULL).
- `recurring_tasks.kind` (NULL or `maintenance`); `recurring_occurrences.note` (Confirm actioned's note, default ''), `recurring_occurrences.overdue_belled_on` (Sydney date).
- `boards.kind` (`board` default | `edge`), `boards.width` (mm, edge), `boards.colour`, `boards.on_hand` (REAL >= 0 or NULL), `boards.on_hand_at`.
- `stock_reservations(id, job_id, order_id, material_id, board_id, qty > 0, covers 0|1, status reserved|confirmed|cut|released, reserved_by/at, confirmed_by/at, cut_by/at, released_by/at)`.
- `job_cuts(job_id PRIMARY KEY, date, cut_by, cut_at)`: a job recorded as cut 100%, once.

Settings `stock.cycle` (`monthly` | `fortnightly`, default `fortnightly`) and `stock.cycle_start` (a Monday, default `2026-10-26`, Todd 2026-10-27). Not in `/api/settings`.

## 2. Fortnightly cycle

- A stock period is a month (`YYYY-MM`, as before) or a fortnight (`YYYY-MM-DD`, its Monday), both in `stock_orders.period`. Any started period of either kind reads and writes; a fortnight key must be a real Monday (a Tuesday is 400); one not yet started is 400. Month records already stored stay readable.
- `Periods` (public/periods.js) gains `validStockPeriod`, `validFortnight`, `isFortnight`, `isMonday`, `fortnightOf(date, cycleStart)`, `currentStockPeriod(today, cycle, cycleStart)`, `addStockPeriods`, `stockPeriodEnd`, `stockPeriodStarted`, `stockLabel` (a month's long label, or "26 Oct – 8 Nov 2026") and `addDays`.
- `GET /api/stock/settings` (stock.count or stock.order) → `{cycle, cycleStart, current, currentLabel, today}`. `PUT /api/stock/settings {cycle?, cycleStart?}` (stock.order): bad cycle or a start that isn't a Monday 400; audited `settings.update`.
- The month view gains `label` and `kind` (`month` | `fortnight`); `GET /api/stock/orders` rows gain `label`.
- **Stock count due** (`lib/stock.js stockCountDue`; the dashboard's stock line for stock.count and the workshop manager's Waiting on you): fortnightly, the fortnight before while it isn't counted (`overdue: true`), else the current fortnight from its Thursday (3 days after its Monday) until counted; monthly, as before. The board stocktake stays monthly (Todd, 2026-10-27).

## 3. Targets and the order fill

- Stock items carry `target`. Creating, editing and reordering the list, and `?all=1`, are now open to **stock.count** as well as stock.order (the workshop manager keeps the list and targets).
- Each month or fortnight line carries `target` and `suggested` (max(target − have, 0), or null without both).
- **Order fill:** when Have is saved, a line with a target whose Order is empty or still the old suggestion (and whose supplier group isn't ordered, and not raised above 0 on a month marked nothing to order) gets Order = the new suggestion. Finish count fills every such line. An Order Ordering typed is kept. Audited `stock_order.order_fill`.
- Finish count's existing bell to stock.order holders (kind `stock.counted`) is "the order list sent": its body says "N lines to order from M suppliers." (or "Nothing to order on the count.").

## 4. Maintenance

- Key **maintenance.manage**, the 38th (appended to `KEYS`): workshop_manager, admin (preset now 35 keys) and the owner.
- A maintenance item is a recurring task with `kind 'maintenance'`, always given to the Workshop department (`dept 'workshop'`; any assignee sent is ignored). lib/recurring's functions take `{kind}`: Admin > Tasks (`/api/recurring`) lists and opens only ordinary rules (a maintenance id is 404 there); Workshop > Maintenance only maintenance ones. Occurrences are Workshop department tasks as before (alerts to the Workshop team, the workshop Planner layer, where they say "Maintenance" and link to `/maintenance.html`).
- Routes, all **maintenance.manage**: `GET /api/maintenance` → `{today, items}` (each the recurring rule shape plus `open: [{taskId, dueDate, status, overdue, daysOverdue}]`, `lastDone: {dueDate, at, by, note} | null`, `overdue`); `GET /api/maintenance/:id`; `POST /api/maintenance` (201); `PATCH /api/maintenance/:id`; `POST /api/maintenance/:id/pause|resume`; `DELETE /api/maintenance/:id` (204); `POST /api/maintenance/occurrences/:taskId/done {note?}` (note 1000 characters at most; already done 409; audited `maintenance.done`); `POST /api/maintenance/occurrences/:taskId/reopen` (audited `maintenance.reopen`); `POST /api/maintenance/run {today?}` (never before today) → `{date, made, belled}`.
- **Only maintenance.manage holders tick an occurrence:** `POST /api/tasks/:id/done` and `/reopen` on a maintenance occurrence are 403 for anyone else.
- **Overdue bell:** with the hourly recurring run, each open occurrence 7 or more days overdue bells users.admin holders (kind `maintenance.overdue`, "Maintenance overdue: <title>", link `/maintenance.html`), then again once a week while it stays open.
- Page **Workshop > Maintenance** (`/maintenance.html`, maintenance.manage).

## 5. Board and edge tape stock, reservations, cut 100%

- Board list items carry `kind`, `width`, `colour`, `onHand`, `onHandAt`, `reserved` (sum of reserved and confirmed reservations) and `free` (on hand − reserved, never below 0). Edge tape is counted, held and reserved in whole rolls (400 otherwise). The list (create, edit, reorder, `?all=1`) is open to **stock.count**; setting `priceCents` stays stock.order's (403), and prices are still shown only to stock.order. `onHand` may be typed on the list; finishing a board count sets each counted item's on hand to its quantity (audited `board.on_hand`).
- `GET /api/job-records/:id/reservations` (jobs.view, stock.count or orders.mark_ordered) → `{jobId, lines: [{orderId, materialId, section, name, qty, unit, description, supplier, orderStatus, reservations, covered}], reservations, stock, cut, canReserve, canConfirm}`. The lines are the job's live boards and edging materials lines that have an order line.
- `POST /api/job-records/:id/reservations {orderId, boardId, qty, covers?}` (**orders.mark_ordered**) → 201. The order line must be the job's, from a boards or edging materials line, and still `to_order` (409); a boards line takes a board, an edging line edge tape (400); qty no more than free (409); one covering reservation per line (409). Audited `stock_reservation.create` (entity the job). Bells stock.count holders (kind `stock.reserve`, "Reserve from stock: <job>", link `/reserve.html`). `covers: true` ("nothing left to order on this line") makes the line count as ordered for the all-ordered rule (M24), which then runs as if a line had been marked ordered.
- `POST /api/reservations/:id/confirm` (**stock.count**): reserved → confirmed (labelled). A covering confirmed (or cut) reservation counts as received for the materials-in rule.
- `POST /api/reservations/:id/release` (stock.count or orders.mark_ordered): reserved or confirmed → released (back to free stock); a cut one 409.
- `GET /api/reservations` (stock.count or orders.mark_ordered) → `{toLabel, reservedNotCut, toCut: [{jobId, name, clientName, reservations}], stock, canConfirm, canRelease}`. `toCut`: live jobs not yet cut with a live reservation or a non-install board row this week.
- `POST /api/workshop/cut {jobIds}` (**stock.count**): records each job cut 100% once (`job_cuts`; a repeat is listed in `skipped`); every confirmed reservation of the job becomes `cut` and its quantity comes off on hand. Audited `job.cut_complete` (entity the job). → `{date, cut: [{jobId, name, taken}], skipped, ...the To reserve page}`.
- Pages: **Workshop > To reserve** (`/reserve.html`, stock.count or orders.mark_ordered; in the menu for stock.count), the job page's **Stock reservations** section, and a **Jobs cut 100%** block on the End of shift page for stock.count holders.
- Waiting on you: Ordering's `toOrder` count leaves out lines wholly reserved from stock.

## 6. Waiting on you (workshop manager)

For maintenance.manage holders, `GET /api/my-work` adds: `stockCount` (the stock count due or overdue), `maintenanceOverdue`, `maintenanceDue` (due today), `toLabel` (reservations to label), `toCut` (jobs with labelled stock not yet cut), `deliveries` (deliveries due today or overdue). Vehicle bookings come with M28.

## 7. Access summary

| Route | Access |
|---|---|
| `GET /api/stock/settings` | stock.count or stock.order |
| `PUT /api/stock/settings` | stock.order |
| `POST /api/stock/items`, `PATCH /api/stock/items/:id`, `POST /api/stock/items/reorder` | stock.count or stock.order (was stock.order) |
| `POST /api/boards`, `PATCH /api/boards/:id`, `POST /api/boards/reorder` | stock.count or stock.order (was stock.order; `priceCents` stock.order only) |
| `/api/maintenance` (every route) | maintenance.manage |
| `GET /api/reservations`, `POST /api/reservations/:id/release` | stock.count or orders.mark_ordered |
| `POST /api/reservations/:id/confirm`, `POST /api/workshop/cut` | stock.count |
| `GET /api/job-records/:id/reservations` | jobs.view, stock.count or orders.mark_ordered |
| `POST /api/job-records/:id/reservations` | orders.mark_ordered |
| `/maintenance.html` | maintenance.manage |
| `/reserve.html` | stock.count or orders.mark_ordered |

## 8. Open for Todd's look

- The plan says the count is due "from the second Thursday of the fortnight"; Todd's settled answer says the first fortnight (from Mon 26 Oct) is due from Thu 29 Oct, its first Thursday. Built as the first Thursday (`DUE_FROM = 3` in `lib/stock.js`); one number to change.
- On hand is reset by the board stocktake, which stays monthly; the plan's "the fortnightly count resets on hand" was read as "the count".
- A line wholly reserved from stock still shows as To order on Ordering's own order lists (it is left out of the all-ordered rule and the Waiting on you count).
- The workshop_manager role has no shift.report, so the End of shift page's cut block only helps a workshop manager who also holds it; the To reserve page carries the same list.
