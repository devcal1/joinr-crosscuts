# Crosscuts — Milestone 3 plan: Design/PM (2026-10-11)

Status: **approved by Todd 2026-10-11** (M3 · 1.3), with the decisions in §10. Steps: M3 · 1.1 (audit, §1), M3 · 1.2 (plan, §2–§9, questions in §10), M3 · 1.3 (decisions, recorded in §10).

Source of truth: `crosscuts-brief.md` §5.2 (items 3, 4, 5, 7, 8) and §8; roadmap M3 row.

**M3 scope:**
- the **pipeline board**: job cards in columns by stage, dragged with pointer events;
- **orders** per job, with the "orders placed" path firing the same 50% invoice prompt as M2's Materials ordered button;
- **client inspection** booking, visible on the scheduling side;
- **photos linked to jobs**, and a new **tag filter** (replacing the abandoned `/api/tags` WIP);
- tidying the stage ↔ "To start" rules that the pipeline board would otherwise expose.

**Not in M3:**
- Tasks and comments on the job (brief §5.2.6): M4, with the shared mechanism.
- Board indicators ("materials in", inspection dates) on the TV board: M5, because they touch the board and `exportJpg()`. M3 shows the same facts off the board (job page, scheduling page).
- A suppliers list or supplier contacts: suppliers are free text (with suggestions from earlier orders).

## 1. Audit findings (M3 · 1.1)

Three read-only surveys of the code, 2026-10-11.

**What already exists:**
- **The job record is complete** (`003_jobs.js`, plus `client_abn` in 006 and `quote_number` in 009): client, site, the typed spec fields (sheet count, two-pac, benchtop), value, all eight key dates, the OneDrive and Joinr links, `source`, `external_ref`. Only `job_type` is free text. Nothing in §5.2.1 is missing.
- **Stages and hooks** in `lib/jobstage.js`: `setStage`, `onScheduled`, `onSentToBacklog`, `onFinishedComplete`, `onDesignReadyToCut` (sets `ready_to_cut` and adds a "To start" row unless the job already has current or future week rows; this is brief §5.2.3's link), `createBoardJob`. Issuing a final invoice sets `invoiced`.
- **Stage moves today** are a PATCH `{stage}` on `/api/job-records/:id` (`jobs.edit`). The derived stages `on_board`, `complete`, `invoiced` need `users.admin`.
- **Permissions are already in place for all of M3:**
  - `orders.edit` (admin, design_pm), `orders.mark_ordered` (admin), `inspections.edit` (admin, design_pm), `photos.admin` (admin, design_pm). They're defined but nothing beyond the placeholders uses them yet.
  - `design.html` has "Pipeline board", "Orders" and "Client inspections" tiles marked Planned. `scheduling.html` has Planned tiles only.
- **Materials ordered (M2):** `POST /api/job-records/:id/materials-ordered` (Todd only) sets `materials_ordered_date` once (409 on a second press) and calls `invoices.onMaterialsOrdered`. That function is already idempotent: one live progress invoice per job, enforced by a unique index.
- **The bell:** `notify.toUser` / `notify.toKey` (sync, transaction-safe, free-text `kind`).
- **Photos:** one `photos` table (001) with tags as one comma-separated string. Thumbnails are 700px WebP with EXIF rotation. Gemini only suggests tags; it never applies them. `photos.search` goes to every role, `photos.admin` to admin and design_pm.
- **The `/api/tags` WIP** is not in Crosscuts. It sits uncommitted in the frozen old repo: a case-sensitive tag-count endpoint and a chip bar that filtered the *admin* table. It was left because of stale counts after edits, and it never reached the showroom search.

**What doesn't exist:**
- No pipeline page, no drag code using pointer events (the board uses HTML5 drag-and-drop), no card ordering column.
- No dedicated stage-move endpoint and no check for a stale move (two people moving the same card).
- Stage moves don't fill in the key dates (`quoted_date`, `won_date`, `ready_to_cut_date`).
- No tables, routes or pages for orders or inspections. No "received" or "materials in" date anywhere.
- No `photos.job_id`, no tag endpoint, no tag normal form, no photo section on the job page, no audit rows for photo actions.
- Search tiles are plain `div`s: not reachable by keyboard; the caption shows on hover only.

**Traps found:**
1. **Derived columns.** Dropping a card on `complete` (an admin can, today) would make the final invoice due. Dropping on `on_board` or `invoiced` is meaningless off the board.
2. **An `on_board` job can be set to `ready_to_cut`.** The hook then skips the "To start" row (the job has week rows), so the job is labelled `ready_to_cut` while it's on the board.
3. **Leaving `ready_to_cut` (back to `won`, or to `lost`/`archived`) leaves the job in "To start".**
4. **Re-sending `ready_to_cut` re-adds a "To start" row** the scheduler had deliberately removed. A drop back on the same column must send nothing.
5. **Hooks swallow errors** (`safely()`, the invoice `hook()`), so a half-failed move still returns 200.
6. **Two "archived" ideas:** the `archived` checkbox and the `archived` stage aren't linked. The board's job picker looks only at the checkbox.
7. **Showroom privacy:** `GET /api/photos` is served to the showroom role. Any job name or client detail added to photo rows must be dropped for users without `jobs.view`.
8. **Tags have no normal form:** Gemini lowercases, typed tags don't. Counts and chips would split "Kitchen" from "kitchen".
9. **The `invoices.due_reason` CHECK** allows only the M2 reasons. The orders path reuses `'materials_ordered'` rather than rebuilding the table.
10. **`notify.toKey` also notifies the person who acted** (Todd holds every key).
11. **Board files are frozen in structure and behaviour** (non-negotiable 7). All stage/backlog rule changes go in `lib/jobstage.js` and the routes, never `schedule.js`.
12. **The photo upload contract** is checked by the smoke test (dimensions, thumb URL, the orientation-6 thumb). Keep `.rotate()` and the dimension swap.

## 2. How it works, in one paragraph

Design/PM gets a **Pipeline** page: one column per stage from Lead to Invoiced, each job a card (name, client, promised install, sheets, value for those allowed to see it). Todd or a design_pm drags a card to move its stage. The board's own columns (On board, Complete, Invoiced) show where jobs are but aren't drop targets: the board and accounts move those. Dropping on Ready to cut puts the job in the board's "To start" list, as today. On the job page, an **Orders** section lists supplier lines (*to order* → *ordered* → *received*). When Todd marks the last line ordered, or presses **Materials ordered**, the 50% invoice becomes due, exactly once. When every line is received, the job shows **Materials in** and scheduling gets a bell notification. Two-pac jobs get an **Inspection** section (date, time, host, notes), and the scheduling page lists upcoming inspections and materials. Photos can be linked to a job, the job page shows its photos, and the showroom search gets tag chips that work by keyboard.

## 3. Data (migration `010_design_pm.sql`, additive only)

**`orders`** (one row per supplier line):
- `id`, `job_id` → jobs, `supplier` TEXT, `description` TEXT, `status` CHECK `to_order` / `ordered` / `received` / `cancelled`.
- `ordered_date`, `expected_date`, `received_date`: Sydney dates (YYYY-MM-DD).
- `notes`, `created_at`, `updated_at` (UTC), `created_by` → users.
- No hard delete: a removed line becomes `cancelled` and is hidden by default (brief §8.5).

**`inspections`:**
- `id`, `job_id` → jobs, `date` (Sydney date), `time` (HH:MM, Sydney), `host` TEXT, `notes`, `status` CHECK `booked` / `done` / `cancelled`, `created_at`, `updated_at`, `created_by`.

**`photos.job_id`:** INTEGER → jobs, nullable, with an index. Existing photos stay unlinked. No existing row changes.

**`jobs.materials_in_date`:** Sydney date, nullable. Set when the last open order line is received, cleared if a new line is added later. It's the flag the M5 board indicator will read.

No card-position column (Q2).

**`011_tidy_photo_tags.js` (the one-off tag tidy, Q4, signed off by Todd 2026-10-11):** rewrites `photos.tags` only. Each photo's tags are split on commas, trimmed, lowercased, emptied entries dropped, and duplicates removed (first occurrence kept, order otherwise unchanged), then joined with `, `. No row is deleted and no other column changes. A photo whose tags are already tidy is not written. It runs on boot like any migration, so the runner's `VACUUM INTO` backup is taken first; at cutover it runs on the loaded live data and the cutover count checks compare photo counts before and after. It's its own file so it can be reviewed on its own.

## 4. Pipeline board

- **Page:** `/pipeline.html`, linked from the Design page and the shell. Seeing needs `jobs.view`; dragging needs `jobs.edit` (admin, design_pm). Others see the same board read-only.
- **Columns:** Lead · Quoted · Won · Design & ordering · Ready to cut · On board · Complete · Invoiced. **Lost** and **Archived** are drop zones at the end; their cards are hidden behind a "Show lost and archived" toggle.
- **Cards:** name, client, promised install, sheet count, and value only for `jobs.value`. Clicking opens the job page. Orange "attend to" mark when the promised install date is within 14 days and the job isn't yet on the board.
- **Order within a column:** by promised install date (soonest first, blanks last), then name (Q2).
- **Drag:** pointer events (mouse, touch and pen) with a drag handle; the lifted card gets a teal outline, not a shadow (style check). A **Move to…** menu on each card does the same thing without dragging, for keyboard and for small screens.
- **Rules (enforced on the server, mirrored on the page):**
  - Drop targets are the manual stages only: Lead, Quoted, Won, Design & ordering, Ready to cut, Lost, Archived (trap 1).
  - Cards in On board can't be moved from the pipeline at all (trap 2). Cards in Complete and Invoiced may only go to Archived.
  - Dropping back on the same column sends nothing (trap 4).
- **New endpoint:** `POST /api/job-records/:id/stage {stage, from}`. If the job's current stage isn't `from` (someone else moved it), it returns 409 and the page refreshes the card. The move and its hooks run in one transaction; a hook failure rolls back the move and returns an error instead of a silent 200 (trap 5).
- **Key dates fill in on the way forward, never overwritten:** Quoted → `quoted_date`, Won → `won_date`, Ready to cut → `ready_to_cut_date`, each set to Sydney today only if empty. Moving backwards clears nothing.
- **Leaving Ready to cut for an earlier stage, Lost or Archived** takes the job out of "To start" if it's there and not on the board (trap 3, Q3). This is a change to `lib/jobstage.js`, not the board.
- **Archived stage and the checkbox** (trap 6): moving to Archived also ticks `archived`; moving out of Archived unticks it (Q5).
- The job page's stage dropdown uses the same endpoint and rules, so there's one path. An admin can still set a derived stage by hand on the job page, as today.

## 5. Orders

- **Job page section "Orders"** (seeing: `jobs.view`; editing: `orders.edit`): add a line (supplier with suggestions from earlier orders, description, expected date, notes), change status, cancel.
- **Who can mark a line ordered** (Q1, recommended): only `orders.mark_ordered` (Todd). design_pm drafts lines and marks them received. This matches the brief: Todd places the orders.
- **One shared function** `markMaterialsOrdered(db, jobId, req)` in `lib/orders.js`, used by both the existing **Materials ordered** button and the orders path. It sets `materials_ordered_date` only if empty, audits it, then calls `invoices.onMaterialsOrdered`. The job date is the "done once" flag. The orders path fires it when a line moves to *ordered* and every non-cancelled line on the job is *ordered* or *received*; there must be at least one line. Lines added later never undo it.
- **Materials in:** when every non-cancelled line is *received*, `materials_in_date` is set and scheduling (`scheduling.view`) gets one bell notification "Materials in: <job>". Adding a new line clears it.
- **Orders page** `/orders.html` (Design, `jobs.view`): every open line across jobs, filtered by status and supplier, with overdue expected dates in orange. It's Todd's ordering list.
- Every create, status change and cancel is audited.

## 6. Client inspections

- **Job page section "Inspection"** for two-pac jobs (or any job that already has one): date, time, host (free text, pre-filled with the booker's name), notes, status. Editing needs `inspections.edit`; seeing needs `jobs.view` or `scheduling.view`.
- Booking, moving or cancelling one notifies `scheduling.view` holders through the bell, and is audited.
- **Scheduling page** (`/scheduling.html`, `scheduling.view`): the Planned tiles give way to an **Upcoming** list for the next 14 days: inspections (date, time, job, host) and expected or received materials (job, supplier, expected date, Materials in). It's read-only, with links to the job.
- `notify.toKey` gains an optional `exceptUserId`, so the person who acted isn't notified about their own action (trap 10). The M2 callers keep their current behaviour.

## 7. Photos and tags

- **Linking:** the upload page gets an optional **Job** picker (open and recent jobs). The admin table shows each photo's job and filters by it, and a photo's job can be changed or cleared. Needs `photos.admin`.
- **Job page section "Photos"** (`jobs.view`): thumbnails of the job's photos, with **Upload photos** for `photos.admin`. Any job can have photos (the brief mentions completed jobs, but nothing stops an earlier one).
- **Showroom privacy** (trap 7): `GET /api/photos` returns `jobId` and the job name only to `jobs.view` holders. The showroom role sees exactly what it sees today. Smoke-tested.
- **Tags, new version:** `GET /api/photos/tags` returns `[{tag, count}]`, trimmed and lowercased (after the tidy there is one spelling per tag). New and edited tags are saved trimmed, lowercased and de-duplicated, and migration 011 tidies the existing ones the same way (Q4), so after M3 every stored tag is in one form.
- **Tag chips on the showroom search** (and the admin table): pick one or more chips to narrow the photos (all chosen tags must match), alongside the existing fuzzy search. Counts refresh after every edit, fixing the WIP's stale-count bug.
- **Keyboard:** search tiles become buttons (Tab, Enter, Space), the caption shows on focus as well as hover, and the lightbox takes focus and returns it on close. This clears the M1.2 deferred finding.
- Photo upload, tag edit, job link and delete write audit rows.
- The upload contract (dimensions, thumb URL, EXIF rotation) is unchanged.

## 8. Pages and keys

- **New pages:** `/pipeline.html` (`jobs.view`), `/orders.html` (`jobs.view`). Both registered in `lib/pages.js` and the shell's Design group. The Design page's Planned tiles become live links.
- **Changed pages:** `job.html` (Orders, Inspection, Photos sections; the stage dropdown uses the new endpoint), `scheduling.html` (Upcoming), `search.html` and `admin.html` (chips, job picker, keyboard).
- **Not changed:** the board files (`schedule.*`, `workers.html`), `exportJpg()`, `shared.js`.
- **Feature keys: none added.** `orders.edit`, `orders.mark_ordered`, `inspections.edit` and `design.view` go from "gates a placeholder" to live in `docs/auth.md`. The CI count of 21 stays.
- All new UI uses the house-style components (`hs-`, `cc-`), passes `ci/style-check.js`, and has no icons.

## 9. Build, tests, release

**Waves** (fixed at M3 · 2.1 in `m3-contracts.md`; likely shape):
- **2.2 Scaffold (me):** migrations 010 and 011 (tag tidy, checked against a copy of the dev DB with mixed-case tags); `lib/orders.js` with `markMaterialsOrdered` moved out of the route (the button keeps working); the stage-move function and its rules in `lib/jobstage.js`; `notify` `exceptUserId`; empty guarded routers.
- **3.1 Wave 1, in parallel:**
  - **A, pipeline:** the stage endpoint, `/pipeline.html` with pointer-event drag, the job page's stage dropdown.
  - **B, orders and inspections backend:** routes, Materials in, notifications, audit.
  - **C, photos:** `job_id` on upload/edit, tags endpoint, normalisation, privacy filter, search chips and keyboard, audit.
- **3.2 Wave 2:**
  - **D:** job page Orders/Inspection/Photos sections, `/orders.html`, the scheduling Upcoming list, the Design page tiles.

**Smoke additions (`ci/smoke-m3-*.sh`, CI is the real check):**
- Logged out: 401 on every new route. dpm 200 / sched 403 on stage moves and order edits; sched 200 on reading inspections; show 403 on all of it.
- Stage moves: Lead → Quoted fills `quoted_date`; a stale `from` gives 409; a drop on `complete` or `on_board` gives 400 for everyone; an `on_board` job can't be moved; Ready to cut adds a "To start" row; back to Won removes it; Archived ticks `archived`.
- Orders: dpm can't mark a line ordered (403), admin can; the last line ordered → the progress invoice is due once; the button afterwards → 409; a second line added and ordered → no second invoice; all received → `materials_in_date` and a bell row for sched, not for the actor.
- Inspections: booking notifies sched; dpm 200, acct 403 on edit.
- Photos: upload with `jobId`; the showroom's `GET /api/photos` has no `jobId` or job name; tags endpoint merges case; photos uploaded with mixed-case tags before 011 come out tidy after it (checked locally, since CI starts empty); the existing upload/orientation checks still pass.

**Release:** deferred (Todd, 2026-10-10). M3 is built and committed locally; when Todd releases, everything since 0.1.3 goes out in one version.

**Local checks:** shim boot, the style check, headless-Edge screenshots of the new and changed pages, and a drag test of the pipeline in the browser at desktop and phone width.

## 10. Questions for Todd (M3 · 1.2) and decisions (M3 · 1.3)

**Questions** (recommended answer first; it stands if Todd doesn't say otherwise):
- **Q1. Who can mark an order line "ordered"** (which can fire the 50% invoice)? *Recommended: only Todd (`orders.mark_ordered`); design_pm adds lines and marks them received.* Alternative: anyone who edits orders.
- **Q2. Card order within a pipeline column?** *Recommended: by promised install date, soonest first.* Alternative: manual drag-to-reorder (needs a position column and more drag work).
- **Q3. A job moved back out of Ready to cut** (to Won, Lost or Archived) before it's on the board: *Recommended: it leaves the board's "To start" list automatically.* Alternative: it stays until the scheduler removes it.
- **Q4. Existing photo tags with mixed case:** *Recommended: leave them as typed and match without regard to case.* Alternative: a one-off tidy that lowercases stored tags (this changes live data at cutover, so it would need its own sign-off).
- **Q5. Archived stage and the Archived checkbox:** *Recommended: linked, so moving a job to Archived also hides it from the board's job picker.* Alternative: keep them separate as today.

**Decisions from Todd (2026-10-11):**
1. **Q1: only Todd marks order lines ordered** (`orders.mark_ordered`). design_pm adds lines and marks them received.
2. **Q2: card order by promised install date** (default; not asked separately).
3. **Q3: a job moved back out of Ready to cut leaves "To start" automatically** if it isn't on the board.
4. **Q4: one-off tidy of stored photo tags** (migration 011, rule in §3). This is the data change Todd signed off; it lowercases, trims and de-duplicates tags, nothing else.
5. **Q5: the Archived stage and the Archived checkbox are linked.**
