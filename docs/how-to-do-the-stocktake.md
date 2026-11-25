# How to do the stock order, the board stocktake and paint orders in Crosscuts

For Todd, Ordering and the Workshop Manager. Four jobs live under the **Ordering** menu:

- **Stock order:** the hardware count, done **every fortnight** since 0.2.6. The Workshop Manager counts what's on the shelf against a **target** for each item. Since 0.2.27 finishing the count puts what is below target on the **monthly stock order** on the **Orders** page, where Ordering orders it (see "The monthly stock order" below).
- **Board stocktake:** the monthly count of sheets and edge tape rolls (it stays monthly). It is finished once it is counted, and it resets each item's **on hand**.
- **Paint order:** paint, hardener, thinners, primer and sanding discs.
- **Drawer order:** see [how-to-order-drawers.md](how-to-order-drawers.md).

Who does what:
- **The Workshop Manager** (and Ordering and admin) counts: types **Have** on the stock order and quantities on the board stocktake. Counting needs the `stock.count` key.
- **The Workshop Manager** keeps the stock list and its targets, and the board and edge tape list (not the prices) and its on hand amounts (0.2.6).
- **Ordering** (and admin) keeps the lists too, sets board prices and can reopen a finished board count. That needs the `stock.order` key. Ordering stock from suppliers is done on the Orders page (`orders.edit` to add or change items, `orders.mark_ordered` to order and undo).
- **The Workshop Manager** (and Ordering, Projects and admin) marks deliveries received on **Deliveries**.

The stock order and board stocktake are not order lines on jobs: they have no job and no effect on any invoice. Paint can be (see below).

## Setting up the lists (the Workshop Manager or Ordering, once)

Each page has a **List** tab (the paint page has **Paint list**). Type the lists in by hand; nothing is imported. Orders and counts start empty.

- **Stock items:** supplier, code (optional), item, **target** (optional: the total you want on the shelf) and link (optional). Items with the same supplier are ordered together as one **supplier group**. **Up** and **Down** move an item within its group; **Group up** and **Group down** move a whole group. **Deactivate** takes an item off the count without losing history.
- **Boards and edge tape:** the kind (**Board**, or **Edge tape** counted in whole rolls), supplier, thickness, name, finish, width and colour (edge tape), **on hand**, and the **price per sheet (ex GST)**. The list's order is the order of the count sheet. Prices are seen and set by Ordering only. The list also shows each item's **reserved** amount (held for jobs, see [how-to-maintenance.md](how-to-maintenance.md#reserving-boards-and-edge-tape)) and **free** (on hand less reserved).
- **Paint items:** name, finish, manufacturer, kind (Colour, Hardener, Thinners, Primer, Abrasive or Other) and unit (kg or each).

A new item or board appears on the month that's still being counted, not on months already finished. Editing a list doesn't change a month that's already counted.

## The stock order page (counting)

Open **Ordering**, then **Stock order**. The page opens on the current **fortnight** (for example "26 Oct – 8 Nov 2026"); **Previous**, **Next** and the box change it. The fortnight's state shows in words at the top. The page has two tabs, **Count** and **List**. (The **Order** tab is gone: ordering is on the Orders page now.)

- Fortnights are counted from **Monday 26 October 2026** (Todd, 2026-10-27). The count is **due from the Thursday** of each fortnight (the first was due from Thursday 29 October) and shows on the dashboard until it is finished; a fortnight left uncounted shows as overdue in the next.
- Months counted before 0.2.6 still open from the box, as months. Ordering can change the cycle (monthly or fortnightly) and the Monday it starts from with `PUT /api/stock/settings`; there is no screen for it.

### Count (Workshop Manager)

1. On the **Count** tab, type the **Have** for each item (a whole number). Each saves when you leave the box. The **Target** shows beside it.
2. To count on paper first, press **Print blank count sheet**: every active item with an empty Have box and a "Counted by" line.
3. When every item is done, press **Finish count**. The page then says how many items went on which month's stock order, for example "7 items are on the November 2026 stock order (5 added, 2 changed, 0 removed)", with a link that opens that month on the Orders page. Ordering is told "Stock counted" with the same link.

Once the count is finished, Have can't be changed. Ordering can press **Reopen count** to take it back to counting; the Workshop Manager then changes a Have and finishes again. Reopening leaves the order as it is, and finishing again works the order out afresh (rule A below). Reopen works only while no old supplier group is marked ordered.

### The month the count goes to

The order for the **month (Sydney time) in which Finish count is pressed**. A count finished just after midnight on 1 November goes to November.

### How the order is worked out (rule A)

Most months have two counts, and something ordered after the first may not have arrived by the second. So the order is not simply target less have. For each item with a target:

**order = target - have - what is already ordered and not yet received** (never below nothing).

"Already ordered and not yet received" includes anything ordered on the Orders page, and any supplier group ordered on the old Order tab and not yet received, so nothing is doubled in the changeover.

- If the item already has a line from an earlier count still **To order**, in any month, that line is set to the new figure and moved to the current month. It is not added twice. If the figure is zero the line is removed (hidden, kept in the audit log).
- Otherwise a new **To order** line is made when the figure is above zero.
- Lines added by hand are never changed by a count. They reduce the need only if they were picked from the stock list and are already ordered.
- Items with **no target** are counted but put nothing on the order. Ordering adds them by hand.
- If a supplier group in this fortnight was already ordered on the old Order tab, its items are skipped.

**Example.** Target 20, have 5: 15 goes on the order, and it is ordered. At the next count there are 3 on the shelf and the 15 hasn't come: the order is 20 - 3 - 15 = 2. Once the 15 has arrived and the shelf holds 20, nothing is ordered.

Ordering can change a counted quantity on the Orders page until the line is ordered. The next count replaces it.

### Send to monthly order (fortnights counted before 0.2.27)

A fortnight that was counted but not ordered when 0.2.27 went in is not converted automatically. Its page shows **Send to monthly order** (Ordering only), and the dashboard shows "Stock count <fortnight>: counted, not sent to the monthly order". Pressing it applies rule A once for that fortnight and says what it did. It refuses if the fortnight was already sent or a newer count has been sent. Groups already ordered on the old Order tab finish on Deliveries as before.

### The Ordered view (old fortnights)

A **past** fortnight that has supplier groups ordered on the old Order tab shows a read-only **Ordered** tab: each group, its dates, its delivery note and its items. **Undo** is still there for a group not yet received (Ordering), where the server allows it. Nothing else can be changed there.

## The monthly stock order (Ordering)

On the **Orders** page, **Job cards** tab, the **Stock** section sits above the job cards: one stock order per calendar month, with no job. See [how-to-job-cards.md](how-to-job-cards.md#the-stock-section) for adding, editing and ordering items there, and for ordering stock together with job items on a supplier order.

### Received (Workshop Manager)

Receiving is **per item**. Each ordered stock item is its own row in the **Stock and paint** group on **Deliveries**, labelled "Stock order November 2026" with the item, its code and the quantity. Press **Received**, set the date, add a delivery note if something is worth recording, and save. **Undo** is under **Received recently** (the last 14 days). Stock groups ordered on the old Order tab still show as one row per supplier.

## The board stocktake

Open **Ordering**, then **Board stocktake**. It works by month (it stays monthly).

### 1. Count (Workshop Manager)

1. On the **Count** tab, type the **Qty** for each board, in whole or half sheets (0.5), and for each edge tape in whole rolls. Each saves when you leave the box. No prices are shown to the counter.
2. To count on paper first, press **Print blank count sheet** (two columns per A4 page, in the list's order).
3. Press **Finish count**. The month shows **Counted** and the count is done. There is nothing more to confirm. Each counted item's **on hand** becomes what was counted.

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
  - "Stock order <Month>: N to order" for each month that has stock items still to order, linking to that month on the Orders page. It goes when every item is ordered or deleted. There is no "nothing to order" line any more: an empty month needs no action.
  - "Stock count <fortnight>: counted, not sent to the monthly order", only for a fortnight counted before 0.2.27 (see Send to monthly order).

  These stay until the work is done. A finished board count leaves no line: it is done once it is counted.
- **Alerts:** "Stock counted" tells Ordering how many stock lines the count added or changed and links to the month's order on the Orders page.
- **Deliveries:** ordered stock items, old stock groups, paint orders and drawer stock rows add to the Deliveries line and the **Stock and paint** group.

## On Deliveries

The **Stock and paint** group sits after the five date groups. Each item shows its label ("Stock order November 2026" with the item, code and quantity underneath, "Paint order 7", "Drawer stock (EDGE)"), the supplier, the ordered and expected dates (overdue in orange) and any delivery note, with **Received** and, for people who can open the page, **Open** (a stock item opens its month on the Orders page). **Print** prints one checklist: job lines, stock and paint items that are overdue or due in the next 7 days.
