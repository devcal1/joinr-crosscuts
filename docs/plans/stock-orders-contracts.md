# Monthly stock orders: build contracts (0.2.27)

Access changed by Todd 2026-11-25 after the build: see Who in the plan (add and delete: `orders.view`, edits: the adder or `orders.mark_ordered`).

Binding with `stock-orders-plan.md` (approved by Todd 2026-11-25) and `mockups/stock-C.html`. If a contract looks wrong, report it, don't work around it. Follow CLAUDE.md. Nobody commits, pushes, bumps versions (the lead does) or runs the full smoke (fixed ports; the lead does).

## File ownership

- **S (server):** `db/migrations/068_stock_lines.sql`, `lib/stocklines.js` (new), `lib/stock.js`, `lib/stockdeliveries.js`, `lib/orders.js`, `lib/purchaseorders.js`, `routes/stocklines.js` (new), `routes/stock.js`, `routes/orders.js`, `routes/supplierorders.js`, `server.js`, `lib/audit.js` if needed, `ci/*`.
- **O (Orders pages):** `public/orders.html`, `public/stockorders.js` and `.css` (new, prefix `sk-`), `public/jobcards.*`, `public/orders.js`, `public/supplierorder.js`, `public/supplierorders.*`, `public/orderprint.*`.
- **P (other pages):** `public/stock.*`, `public/deliveries.*`, `public/index.js`, `public/shell/shell.js` only if an alert link or badge needs it, `docs/how-to-do-the-stocktake.md`, `docs/how-to-job-cards.md`.

## Table (068, additive)

`stock_lines`: `id` PK AUTOINCREMENT, `month` TEXT (YYYY-MM), `supplier` TEXT (non-empty), `item` TEXT (non-empty), `code` TEXT default '', `quantity` REAL (> 0), `status` CHECK to_order/ordered/received default to_order, `ordered_date`, `expected_date`, `received_date`, `received_by`, `notes` default '', `delivery_note` default '', `source` CHECK count/hand, `stock_item_id` REFERENCES stock_items, `supplier_order_id` REFERENCES supplier_orders, `deleted_at`, `deleted_by`, `created_at`, `created_by`, `updated_at`, `updated_by`. Indexes on (month), (status), (stock_item_id, status). `stock_orders` gains `sent_at` and `sent_period` (TEXT, the month).

## Line shape (JSON everywhere)

`{id, month, supplier, item, code, quantity, status, orderedDate, expectedDate, receivedDate, receivedBy:{id,name}|null, notes, deliveryNote, source, stockItemId, supplierOrderId, poNumber|null, createdAt, createdBy:{id,name}|null, overdue}`. Deleted lines are in no list or count. Quantity: as order lines (max 2 decimals, max 99999), above 0. Lengths as order lines.

## Routes

- `GET /api/stock-lines/months` (`orders.view`): `{current, first, last, months:[{month, toOrder, ordered, received}]}`; `first` = earliest month with a line (or current), `last` = the later of next month and the latest month with a line; a continuous run.
- `GET /api/stock-lines?month=YYYY-MM` (`orders.view`): `{month, lines:[...], suppliers:[names A-Z]}`; lines by supplier A-Z, then id. `?status=to_order` without month: all months, for the supplier order screen.
- `GET /api/stock-lines/items` (`orders.view`): active stock list `[{id, supplier, code, item}]` for the type-ahead.
- `POST /api/stock-lines` (`orders.edit`): `{month, supplier, item, quantity, notes?, stockItemId?}`, 201, source hand. Month must lie within the current month ... next month.
- `PATCH /api/stock-lines/:id`, access `["orders.edit","orders.mark_ordered","orders.receive"]` with per-field checks in lib: supplier, item, quantity, notes need `orders.edit` (supplier, item, quantity only while to_order, else 409). `status`: ordered>to_order (Undo, `orders.mark_ordered`; clears dates, delivery note and the PO link), ordered>received (`orders.receive`, `receivedDate?`, `deliveryNote?`), received>ordered (`orders.receive`). to_order>ordered is refused here: only a supplier order does it. `expectedDate` while ordered: `orders.mark_ordered`. Date rules as order lines. A new delivery note alerts `orders.mark_ordered` holders like the stock group one.
- `DELETE /api/stock-lines/:id` (`orders.edit`): to_order only, soft.
- `POST /api/orders/mark-ordered`: body may also carry `stockLineIds:[...]`. `orderIds` may then be empty or missing; at least one of the two. Limit 200 in total. Same one-supplier, dates, ref, notes and 409 rules; one transaction, one PO. Response adds `stockLines:[...]`, `stockCount`. `count` stays the number of job items, `jobCount` unchanged.
- `GET /api/orders/suppliers` unchanged. `GET /api/supplier-orders` items add `hasStock:boolean`; `itemCount` includes stock. Detail `items` for stock: `{stockLineId, stock:true, month, jobId:null, jobNumber:null, jobName:"", supplier, description, quantity, now...}` with the same now fields as job items. Snapshots stay version 1; stock items carry `stock:true, stockLineId, month`, `orderId:null`; they come first. Snapshots without stock must give exactly today's output.
- `POST /api/stock/orders/:period/send` (`stock.order`): rule G. 409 if not counted, already sent, or a later period has been sent. `month(...)` views add `sent:{at, period}|null` and, after counted/send, `sentResult:{month, added, updated, removed}`.
- `POST /api/stock/orders/:period/groups`: marking ordered now 409 "Stock is ordered on the Orders page now"; `undo` stays, as do `groups/received` routes. `PUT .../order` and `POST .../nothing` answer 409 the same way.
- `GET /api/stock/summary`: `stockToOrder` becomes `[{month, label, toOrder}]` (months with to_order lines, oldest first), plus `stockToSend:[{period,label}]` (rule G candidates: counted, not sent, with order quantity in a group not ordered).

## Rule A (lib/stocklines.js, called inside counted()'s and send()'s transaction)

Per line of the count, skipping items whose supplier group in this period is already ordered: base = `order_qty` when not null, else suggest(target, have); null base: leave everything alone. onOrder = sum of `ordered` stock_lines with that stock_item_id (any source), plus `order_qty` of the item in other periods' ordered, not-received groups. need = max(0, base − onOrder). The item's existing to_order, source-count line(s), any month: need > 0 sets the first to need, refreshes supplier, code and item, moves it to the current Sydney month, and removes any others; need 0 removes them. No such line and need > 0: insert. Set sent_at, sent_period. reopen() clears sent_at and sent_period and leaves the lines; reopen no longer depends on lines being ordered, but still refuses when old groups are ordered. Audit actions `stock_line.create|update|delete|status` (entityType `stock_line`), and `stock_order.sent`. The stock.counted alert's link becomes `/orders.html?stock=YYYY-MM` and its body gives the number of lines added or changed.

## Deliveries

`stockdeliveries` adds entries of type `stock_line`, one per ordered or recently received line: `id` the line id, `label` "Stock order <Month YYYY>", `supplier`, plus `item`, `code`, `quantity`, dates, note as the other entries, `link` `/orders.html?stock=YYYY-MM`. The page receives and undoes through `PATCH /api/stock-lines/:id`.

## Pages

- `/orders.html?stock=YYYY-MM` opens the Job cards tab at that month. O's section exposes `window.StockOrders.reload()`; the supplier order view is opened for a supplier with stock ticked by `window.SupplierOrder.open({supplier, stockLineIds})`.
- Anyone without `orders.edit` / `orders.mark_ordered` sees no Add, Edit, Delete / Order, Undo.
- Print month: a new `orderprint.html?mode=stock&month=` in the same style. The supplier print list gains the ticked stock ids.
- Phones: no sideways scroll at 375 px.
