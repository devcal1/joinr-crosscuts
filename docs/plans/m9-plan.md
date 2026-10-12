# M9 BAS and suppliers: plan

Status: **M9 · 1.2: plan written, questions put to Todd** (section 4). Decisions go in section 5 when answered.

Scope (Todd, 2026-10-12, `jobs-master-tabs.md`): two Accounts tabs of the jobs master move into Crosscuts.
- **BAS-Sales** (tab 25): monthly sales for the BAS, **built from Crosscuts invoices, no typing in**.
- **Supplier Accounts** (tab 29, "report"): the monthly checklist of supplier statements.

No MYOB integration (brief D10/D12): figures are keyed into MYOB by hand, as invoices and pay runs are.

This repo is public: no figures, client or supplier names, account numbers or amounts from the workbook go in it.

## 1. Audit (M9 · 1.1, 2026-10-12)

### 1.1 BAS: what exists

- **Invoices** (`006_accounts.sql`, `007_invoice_freeze.sql`, `008_invoice_reference.sql`):
  - `kind`: deposit, progress, final or extra.
  - `status`: pending, due, issued, paid, waived or void. "Draft" means pending or due.
  - Frozen at issue: `total_cents`, `gst_cents`, the bill-to snapshot, `reference`, `contract_value_cents` and `invoiced_before_cents`.
  - Dates (Sydney `YYYY-MM-DD`): `issue_date`, `due_date`, `paid_date`, `myob_entered_date` and `became_due_date`.
  - Also `external_id` (the MYOB slot), `void_reason`, `waive_reason` and `replaces_id`.
  - **No void date:** only `updated_at` (UTC, and changed by any later edit) and the `invoice.void` audit row.
- **Lines** (`invoice_lines`): description and `amount_cents`, GST-inclusive, which may be negative (a discount). The invoice total must be more than 0. Lines are frozen at issue.
- **GST:** worked out once per invoice at issue as `Math.round(total / 11)` (`lib/invoices.js` `issue()`).
  - There is no per-line GST and no GST-free flag: every line is taxable.
  - Amounts are integer cents, GST-inclusive, and never shown ex-GST (m2-plan decision 10).
- **Issue date:** always the Sydney day it is issued. It can't be backdated or edited.
- **Paid:** issued to paid with any valid date; nothing checks it against the issue date or today. It means paid in full (no part payments, m2 Q-D). Mark unpaid sets it back to issued.
- **Void:** issued, never paid. It keeps its number and makes a new due copy (`replaces_id`), which gets a new number when it's issued.
- **No credit notes** (m2 Q-C, deferred).
- **Waived:** a draft set aside, never issued, so never a sale.
- **Extras:** ordinary invoices of kind `extra`, from the same number series.
- **Existing totals:**
  - `GET /api/invoices/table` gives outstanding and overdue amounts and counts, and the not-in-MYOB count. Its `month` filter matches issue date **or** paid date in the current month, which mixes the two bases.
  - The Friday round-up (`lib/roundup.js`) covers due, overdue, not in MYOB and needs-value.
  - **Nothing sums sales by month.**
- **Report library** (`012_collaboration.sql`, `lib/reports.js`): uploaded files only, with a monthly `period` and a `category` CHECK (`bank_reconciliation`, `bas`, `payroll`, `aged_debtors`, `other`). Nothing is computed.
- **Dates** (`lib/time.js`): `sydneyToday`, `addDays`, `DATE_RE`. Nothing for months, quarters or the financial year (July–June).
- **Exports:** no CSV export exists anywhere. Prints follow the `invoice.*` / `payprint.*` browser-print pattern.
- **Cutover** (`docs/cutover.md`): test invoices are lost, and real invoicing starts at cutover.
  - Months before cutover are in MYOB and the workbook only.
  - The cutover month is partial: invoices issued straight in MYOB before the load are missing.

**What makes "monthly sales" ambiguous:**
- the basis (issue date or paid date);
- a void in a later month changing an earlier month, with no void date to place it;
- unchecked paid dates;
- no history before cutover, and a partial cutover month;
- GST rounded per invoice (the sum of `gst_cents` can differ by a few cents from total ÷ 11);
- no credit notes for paid invoices.

### 1.2 BAS-Sales tab: structure (no figures)

- **No heading row.** The only labels are month names, year numbers, "20xx Avg:" and "FY Predict:".
- **Block 1:** one row per month, June 2023 to June 2024, each with a typed whole-dollar amount, and a bar chart.
- **Block 2:** a grid with months as rows (January to December) and years as columns (2023, 2024, 2025), filled from June 2023 to June 2025. A line chart, "Monthly Sales", has one series per year. Nothing is typed after June 2025.
- **Formulas:** ad hoc: a running total, two averages (one duplicated) and "FY Predict" = average × 12.
- **Nothing about the BAS form itself:** no GST, no G1 or 1A, no quarters, and no cash/accrual or inclusive/exclusive note. It is one "sales" figure per month.

### 1.3 Supplier Accounts: what exists

- **Suppliers:** no supplier table.
  - The only supplier data is `orders.supplier`, a required free-text field on each per-job order line (`010_design_pm.sql`). `GET /api/orders/suppliers?q=` suggests up to 50 distinct names.
  - Order lines carry no amounts, invoice numbers or statements.
  - M3 chose free text on purpose ("no suppliers list").
- **Report library:**
  - A statement PDF can be filed under "other" today.
  - A `supplier_statement` category would mean rebuilding the table to change its CHECK, which is not additive.
- **Files** (`lib/files.js`): PDF, images and Office files, checked by magic bytes, 25 MB maximum. They attach through link tables (`reports.file_id`, `task_files`), which is the additive pattern to reuse.
- **Tasks:** one-off only, no recurrence.
- **Planner** (`018_planner.sql`): events repeat weekly, fortnightly or monthly. There is an `accounts` layer (seen by accounts and admin) with reminders. Accounts can already set a monthly "check supplier statements" reminder with no new code.
- **Alerts:** the `notify` bell. The Friday 12:00 round-up goes to `invoices.edit` holders and could gain a "statements still waiting" line.
- **Months:** `reports.period` (`YYYY-MM`, never in the future, Sydney) is the only month-keyed data.
- **Accounts menu** (`public/shell/shell.js`): Accounts, Pay runs, Reports, in a dropdown. A new item doesn't change the bar width.

### 1.4 Supplier Accounts tab ("report"): structure (no names)

- **A blank printed A4 form, filled in by hand.** No formulas, validation or ticks are stored; rows are tall for handwriting.
- **Header:** "Suppliers", then the business name, address and phone.
- **Columns:** Supplier name | Have Statement | Waiting | N/A | Total, plus one unheaded bordered column (notes or a tick).
- **Rows:** one per supplier, 27 of them, alphabetical. The list includes services and other payees, not only materials suppliers.
- **No month or date field:** one sheet is one month's pass.
- **How it's filled in:**
  - Have Statement, Waiting and N/A read as one choice of three.
  - Total is a hand-written amount, most likely the statement balance.
  - Reconciling and paying are not on the form.

### 1.5 Shared

- **Keys:** 23 (`lib/permissions.js`). `accounts.view` reads and `invoices.edit` writes; M8 reused both, with `users.admin` to reopen. A new key touches `ci/smoke.sh` (two key counts), `docs/auth.md` and `docs/how-to-add-feature-key.md`.
- **Next migration: 020.** Both halves can share one additive migration.
- **Version:** 0.1.11 (M8) is unpushed, so M9 ships as **0.1.12**.

## 2. Proposed shape (before Todd's answers)

### 2.1 BAS sales (`/bas.html`, Accounts menu)

- **A financial-year table:** one row per month with quarter subtotals (Jul–Sep, Oct–Dec, Jan–Mar, Apr–Jun) and the year's total. Columns:
  - Sales including GST (G1);
  - GST on sales (1A), the sum of each invoice's frozen `gst_cents`;
  - Sales excluding GST;
  - the number of invoices, and how many aren't yet Entered in MYOB.
- **Click a month** for its invoice list (number, client, issue date, paid date, total, GST), with a CSV of it for MYOB or the accountant.
- **A same-month-by-year comparison** (as the workbook grid), drawn in house colours. The average and "FY Predict" formulas are dropped.
- **Voids:**
  - A void invoice never counts; its replacement counts in the month it is issued.
  - Migration 020 adds `invoices.void_date`, set by Void. Older voids fall back to the audit row's date.
- **Lodged months (if wanted):** **Lodged** (`invoices.edit`) freezes the month's figures; an admin can reopen, as with pay runs. A later change shows as "changed since lodged" and never silently moves a lodged month.
- **History (if wanted):**
  - Months before cutover take one typed total each, marked "imported".
  - The cutover month takes one "added by hand" amount with a note.
- **Print:** the financial year, black on white.

### 2.2 Supplier accounts (`/suppliers.html`, Accounts menu)

- **Suppliers:** a list Accounts keep (add, rename, archive, never delete), separate from the free-text names on Orders. Accounts type the names in once; none go in the repo.
- **One month at a time** (previous and next), one row per supplier, as on the form:
  - Have statement / Waiting / N/A (Waiting until changed);
  - an optional Total;
  - a note;
  - optionally the statement PDF attached to the row.
- **A footer** with the counts and the sum of the totals.
- **Print:** the month's list, and a blank form to fill in by hand.
- **Reminder:** a monthly Planner event on the Accounts layer (no new code), and optionally a "statements still waiting" line in the Friday round-up.

### 2.3 Building it

- **Migration `020_bas_suppliers.sql` (additive):**
  - `invoices.void_date`;
  - `bas_months` (imported and adjustment figures, the lodged snapshot);
  - `suppliers`, `supplier_statements` (one row per supplier per month, `UNIQUE (supplier_id, period)`) and, if wanted, `supplier_statement_files`.
- **Code:**
  - `lib/bas.js` and `routes/bas.js`; `lib/suppliers.js` and `routes/suppliers.js` (`defineRoutes`, audited writes in transactions);
  - `fyOf` and `quarterOf` helpers in `lib/time.js`;
  - pages `bas.*` (`ba-`) and `suppliers.*` (`su-`).
- **Keys:** no new key: `accounts.view` sees, `invoices.edit` edits, `users.admin` reopens a lodged month.
- **Tests and docs:** smoke files `ci/smoke-m9-bas.sh` and `ci/smoke-m9-suppliers.sh`; how-tos for both; a `docs/cutover.md` note on the cutover month.

## 3. Lead's defaults (not asked; Todd can change any)

1. **Keys:** the existing Accounts keys, as in M8 (23 stays).
2. **Periods:** calendar months in Sydney time; the financial year runs July to June, labelled by the year it ends ("FY 2027" = Jul 2026 – Jun 2027).
3. **Money:** integer cents, GST-inclusive as stored. Ex-GST is shown only on the BAS page, as total minus GST.
4. **Credit notes stay deferred.** A refund is entered as a hand adjustment with a note in the month it happens.
5. **Paid-date sanity:** Mark paid refuses a date before the issue date or in the future. This is small, and it matters if Received is shown.
6. **Supplier data starts fresh:** Accounts type the names once.
7. **Names:** "BAS sales" and "Supplier accounts", in the Accounts dropdown after Pay runs, before Reports.
8. **Prints by browser print** (Save as PDF), black on white, as with pay runs. One CSV only: the month's invoice list.

## 4. Questions for Todd

Put to Todd on 2026-10-12. Each has a recommended answer.

1. **Basis.** Do the monthly sales go by the invoice's issue date (accrual) or by the date it's paid (cash)? Recommended: issue date, with a "Received" column beside it. The BAS basis is the accountant's call; showing both costs little.
2. **Lodged months.** Lock a month once the BAS is lodged (admin can reopen)? Recommended: yes, so a lodged figure never moves.
3. **History.** Type in the monthly totals from before cutover (one figure a month, marked imported), or start from cutover? Recommended: type them in, to keep the year-on-year comparison. If yes: were the workbook's figures including GST?
4. **Supplier statement states.** Mirror the form (Have statement / Waiting / N/A, total, note), or also add Reconciled, Paid and Entered in MYOB ticks? Recommended: mirror the form for now.
5. **Statement PDFs.** Attach each month's statement to its row? Recommended: yes (an additive link table, as task files).
6. **Waiting statements in the Friday round-up.** Recommended: yes, one line ("3 supplier statements still waiting for September"), as well as the Planner reminder Accounts can set themselves.
