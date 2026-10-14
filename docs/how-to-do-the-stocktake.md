# How to do the monthly stock order, the board stocktake and paint orders in Crosscuts

For Todd, Ordering, the Workshop Manager and Accounts. Four jobs live under the **Ordering** menu:

- **Stock order:** the monthly hardware order. The Workshop Manager counts what's on the shelf; Ordering decides what to order.
- **Board stocktake:** the monthly count of sheets. Ordering turns it into a stock value for Accounts.
- **Paint order:** paint, hardener, thinners, primer and sanding discs.
- **Drawer order:** see [how-to-order-drawers.md](how-to-order-drawers.md).

Who does what:
- **The Workshop Manager** (and Ordering and admin) counts: types **Have** on the stock order and quantities on the board stocktake. Counting needs the `stock.count` key.
- **Ordering** (and admin) keeps the lists, types what to order, marks it ordered, sets board prices and confirms the stock value. That needs the `stock.order` key.
- **The Workshop Manager** (and Ordering, Design/PM and admin) marks deliveries received on **Deliveries**.
- **Accounts** sees each month's board stock value on **Stock value**.

The stock order and board stocktake are not order lines on jobs: they have no job and no effect on any invoice. Paint can be (see below).

## Setting up the lists (Ordering, once)

Each page has a **List** tab (the paint page has **Paint list**). Type the lists in by hand; nothing is imported. Orders and counts start empty.

- **Stock items:** supplier, code (optional), item and link (optional). Items with the same supplier are ordered together as one **supplier group**. **Up** and **Down** move an item within its group; **Group up** and **Group down** move a whole group. **Deactivate** takes an item off the count without losing history.
- **Boards:** supplier, thickness, board, finish and the **price per sheet (ex GST)**. The list's order is the order of the count sheet. Prices are seen by Ordering only.
- **Paint items:** name, finish, manufacturer, kind (Colour, Hardener, Thinners, Primer, Abrasive or Other) and unit (kg or each).

A new item or board appears on the month that's still being counted, not on months already finished. Editing a list never changes a past month.

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
3. Press **Finish count**. Ordering is told ("Board count done: <Month>") with "Confirm the stock value".

### 2. Value (Ordering)

The **Value** tab appears once the count is finished. It shows each counted board's price and amount, and the subtotal.

1. **Boards with no price.** Any counted board with a quantity above zero and no price is marked **No price** in orange. Type its price per sheet (ex GST) beside it and press **Set price**. The value can't be confirmed while any such board has no price.
2. **Adjustment.** If the worked-out figure needs a correction (damaged sheets, offcuts), type it in **Adjustment (ex GST)**, as dollars and cents. A negative takes off (`-125.50`). A note is needed whenever the adjustment isn't zero. **The adjustment and its note save as you type them**, before you confirm, so reloading the page keeps them.
3. Press **Confirm value** and check the figure in the dialog. **The value is the sheets counted times each board's price, plus the adjustment.** Confirming freezes each board's price as it is now. Accounts is told ("Board stock value: <Month>").

### Changing a count or a value

- **Reopen count** (Ordering, on the **Value** tab) takes a counted month back to counting, so the Workshop Manager can change a quantity. It works only before the value is confirmed.
- **Reopen** (admin only) takes a confirmed month's value back: the frozen prices and value are cleared, the count stays finished, and Accounts sees "Waiting for the value" until Ordering confirms it again.

## Stock value (Accounts)

Open **Accounts**, then **Stock value**. It lists each month, newest first: the board stock value (ex GST), who counted it and when, who confirmed it and when, and the adjustment (hover for its note; the note is printed too). A month that's been counted but not confirmed shows **Waiting for the value**.

It's read-only, and it never shows board prices. **Print** prints the list. The page starts with the first count done in Crosscuts; there's no history before that.

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
  - "Stock order <Month>: counted, to order" once a count is finished and not all groups are ordered, and
  - "Board count <Month>: value to confirm" once a board count is finished.

  These stay until the work is done.
- **Deliveries:** ordered stock groups, paint orders and drawer stock rows add to the Deliveries line and the **Stock and paint** group.

## On Deliveries

The **Stock and paint** group sits after the five date groups. Each item shows its label ("Stock order October 2026", "Paint order 7", "Drawer stock (EDGE)"), the supplier, the ordered and expected dates (overdue in orange) and any delivery note, with **Received** and, for people who can open the page, **Open**. **Print** prints one checklist: job lines, stock and paint items that are overdue or due in the next 7 days.
