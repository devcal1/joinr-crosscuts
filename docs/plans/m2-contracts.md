# M2 interface contracts (binding for all M2 subagents)

Read `docs/plans/m2-plan.md` for the why; this file is the *what*. Everything in `m1-contracts.md` still holds (timestamps, dates, `defineRoutes`, audit, errors `{error}`, the board files that must not be edited). Do not change anything here without the integrator's say-so. If a contract looks wrong, report it instead of working around it.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), no build step, no framework. Money is integer cents, **GST-inclusive**. Business dates are Sydney `YYYY-MM-DD`.

**No version bump in M2** (release deferred by Todd, 2026-10-10; one bump at release). **No new feature keys:** the CI count of 21 stays.

## 1. Migration `006_accounts.sql` (scaffold, M2 · 2.2)

```sql
ALTER TABLE jobs ADD COLUMN client_abn TEXT;            -- Q-A: optional, printed on invoices

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit','progress','final','extra')),
  status TEXT NOT NULL CHECK (status IN ('pending','due','issued','paid','waived','void')),
  number TEXT UNIQUE,                                   -- null until issued
  lines_custom INTEGER NOT NULL DEFAULT 0 CHECK (lines_custom IN (0,1)),
  total_cents INTEGER,                                  -- frozen at issue
  gst_cents INTEGER,                                    -- frozen at issue: round(total/11)
  became_due_date TEXT,
  due_reason TEXT CHECK (due_reason IS NULL OR due_reason IN ('scheduled','materials_ordered','completed','manual')),
  issue_date TEXT,
  due_date TEXT,                                        -- payment due; default issue_date + 10 days
  paid_date TEXT,
  bill_to_name TEXT,                                    -- client snapshot, frozen at issue
  bill_to_address TEXT,
  bill_to_abn TEXT,
  site_address TEXT,
  myob_entered_date TEXT,
  external_id TEXT,                                     -- MYOB slot (D12); stored, never called
  notes TEXT NOT NULL DEFAULT '',
  last_contacted_date TEXT,
  follow_up_notes TEXT NOT NULL DEFAULT '',
  void_reason TEXT,
  waive_reason TEXT,
  replaces_id INTEGER REFERENCES invoices(id),          -- set on the copy made by a void
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_invoices_one_live ON invoices(job_id, kind)
  WHERE kind <> 'extra' AND status <> 'void';
CREATE INDEX idx_invoices_job ON invoices(job_id);
CREATE INDEX idx_invoices_status ON invoices(status, due_date);

CREATE TABLE invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  sort_order INTEGER NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL                         -- GST-inclusive; may be negative (a discount line)
);
CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id, sort_order);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  entity_type TEXT,
  entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id)
);
```

It is additive only, creates no invoice rows (decision 5), and touches no existing data. The plan's separate number-sequence table is folded into `app_settings` (`invoice.next_number`), because SQLite's single writer makes an in-transaction read-and-increment safe.

## 2. Shared library signatures

All of these are synchronous, take the better-sqlite3 handle `db` first, and are safe inside a caller's `db.transaction`.

### `lib/time.js` (scaffold adds)
- `sydneyParts(now = new Date())` → `{date:'YYYY-MM-DD', weekday:1..7 (Mon=1), hour:0..23, minute:0..59}`, using `Intl` with `timeZone:'Australia/Sydney'`.
- `latestFridayNoon(now = new Date())` → the `YYYY-MM-DD` of the most recent Friday whose 12:00 Sydney is at or before `now`.

### `lib/settings.js` (Wave 1 B; the scaffold provides a working get/set)
- `get(db, key)` → string or `null`. `getAll(db)` → `{key: value}`.
- `set(db, key, value, req)` upserts the value, sets `updated_by` from `req.user`, and audits `settings.update` (before and after). The audit is skipped for keys starting `roundup.`.
- `KEYS`:
  - `business.trading_name`, `business.legal_name`, `business.abn`, `business.address`, `business.phone`, `business.email`;
  - `bank.account_name`, `bank.bsb`, `bank.account_number`;
  - `invoice.terms_text`, `invoice.prefix` (default `CC-`), `invoice.next_number` (default `1`), `invoice.pad` (default `4`), `invoice.default_days` (default `10`);
  - `roundup.last_run`.
- `business(db)` → `{tradingName, legalName, abn, address, phone, email, bankAccountName, bsb, accountNumber, termsText}`. This object is what invoice responses embed.
- `businessReady(db)` → true when `trading_name` (or `legal_name`), `abn` and `address` are all set. Issuing requires it.

### `lib/notify.js` (Wave 1 B; the scaffold provides working versions)
- `toUser(db, userId, {kind, title, body, link, entityType, entityId})` inserts one row.
- `toKey(db, featureKey, payload)` inserts one row for every user who is not disabled and whose effective permissions (`permissions.computeEffective` over `user_roles` + `permission_overrides`) include `featureKey`. It returns the count.
- Kinds used in M2: `invoice.due`, `invoice.roundup`.
- Links are site-relative, e.g. `/accounts.html?invoice=12`.

### `lib/invoices.js` (Wave 1 A)
- Event hooks:
  - `onScheduled(db, jobId, weekStart, req)` creates a deposit `due` (`due_reason 'scheduled'`) if the job has **no deposit row in any status** and **no `week_rows` with `week_start < weekStart`**. It then notifies `invoices.edit` holders.
  - `onMaterialsOrdered(db, jobId, date, req)` creates a progress `due` (`'materials_ordered'`) if there is no live progress invoice, then notifies.
  - `onCompleted(db, jobId, req)` runs only if the job already has at least one invoice row (decision 5). It creates a final `due` (`'completed'`) if there is no live final, turns any `pending` extras into `due`, then notifies.
  - Each hook runs its work in a nested `db.transaction` (a savepoint) inside try/catch. On error it logs `[invoices] <hook> failed` and returns `false`. It never throws.
  - Each due invoice is audited as `invoice.due`, and its notification reads `"<Kind> due: <job name>, $<amount>"` with the link `/accounts.html?invoice=<id>`.
- `suggestedCents(valueCents, kind)`: deposit = `Math.round(v*0.10)`, progress = `Math.round(v*0.50)`, final = `v - round(v*0.10) - round(v*0.50)`, extra = `null`. A null value gives `null`.
- `standardLine(job, kind)`: `"Deposit (10%): <name>[, <site_address>]"`, `"Progress payment (50%): …"`, `"Final payment (40%): …"`.
- `linesFor(db, invoice)`: when `lines_custom = 0` and the invoice isn't issued, one standard line with the suggested amount from the **current** job. Otherwise the stored `invoice_lines`.
- `issue(db, id, req)`, `voidInvoice(db, id, reason, req)` (returns `{voided, replacement}`), `waive(db, id, reason, req)`, `markPaid(db, id, paidDate, req)`, `unmarkPaid(db, id, req)`, `setMyob(db, id, dateOrNull, req)`. Each throws `HttpError`-style `{status, message}` on rule breaks; the routes map those to 4xx.
- `isOverdue(inv, today)`: `status === 'issued' && due_date < today`.

### `lib/roundup.js` (Wave 1 B)
- `shouldRun(now, lastRun)` → the Friday date string when `latestFridayNoon(now) !== lastRun`, otherwise `null`. It is pure.
- `run(db, {force, now})`:
  - builds the summary: due-but-not-issued count and total, overdue count and total, issued-but-not-in-MYOB count, and the oldest five by name;
  - sends `invoice.roundup` to `invoices.edit` holders, unless every count is zero;
  - unless `force`, sets `roundup.last_run`;
  - returns `{sent, summary}`.
- `start(db)`:
  - On the first call, if `roundup.last_run` is null, it sets it to `latestFridayNoon()` **without running**, so a fresh install or upgrade doesn't fire a stale round-up.
  - It then checks every 60 s and calls `run` when `shouldRun` says so. Errors are logged, never thrown.
  - The env `ROUNDUP_DISABLED=1` skips `start` entirely.

## 3. Hooks into existing code (Wave 1 A owns these edits)

- `lib/jobstage.js`:
  - `onScheduled(db, jobId, req, weekStart)` gains a fourth argument. After its stage logic it calls `invoices.onScheduled(db, jobId, weekStart, req)` (always, whatever the stage did).
  - `onFinishedComplete` calls `invoices.onCompleted(db, jobId, req)` after a successful `setStage` to complete.
- `routes/schedule.js`:
  - Pass the week to the three `onScheduled` calls: `snappedWeekStart` (`POST /rows`, backlog place) and `toWeekStart` (duplicate).
  - Wrap the job create, row insert and `onScheduled` of `POST /rows` in one `db.transaction`.
  - No other change; the board's behaviour is otherwise untouched.
- `routes/jobs.js`:
  - `clientAbn` is added to FIELDS (text).
  - `materialsOrderedDate` is removed from the PATCH-editable fields (a PATCH that sends it gets 400 `"Use Materials ordered"`). It is still returned.
  - A PATCH that hand-sets `stage: 'complete'` (admin) goes through `jobstage.onFinishedComplete` instead of `setStage`, so `completed_date` and the final invoice follow.
  - New route: `POST /api/job-records/:id/materials-ordered`, access `orders.mark_ordered`.
    - Body `{date?}`: a Sydney date, default today.
    - Sets `materials_ordered_date` (audited as `job.update`) and calls `invoices.onMaterialsOrdered`. Returns the job object.
    - If the date is already set it returns 409 `"Materials already marked ordered"`.

## 4. API surface

Errors are `{error}`. Validation → 400, not found → 404, rule break (wrong status, locked, not ready) → 409.

### `/api/invoices` (`routes/invoices.js`, Wave 1 A)

**The invoice object** (camelCase of every column, plus):
- `lines: [{id|null, description, amountCents}]` and `totalCents` (computed live while due, frozen once issued), `gstCents`;
- `suggestedCents`;
- `overdue: bool`;
- `job: {id, name, clientName, clientPhone, clientEmail, siteAddress, clientAbn, valueCents, stage}`;
- `replacedById: id|null`.

**The cell object** used by the table: `{id, kind, status, number, totalCents, issueDate, dueDate, paidDate, overdue, myobEntered:bool, description}`.

| Method & path | Access | Body / query → response |
|---|---|---|
| `GET /table` | `accounts.view` | `?filter=all\|due\|unpaid\|overdue\|notmyob\|month&q=&allJobs=0\|1` → `{rows:[{job:{id,name,clientName,valueCents,stage}, deposit:cell\|null, progress:cell\|null, final:cell\|null, extras:[cell]}], totals:{outstandingCents, overdueCents, dueCount, overdueCount, notInMyobCount}}`. Without `allJobs`, only jobs that have an invoice are listed. Void cells are omitted; the live replacement shows. |
| `GET /overdue` | `accounts.view` | → `[{invoice, daysOverdue}]`, oldest first. `invoice` includes `job.clientPhone`. |
| `GET /summary` | `accounts.view` | → `{dueCount, overdueCount}` (dashboard tile). |
| `GET /job/:jobId` | `accounts.view` | → `[invoice]` for that job, including void ones. |
| `GET /:id` | `accounts.view` | → `{invoice, business: settings.business(db), contract:{valueCents, invoicedToDateCents}}`. `invoicedToDateCents` is the sum of issued and paid invoices on the job, excluding this one. |
| `POST /` | `invoices.edit` | `{jobId, kind, description?, amountCents?}` → 201 invoice. Deposit, progress or final → `due`, `due_reason 'manual'` (409 if one is live). Extra → `description` and `amountCents` are required, `lines_custom=1` with that one line, and status `due` if the job stage is complete or invoiced, otherwise `pending`. Audited as `invoice.create`. |
| `PATCH /:id` | `invoices.edit` | While `pending` or `due`: `lines` (replaces all; sets `lines_custom=1`), `dueDate`, `billToName`, `billToAddress`, `billToAbn`, `siteAddress`. In any status: `notes`, `lastContactedDate`, `followUpNotes`, `externalId`. A draft-only field on an issued invoice → 409. Audited as `invoice.update`. |
| `POST /:id/issue` | `invoices.edit` | → invoice. 409 unless `status==='due'`, `businessReady`, and `total > 0`. In one transaction it: takes the number (`prefix + zero-pad(next_number, pad)`) and increments `invoice.next_number`; materialises the lines; freezes the total and GST (`Math.round(total/11)`); snapshots `bill_to_*` (from the edited values, else the job's client name, site address and client ABN) and `site_address`; sets `issue_date` (today) and `due_date` (the edited value, else today + `invoice.default_days`); and sets the status to `issued`. Issuing a final → `jobstage.setStage(db, jobId, 'invoiced', req)`. Audited as `invoice.issue`. |
| `POST /:id/paid` | `invoices.edit` | `{paidDate?}` (default today) → invoice. Only from `issued`. Audited as `invoice.paid`. |
| `POST /:id/unpaid` | `invoices.edit` | → invoice. Only from `paid`, back to `issued`. Audited as `invoice.paid` with after `{status:'issued'}`. |
| `POST /:id/myob` | `invoices.edit` | `{entered: bool}` → invoice. Sets or clears `myob_entered_date` (today). Only for `issued` or `paid`. Audited as `invoice.myob`. |
| `POST /:id/void` | `invoices.edit` | `{reason}` (required) → `{voided, replacement}`. Only from `issued`. The replacement is a new `due` row with the same kind, job and lines (`lines_custom=1`), `replaces_id` = the old id, and `due_reason 'manual'`. Audited as `invoice.void`. **Paid invoices can't be voided** (credit notes are deferred): 409. |
| `POST /:id/waive` | `invoices.edit` | `{reason}` (required) → invoice. Only from `pending` or `due`. Audited as `invoice.waive`. |

### `/api/notifications` (`routes/notifications.js`, Wave 1 B)

| Method & path | Access | → |
|---|---|---|
| `GET /` | `login` | `?limit=1..100 (default 30)` → `{rows:[{id,kind,title,body,link,createdAt,readAt}], unread}`, newest first, own rows only |
| `GET /unread-count` | `login` | `{unread}` |
| `POST /:id/read` | `login` | 204 (own row only; another user's id → 404) |
| `POST /read-all` | `login` | 204 |
| `POST /roundup/run` | `users.admin` | `{sent, summary}`: `roundup.run(db, {force:true})` |

### `/api/settings` (`routes/settings.js`, Wave 1 B)

| Method & path | Access | → |
|---|---|---|
| `GET /` | `users.admin` | `{business:{...as settings.business}, invoice:{prefix, nextNumber, pad, defaultDays, termsText, numberLocked}}`. `numberLocked` is true once any invoice has a number. |
| `PUT /` | `users.admin` | The same shape, partial allowed → the same response. Changing `prefix`, `nextNumber` or `pad` while `numberLocked` → 409. ABN: 11 digits after removing spaces → 400 otherwise. BSB: 6 digits. |

### Dashboard
No new route: the Accounts tile uses `GET /api/invoices/summary`, and the Notifications tile uses `GET /api/notifications?limit=5`.

## 5. Audit actions (additions)
`invoice.due`, `invoice.create`, `invoice.update`, `invoice.issue`, `invoice.paid`, `invoice.myob`, `invoice.void`, `invoice.waive`, `settings.update`. The entity type is `invoice` (or `settings`, with the key as `entityId`). The actor is `req.user`, or `"system"` for hooks run with no request.

## 6. Pages and front end

- `lib/pages.js` (scaffold): add `'/invoice.html': 'accounts.view'`. `/accounts.html` is already `accounts.view`.
- **`/accounts.html`** (Wave 2 C): the invoice table, the filters, the totals, the editor dialog (lines, bill-to, due date, Preview → `/invoice.html?id=`, Issue), the issued-invoice actions (Paid / Unpaid, Entered in MYOB, Void, Waive, notes), the "New invoice" and "Add extra" dialogs, and the Overdue view (a tab or filter preset) with "Contacted today" (`PATCH lastContactedDate`). `?invoice=<id>` opens that invoice's dialog.
  - Status colours: due → orange, overdue → red (`--stop`), issued, paid and waived → neutral or teal.
  - It reads `cc.can('invoices.edit')`; without it, every action is hidden (view only).
- **`/invoice.html?id=`** (Wave 2 D): the document. On screen it has the house-style frame and buttons ("Save as PDF" → sets `document.title` to `"<number> <job name>"`, then `window.print()`; "Back").
  - The print CSS is black on white A4, between the `style-check: print-start` / `print-end` comments.
  - Contents and DRAFT / VOID marks are as in plan §6.
  - It has no edit controls.
- **`/job.html`** (Wave 2 C):
  - a "Client ABN" field in the Client group;
  - an **Invoices** section (shown if `cc.can('accounts.view')`), listing `GET /api/invoices/job/:id` with links to `/accounts.html?invoice=`;
  - the materials-ordered date shown read-only, with a **Materials ordered** button if `cc.can('orders.mark_ordered')` and the date is empty.
- **Shell bell** (Wave 2 E, `public/shell/shell.js` and `shell.css`):
  - a `cc-bell` button in `.cc-right` with an unread badge, polling `GET /api/notifications/unread-count` every 60 s (and on focus);
  - a `cc-bell-menu` list with "Mark all read"; clicking an item marks it read and follows its link.
  - The board pages don't load the shell, so the bell never appears there.
  - Text label "Alerts" plus the count: no icons (house style).
- **Dashboard** (Wave 2 E, `public/index.*`): the Notifications placeholder becomes the live latest five; the Accounts tile adds "N due · N overdue" when `cc.can('accounts.view')`.
- **Settings panel** (Wave 2 E, `public/users.*`): a "Business details and invoicing" section (`users.admin`) for `GET`/`PUT /api/settings`, with the number fields disabled when `numberLocked`, and a **Run round-up now** button.
- Every new or changed page must pass `node ci/style-check.js`. Use `tokens.css` and `components.css` (`hs-`), the shell's `cc-dialog*`, and `shared.js` `api()` / `toast()` / `guarded()`.

## 7. Server composition (scaffold; the integrator owns `server.js`)
- Mount `routes/invoices.js` (`/api/invoices`), `routes/notifications.js` (`/api/notifications`) and `routes/settings.js` (`/api/settings`). The scaffold creates all three as guarded stub routers.
- After `listen`: `require('./lib/roundup').start(db)`.

## 8. Tests

`ci/smoke.sh` (scaffold) gains, between step j and step k:
```bash
for f in "$(dirname "$0")"/smoke-m2-*.sh; do [ -f "$f" ] && source "$f"; done
```
Sourced files share the helpers, the jars (`$ADMIN $SCHED $ACCT $DPM $SHOW`), `$CONTAINER` and `sydney_monday`. Each file starts with `step "m2-…"`.
- **`ci/smoke-m2-invoices.sh`** (Wave 1 A):
  - the permitted / forbidden pairs (acct 200, sched / dpm / show 403);
  - the deposit fires once on the backlog place, and not on a second placement;
  - no deposit for a job with an earlier week row;
  - Finish week complete → final due;
  - materials-ordered: admin 200, dpm 403, then progress due;
  - an awkward value split adds up exactly, and GST = round(total/11);
  - issue → consecutive numbers; a second issue → 409; a draft-field PATCH on an issued invoice → 409;
  - void → a replacement, and the number is never reused;
  - issuing the final → stage `invoiced`;
  - paid, unpaid, myob, waive, with an audit row for each;
  - `/invoice.html` sched 403, acct 200.
- **`ci/smoke-m2-notify.sh`** (Wave 1 B):
  - an acct notification exists after a due event;
  - read and read-all; another user's id → 404;
  - settings: admin 200, acct 403; the ABN is validated; the number is locked after an issue;
  - `roundup/run` → `sent > 0`;
  - the `shouldRun` cases via `docker exec "$CONTAINER" node -e` (Friday 11:59 / 12:00 Sydney, the DST weekend, and the same Friday twice);
  - a restart doesn't re-run.

Docker isn't available on the dev box, so smoke files are checked locally with `bash -n` only. **Local verification** for every task is a shim boot plus `curl` against the routes it owns (logged in through `/api/auth/setup` and `/api/auth/login` on a fresh `.dev-<task>/` data dir). Report what was run.

## 9. Waves and file ownership

| Step | Who | Owns (only these files) |
|---|---|---|
| **M2 · 2.2 Scaffold** | integrator | `db/migrations/006_accounts.sql`, `lib/time.js` (two helpers), `lib/pages.js` (one entry), stubs for `lib/settings.js`, `lib/notify.js` (both working minimal versions), `lib/invoices.js`, `lib/roundup.js` (no-op `start`), and `routes/{invoices,notifications,settings}.js` (empty guarded routers), `server.js`, the `ci/smoke.sh` source line, `docs/auth.md` (keys now live) |
| **M2 · 3.1 Wave 1, A: invoices backend** | Sonnet, worktree | `lib/invoices.js`, `routes/invoices.js`, `lib/jobstage.js`, `routes/schedule.js` (§3 edits only), `routes/jobs.js`, `ci/smoke-m2-invoices.sh` |
| **M2 · 3.1 Wave 1, B: notifications and settings backend** | Sonnet, worktree | `lib/notify.js`, `lib/settings.js`, `lib/roundup.js`, `routes/notifications.js`, `routes/settings.js`, `ci/smoke-m2-notify.sh` |
| **M2 · 3.2 Wave 2, C: accounts and job pages** | Sonnet, worktree | `public/accounts.{html,css,js}`, `public/job.{html,js}`, `public/jobs.css` (only if needed) |
| **M2 · 3.2 Wave 2, D: invoice document** | Sonnet, worktree | `public/invoice.{html,css,js}` |
| **M2 · 3.2 Wave 2, E: bell, dashboard, settings panel** | Sonnet, worktree | `public/shell/shell.{js,css}`, `public/index.{html,js,css}`, `public/users.{html,js,css}` |
| **M2 · 4.1 Integrate** | integrator (+ Haiku for docs) | merges; `docs/how-to-invoice.md` (a short guide for accounts staff and Todd's first-time settings) |

Wave 2 starts only after Wave 1 is merged on `main`, so the pages code against real APIs. Tasks don't edit files outside their row. A task that needs a change elsewhere reports it.
