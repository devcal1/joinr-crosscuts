# Crosscuts — Milestone 2 plan: Accounts (2026-10-10)

Status: **decisions recorded 2026-10-10 (§10); awaiting Todd's approval of the plan as amended.**

Source of truth: `crosscuts-brief.md` §5.1, §6.1, D9–D12. Todd changed D10 and D12 on 2026-10-10 (decision 7): **Crosscuts now issues the invoices**. Nothing is built until Todd approves. Steps: M2 · 1.1 (audit, §1), M2 · 1.2 (plan, §2–§9), M2 · 1.3 (decisions, §10).

**M2 scope:**
- invoice prompts from job events;
- **issuing the tax invoices** (numbered, printable to PDF);
- the invoice table with invoiced/paid tracking and the overdue list;
- the Friday 12:00 Sydney round-up;
- the in-app notification bell.

**Not in M2:**
- Phone push (decision 1–2): it waits for the phone companion app.
- The task queue and the report library: these go to M4 (decision 6).
- Any MYOB link. Accounts re-key issued invoices into MYOB (decision 8).

## 1. Audit findings (M2 · 1.1)

Two read-only surveys of the code, 2026-10-10.

**What already exists:**
- `jobs.value_cents` (integer cents). It is editable with `jobs.edit` + `jobs.value` (admin, Design/PM), and Accounts can see it but not edit it.
- `jobs.materials_ordered_date` and `jobs.completed_date` (Sydney dates). Today the materials date is just a plain date field on the job page.
- The `invoiced` job stage already exists in the stage list. Nothing sets it yet.
- The feature keys `accounts.view` (admin, accounts), `invoices.edit` (admin, accounts) and `orders.mark_ordered` (admin only). They gate nothing beyond the placeholder `accounts.html`.
- Stage hooks in `lib/jobstage.js`:
  - `onScheduled` runs when a job goes onto the board (backlog place, new row, duplicate row).
  - `onFinishedComplete` runs on Finish week → Complete, inside the Finish-week transaction.
- The audit API `audit.log(req, {...})` is synchronous and safe inside transactions. For background work it is called with `actorLabel: "system"`.
- Sydney date helpers (`sydneyToday`, `sydneyMonday`, ...).
- Node 24's built-in `fetch` with `AbortSignal.timeout`, so ntfy needs no new package.
- The CI logged-out sweep covers new routes automatically.

**What doesn't exist:**
- No tables or code for invoices, payments, notifications, orders or tasks.
- No "first scheduled" marker. `onScheduled` also fires for return visits (a `complete` job placed back on the board), so it isn't "first" by itself.
- No "materials ordered" event. That is M3 Orders; M2 needs a stand-in (Q3).
- No background timer of any kind in the server, and no Sydney time-of-day or weekday helper.
- No settings store: the only secret is a file in `/data/config` (the Gemini key).
- No notification bell: the shell removed it "until notifications exist", and the dashboard "Notifications" tile is a static placeholder.

**Traps found:**
- `jobstage.js` wraps hooks in `safely()`, which swallows errors. Inside a transaction, a failing hook can leave half its writes behind. Invoice hooks must run in their own savepoint, so a failure rolls back only the hook and never blocks the board.
- `POST /api/rows` (add a row to the board) runs its insert and `onScheduled` outside a transaction. It gets wrapped.
- `ci/smoke.sh` asserts exactly 21 feature keys, and `docs/auth.md` lists them. Both change if a key is added. This plan adds none.
- A hand-set `complete` on the job page (admin only) doesn't set `completed_date` and doesn't run `onFinishedComplete`. M2 treats it like Finish week.


## 2. How it works, in one paragraph

Each job gets up to four kinds of invoice: **deposit**, **progress**, **final**, and any number of **extras**. An invoice appears, marked **due**, when its event happens:
- the job's first placement on the board makes the deposit due;
- Todd's "Materials ordered" makes the progress invoice due;
- Finish week → Complete makes the final, plus any extras, due.

Each due invoice puts a notification in the bell of everyone with `invoices.edit` (Todd, Chloe, Tracy, Jill).

An accounts user opens the due invoice. It comes pre-filled with one standard line, the client and the amount. They check or edit it, then **Issue** it. Issuing gives it the next number in the new series, locks it, and opens the printable tax invoice, which they save as a PDF and email to the client from their own mail (Crosscuts sends no email, D9). They then enter it into MYOB and tick "Entered in MYOB".

When the money lands they mark it **Paid**. An issued invoice not paid within its due date (10 days by default, set per invoice) is **overdue**.

Every Friday at 12:00 Sydney a round-up lists everything due but not issued, plus anything overdue, and it repeats each week until the list is clear. When the final invoice is issued, the job moves to the `invoiced` stage.

## 3. Data (migration `006_accounts.sql`, additive only)

Money is integer cents, **GST-inclusive** (decision 10). Business dates are Sydney `YYYY-MM-DD`; timestamps are UTC ISO (the M1 contract).

**`invoices`**, one row per invoice:
- `id`, `job_id` (FK jobs), `kind` (`deposit` / `progress` / `final` / `extra`).
- `status`:
  - `pending`: extras only, before completion;
  - `due`: an editable draft;
  - `issued`: numbered and locked;
  - `paid`;
  - `waived`: not needed;
  - `void`: issued, then cancelled.
  - For deposit, progress and final, "not due" means there is no row yet.
- `number`: unique; null until issued (§5).
- `issue_date`, `due_date` (issue date + 10 days by default, editable before issue), `paid_date`.
- `became_due_date`, `due_reason`: `scheduled` / `materials_ordered` / `completed` / `manual`.
- `total_cents`: the sum of its lines. `gst_cents` is stored at issue: the total ÷ 11, rounded to the cent.
- Client snapshot at issue: `bill_to_name`, `bill_to_address`, `bill_to_abn` (optional; Q-A), and `site_address`. Later edits to the job don't change an issued invoice.
- `myob_entered_date`: accounts tick it once the invoice is keyed into MYOB, so nothing is missed (decision 8).
- `external_id`: the MYOB slot (D12), kept for later.
- `notes`, `last_contacted_date`, `follow_up_notes`: for Jill's overdue work.
- `void_reason`, `replaced_by_id`: a voided invoice points to its replacement.
- `created_at`, `updated_at`.
- At most one live (not `void`) deposit, progress and final per job.

**`invoice_lines`:** `id`, `invoice_id`, `sort_order`, `description`, `amount_cents` (GST-inclusive). Lines are editable while the invoice is `due` and frozen once it is issued.

**`invoice_number_seq`:** a single-row counter, so each number is used once, in order, inside the issue transaction. The series prefix and start number are set once by Todd (decision 9).

**`notifications`:** `id`, `user_id`, `kind`, `title`, `body`, `link`, `entity_type`, `entity_id`, `created_at`, `read_at`. Each recipient gets their own row.

**`app_settings`:** key/value, edited by admin:
- **Business details** for the invoice: trading name, legal name, ABN, address, phone, email, bank account name, BSB and account number, payment terms text, and logo (the existing `logo.png`).
- The number prefix and start number.
- `roundup.last_run`.
- Todd enters these himself on the settings panel. Nothing is entered by Claude.

## 4. Amounts and GST

- **Suggested split** from `jobs.value_cents` (GST-inclusive): deposit 10%, progress 50%, final = value − deposit − progress, so the three always add up to the value exactly.
- The pre-filled line (decision 11) is, for example, "Deposit (10%): Smith kitchen, 12 Rose St, $4,500.00". It is editable, and lines can be added before issue. Extras start with the description typed when the extra was entered.
- GST shown on each invoice: total ÷ 11 ("Total includes GST of $409.09"). Rounded per invoice; amounts are never shown ex-GST.
- A job with no value gives an empty line to fill in by hand.
- **Partial payments are out of scope.** "Paid" means paid in full, and anything odd goes in the notes. Say if this is wrong.

## 5. Issuing, numbering, corrections

- **Issue** (`invoices.edit`), in one transaction:
  - takes the next number;
  - snapshots the client details and lines;
  - stores the GST;
  - sets `issue_date` (today) and `due_date`;
  - sets the status to `issued`;
  - audits `invoice.issue`.
  - Issuing the final also sets the job stage to `invoiced`.
- **Number format:** a new series (decision 9), proposed as `CC-0001`, `CC-0002`, ... The prefix and start number are fixed in the settings panel before the first invoice is issued, and locked after it.
- **Corrections:** an issued invoice is never edited. To correct one, **Void** it (a reason is required; audited). That creates a new `due` copy with the same lines for editing, and the new copy gets a new number when it is issued. The void stays in the record and its number is never reused.
  - Accounts must also void it in MYOB, and the dialog says so.
  - Formal credit notes (for an invoice already paid) are deferred unless Todd wants them in M2.
- **Waive** (a due invoice that isn't needed, e.g. a warranty visit) needs a note and is audited.

## 6. The tax invoice document

- `/invoice.html?id=…` shows the invoice as a document page. **On screen** it uses the house-style frame. **When printed** it is a clean black-on-white A4 page, following the TH Cabinets Brand & Document Style Guide v1.0.
- Staff use the browser's **Print → Save as PDF**, which needs no PDF library and no build step (brief §7).
  - The page has a "Save as PDF" button that opens print and sets a sensible filename (e.g. `CC-0012 Smith kitchen.pdf`).
  - A server-side PDF can come later if the browser output isn't good enough.
- **Contents**, built to the ATO's tax-invoice requirements (to be checked by Tracy, Q-B):
  - the words "Tax invoice";
  - the business name and ABN;
  - the issue date and invoice number;
  - the client's name and address. The ATO wants the buyer identified on invoices of $1,000 or more, and nearly all of these are.
  - the site address;
  - each line's description and amount;
  - the total, and "Total includes GST of $X";
  - the due date;
  - bank details and payment terms;
  - and for a deposit, progress or final invoice, a small summary: contract price, invoiced to date, and this invoice.
- A due (draft) invoice can be previewed, but it prints a large "DRAFT – not a tax invoice" mark and no number.
- Void invoices print "VOID".

## 7. Triggers

All triggers run inside the existing transactions, in their own savepoint (so a failure never blocks the board), and are audited (`invoice.due`, actor = the person whose action caused it).

| Event | Code point | Creates | Notes |
|---|---|---|---|
| Job placed on the board | `onScheduled` (backlog place, add row, duplicate row) | deposit `due`, if the job has **no deposit at all and no earlier week rows** | Return visits, re-placements and pre-go-live jobs don't fire it (decision 5) |
| Todd's **Materials ordered** | new button on the job page, `orders.mark_ordered` | progress `due`; sets `materials_ordered_date` | M3 Orders will call the same function (decision 3) |
| Finish week → Complete | `onFinishedComplete` | final `due`; pending extras → `due` | Only for jobs that already have an invoice (decision 5). Also fires on an admin hand-set `complete`. |
| Final issued | invoices route | job stage → `invoiced` | Through `setStage`, audited as `job.stage` |
| By hand | invoice table "New invoice" | any kind, `due_reason = manual` | For jobs that predate tracking, and odd cases |

The other audit actions are `invoice.update` (lines, dates and notes while due), `invoice.issue`, `invoice.paid`, `invoice.void`, `invoice.waive`, `invoice.myob` and `invoice.create`, each with before and after values. Settings changes are audited as `settings.update`.

## 8. Pages

**`/accounts.html` becomes the invoice table** (gated by `accounts.view`). The brief says it must be fast with no navigation:
- One row per job that has any invoice ("Show all jobs" lists the rest). The columns are Job · Client · Value · Deposit · Progress · Final · Extras.
- Each cell shows *not due* / **due** (orange) / *issued* (number, date) / *paid* (date) / *waived*, with the amount.
- **Overdue** cells are red, red's one approved use. A small mark shows issued invoices not yet entered in MYOB.
- Clicking a due cell opens the invoice editor (lines, client, due date, **Preview**, **Issue**). Clicking an issued cell opens the document with **Paid** (date = today), **Entered in MYOB**, **Void** and notes.
- Filters: Due, Unpaid, Overdue, Not in MYOB, This month, and Client (search). The totals row shows outstanding and overdue.
- An **Overdue** view (Jill's list): number, client and phone, days overdue, last contacted, follow-up notes, and a "Contacted today" button.
- Built from the house-style components (`hs-table`, `hs-badge`, `hs-btn`, `cc-dialog`), modelled on `audit.html` and `jobs.html`. It must pass `ci/style-check.js`.

**Job page:**
- An **Invoices** section for `accounts.view` holders: the job's invoices, read-only, with links.
- A **Materials ordered** button for `orders.mark_ordered` (Todd), replacing the plain date field.

**Settings (admin):** a **Business details and invoicing** panel on the users page (`users.admin`): business details, bank details, the number prefix and start number (locked after the first issue), and a **Run round-up now** button.

**Bell and dashboard:**
- The bell comes back in the shell's top bar with an unread count. It polls every 60 s and offers "Mark read" and "Mark all read". It is hidden on the board.
- The dashboard's Notifications tile goes live (the latest five).
- The Accounts tile shows "N due · N overdue".

**Feature keys:** none added. Seeing needs `accounts.view`; drafting, issuing, marking paid, voiding and waiving need `invoices.edit`; Materials ordered needs `orders.mark_ordered`; settings need `users.admin`. The CI count of 21 stays. In `docs/auth.md` these keys change from "gates a shell page only" to live.

## 9. Round-up, build, tests, release

**Friday round-up (in-app only):**
- An in-process timer checks once a minute. The first time it is Friday at or after 12:00 Sydney and `roundup.last_run` isn't this Friday, it runs.
- If the app was down at noon, it runs as soon as it is back, any time before the next Friday.
- Content: the count and total due but not issued, the count and total overdue, the count not yet entered in MYOB, and the oldest few by name.
- It goes as a notification to each `invoices.edit` user. An empty list sends nothing.
- Sydney time-of-day and weekday helpers are added to `lib/time.js` with `Intl`, so daylight saving is handled.

**Waves** (fixed at M2 · 2.1 in `m2-contracts.md`; likely shape):
- **2.2 Scaffold (me):** migration 006, `lib/invoices.js` and `lib/notify.js` stubs with agreed signatures, and the Sydney time helpers.
- **3.1 Wave 1, in parallel:**
  - **A, invoices backend:** `lib/invoices.js`, `routes/invoices.js` (draft, issue, number, void, paid, waive), the hooks in `jobstage.js` / `schedule.js` / `jobs.js`, and wrapping `POST /api/rows` in a transaction.
  - **B, notifications and settings backend:** `lib/notify.js`, `routes/notifications.js`, the round-up timer, and `routes/settings.js`.
- **3.2 Wave 2, in parallel:**
  - **C:** `accounts.*`, the invoice editor, the job-page section and button.
  - **D:** `invoice.html`, the document and its print styles.
  - **E:** the shell bell, the dashboard tiles and the settings panel.

**Smoke additions (CI is the real check):**
- acct gets 200 and sched / dpm / show get 403 on the invoice and settings routes.
- Place a backlog job → a deposit is due, with a bell notification for acct and admin. Place it again → no second deposit. Finish week Complete → the final is due. Materials ordered (admin 200, dpm 403) → the progress invoice is due. A job with earlier week rows → no deposit.
- **Numbers:**
  - Issuing two invoices gives consecutive numbers.
  - Issuing an already issued invoice fails.
  - Editing an issued invoice fails.
  - Void → a new due copy exists, and the voided number is never reused.
  - The prefix is locked after the first issue.
- The split adds up to the value exactly for an awkward value (e.g. $10,000.01), and the GST is the total ÷ 11 rounded.
- Issuing the final → the stage becomes `invoiced`. Then paid, the MYOB tick, waive, and audit rows for each.
- `/invoice.html` is 403 for sched and 200 for acct.
- Round-up now → notifications exist. A restart doesn't re-run the same Friday.

**Release:** release is deferred (Todd, 2026-10-10). M2 is built and committed locally. When Todd chooses to release, everything since 0.1.3 goes out in one version.

**Before the first real invoice** (the on-device check, M2 · 6.1):
- Todd fills in the business and bank details and the start number.
- Tracy checks a printed sample against what the ATO and MYOB need (Q-B).

## 10. Decisions from Todd (2026-10-10)

1. **No phone push in M2.** Todd will use a companion app on his phone over Tailscale, and would rather not install an extra app (ntfy). M2 ships the in-app bell and round-up only. Phone alerts are added once the companion app exists (no ntfy, no `push_outbox`).
2. *(Superseded by 1: push wording.)*
3. **Materials ordered: Todd's own button now** on the job page (`orders.mark_ordered`). It sets `materials_ordered_date` and makes the progress invoice due. M3 Orders later drives the same function.
4. **Due date: 10 days is standard, set per invoice** in Crosscuts (pre-filled as issue date + 10 days and editable before issue). There is no Joinr due date. This replaces the earlier reading of "set in Joinr".
5. **Jobs that predate tracking get no automatic invoices.** Accounts create those by hand with "New invoice". Mechanism:
   - The migration creates no invoice rows.
   - The deposit hook fires only for jobs with no deposit and no week rows before the current one.
   - The final hook fires only for jobs that already have an invoice.
   - The same rules apply at cutover.
6. **Report library: M4**, with the task queue and file attachments.
7. **Crosscuts issues the invoices** (numbered tax invoices, printed or saved as PDF). This changes brief D10 ("MYOB stays the book of record") and D12, and the brief is annotated.
8. **MYOB: accounts re-key each issued invoice into MYOB by hand for now**, so the books, BAS and reconciliation are unchanged. Crosscuts tracks "Entered in MYOB". A CSV export for MYOB import may come later.
9. **Numbering: a new series**, proposed `CC-0001` upwards. Todd sets the prefix and start number before the first issue.
10. **Job value is GST-inclusive.** The 10/50/40 split is of the inclusive price, and each invoice shows its GST as the total ÷ 11.
11. **Invoice lines: one standard pre-filled line, editable**, with extra lines allowed before issue.

**Still open (small; defaults stand unless Todd says otherwise):**
- **Q-A:** should the client's ABN be on the job and the invoice (business clients)? Default: an optional field.
- **Q-B:** Tracy checks the sample invoice before first use.
- **Q-C:** credit notes for paid invoices: deferred.
- **Q-D:** partial payments: out of scope ("paid" means in full).
