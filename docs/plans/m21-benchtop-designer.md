# M21 contracts: the Benchtop designer (0.2.0)

Approved by Todd 2026-10-24 (mock-ups `designer` and `plan-print`). Short binding note; the how-to is `docs/how-to-benchtop-designer.md`.

## Data (migration 038_benchtop_designer, additive)

- `benchtop_materials` (supplier, range_name, colour, thickness_mm 5-200, active). Admin list.
- `benchtop_edge_finishes` (code, name, line_style in heavy/thin/double/dashed/dotted, sort, active). Admin list; seeded with PR Pencil round (heavy), AR Arris (thin), MITRE Mitred (double), BN Bullnose (dotted), RAW Raw, against wall (dashed).
- `benchtop_plans`: one per job (`job_id UNIQUE`), `design_json`, `notes` (max 4000), created/updated.
- `benchtop_plan_revisions`: `seq` (1 = A, 27 = AA), `letter`, `snapshot_json` (job, design, notes, the materials used and all finishes as they were, the letterhead), printed at/by.

## design_json

`{pieces: [piece]}`, at most 30. A piece: `id` (`[a-z0-9]{1,12}`, unique), `name`, `shape` (`straight` | `l` | `u` | `leg`), `materialId` (or null), `runs`, `edges`, `joins`, `cutouts`.

- `runs`: straight `[run]`; l `[back, return]`; u `[back, left return, right return]`; each `{len 50-10000, depth 50-2000}` mm. A run's length is its full outside length.
- leg: `leg: {width, height (50-3000), attachTo: piece id or null, end: start|end}`, no runs; drawn in elevation, top edge mitred.
- `edges`: `{eN: finishId}`; edges are numbered clockwise from the top-left corner (straight 4, L 6, U 8, leg 4). Unset = no finish.
- `joins`: `{run, at}` (mm from the run's start, 1 to len-1), at most 10.
- `cutouts`: `{kind sink|cooktop|tap|other, label, w, h (tap: h = w, the diameter), edge, along, in}`: along the reference edge from its start, and in from it, both to the cut-out's near sides. At most 20.

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

`/benchtop.html` (jobs.view; ?job=N, ?plan=N, ?plan=N&rev=B), `/benchtopprint.html` (jobs.view; ?plan=N&rev=B), `/benchtopadmin.html` (users.admin; menu Admin > Benchtop lists). The job's Benchtops section links "Benchtop plan"; the Benchtops page lists plans under the stone orders. Print: A4 portrait, black on white, stone-order letterhead, one common scale (1:10 to 1:200), pieces packed several per sheet, legend, cut-out table, material schedule, notes, "Check all sizes on site before cutting", page X of Y. "Send to supplier" is shown disabled (coming later). House-style exception eight: the Add piece shape diagrams (CLAUDE.md).

Smoke: `ci/smoke-m21-benchtop-designer.sh`.
