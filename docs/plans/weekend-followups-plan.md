# Weekend follow-ups: plan

Status: **built locally as 0.2.18 (2026-11-13), not pushed.** Todd's decisions are locked in (2026-11-13, see the end). Planner: T1-Violet. Tentative release 0.2.18 (T1-Teal holds 0.2.17 for pay run notes; final numbers may shift). **No migration is needed**, so 062 is not claimed.

These are the three follow-ups Todd deferred when the board's Weekend column shipped (0.2.16, commit f3c093f, migration 060, committed locally and not pushed):

- **a. End of shift for weekend workers.** Decision: their Weekend jobs are listed on Saturday and Sunday, and **there is never a weekend reminder.**
- **b. Weekend leave greys out Weekend chips.** Decision: leave on **Saturday or Sunday** greys the Weekend chip.
- **c. What a Weekend booking counts as.** Decisions: the Planner shows it on **both the Saturday and Sunday tiles, counting as one day**. On the pay run it appears as **a grey note in Friday's Check column, with nothing stored.**

## Background: how the Weekend column works today (0.2.16)

- The board has a sixth day cell after Friday, key `wknd`. One cell covers Saturday and Sunday. `assignments.day` and `day_flags.day` accept `wknd` (migration 060).
- A Weekend booking counts as **one worked day** for days-a-week (the over-days outline) and **one person-day** for project hours, and is **dated Saturday** wherever a date is needed. **All of that stays.**
- Leave, sick days and regular days off are **Monday to Friday only**. `lib/schedule.js` says "the Weekend cell is never away". The leave dialog says "Saturday and Sunday in the range are ignored by the board."

## What I found

1. **End of shift is blind at the weekend.** `lib/shift.js` and `lib/mywork.js` both map the weekday through `[null, "mon", …, "fri", null, null]`, so on Saturday and Sunday the board day is `null`. The page still opens and a report can still be sent, but it lists no jobs ("You're not on the board today"), and photos are tagged `shift`, never `install`. Because the day is null, there's no My work line and no 16:00 reminder at the weekend. That is exactly what Todd wants to keep.
2. **Leave already covers weekends in the data.** A leave record is a date range, and nothing stops it including Saturday or Sunday. Only `awayForWeek()` in `lib/availability.js` stops at Friday. The board, the "+" picker, `exportJpg()` and print all read `chip.away` and `week.away[worker][day]`, so **once the server answers for `wknd`, every board surface follows with no change to board code.**
3. **The pay-run "Saturday" suggestion goes nowhere.** Timesheets hold the run's **ten weekdays only** (`PayMaths.fortnightDates`, and `pay_days.date` is "one of the run's ten weekdays"). Saturday isn't one of them, so 0.2.16's `wknd: 5` line in `suggestionsFor()` is dead code, and Weekend bookings don't reach the pay run at all today. `docs/how-to-pay-run.md` already says weekend work goes in Notes.
4. **The Planner already shows Saturday and Sunday tiles** (two rows of seven in the fortnight view, and the phone agenda). A Weekend booking shows on the Saturday tile only. Showing it on Sunday too is a one-function change in `lib/planner/auto.js`, and the page code doesn't change.
5. **Overlap with T1-Teal (pay run notes, 0.2.17).** The pay-run part touches `lib/payroll.js` (`suggestionsFor`) and `public/payrun.js` (`hintFor`), the same files as T1-Teal's day notes. **Build it after T1-Teal's work is committed, on top of it.**

---

## a. End of shift for weekend workers

**Current behaviour.** See finding 1. A weekend worker can search for a job by hand and send a report, but the page doesn't know they're booked.

**Change (locked):**

- One shared helper in `lib/time.js`, `boardDayKey(weekday)`, gives `'mon'`..`'fri'` for 1 to 5 and `'wknd'` for 6 and 7. `lib/shift.js` uses it in `dayOf()`. `sydneyMonday()` already gives the previous Monday for a Sunday, so the week lookup is right on both days.
- **On Saturday and on Sunday**, `shift.today()` lists the jobs from the Weekend cells the person is booked on, as it lists Monday's jobs on a Monday, with the same Install/Manufacturing badges. `shift.photoTag()` tags a Weekend install job's photos `install`. A report can be sent on either day, one per person per date as now.
- **No weekend reminder (Todd):**
  - `dueToRemind()` returns nothing on Saturday and Sunday.
  - `runReminder()` skips them unless forced, as it does today.
  - Both get an explicit weekday check (weekday 1 to 5) instead of relying on `day` being null, because `day` is now `wknd` at the weekend.
  - A forced run (`POST /api/shift/reminder/run`) at the weekend also sends nothing, because `dueToRemind()` is empty.
- **`lib/mywork.js` is not changed.** It keeps its own weekday-only list, so the "End-of-shift report not sent today" line still never appears at the weekend. A comment there says so, so nobody "fixes" it to the shared helper later.
- The Morning check line, the accounts sweep and task schedules stay weekday-only. They're not part of this.

**What the weekend worker sees.** Opening End of shift (from the menu, or a link) on Saturday or Sunday: the date ("Saturday 14 November"), a card for each Weekend job with Add photos and Raise an issue, Another job search, the note, and Send report. Nothing prompts them: no bell, no My work line. They open it themselves, as today. Mockup: `docs/plans/mockups/weekend-shift.html` (views: Proposed Saturday, Proposed Sunday, Now (0.2.16)).

**Data and migration.** None. `shift_reports` is keyed by user and date.

**API.** No new route and no access change:
- `GET /api/shift/today`, `GET /api/shift/jobs`, `POST /api/shift/report` and `POST /api/shift/jobs/:id/photos` stay `shift.report`.
- `POST /api/shift/reminder/run` stays `users.admin`.
- `GET /api/my-work` (`routes/morning.js`) stays `'login'` and is unchanged.

**UI.** No page code change. `public/shift.js` already renders whatever jobs the server sends.

**Board, print, `exportJpg()`.** Not touched. **Board exceptions:** none needed.

**Docs.** `docs/how-to-shift-report.md`: one paragraph. If you're booked in the board's Weekend column, your Weekend jobs show on Saturday and Sunday. There's no reminder at the weekend, so open End of shift yourself when you finish.

## b. Weekend leave greys out Weekend chips

**Current behaviour.** `awayForWeek()` only looks at Monday to Friday. A person on leave over the weekend shows in their own colours in the Weekend cell, even when their Friday chip is grey (mockup "Now" view: Kel, on leave Friday to Monday).

**Change (locked):**

- `awayForWeek()` also fills `wknd`: **away if any leave, sick or other record covers Saturday or Sunday of that week.** If both days are covered by different kinds, Saturday's kind wins. The range query widens from Friday to Sunday (`weekStart`..`weekStart + 6`).
- **Regular days off stay Monday to Friday.** `wknd` is never `'off'`, and `regularDaysOff: ["wknd"]` stays refused (the 0.2.16 smoke already checks this).
- `lib/schedule.js`: the "Weekend cell is never away" comment goes. The code (`awayDays[a.day] || null`) already does the right thing.
- **Leave dialog hint** in `public/availability.js`:
  - It changes from "Whole days. Saturday and Sunday in the range are ignored by the board." to "Whole days. Leave over a Saturday or Sunday greys that person's Weekend chips on the board."
  - The leave list's **Weekdays** column keeps counting Monday to Friday.
- Pay-run leave suggestions don't change: there are no weekend days on a timesheet. The Planner's "Who's away" stays weekdays only (Todd).

**On the board, all through existing code:**
- The Weekend chip takes the grey M5 "away" style, with the hover title "On leave", "Sick" or "Away".
- The "+" picker on a Weekend cell lists the person last and greyed with their away tag, and asks "Kel is on leave that day." before booking.
- **`exportJpg()`** draws the grey fill and muted text, because it reads `chip.away`.
- **Print** shows the chip white with a dashed outline and "(away)", still black on white.
- So JPG and print are mirrored with no code change.

**Data and migration.** None.

**API.** No new route. `GET /api/schedule` (`board.view`) carries `wknd` in `week.away[workerId]` and in `chip.away`. `POST /api/availability/leave` and `DELETE /api/availability/leave/:id` stay `users.admin`.

**UI.** Mockup `docs/plans/mockups/weekend-board-away.html` runs the real `schedule.js` with sample data (views: Proposed, Now (0.2.16)). The Weekend "+" picker and the JPG and PDF buttons run the real code.

**Board sign-off.** Todd's yes to this (2026-11-13) is the sign-off for reusing the M5 away style in the Weekend column. **Do not edit CLAUDE.md yet.** When the orchestrator commits this batch (and only then), the draft line below goes at the end of the Weekend exception in non-negotiable 7:

> **Weekend leave (approved by Todd 2026-11-13):** a Weekend chip takes the M5 grey "away" style when the person's leave, sick or other record covers that Saturday or Sunday; regular days off stay Monday to Friday. No new style, size or layout; `exportJpg()` and print already mirror it through `chip.away`.

---

## c. What a Weekend booking counts as

### c1. In the Planner (locked: both days, one day)

**Current behaviour.** `boardDate(weekStart, 'wknd')` returns Saturday, so "Installing: job" appears on the Saturday tile only.

**Change.**
- In `lib/planner/auto.js`, `boardDate()` becomes `boardDates()`, returning `[Saturday, Sunday]` for `wknd` and `[date]` for a weekday.
- `boardWeeks()` adds each of those dates that falls inside [from, to].
- `public/planner.js` doesn't change (it checks `j.days.includes(d)`). The month grid lists job names per week and is unchanged.
- **Counting stays at one:** one worked day for days-a-week (`lib/availability.js`) and one person-day for project hours, dated Saturday (`lib/projectjobs.js`). Both files are unchanged.

**Data, API.** None. `GET /api/planner/events` stays `planner.view`; only `weeks[].installing[].days` gains the Sunday date.

**UI.** Mockup `docs/plans/mockups/weekend-planner-B.html` runs the real `planner.js` (views: Proposed both days, Now (0.2.16) Saturday only). Look at the fortnight view's Saturday 14 and Sunday 15 tiles.

**Board exceptions.** None. The Planner's layer-marker exception is unchanged.

### c2. On the pay run (locked: Friday note, nothing stored)

**Current behaviour.** See finding 3. Weekend bookings don't appear on timesheets, and `wknd: 5` in `suggestionsFor()` is dead code.

**Change.**
- `suggestionsFor()` gathers each week's Weekend bookings for the person and sets a new `weekend` text on that week's **Friday** suggestion: "job (quote)", joined with ", ", de-duplicated, in board order. The dead `wknd: 5` goes.
- `public/payrun.js` `hintFor()` appends "Weekend on the board: …" to Friday's Check column (grey, `.pr-hint`).
- **Nothing is filled in or stored**: Fill suggestions ignores `weekend`, and `pay_days` doesn't change.
- Accounts writes weekend hours in Notes, as now. Timesheet print (`payprint.js`) is unchanged.

**Data, API.** None. `GET /api/payruns/:id/timesheets/:tsId` stays `accounts.view`. `suggestions[friday].weekend` is a new optional field, sent only while the run is open (as all suggestions are).

**UI.** Mockup `docs/plans/mockups/weekend-payrun-hint.html` runs the real `payrun.js` with the `hintFor()` change applied to that copy (rows 13 Nov and 20 Nov).

**Board exceptions.** None.

**Docs.** `docs/how-to-pay-run.md` line 24 becomes: "Weekend work has no row: Friday's Check column lists the weekend's board jobs; write the hours in **Notes**, which print on the summary."

---

## Smoke-test additions (all in `ci/smoke-weekend.sh`, April 2035 data, as now)

The suite already makes its own worker (`WE_W`) and installing row (`WE_ROW`) in the week of Monday 2035-04-02 (Saturday 04-07, Sunday 04-08). The new blocks go before the tidy-up at the end. Each block cleans up its leave and users.

**b. Leave greys the Weekend chip:**
- Re-book `WE_W` on `wknd`.
- Leave Saturday only (04-07..04-07, `leave`): the Weekend chip's `.away` is `"leave"`, `week.away[WE_W].wknd` is `"leave"`, and Friday is null.
- Leave Sunday only: `"leave"`.
- Leave Friday only (04-06): Weekend null, Friday `"leave"`.
- Leave Monday to Friday of that week: Weekend null.
- Leave Friday to Monday (04-06..04-09): Friday and Weekend are `"leave"`, and the next week's Monday is `"leave"`.
- Sick on Saturday plus leave on Sunday: `"sick"` (Saturday wins).
- A Saturday-only leave lists with `days == 0`.
- `regularDaysOff: ["wknd"]` is still 400 (existing).
- Remove every leave (`DELETE /api/availability/leave/:id` gives 204), and the Weekend chip is no longer away.
- `GET /availability.js` contains the new hint text.

**a. End of shift at the weekend, with no reminder** (clock-free, as the 060 block does). Make a workshop login linked to `WE_W`, with `shift.report`, as `smoke-m25-shift.sh` does. One `docker exec node` script opens `/data/db/photos.db` read-only, takes an in-memory copy (`new Database(db.serialize())`), and calls the libs with fixed instants: Saturday 2035-04-07T02:00Z (12:00 Sydney), Sunday 2035-04-08T02:00Z, Friday 2035-04-06T02:00Z.
- `shift.today()` on Saturday and on Sunday lists `CI Weekend Job` with `panels == ["installing"]` and `installDay == true`. On Friday it doesn't list it.
- `shift.photoTag()` on Saturday gives `"install"`.
- **`shift.dueToRemind()` on Saturday and on Sunday gives `[]`**, though the login is on a Weekend install row with no report.
- **`shift.runReminder()` (not forced) at Saturday 16:30 Sydney sends 0** and doesn't set `shift.reminder_last_run` to that date.
- **`mywork.linesFor()` on Saturday and Sunday has no `shiftReport` line.**
- Control: book `WE_W` on `fri` too. Then `dueToRemind()` on Friday includes the login, so weekdays are unchanged.
- `boardDayKey`: 6 and 7 give `wknd`, and 1 to 5 give `mon`..`fri`.

**c1. Planner:**
- `GET /api/planner/events?from=2035-04-02&to=2035-04-15` (ADMIN): the `CI Weekend Job` installing entry's `days` include `"2035-04-07"` and `"2035-04-08"`.
- With `from=to=2035-04-08`: `days == ["2035-04-08"]`.
- The job's project hours (if the suite can reach them) still count the Weekend booking as one person-day.

**c2. Pay run:** in the same node script, `payroll.suggestionsFor(copy, {start_date: "2035-04-02"}, {workerId: WE_W})`:
- `["2035-04-06"].weekend` contains `CI Weekend Job`.
- There's no `2035-04-07` key.
- Friday's `job` is unaffected by the Weekend booking.
- `GET /payrun.js` contains "Weekend on the board".

The existing suites must still pass unchanged, especially `smoke-m5-availability.sh`, `smoke-m25-shift.sh` (its weekend branch still holds: no board jobs then means no reminder), `smoke-m7-auto.sh`, `smoke-m8-payruns.sh` and the 0.2.16 weekend block.

## Version

One bump for the batch, by the orchestrator in the final commit: `crosscuts/app/package.json` and the root version in `crosscuts/app/package-lock.json` go to **0.2.18** (or the next free number). **No migration.**

---

## Build tasks (for Sonnet 5.5 implementation subagents)

Each task gets this plan, CLAUDE.md and its file list. **No task bumps the version, edits CLAUDE.md, commits or pushes.** Tasks 1 to 3 touch different files and can run in parallel. Task 4 waits for T1-Teal's pay run notes to be committed. Task 5 runs after 1 to 4.

**Task 1: weekend leave (b).** Order: 1 (parallel).
- Files: `crosscuts/app/lib/availability.js` (`awayForWeek` adds `wknd`, the range widens to Sunday, Saturday's kind first, comments), `crosscuts/app/lib/schedule.js` (comment only), `crosscuts/app/public/availability.js` (the hint text).
- Acceptance:
  - `wknd` is set from Saturday-or-Sunday leave, sick or other, and is never `'off'`.
  - `weekdaysBetween` is unchanged.
  - **No diff** in `schedule.html`, `schedule.css`, `schedule.js` or `workers.html`.
  - `node ci/style-check.js` passes.
  - In a dev-shim run with a Friday-to-Monday leave: a grey Weekend chip, the Weekend "+" picker lists the person last and asks first, grey in the JPG, and dashed "(away)" in print preview.

**Task 2: End of shift at the weekend (a).** Order: 1 (parallel).
- Files: `crosscuts/app/lib/time.js` (`boardDayKey`), `crosscuts/app/lib/shift.js` (`dayOf` uses it; `dueToRemind` and `runReminder` get an explicit weekday-only check), `crosscuts/app/lib/mywork.js` (comment only: the weekday-only list is deliberate), `docs/how-to-shift-report.md`.
- Acceptance:
  - On Saturday and Sunday, `today()` lists Weekend jobs and `photoTag()` gives `install`.
  - `dueToRemind()` is `[]` and `runReminder()` sends nothing.
  - `linesFor()` has no `shiftReport` line.
  - Weekdays behave exactly as before.
  - **No change to `public/shift.js`.**
  - A node check with fixed `now` values against the dev database passes.

**Task 3: the Planner (c1).** Order: 1 (parallel).
- Files: `crosscuts/app/lib/planner/auto.js` (`boardDates`, `boardWeeks`).
- Acceptance:
  - A Weekend booking's `days` holds Saturday and Sunday when both are inside [from, to], and only the one inside otherwise.
  - Weekday bookings are unchanged.
  - `lib/projectjobs.js` and `public/planner.js` are unchanged.
  - The dev-shim fortnight view shows the booking on both tiles.

**Task 4: the pay-run Friday note (c2).** Order: 2, **after T1-Teal's pay run notes are committed**, built on top of them.
- Files: `crosscuts/app/lib/payroll.js` (`suggestionsFor`: `weekend` on each week's Friday, drop `wknd: 5`), `crosscuts/app/public/payrun.js` (`hintFor` appends "Weekend on the board: …", alongside whatever T1-Teal adds), `docs/how-to-pay-run.md`.
- Acceptance:
  - Friday's Check column lists the weekend jobs.
  - Fill suggestions fills nothing new, and nothing new is saved.
  - A finalised run sends no suggestions.
  - `payprint.js` is unchanged.
  - `smoke-m8-payruns.sh` and T1-Teal's new smoke still pass.

**Task 5: smoke tests.** Order: 3, after 1 to 4.
- Files: `ci/smoke-weekend.sh` only.
- Acceptance:
  - The blocks above.
  - `bash -n` is clean.
  - One full local smoke-harness run passes.

**Task 6 (the orchestrator): version, CLAUDE.md, STATUS.**
- Bump `package.json` and `package-lock.json`.
- Add the drafted CLAUDE.md line (only at commit time).
- Add a `docs/plans/STATUS.md` line.
- Commit locally with the attribution lines. **Never push** without Todd's yes.

## How I'll review the subagents' work

1. **Read every diff** against this plan. **No board file** (`schedule.html`, `schedule.css`, `schedule.js`, `workers.html`) may change, and nor may `public/shift.js` or `public/planner.js`. If one did, stop.
2. **Style check:** `node ci/style-check.js`.
3. **Local dev-shim run** (Git Bash, repo root): `cd crosscuts/app && DB_DIR=../../.dev/db UPLOADS_DIR=../../.dev/uploads CONFIG_DIR=../../.dev/config node -r ../../tools/dev-sqlite-shim.js server.js`, on a scratch `.dev` copy. In the browser:
   - The board with a Friday-to-Monday leave: grey Weekend chip, Weekend "+" picker, JPG export, print preview "(away)".
   - The leave dialog hint.
   - The Planner fortnight view: Saturday and Sunday tiles.
   - A pay run: Friday's note.
   - End of shift at the weekend: a node one-off calling `shift.today()`, `dueToRemind()` and `mywork.linesFor()` with fixed Saturday and Sunday instants against the dev database (the browser can't fake the date).
4. **Local smoke harness, one run at a time** (`.dev/m23-full`: copy the ci smokes in, then `node adapt.js && bash fullrun.sh`). First check that no other agent's smoke run is going (fake Joinr ports 4999/4996).
5. **CI is the real check**, and runs only when Todd says push.

---

## Todd's decisions (2026-11-13)

1. **End of shift reminders: never at the weekend.** No bell and no My work line. Weekend workers can still open End of shift and send a report, with their Weekend jobs listed on Saturday and Sunday.
2. **Weekend leave: leave on Saturday or Sunday greys the Weekend chip.** This is also the board sign-off for reusing the M5 away style in the Weekend column (CLAUDE.md line drafted above, to be added at commit).
3. **Pay run: a grey note in Friday's Check column**, "Weekend on the board: job (quote)". Nothing stored.
4. **Planner: both the Saturday and Sunday tiles, counting as one day** (option B).
5. **Planner "Who's away" stays weekdays only.**
