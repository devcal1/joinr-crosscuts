# Crosscuts — Milestone 7 plan: Staff planner (2026-10-11)

Status: **draft for Todd (M7 · 1.2).** Todd's description, his 8 answers and the 4 settled points are in `docs/plans/planner-notes.md`. They are binding and are not asked again here. §15 asks only what the notes leave open. Steps: M7 · 1.1 (audit, §1), M7 · 1.2 (this plan and its questions), M7 · 1.3 (decisions).

Source of truth: `planner-notes.md` (all of it); CLAUDE.md non-negotiables 5 (additive migrations), 6 (`defineRoutes` access values), 7 (the board is frozen) and 8 (`cc-` classes), and "Look and feel". The brief has no planner section. This milestone was added by Todd on 2026-10-11.

**M7 scope:**
- a new **Planner** page: a Monday-to-Sunday month grid beside a two-week view (this week and next);
- **layers** you can switch on and off: Company-wide, Install & hardware, Accounts, Design/PM, Scheduling/Production, Workshop and Personal;
- **automatic events**, worked out from the source records, never typed in;
- **hand-made events**: all-day, multi-day and timed, repeating weekly, fortnightly or monthly, optionally linked to a job;
- **reminders in the bell** and **print/PDF** (black on white);
- the new **workshop role**, and the named colour exception for layer markers.

**Not in M7:** a calendar feed for Outlook or phones (Todd's answer 8), and any change to the board or the TV.

## 1. Audit findings (M7 · 1.1)

Read in the code on 2026-10-11.

**What already exists:**
- **Roles and keys** live in code: `lib/permissions.js` has `ROLES` (admin, accounts, design_pm, scheduling, showroom), 21 `KEYS` and `PRESETS`. Admin is `[...KEYS]`, so admin gets any new key automatically. `lib/auth.js` `loadUser` computes `perms` from roles plus overrides on every request. `routes/users.js` validates roles against `permissions.ROLES`.
- **Departments mean roles.** M4's chat channels set the precedent: "a department channel means people with this role" (`m4-plan.md` trap 12).
- **Every source of an automatic event already has a dated column and an index:**

  | Source | Date fields | Where |
  |---|---|---|
  | Board weeks | `week_rows.week_start`, `panel` (manufacturing, installing); per-day `assignments.day` | 001; `lib/schedule.js` `buildWeek` |
  | Promised install | `jobs.promised_install_date` | 003 |
  | Materials ordered | `jobs.materials_ordered_date` | 003; `lib/orders.js` `markMaterialsOrdered` |
  | Materials due in | `orders.expected_date` (status `ordered`) | 010; `orders.upcoming` |
  | Materials received | `jobs.materials_in_date` (every live line in) | 010 |
  | Client inspections | `inspections.date`, `time` (HH:MM or null), status `booked`/`done` | 010; `inspections.upcoming` |
  | Leave | `leave.date_from`, `date_to`, `kind`, `note`, worker | 013; `availability.listLeave` |
  | Invoices | `invoices.due_date` (status `issued`); overdue = issued and past due | 006; `lib/invoices.js:125` |
  | Tasks | `tasks.due_date`, `assignee_id`, status `open` | 012 |

- **A reminder timer to copy:** `lib/tasks.js` `startReminder` (a 60 s check, a kill switch env `REMINDER_DISABLED=1`, first-start seeding in `app_settings`, `unref()`, an admin `POST /api/tasks/reminder/run`). The bell is `lib/notify.js`: `toUser` and `toUsers` (with `exceptUserId` and `dedupeUnread`), synchronous and safe inside a transaction.
- **Sydney time:** `lib/time.js` has `sydneyToday`, `sydneyParts`, `addDays` and `mondayOf`, all pure calendar maths. It has nothing that turns a Sydney wall-clock time into an instant.
- **Audit:** `audit.log(req, {action, entityType, entityId, before, after})`, readable by `audit.view` (admin).
- **The shell** (`public/shell/shell.js` `LINK_GROUPS`) and the home page (`public/index.js`, "Your departments" and "Your work" tiles) both show entries by key. The board (`schedule.html`) has no shell, so nothing added to the shell appears on the TV.
- **Lookahead** (`public/lookahead.*`, `GET /api/scheduling/lookahead`, `scheduling.view`) is a read-only four-week view of board rows. The planner reuses its date formatting and its "read-only, links to the job" manner. It does not replace it. Lookahead stays the scheduler's detailed view of who is on what; the planner shows only which jobs are in which week.
- **The style check** (`ci/style-check.js`) refuses literal colours outside `tokens.css`, shadows, other font weights and icons. It strips `var(--…)` references before checking, so token colours pass anywhere. Print colours are allowed between `style-check: print-start` and `print-end`.
- **Smoke:** `ci/smoke.sh` sources `smoke-mN-*.sh`, with the role jars `$ADMIN $SCHED $ACCT $DPM $SHOW`. Its step b calls every `/api` route logged out, so new routes get their 401 check for free.

**What doesn't exist:** a workshop role, any calendar or event table, repeat logic, a Sydney-time-to-instant helper, and a page that mixes several departments' data.

**Traps found:**
1. **The role list is fixed in the database.** `user_roles.role` has `CHECK (role IN ('admin','accounts','design_pm','scheduling','showroom'))` (002). SQLite can't alter a CHECK, so adding `workshop` means rebuilding that one table with every row copied (question 3).
2. **Admin would see personal events through the audit log.** Admin holds `audit.view`, and `audit.log` stores before and after in full. Personal events must be audited without their content.
3. **Leave carries a reason** (`kind`, `note`). The planner must drop both on the server, not just hide them on the page.
4. **Workshop logins have no `jobs.view`.** A link to `/job.html` would give them a 403 page, so links are only sent to people who can open them.
5. **Board weeks would flood a month grid.** Ten jobs a week drawn on every day would be 50 entries a week. They need their own compact form (§4).
6. **Daylight saving.** A weekly 9:00 meeting must stay at 9:00 when the clocks change, and 2:30 am doesn't exist on the first Sunday in October.
7. **The menu bar is nearly full** (M4 trap 7). One more link needs re-measuring at 1100–1600 px.
8. **Unlisted pages are open to any login** (`lib/pages.js`), so `/planner.html` must be listed.

## 2. How it works, in one paragraph

**Planner** is a new menu item and home tile. On the left is the month, Monday to Sunday. On the right is this week and next, day by day with times. Along the top are layer buttons that switch each layer on and off, and the page remembers your choice. You see only the layers your roles allow, and the server never sends you the others. Each event has a small coloured marker for its layer. Some events are put there by Crosscuts itself: installs, board weeks, materials, inspections, who's away, invoices due and your own task due dates. Those are read-only and link to where they come from. Anyone with an office login can add events to the layers they belong to: all-day, several days, or at a time, once or repeating. Each event can have a reminder in the bell. **Print** gives the month or the two weeks in black and white, with layer names as words.

## 3. Layers and who sees what

Layers follow **roles**, as M4's channels do. A per-user key override never adds a department layer.

| Layer | Marker | Who sees it | Who adds to it | Who can change or delete an event |
|---|---|---|---|---|
| Company-wide | teal | everyone with `planner.view` | anyone with `planner.edit` | its creator, admin |
| Install & hardware | orange | everyone with `planner.view` | question 2 | question 2 |
| Accounts | light grey | accounts, admin | accounts, admin | its creator (while still in accounts), anyone in accounts, admin |
| Design/PM | violet | design_pm, admin | design_pm, admin | the same pattern |
| Scheduling/Production | fuchsia | scheduling, admin | scheduling, admin | the same pattern |
| Workshop | mid grey | question 1 | question 1 | question 1 |
| Personal | hollow (outline) | its owner only, **admin excluded** | anyone with `planner.edit`, for themselves | its owner only |

- **Multi-role users** see, and post to, every department layer they hold. When they create an event, the layer they last used is pre-selected (kept in the browser). Otherwise the first in the order Accounts, Design/PM, Scheduling, and for admin, Company-wide.
- **Workshop role:** `board.view` and `planner.view` only. It sees Company-wide and Install & hardware, read-only, and creates nothing, not even personal events. The TV account and workshop logins get it.
- **The TV stays board-only.** Nothing changes on `schedule.html`. The board has no shell, so no Planner link appears there. Todd switches the TV account to the workshop role at 6.1. That role has no `board.edit`, so if anyone edits the board from the TV, they keep `board.edit` through an override on the Users page.
- **Showroom:** no planner (question 5).

**Two new feature keys** (23 in all): `planner.view` (admin, accounts, design_pm, scheduling, workshop) and `planner.edit` (admin, accounts, design_pm, scheduling). The keys gate the page and the routes. Layers are then decided by roles inside one module, `lib/planner/layers.js`, which every planner route and the reminder sweep go through:
- `visibleLayers(user)`;
- `postableLayers(user)`;
- `canEdit(user, event)`.

## 4. Automatic events: worked out when asked, not stored

**Recommended: computed on read.** Each request for a date range runs one ranged query per source and turns the rows into events in memory. No copies are stored, so there are no sync jobs, no hooks in the source modules and no drift: change an order's expected date and the planner shows it on the next load. The alternative, stored copies kept up to date by hooks in every source module, touches orders, inspections, invoices, leave, tasks and the board's write paths (the board is frozen), and a missed hook leaves a wrong date on the planner for good. The cost of computing on read is small: about seven indexed range queries over tables of hundreds of rows (§11).

| Source | Layer | What shows | Link (only when the viewer can open it) |
|---|---|---|---|
| Board weeks | Install & hardware | per week: "Manufacturing: A, B, C" and "Installing: D, E", as a band across the week row (month) or the week header (two-week view). An installing job also marks the days it has someone assigned. | job page (`jobs.view`), otherwise the board (`board.view`) |
| Promised install | Install & hardware | "Promised install: Job" on that day; jobs that are lost or archived left out | job page |
| Materials ordered | Install & hardware | "Materials ordered: Job" (`jobs.materials_ordered_date`) | job page `#orders` |
| Materials due in | Install & hardware | "Materials due: Job (3 lines)", one per job per expected date, still-ordered lines only | job page `#orders` |
| Materials received | Install & hardware | "Materials in: Job" (`jobs.materials_in_date`) | job page `#orders` |
| Client inspection | Install & hardware | "Inspection: Job" at its time (or all-day if no time); booked and done, not cancelled | job page `#inspection` |
| Leave | Company-wide | "Sam away", weekdays only; **no kind, no note**, both dropped on the server | Availability (`scheduling.view`) |
| Invoice due | Accounts | "CC-0123 due: Job" on the payment due date of an issued, unpaid invoice; past due shown red with "overdue". Today also carries one red line, "N invoices overdue". | the invoice (`accounts.view`); the Accounts overdue list |
| Task due | the assignee's Personal | "Task due: title", open tasks only | the task (`tasks.use`) |

Automatic events are read-only, have no reminders (their sources already alert: `materials.in`, `inspection.*`, invoice prompts, the 7:00 task reminder) and are marked with their source in small uppercase letterspaced text. Regular days off and part-time patterns are not shown, only leave. Job values, client details and addresses never appear on the planner.

## 5. Hand-made events: data (migrations 017 and 018)

The next free number is 017 (016 is Backup). Two files, so the role change and the new tables each run in their own transaction:

**`017_workshop_role.js`** (question 3). It rebuilds `user_roles` with `workshop` added to the CHECK:
1. Create `user_roles_new` with the new CHECK.
2. Copy every row.
3. Check the counts match, or throw (the transaction rolls back).
4. Drop the old table, then rename the new one.

Nothing references `user_roles`, so no foreign keys are involved. The runner's `VACUUM INTO` backup is written first, as for every migration on an existing database.

**`018_planner.sql`** (additive: new tables and indexes only):
- `planner_events`:
  - identity and place: `id`, `layer` (CHECK `company`, `install`, `accounts`, `design_pm`, `scheduling`, `workshop`, `personal`), `owner_id` (the creator; for Personal, the only person who can see it);
  - content: `title` (up to 200), `notes` (up to 4,000), `job_id` (nullable);
  - when: `all_day` (0/1), `start_date` and `end_date` (Sydney `YYYY-MM-DD`, inclusive; a timed event has `end_date = start_date`), `start_time` and `end_time` (Sydney `HH:MM` wall clock, null when all-day);
  - repeats and reminders: `repeat` (`none`, `weekly`, `fortnightly`, `monthly`), `repeat_until` (nullable Sydney date), `split_from_id` (nullable; set on the second half of a split series), `reminder` (nullable; §9), `remind_layer` (0/1, if question 4 says yes);
  - bookkeeping: `created_at`, `updated_at`, `updated_by`, `removed_at`, `removed_by` (soft delete).
  - Indexes: `(layer, start_date)`, `(owner_id, layer)` and `(job_id)`.
- `planner_exceptions`: `event_id`, `occurrence_date` (the original start date of that occurrence), `cancelled` (0/1), and override columns that are null when unchanged: `title`, `notes`, `all_day`, `start_date`, `end_date`, `start_time`, `end_time`. The primary key is `(event_id, occurrence_date)`. An exception can never change the layer or the job, so who can see an occurrence is always the series' rule.
- `planner_reminders_sent`: `event_id`, `occurrence_date`, `user_id`, `fire_at`, `sent_at`, with primary key `(event_id, occurrence_date, user_id, fire_at)`. This is the dedupe record. It is never pruned (tiny).
- Indexes for the automatic sources, where missing: `jobs(promised_install_date)`, `jobs(materials_ordered_date)`, `jobs(materials_in_date)`, `orders(expected_date)` (only `status, expected_date` exists). The others are covered already (§1).

**Times.** Timed events are stored as Sydney wall-clock date plus `HH:MM`, never UTC, so a weekly 9:00 stays 9:00 across daylight saving, and the page shows Sydney time even on a laptop in another zone. A timed event is on one day: `end_time` is after `start_time`, defaulting to an hour later. Only all-day events span several days, up to 92.

## 6. Repeats and one-off changes (settled point 4)

- **Rules:** weekly, fortnightly (every 14 days from the start date), monthly (the same day of the month; for the 29th–31st, the last day of shorter months). There is an optional end date. A multi-day event repeats with the same length. There is no limit on how far ahead a series is shown; occurrences are worked out only inside the range being looked at.
- **Editing an occurrence** asks "This one" or "This and all later". There is no "All" button: editing the first occurrence with "this and all later" is the same as changing the whole series.
  - **This one:** writes or updates that occurrence's exception row (it can move it to another day or time).
  - **This and all later:** in one transaction, sets the original's `repeat_until` to the day before that occurrence, and creates a new event with the edited fields, the same rule and the same end date, and `split_from_id`. Any one-off changes the original had after the split stay with the original, and are no longer shown. The dialog says "later one-off changes will be replaced".
- **Deleting** asks the same. **This one** marks the exception `cancelled`, and the rest of the series stays. **This and all later** sets `repeat_until`. Deleting a non-repeating event, or the whole of a series from its first occurrence, soft-deletes the row.
- **Two people editing:** the dialog sends the series' `updatedAt`, and a mismatch returns 409 ("someone else changed this event; reload"), as tasks do. Every exception write also bumps the series' `updated_at`.

## 7. API (`routes/planner.js`, every route through `defineRoutes`)

| Route | Access | Notes |
|---|---|---|
| `GET /api/planner/layers` | `planner.view` | your visible and postable layers, with labels and the default |
| `GET /api/planner/events?from&to[&layers=a,b]` | `planner.view` | hand-made occurrences plus automatic events in range. At most 62 days, otherwise 400. `layers` can only narrow what you're allowed. |
| `GET /api/planner/events/:id` | `planner.view` | one series with its exceptions. **404, not 403**, when you can't see it, so a personal event's existence never leaks. |
| `POST /api/planner/events` | `planner.edit` | the layer must be one of your postable layers (403 otherwise); a job link needs `jobs.view` |
| `PATCH /api/planner/events/:id` | `planner.edit` | `{scope: "one" or "later", occurrence, updatedAt, …fields}`; `canEdit` checked; 409 when stale |
| `DELETE /api/planner/events/:id?scope&occurrence` | `planner.edit` | as above; soft |
| `POST /api/planner/reminders/run` | `users.admin` | runs the sweep as at a given time without moving the stored mark (for smoke tests, as `/api/tasks/reminder/run`) |

Each event in a response is `{id, source, layer, title, allDay, start, end, startTime, endTime, jobId?, jobName?, link?, readOnly, canEdit, repeat?, overdue?}`. Hand-made ids are `e:<id>:<occurrenceDate>`. Automatic ids are `a:<source>:<key>`. `link` is built on the server for that viewer, and left out when they can't open the target.

**Server enforcement:** the SQL itself filters by `layer IN (visibleLayers(user))`, with `owner_id = user.id` for Personal. The automatic sources are only queried for layers the viewer can see: invoices only when Accounts is visible, tasks only for the viewer's own id. Nothing is fetched and then filtered on the page.

**Audit:** `planner.event.create`, `.update`, `.delete`, `.split`, `.occurrence.update` and `.occurrence.delete`, with changed columns only. For **Personal** events, before and after hold only `{layer: "personal"}` and the names of the changed fields, never the title, notes or times, so admin's audit view can't read them.

## 8. The Planner page (`/planner.html`, `planner.css`, `planner.js`)

- **Desktop (1100 px and up):** the month grid takes about two-thirds of the width, with the two-week view beside it.
  - Month grid: six rows Mon–Sun with today ringed in teal; up to three items per day, then "+N more"; multi-day events as bars across the week row; and the board-weeks band at the top of each week row.
  - Two-week view: this week and next, one block per day with timed events in time order after the all-day ones, and each week's "Manufacturing / Installing" lines in its header.
  - Prev, Today and Next move the month; the two-week view always stays on this week and next.
- **Layer buttons:** outlined uppercase buttons, each with its marker, pressed when on. They are remembered per user in `localStorage` (`cc.planner.layers.<userId>`, every read and write in try/catch; all visible layers on when nothing is stored).
- **Event detail** opens in a dialog: title, layer name, when, repeat, reminder, job link, notes, who created it, and Edit and Delete for those allowed. Automatic events show their source and an **Open** link instead.
- **New event** (`planner.edit` only), from a button or a click on an empty day:
  - title and layer (your postable layers only);
  - All day, or start and end date (all-day) / date with start and end time (timed);
  - Repeats with Until, and Reminder;
  - Job (the tasks job picker, `/api/job-records`) and Notes.
- **Phone (640 px and below):** the two-week view comes first as a single-column agenda. The month becomes a compact grid of day numbers with up to three marker dots and a count; tapping a day lists it below. The layer buttons sit in a collapsible row. There is no horizontal scroll.
- **House style:** ink ground and surface cards, white and body text, teal for actions and today, red only for overdue invoices, Arial bold and regular, no icons and no shadows. Markers are the only use of the layer colours. Classes on the page are prefixed `pl-`. The shell keeps `cc-`.
- **Menu and home:** a **Planner** link in the shell (its own entry before the groups, `planner.view`), re-measured at 1100–1600 px and in the phone menu. A **Planner** tile under "Your work" lists today's and tomorrow's events (up to 6) with "Open planner".
- **The colour exception (settled point 1), written in at 2.1/2.2:**
  - **CLAUDE.md, "Look and feel":** "two named exceptions" becomes three, adding: *"Planner layer markers (approved by Todd 2026-10-11): on the Planner page only (`planner.html`, `planner.css`, `planner.js`), each layer's events carry a small marker (a 3 px left edge on chips and bars, a 6 px dot in compact cells) in its layer colour: teal, violet, fuchsia, orange, two greys, and a hollow outline for Personal, from the `--layer-*` tokens. Event text stays white or body on the surface. Print shows the layer name in words, black on white."*
  - **`tokens.css`:** gains `--layer-company`, `--layer-install`, `--layer-accounts`, `--layer-design`, `--layer-scheduling`, `--layer-workshop` and `--layer-personal`, each defined as an existing token. No new hex values.
  - **`ci/style-check.js`:** its header lists the third exception, and one new rule fails any use of `--layer-` outside `tokens.css` and `planner.*`. That rule is checked on the raw line, because the check strips `var(--…)` before its other rules.
- **Print/PDF:** a **Print** button asks "Month" or "Two weeks", sets a class on the page and calls `window.print()`; Save as PDF comes from the browser, as for invoices. The month prints on A4 landscape, the two weeks on portrait. Black on white between `style-check: print-start/end`. Each event is prefixed with its layer name in brackets (`[Accounts]`), markers are not printed, and only the layers switched on are printed. A footer lists them and the print date.

## 9. Reminders in the bell

- **Per event, optional**, set on the series (an occurrence keeps the series' offset, at its own time):
  - timed events: at the start, 15 minutes before, 1 hour before, or 1 day before;
  - all-day events: 7:00 on the day, or 7:00 the day before (7:00 matches the task reminder).
- **Who gets it:** the creator, and for a shared layer optionally everyone who can see that layer (question 4). Personal reminders go only to the owner. Recipients are checked when the reminder fires, against the layer rules, so someone who has lost the role gets nothing.
- **The sweep:** `lib/planner/reminders.js` `startReminders(db)`, started in `server.js` after `listen`, like the task reminder.
  - Every 60 s it finds the reminders whose fire time falls in the window from the stored mark (`planner.reminder_swept_to` in `app_settings`, at most 6 hours back) to now, then moves the mark to now.
  - It skips an occurrence that has already ended, and a cancelled occurrence.
  - Each send is recorded in `planner_reminders_sent`, so overlap or a restart never sends twice. An occurrence moved later gets a new `fire_at`, so it reminds again.
  - On first start the mark is seeded to now and nothing is sent.
  - Off with `PLANNER_REMINDER_DISABLED=1`.
- **The alert:** kind `planner.reminder`, title "Tomorrow: Site meeting, 9:00" (or "In 1 hour: …"), link `/planner.html?date=YYYY-MM-DD&event=<id>`, entity `planner_event`, `<id>:<date>`.
- **Sydney time to instant:** a new `sydneyInstant(date, "HH:MM")` in `lib/time.js`. A time that doesn't exist (the spring-forward hour) moves an hour later. A time that happens twice (the fall-back hour) uses the first.

## 10. Permissions and the job page

- `lib/permissions.js`: `workshop` in `ROLES`; `planner.view` and `planner.edit` in `KEYS`; the presets in §3. The workshop preset is `board.view` and `planner.view`.
- Elsewhere:
  - `public/users.js`: a "Workshop" role label;
  - `lib/pages.js`: `/planner.html` → `planner.view`;
  - `docs/auth.md`: a Workshop column and the two keys;
  - `docs/how-to-add-user.md`: a line on the workshop role and the TV.
- **The job page (question 6):** a small **Planner** section listing the job's upcoming hand-made events. It uses the same `visibleLayers` filter, so nobody sees another person's personal events or another department's events there.

## 11. Performance and limits

- **Range cap:** 62 days per request. The page asks for the month grid (up to 42 days) and the two weeks separately.
- **Hand-made events:** one query. It returns non-repeating events that overlap the range, and repeating events starting on or before its end and not ended before its start. Their exceptions come in one more query. Occurrences are worked out arithmetically from the first one at or after `from`, never by looping from a series' start, so a weekly series from 2027 viewed in 2035 costs the same.
- **Automatic events:** about seven indexed range queries, then grouping in memory (materials lines per job and date; board rows per week and panel).
- **Expected size:** a few hundred jobs and a few thousand rows a year. A month should come back in milliseconds on the Umbrel. The 2.2 scaffold adds a timing check on a seeded year of data (target under 100 ms).
- **The sweep:** it reads only events that have a reminder, expanded over the window plus one day.

## 12. Risks and traps

1. **Leaks of private layers.** The paths are the events list, single-event reads (404), the bell (recipients checked at send), the audit log (personal content redacted), the job page section (same filter), the `layers` parameter (narrow only) and occurrence exceptions (they can't change the layer). Smoke tests each one (§13).
2. **Daylight saving and time zones:** wall-clock storage, calendar maths for repeats, `sydneyInstant` for the bell only. Smoke uses the October and April change-over Sundays.
3. **The board stays frozen.** No edits to `schedule.*` or `workers.html`. Board weeks are read with read-only queries. `alignPanels()` and `exportJpg()` are untouched.
4. **The TV is unchanged** apart from its account's role, which Todd changes at 6.1. That role has no `board.edit` (an override if needed).
5. **The style check:** the new `--layer-` rule must pass on the whole tree, and the page must pass the existing rules.
6. **The `user_roles` rebuild** runs once, inside a transaction, after the automatic backup. If the counts don't match it throws and boot stops with the database unchanged.
7. **Clutter:** board weeks as a band, "+N more", and layer toggles. If Install & hardware is still too busy in real use, the layer can be switched off.
8. **Who's away covers workshop workers only** (leave is per board worker). Office staff away goes on Company-wide by hand until a later milestone.

## 13. Steps (per `roadmap.md`)

| Step | What happens | Needs Todd |
|---|---|---|
| **M7 · 1.1** Audit | the code survey above (§1) | — |
| **M7 · 1.2** Plan | this file; questions in §15 | **Todd** reads and answers ✂ |
| **M7 · 1.3** Decisions | answers recorded; plan approved; CLAUDE.md gains the layer-marker exception | **Todd** ✂ |
| **M7 · 2.1** Contracts | `m7-contracts.md`: layer rules, the event shapes, migrations 017/018, recurrence rules, the API, the reminder sweep, the page, the smoke list, file ownership; the waves (proposed below) | ✂ |
| **M7 · 2.2** Scaffold | migrations 017 and 018 (applied in `.dev`); keys and the role; `lib/planner/layers.js` complete (the security core, written by the lead); `sydneyInstant`; tokens and the style-check rule; `/planner.html` listed; stub routes (501); the smoke hook; version bump | ✂ |
| **M7 · 3.1** Wave 1 | **A** hand-made events: CRUD, repeats, exceptions, split, audit redaction, the reminder sweep, `smoke-m7-events.sh`; **B** automatic events: `lib/planner/auto.js`, all nine sources with per-viewer links, `smoke-m7-auto.sh`; **C** the page: grid, two-week view, toggles, dialogs, phone, print, against the contract shapes | ✂ |
| **M7 · 3.2** Wave 2 | **D** the menu link, home tile, job page section (if approved), Users page label, docs (`auth.md`, how-to-add-user); **E** `smoke-m7-access.sh`: the leak tests across all roles, plus local headless-Edge screenshots at 1440, 1100 and 375, and print previews | ✂ |
| **M7 · 4.1–4.3** | integrate; independent review (leaks, daylight saving, repeat edge cases, the style check); fix | ✂ each |
| **M7 · 5.1** Publish | version bump, push (Todd OK), CI green | **Todd** ✂ |
| **M7 · 5.2** Pin | store pin, `version:` and `releaseNotes`; the held shield icon goes with it | **Todd** ✂ |
| **M7 · 6.1** On device | Todd updates; switches the TV account (and any workshop logins) to the workshop role; the checks below | **Todd** |
| **M7 · 6.2** Close | STATUS closed; worktrees cleaned up | ✂ |

**Smoke (CI)**, with new jars `$WORK` (workshop) and `$ACCT2` (a second accounts user):
- **Access:**
  - showroom 403 everywhere;
  - workshop sees only Company-wide and Install & hardware, and gets 403 on every write;
  - a design_pm user can't read Accounts events, and gets 404 on an Accounts event id;
  - `$ACCT2` can edit `$ACCT`'s Accounts event, but not their Personal one;
  - admin gets 404 on someone else's personal event, and the audit entry for it carries no title.
- **Events:** create, edit and delete for each kind; "this one" and "this and all later" on weekly, fortnightly and monthly series (including the 31st); 409 on a stale edit; a range over 62 days gives 400.
- **Automatic events:** each source appears on the right layer and disappears when its source changes; leave without its reason; links left out for workshop.
- **Reminders:** each offset, sent once, and an October daylight-saving case.

**Release:** `package.json` is already 0.1.9 locally (the held shield favicon, `8e96032`, not pushed; Todd: hold until the next app change). **Recommended: M7 ships as 0.1.9, with the favicon, and the store push carries the 0.1.9 pin and the new icon together.** If 0.1.9 goes out before M7 (for another change), M7 becomes 0.1.10. Either way the version is bumped (with `package-lock.json`) at 2.2, and the release timing is Todd's call at 5.1.

**The 6.1 checks**, over the LAN and Tailscale:
- An accounts user and a design user each see their own layer and not the other's.
- A personal event is invisible to admin.
- A repeating event, edited "this one", then "this and all later".
- A reminder arrives in the bell.
- The workshop login sees two layers and can't add.
- The TV still shows only the board.
- A month and a two-week print to PDF.

## 14. Not in M7

- A calendar feed for Outlook or phones (answer 8, later).
- Reminders on automatic events.
- Office staff leave as an automatic source.
- Won quotes from Joinr on the planner.
- Drag to move events.
- Inviting or notifying others when an event is created.
- Repeats other than weekly, fortnightly and monthly.
- Timed events that cross midnight.
- Any change to the board, the TV or the Lookahead page.

## 15. Questions for Todd (M7 · 1.2), with recommended answers

Only what the notes leave open.

1. **The Workshop layer.** Answer 1 creates it, but answer 3 says workshop logins see only Company-wide and Install & hardware and create nothing. So who is it for? (a) *Recommended:* scheduling (who runs the workshop) and admin post to it and edit it. Workshop logins see it read-only, as a third layer, for floor notices that aren't company-wide (machine service, a clean-up day). (b) Strictly per answer 3: scheduling and admin only; workshop logins don't see it.
2. **Hand-made events on Install & hardware** (for example a hardware delivery or a crane booking). (a) *Recommended:* design_pm, scheduling and admin can add them; the creator, anyone in design_pm or scheduling, and admin can change them. (b) Like Company-wide: anyone with `planner.edit` adds; the creator and admin change.
3. **The workshop role needs one table rebuilt.** The allowed role names are fixed inside the `user_roles` table, so migration 017 copies every row into a new table that allows `workshop`, checks the count and swaps them, with the automatic backup taken first. No data changes. (a) *Recommended:* approve this one non-additive migration (rule 5). (b) Don't, and give workshop logins a role-less account with key overrides instead (messier, and the TV wouldn't show as "Workshop").
4. **Who gets a reminder?** (a) *Recommended:* the creator. On shared layers, a tick "Remind everyone on this layer" also alerts everyone who can see it, which is never offered on Personal. (b) The creator only.
5. **The showroom account.** (a) *Recommended:* no planner (it stays photos only; one can be granted `planner.view` per user if ever wanted). (b) Showroom sees Company-wide and Install & hardware like the workshop.
6. **The job page.** (a) *Recommended:* a small Planner section on each job listing its upcoming linked events, filtered by the same layer rules. (b) No; links go only from the planner to the job.

## Decisions (M7 · 1.3)

Todd, 2026-10-11, answered one by one; all as recommended. **The plan is approved.**
1. **Workshop layer: floor notices.** Scheduling and admin post and edit; workshop logins see it read-only as a third layer.
2. **Install & hardware, hand-made events:** design_pm, scheduling and admin add; the creator, anyone in design_pm or scheduling, and admin change or delete.
3. **Migration 017 approved** (the one non-additive migration, rule 5): rebuild `user_roles` to allow `workshop`, row count checked, the automatic backup first, no data changed.
4. **Reminders:** the creator, plus an optional "Remind everyone on this layer" on shared layers (never Personal).
5. **Showroom:** no planner.
6. **Job page:** a small Planner section listing the job's upcoming linked events, under the same layer rules.
