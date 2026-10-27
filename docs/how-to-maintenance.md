# How to run maintenance, reserve stock and record cuts in Crosscuts

For the Workshop Manager, Ordering and Todd. New in 0.2.6. The stock order and board stocktake are in [how-to-do-the-stocktake.md](how-to-do-the-stocktake.md).

Who does what:
- **The Workshop Manager** keeps the maintenance schedule and confirms each item actioned (the `maintenance.manage` key: the Workshop Manager, admin and the owner). They also label stock reserved for jobs and record which jobs are cut 100% (the `stock.count` key).
- **Ordering** reserves boards and edge tape from stock for a job (the `orders.mark_ordered` key).
- **Admin** is told about maintenance that is a week or more overdue.

## Maintenance

Open **Workshop**, then **Maintenance**.

### Adding an item

1. Press **Add maintenance item**.
2. Type the item (for example "Oil the panel saw") and, if useful, what to do.
3. Choose how often it repeats: every week, fortnight, month or year, or **Custom** (every so many days, weeks, months or years).
4. Set the **first due date**, an end date if it stops, and how many days before it is due it should show (0 shows it on the day).
5. Press **Save**.

Each time an item is due, it becomes a Workshop task, the Workshop Manager gets a bell, and it shows on the **Workshop** layer of the Planner on its due date. Nothing is made for dates before the item was added.

**Edit** changes an item; **Pause** stops it (Resume starts it again from today); **Delete** stops it for good. What has been recorded stays.

Maintenance items are not on **Admin > Tasks**; that page keeps the other recurring tasks.

### Confirming it actioned

When the job is done, find the item, press **Confirm actioned** beside its due date, add a note if there is something to say (for example "Blade changed too"), and press **Confirm actioned**. The page then shows who did it, when, and the note under **Last done**.

Only the Workshop Manager (or admin) can confirm. The Tasks page's Done button on a maintenance task is refused for anyone else.

Anything not done shows in red as overdue. Once an item is **7 or more days overdue**, every admin gets a bell, and again each week until it is confirmed.

## Reserving boards and edge tape

The Workshop Manager keeps the list of boards and **edge tape rolls** on the board stocktake's **List** tab (see [how-to-do-the-stocktake.md](how-to-do-the-stocktake.md)). Each item shows:
- **On hand:** what is on the shelf. The monthly board count sets it to what was counted; it can also be typed on the list.
- **Reserved:** what is held for jobs and not yet cut.
- **Free:** on hand less reserved.

### Reserve instead of ordering (Ordering)

When a job's order list has reached Ordering, open the job and find **Stock reservations**. It lists the job's boards and edging lines.

1. On a line still to order, press **Reserve from stock**.
2. Choose the stock item (boards for a boards line, edge tape for an edging line), the quantity (no more than is free; edge tape in whole rolls), and tick **Nothing left to order on this line** if the stock covers it all.
3. Press **Reserve**.

If you didn't tick it, the rest of the line is ordered as usual. If you did, the line counts as ordered: when everything else on the job is ordered too, the job is all ordered, as if you had marked the line ordered.

The Workshop Manager gets a bell ("Reserve from stock: <job>").

### Label it (Workshop Manager)

Open **Workshop**, then **To reserve**. Under **To label as reserved**, label the stock for the job, then press **Reserved**. A line wholly covered from stock then counts as in for the job.

**Release** (the Workshop Manager or Ordering) puts a reservation back into free stock, any time before the job is cut. It is recorded in the audit log.

### End of every shift: jobs cut 100% (Workshop Manager)

On **To reserve** (under **End of shift: jobs cut 100%**) or on the **End of shift** page, tick each job that has been cut 100% and press **Record cut 100%**. Every reservation for those jobs that has been ticked Reserved comes off on hand. A reservation not yet labelled stays reserved.

The job page then shows "Cut 100% on <date>, recorded by <name>". It is recorded in the audit log and can only be recorded once per job.

## Waiting on you

The Workshop Manager's **Waiting on you** tile on the dashboard lists, when there is something there:
- the stock count due (or overdue);
- maintenance due today, and maintenance overdue;
- reservations to label as reserved;
- jobs with labelled stock to mark cut 100% at the end of the shift;
- deliveries to receive (due today or overdue).

Vehicle bookings join it with the vehicles register (M28).
