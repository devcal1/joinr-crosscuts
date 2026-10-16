# How to keep loan balances in Crosscuts

For Todd, and anyone he gives the Loans page to. The **Loans** page replaces the Loan Balances tab of the jobs master workbook: each loan's repayments, its interest rate over time, and a balance that is always worked out, never typed.

Who can open it:
- **The owner** (Todd). Loans needs the owner-only key `loans.manage`, so other admins don't see it in the menu, can't open it, and don't see its rows in the audit log.
- **An Accounts login the owner grants it to** (below). Only the owner can grant it.

Open **Accounts**, then **Loans**.

Nothing about loans sends a notice or makes a task.

## Giving an Accounts login the Loans page

Only the owner can do this.

1. Open **Admin**, then **Users**, and open the person.
2. Under **Overrides**, find `loans.manage` (marked "owner only") and press **Grant**.

They then see **Loans** under Accounts, and nothing else of the owner's. To take it away, press **Default** on the same line.

While they hold it, **only the owner can reset their password** (another admin sees "Only the owner can reset this password (they hold loans.manage)."), so no other admin can sign in as them to read the loans.

## The list

The list shows each loan's **Name**, **Direction**, **Other party**, **Balance**, **Rate now**, **Last paid** and the interest paid in the current financial year (the column says which, for example "Interest FY 2026-27"; the year runs 1 July to 30 June). Press a loan's name to open it. **Show archived** lists the archived loans instead.

## A new loan

1. Press **New loan**.
2. Fill in:
   - **Name**, for example "M13 Lender loan".
   - **Direction:** **Lent to the business** (the business repays it) or **Lent by the business** (it is repaid to the business). It only changes the words; the sums are the same.
   - **Other party** (optional).
   - **Opening balance:** the balance on the opening date, in dollars.
   - **Opening date:** not in the future.
   - **Note** (optional).
3. Press **Add loan**. The loan opens.
4. Add its rate (below) before its first repayment.

At cutover, each loan starts from its balance on the cutover day, as its opening balance, rather than the workbook's history.

## A loan

The top shows the **Balance** in large type, then the direction, other party, the rate now, when it opened and at what balance, and this financial year's principal and interest.

- **Details:** change any of them and press **Save**.
- **Rates:** the rate history.
- **Repayments:** every repayment, oldest first.
- **Statement:** the print.
- **Archive** / **Restore** at the top.

### Rates

Interest is worked out from the **annual rate** in force on the day. A loan keeps its whole rate history: press **Add rate**, choose **From** (the date the rate starts) and the **Annual rate (%)** (for example 6.50), add a note if you like, and press **Add rate**. The rate on any day is the latest one that started on or before it. **Edit** and **Delete** change the history. Deleting a rate leaves the interest already recorded alone; only the worked-out figures change.

### Repayments

1. Press **Add repayment**.
2. Choose the **Date paid** (not in the future, not before the opening date).
3. Type the **Principal** (what comes off the balance).
4. The **Interest** fills itself in as you choose the date, with how it was worked out underneath, for example "Worked out: balance $118,000.00 × 6.00% ÷ 12 = $590.00." Change it to match the lender's statement if it differs.
5. Add a **Reference** (a MYOB or bank reference) and a **Note** if you like.
6. Press **Add repayment**.

**How the interest is worked out:** once a month, as the workbook did. If another repayment in the same calendar month already carries interest, the suggestion is $0.00, with "Interest already charged this month (d Mon)." Otherwise it is the balance just before the repayment × the annual rate ÷ 12, rounded to the cent. So a repayment of principal only (interest $0.00) leaves the month's interest to the next repayment that month. If no rate covers the date, it says "No rate covers d Mon yyyy: type the interest or add a rate."

Example (made-up figures): a loan opened at $120,000.00 at 6.00%. A repayment on 10 January of $2,000.00 principal gets $600.00 interest ($120,000.00 × 6% ÷ 12) and leaves $118,000.00. A second repayment on 24 January gets $0.00 interest.

The interest you type is what's kept and printed. When it differs from the worked-out figure, the Repayments table shows the worked-out one beside it in small grey type ("worked out $x"). When you edit a repayment, its interest stays as it was; **Use $x** puts the worked-out figure in.

**Edit** and **Delete** (it asks first) change a repayment. Deleting one raises every later balance by its principal.

### The balance

**The balance is the opening balance less every principal repaid.** It is worked out every time, never typed, so it can't drift. Interest is paid as it falls due and doesn't change the balance. The **Balance after** column shows it after each repayment.

A balance can't go below zero. Further borrowing on the same loan isn't recorded: make a new loan if that ever happens.

### Archive

When a loan is paid off, press **Archive** (it asks first). An archived loan leaves the list (it's under **Show archived**), takes no new rates or repayments, and its page is read-only, but its statement still prints. **Restore** brings it back. Loans are never deleted.

## The statement

On the loan, under **Statement**, choose **From** and **To** (the opening date and today unless you change them) and press **Print statement**. It opens on screen on a white sheet with **Print** and **Back to the loan**.

The statement is A4, black on white, with no letterhead: "Loan statement", the loan's name, the period, its direction and other party, and when it opened; the balance at the start; a table of Date, Reference, Principal, Interest, Total and Balance; the totals; the balance at the end; and the rates in force during the period ("6.00% from 1 Jan 2025"). A long statement runs on to more pages, with the table's heading repeated.

## When Crosscuts refuses

| It says | What it means |
|---|---|
| That would take the balance below zero on d Mon yyyy | The principal is more than what's owed by then. Check the figures. |
| A repayment can't be before the opening date (d Mon yyyy) | Choose a later date, or change the opening date. |
| A repayment is dated before that (d Mon yyyy) | The new opening date is after a repayment. |
| Enter the principal, the interest or both | A repayment needs at least one of them. |
| No rate covers d Mon yyyy: type the interest or add a rate | No rate started on or before that date. |
| There is already a rate from d Mon yyyy | Each start date has one rate. Edit that one. |
| The rate must be from 0 to 5000 basis points (0% to 50%) | Type a percent from 0 to 50. |
| This loan is archived; restore it to change it | Restore it first. |
| The opening date can't be in the future | Choose today or earlier. |
| The statement can't end before it starts | Put the To date after the From date. |
