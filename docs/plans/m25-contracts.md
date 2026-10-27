# Workshop end-of-shift report: contract (0.2.4, Todd 2026-10-27)

Plan: `m25-plan.md` (part of `workflow-roadmap.md`). Builds on 0.2.3 (`m24-contracts.md`). Everything before still holds except where a section below changes it. CLAUDE.md applies: additive migration, `defineRoutes` with an access value, house style (text only), board untouched.

Code: migration `046_shift_reports.sql` (the plan said 045; M24 took that number); `lib/shift.js`, `lib/issues.js`, `lib/photostore.js` (the upload and thumbnail step, moved out of `routes/photos.js` and shared), `routes/shift.js`; changes to `lib/permissions.js`, `lib/settings.js`, `routes/settings.js`, `lib/pages.js`, `lib/projectsteps.js`, `lib/handoffs.js`, `server.js`, `routes/photos.js`; pages `public/shift.html|css|js`, `public/jobissues.js|css` (on `job.html` and `project.html`), `public/projectsdash.js`, `public/schedulingdash.js`, `public/notes.css`, `public/users.html|js`, `public/shell/shell.js`. Test: `ci/smoke-m25-shift.sh`.

## 1. The key

`shift.report`, appended to `KEYS` (37 keys; admin preset 34). In the Workshop preset (now `board.view`, `planner.view`, `notes.workshop`, `shift.report`) and so admin's. It opens `/shift.html` and the `/api/shift/*` routes and lets the holder raise job issues. It does not give `photos.admin`.

## 2. Logins

Each workshop person signs in with their own login (Todd makes them on the Users page) and is linked to their board worker with the existing Worker picker (`users.worker_id`, migration 033). An unlinked login sees no board jobs, only search. The TV keeps its own login.

## 3. The shift page

`/shift.html` (shift.report), phone first, in the Workshop menu as **End of shift**.

- `GET /api/shift/today[?add=1,2]` → `{date, worker: {id, name, hue} | null, installDay, jobs: [{id, name, clientName, siteAddress, pipelineStage, panels, photosToday: [{id, url, thumbUrl, tags}], issues: [open issues]}], report: {note, jobIds, sentAt} | null}`. Jobs: this week's board rows (Sydney Monday) with the person's worker on today's day (none at the weekend), then the `add` ids and the jobs of today's report; archived jobs are left out. `panels` is `installing` and/or `manufacturing`, empty for an added job. `installDay` is true when any of today's rows is an install row. `photosToday` is the job's photos uploaded since Sydney midnight.
- `GET /api/shift/jobs?q=` → `{jobs: [{id, name, clientName, pipelineStage}]}`: live jobs (not archived, not complete/invoiced/lost/archived) whose name or client contains q (2 characters at least), 20 at most.
- `POST /api/shift/jobs/:id/photos` (multipart, field `photos`, up to 30; JPEG, PNG or WebP up to 25 MB each, as Photo admin) → 201 `{created: [{id, url, thumbUrl, tags}], failed}`. Stored as `photos` with the job id and the tag **install** when the person is on an install row for that job today, else **shift**; audited `photo.upload`. Unknown job 404; archived 400.
- `POST /api/shift/report` `{note?, jobIds?}` → `{date, note, jobIds, sentAt}`. One `shift_reports` row per person per Sydney day (`UNIQUE(user_id, date)`); sending again replaces it. Note 2,000 characters at most; an unknown job id 400. Audited `shift.report`.

## 4. Job issues

Table `job_issues` (job_id, body, photo_ids JSON, raised_by, raised_at, status `open`/`resolved`, resolved_by, resolved_at, resolution).

- `POST /api/job-records/:id/issues` `{body, photoIds?}` (shift.report) → 201 issue. The body is required (2,000 characters at most); photos must be this job's. Audited `issue.raise`. Bell kind `job.issue`, title "Issue on <job>: <first 80 characters>", body "Raised by <name>", link `/job.html?id=N#issues`, to the job's project owner (or, with no owner, every `design.view` holder) and every `board.edit` holder, except the raiser. A message "Issue on <job>: <text> (n photos)" is posted to the Workshop channel as the raiser.
- `GET /api/job-records/:id/issues` (jobs.view, design.view or shift.report) → `{issues: [...], canResolve}`, open ones first, newest first. Each issue: `{id, jobId, jobName, body, photos: [{id, url, thumbUrl}], raisedBy, raisedAt, status, resolvedBy, resolvedAt, resolution, canResolve}`.
- `POST /api/issues/:id/resolve` `{resolution?}` (route: board.edit, design.view or users.admin; the rule: the job's project owner, a board.edit holder or an admin, else 403). Already resolved 400. Audited `issue.resolve`.
- Shown: an **Issues** section on the job page and the project page (open issues with an orange edge, Resolve with a note for those who may); `openIssues` on each My projects job (M23) and each Needs install date job (M24), shown as "n open issues" linking to the job's Issues; the open issues on each shift card.

## 5. The reminder

Settings `shift.reminder_time` (Sydney `HH:MM`, default **16:00**, Todd 2026-10-27; empty is off) through `PUT /api/settings {shift: {reminderTime}}` (users.admin; else 400 "Shift reminder time must be HH:MM, or empty for off"), on Admin > Users, Business details, **Shift report reminder**. Every 60 s (off with `SHIFT_REMINDER_DISABLED=1`), on a weekday at or after the time and once a day (`shift.reminder_last_run`), every enabled `shift.report` holder whose worker is on an **install** row today (Todd 2026-10-27: install days only) and who hasn't sent a report gets kind `shift.reminder`, "Send your end-of-shift report", link `/shift.html` (one unread per day). `POST /api/shift/reminder/run` (users.admin) runs it now whatever the time, recording nothing → `{sent, date}`.

## 6. Access summary

| Route | Access |
|---|---|
| `GET /api/shift/today`, `GET /api/shift/jobs`, `POST /api/shift/report`, `POST /api/shift/jobs/:id/photos` | shift.report |
| `POST /api/job-records/:id/issues` | shift.report |
| `GET /api/job-records/:id/issues` | jobs.view, design.view or shift.report |
| `POST /api/issues/:id/resolve` | board.edit, design.view or users.admin (then owner, board.edit or admin) |
| `POST /api/shift/reminder/run` | users.admin |
| `PUT /api/settings` `{shift}` | users.admin |
| `/shift.html` | shift.report |

## 7. After the release

Check photo upload and the phone camera on a real phone, on the Umbrel install once released (Todd 2026-10-27: after the push, not before).
