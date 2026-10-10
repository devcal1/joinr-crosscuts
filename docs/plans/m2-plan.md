# Crosscuts — Milestone 2 plan: Accounts (draft for approval, 2026-10-10)

Source of truth: `crosscuts-brief.md` §5.1, §6.1, D9–D12. Nothing is built until Todd approves. Steps: M2 · 1.1 (audit, §1) and M2 · 1.2 (plan, §2–§8, questions in §9).

**M2 scope (roadmap):** the invoice table (deposit / progress / final / extras), invoice prompts from job events, the Friday 12:00 Sydney round-up, ntfy push to Todd, and the overdue list. The task queue moves to M4 (Collaboration), with the rest of tasks and comments. The report library is Q7.

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

Each job gets up to four kinds of invoice: **deposit**, **progress**, **final**, and any number of **extras**. An invoice row appears, marked **due**, when its event happens:
- the job's first placement on the board makes the deposit due;
- Todd's "Materials ordered" makes the progress invoice due;
- Finish week → Complete makes the final, plus any extras, due.

Each due invoice sends a notification to everyone with `invoices.edit` (Todd, Chloe, Tracy, Jill) and an ntfy push to Todd's phone. Accounts staff mark it **Invoiced** (reference and date) and then **Paid** (date). An invoice not paid by its payment due date is **overdue**. Every Friday at 12:00 Sydney a round-up lists everything due but not invoiced, plus anything overdue, and it repeats each week until the list is clear. When the final invoice is marked invoiced, the job moves to the `invoiced` stage.

## 3. Data (migration `006_accounts.sql`, additive only)

Money is in integer cents. Business dates are Sydney `YYYY-MM-DD`; timestamps are UTC ISO (the M1 contract).

**`invoices`**, one row per invoice:
- `id`, `job_id` (FK jobs), `kind` (`deposit` / `progress` / `final` / `extra`), and `description` (required for extras).
- `status`: `pending` (extras only, before completion) / `due` / `invoiced` / `paid` / `waived`. For deposit, progress and final, "not due" means there is no row yet.
- `amount_cents`: null until set. While it is null, the table shows the suggested amount from the job value (§4).
- `due_date`: the day it became due. `due_reason`: `scheduled` / `materials_ordered` / `completed` / `manual`.
- `invoice_ref`, `invoiced_date`, `payment_due_date` (from the terms, Q4, and editable), `paid_date`.
- `external_id`: the MYOB slot (D12). Stored, never called.
- `notes`, `last_contacted_date`, `follow_up_notes`: for Jill's overdue work.
- `created_at`, `updated_at`, `archived` (soft delete, brief §8.5).
- At most one deposit, one progress and one final per job (a unique index that excludes extras and archived rows).

**`notifications`:** `id`, `user_id`, `kind`, `title`, `body`, `link`, `entity_type`, `entity_id`, `created_at`, `read_at`. Each recipient gets their own row, so "mark read" is per person.

**`push_outbox`:** `id`, `title`, `body`, `link`, `created_at`, `attempts`, `last_attempt_at`, `last_error`, `sent_at`. Every push is written here first and sent by the background sender, so an ntfy failure never blocks a request. Anything still unsent is visible in-app (§6).

**`app_meta`:** key/value, for example `roundup.last_run` = the Friday's date, so a restart never repeats it and a missed one is caught up.

Extras: any number of `extra` rows, entered by hand. Before completion an extra is `pending`. It becomes due with the final, or straight away if the job is already complete.

## 4. Amounts

- **Suggested split** from `jobs.value_cents`: deposit 10%, progress 50%, final = value − deposit − progress, so the three always add up to the value exactly (rounded to the cent).
- **Editable per invoice** (`invoices.edit`). Once someone sets `amount_cents`, it stops following the job value. Marking an invoice **Invoiced** freezes the amount shown at that moment into `amount_cents`, so later value changes can't rewrite history.
- If a job has no value, the cells show "no value". Accounts can still type an amount.
- Amounts are taken exactly as the job value is entered. Crosscuts does no GST maths; MYOB stays the book of record (D10).

## 5. Triggers

All triggers run inside the existing transactions, in their own savepoint, and are audited (`invoice.due`, actor = the person whose action caused it).

| Event | Code point | Creates | Notes |
|---|---|---|---|
| Job placed on the board | `onScheduled` (backlog place, add row, duplicate row) | deposit `due`, if the job has **no deposit row at all** | "No deposit row" is the "first scheduled" marker, so return visits and re-placements don't fire it again |
| Todd's **Materials ordered** | new action on the job page, `orders.mark_ordered` (Q3) | progress `due`; sets `materials_ordered_date` | M3 Orders will call the same function when every order line reaches *ordered* |
| Finish week → Complete | `onFinishedComplete` | final `due`; pending extras → `due` | Also fires on an admin hand-set `complete` |
| Final marked Invoiced | invoices route | job stage → `invoiced` | Through `setStage`, so it is audited as `job.stage` |
| By hand | invoice table "Add" | any kind, `due_reason = manual` | For jobs that predate tracking (Q5) and odd cases |

Marks are audited as `invoice.invoiced`, `invoice.paid`, `invoice.waived`, `invoice.update` (amount, dates, notes) and `invoice.create` (extras or manual), each with before and after values.

**Waived:** an accounts user can mark any due invoice "not needed" (a cash job, a warranty visit, a deposit taken outside Crosscuts). Waiving needs a note, is audited, and clears the invoice from the round-up.

## 6. Notifications and push

**In-app (the start of brief §6.1; M4 widens it to tasks and messages):**
- A **bell** comes back in the shell's top bar, with an unread count. It polls every 60 s and opens a list with "Mark read" and "Mark all read".
- The bell is hidden on the board page. The TV doesn't need it, and the board's layout is frozen.
- The dashboard's "Notifications" placeholder tile becomes the latest five, with a link.
- Invoice prompts go to every active user holding `invoices.edit`.

**ntfy push to Todd** (Q1, Q2):
- Todd's notifications (anything addressed to a user flagged "push to my phone"; only Todd for now) are also queued in `push_outbox`.
- A background sender wakes every 30 s and POSTs each one to the ntfy topic, with a 10 s timeout. On failure it retries with growing gaps (1, 5, 15, 60 min, then hourly), for up to 24 h.
- The topic, server and optional access token live in `/data/config/ntfy.json`, set from an admin **Push settings** panel (on the users page, `users.admin`) with a **Send test** button.
- No file means push is off. Nothing breaks, and the panel says "Push not set up".
- Unsent or failed pushes show in that panel. An orange notice also appears in Todd's bell list when a push has failed for over an hour.
- Push text: see Q2. Every push links to `http://<Tailscale address>:4933/accounts.html`, so it opens over Tailscale from the phone. The address is set in the same panel.

**Friday round-up:**
- An in-process timer checks once a minute. The first time it finds it is Friday at or after 12:00 Sydney and `roundup.last_run` isn't this Friday, it runs.
- If the app was down at noon, it runs as soon as it's back, any time before the next Friday.
- Content: the count and total of due-but-not-invoiced invoices, the count and total overdue, and the oldest few by name. It goes as a notification to each `invoices.edit` user plus one push to Todd. An empty list sends nothing.
- An admin **Run round-up now** button (also used by CI) runs it on demand, without changing `last_run`.
- Sydney time-of-day and weekday helpers are added to `lib/time.js` with `Intl`, so daylight saving is handled.

## 7. Pages

**`/accounts.html` becomes the invoice table** (gated by `accounts.view`). The brief says it must be fast with no navigation, so the table is the department page itself:
- One row per job that has any invoice (or a value, with "Show all jobs"). The columns are Job · Client · Value · Deposit · Progress · Final · Extras.
- Each cell shows *not due* / **due** (orange) / *invoiced* (ref, date) / *paid* (date) / *waived*, plus the amount.
- **Overdue** cells are red. That is red's one approved use (CLAUDE.md "Look and feel").
- Clicking a cell opens a small dialog with **Invoiced** (ref, date = today, editable amount) or **Paid** (date = today), plus amount, notes and waive.
- Filters: Due, Unpaid, Overdue, This month, Client (search). The totals row shows outstanding and overdue.
- An **Overdue** view (a filter preset, Jill's list): the invoice, client phone, days overdue, last contacted, follow-up notes, and a "Contacted today" button.
- The page is built from the house-style components (`hs-table`, `hs-badge`, `hs-btn`, `cc-dialog`), modelled on `audit.html` and `jobs.html`. It must pass `ci/style-check.js`.

**Job page:**
- An **Invoices** section, shown to `accounts.view` holders, lists the job's invoices read-only, with a link to the table.
- A **Materials ordered** button for `orders.mark_ordered` (Todd). It replaces the plain date field, which shows the date once it is set.

**Dashboard:** the Accounts tile shows "N due · N overdue" for `accounts.view` holders. The Notifications tile goes live.

**Feature keys:** no new keys. Seeing the table needs `accounts.view`; marking, editing, waiving and adding extras need `invoices.edit`; Materials ordered needs `orders.mark_ordered`; push settings and the round-up button need `users.admin`. Design/PM and Scheduling see no money beyond what M1 already gives them. The CI count of 21 and `docs/auth.md` stay as they are, apart from changing "gates a shell page only" to "live" for these keys.

## 8. Build, tests, release

**Waves** (fixed at M2 · 2.1 in `m2-contracts.md`; likely shape):
- **2.2 Scaffold (me):** migration 006, `lib/invoices.js` and `lib/notify.js` stubs with agreed signatures, and the Sydney time helpers.
- **3.1 Wave 1, in parallel:**
  - **A, invoices backend:** `lib/invoices.js`, `routes/invoices.js`, the hooks in `jobstage.js` / `schedule.js` / `jobs.js`, and wrapping `POST /api/rows` in a transaction.
  - **B, notifications backend:** `lib/notify.js`, `routes/notifications.js`, the push sender, the round-up timer and the ntfy settings.
- **3.2 Wave 2, in parallel:**
  - **C:** `accounts.*`, plus the job-page section and button.
  - **D:** the shell bell, the dashboard tiles and the push settings panel.

**Smoke additions (CI is the real check):**
- acct gets 200 and sched / dpm / show get 403 on the invoice routes. The page check for `/accounts.html` is already there.
- Place a backlog job → a deposit is due, with a notification for acct and admin. Place it again → no second deposit. Finish week Complete → the final is due. Materials ordered (admin 200, dpm 403) → the progress invoice is due.
- Mark invoiced → the stage becomes `invoiced`. Then paid, waive, and audit rows for each.
- The suggested split adds up to the value exactly for an awkward value (e.g. $10,000.01).
- Round-up now → a notification exists. Push with no `ntfy.json` → queued, nothing crashes. A test ntfy target pointed at a dead address → recorded as failed, app fine.
- A restart doesn't re-run the round-up for the same Friday.

**Release:** release is deferred (Todd, 2026-10-10). M2 is built and committed locally like M1.2. When Todd chooses to release, everything since 0.1.3 goes out in one version.

## 9. Questions for Todd

1. **ntfy server.** *Recommended: ntfy.sh with a long random private topic.* It works on the phone anywhere with no Tailscale needed for the push itself, and it's free. Self-hosting on the Umbrel means the phone can only receive over Tailscale. On an iPhone, a self-hosted server still relays a wake-up through ntfy.sh, so it doesn't avoid ntfy.sh anyway.
2. **What the push says.** ntfy.sh messages can be read by anyone who guesses the topic, and are cached for up to 12 h. *Recommended: job name and invoice kind, no amounts or client details* ("Deposit due: Smith kitchen"). Alternatives are full detail, or just "2 invoices due, open Crosscuts".
3. **Materials ordered before M3.** *Recommended: a Todd-only "Materials ordered" button on the job page now*, which M3 Orders later also drives. The alternative is that the progress invoice is added by hand until M3.
4. **Payment terms** (when an invoice becomes overdue): 7 days, 14 days, or 30 days after the invoice date? It stays editable per invoice.
5. **Jobs that predate tracking** (now, and at cutover). *Recommended: no automatic invoices for jobs already on the board or complete when M2 goes live.* Accounts adds those by hand, so nothing floods them with stale "due" prompts. The alternative is to create due deposits (and finals for complete jobs) for all of them.
6. **Report library** (brief §5.1.6, monthly uploads): *recommended for M4*, with the task queue and attachments, which share the file-upload work. Or add it to M2.
