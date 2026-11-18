# How to use job cards and supplier orders in Crosscuts

For Todd, Ordering and Projects. A **job card** is a job's order lines, the same lines as the job's **Orders & materials** tab, now with a **quantity** on each. The **Orders** page shows one card per job that still has something to order or waiting to arrive. The **Supplier order** screen turns the lines still to order for one supplier into one order list, so you can place a single order and mark all of it ordered at once.

Who does what:
- **Seeing** cards and lines, and **printing**, needs `orders.view` (Ordering, and anyone else with Orders on their menu).
- **Adding items and editing lines** needs `orders.edit` (Ordering, Projects, admin).
- **Marking lines ordered** needs `orders.mark_ordered` (Ordering, admin).
- **Receiving** still happens on **Deliveries**, as before (see `how-to-receive-deliveries.md`).

## Starting a card

1. On **Ordering**, then **Orders**, press **New job card**.
2. Pick the job. Add a row for each item: **Supplier**, **Hardware** (what it is) and **Qty**. Press **Add items rows** for more rows; the red **x** at the end of a row removes it.
3. Press save. Every row becomes an order line on the job, **To order**, and the card appears on the Orders page.

Every row needs a supplier, the hardware and a quantity. If a row is wrong, nothing is saved and the message names the row ("Row 3: ..."). A job that is archived can't take new items.

## Adding items to a card

Open the card and add more items the same way. They are ordinary order lines, so they show on the job's **Orders & materials** tab too. A line's quantity can be changed or cleared when you edit the line (it needs `orders.edit`). Lines made before 0.2.22 have no quantity; the quantity column is simply blank for them.

## Opening and printing a card

Open a card to see its lines: supplier, hardware, quantity, status (To order, Ordered, Received) and the ordered, expected and received dates. **Print card** opens a one-page A4 sheet in a new tab (black on white, with the letterhead) and the print dialog; cancelled lines are left out. Printing changes nothing.

## Ordering from a supplier

1. On **Orders**, press **New supplier order** and pick the **supplier**. Its lines still to order are listed, grouped by job, with how many there are.
2. **Untick** anything that is not part of this order. Unticked lines stay To order.
3. Set the **order date** (today unless you placed the order earlier; not in the future). Optionally add an **expected date** and the supplier's **ref** (their order or quote number). The expected date is put on every line. The PO number (see Supplier orders below) is added to each line's notes, with the ref after it when you gave one, e.g. `PO-0007 · Ref: BH-55120`.
4. **Print list** prints the ticked items for the supplier, grouped by job, with the order date and ref. **Printing does not mark anything ordered.**
5. After placing the order, press **Mark N ordered** (N is how many are ticked). Each line becomes **Ordered** with that order date, and the order is saved as a purchase order (see Supplier orders below).

If someone else changed one of the lines in the meantime (marked it ordered, cancelled it, reserved it from stock), the whole order is refused with a sentence naming the line, nothing is changed, and the list reloads. Check it and try again.

Lines reserved from stock, drawer lines and paint lines are not on the supplier list: drawers and paint are ordered from their own pages.

## Supplier orders

Pressing **Mark N ordered** on a supplier order now saves the order as a **purchase order** with its own number: PO-0001, PO-0002 and so on. Numbers are never reused. Back on the Orders page a message says, for example, "PO-0007 saved. 5 items marked ordered for 3 jobs from Blum Hardware", with **View PDF** and **Download PDF** buttons. If the PDF could not be made at that moment, the order is still saved and the message says the PDF will be made when you open it.

The PO number is added to the notes of every item in the order: `PO-0007`, or `PO-0007 · Ref: BH-55120` when you entered the supplier's ref. (This replaces the old `Ref: ...` line.)

**Finding an order.** On Orders, the **Supplier orders** tab (between Job cards and All order lines) lists every saved order, newest first: PO number, supplier, order date, expected date, supplier ref, how many items, the job numbers and who placed it. **Find** searches the PO number, the supplier ref and the job number or name. The **Supplier** filter narrows it to one supplier.

**Opening an order** shows its items grouped by job, each with where it is now: **Ordered**, **Received** (with the date), or **Undone since** (with the date and who) if the item has been put back to To order or cancelled since. That is information only; it never changes the order.

**View PDF, Print and Download PDF** are on the open order. View PDF opens the PDF in a new tab. Print opens the same page ready to print, with only the items in that order. Download PDF saves it as a file named like `PO-0007 Blum Hardware.pdf`. All three need `orders.view`.

**The PDF never changes after it is made.** It shows the order as it was when you pressed Mark ordered: the items, quantities, dates, ref, who placed it and the company details at that moment. Editing, receiving or undoing an item later does not alter it. If an item is undone and ordered again, it appears on a new PO and the old PO stays as it was.

**On job cards,** each ordered item shows its PO number as a link that opens that order. If an item has been on more than one order, the link goes to the latest order that has it.

**Items with no PO.** Items marked ordered one at a time (from the job's Orders & materials tab or a card line), and anything ordered before this change, have no PO number, so there is no link and no PDF for them. A saved order cannot be edited or deleted.

## When the last line is marked ordered

Marking is the same as marking one line on its own. When the **last** line of a job is marked ordered, the job's materials count as ordered and its 50% progress invoice falls due, so Accounts are told, with the order date you set. If a supplier order covers the last lines of several jobs, each of those jobs follows. Only mark lines you have really ordered.

## Undo

**Undo** works on one line at a time, as before: open the line (on the card or the job's Orders & materials tab) and press **Undo** to put it back to To order. Undoing one line of a supplier order leaves the others Ordered.

## Receiving

Receiving does not happen on cards. When the delivery arrives the Workshop Manager marks each line **Received** on **Deliveries**.
