# How to place orders and receive deliveries in Crosscuts

For Todd, Ordering, the Workshop Manager and Projects. Each job's materials are a list of **order lines** (one per supplier order). A line goes **To order → Ordered → Received**, or is cancelled.

Who does what:
- **Ordering** (and Projects) adds lines and edits them. **Ordering** (and admin) marks them ordered.
- **The Workshop Manager** (and Ordering, Projects and admin) receives them and writes delivery notes.
- Everyone with Accounts, Projects or Scheduling can see the lines on the **Orders** page.

## Placing orders (Ordering)

1. Open the job (**Projects**, then **Jobs**), go to its **Orders** section and add a line for each order: supplier, what it is, the expected date if you know it, notes.
2. When you've placed an order, press **Mark ordered** on its line. **Undo** puts it back to To order.
3. **When the last line of a job is marked ordered, the job's materials count as ordered and its 50% progress invoice falls due**, so Accounts are told. Mark the last line only once everything for the job has really been ordered.
4. **Edit** changes a line's supplier, description, expected date or notes, or the date it was ordered. Keep the expected date up to date: it's what puts the line on the Deliveries page in the right place.

The **Orders** page (**Ordering**, then **Orders**) lists every open line across all jobs, with filters by status and supplier.

## Receiving deliveries (Workshop Manager)

Open **Ordering**, then **Deliveries** (the dashboard's **Deliveries** line goes there too). Every ordered line is listed by when it's expected: **Overdue**, **Today**, **Next 7 days**, **Later** and **No date yet**.

- **When everything on a line has arrived,** press **Received**. The date is today; change it if it came earlier (not before it was ordered). Add a delivery note if something is worth recording, then **Mark received**.
- **If part of it is short or damaged,** don't mark it received: press **Delivery note**, write what's wrong ("2 of 3 boxes", "side panel damaged"), and save. The line stays ordered. Ordering is told straight away.
- **When the rest arrives,** press **Received** then.
- **Marked one received by mistake?** It's under **Received recently** (the last 14 days): press **Undo**. Its delivery note stays.
- **Print** prints Overdue, Today and Next 7 days as a checklist to take round the workshop.

### Stock and paint

Below the job groups, **Stock and paint** lists what's on order for the workshop rather than for one job: each supplier group of the monthly stock order, each paint order, and drawer stock. Receive each with **Received** as above; its dialog takes a delivery note. There's no separate Delivery note button on these rows, so if something is short, receive it when it's all in. Recent receipts join **Received recently** with **Undo**.

- **A paint order is received as a whole.** Receiving it receives its job lines too, so those jobs' materials follow. Paint lines don't appear in the job groups.
- **A job's drawer line** stays in the job groups, labelled DRAWERS. It's ordered from the Drawer order page, not with **Mark ordered**, but you receive it here like any other line.
- **Print** includes stock and paint due in the same 7 days (overdue ones too), in its own section.

See `how-to-do-the-stocktake.md` and `how-to-order-drawers.md` for the ordering side.

When every line of a job has been received, the job's materials are in: the board's materials mark turns to "in", the Planner shows it, and Scheduling and Ordering are told.

## Notes

- A delivery note tells everyone who can mark lines ordered (Ordering and admin), each time it changes. That goes for a job line and for a stock supplier group, a paint order or a drawer stock row alike.
- The Workshop Manager sees job names but not the job pages (no client details).
- A line can't be marked received before it's marked ordered, and dates can't be in the future.
