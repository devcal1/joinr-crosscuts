# Staff planner: discussion notes (pre-plan)

Status: **discussion with Todd (started 2026-10-11).** Nothing here is approved. When the discussion is done, these notes become `m7-plan.md` (stage 1 of the roadmap), with questions and recommended answers for Todd to approve.

## What Todd described (2026-10-11)

- **Used by everyone.** It is the central hub of all departments.
- **Each department has its own overlay.** People create events on the planner with their own user account.
- **Permissions decide what each person sees.** Accounts' events are not seen by everyone. The TV and the manufacturing staff see only hardware and install dates and the like.
- **Layout:** a month grid, Monday to Sunday, and beside it a two-week view (this week and next).
- **Automation:** some events are put on the planner automatically, where it makes sense.

## What Crosscuts has today that this touches

- **Roles:** admin, accounts, design_pm, scheduling, showroom (`lib/permissions.js`). There is no workshop or TV role yet; the TV signs in with an ordinary account.
- **Dated things that could feed the planner automatically:** board weeks per job (manufacturing, installing), promised install dates, materials ordered and received, client inspections, invoice due and overdue dates, leave and availability (M5), task due dates (M4), won quotes from Joinr (M6).
- **The board is frozen** (CLAUDE.md rule 7): the planner is a new page, not a change to the board.

## Answers so far (Todd, 2026-10-11, one question at a time)

1. **Overlays:** one per department (Accounts, Design/PM, Scheduling/Production, Workshop), plus **Company-wide**, **Personal** and **Install & hardware**. Each is a layer people can switch on and off.
2. **Visibility:** everyone sees Company-wide and Install & hardware; each department sees its own overlay; personal events only their owner; Accounts is private to accounts staff; workshop and TV accounts see only Company-wide and Install & hardware. Admin sees everything.
3. **Workshop:** a new **workshop role**: views the board and the planner's Company-wide and Install & hardware overlays, creates no events. The TV account and any workshop logins get it.
4. **Automatic events (all four groups):** installs and board weeks (promised install dates; the weeks a job is in manufacturing or installing); materials (ordered, due in, received) and client inspections; leave and who is away (from Availability, without the reason); invoice due and overdue dates (Accounts only) and task due dates (the assignee's personal overlay). Kept in step with their source, not typed in.
5. **Hand-made events:** all-day and multi-day, timed, repeating (weekly, monthly), and optionally linked to a job.
6. **Editing:** the creator, anyone in the same department (for that department's overlay) and admin. Company-wide: the creator and admin. Personal: only the owner. Every change audited.
7. **Placement:** a new Planner page (menu and home tile). **The TV stays board-only.**
8. **In this milestone:** reminders in the bell (e.g. one day before) and print/PDF of the month or the two-week view (black on white). A calendar feed for Outlook or phones is left for later.

## The four open points, settled (Todd, 2026-10-11)

1. **Layer colours: spectrum markers.** A new named house-style exception (needs adding to CLAUDE.md "Look and feel" when the plan is approved): each layer gets a small coloured marker (a left edge or dot on its events) from the brand spectrum (teal, violet, fuchsia, orange) plus greys for the rest. Event text stays white on the dark surface; print stays black on white with the layer name.
2. **Personal events: owner only.** Nobody else sees them, admin included. Admin sees every department and shared layer.
3. **Departments:** a person sees and posts to the layer of **every department role they hold**, picking the layer when creating an event (their main one pre-selected). **Automatic events: every job-related one goes on Install & hardware** (promised installs, manufacturing and installing weeks, materials ordered / due in / received, client inspections), so the workshop sees the whole production picture. Who's away goes on Company-wide, invoices on Accounts, task due dates on the assignee's Personal layer.
4. **Repeats: a series with one-off changes.** Weekly, fortnightly or monthly, with an optional end date; shown as far ahead as anyone scrolls; editing offers "this one" or "this and all later"; deleting one occurrence leaves the rest.

## Was still to settle (kept for the record)

- **Overlay colours vs the house style.** The house style allows only teal (working), orange (attend), red (overdue/destructive), and the spectrum as thin rules; worker colours and the board icons are the only exceptions. Overlays need to be told apart, so the plan will propose a named exception (for example the four spectrum colours plus neutrals as small overlay markers) for Todd to approve.
- **Admin and personal events.** "Admin sees everything" versus "personal: only the owner": recommend admin does not see the content of others' personal events (only that a slot is busy, or nothing at all).
- **Which department is each user in** (a user can have several roles today), and where "Scheduling/Production" ends and "Install & hardware" begins for the automatic events.
- **Repeats:** how far ahead, and editing one occurrence versus the series.
