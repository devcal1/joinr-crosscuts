# Job materials list: contracts (Todd, 2026-10-18)

Each job gets a **Materials list** that a person can override, prefilled from the won Joinr quote, that can feed Ordering. Everything in `m1-contracts.md` ... `m17` still holds. CLAUDE.md applies (additive migration, `defineRoutes` access, house style, no icons, no new feature keys). No version bump here: the integrator bumps (0.1.21).

Code: `lib/materials.js`, `routes/materials.js`, `public/jobmaterials.js` and `jobmaterials.css`, `db/migrations/034_job_materials.sql`. Test: `ci/smoke-m18-materials.sh`.

## 1. Migration `034_job_materials.sql`

Table `job_materials`:

| Column | Meaning |
|---|---|
| `id`, `job_id` (NOT NULL, FK jobs) | |
| `position` | order within the job (a new line takes max + 1); the page lists by section, then position |
| `section` | free text, 1 to 40 characters. Typed lines use one of `boards, edging, doors, benchtop, handles, hardware, drawers, room_extras, paint, other`; Joinr lines may later carry their own |
| `name` | NOT NULL, 1 to 300 characters (not blank) |
| `qty` | REAL, NULL or 0 to 1,000,000 (three decimals kept). A Joinr quantity over 1,000,000, alone or summed over lines with the same key, is stored as NULL with the note "Quantity too large from Joinr", so a fill or Update never fails on this CHECK |
| `unit` | NULL or at most 30 characters |
| `notes` | NOT NULL, default `''`, at most 1000 |
| `source` | `joinr` or `manual` |
| `joinr_key` | the stable key of a Joinr line (so a re-sync matches it). `joinr` lines must have one, `manual` lines must not; unique per job |
| `overridden` | 0/1: set when a person edits a Joinr line |
| `gone_from_joinr` | 0/1: the latest quote no longer has this Joinr line ("No longer in Joinr") |
| `removed_at` | soft remove. A removed Joinr line does not come back on a re-sync |
| `order_id` | FK orders: set when the line is turned into an order line |
| `created_at`, `updated_at`, `created_by`, `updated_by` | |

Index on `(job_id, position)`, a unique partial index on `(job_id, joinr_key)`, and one on `order_id`. `gone_from_joinr` is the one column beyond the brief's list: "No longer in Joinr" needs somewhere to live that is not a delete.

## 2. The one writer of Joinr lines: `materials.fillFromJoinr(db, jobId, payload, req)`

`payload` is the stored `joinr_intake.payload` (JSON text or object). It maps the payload to lines with `linesFromPayload` and **merges** them (so it can run again safely). Today's mapping (contract versions 1 and 2):

| From the payload | Line | Key |
|---|---|---|
| `spec.sheetCount` (> 0, already rounded up) | boards, "Board sheets", qty n, unit `sheets` | `sheets` |
| each distinct `raw.doorsPanels` text | doors, the text, no qty | `doors:<lowercase text>` |
| `spec.benchtop` of `laminate` or `stone` | benchtop, "Benchtop: stone" | `benchtop-kind` |
| each distinct `raw.benchtops` text | benchtop, the text, no qty | `benchtop:<lowercase text>` |
| `spec.twoPac === true` | paint, "Two-pac finish" | `twopac` |
| each `drawers[]` entry | drawers, the name, qty, unit `each` (notes "Inner drawers" for `innerDrawers`) | `drawers:<section>:<lowercase name>` |

**TODO(J4) (resolved 2026-10-18: section 7).** Contract version 4 (task J4 in Joinr) will send the whole quote: every room's lines with section, name, qty, unit and the money figures. That feeds this function by adding one mapping in `linesFromPayload` (a `quote` block, one `add(key, section, name, qty, unit, notes)` per line, the key built from room and line ids). Nothing else here, in the routes or on the page changes. **Money figures never go into `job_materials`**: they get their own job-page section, shown only to `jobs.value` holders, with J4.

Merge rules (what a sync may touch):

1. A Joinr line is matched by `joinr_key`. A new key is **added**.
2. A **removed** line (`removed_at`) is never brought back.
3. An **overridden** (edited) line is never touched, not even to flag it.
4. Any other Joinr line is **refreshed** from the quote (section, name, qty, unit, notes) and its "No longer in Joinr" flag is cleared.
5. A non-overridden, non-removed Joinr line that the quote no longer has is marked `gone_from_joinr`, never deleted.
6. **Manual lines are never touched.**
7. Returns `{added, updated, gone, kept, removedKept}`. Audit: one row (`material.fill` or `material.joinr_update`, entity `job`) only when something changed, with the counts and the line ids. The automatic path's actor is `Joinr (automatic)`.

Called from:
- `intake.acceptTx` and `intake.linkTx` (after the drawers fill), so the **automatic** accept/link (`autoDecide`) and the hand buttons both prefill. A failure is logged and rolled back to its own savepoint: it never stops the job being made.
- `syncFromJoinr` (below).

`syncFromJoinr(db, req, jobId, {action})` reads the job's latest accepted/linked intake record (its stored payload is already the latest item) and runs the same merge. 409 "This job is not tied to a Joinr quote" otherwise. A Joinr 'changed' item **never** rewrites the list by itself: the job page's "Changed in Joinr" callout gains **Update materials from Joinr**. Update does not acknowledge the change.

## 3. API

All under `/api/job-records/:id/materials`; errors are `{error}`; an unknown job is 404.

| Route | Access | Does |
|---|---|---|
| `GET /` | `jobs.view` | `{lines, sections, joinr}`. `lines` excludes removed lines, listed by section then position. `joinr = {linked, quoteNumber, changed, hasJoinrLines}` (linked: an accepted/linked intake record) |
| `POST /` | `jobs.edit` | A typed line `{section?, name, qty?, unit?, notes?}` (section default `other`; 400 for an unknown section, a blank or over-long name, a qty that is not a number from 0 to 1,000,000, a unit over 30, notes over 1000; at most 500 lines per job). 201 with the line |
| `PATCH /:lineId` | `jobs.edit` | Any of `section, name, qty, unit, notes`. Editing a **Joinr** line sets `overridden`, so a sync leaves it alone (a PATCH that changes nothing does not). A line of another job or a removed line is 404 |
| `DELETE /:lineId` | `jobs.edit` | Soft remove. 409 while the line has a live (not cancelled) order line: cancel that first |
| `POST /fill-from-joinr` | `jobs.edit` | Runs the merge for a job tied to Joinr (the page offers it when the job has no Joinr lines: jobs tied before the list existed). Answers `{summary, lines, sections, joinr}`. Audit `material.fill` |
| `POST /update-from-joinr` | `jobs.edit` | The same merge from the callout. Audit `material.joinr_update` |
| `POST /to-orders` | `orders.edit` | `{ids: [line id], supplier?}` (1 to 200 ids). See section 4 |

A line object: `{id, jobId, position, section, name, qty, unit, notes, source, overridden, origin ('joinr' | 'edited' | 'typed'), goneFromJoinr, orderId, orderStatus, ordered, createdAt, updatedAt}`. `ordered` is true while `order_id` points at an order line that is not cancelled.

Audit actions, all with before/after where they apply: `material.create`, `material.update` (before/after of the changed fields, plus `overridden` when the edit overrides), `material.remove`, `material.fill`, `material.joinr_update`, `material.to_order`.

## 4. Feeding Ordering (`to-orders`)

Never automatic. For each chosen line that is not already ordered it calls `orders.createLine` (so the usual `order.create` audit row and rules apply) with description `<name>, <qty> <unit>` (just the name when there is no quantity; cut to 500), the line's notes, status `to_order`, and the chosen supplier. It then sets `order_id`.

- **Supplier is optional.** `orders.createLine` gains `opts.blankSupplier` (used only here; the orders routes never pass it), so a line can be created with the supplier still to choose. Such a line shows "No supplier yet" on the job page, the Orders page and Deliveries, and **cannot be marked ordered until it has a supplier** (409 "Choose a supplier first"; a PATCH that sets the supplier and the status together is fine).
- **Idempotent per line.** A line with a live order line is skipped (`skipped: [{id, reason}]`); a second press creates nothing. A line whose order line was cancelled can be ordered again (a new order line, a new `order_id`).
- **It marks nothing ordered.** A new `to_order` line only stops the all-ordered rule from holding; `markMaterialsOrdered` runs only when a line is marked ordered. A job whose materials were already marked ordered keeps its date. The orderlinks (drawer and paint links) are not involved.
- One transaction; one `material.to_order` audit row. Answers `{created: [{id, orderId}], skipped, job, lines, sections, joinr}`.
- Access is `orders.edit` (the key that creates order lines today): Design/PM, Ordering and admin. Ordering can create order lines from the list without `jobs.edit`.

## 5. The page (job page, `public/jobmaterials.js`)

A "Materials" section after "From Joinr" and before "Orders" (`#materials`), for `jobs.view` holders: a table of section, item, qty, unit, notes and marks, with a small word on each line: **JOINR**, **EDITED** (a Joinr line a person changed) or **TYPED** (grey, like the others: violet is for the numbered discs only), plus **ORDERED** and **NO LONGER IN JOINR**. Section label shown on the first line of each group. `jobs.edit`: Edit (in place), Remove (confirm dialog), an Add a line form, and **Fill from Joinr** in the section bar when the job is tied to Joinr and has no Joinr lines. `orders.edit`: a tick per not-yet-ordered line, an optional supplier (from the supplier list) and **Create order lines (n)**; the Orders section reloads after. Drawer lines stay orderable here (Todd, 2026-10-18), so a muted line under the button says "Drawers from Joinr are also on the Drawer order. Take care not to order them twice." The "Changed in Joinr" callout gains **Update materials from Joinr** (`jobs.edit`), with a one-line result ("1 added, 1 updated, 2 no longer in Joinr. 2 lines you changed or removed were left alone."). House style only: outlined buttons, badges, no icons. No board files touched.

## 6. Tests: `ci/smoke-m18-materials.sh`

Migration 034 columns and CHECKs (negative qty, blank name, bad source, a Joinr line without a key and a manual line with one, overridden/gone out of range, over-long notes, unit and section, the foreign keys, the unique key); an auto-accepted quote from the stand-in Joinr fills 8 lines; access (Scheduling, Accounts and Ordering read; Scheduling, Accounts, Ordering, Showroom 403 on writes; Showroom 403 on read; logged out 401); typed add and its validation; an edit sets `overridden`, a no-change edit does not; a remove is soft and audited; a Joinr 'changed' does not rewrite the list; Update adds, refreshes, flags the lines Joinr dropped, and leaves edited, removed and typed lines alone, twice with the same result; a returning line is unflagged; Fill from Joinr for a job tied before the list existed (idempotent; 409 for a job not tied); Link to an existing job keeps its typed lines; `to-orders` creates `to_order` lines once, sets `order_id`, leaves the job's materials dates alone, refuses removing an ordered line, re-orders after a cancel, and a blank-supplier line cannot be marked ordered until it has one; a job already marked ordered keeps its date.

## 7. Contract version 4: the whole quote feeds the list (task J4, J4 consumer, 2026-10-18)

The `TODO(J4)` in section 2 is resolved. When the job's Joinr record has a quote snapshot (`joinr_quote_snapshots`, migration 035; `m6-contracts.md` section 14), `linesFromPayload(payload, quote)` takes the quote's **materials lines** instead of the thin "Board sheets" and `drawers:` stand-ins: one line per room, section and item (`lib/joinr-quote.js` `materialLines`), key `q:<room id or index>:<section id>:<item lower case>`, so a re-sync matches the line it made before.

| From the quote | Line |
|---|---|
| a room line in boardEdge | boards, the item, qty, unit (sheets); the room in the notes |
| benchtops | benchtop |
| drawers, innerDrawers | drawers (inner drawers noted) |
| handles, hardware | handles, hardware |
| roomExtras | room_extras |
| any other section priced as materials | other (the section title in the notes) |
| each additional item with a qty above 0 and no negative price | other |

Not lines: labour (office, factory, site), travel and overheads, a line with no quantity, a credit. **Labour shows in the job page's "From Joinr quote" section, not here.** The doors/panels and benchtop text lines, the benchtop kind and the two-pac line stay (the quote does not carry them). With no quote (`null`, absent, dropped as malformed) the section 2 mapping is used unchanged. The merge rules (add, refresh, flag gone, leave edited, removed and typed lines) and **Update materials from Joinr** are as before; Update reads the latest snapshot. Money never goes into `job_materials`. A job filled from the thin mapping before its quote arrives has those lines flagged "No longer in Joinr" by its first Update. Tested in `ci/smoke-m19-fullquote.sh`.
