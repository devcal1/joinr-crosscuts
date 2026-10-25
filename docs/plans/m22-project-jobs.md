# Project jobs: contract (0.2.1, Todd 2026-10-25)

The Projects department is given jobs; each job has one owner in Projects, whose worker colour its tile takes. The job's project page holds the hours, the materials list (with colour and finish), the hardware list (brand, code, supplier) and job notes. The output of the stage is a finalised order list; sending it moves the job to **Ordering**, the next stage.

Everything in `m1-contracts.md` ... `m21` still holds. CLAUDE.md applies: additive migration only, `defineRoutes` with an access value on every route, house style, no new feature keys, board files untouched.

Code: `db/migrations/041_project_jobs.sql`, `lib/projectjobs.js`, `routes/projectjobs.js`, the stage halves in `lib/jobstage.js`, the new line fields in `lib/materials.js`, Accept with an owner in `routes/joinr.js`; pages `public/project.html|js|css`, `public/projectorder.html|js|css`, `public/projectowner.js` (job page), and changes to `pipeline.js|css`, `job.js|html`, `jobs.js`, `intake.js|css`. Test: `ci/smoke-m22-project-jobs.sh`. How-to: `docs/how-to-project-jobs.md`.

## 1. Migration `041_project_jobs.sql` (additive)

| Table | Column | Meaning |
|---|---|---|
| `jobs` | `project_owner_id` | NULL or a `users.id`: the job's one owner in Projects. Separate from `job_people` (the name chips). |
| `jobs` | `sent_to_ordering_at` | NULL, or when the job was sent (or moved by hand) to Ordering. |
| `jobs` | `project_notes` | NOT NULL default `''`, at most 5000: the project page's job notes. |
| `job_materials` | `colour`, `finish`, `brand`, `code` | NULL or at most 100 characters each. |
| `job_materials` | `supplier` | NULL or at most 200: who the line is ordered from. |

New table `project_order_lists`: `id`, `job_id`, `revision` (A, B, ... Z, AA ...; unique per job), `lines_json` (the frozen lines), `line_count`, `fingerprint` (sha256 of the frozen fields of the live lines at finalise), `finalised_at`, `finalised_by`, `sent_at`, `sent_by`. No existing row is rewritten: existing design_ordering jobs show as Projects because their `sent_to_ordering_at` is NULL.

## 2. Projects and Ordering (the two halves of design_ordering)

Migration 003's CHECK on `jobs.stage` can't take a new value, so the stored stage stays `design_ordering`. Every job object gains `pipelineStage`: the stored stage, except `design_ordering` reads `projects` while `sent_to_ordering_at` is NULL and `ordering` once it is set.

- `POST /api/job-records/:id/stage`, `PATCH /api/job-records/:id` and `POST /api/job-records` take `projects` and `ordering` as stages, alongside the stored names. Both store `design_ordering` (with the usual stage rules, key dates and audit). `ordering` sets `sent_to_ordering_at` (when NULL); `projects` clears it. Each change is audited as `job.ordering` (`before`/`after` `{sentToOrderingAt}`).
- `from` may be the stored stage or the shown one; a shown `from` that is no longer true is a 409 "Someone else has moved this job".
- A plain `design_ordering` move leaves the column alone, and leaving design_ordering never touches it (nothing is cleared on the way out; a job brought back shows in the half it was in).
- `GET /api/job-records?stage=projects|ordering` filters by the shown half.
- The Pipeline has a **Projects** and an **Ordering** column in place of Design / ordering; the job page's stage list and the Jobs list show the shown name. The Admin photo page's "open" stages are unchanged (stored names).

## 3. The line fields

`POST` and `PATCH /api/job-records/:id/materials[/:lineId]` (unchanged access: jobs.edit) take `colour`, `finish`, `brand`, `code`, `supplier` (blank stores NULL; over the limits 400 "`<field>` must be N characters or fewer"). Every line in the list answers them. They are Crosscuts-only: a Joinr sync never writes them, and setting them does **not** mark a Joinr line edited (so the sync keeps refreshing its name and quantity). Changing any other field still does.

The **Hardware** list is the lines in the `hardware` and `handles` sections; **Materials** is every other section.

## 4. The owner

- `GET /api/project-owners` (jobs.view) → `{owners: [{id, name, hue|null}]}`: every enabled user holding `design.view` (the owner holds every key), A to Z; `hue` is the linked board worker's colour.
- `PUT /api/job-records/:id/owner` `{ownerId: id | null}` (route access `["jobs.edit", "users.admin"]`; inside, users.admin, or jobs.edit together with design.view, else 403). Missing `ownerId` 400; not an id 400; not in the owner list 400 "The owner must be an active user with Projects access". Audited `job.owner` (`{ownerId, name}` before and after). Answers the project summary (section 5).
- `POST /api/joinr/intake/:id/accept` takes an optional `{ownerId}`. It is checked before anything is written (the same 400s and, without the right to set an owner, 403) and set in the same transaction as the accept.
- Every job object carries `owner: {id, name, hue} | null` (and the raw `projectOwnerId`).
- **Tiles:** on the Pipeline's Projects and Ordering columns a tile's background is its owner's worker colour (`hueColors(hue).bg`, the worker-colours exception) with "OWNER name" on it; no owner (or an owner with no linked worker) is the neutral grey `--na` with "NO OWNER". Tiles there also have a **Project** link.
- The job page shows "Project owner" (a picker for those who may set it, text for the rest) and a **Project page** link. Intake's Accept has an owner picker beside it.

## 5. The project page

`GET /api/job-records/:id/project` (jobs.view) →

```
{ job: {id, name, clientName, siteAddress, quoteNumber, stage, pipelineStage, sentToOrderingAt, projectNotes, owner},
  hours: {quotedFactoryMin, quotedInstallMin, booked: {manufacturing: {toDate, ahead}, installing: {toDate, ahead}}},
  materials: [line], hardware: [line], sections,
  problems: [{id, name, missing: ["supplier" | "quantity"]}],
  orderList: {current: rev | null, changed: bool | null, nextRevision, revisions: [rev]},
  can: {edit, setOwner, send} }
rev = {revision, lineCount, finalisedAt, finalisedBy, sentAt, sentBy}
```

- **Hours:** quoted factory and install minutes from the job's Joinr record (`bonuses.joinrHours`: Joinr's hours doubled back, as for bonuses). Actual time: the board books people by the day, not the hour, so it is **person-days** (one worker on one day of one of the job's week rows), split by panel (manufacturing = factory, installing = install), up to and including today ("to date") and later ("ahead"). The page shows quoted hours with "about N days" at 8 hours a day beside the booked days, and says so.
- `PUT /api/job-records/:id/project/notes` `{notes}` (jobs.edit): text up to 5000, else 400. Audited `job.project_notes`.
- The page (`/project.html?id=N`, jobs.view) edits lines in place (a field saves on change), adds and removes lines, offers Fill/Update from Joinr when the job is tied to Joinr, and has the owner picker.

## 6. Finalise, print and send

- `POST /api/job-records/:id/project/finalise` (jobs.edit). No live lines: 400 "Add materials or hardware before finalising". Any live line without a supplier, or without a quantity above 0: 400 "N lines need a supplier and a quantity before finalising" with `problems`. Unchanged since the latest revision: 409 "Nothing has changed since revision X". Otherwise freezes the live lines (id, section, name, qty, unit, colour, finish, brand, code, supplier, notes, hardware) as the next revision. 201, the summary. Audited `project.finalise`.
- Any later change to a live line (added, removed, any frozen field) makes `orderList.changed` true; the next finalise is the next letter.
- `GET /api/job-records/:id/project/order-lists/:rev` (jobs.view): the revision with its lines split into materials and hardware, the job's name, client, site, quote number and owner name, and `superseded` (a later revision exists). Unknown: 404. Printed at `/projectorder.html?id=N&rev=A`: A4 portrait, black on white, grouped by supplier A to Z, a tick column.
- `POST /api/job-records/:id/project/send` (orders.edit). The job must show Won, Projects or Ordering (else 409). No revision: 409 "Finalise the order list first". Changed since the latest: 409 "The list has changed since revision X. Finalise it again first." Already sent: 409 "Revision X has already been sent to Ordering". Otherwise, in one transaction: each frozen line still live and without a live order line becomes a `to_order` order line on the job (`orders.createLine`, supplier from the line, description "name, brand, code, colour, finish, qty unit", notes), in supplier order A to Z; the line's `order_id` is set; lines already ordered are skipped. The revision's `sent_*` are set, and the job moves to Ordering (section 2) if it is not there. Answers `{revision, created, skipped, suppliers, ...summary}`. Audited `project.send`.
- A revision sent after the first sends only the lines not yet ordered (new lines). A change to an already ordered line (say its quantity) does not change its order line: Ordering adjusts that order line on the Orders page.

## 7. Access summary

| Route | Access |
|---|---|
| `GET /api/project-owners` | jobs.view |
| `PUT /api/job-records/:id/owner` | jobs.edit + design.view, or users.admin |
| `GET /api/job-records/:id/project` | jobs.view |
| `PUT /api/job-records/:id/project/notes` | jobs.edit |
| `POST /api/job-records/:id/project/finalise` | jobs.edit |
| `GET /api/job-records/:id/project/order-lists/:rev` | jobs.view |
| `POST /api/job-records/:id/project/send` | orders.edit |
| `/project.html`, `/projectorder.html` | jobs.view |
