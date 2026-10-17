# How to do the monthly stock order, the board stocktake and paint orders in Crosscuts

For Todd, Ordering and the Workshop Manager. Four jobs live under the **Ordering** menu:

- **Stock order:** the monthly hardware order. The Workshop Manager counts what's on the shelf; Ordering decides what to order.
- **Board stocktake:** the monthly count of sheets. It is finished once it is counted.
- **Paint order:** paint, hardener, thinners, primer and sanding discs.
- **Drawer order:** see [how-to-order-drawers.md](how-to-order-drawers.md).

Who does what:
- **The Workshop Manager** (and Ordering and admin) counts: types **Have** on the stock order and quantities on the board stocktake. Counting needs the `stock.count` key.
- **Ordering** (and admin) keeps the lists, types what to order, marks it ordered, sets board prices and can reopen a finished board count. That needs the `stock.order` key.
- **The Workshop Manager** (and Ordering, Design/PM and admin) marks deliveries received on **Deliveries**.

The stock order and board stocktake are not order lines on jobs: they have no job and no effect on any invoice. Paint can be (see below).

## Setting up the lists (Ordering, once)

Each page has a **List** tab (the paint page has **Paint list**). Type the lists in by hand; nothing is imported. Orders and counts start empty.

- **Stock items:** supplier, code (optional), item and link (optional). Items with the same supplier are ordered together as one **supplier group**. **Up** and **Down** move an item within its group; **Group up** and **Group down** move a whole group. **Deactivate** takes an item off the count without losing history.
- **Boards:** supplier, thickness, board, finish and the **price per sheet (ex GST)**. The list's order is the order of the count sheet. Prices are seen by Ordering only.
- **Paint items:** name, finish, manufacturer, kind (Colour, Hardener, Thinners, Primer, Abrasive or Other) and unit (kg or each).

A new item or board appears on the month that's still being counted, not on months already finished. Editing a list doesn't change a month that's already counted.

## The monthly stock order

Open **Ordering**, then **Stock order**. The page opens on the current month; **Previous month**, **Next month** and the month box change it. The month's state shows in words at the top.

### 1. Count (Workshop Manager)

1. On the **Count** tab, type the **Have** for each item (a whole number). Each saves when you leave the box.
2. To count on paper first, press **Print blank count sheet**: every active item with an empty Have box and a "Counted by" line.
3. When every item is done, press **Finish count**. Ordering is told ("Stock counted: <Month>").

Once the count is finished, Have can't be changed. Ordering can reopen it (below).

### 2. Order (Ordering)

1. On the **Order** tab, type the **Order** quantity for each item. You can start before the count is finished.
2. For each supplier group, press **Mark ordered**. Set the date it was ordered and, if you know it, the expected date. A group can be marked once the count is finished and at least one of its items has an Order above zero.
3. **Print order** prints one supplier group: only its items with an Order above zero (code, item, quantity). **Print all orders** prints one page per supplier group.

- A finished count stays "counted, to order" on the dashboard until Ordering acts. Once you mark a supplier group ordered, any group with nothing to order (every Order empty or zero) needs no action, so the month is finished (ordered) once **every group that has something to order** is marked ordered.
- If the month needs nothing at all (no Order quantity anywhere), press **Nothing to order this month** on the Order tab. The month is closed, the page shows "Nothing to order: <name>, <date>", and the dashboard line goes. **Undo** brings it back to counted. The button only shows while no quantity is typed and no group is ordered; while the month is marked, Order quantities can't be typed and the count can't be reopened until you undo it.
- A group that's marked ordered is locked: **Undo** it first to change its quantities ("<supplier> has already been ordered").
- **Reopen count** takes the count back to counting, so the Workshop Manager can change a Have and finish it again. It works only while no supplier is marked ordered.

### 3. Received (Workshop Manager)

Receiving isn't done on the stock page. Each ordered supplier group is an item in the **Stock and paint** group on **Deliveries**. Press **Received**, set the date, add a delivery note if something is worth recording, and save. The dates then show on the stock order page, read-only. **Undo** is under **Received recently** (the last 14 days).

When every ordered group has arrived, the month is **received**.

## The board stocktake

Open **Ordering**, then **Board stocktake**. It works by month, like the stock order.

### 1. Count (Workshop Manager)

1. On the **Count** tab, type the **Qty** for each board, in whole or half sheets (0.5). Each saves when you leave the box. No prices are shown to the counter.
2. To count on paper first, press **Print blank count sheet** (two columns per A4 page, in the list's order).
3. Press **Finish count**. The month shows **Counted** and the count is done. There is nothing more to confirm.

The board stocktake no longer works out or confirms a stock value (removed 2026-10-17, after the Stock value page went on 2026-10-16). Values saved on earlier months stay in the database but are not shown anywhere.

### Changing a count

**Reopen count** (Ordering, on the **Count** tab) takes a counted month back to counting, so the Workshop Manager can change a quantity and finish the count again. Anyone who can't reopen it asks Ordering.

## Paint orders

Open **Ordering**, then **Paint order**. The tabs are **Orders**, **Paint list** and **Settings**. Only Ordering and admin see the page in the menu; a receiver opens a paint order from **Deliveries**.

### Making an order

1. On **Orders**, press **New paint order**.
2. Fill in the **supplier**, an expected date if you know it, and notes.
3. Press **Add line** for each item. Choose it from the paint list (or **Other…** and type it), then the quantity. A kg line shows its **litres**: the kg times the litres-per-kg factor (0.85 to start; **Settings** changes it, and the litres on every order, old ones too).
4. A line can have a **job** (optional). Leave it empty for workshop stock.
5. **Save draft**. A draft can be changed freely. **Cancel order** cancels a draft.

### Lines with a job

A paint line with a job becomes an order line on that job, so it counts toward the job's materials and its 50% progress invoice.

- One order line is made per job, however many paint lines that job has. It's labelled PAINT ORDER <number> on the job's Orders and on the Orders page, with an **Open paint order** link. It is changed only from the paint order, never from the Orders page.
- Take a job out of the lines and its order line is cancelled.
- Lines with no job are workshop stock. One paint order can mix both.

### Ordering and receiving

1. **Print** gives the order on the company letterhead: the order number, the date, the supplier, and a table of Kg, Litres, Name, Finish, Manufacturer and Job. Send it to the supplier.
2. **Mark ordered** sets the ordered date and the expected date. A dialog lists the jobs whose lines will be marked ordered; **when a paint line is the last line a job still had to order, its progress invoice falls due**. Marking an order with job lines needs the Mark ordered permission as well as the Ordering page. **Undo ordered** puts the order back to a draft and its job lines back to To order. A progress invoice that already fell due stays due.
3. **Received** is done by the Workshop Manager on **Deliveries** (the **Stock and paint** group) or on the order's own page. It receives the order's job lines too, so a job's materials-in mark follows. **Undo received** is available to the same people.

Once ordered, an order can't be edited. Undo ordered first.

## Reminders on the dashboard

- **The Workshop Manager and Ordering (counting):** from the **25th of a month to the 7th of the next**, the dashboard shows "Stock count: <Month> not done" and "Board count: <Month> not done" for the month just ending, until each count is finished. The link opens that month.
- **Ordering (placing and confirming):** the dashboard also shows
  - "Drawers: N to order · N waiting for check" when there are any,
  - "Stock order <Month>: counted, to order" once a count is finished and until Ordering acts: a supplier group is marked ordered (then it shows "ordering" until every group with something to order is), or the month is marked **Nothing to order this month**.

  These stay until the work is done. A finished board count leaves no line: it is done once it is counted.
- **Deliveries:** ordered stock groups, paint orders and drawer stock rows add to the Deliveries line and the **Stock and paint** group.

## On Deliveries

The **Stock and paint** group sits after the five date groups. Each item shows its label ("Stock order October 2026", "Paint order 7", "Drawer stock (EDGE)"), the supplier, the ordered and expected dates (overdue in orange) and any delivery note, with **Received** and, for people who can open the page, **Open**. **Print** prints one checklist: job lines, stock and paint items that are overdue or due in the next 7 days.
