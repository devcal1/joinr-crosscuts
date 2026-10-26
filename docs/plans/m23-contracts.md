# Projects steps and hand-offs: contract (0.2.2, Todd 2026-10-26)

Plan: `m23-plan.md` (part of `workflow-roadmap.md`). Builds on 0.2.1 (`m22-project-jobs.md`). Everything in `m1-contracts.md` ... `m22` still holds, except where a section below changes it. CLAUDE.md applies: numbered migrations, `defineRoutes` with an access value on every route, house style with text marks, board files untouched.

Code: migrations `042_project_steps.sql`, `043_workshop_department.js`, `044_projects_channel_name.sql`; `lib/projectsteps.js`, `routes/projectsteps.js`; changes to `lib/projectjobs.js`, `routes/projectjobs.js`, `routes/jobs.js`, `lib/planner/auto.js`, `lib/messages.js`, `lib/permissions.js`, `lib/notes.js`, `lib/team-tasks.js`, `lib/recurring.js`, `server.js`; pages `public/project.html|js|css`, `public/pipeline.html|js|css`, `public/notes.html|css`, `public/projectsdash.js`, `public/orders.html|js|css`, `public/job.js`, `public/shell/shell.js`. Test: `ci/smoke-m23-project-steps.sh`. How-to: `docs/how-to-project-jobs.md`.

## 1. Migrations

**042 `project_steps` (additive).**

| Table | Column | Meaning |
|---|---|---|
| `job_steps` (new) | `job_id`, `step` (`drawn` \| `check_measured` \| `nested`), `done_at`, `done_by` | One row per ticked step; primary key (job_id, step). An untick deletes the row; the audit log keeps the history. |
| `check_measures` (new) | `id`, `job_id`, `date`, `time`, `host`, `notes`, `status` (`booked` \| `done` \| `cancelled`), `created_*`, `updated_at` | Like `inspections`. |
| `jobs` | `requested_install_date` | NULL or a real Sydney date. `promised_install_date` stays the confirmed date. |
| `channels` | `access_key` | NULL, or a feature key that opens the channel. |

042 also inserts two channels: `ordering` "Ordering" (access_key `notes.ordering`, position 5) and `workshop` "Workshop" (`notes.workshop`, position 6). Migration 012's role CHECK can't name these departments, so they open by key.

**043 `workshop_department` (a rebuild; Todd's sign-off 2026-10-26).** `dept_notes`, `recurring_tasks` and `dept_tasks` list the five departments in a CHECK. Each is rebuilt by 021's method from its live CREATE statement with `'workshop'` added, together with the two children (`dept_note_acks`, `recurring_occurrences`): copy, compare (count and EXCEPT), drop the children then the parents, rename, re-create the indexes, check counts, `foreign_key_check` and that the children still reference their parents. No row is added, changed or removed. The runner's VACUUM INTO backup comes first; any throw rolls the whole file back.

**044 `projects_channel_name` (a data change; Todd's approval 2026-10-26).** `UPDATE channels SET name = 'Projects' WHERE slug = 'design' AND name = 'Design/PM'`. No message or read marker is touched.

## 2. Steps and check measures

- Who may tick and book: `users.admin`, or `jobs.edit` with `design.view` (the owner rule, m22 section 4). Routes take `["jobs.edit", "users.admin"]` and check the pair inside (403).
- `PUT /api/job-records/:id/steps/:step` `{done: true|false}`. Unknown step 400; `done` not a boolean 400; unknown job 404. Ticking records now and the user; unticking deletes. Audited `job.step` (`before`/`after` `{step, done, doneAt?, doneBy?}`). Answers the project summary.
- "Order list ready" is derived: the latest revision exists and the live lines have not changed since (`orderList.current && !orderList.changed`).
- `GET /api/job-records/:id/check-measures` (jobs.view) → `{checkMeasures: [cm]}`, newest first. `cm = {id, jobId, date, time|null, host, notes, status, createdAt, updatedAt, createdByName}`.
- `POST /api/job-records/:id/check-measures` `{date, time?, host?, notes?}` → 201 `{checkMeasure, ...summary}`. Date YYYY-MM-DD real, else 400; time HH:MM 24 h, else 400; host defaults to the booker's name (200 max), notes 2000 max. Audited `check_measure.create` on the job.
- `PATCH /api/check-measures/:id` `{status?, date?, time?, host?, notes?}` → `{checkMeasure, ...summary}`. A cancelled one is 409 "A cancelled check measure can't be changed". `status: "done"` also ticks Check measured. Audited `check_measure.update`.
- **Planner:** booked and done check measures are automatic items on the **Projects** layer (`design_pm`): `source "check_measure"`, `sourceLabel "Projects"`, title "Check measure: <job>", on its date (with its time when set), linking to `/project.html?id=N#steps` for jobs.view holders.
- **Project summary** (`GET /api/job-records/:id/project`, m22 section 5) gains `steps {drawn, check_measured, nested}` (each `{doneAt, doneBy: {id, name}} | null`), `marks` (section 6), `checkMeasures`, `job.requestedInstallDate`, `job.promisedInstallDate`, and `can.steps`.

## 3. Owner on arrival

- **Alert:** every live Won job (`stage = 'won'`, not archived) with no project owner sends one bell alert per person who may set an owner (users.admin, or jobs.edit with design.view): kind `project.owner_needed`, title "<job> needs a project owner", link `/project.html?id=N`, entity job. Once per person per job, read or not. The sweep runs after every non-GET `/api` response, at boot and every 5 minutes (the Joinr pull makes Won jobs by itself). `OWNER_SWEEP_DISABLED=1` turns the timer off.
- **Move:** setting an owner on a job shown at Won moves it to Projects (an audited `job.stage` move, from `won` to `design_ordering` with `sent_to_ordering_at` NULL). A job the board holds is left where it is. This holds for `PUT /api/job-records/:id/owner` and for Accept with an owner (m22 section 4), so an accepted job with an owner arrives at Projects.
- **Pipeline:** a **No owner** button narrows the Won, Projects and Ordering columns to jobs with no owner. Won tiles also show "Owner name" / "No owner".

## 4. Requested install date

- `requestedInstallDate` is a plain job field (`PATCH /api/job-records/:id`, `POST /api/job-records`; jobs.edit; a real date or null, else 400). Every job object carries it. Edited on the project page (Steps panel) and the job page (Dates).
- `POST /api/job-records/:id/project/send` refuses a job without one: 400 "Enter a requested install date before sending to Ordering" (checked after the stage check, before the revision checks).

## 5. Order manager alert

On a successful Send to Ordering, every holder of `orders.mark_ordered` except the sender gets kind `project.sent`, title "Order list for <job> sent: N lines, M suppliers" (N = order lines made by this send, M = their suppliers), body "Revision X", link `/orders.html?job=N`. The Orders page reads `?job=N`, lists only that job's lines (`GET /api/orders?jobId=N`) and shows "Showing <job> only" with **Show all jobs**.

## 6. Marks and ordering progress

- `marks` = `[{mark, label, done}]` in order D (Drawn), CM (Check measured), N (Nested), OL (Order list ready).
- Every job object carries `projectMarks` (the marks while shown at Won, Projects or Ordering, else null) and `orderingProgress` (`{ordered, total, latestEta}` while shown at Ordering, else null): `total` = the job's order lines not cancelled, `ordered` = those ordered or received, `latestEta` = the latest expected date among lines still to order or ordered.
- **Tiles:** Projects tiles show the four marks (done in full text, missing faded); Ordering tiles show "n/m ordered" ("No order lines" when none). Text only.

## 7. Naming tidy and Workshop

- The design channel's stored name is Projects (044); the display rename from 0.2.0 stays harmless.
- Channel visibility (`lib/messages.js` `channelsFor`): admins see every channel; a channel with an `access_key` opens to holders of that key; otherwise as before (role NULL for everyone, else the role).
- **Workshop, the sixth department:** new feature key `notes.workshop` (36 keys; the admin preset 33), in the presets `workshop`, `workshop_manager` and (as every non-owner key) `admin`. `lib/notes.js` DEPTS (the Workshop notes wall, `/notes.html?dept=workshop`), `lib/team-tasks.js` TEAMS ("Workshop team"), `lib/recurring.js` DEPTS (Workshop, on the Workshop Planner layer). The menu has a plain **Workshop** department (no rule) whose name opens its notes wall; M27 adds Maintenance under it.

## 8. My projects

- `GET /api/my-projects[?all=1]` (design.view) → `{all, canAll, jobs: [row]}`. Without `all` (or without users.admin) the rows are the signed-in user's owned jobs; `all=1` with users.admin gives every owner's. Rows: live (not archived) jobs with an owner, shown at Won, Projects, Ordering, Ready to cut or On board, by requested install date (none last) then name.
- `row = {id, name, clientName, pipelineStage, owner {id, name, hue}, marks, requestedInstallDate, promisedInstallDate, revision|null, revisionChanged|null, ordering {ordered,total,latestEta}|null (null at Won and Projects), waitingOn}`.
- `waitingOn`: at Ordering "With Ordering", Ready to cut "Ready to cut", On board "On the board"; otherwise the first of "Draw", "Check measure booked <d Mon>[ time]" or "Book or tick the check measure", "Nest", "Finalise the order list", "Finalise the changes since revision X", "Enter a requested install date", "Send to Ordering".
- Shown on the Projects notes wall (`/notes.html?dept=design`) above "Available now", one table row per job; admins get **Show all owners**.

## 9. Access summary

| Route | Access |
|---|---|
| `PUT /api/job-records/:id/steps/:step` | users.admin, or jobs.edit + design.view |
| `GET /api/job-records/:id/check-measures` | jobs.view |
| `POST /api/job-records/:id/check-measures` | users.admin, or jobs.edit + design.view |
| `PATCH /api/check-measures/:id` | users.admin, or jobs.edit + design.view |
| `GET /api/my-projects` | design.view (`all=1` needs users.admin) |

## 10. Open for Todd's look

- The tile marks wording (D CM N OL; faded when missing).
- Whether unticking a step should need an admin (today anyone who may tick may untick; the audit log keeps it).
- Who gets the owner alert: admins and anyone with jobs.edit + design.view (the people who can set the owner). Order managers (design.view without jobs.edit) don't.
