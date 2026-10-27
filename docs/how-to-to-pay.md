# How to keep the bills to pay

For Accounts and the admins. Added in 0.2.7 (`docs/plans/m28-contracts.md` section 2). There is no separate To pay page: everything to pay is on **Accounts > Supplier accounts**, in the same three months side by side.

## Accounts prepares

- **Supplier accounts** are listed first in each month, as before (statement, total, reconciled, MYOB).
- **Individual invoices** are listed below them: one-off bills from someone who isn't a supplier account. Click **Add** under the month, give the payee, what it is for, the amount (leave it empty if it isn't known yet: it shows as Missing), the due date and the month. Click the payee to change it, attach the invoice file, tick Entered in MYOB, or remove it.
- If a payee turns out to be regular, open it and click **Make a supplier account**: they are added to the supplier accounts from that month; the invoice stays where it is.
- **Left to pay** for each month includes the individual invoices, and so does the count of missing figures. **Print** prints the month with both lists.

## Admin pays

Only admins tick **Paid**, on a supplier line or an individual invoice. Everyone else sees the box but can't change it. The Dashboard shows admins "To pay this month: N, $X" in **Waiting on you**, with any lines that have no figure yet counted separately, for example "(2 without a figure)".

Admin accounts (BAS, Workcover, insurance payments) is unchanged.
