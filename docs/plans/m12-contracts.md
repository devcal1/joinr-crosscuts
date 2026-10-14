# M12 interface contracts: Design/PM tools (binding for all M12 subagents)

Read `docs/plans/m12-plan.md` first. Its **Decisions** (section 5, 1–5) and **Lead's defaults** (section 4) are binding and win over its section 2. This file is the *what*.

Everything in `m1-contracts.md` … `m11-contracts.md` and `backup-contracts.md` still holds:
- UTC ISO timestamps with milliseconds, Sydney `YYYY-MM-DD` business dates.
- `defineRoutes`, audit, `lib/httperror.js`, errors as `{error}`.

If a contract looks wrong, report it instead of working around it. Points the integrator decided while writing this file are in §12; Todd can change any of them.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), Node 24, no build step, no framework.

**This repo is public.** Smoke, screenshot and seed data use made-up names only (`M12 Test Job`, `M12 Stone Supplier`, `M12 Stone Brand`). No supplier, brand, client or job from the workbook appears in code, docs or tests.

**Version.** M12 ships as **0.1.16**. The scaffold bumps `crosscuts/app/package.json` and the root version in `crosscuts/app/package-lock.json`; there's no further bump during the build.

**Not touched in M12:**
- The board files (`schedule.*`, `workers.html`, `exportJpg()`, `alignPanels()`) and `public/shared.js`.
- `lib/orders.js`, `lib/orderlinks.js`, `lib/invoices.js`, Deliveries: a stone order is **not an order line** (Decision 1), so it never touches the 50% progress invoice, "materials in" or Deliveries.
- `lib/permissions.js`: **no new key, no role or preset change** (Decision 5). The count stays at 27.
- The Planner, the chat channels, notices (M12 sends none, §12.9), and migrations 001–024.
- tenon-quotr (CLAUDE.md rule 12): nothing in M12 needs a Joinr change.

## 1. Files and owners

| File | What it is | Owner |
|---|---|---|
| `db/migrations/025_stone_orders.sql` | two new tables (§2), complete | scaffold |
| `lib/pages.js` | three page gates (§8) | scaffold |
| `public/shell/shell.js` | Design/PM menu: Stone orders, Batten calculator (§8) | scaffold |
| `server.js` | `require("./routes/stone")` after the M11 routes | scaffold |
| `routes/stone.js` | every §5 route declared with its access; handlers 501 in the scaffold | scaffold, then A |
| `lib/stone.js` | the binding exports of §4 as stubs throwing 501 (`summary()` answers zeros, §4.6) | scaffold stub, then A |
| `public/stone.html`, `public/stoneprint.html`, `public/battens.html` | placeholder pages (the shell and an `h1`) so the gates and menu can be checked | scaffold, then B / B / C |
| `ci/smoke.sh` | the M12 source loop (§10.1) | scaffold |
| `crosscuts/app/package.json`, `crosscuts/app/package-lock.json` | 0.1.16 | scaffold |
| `ci/smoke-m12-stone.sh` | §10.2 | A |
| `public/stone.html`, `stone.css`, `stone.js` | the Stone orders page: list and form (§9.2), prefix `so-` | B |
| `public/stoneprint.html`, `stoneprint.css`, `stoneprint.js` | the prints: stone order and benchtop sheet (§9.3), prefix `sp-` | B |
| `public/job.html`, `public/job.js` (the From Joinr benchtop text and the new Benchtops section only), optionally `public/jobstone.js` | the job page (§9.1), prefix `jt-` | B |
| `public/design.html` | the Stone orders tile (§9.4) | B |
| `public/battens.js` | the batten maths, shared by page and smoke (§6), complete | C |
| `public/battens.html`, `battens.css`, `battenspage.js` | the Batten calculator page (§9.5), prefix `bn-` | C |
| `ci/smoke-m12-battens.sh` | §10.3 | C |
| `docs/how-to-order-stone.md` (new), `docs/plans/menu-plan.md` (who sees what), `tools/screenshots/shoot.js`, `tools/screenshots/seed.js` | docs, screenshots and made-up data | integrator, 4.1 |

**Boundaries.**
- Every rule about stone orders lives in `lib/stone.js`: routes declare the coarse access and pass the body on; pages only hide controls.
- Every write runs in one `db.transaction` with its audit row. Every function in `lib/stone.js` takes `db` first and never requires `../db`.
- `public/battens.js` is the only place the batten maths lives; the page and the smoke both call it.

## 2. Migration `025_stone_orders.sql` (scaffold)

```sql
-- M12 Design/PM tools (docs/plans/m12-contracts.md section 2). Additive only: two new tables.

-- A stone benchtop order for a job: the form as it stands now (the working copy).
CREATE TABLE stone_orders (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),  -- the last revision sent; 0 = never sent
  supplier TEXT NOT NULL DEFAULT '',
  job_reference TEXT NOT NULL DEFAULT '',
  quote_number TEXT NOT NULL DEFAULT '',
  site_address TEXT NOT NULL DEFAULT '',
  site_access TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  client_phone TEXT NOT NULL DEFAULT '',
  our_contact TEXT NOT NULL DEFAULT '',
  our_phone TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  colour TEXT NOT NULL DEFAULT '',
  edge_height TEXT NOT NULL DEFAULT '',
  edge_profile TEXT NOT NULL DEFAULT '',
  cabinetry_install_date TEXT,                -- Sydney dates, or NULL
  measure_date TEXT,
  requested_install_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  CHECK ((status = 'draft' AND revision = 0) OR (status = 'sent' AND revision >= 1) OR status = 'cancelled')
);
CREATE INDEX idx_stone_orders_job ON stone_orders(job_id);
CREATE INDEX idx_stone_orders_status ON stone_orders(status);

-- Each revision as it was sent, frozen, so it can be printed again exactly.
CREATE TABLE stone_order_revisions (
  id INTEGER PRIMARY KEY,
  stone_order_id INTEGER NOT NULL REFERENCES stone_orders(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  form_json TEXT NOT NULL,                    -- the form as sent (section 3's keys), frozen
  sent_date TEXT NOT NULL,                    -- the Sydney date it was sent (typed; default today)
  sent_at TEXT NOT NULL,                      -- when it was marked sent (UTC ISO)
  sent_by INTEGER REFERENCES users(id),
  UNIQUE (stone_order_id, revision)
);
```

## 3. The form

One table, used by `lib/stone.js` (validation and the column map) and the pages. Key order is the order of `form_json` and of the page.

| Key | Column | Kind | Max | Prefill (new order) | Needed to send |
|---|---|---|---|---|---|
| `supplier` | `supplier` | text | 200 | `''` | yes |
| `jobReference` | `job_reference` | text | 200 | the job's name | |
| `quoteNumber` | `quote_number` | text | 100 | the job's quote number | |
| `siteAddress` | `site_address` | text | 300 | the job's site address | |
| `siteAccess` | `site_access` | text | 1000 | `''` | |
| `clientName` | `client_name` | text | 200 | the job's client name | |
| `clientPhone` | `client_phone` | text | 100 | the job's client phone | |
| `ourContact` | `our_contact` | text | 200 | the user's display name | |
| `ourPhone` | `our_phone` | text | 100 | the business phone (settings) | |
| `brand` | `brand` | text | 200 | `''` | yes |
| `colour` | `colour` | text | 200 | `''` | yes |
| `edgeHeight` | `edge_height` | text | 50 | `''` | yes |
| `edgeProfile` | `edge_profile` | text | 100 | `''` | yes |
| `cabinetryInstallDate` | `cabinetry_install_date` | date | | the job's promised install date | |
| `measureDate` | `measure_date` | date | | `null` | |
| `requestedInstallDate` | `requested_install_date` | date | | `null` | yes |
| `notes` | `notes` | text | 4000 | `''` | |

- **Text:** a string, trimmed; `null` is stored as `''`. Too long → 400 `"<Label> must be <max> characters or fewer"`. Not a string → 400 `"<Label> must be text"`.
- **Dates:** a valid `YYYY-MM-DD`, or `null`/`''` (stored NULL). Otherwise 400 `"<Label> must be a date"`. No date-order rule between them.
- **Labels** (for sentences and the pages): Supplier, Job reference, Quote number, Site address, Site access, Client, Client phone, Our contact, Our phone, Stone brand, Colour, Edge height, Edge profile, Cabinetry install, Measure / template, Requested benchtop install, Notes.
- **Unknown keys** in a body → 400 `"Unknown field: <key>"`.
- **The page's lists** (B, no server check): edge height `20 mm`, `36 mm`, `40 mm`, `50 mm`, `60 mm`, **Other…** (typed); edge profile `Aris`, `6x6 round`, `10x10 round`, `Square`, **Other…** (typed). Stored as the text shown.

## 4. `lib/stone.js` (A)

### 4.1 The stone order object

```js
{
  id, jobId, jobName, jobArchived,          // jobArchived: boolean
  status: "draft" | "sent" | "cancelled",
  revision: n,                              // last revision sent; 0 = never
  changedSinceSent: boolean,                // revision > 0 and the form differs from that revision's form_json
  sentDate: "YYYY-MM-DD" | null,            // the last revision's sent date
  sentBy: {id, name} | null,                // the last revision's sender
  form: { ...section 3's keys },
  createdAt, createdBy: {id, name} | null,
  updatedAt, updatedBy: {id, name} | null,
  cancelledAt, cancelledBy: {id, name} | null,
}
```

`get()` and every write add `revisions: [{revision, sentDate, sentAt, sentBy}]`, oldest first. The list leaves it out.

"Differs" compares the current form, normalised as stored, with the revision's `form_json` key by key.

### 4.2 Exports (binding signatures)

```js
forJob(db, req, jobId)          // -> {job, orders, prefill, benchtopText}   (section 5, GET job stone)
create(db, req, jobId, body)    // -> order with revisions
get(db, req, id)                // -> order with revisions (404 when none)
update(db, req, id, body)       // -> order with revisions
send(db, req, id, body)         // -> order with revisions
cancel(db, req, id)             // -> order with revisions
restore(db, req, id)            // -> order with revisions
revision(db, req, id, rev)      // -> {orderId, jobId, jobName, revision, sentDate, sentAt, sentBy, form}
list(db, { status })            // -> orders (no revisions)
summary(db, today = sydneyToday())  // -> {date, drafts, changed, installsSoon}
suggestions(db)                 // -> {suppliers, brands}
benchtopSheet(db, req, jobId)   // -> {job, benchtopText}
benchtopText(db, jobId)         // -> string[]
```

### 4.3 The rules

| Action | Rule |
|---|---|
| **create** | The job must exist (404) and not be archived (409 `"The job is archived"`). Body keys as §3; **a key left out takes the prefill**, a key sent as `''` or `null` stays empty. Status `draft`, revision 0. Several orders per job are allowed. 201. |
| **update** | The keys present change; the rest stay. Cancelled → 409 `"This stone order is cancelled"`; job archived → 409 `"The job is archived"`. A `draft` stays draft; a `sent` order stays `sent` (it then reads `changedSinceSent`). Nothing changed → 200, no audit row. |
| **send** | Body `{sentDate?}`: default today (Sydney); not a date → 400; in the future → 400 `"The sent date can't be in the future"`; before the last revision's sent date → 400 `"The sent date can't be before revision <n> (<d Mon yyyy>)"`. Cancelled or archived → 409 as update. Missing needed fields (§3) → 400 `"Fill in before sending: <Label>, <Label>"`. A sent order with no change since its last revision → 409 `"Nothing has changed since revision <n> was sent"`. Otherwise writes revision `n + 1` (`form_json` = the form, `sent_by` = the user), sets `revision`, `status = 'sent'`. 200. |
| **cancel** | From draft or sent; already cancelled → 409 `"This stone order is already cancelled"`. Allowed on an archived job. Sets `cancelled_at`/`cancelled_by`. Nothing is deleted. |
| **restore** | Only a cancelled order (else 409 `"Only a cancelled stone order can be restored"`); job archived → 409. Back to `draft` (revision 0) or `sent` (revision ≥ 1); clears `cancelled_*`. |
| **revision** | 404 when the order or that revision doesn't exist. |

Every write sets `updated_at`/`updated_by`. Audit, entity `stone_order`: `stone.create` (after: the form), `stone.update` (before/after: only the changed keys), `stone.send` (after: `{revision, sentDate}`), `stone.cancel`, `stone.restore` (before/after: status).

### 4.4 The list

`list(db, {status})`, `status` one of `open` (default: draft and sent, on jobs not archived), `cancelled`, `all` (everything); anything else → 400. Sorted by `requested_install_date` ascending with NULLs last, then id.

### 4.5 The prefill and the benchtop text

- `forJob` returns:
  - `job: {id, name, archived, benchtop}` (benchtop: `laminate`/`stone`/`none`/null);
  - `orders` (not cancelled first by id, then cancelled; with revisions);
  - `prefill`: the §3 form a new order would get for this user;
  - `benchtopText`.
- `benchtopText(db, jobId)`: the `raw.benchtops` list of the job's Joinr intake record (`joinr_intake.job_id = jobId`, state `accepted` or `linked`, the newest by `last_seen_at` if more than one), read from `payload` as JSON. Strings only, trimmed, empties dropped, each cut to 200, duplicates dropped, order kept. `[]` when there's none or the payload can't be read.
- `benchtopSheet(db, req, jobId)`: `{job: {id, name, clientName, siteAddress, quoteNumber}, benchtopText}`; 404 when the job doesn't exist (an archived job is fine).

### 4.6 The summary and suggestions

- `summary(db, today)`: over open orders (§4.4), `drafts` = status draft; `changed` = sent with `changedSinceSent`; `installsSoon` = **not cancelled** orders whose `requested_install_date` is from today to today + 13. `date` = today. The scaffold stub answers `{date, drafts: 0, changed: 0, installsSoon: 0}`.
- `suggestions(db)`: `{suppliers, brands}`, each the distinct non-empty values used on any stone order (case-blind, the most recently updated spelling), most recent first, at most 50.

## 5. Routes (`routes/stone.js`, `defineRoutes("/api")`)

Literal paths are registered before `/:id` ones. Ids are positive integers; anything else is 404.

| Method & path | Access | Answers |
|---|---|---|
| `GET /api/job-records/:id/stone` | `jobs.view` | `forJob` |
| `POST /api/job-records/:id/stone` | `jobs.edit` | 201, the order |
| `GET /api/job-records/:id/benchtop-sheet` | `jobs.view` | `benchtopSheet` plus `business` |
| `GET /api/stone` | `design.view` | `{orders}`; query `status` |
| `GET /api/stone/summary` | `design.view` | `summary` |
| `GET /api/stone/suggestions` | `jobs.edit` | `suggestions` |
| `GET /api/stone/letterhead` | `["jobs.view", "design.view"]` | `{business}` |
| `GET /api/stone/:id` | `jobs.view` | the order plus `business` |
| `PATCH /api/stone/:id` | `jobs.edit` | the order |
| `POST /api/stone/:id/send` | `jobs.edit` | the order |
| `POST /api/stone/:id/cancel` | `jobs.edit` | the order |
| `POST /api/stone/:id/restore` | `jobs.edit` | the order |
| `GET /api/stone/:id/revisions/:rev` | `jobs.view` | `revision` plus `business` |

`business` is `{tradingName, legalName, address, phone, email}` from `settings.business(db)`, as `routes/paint.js` `withBusiness` (no ABN, no bank details). A body that isn't a JSON object → 400 `"JSON body required"` (send, cancel and restore accept an empty body).

## 6. `public/battens.js` (C, complete)

A plain module like `public/drawers.js`: no dependencies, no DOM; `<script src="/battens.js">` sets `window.Battens`, and Node's `require` gets the same object (`module.exports`).

```js
Battens.solve({ space, width = 25, ends = "batten", count, gap })
  // -> { ok: true, space, width, ends, count, gaps, exactGap, gap, total, leftOver,
  //      setOut: [{ n, start, end }] }
  //  | { ok: false, error: "<sentence>" }
```

- **Inputs** are millimetres in 0.5 mm steps. `space` 1–20000; `width` 1–1000; `ends` `"batten"` (starts and ends on a batten, as the workbook) or `"gap"` (a gap at each end). Give exactly one of `count` (a whole number, 2–1000 with batten ends, 1–1000 with gap ends) or `gap` (0.5–10000).
- **Gaps:** `gaps` = count − 1 (batten ends) or count + 1 (gap ends).
- **Given the count:** `exactGap` = (space − count × width) / gaps.
- **Given a gap:** the count whose `exactGap` is closest to the gap asked for, out of the whole numbers either side of the exact answer and within the limits; a tie takes more battens.
- **Rounding:** `gap` is `exactGap` **rounded down** to the 0.5 mm, so the run never comes out longer than the space. `exactGap` is reported to 0.01. `total` = count × width + gaps × gap; `leftOver` = space − total (≥ 0).
- **Set-out:** batten `n` (1-based) starts at (n − 1)(width + gap) with batten ends, or gap + (n − 1)(width + gap) with gap ends, measured from the start; `end` = start + width. Any left-over sits at the far end.
- **Refusals** (`ok: false`, nothing thrown): a bad or missing input names it (`"The space to fill must be from 1 to 20000 mm, in 0.5 mm steps"` and so on); both or neither of `count` and `gap` → `"Give the number of battens or the gap you'd like"`; batten ends with fewer than 2 → `"Starting and ending on a batten needs at least 2 battens"`; a gap under 0.5 mm, or no count that leaves one → `"<count> battens of <width> mm don't leave a gap in <space> mm"` (or, from a gap, `"Battens of <width> mm with a <gap> mm gap don't fit in <space> mm"`).
- **The workbook check:** `{space: 1768, width: 25, count: 22}` → gap 58, total 1768, left over 0, batten 2 starts at 83, batten 22 at 1743 and ends at 1768; `{space: 1768, width: 25, gap: 58}` → count 22.

## 7. Prints (B)

All A4 portrait, black on white, between the `style-check: print-start` / `print-end` comments; the shell, buttons and the screen chrome hidden; `document.title` names the sheet. The letterhead banner is `/assets/invoice-letterhead.png` (as the paint order), under it the business address, phone and email on one line.

- **Stone order** (`document.title` "Stone order <job reference> rev <n>"; a draft: "… draft"):
  - "Stone benchtop order", **To:** the supplier, **Revision** n and **Date sent** (the revision's `sentDate`, never today).
  - Blocks: **Job** (job reference, quote number, site address, site access); **Contacts** (our contact and phone, client and phone); **Stone** (brand, colour, edge height, edge profile); **Dates** (cabinetry install, measure / template, **requested benchtop install** in bold).
  - The line "Please mark all details, including cut-outs, on site before the final measure."
  - **Notes**, then **Ordered by** (the sender's name) and **Date** (the sent date).
  - A print of the current form when it's a draft or has unsent changes carries **DRAFT – NOT SENT** at the top, with no revision or sent date.
  - One page; long notes may run to a second.
- **Benchtop sheet** (`document.title` "Benchtop sheet <job name>", or "Benchtop sheet" blank):
  - The banner and address line, then **Job**, **Client**, **Site address**, **Quote**, and **Benchtop** (the Joinr text joined with "; ").
  - Then a large ruled-border blank drawing area filling the rest of the page, and at the foot the **edge key**: `[ ]` Square edge, `//` Rolled edge, `X` Raw edge.
  - The blank sheet has the same lines with empty space to write on. Always one page.

## 8. Pages, menu and access (scaffold)

`lib/pages.js` gains:

```js
// M12 (docs/plans/m12-contracts.md section 8).
"/stone.html": "design.view",
"/stoneprint.html": ["jobs.view", "design.view"],
"/battens.html": "design.view",
```

`public/shell/shell.js`, the Design/PM department, after Intake: **Stone orders** (`/stone.html`, `design.view`), **Batten calculator** (`/battens.html`, `design.view`). The bar's width doesn't change. `stoneprint.html` isn't on the menu.

Who sees what: admin, Design/PM and Ordering get both items; Accounts and Scheduling see stone orders on the job page and print them, without the Stone orders page; Workshop, Workshop Manager and Showroom see none of it.

## 9. The pages

All pages:
- Pass `node ci/style-check.js` and follow the house style (`tokens.css`, `components.css` `hs-`, the shell's `cc-dialog*`, `shared.js`), and carry `#cc-shell`.
- Put user text in through `textContent`, and hide every control the user can't use (`cc.can()`).
- Have no horizontal page scroll at 375 px (tables scroll inside their own box).
- Show a job name as a link to `/job.html?id=…#benchtops` only with `jobs.view`.

### 9.1 Job page (B)

- **From Joinr** (lead's default 6): when the intake record's `quote.raw.benchtops` has entries, one more summary item, **Benchtop (as typed)**, the entries joined with "; ".
- **A new Benchtops section** (`section#benchtops.jo-sec`, heading "Benchtops"), after Orders and before Inspection, shown with `jobs.view`, loaded from `GET /api/job-records/:id/stone`:
  - Each stone order not cancelled (**Show cancelled** toggles the rest, as Orders): supplier, brand and colour, edge height and profile, measure date, requested install date, and the state:
    - **Draft**;
    - **Sent rev n, d Mon** (with who);
    - **Changed since rev n** in orange;
    - **Cancelled**.
  - Per order: **Open** (`/stone.html?id=…`, with `design.view`) and **Print** (`/stoneprint.html?id=…&rev=n` when sent and unchanged, else `/stoneprint.html?id=…`).
  - Section buttons: **New stone order** (`/stone.html?job=<id>`, with `jobs.edit` and `design.view`, not on an archived job) and **Print benchtop sheet** (`/stoneprint.html?sheet=<id>`).
  - When the job's benchtop is `stone` and it has no stone order that isn't cancelled: "Stone benchtop: no stone order yet" in orange.
  - Empty otherwise: "No stone orders."
- The section's code may live in `public/jobstone.js` (loaded by `job.html` after `job.js`), so `job.js` changes stay small; `#benchtops` joins the hash jumps.

### 9.2 `/stone.html` (B, prefix `so-`)

- **No query: the list** ("Stone orders", from `GET /api/stone`):
  - A filter **Open / Cancelled / All** (kept in the hash).
  - A table: Job, Supplier, Stone (brand and colour), State (as §9.1), Measure, Requested install (orange when within 14 days and the order is a draft or has unsent changes), **Open**.
  - Empty: "No open stone orders." A line says "Start a stone order from its job's Benchtops section."
  - Header button **Print blank benchtop sheet** (`/stoneprint.html?sheet=blank`).
- **`?job=<id>`: a new order.**
  - The form prefilled from `GET /api/job-records/:id/stone` `prefill`.
  - **Save** posts the whole form (`POST`, 201) and replaces the URL with `?id=`.
  - Archived job or no `jobs.edit`: a sentence, no form.
- **`?id=<id>`: the order.**
  - The job (link), the state line (as §9.1) and the form in §3's order, grouped as the print: Supplier; Job; Contacts; Stone; Dates; Notes.
  - Supplier and stone brand have datalists from `GET /api/stone/suggestions`. Edge height and profile are selects with **Other…** revealing a text input; a stored value not on the list shows as Other with its text.
  - Buttons (`jobs.edit`, by state):
    - **Save** (PATCH with only what changed);
    - **Mark sent** (never sent) or **Send revision n+1** (sent with changes): a dialog with the sent date (default today, max today), which saves unsaved changes first, then sends;
    - **Print** (`stoneprint.html?id=…`);
    - **Cancel order** (a confirm);
    - **Restore** (cancelled).
  - **Revisions:** a list of "Revision n, sent d Mon yyyy by Name", each with **Print** (`&rev=n`).
  - Read-only (inputs disabled, no buttons but Print) without `jobs.edit`, on a cancelled order, or on an archived job.
  - A refused request shows its sentence by the buttons; a 400 naming fields marks those fields.

### 9.3 `/stoneprint.html` (B, prefix `sp-`)

- **Modes:**
  - `?id=N&rev=R` (`GET /api/stone/:id/revisions/:rev`): the frozen revision.
  - `?id=N` (`GET /api/stone/:id`): the current form, marked draft as §7 when it's a draft or has unsent changes.
  - `?sheet=<jobId>` (`GET /api/job-records/:id/benchtop-sheet`).
  - `?sheet=blank` (`GET /api/stone/letterhead`).
- On screen: the sheet as it will print (on a white paper box), with **Print** and **Back**. Prints as §7.
- No access or 404: a sentence.

### 9.4 Design/PM dashboard (B, `design.html`)

A second tile, **Stone orders**, from `GET /api/stone/summary`:
- "<n> drafts · <n> changed since sent", plus "<n> installs in the next 2 weeks" when not 0 (in orange).
- Link **Open Stone orders**. If the call fails, the tile is just the link.

### 9.5 `/battens.html` (C, prefix `bn-`)

- **Inputs:** Space to fill (mm), Batten width (mm, default 25), Ends (**Batten at each end** / **Gap at each end**), and **Work out** the gap (from the number of battens) or the number of battens (from the gap you'd like), with that one input. Results update as you type; a refusal shows its sentence.
- **Result:** "<count> battens of <width> mm, <gaps> gaps of <gap> mm", the exact gap, the total and the left-over.
- **The drawing:** the run as a strip scaled to the page width, battens filled and gaps empty, like the workbook. With many battens it stays one strip.
- **Set-out:** a table of Batten, Starts at, Ends at (mm from the start).
- **Print** (`document.title` "Batten set-out"): the inputs, the result, the strip and the set-out on A4 (the table in columns when long).
- Nothing is saved: no server call, no storage.

## 10. Tests and checks

### 10.1 `ci/smoke.sh` (scaffold)

- After the M11 loop and before step k: `for f in "$(dirname "$0")"/smoke-m12-*.sh; do [ -f "$f" ] && source "$f"; done`, with a comment naming this file.
- The key count stays 27 and the presets are unchanged.
- Step k must still pass (the old app's database migrated through 025).

### 10.2 `ci/smoke-m12-stone.sh` (A), `step "m12. stone orders and the benchtop sheet"`

M-suite rules apply: sourced, no shebang, no `set`, the shared helpers and jars (`$ADMIN`, `$DPM`, `$ORDR`, `$ACCT`, `$SCHED`, `$WSMGR`), prefix `M12_S_`, no pristine-DB assumption, made-up names with a run tag, today from the server.

- **Access:**
  - `/stone.html`: dpm 200, ordr 200, acct 403, wsmgr 403.
  - `/stoneprint.html`: acct 200, sched 200, wsmgr 403.
  - `GET /api/stone`: ordr 200, acct 403. `GET /api/stone/summary`: dpm 200, wsmgr 403.
- **Create:**
  - admin makes a job with a quote number, site address, client name and phone, a promised install date and benchtop `stone`.
  - dpm `POST /api/job-records/<id>/stone {}` → 201: draft, revision 0, `jobReference` the job name, `quoteNumber`, `clientPhone`, `cabinetryInstallDate` the promised date, `ourContact` dpm's display name.
  - `POST` with `{supplier: ""}` keeps supplier empty and the rest prefilled.
  - ordr `POST` → 403. acct `GET /api/job-records/<id>/stone` → 200 with both orders; wsmgr → 403.
- **Edit:** an unknown field → 400; a 201-character supplier → 400; a bad date → 400; ordr `PATCH` → 403; dpm `PATCH` → 200 with the fields changed.
- **Send:**
  - With brand and colour empty → 400 naming them.
  - Fill the needed fields with `requestedInstallDate` = today + 3. A future `sentDate` → 400.
  - Send → 200: status `sent`, revision 1, `sentDate` today, one revision.
  - Send again unchanged → 409.
  - `PATCH colour` → `changedSinceSent` true. Send with `sentDate` before revision 1's → 400. Send → revision 2.
  - `GET /api/stone/<id>/revisions/1` (acct, 200) has the old colour; revision 3 → 404. `GET /api/stone/<id>` has `business` with the five keys and no `abn`.
- **Summary and list:** `installsSoon` ≥ 1; the other order is counted in `drafts`; `GET /api/stone` holds the sent order; `?status=bogus` → 400.
- **Cancel and restore:**
  - Cancel → 200, `cancelled`, not in the open list, in `?status=cancelled`.
  - `PATCH` → 409; cancel again → 409; restore → `sent`, revision 2.
- **Archived job:** archive the job (admin): `POST` a new order → 409, `PATCH` → 409, cancel → 200.
- **Suggestions:** dpm sees the supplier and brand; ordr → 403.
- **Benchtop sheet:**
  - `GET /api/job-records/<id>/benchtop-sheet`: acct 200 with the job's name and `benchtopText` an array; wsmgr 403.
  - `GET /api/stone/letterhead`: ordr 200, wsmgr 403.
- **Orders untouched:** the job's `GET /api/job-records/<id>/orders` has no lines, and its `materialsOrderedDate` is still null.
- **Audit:** `stone.create`, `stone.update`, `stone.send`, `stone.cancel` and `stone.restore` rows for the order.

### 10.3 `ci/smoke-m12-battens.sh` (C), `step "m12. batten calculator"`

- **Access:** `/battens.html` dpm 200, ordr 200, acct 403, sched 403. `/battens.js` is served (200).
- **The maths in the image:** one `docker exec "$CONTAINER" node -e '…require("/app/public/battens.js")…'` that checks the cases below and prints `ok` (anything else fails the step with the output):
  - the workbook check of §6 both ways;
  - `{space: 1770, count: 22}` → gap 58, total 1768, left over 2, `exactGap` 58.1;
  - gap ends `{space: 1000, width: 50, count: 9}` → 10 gaps of 55, batten 1 starts at 55;
  - each refusal of §6 gives `ok: false` with its sentence;
  - a tie picks more battens: `{space: 100, width: 10, gap: 27.5}` (3 battens give 35, 4 give 20) → count 4.

### 10.4 Pages (B, C): local checks

As M11 §12.3:
- `node --check`, the style check, a shim boot with made-up data.
- Headless-Edge screenshots at 1440, 1100 and 375:
  - **B:** the job's Benchtops section (draft, sent, changed; the "no stone order yet" line), the From Joinr benchtop text, the list, a new form, a sent form with revisions, the send dialog, the Design/PM tile, and print to PDF of a stone order (sent and draft) and both benchtop sheets.
  - **C:** the calculator both ways, both ends, a refusal, a long run, and print to PDF.
- As each relevant role: admin, design_pm, ordering (read-only), accounts (job section and prints only).
- Keyboard reach of every control and dialog, no console errors from page scripts.
- B runs against A's contract with stubbed responses; the integrator re-checks with real data at 4.1.

### 10.5 Local checks (every task)

As M11 §12.4:
- `bash -n` and the smoke harness on each smoke file (fresh, then again on the same DB). **Only the integrator runs the whole adapted smoke** (at 4.1), so no two agents run full smokes at once (the stand-in Joinr's ports are fixed).
- `node --check`, `node ci/style-check.js`, a shim boot on a fresh `.dev/<task>/` with the four `*_DISABLED=1` flags.
- **Scaffold:** 025 on a fresh DB and on a copy of the latest local test database (pre-025 backup written, rows kept, `foreign_key_check` clean); the route matrix (every access value, 501s, summary zeros); the pages gated and the menu items seen per role; `smoke.sh`'s changed lines.
- **A:** a node replay of every §10.2 assertion against the shim, including `benchtopText` from a `joinr_intake` row inserted in the replay's DB; then `smoke-m12-stone.sh` in the harness; `smoke-m3-orders.sh` and `smoke-m10-orders.sh` still pass.
- **C:** a node run of every §6 rule against `public/battens.js`, then `smoke-m12-battens.sh` in the harness (the `docker exec` emulated by running the same `node -e` against the worktree's file).

## 11. Waves and file ownership

| Step | Who | Owns (only these files) | Starts after |
|---|---|---|---|
| **M12 · 2.2 Scaffold** | integrator | §1's scaffold rows | — |
| **3.1 Wave 1, A: stone backend** | worktree | `lib/stone.js`, `routes/stone.js`, `ci/smoke-m12-stone.sh` | scaffold |
| **3.1 Wave 1, B: stone pages and prints** | worktree | `public/stone.{html,css,js}`, `public/stoneprint.{html,css,js}`, `public/job.html`, `public/job.js` (From Joinr benchtop text, Benchtops section), `public/jobstone.js`, `public/design.html` | scaffold (stubbed responses) |
| **3.1 Wave 1, C: batten calculator** | worktree | `public/battens.js`, `public/battens.{html,css}`, `public/battenspage.js`, `ci/smoke-m12-battens.sh` | scaffold |
| **4.1 Integrate** | integrator | merges; §1's 4.1 rows; STATUS; real-data checks of B and C | all |

- **One wave** (plan §2.5): the three tasks share no file.
- **Worktree base:** each agent resets to the commit the integrator names, and junctions `crosscuts/app/node_modules` from the main checkout (PowerShell `New-Item -ItemType Junction` if `cmd //c mklink` is refused). Junctions are unlinked before a worktree is removed.
- Scratch goes in the agent's scratchpad, and is copied into `.dev/` by the integrator.

## 12. Points the integrator decided (Todd can change any)

1. **The form is stored field by field** (so the list can sort and show dates), and **each sent revision freezes the whole form as JSON**, so a reprint of revision n matches what was sent.
2. **A new stone order takes the job's details** for anything the request leaves out; anything sent as empty stays empty. The prefilled fields can be changed on the order without changing the job.
3. **Needed to send:** supplier, stone brand, colour, edge height, edge profile and the requested benchtop install date. A draft can be saved with anything missing.
4. **The sent date is typed** (default today): not in the future, not before the previous revision's. It's the date on the print, never today's date (the workbook's `NOW()` problem).
5. **Sending again needs a change:** an unchanged order can't make a new revision. Editing a sent order keeps it "sent" and shows "Changed since rev n" until it's sent again.
6. **Cancel keeps the order, and Restore brings it back**; nothing is ever deleted.
7. **An archived job takes no new stone orders or edits**; its orders can still be cancelled and printed.
8. **The edge height and profile lists live in the page** (workbook values plus Other); the server stores whatever text is chosen, so a new size needs no release.
9. **No notices** for stone orders. The Design/PM tile shows drafts, unsent changes and installs requested in the next two weeks.
10. **The prints are their own page** (`stoneprint.html`, `jobs.view` or `design.view`), so Accounts and Scheduling can print a job's stone order or benchtop sheet without the Stone orders page (which stays `design.view`, Decision 5).
11. **The prints carry the business name, address, phone and email** (as the paint order), not the ABN or bank details.
12. **The batten gap is rounded down to the 0.5 mm**, so the run never comes out longer than the space; what's left over is shown and sits at the far end. Inputs are in 0.5 mm steps.
13. **The benchtop text** on the sheet and the job page is the Joinr room text as typed (`raw.benchtops`), from the job's accepted or linked Joinr record.
14. **The Stone orders list has no New button:** a stone order starts from its job's Benchtops section, so it always belongs to a job.
