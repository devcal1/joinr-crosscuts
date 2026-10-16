# Department notes: contracts

Todd's decisions, 2026-10-16. Each of five departments (Scheduling, Design/PM, Ordering, Accounts, Admin) has a **Notes** landing page: a weekly sheet where that department's people leave signed notes for each other. When a new week starts, the old week's notes move down and a fresh blank sheet is on top. Nothing is ever lost.

Where this file and the code disagree, report it. Code: `lib/notes.js`, `routes/notes.js`, `public/notes.html/.css/.js`, migration `029_dept_notes.sql`. Suite: `ci/smoke-m15-notes.sh`.

## 1. Schema (migration 029, additive)

Table `dept_notes`:

| column | notes |
|---|---|
| `id` | integer primary key |
| `dept` | `scheduling`, `design`, `ordering`, `accounts` or `admin` (CHECK) |
| `week_start` | the Monday (Australia/Sydney) of the week the note was written, `YYYY-MM-DD` (CHECK on the shape) |
| `body` | text, 1 to 2000 characters, not blank (CHECK) |
| `author_id` | `users(id)` |
| `created_at`, `updated_at` | UTC ISO text; `updated_at` moves on every edit |
| `removed_at` | null, or the time the author removed it (soft delete) |

Index `idx_dept_notes_dept_week` on `(dept, week_start)`. No existing table changes.

## 2. Who may use which sheet

Five new feature keys (Todd, 2026-10-16: reusing existing keys let too many roles in; for example everyone with `orders.view` would have read the Ordering notes). They are ordinary keys, added to `KEYS` in `lib/permissions.js`. Nothing in the database constrains key names (`permission_overrides.feature_key` is free text, checked against `KEYS` by the Users routes), so migration 029 only creates the table. The map is in one place, `lib/notes.js` (`DEPTS`).

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

## 3. Weeks

A note belongs to the Monday-start week (Australia/Sydney) in which it was written (`sydneyMonday(sydneyToday())` from `lib/time.js`). The rollover is plain date arithmetic on each request: there is no timer and no job. The week is stored on the row when the note is written and never changes.

## 4. Editing and removing

- Only the **author** may edit or remove a note, and only **during the week it was written**. After the week has rolled over the note is locked.
- No one else may change someone's note, admins included (403).
- Remove is a soft delete (`removed_at`). A removed note is never shown again and cannot be edited or removed again (404).
- Edits may carry the `updatedAt` the client last saw; a different value is a 409 ("This note was changed somewhere else; reload it"). Leaving it out skips the check.

## 5. API

All under `/api/notes`, all declared through `defineRoutes` with the five keys. Errors are `{error}` with the codes below.

| route | does |
|---|---|
| `GET /api/notes?dept=<id>` | `{dept, deptLabel, thisWeek, weeks: [thisWeek, lastWeek], more, next}`. Each week is `{weekStart, label, current, notes}`; notes are newest first. `more` is true if older notes exist. `next` is the cursor for the next call. |
| `GET /api/notes?dept=<id>&before=<YYYY-MM-DD>[&limit=n]` | up to `limit` (default 4, at most 12) earlier weeks **that have notes**, newest first, strictly before `before`. Same shape; `next` is the oldest week returned. |
| `POST /api/notes` `{dept, body}` | 201 with the note, filed under this week and signed by the caller. |
| `PATCH /api/notes/:id` `{body, updatedAt?}` | 200 with the note. |
| `DELETE /api/notes/:id` | 204. |

A note is `{id, dept, weekStart, body, author: {id, name}, createdAt, updatedAt, edited, canEdit}`. `canEdit` is true only for the author, in the current week. Note text is stored and returned exactly as typed (trimmed, line breaks kept as `\n`); the page shows it with `textContent` only.

Errors:
- 400: unknown or missing department, a body that is missing, not text, empty or blank, or over 2000 characters ("Notes are 2,000 characters at most"), a bad `before` or `limit`.
- 401: not logged in.
- 403: no key for that department; or not the note's author.
- 404: no such note, or it was removed.
- 409: the note's week is over ("That week is over, so the note can no longer be changed or removed"); or a stale `updatedAt`.

## 6. Audit

Entity `dept_note`, entity id the note's id. `note.create` (after: dept, weekStart, body), `note.update` (before and after: dept, weekStart, body), `note.remove` (before: dept, weekStart, body). Refused requests write nothing.

## 7. The page

`/notes.html?dept=<id>`, one page for all five, with the shared menu bar. Title "<Department> notes". Top to bottom: **This week** (week of Mon d Mon) with a textarea and **Add note**, then the notes; **Last week**; an **Older weeks** button that adds earlier weeks (those with notes) four at a time. An empty week shows a quiet "No notes". Each note shows its text, signed with the author's display name and the Sydney day and time (and "(edited)"). The author sees **Edit** and **Remove** on their own notes this week; Remove asks first. An unknown or forbidden department shows a plain message and loads no notes. The menu highlights the Notes item of the department being viewed (`isCurrent` in the shell compares the `?dept=` value). Print: black on white, the sheets only.

## 8. Tests

`ci/smoke-m15-notes.sh`, sourced by `ci/smoke.sh` after the M14 suites. It checks access per role, a per-person grant and revoke through the Users overrides, and the presets. `ci/smoke.sh` steps a and d count 35 keys and the 32-key admin preset. It seeds older weeks straight into the table (the app writes only the current week), and moves a note's week back to prove the lock after a rollover.
