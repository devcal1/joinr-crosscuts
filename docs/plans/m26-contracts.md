# Morning check and completion: contract (0.2.5, Todd 2026-10-26)

Plan: `m26-plan.md` (part of `workflow-roadmap.md`). Builds on 0.2.4 (`m25-contracts.md`). Everything before still holds except where a section below changes it. CLAUDE.md applies: additive migration, `defineRoutes` with an access value, house style, board layout untouched (the Finish week label change is the M26 exception in non-negotiable 7).

Code: migration `047_morning_check.sql` (the plan said 046; M25 took that number); `lib/morning.js`, `lib/completion.js`, `lib/mywork.js`, `routes/morning.js`; changes to `lib/production.js` (`currentStages`), `routes/schedule.js` (Finish week), `routes/jobs.js` (`awaitingConfirm`), `lib/settings.js`, `server.js`; pages `public/notes.html|css` + `public/morningcheck.js`, `public/confirmcomplete.js` (on `job.html` and `project.html`; styles in `jobissues.css`), `public/pipeline.js|css`, `public/index.html|js`, `public/schedule.js` (label text only). Test: `ci/smoke-m26-morning-complete.sh`; `ci/smoke-m2-invoices.sh` and `ci/smoke-m5-stages.sh` updated.

## 1. Data

Migration 047: `production_days(job_id, date, stage NULL or a production stage, note, set_by, set_at, PRIMARY KEY(job_id, date))` and `jobs.installed_date`. Setting `board.morning_last_done` (JSON `{date, doneOn, at, by}`; not in `/api/settings`).

A job's current production stage (`production.currentStages`, shown by the board's stage label) is the later, by when it was set, of its latest Finish week stage and its latest Morning check stage.

## 2. Morning check

Under the Scheduling notes wall (`/notes.html?dept=scheduling#morningCheck`), for board.edit.

- `GET /api/morning-check[?date=]` (board.edit) → `{date, today, done, doneToday, jobs, emptyRows, readyNotPlaced, installsNoPromised, openIssues}`. `date` defaults to the previous working day (Monday's is the Friday before). `jobs`: every job with someone on it that day (`{id, name, clientName, panels, people, currentStage, dayStage, note, stages: [{key, label}]}`, the stages that apply to the job). `emptyRows`: this week's rows with nobody on them. `readyNotPlaced`: Ready to cut jobs with no row this week or later. `installsNoPromised`: jobs with an install row this week and no promised install date. `openIssues`: every open job issue (M25).
- `PUT /api/morning-check/jobs/:id` `{date, stage | null, note?}` (board.edit): upserts the day's row (both empty deletes it). A stage that doesn't apply 400; note 300 characters at most. Audited `job.production_day`. → `{jobId, date, stage, note, currentStage}`.
- `POST /api/morning-check/done` `{date?}` (board.edit): Done for today. → `{done: {date, doneOn, at, by: {id, name}}}`.

## 3. Installed, then confirmed

- Finish week's `complete` outcome (shown as **Installed** in the dialog) sets `jobs.installed_date` to today (once; audited `job.installed`) and no longer completes the job. The project owner (else every design.view holder), except the person finishing the week, gets kind `job.installed`, "X installed: confirm complete", link `/project.html?id=N#confirmComplete`. The answer gains `installed: [jobIds]`; `completed` stays, always empty. Stages are still recorded. Jobs already complete are untouched.
- `awaitingConfirm` (on every job object): installed and not complete, invoiced, lost or archived.
- `GET /api/job-records/:id/completion` (jobs.view or design.view) → `{installedDate, completedDate, awaitingConfirm, canConfirm, openIssues}`.
- `POST /api/job-records/:id/confirm-complete` (route: design.view or users.admin; rule: the project owner or an admin, else 403; not waiting 409) runs the existing completion path (stage complete, `completed_date` today, the final invoice and pending extras fall due), audited `job.stage` with `via: "confirm_complete"`. Open issues don't block it; the page warns.
- The job and project pages show an orange line while a job waits: "Installed D Mon YYYY. Waiting for the project manager to confirm complete." with Confirm complete for those who may.
- The Pipeline shows waiting jobs in the Complete column, locked, marked **Awaiting PM confirm**.
- An admin's hand-set Complete (`PATCH` stage) still completes at once, as before.

## 4. Waiting on you

`GET /api/my-work` (login) → `{date, items: [{key, text, count, href}]}`, only lines with something in them:

| Who (key held) | Lines |
|---|---|
| design.view | `steps` (owned jobs at Won or Projects with a step to do), `noRequested` (owned jobs at Won, Projects or Ordering with no requested install date), `toConfirm` (owned installs to confirm; an admin sees every one), `myIssues` (open issues on owned jobs) |
| orders.mark_ordered | `toOrder` (lines to order), `noEta` (ordered lines with no expected date) |
| board.edit | `morning` (weekday, Morning check not done today), `needsInstall`, `issues` (open job issues) |
| shift.report | `shiftReport` (on the board today with no report sent) |

Accounts keeps its own dashboard line. Shown on the dashboard as a **Waiting on you** tile in Your work, hidden when empty.

## 5. Access summary

| Route | Access |
|---|---|
| `GET /api/morning-check`, `PUT /api/morning-check/jobs/:id`, `POST /api/morning-check/done` | board.edit |
| `GET /api/job-records/:id/completion` | jobs.view or design.view |
| `POST /api/job-records/:id/confirm-complete` | design.view or users.admin (then owner or admin) |
| `GET /api/my-work` | login |
