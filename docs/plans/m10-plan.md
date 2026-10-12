# M10 New roles: plan

Status: **M10 · 1.1 audit and 1.2 plan done (2026-10-13); questions put to Todd** (section 4).

Scope (Todd, 2026-10-12, `jobs-master-tabs.md`): two new roles, **Ordering** and **Workshop Manager** (a different person from the Scheduler), added together in one `user_roles` rebuild migration as M7's 017 did for `workshop`, with their keys and menus, and **receiving deliveries**: Ordering places orders, the Workshop Manager receives them. The ordering pages themselves (drawer, stock, paint orders, board stocktake) are M11.

This repo is public: no names of suppliers or clients, no account details.

## 1. Audit (M10 · 1.1, 2026-10-13)

### 1.1 Roles, keys and access

- **23 keys, six roles** (`lib/permissions.js:4-52`): admin, accounts, design_pm, scheduling, showroom, workshop. `admin` is every key (`[...KEYS]`), so it gets any new key, and every key-based notification, automatically. Overrides (grant or revoke per user) apply on top; `permission_overrides.feature_key` has no CHECK, so **a new key needs no migration; a new role does**.
- **`user_roles`** has a role CHECK. Migration **017** last rebuilt it (new table, copy, count and EXCEPT check, drop, rename, `foreign_key_check`), safe because nothing references `user_roles` (still true). The runner takes a `VACUUM INTO` backup first and runs each file in one transaction. A rebuild is **not additive**, so it needs Todd's sign-off (CLAUDE.md rule 5; 017 had it).
- **If `ROLES` and the CHECK disagree**, creating a user answers a misleading 409 "That username is already taken" (`routes/users.js` treats any constraint error as a clash) and a PATCH gives a 500. The migration and `ROLES` must change together.
- **Touch points for a role or key:** `lib/permissions.js`; the migration; `public/users.js` `ROLE_LABELS`; `lib/pages.js` gates; route access values (nothing checks a key exists: a misspelt key locks everyone out, admin included); the shell menu (`DEPARTMENTS`, one key per item, no "any of" form); the dashboard hint list (`public/index.js:57`); `lib/planner/layers.js` (see and post lists by role); `ci/smoke.sh` (two "23 keys" assertions and the exact workshop preset), per-role users and jars, `smoke-m3-orders.sh` and `smoke-m7-access.sh` per-role expectations; `docs/auth.md`, `docs/how-to-add-user.md`, `docs/how-to-add-feature-key.md` (stale in places: step 5's "department switcher", step 6's location, the missing count assertions); `tools/screenshots/menu-shots.js` role lists.
- **Per-role behaviour:** the Planner's layers are chosen by role name (`layers.js`); chat channels by role, with a CHECK allowing only accounts, design_pm and scheduling (`012`). A new Planner layer or a role-only chat channel means rebuilding `planner_events` or `channels`, both of which have child tables: riskier than 017. Notifications fan out by key (`lib/notify.js`).
- **Sessions:** permissions are re-read from the database on every request, so a role change takes effect at the next call; it doesn't sign anyone out.
- **The `workshop` role** is board.view and planner.view (the workshop TV and floor logins). It sees the board read-only and the Company, Install & hardware and Workshop Planner layers. It has no jobs.view, tasks or messages.
- **Nothing like an owner-only key exists yet** (M13).

### 1.2 Orders and receiving today

- **Order lines** (`010_design_pm.sql`): job, supplier (free text), description, status (`to_order`, `ordered`, `received`, `cancelled`, by CHECK), ordered, expected and received dates, notes. No `updated_by` or `received_by` (only the audit log knows who), no quantity, no reference, no link to M9's suppliers. Nothing references `orders`.
- **Who does what** (`lib/orders.js`):
  - **Mark ordered** (and its undo, and the ordered date) needs `orders.mark_ordered`, held by **admin only**: the brief's "Todd … the only orderer".
  - **Received** (and its undo, and the received date) needs `orders.edit`, which also adds, edits and cancels lines; held by admin and design_pm.
  - **Seeing orders** needs `jobs.view`, which also opens Jobs, Pipeline and the job page (client contact details).
- **When the last line of a job is marked ordered, the job's 50% progress invoice falls due** (`markMaterialsOrdered` → `invoices.onMaterialsOrdered`). So whoever holds `orders.mark_ordered` triggers invoices.
- **When every line is received**, the job's `materials_in_date` is set, the board's materials mark turns teal ("in"), the Planner shows "Materials in" on the Install & hardware layer, and **one** bell notice goes to `scheduling.view` holders (once per job, ever).
- **There's no partial delivery** (some lines in still shows "ordered"), no delivery note other than the line's general notes, and **no way in the pages to edit a line**, change an expected date or backdate a received date (the API allows them; "Received" always stamps today). The Orders page has no Received column. Lines without an expected date never show on the Scheduling page or the Planner.
- **The Ordering menu** (built in 0.1.10) holds one item, Orders, gated `jobs.view`, so it shows for admin, accounts, design_pm and scheduling (most can only look).
- **Board:** the materials mark is job-level, two states. Any new board state needs a rule-7 exception (CLAUDE.md), mirrored in the JPG export and print.

### 1.3 Stale or inconsistent

- **The brief lags the code:** §3.1–3.2 list five roles (no workshop, no Ordering or Workshop Manager) and name Todd as the only orderer. The brief wins, so M10 needs it updated with Todd's sign-off.
- **The workshop TV's account** is described two ways: Sam's own Scheduling login (`how-to-add-user.md`, `cutover.md`) and a separate account switched to Workshop (M7). Switching Sam's account to Workshop would strip his Scheduling role.
- `m1-contracts.md` still says 21 keys; `docs/auth.md` mentions keys "marked †" that aren't marked; `how-to-add-user.md` lists orders under Design/PM.

## 2. Proposed shape

### 2.1 Roles

- **`ordering`** ("Ordering"): places orders. Keys: board.view, jobs.view (to see the job and its design details when ordering), design.view, **orders.view**, orders.edit, **orders.mark_ordered**, tasks.use, messages.use, planner.view, planner.edit, photos.search.
- **`workshop_manager`** ("Workshop Manager"): runs the workshop floor and receives deliveries. Keys: board.view, **orders.view**, **orders.receive**, tasks.use, messages.use, planner.view, planner.edit. No jobs.view (no client details), no board.edit (the Scheduler's).
- One migration **`021_new_roles.js`**, a copy of 017's method, widening the CHECK to the eight roles.

### 2.2 Keys (23 → 25)

- **`orders.view`**: see order lines (the Orders page, `GET /api/orders`, suppliers list, the Deliveries page) without `jobs.view`. Added to every preset that has `jobs.view` today (accounts, design_pm, scheduling), so nobody loses anything; the Orders page and the Ordering menu item move to `orders.view`. The job page's Orders section stays under `jobs.view`.
- **`orders.receive`**: mark ordered → received, undo it, set the received date and the delivery note. `orders.edit` keeps implying it (design_pm and admin keep receiving).

### 2.3 Receiving deliveries

- **A Deliveries page** (`/deliveries.html`, in the Ordering menu, `orders.receive`): ordered lines grouped as **Overdue**, **Today**, **This week**, **Later** and **No date yet**, each with job, supplier, description and expected date; **Received** (today by default, or an earlier date), with an optional **delivery note** ("2 of 3 boxes", "side panel damaged"). Recently received (last 14 days) underneath, with Undo.
- **Additive columns on `orders`** (migration 021 too, or 022): `received_by`, `updated_by`, `delivery_note`. No new status (a status would mean rebuilding `orders`).
- **Short or damaged:** the line stays **ordered** with a delivery note until the rest arrives; Received when it's complete.
- **The Orders page** gains a Received column and a way to edit a line (expected date, notes, received date) for those allowed.
- **Notifications:** a delivery note on a line tells Ordering (`orders.mark_ordered` holders) straight away; "all materials in" also goes to Ordering, as well as Scheduling as now.
- **Board:** unchanged (no new state; rule 7).

### 2.4 Menus, Planner, chat

- **Ordering menu:** Orders (`orders.view`), **Deliveries** (`orders.receive`). M11's drawer, stock and paint orders join it later.
- **Planner:** no new layer. Ordering sees and posts on **Install & hardware** (the orange layer, the Ordering colour in the menu); the Workshop Manager sees Company, Install & hardware and Workshop, and posts on **Workshop**.
- **Chat:** no new channel (a role channel means rebuilding `channels`); both roles use All.
- **Dashboard:** the Workshop Manager's home shows deliveries due today and overdue.

### 2.5 Building it

- `lib/permissions.js` (two roles, two keys), `021_new_roles.js`, the orders columns, `lib/orders.js` transition rules, `routes/orders.js` access values, the Deliveries page, the Orders page changes, `public/users.js` labels, `lib/planner/layers.js`, the dashboard, smoke (key and role counts, a `smoke-m10-*.sh` for both roles and receiving), the docs (`auth.md`, `how-to-add-user.md`, `how-to-add-feature-key.md` refreshed, a `how-to-receive-deliveries.md`), and the brief's §3.
- Version 0.1.13.

## 3. Lead's defaults (not asked; Todd can change any)

1. **Role ids** `ordering` and `workshop_manager`; labels "Ordering" and "Workshop Manager".
2. **Keys** `orders.view` and `orders.receive`, added to existing presets only where nobody loses access (section 2.2).
3. **No new Planner layer and no new chat channel** (both need rebuilds of tables with child tables).
4. **No new order status;** the delivery note carries short or damaged.
5. **Board unchanged.**
6. **Design/PM keeps** adding, editing and receiving order lines, as today.
7. **The TV:** M10 doesn't change it; the docs are corrected to one account once Todd says which (question 6).

## 4. Questions for Todd

1. **Who marks things ordered?** Today only Todd can, and marking a job's last line ordered makes its 50% progress invoice fall due. Recommended: the Ordering role marks ordered, and the invoice trigger stays with it (the trigger is the business event, not the person). The brief's "Todd is the only orderer" changes.
2. **The Workshop Manager's reach.** Recommended: the board to view (not edit; that stays the Scheduler's), orders to view and receive, Planner (posting on Workshop), tasks and messages; **not** the job pages (client details). Or also job pages, or also board editing.
3. **Short or damaged deliveries.** Recommended: the line stays "ordered" with a delivery note until it's all in, and the note tells Ordering. The alternative is a "part received" status (a rebuild of the orders table).
4. **Who is told when deliveries arrive?** Recommended: when all of a job's materials are in, Scheduling (as now) and Ordering; a delivery note tells Ordering straight away.
5. **Sign-off:** migration 021 rebuilds the roles table (as 017 did), and the brief's §3 is updated with the new roles. Approve?
6. **The workshop TV:** does it sign in with Sam's own login or a separate account? (The docs say both.)

## 5. Decisions

(To be filled in at M10 · 1.3.)
