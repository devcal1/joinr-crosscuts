# Crosscuts — Project Brief for the Build Agent (as of 2026-10-10)

This document is the scaffold for building **Crosscuts**: one self-hosted
app, one login, several department dashboards that share data. It is the
successor to the existing TH Cabinets Umbrel app, built **as a separate,
standalone app in its own repo**, so the live schedule board is never
disrupted. The two run side by side until Crosscuts is functional, then the
business switches over. This brief records the decisions the owner (Todd) has
already made, so you don't re-ask them, and names the questions you are
expected to answer in your milestone plans.

**Read first, in this order:** [`CLAUDE.md`](../CLAUDE.md) (engineering
rules and release history), [`README.md`](../README.md) (user-facing
behaviour), [`docs/agent-briefing.md`](agent-briefing.md) (state of the app
and the open threads as of 2026-10-09). Where this brief conflicts with any of
those, **this brief wins** — several long-standing rules are deliberately
relaxed in §7, and §0 changes where the code lives.

---

## 0. Standalone build — how the repos and apps relate

- **The existing app (`thcabinets-splash`, repo `thcabinets-umbrel-store`) is
  frozen.** Do not change its code, manifest, image or data. It keeps running
  the live board on the workshop TV until cutover. Bug fixes there only if
  Todd asks.
- **Crosscuts is a new Umbrel app in a new repo.** Todd will create the repo
  when the build begins. Start it as a **copy of the current repo** (the
  `thcabinets-splash/app` code, CI workflow and store layout), then rename:
  app id `crosscuts`, a new port (4090 is taken), a new image
  `ghcr.io/devcal1/crosscuts-web`, its own `umbrel-app.yml`. Decide with Todd
  whether the new repo is a second community store or a second app inside a
  copy of the store — either way the installed `thcabinets-splash` app is not
  touched.
- **Both apps run on the Umbrel at once** during the build. Crosscuts is
  installed from its own store entry and seeded with a **snapshot** of the
  live data (DB + uploads) for realistic testing. The old board stays the only
  authoritative schedule until cutover; staff are not asked to use Crosscuts
  for real work before then.
- **Keep the on-disk layout identical** to the old app (`data/db/photos.db`,
  `data/uploads/`, `data/config/`) so cutover is a file copy, not a
  conversion. Crosscuts' migrations run against that copied file at first boot.
- **Cutover is a planned release with a runbook** (§9a): snapshot the live
  data, stop edits on the old board, copy the data volume into Crosscuts, run
  migrations, verify the board matches, point Sam's Chromebook (and the TV) at
  Crosscuts, then disable or uninstall the old app only after Todd confirms.
  Until then the old app is the fallback.
- The uncommitted `/api/tags` WIP in the old working tree: decide with Todd
  whether to carry it into the copy or leave it behind. It no longer blocks
  anything.

**How you work with the owner:** plan → approve → build, one milestone at a
time. Write a plan for the milestone, get Todd's approval, build and ship it,
then plan the next. Pause for anything touching stored data, and for any
genuine ambiguity. **Never push without being told.** Todd is creative
director and owner; you are technical lead. Liaise in plain English.

---

## 1. The vision in one paragraph

Today the app is a schedule board on a workshop TV plus a photo library.
Crosscuts turns it into the office's day-to-day operations hub: every job has
a record from first enquiry to final payment; accounts can see what is
invoiced and paid at a glance; design/PM runs the pipeline and orders
materials; scheduling keeps running the board it already runs, with better
information layered on. Each person logs in as themselves and sees only what
their role allows. It stays on the LAN, works without the internet, and is
reachable from home over Tailscale.

## 2. Decisions already made (do not re-open without a strong argument)

| # | Decision | Notes |
|---|---|---|
| D0 | **Standalone build.** Crosscuts is a new Umbrel app in a new repo, started from a copy of the current one. The installed TH Cabinets app is frozen and keeps running the live board until a planned cutover. | See §0 and §9a. |
| D1 | **Name:** Crosscuts | New app id `crosscuts`, new port, new image. Same on-disk data layout as the old app so cutover is a copy. |
| D2 | **One app, not several.** Single container, single login, single SQLite DB. Departments are sections inside it. | Keep department code in separate modules so a split is *possible*, not planned. |
| D3 | **Crosscuts owns jobs.** The job record lives here. Joinr (the owner's cloud quoting SaaS) will later *feed* accepted quotes in; it is not the source of truth. | Every job carries `source` (`manual` / `joinr` / `board_quick_add`) and `external_ref` (Joinr quote id). |
| D4 | **The OR-Tools Workshop Scheduler is out of scope.** The scheduling section is the current board plus the improvements in §5.3. | Do not design against the solver; just don't do anything that would make a future hand-off harder (see §8 data-model rules). |
| D5 | **Everything behind a personal login**, including the schedule board and the showroom photo search. | The TV mirrors Sam's Chromebook, which stays logged in all day. Crosscuts has no Umbrel proxy-auth whitelist at all, so the "new path breaks the TV" trap does not exist in it. |
| D6 | **Role presets + per-person overrides.** | Assigning a role sets defaults; individual feature switches can be flipped per user. |
| D7 | **Username + password, admin-managed.** Todd creates users and resets passwords. Optional **PIN**, valid only on a device that has already logged in with a password. | No email anywhere in the system, so there is no self-service reset. Todd is the single point of failure for logins — accepted. |
| D8 | **Long-lived sessions**: "remember this device" ≈ 30 days. | Required so the organiser's Chromebook never logs out mid-day. |
| D9 | **No outbound email, ever.** Notifications are in-app, plus ntfy push to Todd's phone, plus a weekly in-app/ntfy invoice round-up. | An internal messaging system replaces email digests. |
| D10 | **Accounts holds dollar amounts.** Job value, invoice amounts, paid dates. | MYOB stays the book of record; Crosscuts is the operational view. **Changed by Todd 2026-10-10: Crosscuts issues the tax invoices (numbered, PDF); accounts re-key them into MYOB, which keeps the books. See `docs/plans/m2-plan.md` §10.** |
| D11 | **Invoice schedule:** 10% when first scheduled, 50% when Todd flags materials ordered, 40% + extras on completion. | Stages: deposit, progress, final, variations/extras. "Invoiced" and "paid" are marked by hand. |
| D12 | **No MYOB integration now**; keep a slot for an external invoice id so a read-only MYOB link can be added later. | 2026-10-10: still no MYOB link; issued invoices are re-keyed by hand, and Crosscuts tracks "Entered in MYOB". |
| D13 | **Board layout unchanged.** Two panels, one week, as today. New data appears as small indicators only. | Lowest risk to the live board. `exportJpg` mirror rule still applies to any new indicator. |
| D14 | **Only Design/PM creates jobs and moves lifecycle stages**, but the board keeps a **quick-add** that creates a minimal job at "ready to cut". | Design/PM fills the rest in later. |
| D15 | **Production stage is captured at Finish week only** (extend the existing dialog), not live. | Stages: cut & edge, kit, assemble, inspect, paint, install, return visit. |
| D16 | **Tailscale is just the pipe.** Same app, same login on LAN and Tailscale; no LAN-only features; no Tailscale-identity login. | Test both. |
| D17 | **Backup: weekly to the offsite NAS over Tailscale.** Documented restore. | Todd supplies NAS details. Not Backblaze. |
| D18 | **Audit log** from milestone 1. | Who changed what, when; jobs, invoices, payments, permissions, logins. |
| D19 | **Hygiene fixes ship inside milestone 1:** `package-lock.json`, vendored Inter font, Sydney timezone default. | Not a separate release. |
| D20 | **All former non-negotiables are negotiable** (framework, build step, single `server.js`, single DB, page-local CSS). See §7 for the recommended position. | Argue for any change explicitly in the plan. |

## 3. Users and permissions

### 3.1 People

| Person | Role preset(s) | Notes |
|---|---|---|
| Todd | Admin | Everything. Creates users, resets passwords, flips overrides. **The owner** (M13): also the only holder of the three owner-only keys (bonuses, alarm codes, loans), and the only one who can change his own login (approved by Todd 2026-10-16; M13). |
| Chloe | Accounts | Day-to-day bookkeeping. |
| Tracy | Accounts | Monthly reconciliation. |
| Jill | Accounts | Debt chasing / overdue invoices. |
| Aaron | Design/PM + Scheduling | Office. |
| Jordan | Design/PM + Scheduling | Office. |
| Sam | Scheduling | The organiser. His Chromebook drives the workshop TV. |
| Michael | Scheduling | Same permissions as Sam. |
| Showroom | Showroom (view photos only) | A shared account for the showroom device, since the photo search is now behind login. |
| Ordering (M10) | Ordering | Places orders and marks order lines ordered; marking a job's last line ordered makes its progress invoice due (Todd, 2026-10-13; M10). Before M10, Todd was the only orderer. From M11 also runs the Ordering pages: the drawer order, the monthly stock order, paint orders and the board stocktake with its prices (approved by Todd 2026-10-13; M11). |
| Workshop Manager (M10) | Workshop Manager | Runs the workshop floor, a different person from the Scheduler. Views the board, receives deliveries (Todd, 2026-10-13; M10). From M11 also does the monthly stock and board counts, without seeing prices (approved by Todd 2026-10-13; M11). |
| Floor crew | Workshop (optional) | They watch the TV, which runs on Sam's login (Todd, 2026-10-13). A floor login, if wanted, gets the Workshop role: the board and Planner to view (M7). |

Nobody outside the business gets a login. All users are on laptops or
Chromebooks (Chrome). No touch input is required.

### 3.2 Permission model

- A small set of **role presets**: `admin`, `accounts`, `design_pm`,
  `scheduling`, `showroom`, `workshop` (M7), `ordering` and
  `workshop_manager` (M10). A user can hold more than one.
- A flat list of **feature keys** (e.g. `jobs.view`, `jobs.edit`,
  `invoices.view`, `invoices.mark_paid`, `orders.edit`, `board.edit`,
  `photos.admin`, `users.admin`, `audit.view`, …). Each preset maps to a set
  of keys. Each user may carry **overrides** (grant or revoke individual keys).
  Effective permission = union of role keys, then overrides applied.
- **M11 keys (approved by Todd 2026-10-13):** `stock.count` (type the monthly
  stock "have" and the board quantities; Workshop Manager, Ordering, admin) and
  `stock.order` (the stock, paint and board lists, board prices, the drawer
  order, paint orders, confirming the board stock value; Ordering, admin).
  (Accounts had a read-only Stock value page on `accounts.view`; it was removed at Todd's request, 2026-10-16. The board stocktake's own confirm-value step went the same way on 2026-10-17, see 5.4.) 27 keys in all.
- **M13 owner and owner-only keys (approved by Todd 2026-10-16):** one login is
  **the owner** (Todd's; a mark on the login, not a role), and three
  **owner-only keys**: `bonuses.manage` (the Bonuses page), `alarms.manage`
  (the Alarms page, with the alarm codes stored encrypted) and `loans.manage`
  (the Loans page). The admin preset is every key **except** these three, so
  other admins don't see those pages or their audit rows. The owner holds every
  key, and is the only one who can grant or revoke an owner-only key (for
  example Loans to an Accounts login), change, reset, disable or sign out the
  owner's login, reset the password of someone holding an owner-only key by a
  grant, or hand ownership to another enabled admin. 30 keys at that point. This
  protects the figures inside Crosscuts; anyone with the Umbrel or the backup
  passphrase can still read the database (`docs/plans/m13-plan.md`,
  `docs/auth.md`).
- **Department Notes keys (approved by Todd 2026-10-16):** five keys,
  `notes.scheduling`, `notes.design`, `notes.ordering`, `notes.accounts` and
  `notes.admin`, each opening that one department's Notes page. Scheduling,
  Design/PM and Accounts hold their own; Ordering and the Workshop Manager share
  `notes.ordering`; admin holds all five; Showroom and Workshop none. **35 keys
  in all; the admin preset is 32** (every key but the three owner-only ones).
  **Audit (Todd, 2026-10-17):** a note's audit rows show only to readers who hold
  that note's department key (`docs/plans/notes-contracts.md` section 7).
- Enforce on the **server** on every route; the UI merely hides what the user
  can't do. Logged-out requests to any API route must be refused, not
  redirected to a page.
- A **User admin** screen for Todd: add/disable users, assign roles, set a
  first password, reset a password, view and flip overrides, see last login.
- Define the full feature-key list in your milestone 1 plan; keep keys coarse
  (a dozen or two), not one per button.

### 3.3 Login and sessions

- Username + password, bcrypt (or argon2) hashed. Sessions server-side,
  cookie-based, `HttpOnly`, `SameSite=Lax`. "Remember this device" extends the
  session to ~30 days; otherwise a shorter default of your choosing.
- **PIN:** a user may set a 4–6 digit PIN. It unlocks only on a device that has
  a valid remembered session established with the password; a PIN never works
  on a fresh device. Rate-limit PIN attempts per device.
- The **Umbrel proxy login must be disabled for Crosscuts** so users don't
  face two logins. Verify the exact mechanism against umbrelOS 2.0 (expected:
  `PROXY_AUTH_ADD: "false"` on the `app_proxy` service) and do not carry the
  old `PROXY_AUTH_WHITELIST` / `PROXY_AUTH_BLACKLIST` lines into the new
  compose file. Confirm by hitting a gated route logged-out from both LAN and
  Tailscale.

## 4. The home screen

After login, a **personal dashboard**: the user's working tiles ("my tasks",
"my notifications / messages", the planner) and a one-line summary of this
week's board. Tiles the user has no permission for are not rendered.
Departments are reached from the menu bar, grouped by department (Todd,
2026-10-12; `docs/plans/menu-plan.md`).
(Until 0.1.10 the dashboard also had department tiles; the menu bar replaced
them.)

## 5. Departments — target state

Everything below is the *destination*. §9 says what is in milestone 1. Pages
not in milestone 1 still exist as navigable shells that state what they will
become.

### 5.1 Accounts

**Purpose:** per-job invoice tracking, and a two-way task queue between Todd
and the accounts staff.

1. **Invoice table — the primary view.** A plain table, one row per job,
   columns for each invoice stage (Deposit 10% · Progress 50% · Final 40% ·
   Extras). Each cell shows one of: *not due* / *due* / *invoiced (ref,
   date)* / *paid (date)*. Two one-click actions per cell: **Invoiced** (enter
   a reference) and **Paid** (stamps today's date; editable). Filters: unpaid,
   overdue, this month, by client. Totals: outstanding, overdue. This is the
   screen Todd opens when money lands in the bank, so it must be fast and
   require no navigation.
2. **Invoice prompts** fire from job events: first scheduled → deposit due;
   Todd flags "materials ordered" (see 5.2 Orders) → progress due; Finish week
   "complete" → final (+ extras if any). Prompts appear in-app for accounts
   staff and Todd, and as ntfy push to Todd. A **Friday 12:00 Sydney round-up**
   lists everything due-but-not-invoiced and repeats weekly until cleared.
3. **Amounts.** Job value is set on the job (Design/PM). The 10/50/40 split is
   suggested from it and editable per invoice. Extras are entered by hand.
4. **Overdue list for Jill.** Invoiced-but-unpaid past due date, with
   follow-up notes and last-contacted date.
5. **Task queue.** Two-way: Todd ↔ accounts staff. Title, notes, assignee, due
   date, status, comments, optional file attachment. Both sides can raise
   tasks for the other.
6. **Report library.** Accounts staff upload monthly reports (reconciliation,
   BAS, etc.) into a dated library Todd can browse.
7. **External invoice id slot** per invoice for a future MYOB link. No MYOB
   calls now.

### 5.2 Design / Project Management

**Purpose:** the job's life from enquiry to invoiced, and the materials needed
to build it.

1. **Job record.** Client (name, phone, email), site address, spec (sheet
   count, painted/two-pac yes-no, benchtop laminate/stone, job type), value,
   key dates (enquiry, quoted, won, design signed off, materials ordered,
   ready to cut, promised install, completed), links (OneDrive design folder,
   Joinr quote URL), `source`, `external_ref`, notes. Existing `jobs.name` and
   `jobs.notes` carry over.
2. **Lifecycle stages:** `quoted` → `won` → `design_ordering` →
   `ready_to_cut` → `on_board` → `complete` → `invoiced` (plus `lost` /
   `archived`). (The `lead` stage was retired, approved by Todd 2026-10-17: the
   pipeline starts at Quoted, see 5.4.) `on_board` is derived from the schedule (job has week rows);
   `complete` is set by Finish week; `invoiced` is derived from accounts (final
   invoice marked). The others are moved by Design/PM.
3. **Pipeline board.** Cards in columns by stage; drag to move (pointer
   events, not HTML5 DnD, so it works on a touch Chromebook if one ever
   appears). Moving a card to `ready_to_cut` puts the job in the board's
   "To start" backlog.
4. **Orders (per job).** A list of supplier orders on the job: supplier, what,
   status *to order* / *ordered* / *received*, dates, notes. When Todd marks
   the job's orders as placed (a job-level **"Materials ordered"** action, or
   all lines reaching *ordered*), the 50% invoice prompt fires. *Received*
   lines feed the board's "materials in" indicator.

   **Ordering pages (M11, approved by Todd 2026-10-13).** Four more pages under
   the Ordering menu, beside Orders and Deliveries:
   - **Drawer order.** Each job has a **drawer grid** (a drawer line on its
     Orders: brand, heights × runner lengths, counts, a note). The counts come
     from Joinr: the won quote's Drawers and Inner Drawers lines, mapped to a
     brand, height and length through a name list Ordering keeps. Design/PM
     checks and corrects the grid at design sign-off; jobs without Joinr data get
     it typed in. The page adds up the checked grids per brand (EDGE and DTC),
     with a stock row for the shelf, prints the sheet, and **Mark ordered**
     places the order: it marks each job's drawer line ordered, so the 50%
     invoice rule applies as for any line. The Workshop Manager receives each
     job's drawers and the stock row on Deliveries.
   - **Stock order.** The monthly hardware order: the Workshop Manager counts
     "have", Ordering types what to order and marks each supplier group ordered,
     and the Workshop Manager receives each group on Deliveries. It is not a job
     order line and has no invoice effect.
   - **Paint order.** A paint order has lines in kg or each, with litres worked
     out. **Paint is ordered per job:** a line with a job becomes an order line
     on that job (counting toward "all ordered" and the 50% invoice); lines with
     no job are workshop stock. Received on Deliveries.
   - **Board stocktake.** The Workshop Manager counts the boards monthly.
     Ordering keeps a price per sheet (ex GST) and confirms the value: counts ×
     prices, plus an optional adjustment and note. The confirmed value stays on the
     Boards page for Ordering (Accounts' Stock value page was removed at Todd's request, 2026-10-16).
     **The confirm-value step was removed too (Todd, 2026-10-17):** a count is
     finished once it is counted, and Ordering can reopen it; prices stay on the
     board list. There is no history before the first count in Crosscuts.

   The lists (stock items, paints, boards) are typed in by hand. Orders and counts
   start fresh. Detail: `docs/plans/m11-plan.md` §5 and
   `docs/how-to-order-drawers.md`, `docs/how-to-do-the-stocktake.md`.
5. **Client inspection booking.** For painted jobs: date/time, host, notes.
   Visible on the scheduling side.
6. **Tasks and comments on the job**, same mechanism as accounts.
7. **Photos linked to jobs.** The existing photo library gains an optional
   `job_id`. Photo admin becomes a Design/PM feature. Completed jobs can have
   photos uploaded against them; tags still drive the showroom search.
8. **Edit rights.** Only `design_pm` (and admin) create jobs and move stages.
   Scheduling has the board **quick-add** only (creates a minimal job at
   `ready_to_cut`, `source = board_quick_add`).
9. **Design/PM tools (M12, approved by Todd 2026-10-14).**
   - **Stone orders.** A job's **Benchtops** section holds its stone orders:
     our own form (supplier, job and site, contacts, stone brand and colour,
     edge height and profile, cabinetry install, measure / template and
     requested benchtop install dates, notes), filled from the job and printed
     on our letterhead to the supplier. Each sent revision is frozen, with the
     sent date typed (never today's date on a reprint); a sent order changed
     afterwards shows "Changed since rev n" until it is sent again. Cancelled
     orders are kept and can be restored. A stone order is **not an order
     line**: it never holds back the 50% invoice or touches Deliveries. A
     Stone orders list page and a Design/PM dashboard tile. Joinr holds no
     benchtop details, so the forms are typed in; the job page shows the
     quote's benchtop text as typed.
   - **Benchtop sheet.** A printed A4 sheet with the job filled in (or blank)
     and the edge key, to draw on by hand. An on-screen drawing tool is a
     future development.
   - **Batten calculator.** Solves the gap from the number of battens, or the
     number from a gap, with the set-out; nothing is saved.
   - No new key: the pages need `design.view`, a job's stone orders `jobs.view`
     to see and print and `jobs.edit` to change. Detail:
     `docs/plans/m12-plan.md` §5 and `docs/how-to-order-stone.md`.

### 5.3 Scheduling / Organisation

**Purpose:** keep running the board exactly as today, with better information
on it and around it.

1. **Board** — unchanged layout. Backlog ("To start") is fed by Design/PM
   moving jobs to `ready_to_cut`, plus quick-add. Finish week continues to
   drive the next week.
2. **Indicators on rows** (small, and mirrored in `exportJpg`): materials
   received / not; current production stage; a worker-chip style for a person
   on leave that day.
3. **Finish week extended**: for each job, capture production stage (cut &
   edge, kit, assemble, inspect, paint, install, return visit) alongside the
   existing outcome. Stage history is stored per job per week.
4. **Staff availability / leave.** (Moved to the Admin menu and made admin-only,
   `users.admin`, approved by Todd 2026-10-16; the board still reads leave from
   `/api/schedule`.) Record leave, sick days and part-time
   patterns per worker; the board greys those people out on those days and
   warns if they are assigned.
5. **Lookahead.** (Removed with the Scheduling page, approved by Todd
   2026-10-16; the Scheduling menu is now Board and Workers.) A read-only 2–4 week view and the backlog ordered by promised
   install date.
6. **Materials in** — from Orders (5.2.4).
7. Worker roster management stays, under Scheduling.

### 5.4 Changes after M13 (approved by Todd 2026-10-16 and 2026-10-17)

Small changes Todd asked for once M1 to M13 were built. They override the older
text above where they differ.

- **Department Notes walls (2026-10-16).** Each of five departments (Scheduling,
  Design/PM, Ordering, Accounts, Admin) has a Notes page in its menu: a week wall,
  one column per weekday, of sticky notes. People sign nothing by hand (the note
  carries the author and time), post on today or a later weekday, and the author
  can edit or remove it until its week is over. Anyone else in the department can
  give a note a thumbs-up (names shown, not on your own note); past weeks are
  paged back to and read-only. Five keys `notes.*`, 35 keys in all, admin preset
  32 (3.2). House-style exceptions, named in `CLAUDE.md`: the **cream paper
  notes** and the **thumbs-up mark** (the page's only icon). Migration 029.
  Detail: `docs/plans/notes-contracts.md`.
- **Scheduling and Lookahead pages removed; Availability moved to Admin
  (2026-10-16),** admin-only (`users.admin`). The board's away chips and warnings
  are unchanged.
- **Planner repeats (2026-10-16/17).** "Every year" (migration 027), and a
  **Custom** repeat: every N days, weeks, months or years, N from 1 to 99
  (migration 030, additive).
- **Lead stage retired (2026-10-17).** The pipeline starts at Quoted; new jobs
  default to Quoted and Lead is refused as a target. Quoted shows the quoted jobs
  as single lines plus a **From Joinr** group: Joinr won quotes still waiting in
  the inbox, each a link to the quote in Joinr (read-only
  `GET /api/pipeline/joinr-quotes`). **0.1.20 (2026-10-17, J3 Crosscuts side):** Joinr's
  new open-quotes list (contract version 3) adds *sent* quotes; Crosscuts fetches it every
  5 minutes and on the Pipeline's Refresh button into a cache (migration 031), and the From
  Joinr group then shows sent and won lines (a job already accepted, linked, ignored or
  withdrawn in the inbox is left out). Until Joinr releases the endpoint Crosscuts keeps
  today's list (`docs/plans/m3-contracts.md` section 13.1).
- **Stock value and the board value step removed (2026-10-16/17).** Accounts'
  Stock value page went on the 16th; on the 17th the board stocktake lost its
  confirm-value step (counts × prices, adjustment, note), its routes and the
  dashboard reminder. A count is done once counted. No data was deleted; old
  "valued" months read as counted.
- **BAS sales by hand (2026-10-16).** The BAS month's sales are typed in; invoices
  no longer count towards them.
- **Admin accounts (2026-10-16).** A page after Supplier accounts for bills that
  are not from suppliers (BAS, Workcover, insurance); migration 028.
- **Dashboard button (2026-10-17).** The menu bar's Dashboard link is a small
  outlined teal button beside the wordmark.
- **Landscape time sheets (2026-10-16).** Printed time sheets are landscape.

## 6. Cross-cutting systems

### 6.1 Notifications and messaging (no email)

- **In-app notification bell** for every user: tasks assigned, comments on
  things you're involved in, invoice prompts (accounts + Todd), Joinr intake
  events (Design/PM). Mark read, mark all read.
- **ntfy push to Todd's phone** for invoice prompts and anything addressed to
  Todd. Recommend in your plan whether to self-host ntfy on the Umbrel (there
  is an Umbrel app) or use a private topic on ntfy.sh; either way, failures
  must not block the app, and undelivered pushes must be visible in-app.
- **Friday 12:00 Australia/Sydney round-up** of outstanding invoice prompts,
  as an in-app notification and ntfy push, repeating until cleared.
- **Internal messaging:** threaded comments on tasks and jobs, plus a general
  chat (company-wide channel, optionally one per department). Keep it simple —
  text, timestamps, author, unread counts. No real-time requirement; polling
  is fine.

### 6.2 Audit log

Append-only table: timestamp, actor, action, entity type/id, before/after
(JSON), IP. Cover logins (success/failure), user/permission changes, job
create/stage change, invoice and payment marks, order status, deletions. A
read-only screen for admin with filters.

### 6.3 Backup and restore

Weekly job on the Umbrel copying the SQLite DB (via the SQLite backup API or
`VACUUM INTO`, not a raw file copy of a WAL database) plus `uploads/` to the
offsite NAS over Tailscale. Keep several generations. Write and **test** a
restore runbook in `docs/`. Todd supplies NAS address, share and credentials.
Confirm the Umbrel has Tailscale (there is an Umbrel app) and the NAS is
reachable from it before designing.

### 6.4 Joinr → Crosscuts quote intake (later milestone, design now)

Goal: an **accepted quote in Joinr becomes a job in Crosscuts** with client,
site, spec, sheet count, two-pac, benchtop and value pre-filled.

Constraint: Joinr is on Vercel/Supabase (cloud); Crosscuts is on a LAN with no
public address. A cloud function cannot reach it directly.

Recommended: **pull.** Crosscuts polls a Joinr endpoint (e.g.
`GET /api/integrations/accepted-quotes?since=…`) every few minutes using a
per-tenant API key stored in Crosscuts' config volume, and a manual
**Sync now** button. Nothing on the Umbrel is exposed to the internet.
Alternative: expose a Crosscuts webhook via Tailscale Funnel or a Cloudflare
Tunnel so Joinr can push; more moving parts, consider only if latency matters.

Requirements regardless of method:
- Idempotent: `external_ref` = Joinr quote id; re-syncs never duplicate.
- A shared **contract document** (field names, types, units, status values)
  committed to both repos. The Joinr side is a separate repo
  (`tenon-quotr`); you may be asked to specify the Joinr endpoint, not build it.
- **Intake behaviour — you recommend:** create the job automatically at `won`,
  or land it in a "New from Joinr" inbox for Design/PM to accept/ignore.
  State the trade-off and pick one in the plan.
- Never let a Joinr outage or a bad payload affect the rest of the app.
- **M11 (approved by Todd 2026-10-13):** the intake item also carries the won
  quote's drawer lines, as an optional `drawers` field (contract document version
  2; the wire `contract` stays 1). An older Joinr that doesn't send it is
  treated as "no drawer data".

### 6.5 Remote access and devices

Same app on LAN and Tailscale. Test login, sessions and the TV flow over both.
Target browsers: current Chrome on Chromebooks and Windows laptops. The TV is
1920×1080 driven by Sam's Chromebook — keep the board's TV legibility.

## 7. Architecture direction

All previous non-negotiables are negotiable (D20). Recommended position; argue
in the plan if you want to depart from it:

- **Keep: no build step, no bundler, no framework.** Plain HTML/CSS/JS served
  by Express is a strength here: no toolchain on Todd's Windows box (where
  `better-sqlite3` won't build and Docker isn't installed), nothing to break on
  an offline LAN, and the existing 1,300-line `schedule.js` keeps working.
  ES modules in the browser are fine. Vendor every third-party asset.
- **Keep: one SQLite file (`photos.db`, never renamed).** Eight users and a
  few thousand rows a year. WAL mode as today. Add proper foreign keys and
  indexes. Introduce a **migrations** mechanism (numbered SQL files, applied at
  boot, recorded in a `schema_migrations` table). Every migration additive
  unless Todd signs off otherwise.
- **Change: split `server.js`** into route modules per department plus
  `auth`, `notify`, `audit`, `db`. Keep `shared.js` and introduce a small
  shared UI layer (nav shell, department switcher, notification bell, tables,
  dialogs) — i.e. **a shared design system replaces page-local CSS for new
  pages.** The schedule board keeps its own CSS and 1.2× scale; don't rework
  it.
- **Keep: `exportJpg` mirror rule** for anything new on the board.
- **Keep: ship as a published image, bump `version:` every release, CI smoke
  tests as the primary verification.** New image, new CI workflow in the new
  repo (copy the old one and rename). Extend the smoke suite: every API route
  logged-out (must 401/403), and logged-in with a permitted and a
  non-permitted role.
- **Keep: schema/bulk-data changes need explicit data-loss reasoning and
  sign-off.** During the parallel-running period Crosscuts holds only a
  snapshot, so the bar is lower there — but every migration must be proven on
  a fresh copy of the live `photos.db` before cutover, because at cutover it
  runs against the real thing.
- **Never uninstall the old app** until Todd confirms cutover is complete.

## 8. Data model direction

You design the schema; these are the rules.

1. **`jobs` becomes first-class.** Extend the existing table (additive, nullable
   columns) rather than replacing it: `week_rows`, `backlog`, `assignments`
   and `day_flags` keep referencing `jobs.id`. Existing rows are backfilled:
   stage inferred from the schedule (`on_board` if it has rows in the current
   or a future week, `ready_to_cut` if in backlog, otherwise `complete`);
   `source = manual`. Present the backfill rule for sign-off before running it.
2. New tables, roughly: `users`, `roles`, `user_roles`, `permission_overrides`,
   `sessions`, `devices` (PIN), `job_events` (dated milestones),
   `job_stage_history` (from Finish week), `orders`, `invoices`, `payments`
   (or paid fields on `invoices`), `tasks`, `comments`, `messages`,
   `channels`, `notifications`, `reports`, `inspections`, `leave`,
   `audit_log`, `integration_sync` (Joinr cursor/log), `schema_migrations`.
   `photos` gains nullable `job_id`.
3. **Don't paint the solver into a corner:** keep sheet count, two-pac,
   benchtop type and promised date as discrete typed fields (not free text),
   since those are what a future scheduler would consume.
4. Money as integer cents, dates as ISO strings in Australia/Sydney local
   date for business dates and UTC for timestamps; be explicit about which.
5. Soft-delete / archive over hard delete everywhere a human might regret it.

## 9. Milestone 1 — definition of done

Everything below **working**, not stubbed, in the new Crosscuts app installed
alongside the old one and seeded with a snapshot of live data:

0. **The new repo and app exist:** copied from the current repo, renamed
   (`crosscuts` id, new port, new image), CI publishing to GHCR, installable
   from its store entry on the Umbrel without touching `thcabinets-splash`.
1. **Personal login** (username + password, remember-device sessions, optional
   device-bound PIN). Umbrel proxy login disabled for the app; no whitelist.
   Verified over LAN and Tailscale.
2. **Role presets + overrides** enforced server-side on every route.
3. **User admin screen** for Todd.
4. **All existing features carried over, behind login, unchanged in
   behaviour:** schedule board, backlog, finish week, workers, photo admin,
   showroom search (via the showroom account), landing page replaced by the
   personal dashboard. Verified against the snapshot: the board in Crosscuts
   shows the same weeks, rows, chips and flags as the old app.
5. **Personal home dashboard** with working department tiles; tasks and
   notification tiles may be labelled placeholders.
6. **Basic job record** with the fields in 5.2.1 and the lifecycle stage,
   editable by Design/PM, with the existing jobs backfilled. A simple job list
   and job page (the pipeline board can wait).
7. **Audit log** writing for logins, user/permission changes and job changes,
   with a read-only admin screen.
8. **Hygiene:** `package-lock.json` committed and `npm ci` in the Dockerfile
   (check it pins both `@img/sharp-linuxmusl-x64` and `-arm64`); Inter
   vendored; `/api/schedule` default week computed in Australia/Sydney.
9. **Every other department page present as a shell** that names what it will
   become (Accounts: invoice table, tasks, reports, overdue; Design/PM:
   pipeline, orders, inspections; Scheduling: leave, lookahead) and is gated by
   the right feature key.
10. **CI smoke tests** extended for auth (logged-out refusal, right/wrong role)
    and for every existing feature behind login.
11. `docs/` updated: how auth works, how to add a user, how to add a feature
    key, how to roll back a release (image tag + DB restore).

Out of M1: invoices, orders, tasks, messaging, notifications, leave,
lookahead, Joinr sync, backup job, and the cutover itself. Suggested order
afterwards — propose your own with reasoning: **M2** Accounts invoice table +
prompts + ntfy; **M3** Design/PM pipeline + orders + inspections; **M4**
tasks, comments, messaging, notification bell; **M5** scheduling extras
(leave, lookahead, stage capture, indicators); **M6** Joinr intake; backup job
as early as Todd can supply NAS details. **Cutover (§9a) happens when Todd
says Crosscuts is functional enough** — likely after M2 or M3, not after M1.

## 9a. Cutover — a release in its own right

Deliver a runbook in `docs/` before proposing a date. It must cover:

1. **Freeze:** agree a time (e.g. Friday after Finish week) when edits to the
   old board stop. Tell Sam.
2. **Snapshot:** copy the old app's `data/` (DB via SQLite backup API or
   `VACUUM INTO`, plus `uploads/` and `config/`) to a safe place *and* keep
   it — this is the rollback.
3. **Load:** replace Crosscuts' data volume with the snapshot; restart; let
   migrations run; check the migration log.
4. **Verify:** the current and next week's board in Crosscuts match the old
   app row for row; worker roster matches; photo count matches; users and
   permissions are present (users live only in Crosscuts, so they survive —
   confirm the migration doesn't clobber them, or re-seed them from a config
   export).
5. **Switch:** Sam's Chromebook and any bookmarks point at Crosscuts; the TV
   shows the Crosscuts board; office staff log in.
6. **Fallback window:** the old app stays installed and untouched for an
   agreed period (suggest two weeks). If Crosscuts fails, the old app is
   simply used again; any edits made in Crosscuts in between are re-keyed by
   hand — say so plainly in the runbook.
7. **Decommission:** only after Todd confirms, the old app is uninstalled
   (which wipes its data — hence step 2) and its store entry retired.

## 10. Questions you must answer in your plans

- Second store vs second app in a copied store; new port; repo layout.
- Exact feature-key list and the preset → key mapping.
- Session lengths (default and remembered), PIN length and attempt limits.
- Umbrel proxy-auth disable mechanism, verified against umbrelOS 2.0 source.
- Migration mechanism and the M1 backfill rule for existing jobs.
- The shared UI layer: what it covers, how the board is excluded.
- ntfy: self-hosted on Umbrel vs ntfy.sh private topic.
- Joinr intake: auto-create at `won` vs review inbox; pull vs push; the
  contract document outline.
- Backup tooling (rsync/rclone/SMB over Tailscale) once NAS details arrive.
- Anything in `docs/agent-briefing.md` §6 (known issues) you want to fold in.

## 11. Things to flag early rather than discover late

- The uncommitted `/api/tags` + admin filter-bar WIP in the old working tree
  (see `CLAUDE.md`): carry into the copy or leave behind — Todd's call, ask
  once at the start.
- Two apps on one Umbrel: distinct app id, port, image name and store entry.
  Check nothing in the copied compose or manifest still says
  `thcabinets-splash` or 4090.
- The snapshot in Crosscuts goes stale during the build. Refresh it from the
  live app whenever you need realistic data, and always immediately before
  cutover.
- The TV: at cutover Sam's Chromebook must be logged in to Crosscuts. Set it
  up the day before.
- Live production data: the old app's `photos.db` is touched only by the
  snapshot copy. Migration dry-run reasoning goes in each plan; the orphan
  `day_flags` sweep can simply be part of the first Crosscuts migration, since
  it then runs on a copy first.
- Multi-arch CI has stalled before; native arm64 runners are the durable fix
  if it recurs.

## 12. Reference material

- Repo: https://github.com/devcal1/thcabinets-umbrel-store (branch `master`)
- `CLAUDE.md`, `README.md`, `docs/agent-briefing.md` (this repo)
- Factory workflow and workshop model: Google Drive
  `context/projects/Workshop Scheduler/` files 01–07 (stages, staff,
  capacities, durations, fleet, hours, Joinr architecture). Read 02 and 07 at
  minimum — 02 for the production stages captured at Finish week, 07 for the
  "a job must stand on its own" rule and the Joinr hand-off intent.
- Joinr: `context/projects/joinr.md`; repo `devcal1/tenon-quotr` (private).
