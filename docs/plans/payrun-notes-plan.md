# Pay run day notes plan (0.2.17, migration 061)

Backlog item raised by Todd on 2026-11-12. Planning only: nothing is built yet, and building waits for Todd's approval of the mockups. The version and migration numbers are tentative: two other plans (weekend follow-ups, overdue invoice reminders) are being written at the same time, so the numbers are settled at build time.

## Todd's words (2026-11-12, in substance)

Admins can add notes per employee per day on the Pay runs page, for example "Steve took a 30min phone call today".

## Todd's decisions (2026-11-13)

1. **Admins write, Accounts reads.** Writing needs `users.admin`; everyone who can open a pay run (`accounts.view`) reads.
2. **Words only.** A note never changes hours or pay maths; Accounts adjusts hours by hand if needed.
3. **Layout A:** the note on its own line straight under its day in the timesheet grid.
4. **Shown on the Summary tab and the printed summary too**, under the sheet's own notes.
5. **Locked once finalised.** No adds or edits on a finalised run; an admin reopens it first.
6. **Written on the day, from a phone.** An **Add day note** button with person and day pickers, which works before the pay run or the sheet exists.
7. **One note per person per day**, edited in place, showing who last changed it.
8. **Notes wait for their run and sheet** (follow-up answer): a note for a fortnight not started yet, or a person with no sheet yet, is kept and shown once they exist, with the "Day notes without a sheet" list on the pay run page. The run and the sheet are **never** created automatically.
9. **The button is on the Dashboard too** (follow-up answer), for admins, as well as on the Pay runs page and an open pay run's page.

## What exists (do not rebuild)

- **Pay runs** (M8, `docs/plans/m8-contracts.md`, migration 019): `pay_people` (one row per person who can have a timesheet; board workers get one lazily through `ensureWorkerRow`), `pay_runs` (a fortnight on the grid from the anchor date, open or finalised, with a frozen `summary_json` at finalise), `pay_timesheets` (one sheet per person per run, with one free-text `notes` box and the Signed and Typed in ticks), `pay_days`. `payroll.currentStart(db, date)` gives the grid Monday for any date.
- **Pay names** (0.2.11, migration 056): "SURNAME, Firstname".
- **Admin review tick** (0.2.11, migration 055): `users.admin` ticks each sheet; a bell goes to every admin at 2 pm on the fortnight's last Friday (`lib/payrunping.js`). Changing hours clears the tick; notes and ticks don't. Locked once finalised.
- **Access** (`routes/payruns.js`): `accounts.view` reads, `invoices.edit` writes sheets, `users.admin` reopens and ticks the review. Admin and Accounts hold `accounts.view`; no other role sees pay runs. Workshop staff (the employees) have no pay-run access at all.
- **Pages:** the Pay runs page (`payruns.html`/`.js`/`.css`: this fortnight and next as cards, the list of runs, people, holidays, rules; one shared `<dialog id="dlg">` built in JS) and one pay run (`payrun.html`/`.js`/`.css`: Timesheets tab with the sheet list and paper-shaped grid, one Save per sheet with an `updatedAt` check; Summary tab).
- **Prints** (`payprint.js`): blank paper timesheets (the form staff fill in by hand, never filled from data), the blank overtime log, and the pay-run summary with a Notes column.

## How it works

- **One note per person per day**, plain text up to 500 characters, keyed to the **person and the date**, not to a run or a sheet. So a note can be written before the fortnight's pay run is started or the person's sheet added, and it shows as soon as they exist. Removing an empty sheet or deleting an empty run never deletes a note: re-adding the sheet brings its notes back. No existing delete path changes.
- **Which pay run a note belongs to** is worked out from its date: the fortnight on the grid that holds that date (`currentStart(db, date)`). A run row isn't needed. If that fortnight's run exists and is finalised, the note can't be added, changed or removed until an admin reopens it.
- **Which days** take a note: the days of that fortnight as `PayMaths.fortnightDates()` lists them (today the ten weekdays; if the weekend follow-ups plan gives pay runs weekend days, notes follow with no change here). Not before the first fortnight (the anchor), and not after the end of next fortnight (the two fortnights the Pay runs page shows), so typos in the year can't park notes years away.
- **Saved on their own**, never through the sheet's Save: a note doesn't touch the sheet's `updatedAt` (Accounts typing the same sheet isn't told "someone else saved this sheet"), doesn't mark the sheet typed in, and doesn't clear the review tick.
- **Employees never see them.** No employee page shows pay runs, and the blank paper timesheets stay blank.

## Data model: migration `061_payrun_day_notes.sql` (additive only)

```sql
-- 0.2.17 (Todd 2026-11-12/13, docs/plans/payrun-notes-plan.md): an admin's note on one person's day,
-- for Accounts to read on the pay run. Keyed to the person and the date (not a run or a sheet), so a
-- note can be written on the day before the run or sheet exists, and removing an empty sheet or
-- deleting an empty run never loses one. Additive only.
CREATE TABLE pay_day_notes (
  person_id INTEGER NOT NULL REFERENCES pay_people(id),
  date TEXT NOT NULL,                                   -- YYYY-MM-DD, one of its fortnight's days
  note TEXT NOT NULL CHECK (note <> ''),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (person_id, date)
);
```

No existing table changes, no backfill. The runner's `VACUUM INTO` backup runs before it on the live database as usual.

## API (`routes/payruns.js`, through `defineRoutes`)

Two new routes, both literal paths registered **before** `/:id` (as `/people`, `/holidays` and `/settings` are). The grid's Add and Edit use the same PUT as the phone dialog, so there is one write path.

| Route | Access | What it does |
|---|---|---|
| `GET /api/payruns/day-notes?personId=N` (or `workerId=N`) `&date=YYYY-MM-DD` | `users.admin` | What the dialog needs for one person and day (below). Never creates a `pay_people` row. |
| `PUT /api/payruns/day-notes` | `users.admin` | Sets, changes or clears one person's note for one day. |
| `GET /api/payruns/:id/timesheets/:tsId` (exists) | `accounts.view` | Adds `dayNotes`: `{ "2026-11-05": { note, by: {id, name}, updatedAt } }`, `{}` when none. |
| `GET /api/payruns/:id` (exists) | `accounts.view` | Each `timesheets[]` entry adds `dayNoteCount`; the run adds `waitingDayNotes: [{ person: {id, workerId, name}, count }]`, notes in this fortnight for people with no sheet in it. |
| `GET /api/payruns/:id/summary` (exists) | `accounts.view` | Each `rows[]` entry adds `dayNotes: [{date, note}]`, oldest day first. Frozen into `summary_json` at finalise like everything else. Summaries frozen before 0.2.17 have none; page and print treat a missing list as empty. |

**The GET** answers `200 { date, person: {id, workerId, name}, fortnight: { startDate, endDate, label, payRunId, status, hasSheet }, dayNote: { note, by, updatedAt } | null }`, where `status` is `"none"` (no run yet), `"open"` or `"finalised"`. 400 for a date that isn't one of a fortnight's days or is out of range (same sentences as the PUT). 404 for an unknown or removed person.

**The PUT**, in `lib/payroll.js` (`setDayNote(db, req, body)`), in one transaction:

- Body `{ personId | workerId, date, note: string, updatedAt: string | null }`, exactly one of `personId` and `workerId` (as `addTimesheet` takes them). `updatedAt` is the note's stamp as last read, or `null` for a day with no note. A board worker without a `pay_people` row gets one (`ensureWorkerRow`) only when a note is actually written.
- 400 "Give a personId or a workerId". 404 for an unknown, archived or removed person. 400 "Pick a day in a pay run fortnight" when the date isn't one of its fortnight's days; 400 "That day is before the first pay run"; 400 "That day is too far ahead: notes go up to the end of next fortnight". 400 "Day notes must be text" and "Day notes must be 500 characters or fewer".
- 409 "That fortnight's pay run is finalised; reopen it to change its notes".
- 409 "Someone else changed this note; reload it", with `{ dayNote: <current or null> }`, when `updatedAt` doesn't match the stored note (or a note now exists where `null` was sent).
- The note is trimmed. Empty means remove the row. Unchanged means no write and no audit row.
- Answers `200 { date, person, fortnight, dayNote | null }` (the same shape as the GET).
- Never touches `pay_timesheets` or `pay_runs`.
- Audit row: `action: "payrun.daynote"`, `entityType: "pay_person"`, `entityId: personId`, `before: { date, note | null }`, `after: { date, note | null }`.

The server keeps refusing to boot if any `/api` route lacks an access value (non-negotiable 6); both new routes have one.

## UI

### Add day note (the phone flow; `docs/plans/mockups/payrun-notes-phone.html`)

- **Where:** an **Add day note** button for `users.admin` holders in three places, all opening the same dialog from the shared `public/daynote.js`:
  - the **Dashboard** (`index.html`, `index.js`, `index.css`; `docs/plans/mockups/payrun-notes-dashboard.html`): in the greeting header, a new `.dash-acts` group at the right of "Good afternoon, Todd" on desktop, and a full-width, 40 px tall button under the date at 520 px and below. `index.js` adds it only when `cc.can("users.admin")`; for everyone else the Dashboard is unchanged. `index.html` loads `/paymaths.js` and `daynote.js`. This is one tap from the phone's home screen.
  - beside the heading on the **Pay runs** page (`payruns.html`, the page Menu, Accounts, Pay runs opens).
  - in the header actions of an **open** pay run (`payrun.html`).
  Not shown to Accounts, and not on a finalised run's page. The dialog element is created by `daynote.js` itself (one `<dialog class="cc-dialog dn-dialog">` appended to `<body>` on first use), so no page needs its own markup for it, and its few `dn-` rules live in a small `daynote.css` that the three pages link. Its person list comes from `GET /api/payruns/people` and its checks from the GET below, both readable by every admin, so the Dashboard needs no new route.
- **The dialog** (the existing `cc-dialog` frame, built by `daynote.js`):
  - **Person:** a select of everyone on the pay run and not removed, by pay name (from `GET /api/payruns/people`, which Admin can already read). On the pay run page it starts as the sheet on screen.
  - **Day:** a date input, starting at today (Sydney). On the pay run page, today if it is in that run, else the run's first day.
  - Under the day, one line saying where the note lands, from the GET as soon as person and day are set: "Goes on the 2–13 Nov 2026 pay run (open)." / "The 16–27 Nov 2026 pay run isn't started yet. The note is kept and shows on Dan's sheet when it is." / "... has no sheet for Dan yet. The note is kept and shows when his sheet is added." / orange "The 19–30 Oct 2026 pay run is finalised. Reopen it to change its notes." (Save disabled). A day outside the range, or not a pay-run day, shows the PUT's sentence and disables Save.
  - **Note:** a textarea (500 max) with a character count.
  - If that person and day already have a note, the dialog becomes **Edit day note**: the note fills the box, "Todd · 5 Nov, 11:20 am" shows under it, and **Remove note** (red) appears.
  - **Save note** (teal), **Cancel**. A 409 for a stale note puts the current note in the box with the sentence "Someone else changed this note; here is theirs. Yours wasn't saved." and keeps the typed text selectable above it, so nothing is lost.
  - After saving: the dialog closes with a toast ("Note saved for BROWN, Steve, Thu 5 Nov."; `daynote.js` shows it with the shell's toast where the page has one, else its own `role="status"` line). On the Dashboard and the Pay runs page nothing else changes. On the pay run page the run and the open sheet refresh, so the note line, the counts and the waiting list update.
- At 375 px the dialog is the full width less 12 px a side, the inputs are 40 px tall (thumb-sized), and nothing scrolls sideways.

### Timesheets tab (layout A; `docs/plans/mockups/payrun-notes-A.html`)

- For an admin on an open run, a quiet **Add note** button in each day's check column (after any hint, e.g. "Melbourne Cup").
- A day with a note gets a full-width line straight under its row (`tr.pr-dn-row`, one cell spanning the grid), indented to the Start column: a "DAY NOTE · THU 5 NOV" label, the note in white, "Todd · 5 Nov, 11:20 am" in muted grey, and a quiet **Edit** button for admins.
- Add and Edit open the line as a small editor in place: textarea (500 max), **Save note**, **Cancel**, **Remove note** (existing notes only), character count. Ctrl+S inside the editor saves the note, not the sheet; Esc cancels; one editor open at a time. It calls the same PUT with the sheet's person.
- Stale 409: as in the dialog. Finalised meanwhile: the 409 sentence, then the page reloads the run read-only, like `doSave` does today.
- Switching sheets or leaving the page with unsaved editor text asks first, as unsaved hours do now.
- The sheet list shows "2 DAY NOTES" under a sheet's state line (`pr-item-notes`).
- Under the sheet list, **Day notes without a sheet** (orange label, from `waitingDayNotes`): "PRICE, Dan: 1 note. Add his sheet to see it." Shown to Admin and Accounts, so a note written on the day before the sheet existed can't be missed.
- **Finalise** adds a warning (warn, don't block, like the review warning) when `waitingDayNotes` isn't empty: "These people have day notes but no sheet: PRICE, Dan. Finalise anyway?"
- Accounts sees the notes and the waiting list with no Add, Edit or Add day note buttons (`docs/plans/mockups/payrun-notes-accounts.html`). A finalised run shows notes read-only for everyone.
- The grid already scrolls sideways inside its box on a phone; the note line scrolls with it.

### Summary tab (`docs/plans/mockups/payrun-notes-summary.html`)

The Notes column keeps the sheet's notes and lists the day notes under them, one per line, each led by its day in label grey. The name column gets a fixed 170 px so "SURNAME, Firstname" doesn't break mid-word, and the notes column 280 to 420 px (table minimum 1,160 px, scrolling inside its box as now).

### Printed summary (`payprint.js`; `docs/plans/mockups/payrun-notes-print.html`)

The Notes cell gets each day note on its own line after the sheet's notes, as "Thu 5 Nov: ..." (the cell already uses `white-space: pre-line`). Black on white as now; nothing new in the print block. The blank timesheets and the overtime log don't change.

### Not changed

The board, the shell, every other page. On the Dashboard only the admin's button is added; its lines, notifications and tiles are untouched.

## Permissions summary

| Who | Sees day notes | Adds, edits, removes (open fortnights only) |
|---|---|---|
| Owner, admins (`users.admin`) | Yes | Yes: Add day note on the Dashboard, the Pay runs page and an open pay run's page, and in the grid |
| Accounts (`accounts.view`, `invoices.edit`) | Yes (sheet, waiting list, summary, print) | No |
| Everyone else, including workshop staff | No (no pay-run access) | No |

## Style check (`ci/style-check.js`)

Nothing new to allow. Only `tokens.css` colours (`--raised`, `--hairline`, `--label`, `--muted`, `--white`, `--teal` for the editor edge and Save, `--stop` through `hs-btn-stop` for Remove, `--orange-tint` for the waiting label, the finalised sentence and the stale sentence: "attend to this"). Text buttons only, no icons, emoji or shadows, uppercase letterspaced labels. Page classes keep their prefixes (`pr-dn-*`, `pr-waiting` on the pay run page; `dash-acts` on the Dashboard; `dn-*` in the shared `daynote.css`); the shared dialog frame stays `cc-dialog` and nothing is added to the shell. The print block in `payprint.css` is untouched. The check must pass unchanged.

## Smoke test: `ci/smoke-payrun-notes.sh`

A new suite, sourced from `ci/smoke.sh` after `smoke-weekend.sh` and before `smoke-backup.sh` (one `[ -f ... ] && source ...` line). It shares the caller's helpers and jars (`$ADMIN`, `$ACCT`, `$SHOW`), has no shebang and no `set`, and doesn't assume a pristine database. Because notes may only go up to the end of next fortnight, it works in the **current and next fortnight** worked out from `GET /api/payruns` (`current.startDate`, `next.startDate`), with a worker it creates itself ("CI Day Note Worker"), so it never touches other suites' data. It checks:

1. Access: `ACCT` and `SHOW` get 403 on both the GET and the PUT; logged out gets 401.
2. Validation: neither or both of `personId`/`workerId` 400; unknown person 404; a Saturday 400; a date before the anchor 400; a date after next fortnight 400; `2035-13-01` 400; a number for `note` 400; 501 characters 400.
3. Before anything exists: `GET` for the new worker (by `workerId`) on a next-fortnight day answers `fortnight.status == "none"`, `hasSheet == false`, `dayNote == null`, and no `pay_people` row was made (the worker's `personId` is still null in `GET /api/payruns/people`).
4. `PUT` by `workerId` there with `updatedAt: null`: 200, note and `by.name` echoed; the worker now has a `personId`.
5. Start next fortnight's run (if the suite's database hasn't got one): `GET /:id` lists the worker in `waitingDayNotes` with `count == 1`. Add the worker's sheet: `waitingDayNotes` drops them, the sheet's `dayNoteCount == 1`, and `GET` the sheet shows the note in `dayNotes`.
6. The sheet's `updatedAt` and `saved` are unchanged by a note save; with the review tick on, changing the note leaves it on.
7. Stale `updatedAt`: 409 with the current note; `null` on a day that now has a note: 409.
8. Same text again: 200 and no new audit row (count `payrun.daynote` rows before and after via `/api/audit`).
9. The summary row's `dayNotes` lists the note with its date. Remove the sheet (it's empty), add it back: the note is still there.
10. Whitespace-only note: removed (`dayNote == null`, `dayNoteCount == 0`).
11. Finalise a run the suite started itself (only if it started one: it never finalises a run it didn't create): the frozen summary has `dayNotes`; PUT is 409 "That fortnight's pay run is finalised..."; GET shows `status == "finalised"`; reopen (admin), PUT works again; then the suite deletes the run's empty sheet and the run so the next fortnight is left as it found it.
12. Audit rows exist with `action == "payrun.daynote"` and the before and after.

## Version

`crosscuts/app/package.json` 0.2.16 to **0.2.17**, and the two root version fields in `crosscuts/app/package-lock.json` with it (non-negotiable 1). If the other two plans build first, this takes the next free version and migration number; only the migration file name and the version change.

## Build tasks (Sonnet 5.5 implementation subagents)

Order: **T1 first**, then **T2, T3, T4 and T5 in parallel** (they touch different files), then my review. Each subagent gets this plan, `CLAUDE.md` and the files named below, commits locally (on `main` or its own worktree branch that I merge) and never pushes.

**T1. Backend, migration and version** (first)
- Files: `crosscuts/app/db/migrations/061_payrun_day_notes.sql` (new); `crosscuts/app/lib/payroll.js` (`dayNoteFortnight(db, date)` for the range and day checks, `getDayNote`, `setDayNote`, `dayNotes` in `getTimesheet`, `dayNoteCount` and `waitingDayNotes` in `getRun` (grouped queries, not one per sheet), `dayNotes` in `liveSummary` rows); `crosscuts/app/routes/payruns.js` (the GET and PUT, `users.admin`, before `/:id`); `crosscuts/app/package.json` and `package-lock.json` (0.2.17).
- Accept: the dev-shim server boots on a fresh `.dev` database and on a copy with 0.2.16 pay-run data (migration applies, backup written); `curl` reproduces smoke items 1 to 12 by hand; `removeTimesheet`, `deleteRun` and `saveTimesheet` are unchanged; the GET never inserts into `pay_people`.

**T2. Smoke suite** (after T1)
- Files: `ci/smoke-payrun-notes.sh` (new); `ci/smoke.sh` (one source line).
- Accept: every item above; passes in the local smoke harness against T1's code; passes twice in a row on the same database and on a database where next fortnight's run already exists (it then skips item 11's finalise and says so).

**T3. Pay run page** (after T1)
- Files: `crosscuts/app/public/payrun.js`, `payrun.css`, `payrun.html` (the header button and the `daynote.js` and `daynote.css` links).
- Accept: matches `payrun-notes-A.html`, `payrun-notes-accounts.html`, `payrun-notes-summary.html` and the desktop part of `payrun-notes-phone.html`; grid Add, Edit and Remove; Save note never marks the sheet dirty; Ctrl+S and Esc in the editor; unsaved editor text guarded; both 409 paths; the waiting list and the Finalise warning; Accounts sees notes and the waiting list with no buttons; finalised read-only; no sideways page scroll at 1920, 1400, 900 and 375 px; `node ci/style-check.js` passes.

**T4. The shared dialog, the Pay runs page and the Dashboard** (after T1)
- Files: `crosscuts/app/public/daynote.js` and `daynote.css` (new: the dialog, `dn-` classes); `payruns.js`, `payruns.html` (the heading button, the two links); `index.js`, `index.html`, `index.css` (the `.dash-acts` button, admin only, the links). T3 only calls `daynote.js`; T4 owns it and lands first in the merge order.
- Accept: matches the phone screens 1 to 5 in `payrun-notes-phone.html` and `payrun-notes-dashboard.html` at 375 px and on desktop; the where-it-lands line for none / open / no sheet / finalised / out of range; Edit day note with Remove; the toast; the button shows for an admin and is absent for Accounts, design/PM, scheduling and workshop logins on both pages; the Dashboard is otherwise unchanged; no sideways scroll at 375 px; style check passes.

**T5. Printed summary and docs** (after T1)
- Files: `crosscuts/app/public/payprint.js` (summary Notes cell only); `docs/plans/m8-contracts.md` (a short 0.2.17 addendum pointing here: the table, the routes, the response fields); `docs/plans/STATUS.md` (one entry: built locally, not pushed).
- Accept: the printed summary matches the print mockup for open and finalised runs; a summary frozen before 0.2.17 still prints; blank timesheets and the overtime log unchanged; black on white.

T3 and T4 both touch the dialog: T4 writes `daynote.js` (one function, `DayNote.open({ personId, workerId, date, onSaved })`), and T3 only calls it. I give both the same function signature up front.

## How I will review

1. Read each diff against this plan and check non-negotiables 1, 5, 6 and 8 by hand (version bumped in both files, migration new and additive, both routes have an access value, page-prefixed classes only).
2. `node ci/style-check.js`.
3. A local run with the dev shim (`cd crosscuts/app && DB_DIR=../../.dev/db UPLOADS_DIR=../../.dev/uploads CONFIG_DIR=../../.dev/config node -r ../../tools/dev-sqlite-shim.js server.js`), on a fresh database, then on a copy holding 0.2.16 pay runs. In the browser pane, as an admin and as an Accounts login: the phone flow at 375 px from the Dashboard, the Pay runs page and the pay run page (note before the run exists, before the sheet exists, on an open run, on a finalised run, edit and remove); the grid Add/Edit/Remove; stale (two tabs); the waiting list and Finalise warning; finalise and reopen; Summary tab; Print summary; widths 1920, 1400, 900, 375.
4. The local smoke harness (memory note "local-smoke-harness"): copy `ci/smoke-*.sh` into `.dev/m23-full/full/ci/`, then from `.dev/m23-full` run `node adapt.js && bash fullrun.sh` in the background and wait for "FULL RUN ... PASSED". **One run at a time**, and not while another wave's agent is running one (the fake Joinr ports clash); I check first.
5. Report back to Todd with screenshots; no push until he says.

## Mockups

All in `docs/plans/mockups/`, standalone, built from the real `tokens.css`, `components.css`, shell bar and dialog frame, and `payrun.css` / `payruns.css` / `payprint.css`, with the proposed rules added:

- `payrun-notes-phone.html`: Add day note on a phone (375 px): the Pay runs page, the dialog for a new note, an existing note, a fortnight with no run yet, a finalised fortnight; then the same dialog on the desktop pay run page.
- `payrun-notes-dashboard.html`: the Dashboard with the admin's Add day note at 375 px (and the dialog open), then desktop for an admin and, unchanged, for Accounts.
- `payrun-notes-A.html`: layout A, admin on an open run (one note being added, two saved, the header button, the waiting list).
- `payrun-notes-accounts.html`: what Accounts sees (open run), then a finalised run.
- `payrun-notes-summary.html`: the Summary tab.
- `payrun-notes-print.html`: the printed summary.

## Open questions for Todd

None. All nine decisions are above; building waits for Todd's approval of the mockups.
