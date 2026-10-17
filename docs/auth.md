# How login works

The reference for Crosscuts' logins, sessions, roles and enforcement. `docs/plans/m1-contracts.md` is the source of truth. If this page disagrees with it, the contract wins and this page needs fixing.

## Sessions

- Cookie `crosscuts_sid`: HttpOnly, SameSite=Lax, no Secure flag (the LAN and Tailscale addresses are plain http).
- **Default:** 12 hours from login.
- **"Remember this device":** 30 days, sliding. Each use extends it (refreshed at most every 5 minutes).
- Logout, disabling a user, a password reset, or "sign out everywhere" ends sessions.
- **Lock** keeps the session but hides the screen until unlocked with PIN or password.

## PIN

- Optional, 4 to 6 digits. Set or clear it from the user menu, with the current password.
- Works only on a device that logged in with a password and "Remember this device", and only to unlock that device's locked session. Never on a fresh browser, after logout, or on a non-remembered session.
- 5 wrong PINs on one device disable PIN on that device until the next password login.
- 10 wrong PINs for one user within an hour disable PIN for that user until the next password login.

## Passwords and lockout

- A password a user chooses must be at least 8 characters.
- 10 failed logins for one username from one IP within 15 minutes triggers a lockout (HTTP 429 with a retry time).
- 30 failed password attempts from one IP within 15 minutes, across any usernames, also trigger a lockout (HTTP 429 with a retry time).
- An attempt is recorded in `auth_attempts` before the password is checked and marked successful afterwards, so a burst of simultaneous guesses counts against the limits while it is still running. Attempts are also written to the audit log.
- At most 4 password or PIN checks run at once across the whole app. Beyond that the server answers `429 {"error":"Busy, try again","retryAfterSec":2}` and records no attempt.
- Changing your own password signs out your other sessions and forgets your other remembered devices.

## Roles and feature keys

A role is a preset: a set of feature keys. A user's effective permissions are the union of their roles' keys, then each override is applied. A **grant** adds a key; a **revoke** removes it. Unknown keys in overrides are refused (400).

`accounts.view`, `invoices.edit` and `orders.mark_ordered` went live in M2 (Accounts): see `docs/plans/m2-contracts.md`. `design.view`, `orders.edit` and `inspections.edit` went live in M3 (Design/PM), and `jobs.view` now also opens the Pipeline and Orders pages: see `docs/plans/m3-contracts.md`. `tasks.use`, `messages.use` and `reports.upload` went live in M4 (Collaboration), and `accounts.view` now also opens the report library: see `docs/plans/m4-contracts.md`. `leave.edit` went live in M5 (Scheduling extras), and `scheduling.view` then also opened Availability and Lookahead: see `docs/plans/m5-contracts.md`. **Changed 2026-10-16 (Todd):** the Scheduling and Lookahead pages (and `/api/scheduling/*`) are removed; Availability moved to the Admin menu and `/availability.html` and every `/api/availability` route (read and write) now need `users.admin`. The board still shows away chips, over-days and the "+" picker warning, because it reads them from `/api/schedule`, not from `/api/availability`. `scheduling.view` stays as a key (it still gets the inspection and "materials in" alerts and lets a login book inspections on the job page) and `leave.edit` is kept but no route uses it any more. M6 (Joinr intake) adds no key: the inbox needs `design.view`, accepting/linking/ignoring and Sync now need `jobs.edit`, and the Joinr connection settings and the one-off import need `users.admin`: see `docs/plans/m6-contracts.md`. Backup adds no key: its section on the Users page and its routes (`/api/backup/status`, `/api/backup/run`) need `users.admin`: see `docs/plans/backup-contracts.md`. M7 (Staff planner) adds `planner.view` and `planner.edit` and the **workshop** role (`board.view` and `planner.view` only). Which planner layers a person sees and posts to is decided by their **roles**, not their keys (`lib/planner/layers.js`): see `docs/plans/m7-contracts.md` section 5. M8 (Pay runs) adds no key: the pay-run pages and `/api/payruns` use the Accounts keys (`accounts.view` reads, `invoices.edit` writes), and reopening a finalised pay run needs `users.admin`: see `docs/plans/m8-contracts.md`. M9 (BAS sales and supplier accounts) adds no key: the BAS and supplier pages and `/api/bas` and `/api/suppliers` use the Accounts keys (`accounts.view` reads, `invoices.edit` writes; a supplier statement file downloads with `accounts.view`), and reopening a lodged BAS month needs `users.admin`: see `docs/plans/m9-contracts.md`. M10 (New roles) adds `orders.view` (see order lines without the job pages: the Orders page, `GET /api/orders`, the Ordering menu; the job page's Orders section stays under `jobs.view`) and `orders.receive` (receive a line, undo it, change its received date, write a delivery note; the Deliveries page), and the **ordering** and **workshop_manager** roles. Ordering marks lines ordered, so marking a job's last line ordered makes its progress invoice due: see `docs/plans/m10-contracts.md`. M11 (Ordering pages) adds `stock.count` (type Have on the monthly stock order and quantities on the board stocktake, and see those lists without board prices) and `stock.order` (keep the stock, paint and board lists and the drawer name list, set board prices, type the stock order, run the Drawer order page and paint orders, confirm the board stock value [that step was removed on 2026-10-17 at Todd's request: `stock.order` no longer covers confirming a board value, there is no board value to confirm, and a board count is finished once it is counted]), making **27 keys**: see `docs/plans/m11-contracts.md`. No role is added, but the Ordering preset gains both keys and the Workshop Manager preset gains `stock.count` (admin holds every key); no migration is needed for a key. The pages and what gates them are in "Ordering pages" below. M12 (Design/PM tools) adds no key and changes no role or preset (still 27 keys): the Stone orders page and the Batten calculator need `design.view`, a job's stone orders are seen and printed with `jobs.view` and changed with `jobs.edit`: see `docs/plans/m12-contracts.md` and "Design/PM tools" below. M13 (Owner-only) adds `bonuses.manage`, `alarms.manage` and `loans.manage`, making **30 keys**. They are the **owner-only keys**: the admin preset is every key **except** these three (still 27), no other preset has them, and only the owner holds them unless the owner grants one to someone: see `docs/plans/m13-contracts.md` and "The owner and owner-only keys" below. Department notes add five keys, `notes.scheduling`, `notes.design`, `notes.ordering`, `notes.accounts` and `notes.admin`, making **35 keys**: each opens that one department's weekly Notes page and nothing else (the page, `/api/notes` for that department, and the Notes item first in the department's menu). Presets: Scheduling has `notes.scheduling`, Design/PM `notes.design`, Ordering **and** Workshop Manager `notes.ordering`, Accounts `notes.accounts`; Admin has all five; Showroom and Workshop have none. An admin can grant or revoke any of them per person on the Users page. They are ordinary keys, so the admin preset is now 32 keys (the 35 less the three owner-only keys). See `docs/plans/notes-contracts.md`.

| Feature key | Admin | Accounts | Design/PM | Scheduling | Showroom | Workshop | Ordering | Workshop Manager |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `board.view` | Yes | Yes | Yes | Yes | | Yes | Yes | Yes |
| `board.edit` | Yes | | | Yes | | | | |
| `workers.edit` | Yes | | | Yes | | | | |
| `jobs.view` | Yes | Yes | Yes | Yes | | | Yes | |
| `jobs.edit` | Yes | | Yes | | | | | |
| `jobs.value` | Yes | Yes | Yes | | | | | |
| `photos.search` | Yes | Yes | Yes | Yes | Yes | | Yes | |
| `photos.admin` | Yes | | Yes | | | | | |
| `accounts.view` | Yes | Yes | | | | | | |
| `invoices.edit` | Yes | Yes | | | | | | |
| `reports.upload` | Yes | Yes | | | | | | |
| `design.view` | Yes | | Yes | | | | Yes | |
| `orders.edit` | Yes | | Yes | | | | Yes | |
| `orders.mark_ordered` | Yes | | | | | | Yes | |
| `inspections.edit` | Yes | | Yes | | | | | |
| `scheduling.view` | Yes | | Yes | Yes | | | | |
| `leave.edit` | Yes | | | Yes | | | | |
| `tasks.use` | Yes | Yes | Yes | Yes | | | Yes | Yes |
| `messages.use` | Yes | Yes | Yes | Yes | | | Yes | Yes |
| `planner.view` | Yes | Yes | Yes | Yes | | Yes | Yes | Yes |
| `planner.edit` | Yes | Yes | Yes | Yes | | | Yes | Yes |
| `users.admin` | Yes | | | | | | | |
| `audit.view` | Yes | | | | | | | |
| `orders.view` | Yes | Yes | Yes | Yes | | | Yes | Yes |
| `orders.receive` | Yes | | Yes | | | | Yes | Yes |
| `stock.count` | Yes | | | | | | Yes | Yes |
| `stock.order` | Yes | | | | | | Yes | |
| `bonuses.manage` | | | | | | | | |
| `alarms.manage` | | | | | | | | |
| `loans.manage` | | | | | | | | |
| `notes.scheduling` | Yes | | | Yes | | | | |
| `notes.design` | Yes | | Yes | | | | | |
| `notes.ordering` | Yes | | | | | | Yes | Yes |
| `notes.accounts` | Yes | Yes | | | | | | |
| `notes.admin` | Yes | | | | | | | |

The three owner-only keys (M13: `bonuses.manage`, `alarms.manage`, `loans.manage`) are held by no preset, admin included. The owner holds them, with every other key, and can grant one to someone else.

### Ordering pages (M11)

| Page | Menu | Needs |
|---|---|---|
| `/drawers.html` (Drawer order) | Ordering | `stock.order` |
| `/stock.html` (Stock order) | Ordering | `stock.count` or `stock.order` |
| `/boards.html` (Board stocktake) | Ordering | `stock.count` or `stock.order` |
| `/paint.html` (Paint order) | Ordering | `stock.order` or `orders.receive` |

The menu entries are by key: Drawer order and Paint order show for `stock.order`, Stock order and Board stocktake for `stock.count`. So the Workshop Manager sees Orders, Deliveries, Stock order and Board stocktake under Ordering, and no Drawer order or Paint order. Someone with only `orders.receive` (the Workshop Manager, and Design/PM) can still open a paint order from a link on Deliveries, to read it and mark it received.

What the keys and the keys already there decide on these pages:

| Action | Key |
|---|---|
| Type Have on the stock order; type board quantities; finish either count | `stock.count` |
| Edit the stock, paint and board lists, board prices and the drawer name list; type the stock order's Order column; mark a stock supplier group ordered; reopen a stock count or a board count | `stock.order` |
| See board prices (on the board list) | `stock.order` (the Workshop Manager and everyone else get no price in the answer) |
| Add or edit a job's drawer grid; fill or refill it from Joinr | `orders.edit` |
| Check or uncheck a drawer grid | `jobs.edit` |
| Use the Drawer order page; set the drawer supplier names; set the litres factor | `stock.order` |
| Place a drawer order, undo one, mark a paint order with job lines ordered (or undo that) | `stock.order` and `orders.mark_ordered` |
| Receive a stock supplier group, a paint order, a drawer order's stock row (and undo it) | `orders.receive` |

Drawer lines and paint job lines are ordinary order lines, so `orders.view` shows them. A drawer line can't be marked ordered from the Orders page, and once it is on a placed drawer order it can't be taken back to To order there either (only **Undo order** on the Drawer order page does that). A paint job line can't be changed there at all. Both kinds are managed from the Drawer order and Paint order pages.

### Design/PM tools (M12)

| Page | Menu | Needs |
|---|---|---|
| `/stone.html` (Stone orders) | Design/PM | `design.view` |
| `/tools.html` (Tools: tiles for the tools) | Design/PM | `design.view` |
| `/battens.html` (Batten calculator, opened from Tools) | Design/PM (lights up Tools) | `design.view` |
| `/stoneprint.html` (stone order and benchtop sheet prints) | none (from the job and the Stone orders page) | `jobs.view` or `design.view` |

| Action | Key |
|---|---|
| See a job's stone orders (its Benchtops section), print them and its benchtop sheet | `jobs.view` |
| See the Stone orders list, the Design/PM tile's stone counts, and print a blank benchtop sheet | `design.view` (the blank sheet also with `jobs.view`) |
| Make, change, mark sent, cancel or restore a stone order; the supplier and brand suggestions | `jobs.edit` |

So Ordering (with `design.view` and `jobs.view`, without `jobs.edit`) reads and prints stone orders but can't change them, and Accounts and Scheduling see and print them from the job page only. A stone order is not an order line: `orders.*` keys play no part, and it never affects the progress invoice.

### The owner and owner-only keys (M13)

Approved by Todd 2026-10-16 (`docs/plans/m13-plan.md` §5, `docs/plans/m13-contracts.md` §3).

**The owner** is one login, marked on the login (`users.is_owner`), not a role. Migration 026 marked the first-run setup user (Todd); from then on first-run setup marks the first admin. In normal use there is exactly one owner, and the owner is an enabled admin: the guards below keep it that way (one edge case is under "A database with no owner"). The Users page shows an **OWNER** mark by the owner's name.

**What the owner holds:** every key (all 35), whatever their roles and overrides. Overrides don't apply to the owner ("The owner holds every key, so overrides don't apply", 409). The admin preset is every key except the three owner-only ones, so another admin has 32.

| Key | Opens | Menu |
|---|---|---|
| `bonuses.manage` | `/bonuses.html` and `/bonusprint.html`: job bonuses, the rate and share points, confirming, paying, the owed summary and the prints ([how-to-bonuses.md](how-to-bonuses.md)) | Admin, Bonuses |
| `alarms.manage` | `/alarms.html`: alarm slots and codes (Show), the alarm company, the weekly times; the leavers line on the dashboard ([how-to-alarm-codes.md](how-to-alarm-codes.md)) | Admin, Alarms |
| `loans.manage` | `/loans.html` and `/loanprint.html`: loans, rates, repayments and the statement ([how-to-loans.md](how-to-loans.md)) | Accounts, Loans |

**Only the owner** (each refusal is a 403 with this sentence):

| Action | Refused for anyone else with |
|---|---|
| Change the owner's login (display name, roles, disable, overrides) | "Only the owner can change the owner's login" |
| Reset the owner's password | "Only the owner can reset the owner's password" |
| Sign the owner out everywhere | "Only the owner can sign the owner out" |
| Grant or revoke an owner-only key, for anyone (themselves included) | "Only the owner can grant or revoke <key>" |
| Reset the password of a login that holds an owner-only key **by a grant override** | "Only the owner can reset the password of someone holding <key>" |
| Hand over ownership | "Only the owner can hand over ownership" |

The password rule for holders is Todd's (2026-10-16): otherwise another admin could reset, say, an Accounts login granted `loans.manage` and sign in as them to read the loans. Disabling such a login, or signing it out, stays open to any admin, because that only takes access away. A revoke override doesn't count as holding the key.

The owner can't disable themselves or remove their own admin role (the existing self rules), and nobody else may act on the owner, which is what keeps exactly one enabled-admin owner.

**Handing over ownership** (`POST /api/users/:id/owner`): on the Users page, the owner opens another **enabled admin** and presses **Transfer ownership**, types that person's username and their own password, then **Transfer**. The new owner gets every key. The old owner stays an admin with the admin preset's 32 keys (plus any grant override left from before), and gets an owner-only key back only if the new owner grants it. No sessions end. It writes a `user.owner` audit row. Refusals: "You're already the owner", "The new owner must be an enabled admin", "Type <username> to confirm", "That password isn't right".

**The audit log:** rows about bonuses, alarms and loans (entity types `bonus`, `bonus_settings`, `alarm_slot`, `alarm_company`, `alarm_times`, `loan`) are shown only to someone holding the matching key, so the owner sees them all and other admins see none of them. They're left out of the count, and their action names (such as `bonus.confirm`) aren't offered in the filter either. Asking for them by entity type gives an empty list, not a refusal. The rows keep their before and after values for the key holders, except alarm codes, which never enter the log (a code change says "set", "changed" or "cleared"; a Show names the slot only). Rows about the users themselves (`user.override` naming an owner-only key, `user.owner`) are ordinary user rows, seen by everyone with `audit.view`. The list of private entity types is `PRIVATE_ENTITY_TYPES` in `lib/audit.js`. **Department notes (Todd, 2026-10-17):** rows about a note (entity type `dept_note`: `note.create`, `note.update`, `note.remove`, `note.ack`, `note.unack`) are shown only to readers who hold that note's department key (`notes.<dept>`); to everyone else they are left out of the rows and the count, like the private types above.

**No notices, tasks, comments or Planner items** come from these three areas (the admin role sees all of those). The only prompt is the alarm leavers line, on the Alarms page and on the dashboard of whoever holds `alarms.manage`.

**What this doesn't protect** (stated plainly, as the plan does):
- **Anyone with the Umbrel itself, or the backup passphrase, can read the database:** bonuses and loans in plain, and the alarm codes too, because the alarm code key file sits beside the database in `data/config/` and goes into the same backup archive. The guards protect the figures **inside Crosscuts** only. The code encryption protects the codes in the plain pre-migration copies on the Umbrel and in the database file on its own.
- A non-owner admin can still disable a holder of an owner-only key, or sign them out, and can use every other part of Crosscuts as before.

**A database with no owner, or a disabled owner,** can only be one that had no enabled admin when migration 026 ran, which the last-admin rule has prevented since M1. (026 then falls back to the earliest admin even if disabled, so the owner is a disabled login.) Either way nobody can use the owner-only keys and every "only the owner" guard refuses everyone, even re-enabling a disabled owner. There is no "claim ownership" button: fixing it is a hand step on the Umbrel for Todd (one `UPDATE` setting `is_owner = 1` on one enabled admin), with Claude, after a backup.

### Planner layers

The Planner (M7) has seven layers. `planner.view` is needed to see any of them and `planner.edit` to add, change or delete anything; beyond that, the layers follow a person's **roles**, and a key override never adds a department layer. "Admin" here means the admin role. Someone with several roles gets every layer any of their roles gives.

| Layer | Who sees it | Who adds to it | Who changes or deletes an event |
|---|---|---|---|
| Company-wide | everyone | everyone | the person who added it, and admin |
| Install & hardware | everyone | Design/PM, Scheduling, Ordering, admin | Design/PM, Scheduling, Ordering, admin |
| Accounts | Accounts, admin | Accounts, admin | Accounts, admin |
| Design/PM | Design/PM, admin | Design/PM, admin | Design/PM, admin |
| Scheduling/Production | Scheduling, admin | Scheduling, admin | Scheduling, admin |
| Workshop | Scheduling, Workshop, Workshop Manager, admin | Scheduling, Workshop Manager, admin | Scheduling, Workshop Manager, admin |
| Personal | only its owner (not even admin), and only with `planner.edit` | anyone with `planner.edit`, for themselves | only its owner |

An **Ordering** user's new events default to Install & hardware, a **Workshop Manager**'s to Workshop (M10). A **workshop** login (workshop staff) sees Company-wide, Install & hardware and Workshop, read-only, and has no Personal layer. **Showroom** has no planner. Someone given `planner.view` by an override with no planner role sees Company-wide and Install & hardware only; with `planner.edit` as well, they can also add to Company-wide and have a Personal layer. On a department layer, edit rights follow the role a person holds now: someone who leaves the department can no longer change its events. Because layers follow roles, revoking `accounts.view` from someone with the Accounts role still leaves the automatic invoice items on their Accounts layer, without links to the invoices.

### Names on job tiles

A login can be linked to a board worker (Users page, **Board worker**; `users.admin`; one login per worker). Anyone with `jobs.edit` adds or removes their **own** name on a Pipeline job (`POST` and `DELETE /api/job-records/:id/people`); `users.admin` can remove anyone's. Everyone with `jobs.view` sees the names, so Scheduling and Accounts see them read-only. No new feature key. See `docs/plans/m3-contracts.md` section 14.

Known M1 limit: the board does not hide edit controls from view-only users. The server refuses their edits with a 403.

## Enforcement

Enforcement is on the server. Screens only hide things for convenience.

- **API routes:** each route declares its access in `defineRoutes`.
  - Not logged in: `401 {"error":"Not logged in"}`.
  - Locked: `401 {"error":"Locked","locked":true}`.
  - No permission: `403 {"error":"Forbidden"}`.
- **HTML pages:** checked before the file is served. The list is in `lib/pages.js`. Unlisted `.html` pages need only a login.
  - Not logged in, or locked: `302` to `/login.html?next=<page>`.
  - No permission: a `403` page.
- **Photo images:** any login, otherwise `401`.
- **Always open:** `/healthz`, the login and setup pages and their assets, and the auth calls for login, setup, unlock and logout.

## CSRF

Cookies are SameSite=Lax. Every non-GET request must also send an `Origin` header matching `Host`. A mismatch gets `403`.

## First admin

`/setup.html` creates the first admin and logs them in with "remember" on. It works only while there are no users. After that, `/api/auth/setup` returns 404. From M13 the first admin is also marked **the owner** (above).

## Why scrypt

Passwords and PINs use Node's built-in `crypto.scrypt` (N=2^15, r=8, p=1). The parameters are stored with each hash, so they can be raised later. This departs on purpose from the brief's bcrypt-or-argon2 suggestion: those need a native package that could break the multi-arch build or the Windows dev box.

## If the admin forgets a password

There is **no email reset.**

- Another admin can reset the password on the Users page. The user must change it at next login, and their sessions end.
- **Except (M13):** only the owner can reset the owner's password, and the password of a login holding an owner-only key by a grant override. Another admin sees "Only the owner can reset this password (they hold <key>)." in place of the reset box.
- **So if the owner forgets their password, no other admin can reset it in the app.** Keep the owner's password in the password manager.
- **Recovering a forgotten owner password** is the same hand step as "A database with no owner" above, with Claude, after a backup: on the Umbrel, one `UPDATE` moves `is_owner` to another enabled admin; that admin resets the old owner's password on the Users page; then the old owner signs in and takes ownership back with **Transfer ownership** from the other admin's login (or the same `UPDATE` in reverse).
- **A second admin account** still keeps the rest of Crosscuts running if the owner is locked out, and is needed for that hand step, but it **can't reset the owner's password** by itself.

## Password expiry

A password lasts six months. At the first sign-in after that, the user must choose a new one before Crosscuts shows anything else. Sessions that are already signed in, such as the workshop TV, keep working: the check happens only at sign-in. Changing a password signs that person out on their other devices.

While a password change is pending, the server refuses every API call except who-am-I, the change itself and lock (403, `mustChangePassword`), so the rule holds even outside the browser.
