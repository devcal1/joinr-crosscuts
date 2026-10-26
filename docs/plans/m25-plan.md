# M25 plan: Workshop end-of-shift report (0.2.4)

Part of `workflow-roadmap.md`. Needs M23 (project owner, Workshop channel). Todd's decision: each workshop person sends their own report from their own phone login.

## Goal

At the end of every shift each workshop person sends photos of the jobs they installed and flags issues, and every issue reaches that job's project manager and the schedule manager.

## Build

1. **Feature key `shift.report`** (follow `docs/how-to-add-feature-key.md`), given to the `workshop` role and to admin. It allows: the shift page, uploading photos to a job it lists, and raising issues. It does not give photos.admin.
2. **Logins.** Workshop people get their own logins (Todd creates them on the Users page; emails or names). The TV keeps its own view-only login.
3. **Shift page `/shift.html`**, phone first (375 px), house style:
   - today's jobs from this week's board rows the person is on (plus a search for any live job);
   - per job: add photos (camera on phone, several at once; stored as `photos` with job_id and tag `install` or `shift`), a short note, and Raise an issue;
   - Send report: records a `shift_reports` row (user, date, jobs, note) so "sent today" is known.
4. **Job issues (migration 045, additive).** Table `job_issues` (job_id, body, raised_by, raised_at, status open/resolved, resolved_by, resolved_at, resolution note, photo ids). On raise: bell the job's project owner (else design.view holders) and board.edit holders; post to the Workshop channel. Shown on the job page, project page, My projects (M23) and the Needs install date / Morning check lists. Resolve: project owner, board.edit or admin.
5. **Reminder.** A weekday bell to workshop people who are on the board today and have not sent a report by a set time (setting `shift.reminder_time`, default 15:30; empty means off).

## Deliverables

Migration 045, `lib/shift.js`, `lib/issues.js`, routes through defineRoutes, `/shift.html` + css + js, contract `m25-contracts.md`, how-to `docs/how-to-shift-report.md`, smoke `ci/smoke-m25-shift.sh`, version 0.2.4, STATUS.md. Check photo upload limits and phone camera input on a real phone over Tailscale before the push.

## Open for Todd

The reminder time; whether a report is expected every shift or only on install days.
