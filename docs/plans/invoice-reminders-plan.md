# Overdue invoice reminder emails: plan

Status: **built locally as 0.2.19 (2026-11-13), not pushed. Todd answered the 13 planning questions on 2026-11-13 (section 0); Todd approved the plan, the mockups and the D9 wording on 2026-11-13; build started the same day.** Tentative numbers: migration **062**, version **0.2.19** (pay run notes took 061 / 0.2.17; the weekend follow-ups 0.2.18 with no migration).

## 0. Decisions (Todd, 2026-11-13)

1. All three modes (Off, Ready for approval, Automatic). **Starts on Ready for approval.** D9 is reworded (draft in section 1, for Todd to approve; the brief is not edited until he does).
2. Reminders at **7, 14 and 30 days** overdue.
3. **Never-sent invoices get no reminders**; they show "Not sent yet".
4. **Only invoices that become overdue after reminders are switched on get reminders. No back-catalogue at all.** The switch-on date is recorded and decides it (section 3).
5. Settings on the **Accounts overdue list**, editable by `invoices.edit` holders (settings mockup A).
6. Wording: **three messages that get firmer** (email mockup A).
7. On the invoice: **inside the email history**, with a "Next reminder" line (invoice mockup A).
8. Overdue list: **a Reminders column plus a "ready to send" strip** (overdue mockup A).
9. A sent reminder **counts as contact** (resets "needs follow-up").
10. The invoice **PDF is attached** to every reminder.
11. The wording is **editable in the settings, with a preview**.
12. Reminders go at **10:00** on weekdays (Sydney).
13. Every reminder is **BCC'd to a preset address**, editable in the reminder settings, **defaulting to chloe@thcabinets.com.au**; blank means no BCC. Smoke tests and dry runs must never send to it (section 10).

Follow-ups (Todd, 2026-11-13):

- **N1.** The release **starts Off** on install. Todd or accounts switch it to Ready for approval by hand once Resend is set up and tested.
- **N2.** The switch-on date **resets on every re-enable** (each change from Off to Ready for approval or Automatic). Moving between Ready for approval and Automatic does not reset it.
- **N3.** **Manual Send reminder still works on invoices that were overdue before the switch-on.** Only the automatic queue skips them.

The B variants have been dropped from the mockups.

Mockups: `docs/plans/mockups/invoice-reminders-settings.html`, `invoice-reminders-invoice.html`, `invoice-reminders-email.html`, `invoice-reminders-overdue.html`.

## 1. What this is, in plain English

Since 0.2.13 a person can email an issued invoice to the client through Resend, with the PDF attached, and see in the email history whether it was delivered or bounced. What was left out on purpose was **chasing**: when an invoice goes past its due date, nobody is reminded by email, only by the Accounts bell ("N invoices need follow-up") and the overdue list.

This feature adds **reminder emails for overdue invoices**: a short, polite email with the invoice PDF attached again, at set points after the due date (suggested: 7, 14 and 30 days overdue). Each reminder shows in the invoice's email history with the same Delivered / Bounced status as the invoice itself. Accounts can pause reminders for one invoice or for a whole client.

### It changes a brief decision

Brief decision **D9** (changed by Todd 2026-11-07) currently says: *no outbound email, except invoices sent by a person through Resend; nothing else is ever emailed: no reminders, nothing automatic.* So:

- A **manual** reminder (a person presses "Send reminder") fits D9 if we read "invoices sent by a person" to include reminders. It still needs Todd to say so and the D9 wording to be updated.
- **Automatic** reminders contradict D9 outright. Todd chose all three modes on 2026-11-13, so D9 is reworded (draft below).

The plan below supports three modes with one setting, so Todd can start careful and loosen later without another release:

| Mode | What happens |
|---|---|
| **Off** (the starting value) | Nothing is ever sent. The overdue list still shows which reminder is due, so accounts can phone instead. |
| **Ready for approval** | Each weekday morning Crosscuts works out which reminders are due and puts them in a "Reminders to send" list. Accounts reads them and presses **Send** (one, or all). Nothing leaves without a person pressing a button. D9 still holds in spirit: a person presses Send. |
| **Automatic** | The same list, but Crosscuts sends them itself at the set time on weekdays. A person can still pause any invoice or client. |

Decided (with N1): the release **ships with the setting at Off**. Todd or accounts switch it to **Ready for approval** once Resend is set up and a test reminder has reached Todd, so the switch-on date (which decides which invoices get reminders) is the day it is really in use. Automatic comes later, when Todd trusts it. A fresh database (CI, `.dev`) also starts Off.

### New D9 wording (approved by Todd 2026-11-13, copied into the brief word for word)

> | D9 | **No outbound email, except invoices and overdue reminders through Resend** (changed by Todd 2026-11-07; reminders added 2026-11-13). An invoice email only leaves when someone presses Send. Overdue reminders (7, 14 and 30 days overdue, for invoices that were sent and became overdue after reminders were switched on) leave either when someone approves them or, if accounts switch the reminder setting to Automatic, on their own at 10:00 on weekdays; every reminder is BCC'd to the address set in the reminder settings. Nothing else is ever emailed: no digests, no notifications, nothing else automatic. Notifications are in-app, plus ntfy push to Todd's phone, plus a weekly in-app/ntfy invoice round-up. | An internal messaging system replaces email digests. Invoices and reminders are the only emails, and reminders can be paused per invoice or per client. |

## 2. What is already in the code (read 2026-11-13)

- **Sending**: `lib/resend.js` (plain HTTPS, key in `data/config/resend-api-key`, base URL overridable by `RESEND_BASE_URL` or `data/config/resend-base-url`, Idempotency-Key header supported). `lib/invoiceemail.js` builds the default subject and message, renders the PDF (`lib/invoicepdf.js`, headless Chromium), sends, writes an `invoice_emails` row, audits `invoice.email_sent` / `invoice.email_failed`, then marks the invoice sent.
- **Delivery status**: `invoice_emails.status` is `sent`, `delivered`, `bounced` or `failed`. A 3-minute sweep (`invoiceemail.start`, off with `INVOICE_EMAIL_SWEEP_DISABLED=1`) polls Resend for rows still `sent` (under 7 days old) and bells `invoices.edit` holders on a bounce. The orange alert on an invoice is the newest bounce unless a later email was delivered.
- **Overdue**: an invoice is overdue when `status = 'issued'` and `due_date < today` (Sydney), `lib/invoices.js isOverdue`. The due date is set at issue (issue date + `invoice.default_days`, default 10) and can only be edited while the invoice is a draft, so it never moves once issued. Days overdue = today minus due date (`GET /api/invoices/overdue`).
- **Follow-up** (0.2.7, `lib/followup.js`): every issued invoice has a follow-up interval (per invoice, else the client's terms in `client_terms`, keyed by the folded client name, else the default 7). "Contacted" writes `invoice_contacts` and moves `last_contacted_date`. An overdue invoice with no contact within its interval is "Needs follow-up", and the 7:00 weekday accounts sweep bells about it.
- **Timers**: there is no general scheduler. Each feature runs its own `setInterval` started from `server.js` after `app.listen`, checks the Sydney clock every minute, stores its last run day in a setting so it runs once a day, and has an env switch to turn it off (`lib/accountsweep.js` is the model: once a weekday from 7:00, `accounts.sweep_last_run`, `ACCOUNTS_SWEEP_DISABLED=1`, and a fresh install does not sweep on its first day). `POST /api/followup/sweep` runs it now with an optional `today` that may not be before today: that is how the smoke tests move the clock forward.
- **Smoke**: `ci/smoke-invoice-send.sh` runs a stand-in Resend (`ci/fake-resend.js`) inside the container on 127.0.0.1:4987 and points Crosscuts at it with `data/config/resend-base-url`. No real email goes anywhere. The fake records the Idempotency-Key but does not yet act on it.
- **There is no invoice email plan doc** in `docs/plans/`: 0.2.13 came with `docs/how-to-send-invoices-by-email.md` and the D9 change only. This plan describes the 0.2.13 pieces it reuses.
- **Resend is not set up on the live server yet** (one of Todd's live to-dos). Reminders cannot be tried live until it is, and the first live invoice email should be sent and checked before any reminder goes out.

## 3. When a reminder is due (the cadence)

- **Steps**: three reminders, at **7, 14 and 30 days overdue** (setting `invoices.reminder_days`, default `7,14,30`; one to three whole numbers from 1 to 120, strictly rising). Step 1 is the first number, and so on.
- **Which invoices** (all must hold on the day):
  1. status `issued` (not paid, waived or void) and overdue;
  2. it was **sent** (`sent_date` is set), by email or marked sent by hand. An invoice nobody has sent yet is not reminded about; it shows "Not sent yet" instead (decided);
  3. the client has an email address (the job's client email, the same one the send dialog uses, or the To of the last delivered email to this invoice; see 6.2);
  4. not paused on the invoice, and the client is not paused;
  5. the newest email to this invoice did not bounce or fail (a bounce stops reminders until someone fixes the address and an email is delivered; the existing orange alert already asks them to);
  6. the step has not already been sent, queued or skipped for this invoice;
  7. **it became overdue after reminders were switched on**: its due date is on or after the switch-on date (`invoices.reminders_on_since`, a Sydney date). An invoice due on the 12th is overdue from the 13th, so with reminders switched on on the 13th it is included, and one due on the 11th is not. Invoices overdue before the switch-on never get automatic reminders; the overdue list shows them as "Before reminders" (grey).
- **Business days**: reminders are only prepared or sent Monday to Friday, from **10:00** Sydney time (setting `invoices.reminder_hour`, default 10). A step that falls on a weekend goes out on Monday.
- **Catch-up after downtime**: if Crosscuts itself was not running (or an invoice was paused) and an invoice has passed more than one step, only the **highest** step that is due is sent; the earlier ones are recorded as *skipped (caught up)*. A client never gets two or three reminders on the same day.
- **Switching on (Todd 2026-11-13: no back-catalogue)**: when the mode changes from Off to Ready for approval or Automatic, `invoices.reminders_on_since` is set to today (Sydney) and audited. Nothing already overdue is ever queued, so switching on sends nothing that day; the first reminders appear 7 days after the first invoice that falls due from then on. Moving between Ready for approval and Automatic keeps the date. **Every re-enable resets it** (decided, N2): turning reminders Off and back on sets the date to the new day, so invoices that went overdue while it was Off get no automatic reminders, and reminders still queued when it went Off are dropped (`cancelled`). The settings say it in words: "Reminders will only go for invoices that become overdue from today, Fri 13 Nov. Invoices already overdue won't get any." Once on: "On since Fri 13 Nov 2026. Invoices overdue before then get no reminders."
- **After the last step**: no more automatic reminders. The invoice stays on the overdue list (red days overdue) and "Needs follow-up" still bells as now. A person can still send an extra reminder by hand (it reuses the last step's wording).
- **Paid in the meantime**: an invoice paid, waived or voided between preparing and sending is dropped from the queue (checked again right before each send).

## 4. Manual sending

On the invoice page and in the Accounts invoice dialog, an overdue issued invoice has a **Send reminder** button (for `invoices.edit` holders) next to Re-send. It opens the same send dialog as Send invoice, filled with the next step's wording (To, CC, subject and message editable; PDF attached; Preview PDF). Sending it records the next step as sent *by hand*, so the automatic run won't repeat it. The BCC address (section 7) is shown read-only in the dialog and applies. This works in every mode, including Off. **It is also offered on invoices that went overdue before the switch-on** (decided, N3): a person chooses to send it, and only the automatic queue skips those invoices. The other rules still apply to a manual send: the invoice must be issued, sent and overdue, and the newest email must not have bounced.

## 5. The scheduler inside the container

A new `lib/invoicereminders.js` with `start(db)`, called from `server.js` after `app.listen`, beside the other sweeps. It follows `lib/accountsweep.js`:

- **Clock**: a 60-second `setInterval` (unref'd). Each tick asks: is the mode Off? is it a weekday at or after the set hour in Sydney? is `invoices.reminders_last_run` already today? If any says no, it does nothing.
- **The run** (at most once a weekday, plus whenever someone presses Run now): first **recover** (below), then work out every invoice's due step (section 3) and, in one transaction per invoice, insert an `invoice_reminders` row in state `queued`. The row's `UNIQUE (invoice_id, step)` is what makes double sending impossible: two runs at once, a restart halfway, or a person pressing Send at the same moment all collide on that key and only one wins.
- **Ready for approval**: the run stops there and bells `invoices.edit` holders once: "3 reminder emails are ready to send", linking to the list.
- **Automatic**: the run then sends the queued rows one by one, about two a second (Resend's rate), at most 20 per run (the rest go on the next tick; a 429 stops the batch and the next tick carries on).
- **Sending one row** (shared by automatic, Approve and Send reminder):
  1. In a transaction, move the row from `queued` to `sending` *only if it is still queued* (`UPDATE ... WHERE id = ? AND state = 'queued'`; zero rows changed means someone else has it, so stop). Re-check eligibility (still issued, overdue, not paused, has an email).
  2. Render the PDF and call Resend (To, CC, plus BCC from `invoices.reminder_bcc` when it isn't blank) with a **fixed Idempotency-Key** `crosscuts-reminder-<invoice id>-<step>`. Resend treats a repeat of the same key within 24 hours as the same email, so a retry after a crash can never send twice.
  3. On success: write the `invoice_emails` row (kind `reminder`, step N), set the reminder row to `sent` with its `email_id`, add an `invoice_contacts` row ("Reminder 2 emailed (14 days overdue)", by the sender or "Automatic reminder") so `last_contacted_date` moves and "Needs follow-up" resets (decided), and audit.
  4. On a refusal (4xx): the row becomes `failed` with Resend's message; bell once. On a timeout or 5xx: the row goes back to `queued` with the error noted and is retried on the next tick (same key, so still no double), giving up as `failed` after 3 tries.
- **Recovery after a restart**: at the start of every run, a row left in `sending` (the process died mid-send) is retried with the same Idempotency-Key if it is under 20 hours old (Resend then either sends it or answers with the email it already sent); older than that it becomes `failed` with "Crosscuts restarted while sending; check with the client before sending again", and accounts are belled. It is never silently re-sent after the 24-hour window.
- **Delivery status**: the existing 3-minute poll already covers every `invoice_emails` row still `sent`, so reminder rows get Delivered / Bounced with no new poller. Its bounce bell and audit name the reminder ("Reminder 2 email bounced").
- **Off switches**: `INVOICE_REMINDERS_SWEEP_DISABLED=1` stops the timer (CI sets it, see section 10). Mode Off stops everything except manual sends.

## 6. Pausing and opting out

### 6.1 Per invoice
On the invoice page and the Accounts invoice dialog: **Pause reminders**, with an optional "until" date (for "the client promised to pay on Friday") and an optional reason. Shown as a grey "Paused until Fri 20 Nov" badge. **Resume** clears it. While paused nothing is queued; a queued row for that invoice is dropped (state `cancelled`). When an "until" pause ends, the next due step is the highest one reached by then (catch-up rule), never a burst.

### 6.2 Per client
In the reminder settings, a **Paused clients** list (add by client name, remove), keyed by the same folded client name as the follow-up terms (`followup.clientKey`), so "Smith Pty Ltd" and "smith pty. ltd" are one client. Use for builders who pay on their own cycle, or a client in a dispute. Optional "until" date as above. A paused client's invoices show "Client paused" on the overdue list.

The address used is the job's client email (as the send dialog uses). If that is empty but an earlier email to this invoice was delivered, its To is used. If neither, the invoice shows an orange "No email on file" on the overdue list and is skipped.

## 7. The email

- **Plain text**, like the invoice email, From and Reply-To the same invoice From address, the **invoice PDF attached again** (decided).
- **BCC** (decided): every reminder, automatic, approved or manual, is BCC'd to the address in the reminder settings (`invoices.reminder_bcc`, default `chloe@thcabinets.com.au`; one address, checked with the same validator as To; blank means no BCC). The BCC address is stored on the email row (`invoice_emails.bcc_addrs`) and shown in the history's hover text and the send dialog, never to the client. Invoice sends (Send invoice / Re-send) are not BCC'd.
- **Wording** (decided: three messages that get firmer; defaults below, editable per step in the settings with a live preview):
  - Subject: `Reminder: invoice INV-0142 is overdue` (step 3: `Second reminder: invoice INV-0142 is 30 days overdue`; see the email mockup for all three).
  - Step 1 (7 days): "Hi Jane, just a friendly reminder that invoice INV-0142 for Smith kitchen, $4,180.00, was due on 3 November 2026 and hasn't been paid yet. The invoice is attached again for convenience, and our bank details are on it. If you've already paid, thank you, and please ignore this email. Thank you, TH Cabinets Accounts"
  - Step 2 (14 days): firmer: "...is now 14 days overdue. Could you please arrange payment, or reply to let us know when to expect it?"
  - Step 3 (30 days): "...is now 30 days overdue. Please arrange payment this week, or call us on (business phone) to talk about it."
- **Placeholders** the templates can use: `{client}`, `{number}`, `{job}`, `{amount}`, `{due}`, `{days}`, `{phone}`, `{from}`. Unknown ones are refused on save. Bank details stay on the PDF only, not in the email body.
- **Preview**: the settings page shows each step filled in with a real overdue invoice (or a sample), and the approval list shows the exact email that will go.

## 8. Data model: migration 062 (additive only)

`062_invoice_reminders.sql`:

```sql
-- 0.2.19: overdue invoice reminder emails (docs/plans/invoice-reminders-plan.md). Additive only.

-- Reminders are invoice emails too: same history, same delivery poll. Existing rows are 'invoice'.
ALTER TABLE invoice_emails ADD COLUMN kind TEXT NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','reminder'));
ALTER TABLE invoice_emails ADD COLUMN reminder_step INTEGER;
ALTER TABLE invoice_emails ADD COLUMN bcc_addrs TEXT NOT NULL DEFAULT '';

-- One row per invoice per step: the claim that makes double sending impossible.
CREATE TABLE invoice_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  step INTEGER NOT NULL CHECK (step BETWEEN 1 AND 3),
  days_overdue INTEGER NOT NULL,             -- when it was prepared
  state TEXT NOT NULL CHECK (state IN ('queued','sending','sent','failed','skipped','cancelled','dry')),
  how TEXT CHECK (how IN ('auto','approved','manual')),
  email_id INTEGER REFERENCES invoice_emails(id),
  idem_key TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  note TEXT,                                 -- skip reason or Resend's error, never the key
  acted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (invoice_id, step)
);
CREATE INDEX idx_invoice_reminders_state ON invoice_reminders(state, created_at);

-- Pause on one invoice (until a date, or indefinitely when the date is null and paused = 1).
ALTER TABLE invoices ADD COLUMN reminders_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN reminders_paused_until TEXT;
ALTER TABLE invoices ADD COLUMN reminders_pause_note TEXT;

-- Paused clients, keyed like client_terms (lib/followup.js clientKey).
CREATE TABLE client_reminder_pauses (
  client_key TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  until_date TEXT,
  note TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);
```

New settings in `lib/settings.js DEFAULTS`: `invoices.reminders_mode` (`off`), `invoices.reminder_days` (`7,14,30`), `invoices.reminder_hour` (`10`), `invoices.reminder_bcc` (`chloe@thcabinets.com.au`; empty string means no BCC), `invoices.reminder_templates` (JSON of three {subject, body}; null means the built-in wording), `invoices.reminders_last_run` (null, not audited), `invoices.reminders_on_since` (null; the Sydney date reminders were switched on, written by the server when the mode leaves Off, never by the client; it decides which invoices are included, section 3). Settings are audited in full; none of these hold a secret.

`invoice_emails.kind` needs SQLite 3.37+ to check a CHECK on ADD COLUMN; both better-sqlite3 in the image and node:sqlite are newer. If the implementer finds a problem, drop the CHECK and validate in code; do **not** rebuild the table.

## 9. API (every route through `defineRoutes` with an access value)

Invoice-scoped, in `routes/invoices.js` (beside the 0.2.13 email routes):

| Route | Access | What |
|---|---|---|
| `GET /api/invoices/:id/reminders` | `accounts.view` | `{eligible, why, nextStep, nextDate, paused, pausedUntil, clientPaused, steps:[{step, days, state, sentAt, emailId}], draft:{to, subject, body}}` |
| `POST /api/invoices/:id/reminders` | `invoices.edit` | Send the next step now by hand `{to, cc, subject, body}` (the send dialog). 201 with the overview and the email history. 409 if nothing is due, not overdue, already sending, or email isn't set up |
| `PUT /api/invoices/:id/reminders/pause` | `invoices.edit` | `{paused: true, until?, note?}` or `{paused: false}` |

Settings and the queue, in a new `routes/invoicereminders.js` at `/api/invoice-reminders`:

| Route | Access | What |
|---|---|---|
| `GET /settings` | `accounts.view` | mode, onSince, days, hour, bcc, templates (filled defaults), paused clients, whether email is set up, whether dry run is on, the preview for each step |
| `PUT /settings` | `invoices.edit` (decided) | `{mode?, days?, hour?, bcc?, templates?}`; checked in full before anything is written; `onSince` is set by the server when mode leaves Off |
| `PUT /clients` | `invoices.edit` | `{clientName, paused: true, until?, note?}` or `{clientName, paused: false}` |
| `GET /queue` | `accounts.view` | queued rows with the exact email each would send, plus the last 30 days of sent / failed / skipped |
| `POST /queue/send` | `invoices.edit` | `{ids: [...]}` (Approve and send, one or many). Returns per-id results |
| `POST /queue/:id/skip` | `invoices.edit` | Skip a queued reminder (state `skipped`, note "skipped by <name>") |
| `POST /run` | `invoices.edit` | Run the preparation now, `{today?}` never before today (the smoke tests' clock, as `POST /api/followup/sweep`). In Automatic it also sends |

The overdue list (`GET /api/invoices/overdue`) gains a `reminder` object per invoice: `{lastStep, lastSentAt, lastStatus, nextStep, nextDate, queued, paused, clientPaused, noEmail, notSent, beforeSwitchOn}`.

## 10. Safe dev and test mode

Four layers, so a smoke test or a local run can never reach the real Resend:

1. **Off by default.** A fresh database starts with mode `off`, so CI and every `.dev/` database send nothing automatically unless a test turns it on.
2. **CI switch.** `ci/smoke.sh` starts every container with `-e INVOICE_REMINDERS_SWEEP_DISABLED=1` (beside `INVOICE_EMAIL_SWEEP_DISABLED=1`); the suite triggers runs itself with `POST /api/invoice-reminders/run`.
3. **The stand-in Resend.** The smoke suite points Crosscuts at `ci/fake-resend.js` on 127.0.0.1 through `data/config/resend-base-url`, exactly as the invoice email suite does, with a made-up key. It removes both files at the end.
4. **Dry run.** `INVOICE_REMINDERS_DRY_RUN=1` makes every reminder send (automatic, approved or manual) skip Resend entirely: the row becomes state `dry`, the would-be email is written to the server log (To, subject, first line, never the key), and the history shows it as "Dry run". `tools/dev-sqlite-shim.js` (outside the Docker build context, so it can never affect the image) sets `INVOICE_REMINDERS_DRY_RUN=1` unless it is already set, so **every local dev-shim run is dry by default**. The settings page shows an orange "Dry run: nothing will be emailed" strip whenever it is on.

**The BCC address (Todd: never in tests or dry runs).** The default BCC is a real mailbox, so:
- Dry run never calls Resend, so nothing reaches the BCC. The log line names it only as "BCC: set" or "BCC: none", never the address.
- The smoke suite's first step sets `invoices.reminder_bcc` to a made-up `bcc-<tag>@example.test` before turning reminders on, and every email the fake Resend receives is checked: none may contain `thcabinets.com.au` in to, cc or bcc. One case sets the BCC blank and checks there is no `bcc` field at all.
- The fake Resend is the only place reminder mail can go in CI (base URL file plus a made-up key), and it sends nothing anywhere.
- Local manual testing against the real Resend, if ever needed, uses Todd's own address as both client and BCC, set by hand.

## 11. Audit log

| Action | When | `after` holds |
|---|---|---|
| `invoice.reminder_queued` | a run prepares a reminder | step, daysOverdue, how (auto run / run now) |
| `invoice.reminder_sent` | Resend accepted it | step, how, emailId, to, cc, subject, resendId |
| `invoice.reminder_failed` | refused, gave up, or restarted too late | step, error |
| `invoice.reminder_skipped` | caught up, skipped by a person, or dropped (paid, paused) | step, reason |
| `invoice.reminder_dry` | dry run | step, to, subject |
| `invoice.reminders_paused` / `_resumed` | per invoice | until, note |
| `client_reminder_pause.update` | per client | clientName, paused, until |
| `settings.update` (existing) | mode, days, hour, templates | before / after as now |

System actions use an actor label like the delivery check's (`{ actorLabel: "automatic reminders" }`). The existing `invoice.email_delivered` / `_bounced` audits fire for reminder rows unchanged, with `kind: 'reminder'` added to `after`.

## 12. Screens (see the mockups)

The chosen options only (Todd 2026-11-13); the B variants were removed.

1. **Reminder settings** (`invoice-reminders-settings.html`): a "Reminder emails" box on the Accounts overdue list, beside "Follow-up intervals". Mode (Off / Ready for approval / Automatic) with the switch-on wording, days, 10:00 send time, BCC address, wording per step with a preview, paused clients, the dry-run strip.
2. **Reminders on the invoice** (`invoice-reminders-invoice.html`): reminder rows in the existing Email history panel (labelled "Reminder 1"), a "Next reminder" line with Pause, the Send reminder button, the paused, bounced and "before reminders" states, and the pause dialog.
3. **Reminder email** (`invoice-reminders-email.html`): the Send reminder dialog (with the read-only BCC line) and the three escalating messages as the client sees them.
4. **Overdue list** (`invoice-reminders-overdue.html`): a Reminders column in the existing overdue table, plus a "ready to send" strip with Send all.

Colours: days overdue stay red (`--stop`, overdue only); orange (`--orange`) only for things to attend to: reminders waiting for approval, a bounce, "No email on file", the dry-run strip; teal for the working buttons and Delivered; grey for paused, skipped and "later". No icons; numbered steps use the house gradient disc.

## 13. Build tasks (for Sonnet 5.5 implementation subagents)

Run them in this order; 2 and 3 can run in parallel once 1 is committed locally, 5 and 6 in parallel once 4 is in. Each task gets this plan, CLAUDE.md, and its file list; each ends with `node ci/style-check.js` (UI tasks) and a local dev-shim boot.

| # | Task | Files | Acceptance |
|---|---|---|---|
| 1 | **Migration and settings** | `db/migrations/062_invoice_reminders.sql`; `lib/settings.js` (six keys) | Boots on a fresh `.dev` DB and on a copy of a 0.2.16 DB (backup written to `db/backups/`); existing `invoice_emails` rows read `kind = 'invoice'`; inserting a second `(invoice_id, step)` fails; `settings.get` returns the defaults; a second boot applies nothing |
| 2 | **Reminder core** | new `lib/invoicereminders.js` (pure step maths, eligibility with reasons, template fill and placeholder check, `prepare(db, today)`, `sendOne(db, req, id, how, override?)`, `recover(db, now)`, dry run); `lib/resend.js` (`bcc` in the payload when given); small hooks in `lib/invoiceemail.js` (write `kind`/`reminder_step`/`bcc_addrs`; `shape()` returns them; delivery audit and bounce bell name the reminder) | A node script under the shim (kept in `.dev/`, not committed) shows: 7/14/30 picked right, invoices due before the switch-on date never queued, BCC added when set and absent when blank, weekend steps wait for Monday, catch-up sends only the highest step and skips the rest, paused invoice / paused client / bounced / no email / not sent are skipped with the right reason, two `prepare` calls in a row create no duplicates, `sendOne` on a row already `sending` does nothing, a stuck `sending` row is retried with the same key under 20 h and failed over 20 h, dry run never calls fetch |
| 3 | **Scheduler** | `lib/invoicereminders.js start(db)`; `server.js` (start after listen, try/catch like the others) | `INVOICE_REMINDERS_SWEEP_DISABLED=1` means no timer; mode Off means no run; runs once a weekday from the set hour; `reminders_last_run` stops a second run; first run after switching on is held to the next weekday; Ready for approval bells once and sends nothing; Automatic sends at most 20 per run, stops on 429 |
| 4 | **Routes** | `routes/invoices.js` (three `/:id/reminders` routes; `reminder` on `/overdue`); new `routes/invoicereminders.js`; `server.js` router list | Every route declared with the access in section 9 (boot refuses otherwise); `accounts.view`-only users get 403 on every write; 400s for bad days (not rising, out of range), bad hour, unknown placeholder; 409s as listed; responses never include the API key |
| 5 | **Invoice page and dialog** | `public/invoicesend.js` (history labels "Reminder N", "Dry run"; Send reminder button using the same dialog); new `public/invoicereminders.js` + `invoicereminders.css` (prefix `irm-`); `public/invoice.html`; `public/accounts.js` (mount in the invoice dialog) | Matches the chosen mockup; print hides it all; text content only, never innerHTML; works at 375 px with no sideways scroll; style check passes |
| 6 | **Overdue list and settings** | `public/accounts.html`, `accounts.js`, `accounts.css` | Matches the chosen mockups; Send all disables while sending and reports per-row failures; settings preview updates as you type; the dry-run strip shows when on |
| 7 | **Smoke suite** | new `ci/smoke-invoice-reminders.sh`; `ci/smoke.sh` (env switch and `source` line after the invoice email suite); `ci/fake-resend.js` (honour Idempotency-Key: a repeated key returns the first id and records no new email) | Passes in the local harness (see below) and covers section 14 |
| 8 | **Docs and version** | `docs/how-to-send-invoices-by-email.md` (a Reminders part), `docs/crosscuts-brief.md` D9 wording as Todd decides, `docs/plans/STATUS.md`; `crosscuts/app/package.json` and `package-lock.json` to 0.2.19 (or the next free number) | Version bumped in both places; D9 text matches Todd's answer word for word |

## 14. Smoke-test additions (`ci/smoke-invoice-reminders.sh`)

Made-up names only, fake Resend on 127.0.0.1:4987 (the invoice email suite stops its fake before this suite starts its own, so the port is free; suites run one after another).

0. First: set `invoices.reminder_bcc` to `bcc-<tag>@example.test` (never the default address). At the end, check that no email the fake received has `thcabinets.com.au` in to, cc or bcc.
1. Mode Off: `POST /run` with `today` = due + 30 creates nothing and sends nothing.
1b. Switch-on: an invoice issued with a due date before today, then mode set to Ready for approval: `onSince` is today, and runs at +7, +14 and +30 never queue that invoice (`beforeSwitchOn: true` on `/overdue`), but a manual `POST /api/invoices/:id/reminders` on it succeeds. Mode Off then Ready for approval again: `onSince` moves to the new day and queued rows from before are `cancelled`.
2. Ready for approval: run at due + 7 queues step 1 for the sent invoice (due on or after the switch-on); the never-sent invoice, the paused invoice, the paused client's invoice, the bounced invoice and the no-email invoice are not queued, each with its reason on `/overdue`; the fake has received nothing; a bell went to `invoices.edit`.
3. Run again the same day: no new rows. `POST /queue/send` twice at once for the same id: exactly one email at the fake.
4. The email at the fake: From and Reply-To are the invoice From, To is the client, subject and body are step 1 filled in, the PDF is attached (more than a kilobyte, starts `%PDF-`), the Idempotency-Key is `crosscuts-reminder-<id>-1`, bcc is the made-up test address. Then BCC set blank: the next reminder has no `bcc` field.
5. History: `/api/invoices/:id/email` shows the reminder row with `kind: reminder`, step 1; Check now after the fake says delivered shows Delivered; a contact row was added and `needsFollowUp` is false.
6. Automatic: run at due + 30 for an invoice due after the switch-on that was never reminded (downtime) sends only step 3 and records steps 1 and 2 as skipped (catch-up).
7. Manual: `POST /api/invoices/:id/reminders` sends step 2 by hand; a later run at due + 14 does not send step 2 again.
8. Recovery: a row set to `sending` (via a `docker exec node` script on the database) is retried with the same key; with the fake's idempotency the fake still holds one email for it.
9. Refusal: fake fails the next send with 422: row `failed`, audited, nothing marked sent; a 500 leaves it `queued` with tries 1.
10. Paid between queue and send: the queued row is dropped (`cancelled`) on send.
11. Access: a scheduler-role user gets 403 on settings, queue send, pause and manual send; `accounts.view`-only gets 200 on the reads.
12. Dry run is not exercised in CI (the image never sets it); a one-line check that `INVOICE_REMINDERS_DRY_RUN` is unset in the container.
13. Clean up: mode back to Off, the fake stopped, `resend-base-url` and the key file removed.

## 15. How I will review the subagents' work

One task at a time through review, never two smoke runs at once:

1. Read the diff against this plan and CLAUDE.md (version bump, additive migration, `defineRoutes` access values, `cc-`/page prefixes, no icons, colour roles, text content only).
2. Local dev-shim boot on a scratch copy of `.dev/db` (dry run is on by default there): check the migration, then drive the API with curl as admin and as a non-accounts user, and the pages in the browser pane at 375, 1366 and 1920 px against the mockups.
3. `node ci/style-check.js`.
4. The local smoke harness (`.dev/m23-full`: copy `ci/smoke-*.sh` and `ci/fake-resend.js` in, `node adapt.js && bash fullrun.sh` in the background, one run at a time, success line "FULL RUN ... PASSED"). The harness must start the fake Resend the same way it already does for the invoice email suite.
5. Commit locally per task. **No push**: Todd says when, and CI smoke on the built image is the real check.

Before release: Todd sets up Resend and sends himself a test invoice; then a test reminder to his own address (manual Send reminder on an invoice whose client email is his) before switching the mode from Off.

## 16. Open questions

None. N1 to N3 were answered by Todd on 2026-11-13 (section 0). Still waiting: his approval of the D9 wording in section 1.
