# M28 plan: Accounts and vehicles (0.2.7)

Part of `workflow-roadmap.md` (read it first). Needs M24 and M26 (invoice triggers, Dashboard tiles) and M27 (`maintenance.manage`, workshop layer).

## Todd's words (2026-10-26, in substance)

Accounts sends and follows up all invoices; keeps the list of supplier accounts and non-account invoices, presented for admin to pay; is responsible for vehicle registrations and insurances; and keeps the directors' loan balances accurate. The workshop manager is in charge of vehicle maintenance bookings.

## Todd's decisions

- Vehicles register holds **dates and bookings only** (no costs).
- **To pay:** Accounts prepares; **admin ticks paid**.
- Invoices get **Mark sent** and follow-up, with the follow-up interval **set per invoice** (client payment terms differ), defaulting from the client/job and then a setting.
- **Loans:** Accounts may see balances, record payments and interest, and tick each month checked against the statement; openings, rates, plans and deletes stay owner-only. This changes the M13 owner-only decision, approved by Todd 2026-10-26.

## What exists (do not rebuild)

Invoice engine (`lib/invoices.js`, 10/50/40, issue/paid/void/waive), Overdue accounts with last contacted and notes (migration 006), Friday round-up (`lib/roundup.js`), Supplier accounts and Admin accounts (`lib/suppliers.js`, `supplier_statements`, three months side by side, Left to pay), Loans (`lib/loans.js`, migration 037, key `loans.manage` owner-only). Crosscuts never sends email; sending stays outside it.

## Build

1. **Vehicles register (migration, additive).** `vehicles` (name, rego plate, make/model, rego expiry, insurance expiry, insurer and policy number, active) and `vehicle_bookings` (vehicle, kind service/repair/inspection/other, date, optional time, where, notes, done at/by). Page `/vehicles.html`: Accounts edits rego and insurance (`invoices.edit`; `accounts.view` sees); the workshop manager books and confirms bookings (`maintenance.manage`). Expiries show on the Planner (company layer) and bell Accounts 30 and 7 days before; bookings show on the workshop layer.
2. **To pay.** `supplier_statements.due_date` (nullable) and a new `payables` table for one-off, non-account invoices (payee, description, amount, due date, file, entered in MYOB, paid date/by, added by). Page **Accounts > To pay**: unpaid statement lines (supplier and admin) and open one-offs, ordered by due date, overdue in red, total at the foot. Accounts adds and edits (`invoices.edit`); **Paid** is ticked by `users.admin` holders only and writes back the statement's existing paid tick or the payable's paid date. A Dashboard line for admin: "To pay: N, $X, N overdue". A one-off can be converted into a supplier account.
3. **Invoice sent and follow-up.** `invoices.sent_date` with a Mark sent button (default today); `invoices.followup_days` (per invoice, nullable), defaulting from a per-client setting where one exists, else the setting `invoices.followup_days_default` (7). An `invoice_contacts` log (date, by, note); Contacted today writes the log and keeps `last_contacted_date` in step. An overdue invoice with no contact within its own interval is "needs follow-up"; the 7:00 weekday sweep bells `invoices.edit` holders with the count.
4. **Loans for Accounts.** New key `loans.maintain` (not owner-only; Todd grants it): view, payments, interest overrides, and a per-month "Statement checked" tick (`loan_months` checked at/by, additive). `loans.manage` keeps openings, rates, plans and deletes. A monthly accounts department task "Check loan balances against statements" (seeded or set up by Todd on Admin > Tasks).
5. **Waiting on you (accounts).** Dashboard tile: invoices to issue, issued not sent, needs follow-up, to-pay lines with no due date, rego/insurance due within 30 days, loan months not checked.

## Deliverables

Migration(s) after M27's, contract `m28-contracts.md`, how-tos (`how-to-invoice.md`, `how-to-suppliers.md`, new `how-to-vehicles.md`, `how-to-to-pay.md`, loans how-to), smoke `ci/smoke-m28-accounts-vehicles.sh`, version 0.2.7, STATUS.md. This is the largest milestone: if it runs long, ship the vehicles register first as its own release.

## Open for Todd

The vehicles to enter (two trucks and a van?); whether per-client payment terms should live on the client/job or only per invoice.
