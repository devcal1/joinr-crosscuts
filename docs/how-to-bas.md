# How to use BAS sales in Crosscuts

For Todd and the accounts team. **BAS sales** works out each month's sales for the BAS from the invoices paid in Crosscuts, so nothing is typed in for months after cutover. The figures are keyed into MYOB or the BAS by hand.

Anyone with Accounts access can see BAS sales. Hand amounts and lodging need the Accounts edit access (the same as invoicing). Only an admin can reopen a lodged month.

Open **Accounts**, then **BAS sales**.

## How the figures are worked out

- **Cash basis:** a month's sales are the invoices **paid** in that month (by their paid date), whenever they were issued. An issued invoice that isn't paid yet doesn't count.
- **Sales inc GST (G1)** is the total of those invoices, including GST. **GST (1A)** is the total of their GST. **Ex GST** is the difference.
- A month can also have one **hand amount** (below), which is added to its sales.
- **Not in MYOB** counts the month's paid invoices not yet ticked as Entered in MYOB on the Accounts page. It's a to-do count, so it stays up to date even on a lodged month.
- Mark paid refuses a paid date before the invoice was issued or in the future, so a payment always lands in a real month.

## The year table

The page opens on the current financial year (July to June, named by the year it ends: FY 2027 is Jul 2026 to Jun 2027). **Previous year** and **Next year** move between years, back to FY 2023.

Each month shows its figures, how many invoices, how many aren't in MYOB, and a status:
- **Lodged** with the date, once it's lodged; **Changed since lodged** (orange) if something moved after that;
- **Imported** for a month with only a hand amount (history from before Crosscuts);
- **Includes a hand amount** for a month with invoices and a hand amount;
- **Not ended** for the current month.

A dash in GST or Ex GST means a hand amount was typed without its GST (imported history has no GST split). The quarter rows and the year total add the months up, and show a dash too if any month in them has one.

**Print** prints the year table with its quarter and year totals (choose Save as PDF to keep a copy).

## A month's detail

Press a month to open it below the table. It shows the month's figures and the invoices paid in it (each links to the invoice). **Download CSV** gives the invoice list as a spreadsheet for MYOB or the accountant. **Previous month** and **Next month** step through months.

### Hand amounts

A month can take one hand amount: an amount including GST, its GST if known (leave it blank if not), and a note. Use it for:
- **history:** months before Crosscuts, one figure a month from the old workbook (including GST), from June 2023;
- **payments not on a Crosscuts invoice:** in the cutover month, payments received before the switch-over; after it, payments on invoices issued in MYOB before cutover (see [cutover.md](cutover.md));
- **a refund:** a negative amount, with a note.

Type it and press **Save**; **Clear** removes it. GST can't be more than a tenth of the amount before GST.

### Lodging

When the BAS for a month is done, open the month and press **Lodge**. Crosscuts asks you to confirm, naming the month and its Sales inc GST. A month can be lodged only once it has ended. For a quarterly BAS, lodge each of its three months; the quarter row shows how many are lodged.

Lodging freezes the month's figures and its invoice list (Not in MYOB stays live). Invoices can still be changed on the Accounts page (Mark paid, Mark unpaid), but a lodged month never changes silently:
- the year table keeps showing the lodged figures, with **Changed since lodged** in orange;
- the month shows the lodged figures beside what they are **now**, and says what changed (for example "CC-0012 is no longer paid in this month", or its paid date moved);
- **Show current list** switches between the lodged invoice list and today's. The CSV is always today's list.

The hand amount of a lodged month can't be changed. To correct a lodged month, an admin opens it and presses **Reopen**; it then shows live figures again and can be lodged again.
