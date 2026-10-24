# How to keep loan balances in Crosscuts

For Todd, and anyone he gives the Loans page to. The **Loans** page replaces the Loan Balances tab of the jobs master workbook: each loan's payments month by month, its interest rate over time, a plan to pay it off, and a balance that is always worked out, never typed.

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

## The Loans page (changed 2026-10-24)

Every current loan sits side by side, as a column each (two across a laptop screen, three on a big screen, one under the other on a phone). **Show archived** shows the archived ones instead; **New loan** adds one.

Each loan shows its **name**, its **Balance** in large type, the **Rate** now and its **plan** in a line ("Plan: $1,500.00 a month · paid off about Jun 2031", or "Plan: paid off by Dec 2028 · $707.94 a month"). Then the buttons **Add payment**, **Rate**, **Plan**, **Details** (the loan's own page) and **Statement**, and the **month table**, like the workbook:

| Month | Principal | Interest | Total | Paid | New balance |
|---|---|---|---|---|---|

- One line per payment, with the month on its first line. Paid is the day it was paid (14/10).
- A month with no payment still has a line: its interest only, Principal, Total and Paid "—", and the balance goes **up** by the interest.
- This month is highlighted teal and marked THIS MONTH.
- Below it, in grey and marked PLANNED, the months the plan lays out (the first 12, with a button for the rest).

## How the balance and interest work (Todd, 2026-10-24)

- **Interest is charged once a month**, on the 1st: the balance at the start of the month × the annual rate in force on the 1st ÷ 12, rounded to the cent, and **added to the balance**. Example (made-up): $69,000.00 at 10.35% with no payment that month gives $595.13 interest and a balance of $69,595.13.
- **The first month charged:** the opening month if the loan opened on the 1st, otherwise the month after (the opening month's line shows "—" for interest).
- **A payment takes its whole total off the balance.** Crosscuts splits it: the **interest part** is the month's interest still unpaid (an earlier payment that month pays it first), the rest is **principal**. A second payment in the same month is all principal. If a month's payments don't cover its interest, what's left stays in the balance and earns interest from then on.
- Months run up to this month (Sydney time). The balance shown is after this month's interest.
- The balance can't go below zero after any payment.

## A new loan

1. Press **New loan**.
2. Fill in **Name**, **Direction** (**Lent to the business** or **Lent by the business**; it only changes the words), **Other party** (optional), **Opening balance** and **Opening date** (not in the future), **Note** (optional).
3. Press **Add loan**. The loan's page opens. Add its **rate** before anything else.

At cutover, each loan starts from its balance on the cutover day as its opening balance.

## Add a payment

1. Press **Add payment** on the loan.
2. Choose the **Date paid** (not in the future, not before the opening date) and type the **Total paid**.
3. The split shows as you type, for example "Interest $146.51 (worked out) · Principal $853.49 · Balance after about $16,133.22", with the month's interest and how much is still to pay underneath.
4. **Interest part (optional):** leave it empty. Type a figure only to match a lender's statement; it changes the split, never the balance. It can't be more than the total.
5. Add a **Reference** (MYOB or bank) and a **Note** if you like, and press **Add payment**.

## The plan

Press **Plan** and choose:
- **A fixed amount a month:** Crosscuts lays out each month to come (interest, principal, total, new balance) until the balance reaches zero, and says when it's paid off. If the amount doesn't cover the interest it says so in orange: "This doesn't cover the interest; the balance grows."
- **Paid off by a month:** Crosscuts works out the even monthly payment (an ordinary loan repayment at the rate now ÷ 12, rounded up to the cent) and lays out the months to that month; the last payment clears what's left.
- **No plan:** no future months.

The plan starts **this month** when nothing has been paid this month yet (its interest is already charged), otherwise **next month**. It shows at most 10 years. The dialog previews the result before you save. The plan only shows; it records nothing.

## A loan's page (Details)

Press **Details** (or the loan's name). The page shows the balance, direction, other party, rate now, when it opened and at what balance, and this financial year's principal paid and interest charged.

- **Details:** change any of them and press **Save**.
- **Rates:** the rate history. **Add rate** with a **From** date and the **Annual rate (%)**; the rate on any day is the latest one that started on or before it. **Edit** and **Delete** change the history; the month table follows.
- **Months:** the same month table, with **Edit** and **Delete** on each payment, and **Interest** on each month to type the interest a lender charged that month (leave it empty to go back to the worked-out figure). Each month shows what it was charged under its name.
- **Statement:** the print.
- **Archive** / **Restore** at the top.

## Archive

When a loan is paid off, press **Archive** on its page (it asks first). It leaves the Loans page (it's under **Show archived**), takes nothing new, and its page is read-only; its statement still prints. **Restore** brings it back. Loans are never deleted.

## The statement

On the loan's page, under **Statement**, choose **From** and **To** and press **Print statement** (the **Statement** button on the Loans page prints from opening to today). It covers **whole months**, from the month of From to the month of To. A4, black on white, no letterhead: the loan, the period, the balance at the start, the month table (Month, Paid, Reference, Principal, Interest, Total, New balance; a month with no payment shows its interest only), the totals paid, the interest charged in the period, the balance at the end, and the rates in force.

## When Crosscuts refuses

| It says | What it means |
|---|---|
| That would take the balance below zero on d Mon yyyy | More than is owed by then. Check the figures. |
| A payment can't be before the opening date (d Mon yyyy) | Choose a later date, or change the opening date. |
| A payment is dated before that (d Mon yyyy) | The new opening date is after a payment. |
| Enter the total paid | A payment needs its total. |
| The interest part can't be more than the total paid | Lower the typed interest part. |
| The payoff month must be next month or later | Choose a later month (up to 10 years ahead). |
| There is already a rate from d Mon yyyy | Each start date has one rate. Edit that one. |
| The rate must be from 0 to 5000 basis points (0% to 50%) | Type a percent from 0 to 50. |
| This loan is archived; restore it to change it | Restore it first. |
| The opening date can't be in the future | Choose today or earlier. |
| The statement can't end before it starts | Put the To date after the From date. |
