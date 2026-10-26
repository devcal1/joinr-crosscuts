# M23 plan: Projects steps and hand-offs (0.2.2)

Part of `workflow-roadmap.md` (read it first for Todd's decisions). Builds on 0.2.1 (`m22-project-jobs.md`: Projects/Ordering display stages over stored `design_ordering`, `jobs.project_owner_id`, project page `/project.html`, order list revisions, Send to Ordering).

## Goal

The project manager's four steps are recorded on every job, nobody's job sits without an owner, each project manager sees their own work, and Send to Ordering hands the job on with a requested install date and an alert to the order manager.

## Build

1. **Project steps (migration 042, additive).** New table `job_steps` (job_id, step in `drawn | check_measured | nested`, done_at, done_by, undone history in audit), plus check measure booking columns on it or a small `check_measures` table (date, optional time, host, notes, status booked/done/cancelled, like `inspections`). "Order list ready" is not stored: it is derived from a finalised current revision (M22).
   - Project page: a Steps panel with three tick buttons showing who/when, untick allowed (audited), and Book check measure (date, time, notes). A booked check measure appears on the Planner on the Projects layer.
   - Access: jobs.edit with design.view, or users.admin (same rule as setting the owner).
2. **Owner on arrival.** When a Won job has no project owner, bell holders of users.admin and design.view: "X needs a project owner". A "No owner" filter on the Pipeline. Setting an owner on a Won job moves it to Projects (audited stage move).
3. **My projects.** A section on the Projects notes wall (`/notes.html?dept=design`, `public/projectsdash.js`) for the signed-in user's owned jobs, one line per job: steps done (text marks D, CM, N, OL), requested install date, current revision, ordering progress (n of m ordered, latest ETA), and what is waiting on them. A "show all owners" toggle for admins.
4. **Requested install date.** `jobs.requested_install_date` (Sydney date). Edited on the project page and the job page. Send to Ordering requires it (400 "Enter a requested install date before sending to Ordering").
5. **Order manager alert.** On Send to Ordering, bell holders of orders.mark_ordered: "Order list for X sent: N lines, M suppliers", linking to Orders filtered by the job.
6. **Pipeline tile marks.** Projects tiles show the step marks (done marks in body text, missing ones muted); Ordering tiles show "n/m ordered". Text only.
7. **Naming tidy.** Rename the Design/PM messages channel's stored name to Projects (an UPDATE in an additive migration; Todd approves this as a data change before it runs). Add Ordering and Workshop channels. **Workshop becomes a sixth department** (Todd, 2026-10-26): a `notes.workshop` key (workshop, workshop_manager, admin) for its notes wall, a Workshop department in `lib/recurring.js` DEPTS on the workshop Planner layer, and a Workshop menu heading (M27 adds Maintenance under it).

## Deliverables

Migration 042 (and 043 for the channel rename if kept separate), `lib/projectsteps.js` + routes through defineRoutes, project page and Pipeline changes, contract `m23-contracts.md`, how-to update `docs/how-to-project-jobs.md`, smoke `ci/smoke-m23-project-steps.sh`, version 0.2.2, STATUS.md.

## Open for Todd's look

The step marks wording on tiles; whether unticking a step needs admin.
