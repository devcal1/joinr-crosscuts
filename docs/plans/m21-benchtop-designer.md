# M21 contracts: the Benchtop designer (0.2.0)

Approved by Todd 2026-10-24 (mock-ups `designer` and `plan-print`). Short binding note; the how-to is `docs/how-to-benchtop-designer.md`.

## Data (migration 038_benchtop_designer, additive)

- `benchtop_materials` (supplier, range_name, colour, thickness_mm 5-200, active). Admin list.
- `benchtop_edge_finishes` (code, name, line_style in heavy/thin/double/dashed/dotted, sort, active). Admin list; seeded with PR Pencil round, AR Arris, MITRE Mitred, BN Bullnose, RAW Raw, against wall, then WF Waterfall (039) and SQ Square (040). Since 040 each finish is drawn by its mark, not its line style.
- `benchtop_plans`: one per job (`job_id UNIQUE`), `design_json`, `notes` (max 4000), created/updated.
- `benchtop_plan_revisions`: `seq` (1 = A, 27 = AA), `letter`, `snapshot_json` (job, design, notes, the materials used and all finishes as they were, the letterhead), printed at/by.

## design_json

`{pieces: [piece]}`, at most 30. A piece: `id` (`[a-z0-9]{1,12}`, unique), `name`, `shape` (`straight` | `l` (L shape, return on the left) | `lr` (L shape, return on the right) | `u`), `materialId` (or null), `x`, `y` (its place in the All view, mm), `runs`, `edges`, `drops`, `joins`, `cutouts`.

- `runs`: straight `[run]`; l and lr `[back, return]`; u `[back, left return, right return]`; each `{len 50-10000, depth 50-2000}` mm. A run's length is its full outside length. On the drawing every edge's length can be typed; it sets the run length or depth it comes from.
- `edges`: `{eN: finishId}`; edges are numbered clockwise from the top-left corner (straight 4, L 6, U 8). Unset = no finish.
- `drops`: `{eN: mm 50-1500}` for each edge whose finish is a waterfall (required). A waterfall finish goes on end edges only (straight e1/e3, l e1/e4, lr e2/e5, u e2/e6). Shown as "WF 870".
- `joins`: `{run, at}` (mm from the run's start, 1 to len-1), at most 10.
- `cutouts`: `{kind sink|cooktop|tap|other, label, w, h (outline only; tap: h = w), edge (= the piece's datum), located, along, in}`: along the reference edge from its start, and in from it, both to the cut-out's near sides. At most 20.
- `datum`: the piece's reference edge for located cut-outs; `thick`: built-up edges (see below).

Changed 2026-10-24 (Todd): the Waterfall leg piece was removed (it is now the Waterfall edge finish, migration 039 `benchtop_waterfall`: `benchtop_edge_finishes.waterfall` and a WF finish); leg pieces in older plans are dropped on read; L split into left and right; the All view and its positions.

## Drawing convention, totals and cut-outs (Todd, 2026-10-25; migration 040 `benchtop_marks`)

- Every edge is one thin unbroken line; its finish is a mark repeated across it: **X** unfinished (to a wall or panel), **//** finished and seen (arris, pencil round, bullnose, waterfall), **[]** seen and finished square. `benchtop_edge_finishes.mark` (X, //, []) replaces the line-style column in Admin (line_style stays in the table, unused). Seeded: RAW → X, SQ Square added → [], the rest //. Teal only marks the selection on screen.
- `thick: {eN: mm 5-200}`: an edge built up to another thickness than the material's (e.g. 40 mm) draws bold; the legend reads "Bold: 40 mm edge".
- Joins and cut-outs are drawn dashed.
- Cut-outs show only what they are (Sink, Cooktop, Tap hole, Cut-out, plus the label), never their size. `w`/`h` are kept for the drawn outline only. Each piece has one reference edge `datum` (default e0); every cut-out's `edge` is set to it by the server. A cut-out with `located: true` is dimensioned from that edge (along it, and in from it); the reference edge is labelled REF. The print lists cut-outs by piece and type, with no size table.
- Totals (screen and print): area in m² overall and per material (when more than one), and metres of each edge finish and of each built-up thickness. Area is the outline area (joins and cut-outs don't reduce it). Rounding: summed exactly in mm, then m² to 2 decimals and metres to 1 decimal.

## Letters, fills and the sheet (Todd, 2026-10-25)

- Pieces are lettered A, B, C... in list order (after Z: AA, AB...), on screen (list discs, drawing, panel) and on the print (drawing, schedule, cut-outs).
- On paper each piece is filled with a pale tint: light grey when the plan has one material; otherwise one tint per material in order of first use (six tokens `--bt-fill-g` and `--bt-fill-0..5` in tokens.css, paper only), with the matching swatch beside the material in the totals and the schedule. On screen the fill stays neutral (`--raised`): tinted fills on the dark ground would add colours outside the house style, so the screen does not show them.
- The sheet (A4 landscape), layout D approved by Todd 2026-10-25: a 14 mm header on every sheet (small letterhead, job and revision left; the bold totals, material swatches and edge metres right, in the same spot on every sheet), the drawing full width (the All arrangement at the largest standard scale up to 1:100, steps 1:10, 20, 25, 30, 40, 50, 75, 100, preferring one that keeps the footer band on the first sheet; else pieces in rows), then a short footer band (one-line key, pieces with swatch, material and joins, cut-outs, notes) and the page line (check all sizes on site, Page X of Y). Long notes or many pieces wrap; what doesn't fit goes on to the next sheet under the same header.

## Revisions

Print plan set (`POST /api/benchtop-plans/:id/print`) compares design and notes with the last revision: unchanged returns that letter; changed (or none yet) freezes the next letter. Revisions are read-only and reprint exactly.

## Routes (all through defineRoutes)

| Route | Access |
|---|---|
| GET/POST `/api/job-records/:id/benchtop-plan` | jobs.view / jobs.edit |
| GET `/api/benchtop-plans` (list) | design.view |
| GET / PUT `/api/benchtop-plans/:id` (PUT takes `expectUpdatedAt`, 409 if stale) | jobs.view / jobs.edit |
| POST `/api/benchtop-plans/:id/print` | jobs.edit |
| GET `/api/benchtop-plans/:id/revisions/:letter` | jobs.view |
| GET `/api/benchtop-lists` | jobs.view or design.view |
| POST `/api/benchtop-lists/:kind`, PATCH `/api/benchtop-lists/:kind/:id` (kind materials/finishes) | users.admin |

Archived jobs: create and save are 409. Audit actions: `benchtop_plan.create`, `.update`, `.revision`, `benchtop_material.create/.update`, `benchtop_finish.create/.update`.

## Pages

The designer opens on **All**: every piece together to scale, dragged to arrange, with edges, sizes, joins and cut-outs edited there; clicking a selected piece in the list shows it alone. The selected piece carries a red × (delete, confirmed). The print draws the All arrangement at the largest standard scale up to 1:100 that fits the first sheet, and falls back to pieces in rows across sheets when it does not.

`/benchtop.html` (jobs.view; ?job=N, ?plan=N, ?plan=N&rev=B), `/benchtopprint.html` (jobs.view; ?plan=N&rev=B), `/benchtopadmin.html` (users.admin; menu Admin > Benchtop lists). The job's Benchtops section links "Benchtop plan"; the Benchtops page lists plans under the stone orders. Print: A4 landscape, black on white, stone-order letterhead, the All arrangement to scale (or pieces in rows when it does not fit), legend, cut-out table, material schedule, notes, "Check all sizes on site before cutting", page X of Y. "Send to supplier" is shown disabled (coming later). House-style exception eight: the Add piece shape diagrams (CLAUDE.md).

Smoke: `ci/smoke-m21-benchtop-designer.sh`.
