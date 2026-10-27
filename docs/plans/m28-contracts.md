# Accounts and vehicles: contract (0.2.7, Todd 2026-10-26 and 2026-10-28)

Plan: `m28-plan.md` (part of `workflow-roadmap.md`). Builds on 0.2.6 (`m27-contracts.md`). Everything before still holds except where a section below changes it. CLAUDE.md applies: additive migration, `defineRoutes` with an access value, house style, board layout untouched. Crosscuts still never sends email: Mark sent records that Accounts sent the invoice outside Crosscuts.

Code: migrations `049_accounts_vehicles.sql` and `050_loan_check_task.sql`; `lib/vehicles.js`, `lib/payables.js`, `lib/followup.js`, `lib/accountsweep.js`, `routes/vehicles.js`, `routes/payables.js`, `routes/followup.js`; changes to `lib/permissions.js`, `lib/settings.js`, `lib/invoices.js` (`present`), `routes/invoices.js`, `lib/suppliers.js` (Paid), `lib/loans.js`, `routes/loans.js`, `lib/mywork.js`, `lib/planner/auto.js`, `lib/pages.js`, `routes/files.js`, `routes/users.js` (meta), `server.js`; pages `public/vehicles.html|js|css` (new), `public/payablesui.js` (new, on `suppliers.html`), `public/suppliers.js|css|html`, `public/accounts.js|css|html`, `public/loans.js|css`, `public/shell/shell.js`. Test: `ci/smoke-m28-accounts-vehicles.sh`; `ci/smoke.sh` (key counts, the admin preset) `ci/smoke-m13-owner.sh` (the admin preset also leaves out `adminExcludedKeys`) and `ci/smoke-m13-loans.sh` (both M13 suites revoke acct's loans.maintain while they test loans.manage alone) updated.

## 1. Vehicles register

Data (migration 049): `vehicles(id, name, rego, make_model, rego_expiry, insurance_expiry, insurer, policy_number, notes, active, created_at, updated_at, updated_by)`; `vehicle_bookings(id, vehicle_id, kind service|repair|inspection|other, date, time HH:MM|NULL, place, notes, done_at/by, cancelled_at/by, created_by/at, updated_at)`; `vehicle_bells(vehicle_id, what rego|insurance, threshold 30|7, expiry, belled_at)`. Dates and bookings only, no costs. The register **starts empty** (Todd 2026-10-28): Accounts adds the vehicles.

Routes:
- `GET /api/vehicles` (accounts.view or maintenance.manage; `?all=1` adds inactive) → `{today, vehicles, bookings, canEdit, canBook}`. A vehicle: `{id, name, rego, makeModel, regoExpiry, insuranceExpiry, insurer, policyNumber, notes, active, updatedAt, bookings (open), lastDone}`; an expiry is `{date, days, expired, soon (0 to 30 days)}` or null. `bookings` is every open booking by date.
- `GET /api/vehicles/:id` (same) → the vehicle with all its bookings.
- `POST /api/vehicles` (**invoices.edit**) → 201; name 1 to 100 characters; dates valid YYYY-MM-DD (400). Audited `vehicle.create`.
- `PATCH /api/vehicles/:id` (invoices.edit): any field, `active` true/false. Audited `vehicle.update`.
- `POST /api/vehicles/:id/bookings` (**maintenance.manage**) `{kind, date, time?, place?, notes?}` → 201; an inactive vehicle 409. Audited `vehicle_booking.create`.
- `PATCH /api/vehicle-bookings/:id`, `POST /api/vehicle-bookings/:id/done {done}` (already done / not done 409), `DELETE /api/vehicle-bookings/:id` (cancels; a done booking 409; 204) — all maintenance.manage. Audited `vehicle_booking.update|done|reopen|cancel` (entity the vehicle).
- Page **Accounts > Vehicles** and **Workshop > Vehicles** (`/vehicles.html`, accounts.view or maintenance.manage).
- **Planner:** each active vehicle's rego and insurance expiry on the **Company-wide** layer (source `vehicle_expiry`, "Rego due: <name> (<plate>)"); each booking (open or done) on the **Workshop** layer (source `vehicle_booking`, "Service: <name>"). Link `/vehicles.html` for holders of either key. No insurer, policy or notes on the Planner.
- **Bells:** the accounts sweep (section 3) bells invoices.edit holders (kind `vehicle.expiry`, link `/vehicles.html`) when an active vehicle's rego or insurance is 30 or fewer days away, and again at 7 or fewer; once per vehicle, kind, threshold and expiry date. A new expiry date bells afresh; an expired one doesn't.
- **Waiting on you:** the workshop manager (maintenance.manage) gets `vehicleBookings` (open bookings due today or before); Accounts gets `vehicleExpiry` (rego and insurance within 30 days or expired).

## 2. Individual invoices on Supplier accounts

Data: `payables(id, period YYYY-MM, payee, description, amount_cents NULL = missing, due_date, file_id, myob, paid_date, paid_by, supplier_id, removed_at/by, added_by, created_at, updated_at)`.

- The Supplier accounts page keeps its monthly layout (three months side by side, Left to pay, print one month). Below each month's supplier accounts, **Individual invoices**: payee (with what it is for and its file), due date, amount (Missing when not known), MYOB, Paid. Left to pay and the missing count include them; the month's print lists them after the supplier accounts. Admin accounts is unchanged.
- `GET /api/payables/months/:period` (accounts.view; a month outside the lists 404) → `{period, lines, counts: {listed, missing, paid}, totalCents, leftCents}`. `GET /api/payables/:id`.
- `POST /api/payables` (**invoices.edit**) `{payee, description?, amountCents?, dueDate?, period?, myob?}` → 201. Without `period`, the due date's month (if it is in range), else this month. `PATCH /api/payables/:id` (invoices.edit) any of those. `DELETE /api/payables/:id` (invoices.edit; a paid one 409) → 204. Audited `payable.create|update|remove`.
- `POST /api/payables/:id/paid {paid, paidDate?}` (**users.admin**; anyone else 403): default today, not in the future; already paid / not paid 409. Audited `payable.paid|unpaid`.
- **Paid on a supplier line is admin's too:** `PUT /api/suppliers/months/:period/:supplierId` that changes `paid` is 403 without users.admin (the rest of the line saves as before; Admin accounts unchanged). The page shows the Paid box disabled to others.
- `POST|DELETE /api/payables/:id/file` (invoices.edit; PDF, JPEG or PNG as statements); the file downloads from `/api/files/:id` with accounts.view.
- `POST /api/payables/:id/convert` (invoices.edit) → 201 `{payable, supplier}`: the payee becomes a supplier account listed from the invoice's month (name clash 409, as Add supplier); the invoice stays and is linked (`supplier`); a second convert 409.
- **Dashboard:** users.admin holders get the Waiting on you line `toPay`: "To pay this month: N, $X (M without a figure)" (unpaid individual invoices of this month plus this month's supplier lines not paid and not N/A; $X counts the figures known; the bracket only when M > 0; `noFigure` on the item), linking to this month's Supplier accounts. Accounts gets `payableNoDue` (unpaid individual invoices from last month on with no due date).

## 3. Invoice sent and follow-up

Data: `invoices.sent_date`, `invoices.followup_days` (1 to 365 or NULL); `invoice_contacts(id, invoice_id, date, note, by_user, created_at)`; `client_terms(client_key, client_name, followup_days, updated_by, updated_at)`, keyed by the job's client name matched loosely (Todd 2026-10-28): case, accents, punctuation and extra spaces ignored ("Smith Pty Ltd" = "smith pty. ltd"); one function (`clientKey`) for storing and looking up. Setting `invoices.followup_days_default` (7); `accounts.sweep_last_run`.

- The invoice object gains `sentDate`, `followUpDays` (stored), `followUpDaysEffective` (the invoice's, else the client's terms, else the default), `followUpDaysFrom` (`invoice` | `client` | `default`), `clientFollowUpDays` and `needsFollowUp`.
- `POST /api/invoices/:id/sent {date?}` (invoices.edit): issued or paid only (409); default today; not in the future or before the issue date (400). If the invoice has no interval yet, it is **pre-filled from the client's terms, else the default** (Todd 2026-10-28). `{sent: false}` clears the date. Audited `invoice.sent|unsent`.
- `PATCH /api/invoices/:id {followUpDays}` (any status; 1 to 365 or null) changes it per invoice.
- `POST /api/invoices/:id/contacts {date?, note?}` (invoices.edit; issued or paid) → 201 `{contacts, invoice}`: one log row (note 1000 characters at most); `last_contacted_date` becomes the latest contact date. `GET /api/invoices/:id/contacts` (accounts.view). Audited `invoice.contacted`. The overdue list's and the dialog's **Contacted today** use it.
- **Needs follow-up:** issued, past its due date, and its last contact (never contacted: the due date) at least its interval ago.
- `GET /api/followup` (accounts.view) → `{defaultDays, clients}`; `PUT /api/followup/default {days}` and `PUT /api/followup/clients {clientName, followUpDays | null}` (invoices.edit; null removes). Audited `settings.update`, `client_terms.update`.
- **The accounts sweep** (`lib/accountsweep.js`): once each weekday from 7:00 Sydney (not on the day it is first started; `ACCOUNTS_SWEEP_DISABLED=1` turns it off), the vehicle bells (section 1) and one bell to invoices.edit holders, "N invoices need follow-up" (kind `invoice.followup`, link `/accounts.html?view=overdue`), when any do. `POST /api/followup/sweep {today?}` (invoices.edit; never before today) runs it now → `{date, ran, vehicleBells, followUp, belled}`.
- Accounts page: the dialog shows Sent and Follow up every; **Mark sent** (date), the interval with **Save interval** and **Use for this client**, a contact note and the **Contact log**; the overdue list marks "Needs follow-up"; **Follow-up intervals** (the default and the client terms) above the overdue list. `/accounts.html?filter=due|unpaid` opens the table on that filter.

## 4. Loans for Accounts

- New key **loans.maintain**, the 39th, in the **accounts** preset (Todd 2026-10-28). Not owner-only, but left out of the admin preset (`ADMIN_EXCLUDED_KEYS` in `lib/permissions.js`; `GET /api/users/meta` lists `adminExcludedKeys`), so the admin preset stays 35 keys and the other admins don't start seeing the loans. Any admin may grant or revoke it per login on the Users page; the owner holds every key.
- loans.maintain **or** loans.manage: `GET /api/loans`, `GET /api/loans/:id`, `/interest`, `/statement`, `GET /plan` (preview), `PUT /api/loans/:id/months/:period` (interest override), `POST /api/loans/:id/repayments`, `PATCH .../repayments/:repId`, and the new `PUT /api/loans/:id/checked/:period {checked}` (a month from the opening month to this month, else 400; audited `loan.month_checked`). Pages `/loans.html`, `/loanprint.html`; the Accounts > Loans menu item shows for either key.
- loans.manage only (unchanged): creating, editing and archiving a loan, rates, the plan, deleting a payment.
- Data: `loan_months(loan_id, period, checked_at, checked_by)`. Each month of the loan object gains `checked: {at, by} | null`; the loan gains `uncheckedMonths` (months up to last month not ticked; 0 when archived). The loan page shows a **Statement checked** box on each month and hides owner-only actions from loans.maintain holders.
- Waiting on you: loans.maintain holders get `loanMonths` (unchecked months across live loans).
- Loan audit rows stay visible to loans.manage holders only (as M13).
- The monthly Accounts department task **"Check loan balances against statements"** is seeded once by migration 050 (additive; only if no rule of that title exists; a migration runs once, so a deleted rule is never re-made): monthly, first due on the 1st of the month after the upgrade, given to the Accounts department, editable on Admin > Tasks.

## 5. Waiting on you (accounts)

For invoices.edit holders (Accounts and admin), `GET /api/my-work` adds: `toIssue` (invoices due to issue), `notSent` (issued, not marked sent), `followUp` (needs follow-up), `payableNoDue`, `vehicleExpiry`. loans.maintain adds `loanMonths`; users.admin adds `toPay` (with `noFigure`); maintenance.manage adds `vehicleBookings`.

## 6. Access summary

| Route | Access |
|---|---|
| `GET /api/vehicles`, `GET /api/vehicles/:id` | accounts.view or maintenance.manage |
| `POST /api/vehicles`, `PATCH /api/vehicles/:id` | invoices.edit |
| `POST /api/vehicles/:id/bookings`, `/api/vehicle-bookings/*` | maintenance.manage |
| `GET /api/payables/*` | accounts.view |
| `POST/PATCH/DELETE /api/payables`, file, convert | invoices.edit |
| `POST /api/payables/:id/paid` | users.admin |
| `POST /api/invoices/:id/sent`, `POST /api/invoices/:id/contacts` | invoices.edit |
| `GET /api/invoices/:id/contacts`, `GET /api/followup` | accounts.view |
| `PUT /api/followup/default`, `PUT /api/followup/clients`, `POST /api/followup/sweep` | invoices.edit |
| loan reading, payments, interest, `PUT /api/loans/:id/checked/:period` | loans.manage or loans.maintain |
| `/vehicles.html` | accounts.view or maintenance.manage |
| `/loans.html`, `/loanprint.html` | loans.manage or loans.maintain |

## 7. Settled by Todd (2026-10-28)

1. **loans.maintain** goes in the **accounts** preset; admin's preset still leaves it out (35 keys).
2. **Client terms** match loosely: case, punctuation and extra spaces ignored.
3. **Follow-up:** as built. Never contacted counts from the due date.
4. **To pay this month** shows lines without a figure separately: "To pay this month: 8, $12,400 (2 without a figure)".
5. **Vehicle alerts:** as built (invoices.edit holders; weekdays at 7:00).
6. The monthly **loan check task** is seeded automatically, once (migration 050).
