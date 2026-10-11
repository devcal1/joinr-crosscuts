# Crosscuts — Milestone 5 plan: Scheduling extras (2026-10-11)

Status: **approved by Todd 2026-10-11** (M5 · 1.3): every recommended answer in §11. Steps: M5 · 1.1 (audit, §1), M5 · 1.2 (plan and questions), M5 · 1.3 (decisions).

Source of truth: `crosscuts-brief.md` §5.3 (items 2–5), D13, D15, §8; the Workshop Scheduler notes on Todd's Drive (02 Constraints, 03 Staff, 06 Hours, 07 Architecture); roadmap M5 row. Binding: CLAUDE.md non-negotiable 7 (the board's structure, sizes and behaviour stay; any visual change is mirrored in `exportJpg()`; print stays black on white).

**M5 scope:**
- **Production stage at Finish week:** the furthest stage each job reached that week, kept as history per job per week.
- **Leave and availability:** leave and sick days per worker, part-time patterns, greyed chips on the board, and a warning when someone on leave is assigned.
- **Board indicators:** materials in / not yet, and the current production stage, as small marks on each row (mirrored in the JPG and print).
- **Lookahead:** a read-only page showing the next 4 weeks and the "To start" list ordered by promised install date.

**Not in M5:** anything from the solver (machine toggles, speed factors, skill matrices, estimated hours, capacity), half-day leave unless Todd wants it (question 4), drag-and-drop on touch screens, and any change to the board's layout.

## 1. Audit findings (M5 · 1.1)

Three read-only surveys, 2026-10-11: the board front end, the data and back end, and the Workshop Scheduler notes on Drive (all seven files found).

**What already exists:**
- **The board** (`schedule.html/js/css`) draws two panels with a job column (204 px) and five day columns. Each job cell has the name and one line of small icon buttons (grip, notes, copy, move back/forward, delete), with about 35 px spare on that line. Chips are coloured per worker (`hue`).
- **`exportJpg()`** draws from data on a canvas (not a screenshot), with twins for notes (a dot) and flags (an orange wash). `alignPanels()` is shared with `renderWeeks`. Print has a text twin for notes (`● note`).
- **Finish week:** one line per job with four outcomes (not started, manufacturing, install, complete), sent as `POST /api/rows/finish-week {weekStart, results:[{jobId, outcome}]}`. The server validates before its transaction and ignores unknown fields, so a `stage` field is purely additive.
- **Data the indicators need already exists:** `jobs.materials_in_date` and `materials_ordered_date` (M3), `promised_install_date`, `is_two_pac`, `benchtop` (`laminate`, `stone`, `none`; M1).
- **The `leave.edit` key** exists (admin, scheduling) and gates nothing yet. The Scheduling page has "Leave and availability" and "Lookahead" tiles marked Planned.
- **Smoke tests** cover Finish week in detail (carry-forward, worker copy, backlog insert, an identical repeat creating nothing, bad bodies writing nothing) and the cutover rehearsal compares the old and new `/api/schedule` in order, including the backlog.

**What doesn't exist:** no leave or availability tables or fields (workers have only name, hue, archived, order); no production stages anywhere (`jobs.stage` is the separate lifecycle stage); no stage history; no lookahead endpoint (`/api/schedule` is fixed at two weeks); nothing orders "To start" by promised date; the schedule rows carry no materials or stage fields.

**From the Workshop Scheduler notes (Drive):**
- **Stages, in order:** cut & edge, kit, assemble, inspect, paint, transport & install, return visit. Not every job uses every stage: **paint only for two-pac jobs**; **return visit only for two-pac jobs with a stone benchtop** (to hang the painted doors after the stone goes in). A non-painted stone job is complete after install. Inspect is usually a sign-off, not a block of work.
- **Hours:** Monday to Friday only (no Saturday), 8 hours Monday–Thursday and 6 on Friday. Everyone is full time except one person who works **any 3 of the 5 days**, chosen week by week. Two office people are on the floor only as backup; they are not "on leave" on other days.
- **"A job must stand on its own"** (07): the scheduler never assumes a quote exists. Crosscuts already meets this (`jobs.source`, nullable `external_ref`); stage history hangs off `jobs.id`.

**Traps found:**
1. **Rule 7 vs the brief.** The brief asks for indicators on rows, greyed chips and a stage picker in the Finish week dialog; rule 7 freezes the board's structure and behaviour. These need Todd's explicit, narrow exception (question 1).
2. **Row height.** Anything that adds a line to the job cell, widens the job column or adds to chips changes sizes. The JPG computes row heights from chips only, so a taller job cell would misalign the export. Indicators must fit on the existing icon line.
3. **Three twins.** Every board mark needs a screen version, a JPG version (dark canvas, colours from tokens, shapes not icon fonts) and a print version (black on white text).
4. **Leave can be bypassed.** Assignments are created through the "+" popover, but also copied by Finish week, Copy to next week and Move week. A popover warning alone isn't enough; the chip itself must show "on leave".
5. **Part-time is flexible.** "Any 3 of 5 days" can't be greyed in advance; it can only warn when someone is put on more than 3 days.
6. **Finish week is matched by job name** on the screen (duplicate job ids are dropped), and an identical repeat must create nothing. Stage history must be an upsert per job per week, written inside the same transaction, validated before it.
7. **The TV doesn't refresh.** The board only reloads after an edit on that screen or at midnight, so materials-in or leave entered elsewhere won't appear on the TV until then (question 5).
8. **Cutover rehearsal** compares the backlog order: the board's "To start" order must not change. Promised-date ordering belongs on the Lookahead page.
9. **Two "stages".** `jobs.stage` (lead … invoiced) is the lifecycle. Production stages need their own table and names.

## 2. How it works, in one paragraph

At **Finish week**, beside each job's outcome, the scheduler picks how far the job got (cut & edge … return visit; paint and return visit only offered when they apply). Crosscuts keeps that per job per week, and the board shows the latest stage as a short label on the row, next to a small materials mark (in / ordered but not in). The **Availability** page lets scheduling record leave and sick days, and set a part-timer's days per week; on the board, a chip for someone on leave that day turns grey, the "+" picker shows who's away, and assigning them asks "on leave, assign anyway?". The **Lookahead** page shows the next four weeks of rows (who's on what, read-only) and the "To start" list ordered by promised install date. The TV board shows the same marks, and so do the JPG and the printout.

## 3. Data (migration `013_scheduling.sql`, additive only)

- `production_stages`: `job_id`, `week_start` (the finished week's Monday), `stage` (`cut_edge`, `kit`, `assemble`, `inspect`, `paint`, `install`, `return_visit`), `recorded_by`, `recorded_at`; primary key `(job_id, week_start)`. The job's **current stage** is its latest row. Labels are kept in code ("Cut & edge", "Kit", "Assemble", "Inspect", "Paint", "Install", "Return visit").
- `leave`: `id`, `worker_id`, `date_from`, `date_to` (Sydney dates, inclusive), `kind` (`leave`, `sick`, `other`), `note`, `created_by`, `created_at`, `removed_at`, `removed_by`. Weekends inside a range are ignored.
- `workers` gains two nullable columns: `days_per_week` (null = full time; e.g. 3) and `regular_days_off` (e.g. `"fri"`; null = none), so both a flexible and a fixed pattern can be recorded (question 2).
- No backfill: history starts empty. No existing row changes.

## 4. Finish week

- Each job line gets a second, smaller control: **Stage reached**, a select listing only the stages that apply (paint only if two-pac; return visit only if two-pac and stone; all seven if those fields are unknown). It defaults to the job's current stage, or "Not recorded".
- Optional: Done is still enabled when no stage is chosen (question 3). The request gains `stage` per result; the server validates it before the transaction and upserts one `production_stages` row per job inside it, keyed to the finished week. A repeat Finish week overwrites the same row and still creates no board rows.
- The dialog's width and layout stay; the select sits on the job line, which already wraps. This is the one structural addition to the dialog (question 1).

## 5. Leave and availability

- **`/availability.html`** (view `scheduling.view`, edit `leave.edit`): a list of workers with their pattern (full time / N days a week / regular day off), and their upcoming leave; Add leave (worker, from, to, kind, note); remove (soft). Linked from the Scheduling page tile, which stops being "Planned".
- **On the board:** a chip whose worker is on leave that day gets an "away" style (grey ground, muted text, a strike or "AWAY" marker in print); in the "+" picker, people on leave that day are listed last with "On leave" and assigning one asks first. The server returns `onLeave` per chip, worked out in one query per request.
- **Part-time:** someone with `days_per_week` = 3 who is assigned on a 4th day in that week shows the same warning in the picker and an orange outline on the extra chip. A regular day off greys like leave.
- Leave never removes or blocks an assignment: the scheduler decides.

## 6. Board indicators

- **On each row's icon line** (no new line, no width change): a **materials mark**, a small Phosphor icon (`ph-package`, allowed on the board): teal when `materials_in_date` is set, orange when materials are ordered but not in, absent when nothing is tracked; and a **stage label**: the current stage as a short uppercase text (`CUT`, `KIT`, `ASM`, `INSP`, `PAINT`, `INST`, `RV`), muted.
- **JPG twin:** a small filled square (teal or orange) and the same short label beside the notes dot; the job name's width shrinks to fit, as it does for notes.
- **Print twin:** text after the name (`● materials in`, `● ordered`, `KIT`), black on white, as the notes marker does.
- **Data:** `/api/schedule` rows gain `materials` (`in`, `ordered`, or null) and `productionStage` (key or null); chips gain `onLeave` and `overDays`. All additive; every existing field stays, so the cutover comparison still passes.

## 7. Lookahead

- **`/lookahead.html`** (`scheduling.view`): the next four weeks (this week and three more), each a compact read-only table per panel (job, the days with who's on them, materials mark, stage), and "To start" ordered by promised install date (no date last), with the materials mark and the promised date. No editing; links open the job page.
- A new `GET /api/scheduling/lookahead?weeks=4` (max 6) reuses the board's row builder; the board's own `/api/schedule` and its "To start" order are unchanged.

## 8. TV refresh (question 5)

- Recommended: the board reloads its data every 5 minutes **only when nothing is open** (no popover, dialog, note editor or drag in progress, and no input focused), so the TV shows materials, leave and stage changes made elsewhere. This is a behaviour change on the board, so it needs Todd's yes.

## 9. Pages, keys, tests

- Pages: `/availability.html` (`scheduling.view`), `/lookahead.html` (`scheduling.view`). No new keys; `leave.edit` goes live (`docs/auth.md` loses its †).
- Smoke (`smoke-m5-*.sh`): Finish week with stages (stored per week, repeat overwrites, bad stage 400 and nothing written, stages filtered server-side too), leave CRUD and access (show/acct 403, dpm read-only), `onLeave`/`overDays` in `/api/schedule`, the lookahead order, and the existing Finish week and cutover assertions still passing unchanged.
- Local: shim boot, style check, headless-Edge screenshots of the board at 1920 (TV) and 1440, a JPG export compared side by side with the screen, a print preview, and the Finish week dialog.
- **Waves** (as before): 2.2 scaffold (migration 013, stage list, leave lookup, row fields, empty routers); Wave 1: **A** Finish week stages + board indicators and their JPG/print twins (the only task touching board files); **B** leave and availability (backend, `/availability.html`, chip `onLeave`/`overDays` data); **C** lookahead (backend and page). Wave 2: **D** board chip "away" style, picker warning, twins, and the TV refresh (if approved), after A and B are merged, so only one task edits `schedule.js` at a time.
- Release: as Todd decides; the next app push after 0.1.5 is 0.1.6.

## 10. Not in M5

Solver inputs (estimated hours, skills, speed factors, machines), half-day leave (unless question 4 says otherwise), leave requests or approvals by workers (they have no logins), a stage history chart, and touch drag on the board.

## 11. Questions for Todd (M5 · 1.2) and decisions (M5 · 1.3, 2026-10-11)

1. **Board exception (rule 7).** M5 needs four small, approved changes on the board, each mirrored in the JPG and print: (a) a materials mark and a short stage label on each row's existing icon line; (b) a grey "away" style for chips of people on leave; (c) a "Stage reached" select in the Finish week dialog; (d) a warning in the "+" picker when assigning someone on leave or over their days. Rows, columns, sizes and everything else stay as they are. *Recommended: approve these four exactly.*
   - **Decision: approved, these four exactly** (recorded in CLAUDE.md rule 7).
2. **Part-time patterns.** (a) *Recommended:* record both: "N days a week" (flexible, warns on an extra day) and an optional regular day off (greyed like leave). (b) Only fixed days off.
   - **Decision: (a)**, days a week plus an optional regular day off.
3. **Stage at Finish week:** (a) *Recommended:* optional, defaulting to the job's current stage, with only the stages that apply offered (paint for two-pac; return visit for two-pac with stone). (b) Required for every job before Done.
   - **Decision: (a)**, optional with the smart default and filtered stages.
4. **Leave granularity:** (a) *Recommended:* whole days (leave, sick, other), Monday to Friday. (b) Half days too.
   - **Decision: (a)**, whole days.
5. **TV refresh:** (a) *Recommended:* the board reloads every 5 minutes when nothing is open, so the TV picks up changes made elsewhere. (b) Keep today's behaviour (reloads only after an edit on that screen, or at midnight).
   - **Decision: (a)**, every 5 minutes when idle.
