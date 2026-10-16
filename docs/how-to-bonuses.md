# How to keep job bonuses in Crosscuts

For Todd. The **Bonuses** page replaces the Bonuses tab of the jobs master workbook: one bonus per job, worked out by the same rule, with each person's share marked paid when it's paid.

Who can open it:
- **The owner** (Todd). Bonuses needs the owner-only key `bonuses.manage`, so other admins don't see it in the menu, can't open it, and don't see its rows in the audit log.
- Anyone the owner grants `bonuses.manage` to on the Users page (see [how-to-add-user.md](how-to-add-user.md)). Only the owner can grant it.

Open **Admin**, then **Bonuses**. The page has three tabs: **Jobs**, **Owed** and **Settings**.

Nothing about bonuses sends a notice or makes a task. Bonuses stay out of the pay run: Crosscuts never adds them to a pay run or its MYOB summary.

## The rule

The same as the workbook:

- **Possible** = the job's price × the bonus rate.
- **Earned** = possible × (checks ticked ÷ 7). Worked out from the price in one step and rounded once, to the cent (half up).
- **Lost** = possible − earned (nothing lost when all seven are ticked).
- **Shares:** each person's share of the earned bonus is their **share points** out of the total points. Any cents left over after the split go one each to the people with the largest remainders, so the shares always add up to the earned bonus exactly. A share that comes to 0 cents isn't kept.

The seven checks, each worth the same:

| Check | Meaning |
|---|---|
| Drawn (Mozaik) | drawn in Mozaik |
| Ordered | ordered |
| Assembled | assembled |
| Installed | installed |
| No fuss | no fuss |
| On time | on time |
| Hours | the job came in on its quoted hours (suggested by Crosscuts, below) |

Example (made-up figures): a price of $30,000.00 at 1.50% has a possible bonus of $450.00. With five checks ticked, earned is $321.43 and lost $128.57. Three people with 2, 1 and 1 points (4 in all) get $160.71, $80.36 and $80.36.

## Settings: the rate and the share points

On the **Settings** tab:

1. Type the **Bonus rate (% of the job price)**, up to two decimal places (for example 1.50).
2. Under **Share points**, press **Add person** for each person who shares a job's bonus, choose them, and type their **points** (a whole number from 0 to 1000). **Up**, **Down** and **Remove** change the list.
3. The **Share total** is added up for you as you type. It is never typed.
4. Press **Save**.

People come from the pay list (the board's workers and the pay-only office people on Pay runs). There is no "Factory" pool: if one is wanted, add a pay-only person named for it on Pay runs and give it points.

Changing the rate or the points changes every **draft** bonus straight away. **Confirmed bonuses keep the rate and shares they were confirmed with.**

## Starting a job's bonus

1. On the **Jobs** tab, press **New bonus**.
2. Type part of the job's name under **Find a job** and choose it. A job that already has a bonus shows "has a bonus" and can't be chosen: each job has one bonus.
3. Press **Create bonus**. The bonus opens as a **draft**.

The draft starts filled in where it can be:
- **Price (inc GST)** comes from the job's value, including GST, with the note "From the job's value, including GST". It is filled in only for someone who can see job values (`jobs.value`). Change it if the bonus should be on a different price.
- **Quoted factory hours** and **Quoted install hours** come from the job's Joinr quote, with the note "From Joinr (factory and site doubled back from the quote)". Joinr sends half the factory and site hours typed on the quote, so Crosscuts doubles them back. Office and travel hours aren't used.

## Filling in a draft

- **Price and people:** the price, **Ran by** (who ran the job) and **Checked by** (who checked it), both from the pay list.
- **Hours:** the quoted and actual hours, factory and install, in hours (decimals are fine, for example 7.5). Type the **actual** hours in; they don't come from timesheets. **Fill from Joinr** puts the quoted hours back as Joinr sent them, if you've changed them.
- **Checks:** tick the checks that were met.
- **Note:** anything worth keeping with the bonus.

**The Hours check is suggested:** it is ticked when the actual factory and install hours together are no more than the quoted ones, and only when all four are filled in. Beside it, "Suggested: yes", "no" or "unknown". You can tick or untick it by hand; it then says "(set by hand)", and **Use suggestion** puts it back to following the hours. While the suggestion is "unknown", Hours counts as not ticked.

**Figures (live)** show the rate, possible, earned and lost as you change things, and **Shares preview** shows each person's points and share. Press **Save** to keep your changes ("Not saved yet." shows until you do).

A draft can be deleted with **Delete** (it asks first). A confirmed bonus can't.

## Confirming

When the job is done and the checks are settled:

1. Press **Confirm**.
2. Choose the **Confirmed date**: today unless you change it, never in the future. Any unsaved changes are saved first.
3. Press **Confirm**.

Confirming freezes the bonus: its rate, figures, the Hours check and the shares, with the share points as they are that day. It is then read-only, and each person's share is owed.

**Reopen** takes a confirmed bonus back to a draft, as long as no share of it has been marked paid. When it's confirmed again, the **current** rate and share points apply.

## Paying

Paying happens outside Crosscuts as now. Crosscuts records that each share was paid.

**One share:** on a confirmed bonus, each share shows **Owed** with **Mark paid**. Choose the **Date paid** (today unless you change it; not in the future, and not before the bonus was confirmed) and, if you like, the **Pay run** it went in. The pay run is only a note: marking a bonus paid never changes the pay run. **Undo paid** marks it owed again.

**Everything owed to one person:** on the **Owed** tab, each person with anything owed has a card listing their owed shares (job, confirmed date, share) and **Mark all paid**. It marks every share on that card paid with one date and pay run.

The **Owed** tab's table shows each person's **Earned**, **Paid** and **Owed** totals across every confirmed bonus, and the totals for everyone. Drafts count nowhere.

## The Jobs list

The **Jobs** tab lists every bonus: Job, Status (**Draft** or **Confirmed**, with the confirmed date), Price, Ticked (n of 7), Earned, Lost and Owed, each with **Open**. **Show** filters it to Draft, Confirmed, Owed (confirmed with a share still unpaid) or All. Drafts come first.

## The prints

Both are A4, black on white, with no letterhead (they're internal). Each opens on screen on a white sheet with **Print** and **Back**.

- **A job's bonus:** **Print** on the bonus. "Job bonus", the job and its confirmed date; price, rate, possible, earned and lost; the seven checks as `[x]` and `[ ]` with "Ticked n of 7" (Hours marked "(suggested)" when it follows the hours); ran by and checked by; the quoted and actual hours; the shares, each paid (with its date and pay run) or "Owed"; and the note. A draft prints a **DRAFT – NOT CONFIRMED** box at the top, with the live figures as of that day.
- **Bonuses owed:** **Print** on the **Owed** tab. Today's date, each person's earned, paid and owed, the totals, then each person with anything owed and their owed shares.

## When Crosscuts refuses

| It says | What it means |
|---|---|
| This job already has a bonus | Each job has one bonus. Open the one it has. |
| This bonus is confirmed; reopen it to change it | Confirmed bonuses are locked. Reopen it first (only possible while nothing is paid). |
| Fill in the price before confirming | The price is empty. |
| Set the share points before confirming | Something was earned but nobody has share points. Set them on Settings. |
| The confirmed date can't be in the future | Choose today or earlier. |
| A share of this bonus has been paid; undo that first | Reopen needs every share owed. Undo paid first. |
| Only a draft bonus can be deleted | Reopen it first, then delete it. |
| No Joinr hours for this job | The job didn't come from a Joinr quote with hours. Type the quoted hours. |
| The paid date can't be before the bonus was confirmed (d Mon yyyy) | Choose a date on or after the confirmed date. |
| This share is already marked paid | Someone marked it already. The page reloads to show it. |
| The owed list changed while you were looking; reload it | Someone marked a share paid or confirmed a bonus meanwhile. The Owed tab reloads; check it and try again. |
| The bonus rate must be from 0 to 10000 basis points (0% to 100%) | Type a percent from 0 to 100. |
| Share points must be whole numbers from 0 to 1000 | No halves: double everyone's points instead. |
| <name> is listed twice | A person appears twice in the share list. Remove one. |

## At cutover

Crosscuts starts with no bonuses. At cutover, type in the bonuses not yet paid (each as a bonus on its job, confirmed), rather than the workbook's history.
