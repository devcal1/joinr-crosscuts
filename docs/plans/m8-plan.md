# M8 Pay runs: plan

Status: **M8 · 1.3 done: Todd answered every question (2026-10-12); plan approved** (Decisions at the end; they replace section 2 where they differ).

Scope (Todd, 2026-10-12, `jobs-master-tabs.md`): the Timesheet, Overtime and Payroll tabs of the jobs master become fortnightly pay runs in Crosscuts. Accounts types each employee's handwritten fortnightly timesheet into a screen that mirrors the paper form row for row, and Crosscuts produces the per-employee summary (Normal Time, Over Time, Double Time, Annual Leave, Personal Leave) for keying into MYOB. No MYOB integration (brief D10/D12): keyed by hand, as invoices are.

This repo is public: no names, rates or hours from the workbook go in it.

## 1. Audit (M8 · 1.1, 2026-10-12)

What exists:

- **Workers** (`001_baseline.sql`): id, name, hue, archived, sort order; M5 added `days_per_week` and `regular_days_off` (`013_scheduling.sql`). No employment fields (start date, employee number, MYOB card), and **no link between a login user and a worker**. Edited on `/workers.html` (`workers.edit`, admin and scheduling only). Accounts can read `/api/workers` (it has `board.view`).
- **Leave** (`013_scheduling.sql`): whole days, kinds `leave`, `sick`, `other`; no hours, no half days. Read needs `scheduling.view`, edit `leave.edit`; Accounts has neither.
- **Board** (`week_rows` + `assignments`): which job row each worker is on each weekday. A worker can be on several jobs the same day.
- **Jobs**: id, name, quote number (e.g. JRQ…), stage. No separate job number.
- **Public holidays:** none anywhere in the app.
- **Time helpers** (`lib/time.js`): Sydney dates, `mondayOf`, `addDays`. Nothing for fortnights or a pay-period anchor.
- **Pay, timesheets, overtime, payroll:** nothing exists. "payroll" is only a Reports upload category.
- **Accounts area pattern** (M2): `routes/invoices.js` (defineRoutes, hand validation, `{error}`, audited writes in a transaction), `public/accounts.*` (`ac-` page classes, `hs-` components, `cc-dialog`), print to PDF through the browser (`invoice.*`, print block bracketed for the style check). Money in integer cents; issued documents frozen as snapshots; "Entered in MYOB" tick. No editable grid exists yet; the invoice line editor is the nearest pattern.
- **Keys:** 23 today. A new key touches `lib/permissions.js`, `ci/smoke.sh` (two key counts and the workshop preset), `docs/auth.md`, and the steps in `docs/how-to-add-feature-key.md`. `admin` gets every key automatically.
- **Next migration:** 019. Additive only.

## 2. Proposed shape (before Todd's answers)

- **Pay run** = one fortnight (Monday to the second Friday), anchored on a pay-period start date Todd gives. Status: open → finalised (frozen, like an issued invoice) → entered in MYOB (tick).
- **Timesheet** = one employee in one pay run: ten weekday rows with the paper's columns (Date, Day, Start, Finish, Lunch, P HOL, SICK, ARL, OFF SITE, JOB, Total daily hours, OT, DT), notes, and a "signed" tick.
- **Summary** = per employee per pay run, matching the paper's summary block; one printable page for the whole pay run (Save as PDF) to key into MYOB.
- **Hours** stored as integer minutes (no floating point), shown as hours and decimals as MYOB wants.
- New tables in migration 019 (pay runs, timesheets, timesheet days, public holidays if wanted); new router `routes/payruns.js`; new page `public/payruns.*` in the Accounts menu; a new key if wanted; smoke file `ci/smoke-m8-payruns.sh`.

## 3. Questions for Todd (asked one at a time)

1. **Who gets a timesheet.** Recommended: the board's workers, each with an "on the pay run" switch, plus the option to add an employee who isn't on the board (office staff) as a pay-only person.
2. **Access.** Recommended: a new key `payroll.edit` (view and edit pay runs) in the Accounts preset; admin has it automatically.
3. **Hours rules.** Do P HOL, SICK, ARL hold hours or ticks? Are OT and DT written on the paper (typed in) or worked out from a daily threshold? Recommended: type in what the paper says; Crosscuts works out the daily total (finish − start − lunch) and flags a mismatch with the written total.
4. **Pre-fill.** Recommended: pre-fill the JOB column from the board and mark board leave days (ARL or SICK) and public holidays as suggestions; whatever Accounts types from the paper wins.
5. **Public holidays.** Recommended: a short VIC list Accounts can edit on the pay-run page.
6. **The fortnight.** Which Monday starts the current pay period (the anchor), and when is pay day?
7. **MYOB summary.** Recommended: on-screen summary, printable page, finalise (freeze) and an "Entered in MYOB" tick. CSV later if wanted.
8. **Overtime log tab.** Recommended: folded into the timesheet's OT and DT columns; no separate log.
9. **History.** Recommended: start fresh; no import from the workbook.

## Decisions (Todd, 2026-10-12)

1. **Paper first, Accounts types it in.** Crosscuts prints the fortnightly timesheet for Accounts; staff fill it in by hand; Accounts types each sheet into a Crosscuts entry screen that mirrors it row for row. Staff never log in for this.
2. **Employees:** the board's workers, each with an "on the pay run" switch, plus pay-only people Accounts adds (e.g. office staff). Each printed sheet carries the employee's name and the fortnight's dates.
3. **Access: the existing Accounts keys, no new key.** `accounts.view` sees pay runs; `invoices.edit` enters and finalises them. (Key count stays 23.)
4. **Crosscuts works out OT and DT**, daily. Ordinary hours **Mon–Thu 8 h, Fri 6 h**; the first **2 h** past ordinary are OT, anything beyond is DT. All three numbers are settings, editable later.
5. **Pre-fill on the entry screen only:** the JOB column from the board, board leave and sick days, and public holidays, as suggestions; what Accounts types from the paper wins. Printed sheets stay blank apart from name and dates.
6. **Public holidays:** an editable VIC list kept by Accounts on the pay-run page, started with this year's and next year's Victorian public holidays (local days such as Bendigo Cup added by hand).
7. **Fortnight anchor: Monday 5 October 2026** (pay runs step 14 days from it: 5–16 Oct, 19–30 Oct, …).
8. **MYOB:** an on-screen and printable summary per fortnight (each employee's hours by category, with notes), **Finalise** freezes it, an **Entered in MYOB** tick, as invoices. An admin can reopen a finalised pay run.
9. **Overtime log: keep a printable blank template** (date, name, hours, job) that prints alongside the timesheets. Not typed in.
10. **History: start fresh.** No import from the workbook.
11. **Public holiday hours get their own line** on the summary (for MYOB's public holiday category); Normal Time is hours actually worked.
12. **OFF SITE is renamed ON SITE** and records **hours** on a job site (away from the factory). Totalled on the summary; it doesn't change pay.

### Lead's defaults (not asked; Todd can change any)

- **Summary lines per employee:** Normal Time, Over Time, Double Time, Public Holiday, Annual Leave (ARL), Personal Leave (SICK), plus On Site hours and the notes.
- **Daily maths:** worked = finish − start − lunch. Normal = worked up to that weekday's ordinary hours; OT = the next 2 h; DT = the rest. P HOL, SICK and ARL are typed (or pre-filled) hours and sit beside worked hours; a part day of work plus part leave is allowed.
- **Pre-filled leave or holiday** uses that weekday's ordinary hours (8 or 6).
- **Hours** stored as integer minutes; shown as decimal hours to two places, as MYOB takes them. Lunch typed as minutes or h:mm.
- **JOB column:** free text, suggested from the board (job name and quote number; several joined when the worker was on more than one job).
- **Workers' switch** defaults to on for every active board worker; archived workers are left out. The switch and the pay-only people live on the pay-run page (Accounts has no `workers.edit`).
- **Leave for pre-fill** is read by the pay-run API on the server, so Accounts needs no `scheduling.view`.
- **Settings** (ordinary hours, OT band, anchor) are edited by `invoices.edit` holders, audited, and apply to open pay runs only; a finalised pay run keeps the numbers it was finalised with.
- **No weekend rows,** as on the paper.
- **Every write audited** (`payrun.*`, `timesheet.*`, `holiday.*`).
