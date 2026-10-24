# M20: recurring tasks (0.2.0) — contract

Approved by Todd 2026-10-24. Admin > Tasks (`/admintasks.html`) keeps rules that make tasks on a
schedule. Code: `lib/recurring.js`, `routes/recurring.js`, `lib/team-tasks.js` (department tasks),
`lib/planner/auto.js` (Planner items). Smoke: `ci/smoke-m20-recurring.sh`.

## 1. Access

- Page `/admintasks.html` and every `/api/recurring` route: `users.admin` (the admin role's existing
  key, as the Users page). No new key. Menu: Admin > Tasks.

## 2. Data (migration 036_recurring_tasks.sql, additive)

- `recurring_tasks`: `title`, `notes`, `assignee_id` XOR `dept` (`scheduling|design|ordering|accounts|admin`),
  `repeat` (`weekly|fortnightly|monthly|annually|custom`), `repeat_every` 1–99 and `repeat_unit`
  (`day|week|month|year`) for custom only, `start_date` (first due date), `end_date` (last possible
  due date, optional), `lead_days` 0–60 (default 0), `active`, `created_from` (Sydney date the rule
  was made or last resumed), `created_by`, `updated_by`, timestamps, `deleted_at` (soft delete).
- `dept_tasks`: a department's shared task. Same columns as `team_tasks` (032), ids ≥ 2000000000,
  `team` any of the five departments, `source` = `'recurring'`. `team_tasks` stays as it is.
- `recurring_occurrences`: `recurring_id`, `due_date`, `task_id` (a `tasks` id or a `dept_tasks` id),
  **UNIQUE (recurring_id, due_date)**.

## 3. Routes (`/api/recurring`, all `users.admin`)

| Method | Path | Answer |
|---|---|---|
| GET | `/` | `{today, rules[], people[{id,name}], depts[{id,label}]}` |
| GET | `/:id` | the rule |
| POST | `/` | 201 the rule (then makes anything already due) |
| PATCH | `/:id` | the rule; optional `updatedAt` for the stale check (409) |
| POST | `/:id/pause`, `/:id/resume` | the rule |
| DELETE | `/:id` | 204; no more occurrences, tasks already made stay |
| POST | `/run` | `{date, made}`; body `{today?}` runs as of a date (never before the real today), for checks |

Rule body: `title`, `notes?`, `assigneeId` or `dept`, `repeat`, `repeatEvery?`, `repeatUnit?`,
`startDate`, `endDate?`, `leadDays?`. A rule answer adds `assignee {id,name}|null`, `deptLabel`,
`repeatText`, `active`, `nextDue`, `nextShows`, `lastDue`, `made`, `updatedAt`.

## 4. Generation

- Due dates follow the Planner's rules (`lib/planner/events.js` `occurrenceDates`): monthly and
  yearly keep the start's day, clamped to the month's length (29 Feb falls on 28 Feb outside a leap year).
- An occurrence due D is made when Sydney today ≥ D − lead days, and only if D ≥ `start_date`,
  D ≥ `created_from` (no backfill before the rule was made; resuming sets `created_from` to today, so
  paused days are skipped) and D ≤ `end_date`.
- The job runs at boot, hourly (`RECURRING_DISABLED=1` turns the timer off), after a create, edit or
  resume (that rule only), and on `POST /run`. The occurrence row, the task, follows and alerts are
  one transaction; the UNIQUE key means a second run makes nothing. At most 400 per rule per run.
- **Person:** a normal `tasks` row (assignee the person, creator the admin who made the rule, due D,
  no job) and a `task.assigned` alert. A person who is disabled or lacks `tasks.use` gets nothing.
- **Department:** one `dept_tasks` row ("<Dept> team", creator "Recurring task (automatic)") seen by
  every member (`tasks.use` + the department's `notes.*` key; admins hold every key), ticked once
  for all; each member follows it and gets a `task.assigned` alert.
- Overdue: an open task past its due date shows overdue (red); the next occurrence is still made.
- Audit: `recurring_task.create|update|pause|resume|delete` (entity `recurring_task`), and
  `task.create` for each task made (actor "Recurring task (automatic)").
- Task answers carry `recurring: true` when a rule made them.

## 5. Planner

Worked out on read (`lib/recurring.js` `plannerItems`, called from `lib/planner/auto.js`); nothing is
written to `planner_events`. Each occurrence is an all-day automatic item (`source: "recurring_task"`):
made ones on their task's current due date with its state ("Done: " in the title, or `overdue`),
later ones from the rule while it is live and active. Person → that person's Personal layer only;
department → its layer for members who see it: Scheduling → Scheduling/Production, Projects →
Projects, Ordering → Install & hardware, Accounts → Accounts, Admin → Company-wide. A recurring
person task is not shown again as a plain "Task due".
