# M13 Owner-only: plan

Status: **M13 · 1.3 done: Todd answered every question (2026-10-16); plan approved** (Decisions in section 5 are binding and win over sections 2 and 4. Todd chose differently from the recommendation on question 2: **the alarm codes are stored**, encrypted; see Decision 2.)

Scope (Todd, 2026-10-12, `jobs-master-tabs.md`): a kind of key the admin preset does not get by default (today `admin` gets every key), then three tabs of the jobs master workbook: **Bonuses** and **Alarms** (Admin, owner only) and **Loan Balances** (Accounts, behind its own key).

**This repo is public, and these tabs are the most private in the workbook.** No codes, passwords, account numbers, figures, rates, balances, lender or staff names appear in this file, the contracts, the code, the tests or the screenshots. Made-up data only (`M13 Test Job`, `M13 Person`).

## 1. Audit (M13 · 1.1, 2026-10-16)

Three read-only surveys: the workbook tabs (read from a copy, since the original was open in Excel; the copy and its dumps were deleted afterwards because they held the real codes and figures), the Crosscuts code, and Joinr (`tenon-quotr`, read and searched only, CLAUDE.md rule 12).

### 1.1 The workbook tabs

**Bonuses** (a per-job bonus ledger, one row per job; 8 jobs entered, rows ready for more; **no dates anywhere**):

- **Settings block:** the bonus rate (a percent of the job price), a typed share total, and **share points per holder**: a "Factory" pool set to zero and three named people. Each holder's fraction = their points ÷ the share total. The share total is typed, not summed, so it would go stale if points changed.
- **Per job:** Owner (a first name: who ran the job), Checks (a first name: who checked it), Job (typed text), Total Price (typed), **Possible** = price × rate, quoted hours (factory, install), actual hours (factory, install), **Lost** = possible − earned, **Bonus** = (checks ticked ÷ 7) × possible.
- **Seven checks**, yes/no, equal weight: Mozaik (drawn), Order, Assemble, Install, No fuss, On time, Hours.
- **Shares:** each holder's share of the job's bonus = bonus × their fraction, each with a **Paid** tick. A "Payweek" column exists but has never been filled in.
- **The hours are placeholders:** every filled row has the same number in all four cells, and no formula uses them. The "Hours" check is ticked by hand.
- **No totals** (nothing adds up a person's earned, paid or unpaid bonus) and **no link to pay runs** (Payroll, Timesheet and Overtime have no bonus column).
- Shares are fixed points per person, the same for every job: they don't depend on hours worked on the job.

**Alarms** (no formulas, no dates):

- **13 user slots** (12 named, one temp): slot number (likely the panel's user number), the holder's first name, and **their code** (stored as a number, so a leading 0 would be lost).
- An unused legend of three user types (office, staff, temp): no holder says which type they are.
- **The alarm company account:** company name, account number, a contact name and phone, and a **monitoring password**.
- **A weekly table**, one row per weekday, two times headed "Deactive" and "Activate": it reads like an automatic arm/disarm schedule, but the headings look swapped for normal hours.
- Not recorded: when a code was issued, changed or removed; who has left; more than one site.

**Loan Balances** (two loans, 2026 only, one row per repayment; not linked from Main):

- Each loan: month label, principal repaid (the column is mislabelled "Balance"), interest, total, date paid, new balance. Repayments roughly fortnightly; interest charged roughly monthly.
- **Interest** is a simple monthly amount: an annual rate (a cash rate plus margins) ÷ 12 on the balance. One row has the formula; later rows are **read off a side calculator and typed**. Two side calculators hold two different rates (the rate changed; the sheet keeps both).
- Most new balances are typed. **One typed balance on the first loan doesn't follow from the payments**, and the difference carries forward.
- The tab doesn't say whether the loans are to or from the business. No link to MYOB, the bank or a statement.

None of the three tabs is referred to by a formula on any other tab, and they refer to no other tab.

### 1.2 Crosscuts today

- **Admin gets every key in one place:** `PRESETS.admin = [...KEYS]` (`lib/permissions.js:41`, 27 keys). Overrides grant or revoke per user (`permission_overrides`, no CHECK on the key, so a new key needs no migration there).
- **No owner exists.** First-run setup makes an admin (`routes/auth.js:199`) with no flag. Anyone holding `users.admin` can today grant **any key to themselves**, change anyone's roles, **reset any password including the owner's** (and so sign in as them), disable the owner while another admin remains, and read the whole audit log. **An owner-only key is only as strong as the guards around `users.admin`.**
- **The admin role (not a key)** also sees every comment, task, report, message channel and Planner layer (only the Personal layer is hidden "even from admin": the precedent).
- **The audit log** stores full before/after JSON for ever (append-only) and shows it to `audit.view` holders (admin preset). Bonus or loan figures written there would be readable by every admin.
- **Backups:** the whole database goes into the nightly 7-Zip AES archive (header-encrypted; copied weekly to the NAS). Before each migration a **plain** `VACUUM INTO` copy is kept on the Umbrel. So anything stored in the database exists in plain form on the Umbrel and encrypted on the NAS. Secrets that must stay out of backups are kept in `CONFIG_DIR` files (the Joinr key precedent), not the database.
- **Quoted hours:** Joinr already sends `estimatedHours {office, factory, site, travel}` on every won quote; Crosscuts keeps it only inside `joinr_intake.payload` and as text in the job's notes. **Joinr's factory and site figures are half the hours typed on the quote** (halved for its overhead sum; the intake contract doesn't say so). Crosscuts can double them back without any Joinr change.
- **Actual hours:** M8 timesheets are per person per day, with the job as **free text** (`pay_days.job`, suggested from the board as "Name (JRQ…)", several joined with " / "). Summing hours per job would mean parsing that text. The board gives days per worker per job, not hours.
- **People:** three lists with no link between logins and staff: `users`, board `workers`, and `pay_people` (a worker, or a pay-only office person). Bonus shares key on `pay_people`.
- **Money** is integer cents everywhere; lock patterns exist (pay run finalise, BAS lodge, reopen needs `users.admin`).
- Next migration **026**; version now **0.1.16**, so M13 ships as **0.1.17**.

### 1.3 Joinr (read only)

- Labour hours live per room, per labour item, inside the quote's JSON; the engine sums them by bucket. The intake read already returns everything needed to send the real typed hours (a TypeScript-only change there, no SQL), but any change in tenon-quotr needs Todd's go under rule 12. **Not needed for M13** if Crosscuts doubles factory and site.
- Joinr has its own unused bonus pool (a percent of the quote, split office/factory/site, not per person). It isn't shown or sent. Joinr records no actual hours.

## 2. Proposed shape

### 2.1 The owner (question 1)

- **One owner**, marked on a login (`users.is_owner`, additive migration 026). Backfilled to the first-run setup user (the earliest admin); setup marks the owner from then on. There is always exactly one.
- **Owner-only keys:** a new list in `lib/permissions.js`. The admin preset becomes every key **except** these. The owner holds all keys. The owner can grant an owner-only key to someone else (e.g. Loans to an Accounts login); **nobody else can grant or revoke them, including other admins.**
- **Guards around the owner** (`routes/users.js`): only the owner may change the owner's roles, reset the owner's password, disable the owner, end the owner's sessions, or grant/revoke owner-only keys. The owner hands ownership to another admin with a confirm (it can't be taken).
- **The audit log:** rows about bonuses, alarms and loans are shown only to holders of the matching key (so the owner sees the full history; other admins don't see them at all).
- **No notices, tasks, comments or Planner items** for these areas (the admin role sees all of those).
- **Plainly stated limit:** this protects the figures inside Crosscuts. Anyone with the Umbrel itself, or the backup passphrase, can read the database.

### 2.2 Bonuses (questions 3, 4, 5)

- A **Bonuses** page (Admin menu, owner-only key): one bonus per Crosscuts job (picked from jobs, not typed), as the workbook's row: price (from the job's value, editable), possible, the seven checks, earned, lost, who ran it and who checked it (staff from `pay_people`), quoted and actual hours (factory, install).
- **Settings:** the bonus rate and each holder's share points (with the share total **added up**, not typed). A job's shares are **frozen when its bonus is confirmed**, so later changes to points or rate don't rewrite old jobs.
- **Hours:** quoted hours prefilled from the job's Joinr quote (factory and site doubled back to the hours typed on the quote), editable; actual hours typed in. The **Hours** check is suggested (ticked when actual ≤ quoted) and can be changed by hand.
- **Paying:** each holder's share is marked paid **with a date** (and optionally which pay run it went in); a summary shows each person's earned, paid and owed totals. Bonuses stay out of the pay run itself (pay runs hold no money).
- A print of the summary and of a job's bonus (A4, black on white).

### 2.3 Alarm holders (questions 2, 6)

- An **Alarms** page (Admin menu, owner-only key): the slot list (slot number, holder: a staff person or a typed name for a temp/outsider, type office/staff/temp, date given, date removed, a note). *(Superseded by Decision 2: the codes are stored too, encrypted and masked; the monitoring password is not.)*
- **Leavers:** when a holder's staff record is archived (they've left) and their slot isn't marked removed, the page and the owner's dashboard say in orange "<name> has left: change or remove slot n".
- **The alarm company:** company name, account number, contact name and phone (no password).
- **The weekly arm/disarm times**, one row per day, if Todd wants them kept.

### 2.4 Loan balances (question 7)

- A **Loans** page (Accounts menu, its own owner-only key; the owner can grant it to an Accounts login).
- Each loan: name, which way it runs (lent by the business, or borrowed by it), the opening balance and date, and its **interest rate history** (rate from a date).
- **Repayments:** date paid, principal, interest, a reference (e.g. MYOB or bank), a note. **Interest is worked out** (rate ÷ 12 on the balance, as the sheet does) and can be changed to match a statement; **the balance is always calculated** from the opening balance and the rows, never typed, so it can't drift as the sheet's did.
- A statement print per loan.

### 2.5 Data (question 8)

- Crosscuts starts empty for testing, as every milestone. At cutover, the owner types in: bonuses not yet paid, the alarm holders, and each loan's balance as at cutover (as the opening balance), rather than importing the workbook's history (it has no dates for bonuses and one wrong balance on a loan).

### 2.6 Build size

- Keys 27 → 30 (names settled in contracts, e.g. `bonuses.manage`, `alarms.manage`, `loans.manage`); admin preset stays 27; the smoke's two "27" assertions change.
- Migration **026** (additive: `users.is_owner` plus the new tables).
- Probably **two waves**: (1) the owner and keys, the users guards, the audit filter; bonuses backend; alarms and loans backend; (2) the three pages, prints and the Users page changes. Fixed at 2.1.

## 3. Questions for Todd (asked one at a time)

1. **The owner:** one owner marked on your login; only the owner holds the owner-only keys by default and can grant them, and only the owner can change, reset or disable the owner's login; ownership handed over only by the owner (recommended)? Or an "owner" role alongside admin?
2. **Alarm codes:** record who holds which slot (with dates and leavers flagged) but **not the codes or the monitoring password**, which stay in a password manager or the alarm company's portal (recommended)? Or store the codes in Crosscuts too (they'd then sit in the database and every backup)?
3. **Bonus formula:** keep the workbook's rule: rate × job price × (checks ticked ÷ 7), the same seven checks at equal weight, fixed share points per person, frozen per job when confirmed (recommended)? Or change any part of it?
4. **Hours:** quoted hours from the Joinr quote (factory and site doubled back to the typed hours; no Joinr change), actual hours typed in, the Hours check suggested from them but changeable (recommended)? Or a hand tick only, or put the job on each timesheet day so actual hours add up themselves (a bigger change to pay runs)?
5. **Paying bonuses:** mark each person's share paid with a date (optionally the pay run), with owed totals per person, kept out of the pay run (recommended)? Or a bonus line in the pay run's MYOB summary?
6. **Alarm extras:** keep the alarm company's details (no password) and the weekly arm/disarm times (recommended), or holders only? (And what the "Deactive/Activate" times are.)
7. **Loans:** who are the two loans between (lent by or to the business; there may be more later)? Interest worked out monthly from a rate history and changeable to match a statement, balance always calculated (recommended)? Owner only by default, grantable to an Accounts login (recommended)?
8. **Data:** start empty; at cutover type in unpaid bonuses, alarm holders and each loan's balance as an opening balance (recommended)? Or import the workbook's history?

## 4. Lead's defaults (unless Todd says otherwise)

1. The owner's login keeps the admin role as well; "owner" is a mark, not a role, so no `user_roles` rebuild.
2. Audit rows for the three areas keep their before/after values (the owner sees the full history) but are hidden from anyone without the matching key.
3. Bonuses, alarms and loans send no notices and create no tasks; the only prompt is the leavers line on the Alarms page and the owner's dashboard.
4. Bonus holders are `pay_people` (staff on the pay run, or pay-only office staff); a "Factory" pool isn't kept unless Todd wants one.
5. The Alarms page and Bonuses page sit in the Admin menu; Loans in the Accounts menu. No new colour.
6. Prints are A4, black on white, with no letterhead (internal documents).
7. Money in integer cents; dates as Sydney `YYYY-MM-DD`; rates as basis points (hundredths of a percent).
8. The intake contract (Crosscuts' copy) gains a line saying Joinr's factory and site hours are halved; the tenon-quotr copy follows only when Todd okays a Joinr change (rule 12).

## 5. Decisions

Todd, 2026-10-16:

1. **The owner:** one owner marked on Todd's login (`users.is_owner`, additive). Only the owner holds the owner-only keys by default and can grant or revoke them; only the owner can change, reset, disable or end the sessions of the owner's login; ownership is handed over only by the owner. (Recommended.)
2. **Alarm codes are stored in Crosscuts** (not the recommendation). Lead's protections, binding unless Todd says otherwise:
   - each code (and nothing else) is **encrypted in the database** (AES-256-GCM) with a key kept in a file under `CONFIG_DIR`, never in the database, so the plain pre-migration copies on the Umbrel hold only ciphertext. The key file goes into the encrypted nightly archive with the rest of `config/` (a restore needs both, as the Joinr key already does);
   - codes are **stored as text** (a leading 0 is kept) and **masked on screen** until the owner (or a holder of the alarms key) chooses Show; each Show writes an audit row that never contains the code;
   - **the audit log never holds a code**: a change records "code changed" only;
   - **the monitoring password is not stored** (Todd's answer to question 6).
3. **The bonus rule as the workbook:** rate × job price × (checks ticked ÷ 7), the seven checks at equal weight, fixed share points per person, a job's shares frozen when its bonus is confirmed. (Recommended.)
4. **Hours:** quoted factory and install hours from the job's Joinr quote (Joinr's halved factory and site figures doubled back; no Joinr change), actual hours typed in, the Hours check suggested from them and changeable. (Recommended.)
5. **Paying:** each person's share marked paid with a date (optionally the pay run), with earned, paid and owed totals per person; bonuses stay out of the pay run. (Recommended.)
6. **Alarm extras:** keep the alarm company's details (name, account number, contact, phone) and the weekly times; **not** the monitoring password. The weekly times **arm in the evening and disarm in the morning** (the tab's headings are swapped): labelled "Arms at" and "Disarms at".
7. **Loans:** both current loans are **lent to the business** (the business repays them); each loan still records its direction so a later one could run the other way (lead's default). Interest worked out monthly from a rate history and changeable to match a statement; the balance always calculated; the owner by default, grantable to an Accounts login. (Recommended.)
8. **Data:** start empty; at cutover the owner types in the unpaid bonuses, the alarm holders and codes, and each loan's balance at cutover as its opening balance. No import of the workbook's history. (Recommended.)

