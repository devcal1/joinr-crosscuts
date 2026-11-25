# Monthly stock orders on the Orders page (0.2.27)

Asked for by Todd on 2026-11-25. Mockup: `docs/plans/mockups/stock-C.html`. **Status: approved by Todd 2026-11-25; built as 0.2.27, not pushed.**

## What it is

Ordering > Orders gets a **Stock** section above the job cards: one stock order per calendar month, with no job attached. Three month cards (last, this, next) cycle left and right. The middle month is open underneath, its items in columns by supplier.

The fortnightly count on the Stock order page feeds the order. Ordering can add items by hand. Stock and job items are ordered together on the New supplier order screen.

## Todd's decisions (2026-11-25, binding)

1. **Layout C**, with the opened month's items in two to three columns.
2. **The count feeds the order.** Finishing the count puts its quantities on the monthly order. Items can also be added by hand.
3. **Month:** the order for the month (Sydney) in which Finish count is pressed.
4. **Combined purchase orders.** Stock items appear on New supplier order with job items, so one PO can hold both.
5. **The Order tab on the Stock order page goes.** Count and List stay. Fortnights already ordered there stay viewable, read-only.

## Rules (approved with the plan)

**A. Two counts must not order the same thing twice.** Most months have two counts, and an item ordered after the first may not have arrived by the second. On Finish count, for each item with a target:

- need = target − have − quantity already ordered but not received (never below nothing). This includes supplier groups ordered on the old Order tab and not yet received, so nothing is doubled in the changeover.
- If the item already has a counted line still **To order**, in any month, that line is set to the need and moved to the current month. It is not added again. If the need is zero, the line is removed (hidden, kept in the audit log).
- Otherwise a new To order line is made when the need is above zero.
- Hand-added lines are never changed by a count, and don't reduce the need unless they were picked from the stock list and are already ordered.

*Example: target 20, have 5, so 15 goes on the order and is ordered. At the next count there are 3 on the shelf and the 15 hasn't come: need is 20 − 3 − 15 = 2.*

**B. Ordering can change a counted quantity** until the line is ordered. The next count replaces it.

**C. Items with no target** are counted but send nothing. Ordering adds them by hand.

**D. Reopen count** leaves the order as it is. Finishing again applies rule A again. (Added in review: refused once a newer count has been sent or any of its stock has been received; a late older count is kept but not sent.)

**E. Unordered items stay in their month**, orange, until ordered, deleted or picked up by the next count. Hand-added items don't roll over.

**F. Receiving is per item** on Deliveries, in the Stock and paint group (today it is per supplier group).

**G. Fortnights counted but not ordered at the update** are not converted automatically. Each shows **Send to monthly order** (Ordering), which applies rule A once. It refuses if a newer count has already been sent. Groups already ordered there finish on Deliveries as now.

## Screens

**Stock section (Job cards tab, above the cards)**
- Previous month, This month, Next month and Print month. Months run from the first with an order to next month. The month is kept in the address, so a link opens it.
- Month cards: to order, ordered, received. Press one to open it.
- The open month: one block per supplier, three columns wide, two narrower, one on a phone. Each item: name, quantity, ordered date, status. Lines that came from a count are marked COUNT in small muted type; ordered lines link to their PO.
- Press an item to edit quantity, supplier, item or notes, delete it, or undo ordered.
- Add item: supplier and item type-ahead (the stock list, order lines and Supplier accounts names; new names allowed), and quantity. Picking a stock list item links the line to it.
- The supplier block's button reads **Order** (not Mark ordered, as the mockup had it). It opens New supplier order for that supplier with that month's stock items ticked.

**New supplier order**
- Suppliers with only stock to order are listed too, and the counts include stock.
- A **STOCK** group sits above the job groups, with each item's month in muted type. Nothing is ticked by default except when coming from Order.
- Mark N ordered marks stock and job items in one transaction, under one PO number. If any ticked item has changed, nothing is marked and the list reloads, as now.
- Stock items never affect job materials or progress invoices.

**Supplier orders tab, PDF and print list:** stock items under a STOCK heading; the Jobs column shows STOCK. POs already saved and their PDFs are not touched.

**Stock order page:** Count and List only. After Finish count: how many items went to which month, with a link. Past ordered fortnights show a read-only Ordered view.

**Dashboard and alerts:** "Stock order November: 7 to order" replaces the fortnight's "counted, to order" line and links to the month. "Nothing to order this month" goes, since an empty month needs no action. The Stock counted alert links to Orders.

## Who

Changed by Todd 2026-11-25 (after the first build): **anyone can add** a stock item, and each shows **who added it and when**. `orders.view` joins the Workshop and Showroom presets, so every role opens Orders. Change or delete while To order: the person who added it by hand, Ordering and admin. **Only Ordering and admin order** or undo ordered (`orders.mark_ordered`). Receive: `orders.receive`. Finishing the count stays `stock.count`. No new key.

Finishing a count writes to the order on the counter's behalf; the audit rows name them.

## Data

Migration **068** (additive; deletes nothing):
- `stock_lines`: month (`YYYY-MM`), supplier, item, code, quantity, status, ordered, expected and received dates, received by, notes, delivery note, source (`count` or `hand`), `stock_item_id` (optional), `supplier_order_id` (optional), deleted at and by, created and updated stamps.
- `stock_orders` gains `sent_at`, `sent_period`.

A separate table, because every row in `orders` must have a job and drives that job's invoice. `supplier_orders` is unchanged; `supplier_order_lines` keeps job lines only, and stock items are in the PO's frozen snapshot and linked from `stock_lines.supplier_order_id`.

## API

All through `defineRoutes`, under `/api/stock-lines` (months, month, add, edit, delete, undo, receive), with the keys above. `POST /api/orders/mark-ordered` also accepts `stockLineIds`. Marking lives in one place: `markOrderedMany`, extended. The old group routes: marking ordered is removed; receive, undo received and undo ordered stay for old groups.

## Build, test, docs

- **Order:** 1. migration, rules and API; 2. Stock section; 3. New supplier order, PO and PDF; 4. Stock order page, Deliveries and dashboard.
- **Smoke:** new `ci/smoke-stock-orders.sh`: rule A with two counts and an unreceived order, a month boundary, reopen, send once, combined PO, the 409 with nothing changed, access, receive, undo. Update the m11 stock and m27 suites and the PO suites.
- **Checks:** full local smoke, style check, browser at 375, 1000 and 1400 px, print, existing PO PDFs unchanged.
- **Docs:** `how-to-do-the-stocktake.md`, `how-to-job-cards.md`, STATUS.
- **Size:** larger than job cards, as it touches counting, ordering, POs, Deliveries and the dashboard. No push until Todd says.

## Not touched

The board, drawer and paint orders, the board stocktake, saved POs, past counts, and Joinr.
