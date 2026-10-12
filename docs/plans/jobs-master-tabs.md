# The jobs master spreadsheet: who owns each tab

Crosscuts largely replaces the TH Cabinets jobs master workbook (`thc_jobs_master.xlsx`, kept on Todd's desktop, not in this repo). Todd and Claude went through its 30 tabs on 2026-10-12 and decided which department owns each one, or that it is redundant.

This repo is public. No figures, codes, names or balances from the workbook are copied here; this file records only what each tab is for and the decision.

## Decisions (Todd, 2026-10-12)

| # | Tab | What it is | Owner | Notes |
|---|---|---|---|---|
| 1 | Main | Front page of buttons to the other tabs | **Redundant** | The menu bar and dashboard replace it. |
| 2 | Timesheet | Weekly employee timesheet: start, finish, lunch, hours, public holiday, sick, annual leave, job, overtime, double time | **Accounts** | Superseded by the newer **Fortnightly Timesheet** (see below). Timesheets are printed and filled in by hand, then Accounts types them in. Needs tables for **fortnightly pay runs** and easy summaries for entering a pay run into **MYOB**. |
| 3 | Timetable-Todd | Todd's weekly hour-by-hour timetable | **Redundant** | The Planner (Personal layer, repeating events). |
| 4 | Timetable-Admin | The admin role's weekly timetable | **Redundant** | The Planner. |
| 5 | Loan Balances | Loan repayments, interest and balances | **Accounts** | Sensitive: needs its own key, not given to every Accounts login by default (to settle at planning). |
| 6 | Overtime | Overtime log: date, name, hours, job | **Accounts** | A template printed and filled in by hand when needed; part of the pay-run data entry. |
| 7 | Drawers-EDGE | Finista EDGE drawer order: counts by size per job, and stock | **Ordering** | Merged with Drawers-DTC into one drawer order. Filled in automatically from Orders, overseen by Ordering, handed to the Workshop Manager for incoming deliveries. |
| 8 | Drawers-DTC | The same for DTC DragonPro drawers | **Ordering** | Merged with Drawers-EDGE (above). |
| 9 | Calc-Batons | Batten spacing calculator | **Design/PM** | A small design tool. |
| 10 | Bonuses | Per-job bonus: quoted against actual hours, checks, shares per person | **Admin (owner only)** | Behind a key only Todd holds. |
| 11 | Project-LP | A multi-unit builder project tracker | **Redundant** | |
| 12 | Running Costs | Business overheads | **Redundant** | In the Joinr quoting app now. |
| 13 | Material Costs | Labour rates and supplier prices | **Redundant** | Joinr. |
| 14 | 2pac Calc | 2pac panel area calculator | **Redundant** | Joinr. |
| 15 | Bathroom | Bathroom renovation phase plan with trades | **Redundant** | |
| 16 | Board Stocktake | Board stock count and monthly stock value | **Workshop Manager** | (Recorded as "Scheduling: workshop" in the question; Todd then confirmed the Workshop Manager is a separate role from the Scheduler.) Accounts sees the monthly value. |
| 17 | Petty Cash Log | Petty cash in, out and reason | **Redundant** | |
| 18 | Quick Quote | Quick benchtop quote | **Redundant** | Joinr. |
| 19 | Stone Order | Stone benchtop order confirmation form | **Design/PM** | Needs the design's edge and profile details. |
| 20 | Alarms | Staff alarm codes and the alarm company account | **Admin (owner only)** | Sensitive: see the open points. |
| 21 | Payroll | Daily pay calculation | **Accounts** | Folded into the fortnightly pay-run tables (with Timesheet). |
| 22 | Benchtop Letterhead | Printed benchtop drawing sheet with the edge key | **Design/PM** | A printable sheet attached to the job. |
| 23 | Project | Renovation project template with trades | **Redundant** | |
| 24 | Timber Calc | Timber benchtop pricing grid | **Redundant** | Joinr. |
| 25 | BAS-Sales | Monthly sales totals for the BAS | **Accounts** | Built from Crosscuts invoices, no typing in. |
| 26 | Stock | Monthly hardware stock order (code, item, have, order) | **Ordering** | The Workshop Manager fills in "have"; Ordering places the order. The invoice check on the side of the sheet is dropped. |
| 27 | Waste | Bin pickup log | **Redundant** | |
| 28 | Paint Order | Paint order form | **Ordering** | |
| 29 | report | Supplier statements checklist | **Accounts** | Renamed **"Supplier Accounts"**. |
| 30 | Schedule | The old two-week manufacturing and installing schedule | **Redundant** | The Board. |

## By department

- **Accounts:** Timesheet and Overtime (fortnightly pay runs, MYOB summaries), Payroll (in the pay run), Loan Balances, BAS-Sales, Supplier Accounts.
- **Ordering (a new department, its own menu and role):** one drawer order (EDGE and DTC), the Stock order, the Paint order. Orders moved here from Design/PM in the menu reorganisation (Todd, 2026-10-12; menu rule orange).
- **Design/PM:** Stone Order, Benchtop Letterhead, Calc-Batons.
- **Workshop Manager (a new role, separate from Scheduling):** Board Stocktake; receives incoming orders.
- **Admin (owner only):** Bonuses, Alarms.
- **Redundant (14):** Main, Timetable-Todd, Timetable-Admin, Project-LP, Running Costs, Material Costs, 2pac Calc, Bathroom, Petty Cash Log, Quick Quote, Project, Timber Calc, Waste, Schedule. (Running Costs, Material Costs, 2pac Calc, Quick Quote and Timber Calc are now in Joinr; the board and Planner replace the schedule and timetables.)

## The fortnightly timesheet (Todd's current form, received 2026-10-12)

The paper form staff fill in by hand. One sheet per employee per fortnight:

- Header: Employee, From, To.
- Ten day rows: Monday to Friday, two weeks (no weekend rows).
- Columns: Date, Day, Start Time, Finish Time, Lunch, P HOL (public holiday), SICK, ARL (annual leave), OFF SITE, JOB, Total Daily Hours, OT (overtime), DT (double time).
- A TOTALS row, then NOTES and SIGNATURE.
- A summary block: Normal Time, Over Time, Double Time, Annual Leave, Personal Leave (the SICK column totals as Personal Leave).

Changes from the old weekly tab: a fortnight instead of a Friday-to-Thursday week, OFF SITE added, the separate Hours column dropped, and the leave totals named as MYOB's categories. The Crosscuts entry screen should mirror this form row for row, so Accounts can type straight from the paper, and its pay-run summary should match the summary block (per employee, per fortnight) for entry into MYOB.

## Who does what

- **Workshop Manager and Scheduler are two different roles**, held by two different people today. Today's `workshop` role is the workshop TV and workshop logins (board and Planner only); the Workshop Manager needs a new role.

## Open points for the planning step

1. **The newer timesheet:** received (see "The fortnightly timesheet" above); it shapes the pay-run tables.
2. **Ordering department:** the menu is settled (after Design/PM, holding Orders, orange rule; in 0.1.10). Still to settle: the Ordering role and its keys.
3. **Workshop Manager role:** its keys (board, incoming orders, stocktake, Planner?) and its menu.
4. **Alarm codes:** storing security codes in a web app, and so in its backups and NAS copies, is a risk. A safer option is to record only who holds a code, and to keep the codes themselves in a password manager or the alarm company's portal. To confirm with Todd.
5. **Loan Balances and Bonuses:** the keys for these (a key only Todd holds by default).
6. **Data:** whether any history is imported from the workbook (e.g. the BAS monthly sales since 2023, the board stock list), or Crosscuts starts fresh.
