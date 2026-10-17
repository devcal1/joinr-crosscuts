# Department notes: contracts

Todd's decisions, 2026-10-16. Each of five departments (Scheduling, Design/PM, Ordering, Accounts, Admin) has a **Notes** page: a week wall like sticky notes on a board, one column per weekday, where that department's people stick signed notes on the day they are for and give each other's notes a thumbs-up. Nothing is ever lost: any past week can be paged back to.

Where this file and the code disagree, report it. Code: `lib/notes.js`, `routes/notes.js`, `public/notes.html/.css/.js`, migration `029_dept_notes.sql`. Suite: `ci/smoke-m15-notes.sh`. Mockup chosen by Todd: `.dev/notes-options/option2.png`.

## 1. Schema (migration 029, additive)

Migration 029 had not been released when the wall layout was chosen, so it was edited in place. (Migration 030 is a different change: the Planner custom repeat.) A local dev database that applied the first version fails the checksum and must be deleted.

Table `dept_notes`:

| column | notes |
|---|---|
| `id` | integer primary key |
| `dept` | `scheduling`, `design`, `ordering`, `accounts` or `admin` (CHECK) |
| `note_date` | the weekday the note sits under (Australia/Sydney, `YYYY-MM-DD`). CHECK: a real date (`date(note_date) IS note_date`) that is Monday to Friday (`strftime('%w')` 1 to 5) |
| `week_start` | the Monday of `note_date`'s week. CHECK: equals `date(note_date, -(weekday-1) days)`, so the two can never disagree. Kept as a column so a week is one indexed lookup |
| `body` | text, 1 to 2000 characters, not blank (CHECK) |
| `author_id` | `users(id)` |
| `created_at`, `updated_at` | UTC ISO text; `updated_at` moves on every edit or move (never on a thumbs-up) |
| `removed_at` | null, or the time the author removed it (soft delete) |

Index `idx_dept_notes_dept_week` on `(dept, week_start)`.

Table `dept_note_acks`: `note_id` (`dept_notes(id)`), `user_id` (`users(id)`), `created_at`; primary key `(note_id, user_id)`, so a person has at most one thumbs-up per note. No existing table changes.

## 2. Who may use which wall

Five new feature keys (Todd, 2026-10-16: reusing existing keys let too many roles in; for example everyone with `orders.view` would have read the Ordering notes). They are ordinary keys, added to `KEYS` in `lib/permissions.js`. Nothing in the database constrains key names (`permission_overrides.feature_key` is free text, checked against `KEYS` by the Users routes), so migration 029 only creates the tables. The map is in one place, `lib/notes.js` (`DEPTS`).

| dept | key |
|---|---|
| `scheduling` | `notes.scheduling` |
| `design` | `notes.design` |
| `ordering` | `notes.ordering` |
| `accounts` | `notes.accounts` |
| `admin` | `notes.admin` |

Role presets: scheduling has `notes.scheduling`; design_pm `notes.design`; ordering and workshop_manager `notes.ordering`; accounts `notes.accounts`; the admin preset has all five (it is every non-owner key); showroom and workshop have none. Admins grant or revoke any of them per person on the Users page. Total keys 35; admin preset 32.

The same keys are used by:
- the page gate: `/notes.html` is open to anyone holding any of the five keys (`lib/pages.js`);
- every `/api/notes` route: declared with the five keys as an array (any one gets in), then the department's own key is checked inside (403 without it);
- the menu: `public/shell/shell.js` has `{ label: "Notes", href: "/notes.html?dept=<id>", key: "notes.<id>" }` as the first item of each of the five departments. The shell is static browser code, so it repeats the keys; the smoke suite checks the five lines match.

Admins have no special power over other people's notes (see section 4).

## 3. Weeks and days

All dates are Australia/Sydney calendar dates; the arithmetic is on date strings (`lib/time.js`), never on the server's own clock zone. A week is Monday to Friday; the wall has no weekend column.

- A note sits under one weekday, `note_date`, chosen when it is written (or moved).
- **A note may go on today or any later weekday**, this week or any future week, without limit. Earlier days are refused (400), as are Saturdays and Sundays (400), whatever week they are in.
- A note written with no day goes under **today** on a weekday, and under **the next Monday** on a Saturday or Sunday (`defaultDate` in `lib/notes.js`).
- **Past weeks are read-only**: no new note, edit, move or remove in a week before the current one. The only thing allowed on a past week is a thumbs-up (section 5).
- The rollover is plain date arithmetic on each request: no timer, no job.
- Stacking: a day's notes show in the order they were posted (`id` ascending).
- Signing: every note shows its author's display name and the time it was posted (Sydney), written by the server's data, never typed by the user. If it was posted on a different day than the one it sits under, the page adds the posting day ("Owner · Thu 15 Oct 9:05 am").

## 4. Editing, moving and removing

- Only the **author** may edit, move or remove a note, and only **while the note's week is the current week or a later one**. Once its week is over it is locked.
- No one else may change someone's note, admins included (403).
- Text may change on any day this week, even a day already gone (the note keeps its day). A **move** goes only to a weekday that is today or later; naming the day the note is already on is not a move.
- Remove is a soft delete (`removed_at`). A removed note is never shown again and cannot be edited, removed or acknowledged again (404).
- Edits may carry the `updatedAt` the client last saw; a different value is a 409 ("This note was changed somewhere else; reload it"). Leaving it out skips the check. A thumbs-up does not change `updatedAt`.
- An edit that changes nothing returns the note and writes nothing (no audit row, `updatedAt` stays).

## 5. The thumbs-up

- Anyone who can open that department's notes, except the note's author, may give a note a thumbs-up, in **any week, past included**. The author's own note shows the mark but it is inactive; trying through the API is a 403 ("You can't acknowledge your own note").
- A person has one thumbs-up per note. Pressing it again takes it back. The note shows the count and the names of who gave one, in the order they gave them ("Todd, Sam").
- `PUT` and `DELETE` are idempotent: asking for the state you are already in changes and records nothing.
- A thumbs-up does not count as editing the note.

## 6. API

All under `/api/notes`, all declared through `defineRoutes` with the five keys. Errors are `{error}` with the codes below.

| route | does |
|---|---|
| `GET /api/notes?dept=<id>[&week=<Monday>]` | The week's wall; no `week` means the current week. |
| `POST /api/notes` `{dept, date?, body}` | 201 with the note. `date` is a weekday, today or later; left out it is today (or the next Monday on a weekend). |
| `PATCH /api/notes/:id` `{body?, date?, updatedAt?}` | 200 with the note. At least one of `body` and `date`. |
| `DELETE /api/notes/:id` | 204. |
| `PUT /api/notes/:id/ack` | 200 with the note, the caller's thumbs-up given. |
| `DELETE /api/notes/:id/ack` | 200 with the note, the caller's thumbs-up taken back. |

`GET` answers `{dept, deptLabel, today, thisWeek, weekStart, heading, label, current, past, prev, next, canAdd, formDays, defaultDate, days}`:
- `heading` is "Week of Mon 12 Oct"; `prev` and `next` are the Mondays either side; `current` and `past` say where the week is against today; `canAdd` is false for a past week.
- `days` is always five entries, Monday to Friday: `{date, name, label ("Tue 13 Oct"), today, canAdd (the day is today or later), notes}`.
- `formDays` are the days the add form offers, `{date, label}`: today and later in the shown week; on a Saturday or Sunday, looking at the current week, next week's five days; none for a past week. `defaultDate` is the one to preselect.

A note is `{id, dept, date, weekStart, body, author: {id, name}, createdAt, updatedAt, edited, canEdit, canAck, acks: {count, names, mine}}`. `canEdit` is true only for the author, while the note's week is the current one or later. `canAck` is true for everyone but the author. Note text is stored and returned exactly as typed (trimmed, line breaks kept as `\n`); the page shows it with `textContent` only.

Errors:
- 400: unknown or missing department; a body that is missing, not text, empty or blank, or over 2000 characters ("Notes are 2,000 characters at most"); a date that is not a real date ("Choose a day for the note"), is a Saturday or Sunday ("Notes go on a weekday, Monday to Friday") or is before today ("Notes can only go on today or a later day"); a PATCH that names neither body nor date ("Nothing to change"); a `week` that is not a date ("week must be a date (YYYY-MM-DD)") or not a Monday ("week must be a Monday").
- 401: not logged in.
- 403: no key for that department; or not the note's author (edit, move, remove); or the author's own note (thumbs-up).
- 404: no such note, or it was removed.
- 409: the note's week is over ("That week is over, so the note can no longer be changed or removed"); or a stale `updatedAt`.

## 7. Audit

Entity `dept_note`, entity id the note's id.
- `note.create` (after: dept, date, weekStart, body).
- `note.update` (before and after: dept, date, weekStart, body), for an edit, a move or both.
- `note.remove` (before: dept, date, weekStart, body).
- `note.ack` (after: dept) and `note.unack` (before: dept), written only when the state really changed; the actor is the person who pressed.

Refused requests and no-ops write nothing.

**Who sees these rows (Todd, 2026-10-17):** in the audit log (`/api/audit`) a note's rows are shown only to a reader who holds that note's department key, `notes.<dept>`; everyone else with `audit.view` does not see them at all. They are left out of the rows, the total (so paging gives nothing away) and a search by entity type or id. The department is read from the row's `dept` (in `before` or `after`, as listed above). Code: `noteDeptClause` in `lib/audit.js`, used by `routes/audit.js`. The owner and admins holding all five notes keys see every department.

## 8. The page

`/notes.html?dept=<id>&week=<Monday>`, one page for all five, with the shared menu bar. Title "<Department> notes". The shown week is in the address (the page writes it on load and on each change; a bad or missing `week` shows the current week), so a week can be linked and refreshed, and the browser's back button steps through the weeks.

- **Top bar:** the week heading ("Week of Mon 12 Oct") and the buttons **Last week**, **This week** (inactive on the current week), **Next week** and **Add note** (hidden on a past week). Last and Next move one week at a time with no limit.
- **The wall:** five columns, Monday to Friday, each headed with the day name and date ("Tue 13 Oct"); today's header is teal with "· today". Notes are cream paper sticky notes (`--paper`, `#E9E4C9`) with ink text, no shadow and no tilt, stacked in posted order. Each is signed at the bottom, in bold, with the author's name and time ("Design Test A · 11:20 am"), and "(edited)" after an edit.
- **Adding:** **Add note** and the dashed **+ NEW NOTE** at the foot of each column that is today or later open the small form: the text and a day select (the `formDays`; today preselected, Monday on a weekend; the column's own day when opened from a column). Posting a note onto a day of another week takes you to that week.
- **Editing:** the author's own notes (current or future week) have **Edit** and **Remove**. Edit opens the text and a day select (the note's own day, today and later this week, and the following week); **Save** or **Cancel**. Remove asks first. The wall is not redrawn while one is open.
- **Thumbs-up:** each note has the Phosphor thumbs-up mark with the count and, beside it, the names. Pressing toggles your own; the count is bold when you gave one. On your own note the mark is shown but inactive. This is the one icon on the page.
- **Phone width (820 px and under):** the five columns stack, day headings stay, empty past days say "No notes". No horizontal scroll.
- An unknown or forbidden department shows a plain message and loads no notes. The menu highlights the Notes item of the department being viewed (`isCurrent` in the shell compares the `?dept=` value). A tab left open reloads when it is looked at again. Print: black on white, the wall only (no menu, buttons, form or placeholders).

The two named style exceptions (CLAUDE.md, Todd 2026-10-16) are the cream paper and the thumbs-up icon, only in `notes.html`, `notes.css` and `notes.js`. `ci/style-check.js` allows the `--paper` token and Phosphor in exactly those files; the `--paper` colour is defined once in `tokens.css`.

## 9. Tests

`ci/smoke-m15-notes.sh`, sourced by `ci/smoke.sh` after the M14 suites. It works on any day of the week (it works its dates out from Sydney's today). It checks access per role, a per-person grant and revoke through the Users overrides, the presets; the wall's shape; creating on today or later days, in this week and future weeks, and the refusals (a past day, a weekend date, bad dates); the weekend default; limits; the author's edit, move and remove (and the refusals for other people); past weeks read-only, by moving a note's week back to prove the lock and by seeded older rows; walking the weeks with `?week=`; the thumbs-up (toggle, idempotence, names and count, not your own note, any week, access); the audit rows; and the tables' own CHECKs. `ci/smoke.sh` steps a and d count 35 keys and the 32-key admin preset.
