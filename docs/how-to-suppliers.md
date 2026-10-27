# How to do supplier accounts in Crosscuts

For Todd and the accounts team. **Supplier accounts** is the monthly checklist of supplier statements (the old paper "Suppliers" form): for each supplier, whether this month's statement is in, its total, whether it's reconciled, paid and entered in MYOB, and the statement itself.

Anyone with Accounts access can see it. Changing lines, attaching statements and managing suppliers need the Accounts edit access (the same as invoicing).

Open **Accounts**, then **Supplier accounts**. It opens on **last month**, because a month's statements arrive after it ends. **Previous month** and **Next month** move between months, from June 2023 to this month.

## Setting up the suppliers (once)

Under **Suppliers**, below the list:
- **Add supplier** adds a name. It's listed from the month on screen onwards, so add suppliers while looking at the first month you want them in.
- **Rename** changes the name everywhere, past months included.
- **Archive** stops a supplier being listed from this month on. Archived suppliers stay on the months they already have lines in. Tick **Show archived** to see them and **Restore** one: it's listed again from this month on, and the months it was archived stay as they were. (The months before it was archived keep their lines; any that were never filled in show as Waiting, saved by whoever restored it.)

Suppliers are never deleted, so their history stays.

## Each month

Each supplier has one line. Changes save by themselves, line by line, as you go (a choice saves at once, typing saves when you leave the box); the line says when it's saved.

1. **Statement:** choose **Have statement**, **Waiting** or **N/A**. Every line starts as Waiting.
2. **Total:** type the statement's total in dollars (`1234.50` or `1,234.50`; a credit can be negative).
3. **Reconciled**, **Paid** and **Entered in MYOB:** tick each as it's done.
4. **Note:** anything worth remembering.
5. **Statement file:** **Attach** the statement (a PDF, or a JPEG or PNG photo). The file's name then links to it; **Replace** swaps it and **Remove** takes it off. One file per supplier per month.

The footer counts the month: how many have a statement, are waiting or are N/A, the sum of the totals, and how many are reconciled, paid and entered in MYOB.

- A box outlined in orange wasn't saved; the reason shows beside the line. Fix it and it saves.
- If someone else changed the same line meanwhile, the line says so: press **Reload** to see what they saved, then make your change again.

## Prints

- **Print** prints the month's list (state, total, ticks and notes) with its counts and the sum.
- **Print blank form** prints the paper form to fill in by hand: the suppliers listed this month, then five blank rows.

Choose Save as PDF in the print dialog to keep a copy.

## The Friday round-up

If any statements for last month are still **Waiting**, the Friday round-up says so ("3 supplier statements still waiting for September"). When that's the only thing in it, its link opens this page on that month. Set the line to Have statement or N/A and it drops out of the next round-up.

## Admin accounts (BAS, Workcover, insurance)

Some bills aren't from suppliers: the BAS, Workcover, business insurance. They have their own page so they don't sit in the supplier list. Open **Accounts**, then **Admin accounts** (it comes right after **Supplier accounts**).

It works exactly like Supplier accounts: the same monthly lines (statement, total, reconciled, paid, entered in MYOB, note, statement file), the same **Previous month** and **Next month**, the same access (Accounts to see, Accounts edit access to change), and the same **Print** and **Print blank form**. The only differences:

- You add the accounts under **Accounts**, below the list, with **Add account** (for example **BAS**, **Workcover**, **Business insurance**). **Rename** and **Archive** work as they do for suppliers, and archived accounts keep the months they already have lines in.
- An admin account and a supplier can't share a name.
- These accounts are never offered as suppliers on Orders, Stock or Paint, and the Friday round-up's "statements still waiting" line counts suppliers only.

## Individual invoices and Paid (0.2.7)

One-off bills (not supplier accounts) are listed under the supplier accounts in each month as **Individual invoices**, and only admins tick **Paid** on Supplier accounts. See [how-to-to-pay.md](how-to-to-pay.md).
