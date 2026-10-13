# M10 interface contracts: New roles and receiving deliveries (binding for all M10 subagents)

Read `docs/plans/m10-plan.md` first. Its **Decisions** (section 5, 1–6) and **Lead's defaults** (section 3) are binding and win over its section 2. This file is the *what*. Everything in `m1-contracts.md` … `m9-contracts.md` and `backup-contracts.md` still holds (UTC ISO timestamps with milliseconds, Sydney `YYYY-MM-DD` business dates, `defineRoutes`, audit, `lib/httperror.js`, errors `{error}`); `m3-contracts.md` §2–§4 is the orders baseline this file changes. If a contract looks wrong, report it instead of working around it. Points the integrator decided while writing this file are in §12; Todd can change any of them.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), Node 24, no build step, no framework.

**This repo is public.** Smoke and screenshot data use made-up names (`M10 Test Supplier`, `M10 Test Job`) only.

**Version.** 0.1.12 (M8 and M9) is committed and unpushed. M10 ships as **0.1.13**: the scaffold bumps `crosscuts/app/package.json` and the root version in `crosscuts/app/package-lock.json`. No further bump during the build.

**Not touched in M10:** the board files (`schedule.*`, `workers.html`, `exportJpg()`, `alignPanels()`; the materials mark stays as it is), `public/shared.js`, the Planner's layer list and the chat channels (no new layer, no new channel: m10-plan default 3), `lib/invoices.js` (the progress-invoice trigger is unchanged: `markMaterialsOrdered` still calls it), migrations 001–020.

## 1. Files and owners

| File | What it is | Owner |
|---|---|---|
| `db/migrations/021_new_roles.js` | `user_roles` rebuilt to allow `ordering` and `workshop_manager` (§2.1), complete | scaffold |
| `db/migrations/022_orders_receiving.sql` | four additive `orders` columns (§2.2), complete | scaffold |
| `lib/permissions.js` | two keys, two roles, presets (§3) | scaffold |
| `public/users.js` | `ROLE_LABELS` gains the two roles | scaffold |
| `lib/pages.js` | `/orders.html` → `orders.view`; `/deliveries.html` → `orders.receive` (§8) | scaffold |
| `public/shell/shell.js` | the Ordering menu (§8) | scaffold |
| `lib/planner/layers.js` | the two roles in SEE/POST and the default order (§7) | scaffold |
| `routes/orders.js` | access values changed, `GET /orders/deliveries` declared (§5); handler 501 in the scaffold, then A | scaffold, then A |
| `lib/orders.js` | `deliveries()` stub in the scaffold (binding signature, 501); everything else of §4 | scaffold stub, then A |
| `ci/smoke.sh` | key and role counts, the two presets, users `ordr` and `wsmgr` and their jars (§10.1), the M10 source loop | scaffold |
| `tools/screenshots/menu-shots.js`, `tools/screenshots/shoot.js` | the two roles in the role lists; three shoot entries (§10.4) | scaffold |
| `crosscuts/app/package.json`, `crosscuts/app/package-lock.json` | 0.1.13 | scaffold |
| `ci/smoke-m10-orders.sh` | §10.2 | A |
| `public/orderui.js`, `public/orderui.css` | the shared order dialogs (§6), class prefix `ou-` | B |
| `public/deliveries.html`, `deliveries.css`, `deliveries.js` | the Deliveries page (§9.1), prefix `dl-` | B |
| `public/orders.html`, `orders.css`, `orders.js` | the Orders page changes (§9.2) | C |
| `public/job.js` (the Orders section only), `public/job.html` (only if the section needs markup) | the job page's order lines (§9.3) | C |
| `public/index.js`, `public/index.html` | the dashboard's Deliveries line (§9.4) | C |
| `docs/how-to-receive-deliveries.md`, `docs/auth.md`, `docs/how-to-add-user.md` (roles and the TV), `docs/how-to-add-feature-key.md` (refreshed), `docs/plans/menu-plan.md` (who has what), `tools/screenshots/seed.js` | docs and made-up data | integrator, 4.1 |

**Boundaries.**
- Every rule about who may do what to an order line lives in `lib/orders.js` (as in M3): routes only declare the coarse access value; no page decides access except to hide controls.
- Every write runs in one `db.transaction` with its audit row.
- `orderui.js` is the only place the receive, delivery-note and edit dialogs are built; the Deliveries, Orders and job pages all call it.

## 2. Migrations (scaffold, M10 · 2.2)

### 2.1 `021_new_roles.js`

A copy of `017_workshop_role.js`'s method with its header rewritten (M10, Todd's sign-off in m10-plan Decision 5): refuse orphans, count, `CREATE TABLE user_roles_new (... role TEXT NOT NULL CHECK (role IN ('admin','accounts','design_pm','scheduling','showroom','workshop','ordering','workshop_manager')) ...)`, copy, compare count and `EXCEPT`, drop, rename, re-count, `PRAGMA foreign_key_check(user_roles)`, log `[migrate] 021 user_roles rebuilt: N row(s) kept, 'ordering' and 'workshop_manager' allowed`. Never requires app code.

### 2.2 `022_orders_receiving.sql`

```sql
-- M10 receiving deliveries (docs/plans/m10-contracts.md section 2.2). Additive only: four new
-- columns on orders. No existing row changes (the new columns start NULL or '').
ALTER TABLE orders ADD COLUMN received_by INTEGER REFERENCES users(id);   -- who marked it received
ALTER TABLE orders ADD COLUMN updated_by INTEGER REFERENCES users(id);    -- who last changed the line
ALTER TABLE orders ADD COLUMN delivery_note TEXT NOT NULL DEFAULT '';     -- short, damaged, part delivered
ALTER TABLE orders ADD COLUMN delivery_note_at TEXT;                      -- when the note was last set (UTC ISO)
```

## 3. Keys, roles and presets (scaffold)

`KEYS` gains, **appended** (order matters for the Users page): `"orders.view"`, `"orders.receive"` → **25 keys**.
`ROLES` gains, appended: `"ordering"`, `"workshop_manager"` → **8 roles**.

| Preset | Change |
|---|---|
| `admin` | every key, as now (so both new keys) |
| `accounts` | + `orders.view` |
| `design_pm` | + `orders.view`, `orders.receive` |
| `scheduling` | + `orders.view` |
| `showroom`, `workshop` | unchanged |
| **`ordering`** (new) | `board.view`, `jobs.view`, `design.view`, `photos.search`, `orders.view`, `orders.edit`, `orders.mark_ordered`, `orders.receive`, `tasks.use`, `messages.use`, `planner.view`, `planner.edit` |
| **`workshop_manager`** (new) | `board.view`, `orders.view`, `orders.receive`, `tasks.use`, `messages.use`, `planner.view`, `planner.edit` |

Nobody loses a key. What each key means from M10:
- `orders.view`: see order lines without the job pages (`GET /api/orders`, `/api/orders/suppliers`, the Orders page, the Ordering menu).
- `orders.receive`: mark an ordered line received, undo it, change its received date, and set or clear its delivery note (§4.2).
- `orders.edit` (unchanged): add lines, edit supplier, description, expected date and notes, cancel.
- `orders.mark_ordered` (unchanged): mark ordered and its undo, change the ordered date; the last line ordered makes the job's progress invoice due (Decision 1).

## 4. `lib/orders.js` (A)

### 4.1 The order object

`present()` gains: `receivedBy: {id, name}|null`, `updatedBy: {id, name}|null`, `deliveryNote: string`, `deliveryNoteAt: string|null`. Every write sets `updated_by` to the user (create, update, cancel). `list()` rows keep `jobName` and `jobStage`.

### 4.2 Status changes and fields (replaces the M3 table)

| Change | Key | Effect |
|---|---|---|
| to_order → ordered | `orders.mark_ordered` | `ordered_date` = body `orderedDate` or today; the all-ordered rule as now |
| ordered → to_order | `orders.mark_ordered` | clears `ordered_date` |
| ordered → received | **`orders.receive`** | `received_date` = body `receivedDate` or today; `received_by` = the user |
| received → ordered | **`orders.receive`** | clears `received_date` and `received_by` (the delivery note stays) |
| to_order → received | — | 409 `"Mark it ordered first"` (as now) |
| `orderedDate` alone | `orders.mark_ordered` | as now |
| `receivedDate` alone (received line) | **`orders.receive`** | as now otherwise |
| `deliveryNote` | **`orders.receive`** | string, trimmed, at most 500 (400 `"The delivery note must be 500 characters or fewer"`); `''` clears it; only on an ordered or received line (409 `"Only an ordered or received line takes a delivery note"`); sets `delivery_note_at` when it changes |
| supplier, description, notes, expectedDate | `orders.edit` | as now |
| cancel | `orders.edit` | as now (sets `updated_by`) |

New date rule: a `receivedDate` (in a transition or alone) before the line's `ordered_date` → 400 `"The received date can't be before it was ordered (<d Mon yyyy>)"`. Future dates stay refused as now.

**Added at 4.3 (review):** on a received line, an `orderedDate` later than its `received_date` → 400 `"The ordered date can't be after it was received (<d Mon yyyy>)"`; both date rules apply only when the date in question changes. `status:"received"` on a line already received → 409 `"It was already marked received on <d Mon yyyy>"` (it used to become a silent date edit), and `status:"ordered"` on a line already ordered → 409 `"It was already marked ordered on <d Mon yyyy>"`. `ordered → to_order` clears the delivery note (in the `order.status` audit). `deliveryNote: ""` is allowed on any line that isn't cancelled; only a non-empty note on a `to_order` line is 409. A note that isn't a string → 400 `"The delivery note must be text"`. The two "already marked" 409s are checked before the transition's key, so anyone who can PATCH gets the 409; `to_order` sent to a `to_order` line stays a no-op. The move back to To order clears `delivery_note_at` too (the `order.status` row carries `delivery_note` only when there was one), and a `""` sent with it needs no `orders.receive`.

One PATCH may carry a status change, a `receivedDate` and a `deliveryNote` together; it is checked whole (every key needed is checked before anything is written) and written in one transaction. Audit: `order.status` as now (its before/after gain `received_by`); `order.update` for plain fields as now, now including `delivery_note`.

### 4.3 Notifications

- **Delivery note:** when a PATCH sets a non-empty note different from the one before → `notify` to holders of **`orders.mark_ordered`** (Decision 3), except the person who wrote it: kind `order.delivery_note`, title `Delivery note: <job name>`, body `<supplier>: <note>` (the note cut to 200 characters with `…`), link `/job.html?id=<jobId>#orders`, entity `order` / the order id. Every changed note notifies (no once-only rule). Clearing a note doesn't.
- **Materials in** (Decision 4): the existing once-per-job `materials.in` notice goes to every holder of **`scheduling.view` or `orders.mark_ordered`**, each user once, except the actor (today: `scheduling.view` only). Nothing else about it changes.

### 4.4 `deliveries(db, today = sydneyToday())` (stub in scaffold, then A)

Every `ordered` line on a job that isn't archived, in five groups by `expected_date`, then the recently received:

```js
{
  date: today,
  groups: [
    { id: "overdue", label: "Overdue",     lines: [...] },   // expected_date < today
    { id: "today",   label: "Today",       lines: [...] },   // = today
    { id: "week",    label: "Next 7 days", lines: [...] },   // today+1 … today+7
    { id: "later",   label: "Later",       lines: [...] },   // > today+7
    { id: "nodate",  label: "No date yet", lines: [...] },   // expected_date null
  ],
  recent: [...],                     // status 'received', received_date >= today-13, newest first
  counts: { overdue: n, today: n },  // for the dashboard
}
```

Lines are `list()` rows (the order object plus `jobName`, `jobStage`). Inside a group: by expected date, job name (case-blind), id. `recent`: by received date descending, then id descending.

## 5. Routes (`routes/orders.js`)

| Method & path | Access (M10) | Was |
|---|---|---|
| `GET /api/job-records/:id/orders` | `jobs.view` | `jobs.view` |
| `POST /api/job-records/:id/orders` | `orders.edit` | `orders.edit` |
| `GET /api/orders/suppliers` | **`orders.view`** | `jobs.view` |
| **`GET /api/orders/deliveries`** (new; registered before `/orders/:id`) | **`orders.receive`** | — |
| `GET /api/orders` | **`orders.view`** | `jobs.view` |
| `PATCH /api/orders/:id` | **`["orders.edit","orders.mark_ordered","orders.receive"]`** | the first two |
| `POST /api/orders/:id/cancel` | `orders.edit` | `orders.edit` |

`routes/jobs.js` `POST /api/jobs/:id/materials-ordered` stays `orders.mark_ordered`.

## 6. `public/orderui.js` (B)

A plain script (`<script src="/orderui.js">` after `/shared.js` and the shell; its styles in `/orderui.css`, prefix `ou-`), using the shell's `cc-dialog*` dialogs as `taskui.js` does, `api()` for requests, `textContent` for every value. Every function resolves to the server's response (`{order, job}`) or `null` when the user cancels; a refused request shows its sentence inside the dialog and keeps it open. **Added at 4.3:** closing a dialog after the server refused a request resolves `{refused: true}`, and the page then reloads its list (the line was changed elsewhere); a plain cancel stays `null`.

```js
window.OrderUI = {
  // "Received": date (default today; min the ordered date; max today) and an optional delivery note.
  // One PATCH {status: "received", receivedDate, deliveryNote}.
  receive(line) -> Promise<{order, job}|null>,
  // "Delivery note": the note (empty clears it). PATCH {deliveryNote}.
  note(line) -> Promise<{order, job}|null>,
  // "Undo received": a confirm naming the line, then PATCH {status: "ordered"}.
  undoReceived(line) -> Promise<{order, job}|null>,
  // "Edit line": only the fields the user may change, by cc.can(): supplier, description,
  // expected date, notes (orders.edit); ordered date (orders.mark_ordered, ordered or received
  // lines); received date (orders.receive, received lines). Sends only what changed.
  edit(line) -> Promise<{order, job}|null>,
  // The line's delivery note for a table cell: a small block with "DELIVERY NOTE" (uppercase,
  // letterspaced, orange while the line is still ordered, the label grey once received), the
  // text, and who/when if known; null when there is no note.
  noteBlock(line) -> HTMLElement|null,
  // Which actions the user may take on a line, for building buttons:
  // {receive, note, undoReceived, edit, markOrdered, undoOrdered, cancel} booleans.
  actions(line) -> object,
};
```

## 7. Planner (`lib/planner/layers.js`, scaffold)

- `SEE_ROLES.workshop` gains `workshop_manager`. (Company and Install & hardware are everyone's already.)
- `POST_ROLES.install` gains `ordering`; `POST_ROLES.workshop` gains `workshop_manager`.
- `DEFAULT_ORDER` becomes `["accounts", "design_pm", "scheduling", "install", "workshop"]`, so an Ordering user's new event defaults to Install & hardware and a Workshop Manager's to Workshop.

## 8. Pages, menu and access (scaffold)

- `lib/pages.js`: `"/orders.html": "orders.view"` (was `jobs.view`), `"/deliveries.html": "orders.receive"`.
- `public/shell/shell.js`, the Ordering department: **Orders** (`/orders.html`, `orders.view`), **Deliveries** (`/deliveries.html`, `orders.receive`). Both inside the dropdown; the bar's width doesn't change.
- `public/users.js` `ROLE_LABELS`: `ordering: "Ordering"`, `workshop_manager: "Workshop Manager"`.
- What each new role sees in the bar: **Ordering**: Scheduling (Board), Design/PM (Design/PM, Jobs, Pipeline, Intake), Ordering (Orders, Deliveries), Photos, plus Planner, Tasks, Messages. **Workshop Manager**: Scheduling (Board), Ordering (Orders, Deliveries), plus Planner, Tasks, Messages.

## 9. The pages

All pass `node ci/style-check.js`, follow the house style (`tokens.css`, `components.css` `hs-`, the shell's `cc-dialog*`, `shared.js`), put user text in via `textContent`, hide every control the user can't use (via `OrderUI.actions()` / `cc.can()`), and have no horizontal page scroll at 375 px (wide tables scroll inside their own box). **A job name links to `/job.html?id=…#orders` only with `jobs.view`**; otherwise it is plain text (the Workshop Manager has no job pages).

### 9.1 `/deliveries.html` (B, prefix `dl-`)

- **Header:** "Deliveries", the date (`Tuesday 13 October`), **Print**.
- **The groups** from `GET /api/orders/deliveries`, in order, each a section with its label and count; an empty group is left out; when every group is empty, "Nothing on order."; Overdue's count and expected dates in orange.
- **Each line:** Expected, Job, Supplier, Description, Notes, the delivery note (`OrderUI.noteBlock`), and **Received** (primary) and **Delivery note** buttons (`OrderUI.receive`, `OrderUI.note`). After a change the page reloads the list and keeps focus on the next line's Received button (or the section heading).
- **Received recently** (the last 14 days): Received date, by, Job, Supplier, Description, delivery note, **Undo** (`OrderUI.undoReceived`).
- **Print** (`document.title` "Deliveries <d Mon yyyy>"): Overdue, Today and Next 7 days as a checklist (a blank tick box, expected date, job, supplier, description, delivery note), A4, black on white, between the `style-check: print-start` / `print-end` comments.

### 9.2 Orders page (C)

- Gated `orders.view` (the scaffold); a user without `jobs.view` sees job names as text.
- **A Received column** (the date and, under it, who), and the delivery note under the description (`OrderUI.noteBlock`).
- **Actions per line** from `OrderUI.actions()`: Mark ordered, Undo (ordered), **Received** (opens `OrderUI.receive`, replacing today's one-click stamp), **Delivery note**, **Undo received**, **Edit** (`OrderUI.edit`), Cancel. The Actions column shows when the user has any of `orders.edit`, `orders.mark_ordered`, `orders.receive`.
- Filters as now; the status filter gains nothing.

### 9.3 Job page Orders section (C)

The same: Received column, delivery notes, the same actions through `OrderUI`; the add-line form as now. The section stays under `jobs.view`. **At 4.3:** the job page is narrow, so each line's buttons sit in a full-width row under the line (no Actions column); the visible label for undoing an order is "Undo ordered" here and on the Orders page.

### 9.4 Dashboard (C)

For a user with `orders.receive`: a line beside the board summary, as the Accounts line: **"Deliveries: N due today · N overdue"** (the overdue part red only when it is not 0, as the Accounts line's `stat-overdue`), leading to `/deliveries.html`. Hidden when both are 0 ("Deliveries: nothing due today").

## 10. Tests and checks

### 10.1 `ci/smoke.sh` (scaffold)

- Lines asserting 23 keys (the setup user's perms and `/api/users/meta`) → **25**; `.roles` includes `ordering` and `workshop_manager`; `.presets.ordering` and `.presets.workshop_manager` equal §3 exactly.
- Users `ordr` (role `ordering`) and `wsmgr` (role `workshop_manager`) created after the M9 loop (so earlier suites never see the new roles), with jars `$ORDR` and `$WSMGR` and the must-change-password step as the others; `.user.roles == ["ordering"]` and `["workshop_manager"]` (migration 021 allows them).
- After the M9 loop and before the Backup suite: `for f in "$(dirname "$0")"/smoke-m10-*.sh; do [ -f "$f" ] && source "$f"; done`.
- Step k must still pass: the old app's database is migrated through 022 there.

### 10.2 `ci/smoke-m10-orders.sh` (A), `step "m10. new roles and receiving deliveries"`

M-suite rules (sourced, no shebang, no `set`, the shared helpers and jars, prefix `M10_`, no pristine-DB assumption, made-up names).
- **Access:** `/orders.html` ordr 200, wsmgr 200, acct 200, wshop 403, show 403; `/deliveries.html` wsmgr 200, ordr 200, dpm 200, acct 403, sched 403; `/job.html` wsmgr 403; `GET /api/orders` wsmgr 200, wshop 403; `GET /api/orders/deliveries` wsmgr 200, acct 403; `GET /api/job-records/<id>/orders` wsmgr 403.
- **Ordering places:** make a job (admin) with two lines (ordr: `POST` 201); wsmgr `POST` → 403; ordr marks line 1 ordered → 200, job's `materialsOrderedDate` still null; wsmgr marks line 2 ordered → 403; ordr marks line 2 ordered → the job's `materialsOrderedDate` is set and the job's progress invoice is due (as `smoke-m3-orders.sh` checks it).
- **Workshop Manager receives:** wsmgr `PATCH {status:"received", receivedDate:<before ordered>}` → 400 with the sentence; a future date → 400; `{status:"received"}` → 200, `receivedBy.name` is wsmgr's, `updatedBy` too; wsmgr edits `supplier` → 403; wsmgr cancel → 403; wsmgr `{deliveryNote:"M10 two of three boxes"}` on line 2 (ordered) → 200 and ordr's newest notification is `order.delivery_note` with the note in its body; sched has no such notification; a 501-character note → 400; a note on a `to_order` line → 409; receive line 2 → `materialsInDate` set, and **both** ordr and sched have a `materials.in` notice for the job; wsmgr undo received → 200, `receivedBy` null, the note kept.
- **Deliveries:** with a line expected yesterday (`PATCH expectedDate` by ordr) and one with none, `GET /api/orders/deliveries` has it in `overdue`, the other in `nodate`, `counts.overdue` ≥ 1, received lines in `recent`.
- **Planner:** wsmgr may post on `workshop` (201) and not on `install` (403); ordr may post on `install` (201) and not on `workshop` (403); wsmgr's layers include `workshop`; tidy the events.
- **Audit:** `order.status` rows for the line carry the actors.
- **Added at 4.3:** today from the server (`GET /api/orders/deliveries` `.date`); the deliveries set S-1 / S / S+7 / S+8 / none in exactly one group each, `counts.today`, recent at S-13 in and S-14 out, an archived job in no group; the note-notice rules (each change notifies, the same note or a clear doesn't, the writer is excluded, exactly 500 accepted, a non-string 400); both "already marked" 409s; a `receivedDate` alone before the ordered date 400; an ordered date after the received date 400; the move back clearing the note with its audit; `""` on a `to_order` line 200; the actor check on a third job; a cancel's `updatedBy`; sched `GET /api/orders` 200.

### 10.3 Pages (B, C) — local checks

As M9 §10.5 for pages: `node --check`, the style check, a shim boot, headless-Edge screenshots at 1440, 1100 and 375 (B: a busy Deliveries page, an empty one, the receive and note dialogs, print to PDF; C: the Orders page and the job section as admin, ordering, workshop manager (no job links), accounts (view only)), keyboard reach of every control and dialog, no console errors from page scripts. B runs against A's contract with stubbed responses; C runs in Wave 2 against the merged Wave 1 (real backend).

### 10.4 Screenshots (scaffold)

`shoot.js`: `["deliveries", "/deliveries.html", 1440, true]`, `["phone-deliveries", "/deliveries.html", 375, true]`, `["orders-1100", "/orders.html", 1100, true]`. `menu-shots.js`: the two roles added to both role lists.

### 10.5 Local checks (every task)

Docker isn't on the dev box, so smoke files get `bash -n` and the M9 smoke harness (`.dev/fix9-smoke/`: the real helpers under `set -Eeuo pipefail` with the docker emulation); every task: `node --check`, `node ci/style-check.js`, a shim boot on a fresh `.dev/<task>/` (`REMINDER_DISABLED=1 ROUNDUP_DISABLED=1 BACKUP_SCHEDULE_DISABLED=1 PLANNER_REMINDER_DISABLED=1`). In addition:
- **Scaffold:** 021 and 022 on a fresh `.dev/m10/` and on a copy of the latest local test database (pre-021 backup written, foreign keys ok, `user_roles` rows unchanged); users created with each new role (201) and their menus seen in the browser; the route matrix (every changed access value, the new route 501); `smoke.sh`'s changed lines run.
- **A:** a node replay of every §10.2 assertion against the shim, then the smoke harness on `smoke-m10-orders.sh` (fresh and again on the same DB), plus `smoke-m3-orders.sh` still passing.

## 11. Waves and file ownership

| Step | Who | Owns (only these files) | Starts after |
|---|---|---|---|
| **M10 · 2.2 Scaffold** | integrator | §1's scaffold rows | — |
| **M10 · 3.1 Wave 1, A: orders backend** | worktree | `lib/orders.js`, `routes/orders.js`, `ci/smoke-m10-orders.sh` | scaffold |
| **M10 · 3.1 Wave 1, B: order dialogs and Deliveries page** | worktree | `public/orderui.js`, `orderui.css`, `public/deliveries.{html,css,js}` | scaffold (stubbed responses) |
| **M10 · 3.2 Wave 2, C: Orders page, job section, dashboard** | worktree | `public/orders.{html,css,js}`, `public/job.js` (Orders section), `public/job.html` (if needed), `public/index.{js,html}` | Wave 1 merged on `main` |
| **M10 · 4.1 Integrate** | integrator | merges; §1's 4.1 docs and `seed.js`; STATUS; real-data checks of B and C | all |

Two waves, because C builds on B's `OrderUI` and A's real responses. Worktree base: each agent resets to the commit the integrator names, and junctions `crosscuts/app/node_modules` from the main checkout (with PowerShell `New-Item -ItemType Junction` if `cmd //c mklink` is refused). Scratch goes in the agent's scratchpad and is copied into `.dev/` by the integrator.

## 12. Points the integrator decided (Todd can change any)

1. **Two keys, not one:** `orders.view` (see lines without the job pages) and `orders.receive` (receive and delivery notes), so the Workshop Manager gets neither `jobs.view` (client details) nor `orders.edit` (adding, editing, cancelling) (Decision 2).
2. **`orders.view` is added to accounts, design_pm and scheduling**, who could already see orders through `jobs.view`, so nobody loses anything; Design/PM also gets `orders.receive`, so Aaron and Jordan still receive as today.
3. **Ordering's keys** follow the plan's §2.1: it also gets `jobs.view` and `design.view` (the job and its design when ordering) and so also the Joinr intake notices that go to `design.view` holders. Todd can trim `design.view` off with a revoke override, or from the preset.
4. **The delivery note** is one field per line, not a history; each change notifies Ordering. A received line keeps its note (it records what arrived short or damaged).
5. **A received date can't be before the ordered date**, as M9's paid date can't be before the issue date.
6. **The Deliveries page groups by expected date** (Overdue, Today, Next 7 days, Later, No date yet) and shows the last 14 days received, matching the Scheduling page's 14-day "Materials in" list.
7. **The dashboard line** shows for anyone with `orders.receive` (admin, Design/PM, Ordering, Workshop Manager).
8. **The workshop TV** stays on Sam's login (Decision 6); only docs change (4.1).
9. **Overrides set before M10 don't move with the split** (review 4.2): a per-user grant or revoke of `jobs.view` no longer decides who sees the Orders page, and one of `orders.edit` no longer decides who receives. No migration copies them: users are re-created by hand at cutover (cutover decision A), so only pre-cutover test users can have such overrides; `how-to-add-user.md` says to re-check them.
10. **The Workshop Manager's other reach** (review 4.2, for Todd's information): `tasks.use` shows the whole company task list (M4: every office user sees every task) and `board.view` the board's job names and notes. "No client details" covers the job pages.
