# M4 interface contracts (binding for all M4 subagents)

Read `docs/plans/m4-plan.md` for the why (its §13 decisions are binding); this file is the *what*. Everything in `m1-contracts.md`, `m2-contracts.md` and `m3-contracts.md` still holds: timestamps, dates, `defineRoutes`, audit, errors `{error}`, `lib/httperror.js`, the notification shape, and the board files that must not be edited. Do not change anything here without the integrator's say-so. If a contract looks wrong, report it instead of working around it. Points the integrator settled before the waves are in §11.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), no build step, no framework. Business dates are Sydney `YYYY-MM-DD` (`lib/time.js` `sydneyToday()`); timestamps are UTC ISO with milliseconds. Removal is soft everywhere in M4.

**No version bump during the M4 build.** The release is paused (Todd, 2026-10-11); the bump to 0.1.5 happens at release. **No new feature keys:** the count of 21 stays. **Not touched:** `schedule.html`, `schedule.css`, `schedule.js`, `workers.html`, `exportJpg()`, `public/shared.js`, `lib/invoices.js`, `lib/jobstage.js`.

## 1. Migration (scaffold, M4 · 2.2): `012_collaboration.sql`

```sql
-- M4 Collaboration (docs/plans/m4-contracts.md section 1). Additive only: new tables,
-- indexes and four seeded channels. No existing table or row changes.
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER REFERENCES jobs(id),
  due_date TEXT,                                        -- Sydney YYYY-MM-DD; null = no due date
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  done_at TEXT,
  done_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status, due_date);
CREATE INDEX idx_tasks_creator ON tasks(created_by, status);
CREATE INDEX idx_tasks_job ON tasks(job_id, status);
CREATE INDEX idx_tasks_status ON tasks(status, due_date);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task','job')),
  entity_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_comments_entity ON comments(entity_type, entity_id, id);

CREATE TABLE follows (
  user_id INTEGER NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task','job')),
  entity_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, entity_type, entity_id)
);
CREATE INDEX idx_follows_entity ON follows(entity_type, entity_id);

CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT CHECK (role IS NULL OR role IN ('accounts','design_pm','scheduling')),
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
INSERT INTO channels (slug, name, role, position) VALUES
  ('all', 'All', NULL, 1),
  ('accounts', 'Accounts', 'accounts', 2),
  ('design', 'Design/PM', 'design_pm', 3),
  ('scheduling', 'Scheduling', 'scheduling', 4);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_messages_channel ON messages(channel_id, id);

CREATE TABLE channel_reads (
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stored_name TEXT NOT NULL UNIQUE,                     -- <uuid>.<ext>, ext from the allowlist
  original_name TEXT NOT NULL,                          -- display and download name only
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id)
);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,                                 -- YYYY-MM (Sydney month the report covers)
  category TEXT NOT NULL CHECK (category IN ('bank_reconciliation','bas','payroll','aged_debtors','other')),
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  file_id INTEGER NOT NULL UNIQUE REFERENCES files(id),
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_reports_period ON reports(period, category);

CREATE TABLE task_files (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  file_id INTEGER NOT NULL UNIQUE REFERENCES files(id),
  PRIMARY KEY (task_id, file_id)
);
```

A file belongs to exactly one report or one task (the `UNIQUE` on `file_id` in both link tables, and the code never links a file twice). Comments and follows point at a task or job by `entity_type` + `entity_id` without a foreign key (two parents); the routes check that the parent exists.

**Lengths** (checked in the routes, 400 beyond): task title 1–200, task notes ≤ 10,000, comment and message body 1–4,000 after trimming, report title 1–200, report notes ≤ 2,000, original file name ≤ 200 (longer names are cut, keeping the extension).

## 2. Shared library signatures

### `lib/files.js` (scaffold, new, complete; A and C use it)

```js
const FILES_DIR;            // path.join(UPLOADS_DIR, 'files'); created at require time
const MAX_FILE_BYTES;       // 25 * 1024 * 1024
const TYPES;                // ext -> {mime, inline, check(buffer) -> bool}

// Express middleware: multer 2 single-file upload of field `field` into FILES_DIR as
// '<uuid>.part'. Errors become 400 ({error:'That file is too big (25 MB at most)'} for
// LIMIT_FILE_SIZE, 400 otherwise) through sendError. A request with no file gets
// req.file = undefined (the route answers 400).
function single(field);

// Checks req.file: the original name's extension (lowercased) must be in TYPES and the
// first 8 KB must pass that type's check. On success renames '<uuid>.part' to
// '<uuid>.<ext>' and returns {storedName, originalName, mime, size, sha256}. On failure
// deletes the .part file and throws bad("That file type isn't allowed"). Async (fs).
async function accept(file);

// Inserts the files row for an accepted file. Synchronous; safe inside a transaction.
// Returns the new id.
function insert(db, accepted, userId);

// Deletes an accepted file from disk (use when the caller's transaction fails). Never throws.
function discard(accepted);

// Soft-removes a file row (removed_at, removed_by). The file stays on disk.
function remove(db, fileId, userId);

// {id, name, size, mime, uploadedAt, uploadedBy:{id,name}, url:'/api/files/<id>'}
function toFile(row);       // row from files LEFT JOIN users (uploaded_by_name)

// Streams the file with the §8 headers. 404 if the file is missing on disk.
function send(res, fileRow);
```

**`TYPES`** (the whole allowlist; nothing else is accepted):

| ext | mime | inline | check (first bytes) |
|---|---|---|---|
| `pdf` | `application/pdf` | yes | starts `%PDF-` |
| `png` | `image/png` | yes | `89 50 4E 47 0D 0A 1A 0A` |
| `jpg`, `jpeg` | `image/jpeg` | yes | `FF D8 FF` (stored as `.jpg`) |
| `xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | no | `50 4B 03 04` (zip) |
| `docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | no | `50 4B 03 04` (zip) |
| `xls` | `application/vnd.ms-excel` | no | `D0 CF 11 E0 A1 B1 1A E1` |
| `csv` | `text/csv` | no | no NUL byte in the first 8 KB, and not starting with `<` after optional BOM and whitespace |

The client's declared mimetype is ignored. The stored extension and the served `Content-Type` come only from this table.

### `lib/notify.js` (scaffold edit)

Add one function; nothing else changes:

```js
// One notification to each user id in `userIds` (duplicates and opts.exceptUserId skipped).
// With opts.dedupeUnread: skip a user who already has an UNREAD row with the same kind,
// entity_type and entity_id. Returns how many were written. Synchronous.
function toUsers(db, userIds, payload, opts = {});
```

### `lib/settings.js` (scaffold edit)

Add `"tasks.reminder_last_run": null` to `DEFAULTS`. Nothing else.

### `lib/people.js` (scaffold, new, complete)

```js
// Enabled users holding featureKey, as [{id, displayName}] sorted by displayName.
function withKey(db, featureKey);
// The display name for a user id, or 'Unknown' (for joins that miss).
function nameOf(db, userId);
```

### `lib/tasks.js` (scaffold: `countsFor` complete; the rest Wave 1 A)

```js
// For the menu bar count: {open, overdue} = the user's assigned open tasks, and those
// with due_date < today. Complete in the scaffold.
function countsFor(db, userId, today);

// Wave 1 A (signatures binding; internals A's):
function list(db, user, {view, jobId, limit});        // view: 'mine'|'raised'|'open'|'done'|'job'
function get(db, user, id);                           // task object (§4) or throws notFound
function create(db, req, body);                       // returns task object
function update(db, req, id, body);                   // stale check, returns task object
function setStatus(db, req, id, action);              // action: 'done'|'reopen'|'cancel'
function attach(db, req, id, accepted);               // links an accepted file
function detach(db, req, id, fileId);
function runReminder(db, {now, force});               // returns {sent, date}
function startReminder(db);                           // the timer (§4 reminder)
```

### `lib/comments.js` (Wave 1 A, new)

```js
function list(db, user, entityType, entityId);        // {rows, following}
function add(db, req, entityType, entityId, body);    // comment object; notifies followers
function remove(db, req, id);
function follow(db, userId, entityType, entityId);    // idempotent
function unfollow(db, userId, entityType, entityId);  // idempotent
```

### `lib/messages.js` (scaffold: `unreadTotal` and `channelsFor` complete; the rest Wave 1 B)

```js
// Channels the user can see: messages.use, and role NULL, or the user holds the role,
// or the user holds 'admin'. Not archived. Ordered by position. Complete in the scaffold.
function channelsFor(db, user);
// Sum of unread messages over channelsFor(user) (messages by others with id > last_read_id,
// not removed). 0 without messages.use. Complete in the scaffold.
function unreadTotal(db, user);

// Wave 1 B:
function listChannels(db, user);                      // [{id, slug, name, unread, lastMessageAt}]
function listMessages(db, user, channelId, {after, before, limit});
function post(db, req, channelId, body);
function markRead(db, user, channelId, lastId);
function remove(db, req, id);
```

### `lib/reports.js` (Wave 1 C, new)

```js
function list(db, user, {year, category});
function create(db, req, fields, accepted);           // inside one transaction with files.insert
function update(db, req, id, fields);
function remove(db, req, id);                         // also files.remove on its file
```

## 3. Hooks into existing code (who owns each edit)

- **`server.js` (scaffold):** the `/photos` narrowing (§8); the four new routers (§7); `require('./lib/tasks').startReminder(db)` after the round-up start.
- **`routes/notifications.js` (scaffold):**
  - `GET /unread-count` returns `{unread, tasks, tasksOverdue, messages}`. `tasks` and `tasksOverdue` come from `tasks.countsFor` (0 without `tasks.use`), `messages` from `messages.unreadTotal`. `unread` is unchanged, so old clients keep working.
  - `GET /` gains `before` (a notification id): rows with `id < before`, same order and limit. The response is unchanged apart from a `more` boolean (true when more rows exist after this page).
  - `POST /api/notifications/tasks-reminder/run` is **not** here: it's `POST /api/tasks/reminder/run` (§4).
- **`routes/photos.js`:** not edited (the multer 2 API is unchanged). The scaffold proves photo upload still works locally.
- **`lib/pages.js` (scaffold):** `/tasks.html: 'tasks.use'`, `/messages.html: 'messages.use'`, `/reports.html: 'accounts.view'`.
- **`package.json` and `package-lock.json` (scaffold):** `"multer": "^2.4.0"`; the lockfile updated with `npm install multer@^2.4.0 --package-lock-only --ignore-scripts` in `crosscuts/app/`. The root version stays 0.1.4. `allowScripts` is unchanged (multer has no install script).

## 4. API surface

Errors are `{error}`. Validation → 400, forbidden → 403, not found (including "exists but you can't see it") → 404, stale or rule break → 409. Every route is a `defineRoutes` route with the access shown; the finer checks are in the handler.

### People (`routes/people.js`, `defineRoutes('/api/people')`, scaffold, complete)

- `GET /api/people` — `['tasks.use','messages.use']` → `{rows: [{id, displayName}]}` = `people.withKey(db,'tasks.use')`. No username, roles or anything else.

### Tasks (`routes/tasks.js`, `defineRoutes('/api/tasks')`, Wave 1 A)

All `tasks.use`. Every user with `tasks.use` sees every task (decision 1).

**Task object:**
```
{id, title, notes, status, dueDate, overdue,          // overdue: open and dueDate < today
 assignee: {id, name}, createdBy: {id, name},
 job: {id, name} | null,
 doneAt, doneBy: {id, name} | null,
 createdAt, updatedAt,
 files: [file],                                       // not removed; lib/files toFile
 commentCount, following,                             // comments not removed; caller follows?
 canEdit}                                             // creator, assignee or admin
```

- `GET /api/tasks?view=mine|raised|open|done|job&jobId=N&limit=N`
  - `mine` (default): assigned to me, `open`, ordered overdue first, then due date (nulls last), then id.
  - `raised`: created by me, `open`, same order.
  - `open`: all open, same order.
  - `done`: `done` or `cancelled`, newest `updated_at` first, `limit` default 50, max 200.
  - `job`: all statuses for `jobId` (400 without it), open first then newest.
  - → `{rows: [task]}`.
- `GET /api/tasks/:id` → task.
- `POST /api/tasks` `{title, assigneeId, notes?, dueDate?, jobId?}` → 201 task.
  - `assigneeId` must be an enabled user holding `tasks.use` (else 400). `jobId` must exist (else 400). `dueDate` a valid date or null.
  - The creator and the assignee follow the task.
  - Notifies the assignee (`task.assigned`) unless they are the creator.
- `PATCH /api/tasks/:id` `{updatedAt, title?, notes?, assigneeId?, dueDate?, jobId?}`
  - Only `canEdit` users (else 403). Only `open` tasks (else 409 "This task is closed").
  - `updatedAt` is required and must equal the stored value, else 409 `{error:'Someone else changed this task. Reload to see it.', task}`.
  - A new assignee follows the task and gets `task.assigned` (unless they made the change).
  - → task.
- `POST /api/tasks/:id/done` → anyone with `tasks.use`; only from `open` (else 409). Sets `done_at`, `done_by`. Notifies the creator (`task.done`) unless they did it. → task.
- `POST /api/tasks/:id/reopen` → anyone with `tasks.use`; only from `done` (else 409). Clears `done_at`/`done_by`. Notifies the assignee (`task.reopened`) unless they did it. → task.
- `POST /api/tasks/:id/cancel` → the creator or admin (else 403); only from `open` (else 409). → task.
- `POST /api/tasks/:id/files` → multipart field `file` via `files.single('file')`; `canEdit` users; the task must be `open`. `files.accept`, then `files.insert` + the link in one transaction (`files.discard` on failure). → 201 task.
- `DELETE /api/tasks/:id/files/:fileId` → the uploader, the creator or admin; soft (`files.remove`). → task.
- `POST /api/tasks/reminder/run` — `users.admin` → `runReminder(db, {force:true})` → `{sent, date}`.

**The morning reminder** (decision 4, Todd: **7:00**, not 7:30):
- `startReminder(db)` follows `lib/roundup.js`: a 60 s `setInterval`, `unref()`, off with `REMINDER_DISABLED=1`.
- It runs when Sydney `weekday` is 1–5, the Sydney time is 07:00 or later, and `tasks.reminder_last_run` ≠ today's Sydney date. It then sets the setting to today (`{audit:false}`).
- First start: if the setting is null, seed it to today, so an install or upgrade sends nothing that day.
- For each enabled user with `tasks.use` and at least one `open` task assigned to them with `due_date <= today`: one `task.reminder` notification. Title `"N task(s) due today or overdue"`; body: up to 5 titles, oldest due first, as `"<title> (due <d Mon>)"` joined with `; `, plus `" and N more"`; link `/tasks.html?view=mine`. No dedupe needed (once a day).
- `force` (the admin route) runs regardless of time and the setting, and doesn't update the setting.

### Comments (`routes/comments.js`, `defineRoutes('/api/comments')`, Wave 1 A)

Access value `['tasks.use','jobs.view']`; the handler then checks the entity:
- `task`: needs `tasks.use`, and the task must exist.
- `job`: reading needs `jobs.view`; writing needs `jobs.view` **and** `messages.use`. The job must exist.

**Comment object:** `{id, entityType, entityId, author: {id, name}, body, removed, createdAt, canRemove}`. A removed comment has `body: null` and `removed: true`. `canRemove` = the author or admin, and not removed.

- `GET /api/comments?entityType=task|job&entityId=N` → `{rows: [comment] (oldest first, all of them), following}`.
- `POST /api/comments` `{entityType, entityId, body}` → 201 comment.
  - The author follows the entity.
  - Notifies every other follower with `notify.toUsers(..., {exceptUserId: author, dedupeUnread: true})`, kind `comment.new`, entity `task`/`job` + id, title `"<author> commented on <task title | job name>"`, body: the first 140 characters of the comment, link `/tasks.html?task=N` or `/job.html?id=N#comments`.
  - For a job comment, a follower who no longer holds `jobs.view` is skipped; for a task comment, one who no longer holds `tasks.use`.
- `DELETE /api/comments/:id` → `canRemove` users (else 403); 409 if already removed. → 204.
- `POST /api/comments/follow` and `POST /api/comments/unfollow` `{entityType, entityId}` → same read check as GET → 204.

### Messages (`routes/messages.js`, `defineRoutes('/api/messages')`, Wave 1 B)

All `messages.use`. A channel outside `channelsFor(user)` is 404.

**Message object:** `{id, channelId, author: {id, name}, body, removed, createdAt, canRemove}` (as comments).

- `GET /api/messages/channels` → `{rows: [{id, slug, name, unread, lastMessageAt}]}` in `position` order.
- `GET /api/messages/channels/:id?after=ID|before=ID&limit=N` → `{rows, lastReadId, more}`.
  - No cursor: the newest `limit` (default 50, max 200), returned oldest first.
  - `after`: messages with `id > after`, oldest first, up to `limit` (the 5 s poll).
  - `before`: the `limit` messages before it, oldest first; `more` says whether older ones exist.
  - Removed messages are included (as removed).
- `POST /api/messages/channels/:id` `{body}` → 201 message. It also moves the author's read marker to the new id.
- `POST /api/messages/channels/:id/read` `{lastId}` → 204. The marker only moves forward (`MAX`), and never beyond the channel's newest id.
- `DELETE /api/messages/:id` → the author or admin (else 403); 409 if already removed. → 204.

Messages never create notifications.

### Reports (`routes/reports.js`, `defineRoutes('/api/reports')`, Wave 1 C)

**Report object:** `{id, period, category, title, notes, file: file, uploadedBy: {id, name}, createdAt, updatedAt, canEdit}`. `canEdit` = the uploader or admin.

- `GET /api/reports?year=YYYY&category=…` — `accounts.view` → `{rows: [report], years: [YYYY…]}`. Not removed; newest period first, then category, then title. `years` lists every year that has a report (for the filter).
- `POST /api/reports` — `reports.upload` — multipart: `file`, `period` (`YYYY-MM`, not after the current Sydney month), `category` (one of the five), `title`, `notes?`. `files.accept`, then `files.insert` + the report in one transaction. → 201 report.
- `PATCH /api/reports/:id` `{period?, category?, title?, notes?}` — `reports.upload`; `canEdit` (else 403). → report.
- `DELETE /api/reports/:id` — `reports.upload`; `canEdit` (else 403). Soft-removes the report and its file. → 204.

Categories show as: Bank reconciliation, BAS, Payroll, Aged debtors, Other.

### Files (`routes/files.js`, `defineRoutes('/api/files')`, scaffold, complete)

- `GET /api/files/:id` — `login`; then:
  - a file linked to a live report → needs `accounts.view`;
  - a file linked to a task → needs `tasks.use`;
  - removed, unlinked, or the report removed → 404 (for admin too);
  - no permission → 404 (not 403: don't confirm the file exists).
  - Sends with `files.send` (§8).

## 5. Audit actions (additions)

- `task.create`, `task.update` (changed fields only), `task.done`, `task.reopen`, `task.cancel`, `task.attach`, `task.detach` (entity `task`).
- `comment.remove` (entity `comment`; before `{body}`). Adding a comment is not audited (it is its own record).
- `message.remove` (entity `message`; before `{body}`). Posting is not audited.
- `report.create`, `report.update`, `report.remove` (entity `report`).

Follows, read markers, file downloads and the reminder are not audited. The actor is `req.user`.

## 6. Pages and front end

All new or changed pages:
- pass `node ci/style-check.js`;
- use `tokens.css` (which imports `components.css`) and the shell's `cc-dialog`;
- have no icons, no emoji, no shadows, and Arial 400/700 with letterspaced uppercase;
- build every piece of user text with `textContent` (never `innerHTML`). Links in comments and messages: split the text on `https?://\S+`, and make only those parts `<a href target="_blank" rel="noopener noreferrer">`; everything else is text nodes; line breaks become `<br>` elements.

Page prefixes: `tk-` tasks, `cm-` comments, `ms-` messages, `rp-` reports, `jo-` job-page sections, `ix-` home tiles. **Never `ph-`.**

### Shell (`public/shell/shell.js`, `shell.css`; scaffold, complete)

- **Right side order:** `Tasks n`, `Messages n`, `Alerts n`, then the user menu.
  - `Tasks` is a link to `/tasks.html` (needs `tasks.use`); its badge shows `tasks` (open, assigned to me), with a new `cc-badge-attend` style in `shell.css` (orange, `--cc-` tokens) when `tasksOverdue > 0`.
  - `Messages` is a link to `/messages.html` (needs `messages.use`); its badge shows `messages`.
  - Both use the existing poll (`pollCount`, 60 s and on focus): it now reads all four fields. A zero hides the badge.
- `window.cc.refreshCounts()` re-polls now (pages call it after marking messages read or closing a task).
- **Bell paging:** the panel shows a "Show older" button when the response has `more`; it loads `?before=<last id>` and appends.
- Re-measure the menu bar at 1100, 1280, 1366, 1440 and 1600 px and adjust the `shell.css` breakpoints so nothing overlaps (report the widths in the scaffold commit).
  - **As built (scaffold, 2026-10-11), measured with the full admin link set:** below 1680 px the right-hand buttons tighten (8 px side padding, 0.04em) and the "Crosscuts" wordmark is hidden; the links collapse into the Menu below **1366** px (was 1280). At 640 px and below, Tasks and Messages leave the bar and head the Menu panel as a "Tasks and messages" group with the same counts. No overflow at 1920, 1680, 1600, 1440, 1366, 1365, 1280, 1100, 800 or 375 px.
- No `LINK_GROUPS` change.

### `/tasks.html` (Wave 1 A: `public/tasks.{html,css,js}`, and the shared `public/taskui.js` and `public/comments.js`)

- View buttons: Mine (default), Raised by me, All open, Done. `?view=` selects one; `?task=N` opens that task's dialog on load (with `#comments` scrolling to the thread).
- A table: title, assignee, due date (overdue in red text, `hs-badge-stop`), job (link to `/job.html?id=N`), created by. Clicking a row opens the task dialog.
- **New task** button → the task dialog in create mode.
- **`public/taskui.js`** (A; D reuses it): `window.ccTasks = { openTask(id, {onChange}), newTask({jobId, jobName, onChange}) }`. The dialog shows the fields (editable when `canEdit` and open), Done / Reopen / Cancel task, files (upload, list with links to `/api/files/:id`, remove), and the comment thread via `ccComments`. A 409 shows the server's message and reloads the task.
- **`public/comments.js`** (A; D reuses it): `window.ccComments = { mount(container, entityType, entityId, {canWrite}) }`. It renders the thread (oldest first, author, time via `cc.timeAgo`, "Removed" for removed ones, a Remove button when `canRemove`), a textarea and a Post button, and a Follow / Stop following button.

### `/messages.html` (Wave 1 B: `public/messages.{html,css,js}`)

- Channel list on the left (name, unread count), the thread on the right, the box at the bottom. Enter sends; Shift+Enter is a new line. At phone width the channel list becomes a select above the thread.
- Poll `?after=<newest id>` every 5 s while `document.visibilityState === 'visible'`; refresh the channel list (counts) every 30 s. On showing new messages in the open channel, `POST …/read` and `cc.refreshCounts()`.
- "Load older" at the top uses `before`. Removed messages show as "Removed". `?channel=<slug>` opens that channel.

### `/reports.html` (Wave 1 C: `public/reports.{html,css,js}`)

- Filters: year (from `years`), category. Months newest first, each a `hs-sectionbar` ("September 2026") with a table: category, title (a link to `/api/files/:id`, opening in a new tab), uploaded by, date, size, and Edit / Remove for `canEdit`.
- **Upload report** button (only with `reports.upload`) → a dialog: month (`<input type="month">`, default the previous Sydney month), category, title (defaults to the category name plus the month), notes, file. Client-side pre-check of the extension and 25 MB, the server being the real check.

### `/job.html` (Wave 2 D: `public/job.{html,js}`, `public/jobs.css` additions for `jo-` only)

- After Photos, before Invoices: a **Tasks** section (needs `tasks.use`): the job's tasks (`view=job`), open first; "New task" via `ccTasks.newTask({jobId, jobName})`; a row opens `ccTasks.openTask`.
- Then a **Comments** section `id="comments"` (needs `jobs.view`), mounted with `ccComments.mount(el, 'job', id, {canWrite: cc.can('messages.use')})`. `#comments` from the bell scrolls to it (the existing `jumpToHash`).

### Home page (Wave 2 D: `public/index.{html,js}`, `public/index.css` additions for `ix-` only)

- Replace the "Coming later" placeholder with **My tasks** (needs `tasks.use`: up to 8 from `view=mine`, overdue in red, each opening `/tasks.html?task=N`, with "All my tasks") and **Messages** (needs `messages.use`: each channel with an unread count, linking to `/messages.html?channel=<slug>`).

### Accounts (Wave 2 D: `public/accounts.html` only)

- Two links in the page header: "Tasks" (`/tasks.html`, shown with `tasks.use`) and "Report library" (`/reports.html`).

## 7. Server composition (scaffold; the integrator owns `server.js`)

- Append `require('./routes/people')`, `require('./routes/files')`, `require('./routes/tasks')`, `require('./routes/comments')`, `require('./routes/messages')` and `require('./routes/reports')` to `routers`, after `./routes/scheduling`.
- The scaffold creates `tasks`, `comments`, `messages` and `reports` as empty guarded routers with their final prefixes; `people` and `files` complete.
- **Route order inside `routes/tasks.js`:** `POST /reminder/run` is registered before `/:id` routes.

## 8. Files on disk and the `/photos` narrowing (scaffold)

- **Storage:** `FILES_DIR = <UPLOADS_DIR>/files`. Created at require time with `mkdirSync({recursive:true})`. It's inside the uploads volume, so the compose file, the cutover copy and the future backup need no change.
- **`/photos` narrowing** in `server.js`, before the static handler: only a request whose path (relative to `/photos`) matches `^/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp|gif)$` (case-insensitive) reaches `express.static`. Anything else is 404 `Not found` as plain text. The static handler also gets `index: false`, `redirect: false`, `dotfiles: 'ignore'`. Existing photo URLs (`<uuid>.jpg`, `<uuid>-thumb.webp`) are unaffected; so are the old app's, which use the same naming.
- **`files.send` headers:**
  - always: `Content-Type` from `TYPES`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`;
  - inline types (pdf, png, jpg): `Content-Disposition: inline; filename*=UTF-8''<encoded original name>`. Images also get `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`. PDF gets no CSP (Chrome's built-in viewer fails under `sandbox`); its type is fixed and checked;
  - everything else: `Content-Disposition: attachment; filename*=UTF-8''<encoded original name>` and `Content-Security-Policy: sandbox`.
  - Uses `res.sendFile(path, {dotfiles:'deny'})` with the stored name only (never a client value).

## 9. Tests

### Smoke files

`ci/smoke.sh` (scaffold) gains, right after the M3 loop at `smoke.sh:1102`:

```bash
# M4 suites (ci/smoke-m4-*.sh): same rules; they must not assume a pristine DB.
for f in "$(dirname "$0")"/smoke-m4-*.sh; do [ -f "$f" ] && source "$f"; done
```

Same rules as M3: shared helpers and jars (`$ADMIN $SCHED $ACCT $DPM $SHOW`), `step "m4-…"` first, no shebang and no `set`, prefixed variables (`M4A_`…), no pristine-DB assumption. Step b's logged-out sweep gives every new route its 401.

**The scaffold adds to `smoke.sh` itself** (in the M1 photo step, after the existing upload): `GET /photos/files/` and `GET /photos/<uploaded name>/` → 404; `GET /photos/<uploaded name>` → 200 as before; `GET /api/people` as sched → 200 with only `id` and `displayName` keys, as show → 403; `GET /api/notifications/unread-count` as sched has the four number fields.

**`ci/smoke-m4-tasks.sh`** (Wave 1 A), `step "m4-a. tasks, comments and the reminder"`:
- **Access:** show → 403 on `GET /api/tasks`, `POST /api/tasks`, `GET /api/comments?entityType=job&entityId=1`; `/tasks.html` dpm 200, show 403.
- **Create and alerts:** acct creates a task for admin with a job and `dueDate` yesterday → 201; admin's unread notifications include one `task.assigned` with link `/tasks.html?task=N`; acct has none for it. Admin's unread-count has `tasks >= 1` and `tasksOverdue >= 1`.
- **Visibility:** sched (`view=open`) sees the task (decision 1).
- **Edit rules:** sched (not creator or assignee) `PATCH` → 403. Admin `PATCH` with the right `updatedAt` → 200; acct `PATCH` with the old `updatedAt` → 409 with `.task.id`.
- **Status:** admin done → 200 and acct gets `task.done`; done again → 409; sched reopen → 200 and admin gets `task.reopened`; sched cancel → 403; acct cancel → 200; `PATCH` on the cancelled task → 409.
- **Comments:** on a new task (acct → dpm): dpm comments → acct gets one `comment.new`, dpm gets none; dpm comments again while acct's is unread → acct still has exactly one unread for it (dedupe); acct unfollows, dpm comments → no new row for acct. Job comment: sched (`messages.use`) posts on a job → 201; show → 403. Remove: acct removes dpm's comment → 403; dpm removes it → 204, then GET shows `removed: true` and `body: null`; again → 409.
- **Attachments:** acct uploads `$WORK/test.pdf` (a minimal `%PDF-1.4` file the script writes) to the task → 201 with one file; `GET /api/files/:id` as sched → 200, `Content-Type: application/pdf`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`; as show → 404. An `.html` file and an `.svg` file → 400. A `.pdf` name whose bytes are PNG → 400. No `.part` files left in `/data/uploads/files` after the refusals (`docker exec … ls`).
- **Reminder:** `POST /api/tasks/reminder/run` as admin → 200 with `sent >= 1`, and admin has a `task.reminder` row whose link is `/tasks.html?view=mine`; as acct → 403.

**`ci/smoke-m4-messages.sh`** (Wave 1 B), `step "m4-b. messages"`:
- **Access:** show → 403 on `GET /api/messages/channels`; `/messages.html` sched 200, show 403.
- **Channels:** acct sees `all` and `accounts` only; sched sees `all` and `scheduling`; admin sees all four. acct posting to the scheduling channel's id → 404.
- **Unread:** acct posts in All; sched's channel list shows All `unread >= 1` and unread-count `messages >= 1`; acct's own count for All is 0. sched `POST …/read` with that id → sched's All `unread == 0`; a `lastId` lower than before doesn't move it back (post a second message, mark read with the first id: unread stays 1).
- **Polling:** `?after=<id>` returns only the newer message.
- **Removal:** sched removes acct's message → 403; acct removes it → 204; it comes back as `removed: true`, `body: null`. Messages create no notifications (acct's notification count is unchanged after posting).
- **Limits:** an empty body → 400; 4,001 characters → 400.

**`ci/smoke-m4-reports.sh`** (Wave 1 C), `step "m4-c. report library and files"`:
- **Access:** sched and dpm → 403 on `GET /api/reports`; show → 403; `/reports.html` acct 200, sched 403. dpm `POST` → 403.
- **Upload:** acct uploads a PDF (period last month, `bas`) → 201; also an `.xlsx` (a zip signature) → 201, and a `.csv` → 201. An `.svg`, an `.html`, a `.exe` (`MZ` bytes) → 400. A future `period` → 400. The list for the year has the three, newest period first.
- **Download:** admin `GET /api/files/:id` for the PDF → 200, `inline`; for the xlsx → `attachment` and `Content-Security-Policy: sandbox`. sched → 404 for both.
- **The `/photos` hole:** read the PDF's stored name (`db_value`) and `GET /photos/files/<stored name>` as admin → 404.
- **Edit and remove:** a second accounts user (create one) `PATCH`es acct's report → 403; acct → 200; admin removes it → 204; it is gone from the list and its file is 404.
- **Photos still upload under multer 2:** covered by the M1 and M3 photo steps, which must still pass.

### Local checks

Docker isn't on the dev box, so smoke files get `bash -n` only. Every task:
- boots the shim on a fresh `.dev/<task>/` data directory (`REMINDER_DISABLED=1 ROUNDUP_DISABLED=1`) and runs `curl` against the routes it owns, including the access rules;
- runs `node ci/style-check.js` if it touches `public/`;
- takes headless-Edge screenshots (`tools/screenshots/`) of the pages it changes. The scaffold adds `tasks`, `messages` and `reports` to `shoot.js`. Seed data for screenshots is made through the API in the task's own run, not by editing `seed.js` (the integrator extends `seed.js` at 4.1).

Report what was run. In addition:
- **Scaffold:** a photo upload and thumbnail through the shim under multer 2; the `/photos` narrowing (a top-level photo 200, `/photos/files/x` 404, a directory 404); the menu bar widths.
- **A:** two browser tabs editing the same task (the 409), and the reminder by `force` plus a unit check of the time rule (`weekday`, 07:00, the seeded first start) with fixed `now` values.
- **B:** two logged-in browsers chatting, unread counts in the menu bar, the 5 s poll pausing in a hidden tab.
- **C:** a PDF opening inline in Edge from `/reports.html`; an xlsx downloading with its original name.

## 10. Waves and file ownership

| Step | Who | Owns (only these files) |
|---|---|---|
| **M4 · 2.2 Scaffold** | integrator | `db/migrations/012_collaboration.sql`, `lib/files.js`, `lib/people.js`, `lib/notify.js` (`toUsers`), `lib/settings.js` (one key), `lib/tasks.js` (`countsFor` complete, the rest stubs throwing `HttpError(501,'Not built')`), `lib/messages.js` (`channelsFor`, `unreadTotal` complete, the rest stubs), `routes/people.js`, `routes/files.js`, `routes/{tasks,comments,messages,reports}.js` (empty guarded routers), `routes/notifications.js`, `server.js`, `lib/pages.js`, `public/shell/shell.{js,css}`, `package.json`, `package-lock.json`, `ci/smoke.sh`, `tools/screenshots/shoot.js` (three entries), `docs/auth.md` |
| **M4 · 3.1 Wave 1, A: tasks and comments** | worktree | `lib/tasks.js` (all but `countsFor`), `lib/comments.js`, `routes/tasks.js`, `routes/comments.js`, `public/tasks.{html,css,js}`, `public/taskui.js`, `public/comments.js`, `ci/smoke-m4-tasks.sh` |
| **M4 · 3.1 Wave 1, B: messages** | worktree | `lib/messages.js` (all but `channelsFor` and `unreadTotal`), `routes/messages.js`, `public/messages.{html,css,js}`, `ci/smoke-m4-messages.sh` |
| **M4 · 3.1 Wave 1, C: report library** | worktree | `lib/reports.js`, `routes/reports.js`, `public/reports.{html,css,js}`, `ci/smoke-m4-reports.sh` |
| **M4 · 3.2 Wave 2, D: pages** | worktree | `public/job.{html,js}`, `public/jobs.css` (`jo-` additions), `public/index.{html,js}`, `public/index.css` (`ix-` additions), `public/accounts.html` |
| **M4 · 4.1 Integrate** | integrator | merges; `tools/screenshots/seed.js`; STATUS; `docs/auth.md` if anything moved |

How the shared files are split:
- **`lib/tasks.js`, `lib/messages.js`:** the scaffold's complete functions (used by the unread count) are frozen; the waves fill in the stubs and must not change those functions' signatures or results.
- **`lib/files.js`, `lib/notify.js`, `lib/people.js`, `server.js`, `lib/pages.js`, `shell.*`, `ci/smoke.sh`, `routes/notifications.js`, `routes/files.js`:** scaffold only. A wave that needs a change reports it.
- **`public/taskui.js`, `public/comments.js`:** A writes them; D only calls them. D reports any change it needs.
- **`public/job.js`:** D only.

Wave 2 starts only after Wave 1 is merged on `main`, so D codes against real APIs. No task edits files outside its row, the board files or `shared.js`. **Worktree base:** agent worktrees have been created at an old commit. Each agent runs `git log -1` first and resets to the scaffold commit the integrator names, and junctions `crosscuts/app/node_modules` from the main checkout.

## 11. Feature keys, docs, and points settled by the integrator (2026-10-11)

9. **Scaffold findings (M4 · 2.2):** `FILES_DIR` is resolved to an absolute path, and `files.send` uses `sendFile(name, {root: FILES_DIR})` (with an absolute path, the dotfiles rule rejected the dev folder `.dev`). `accept()` awaits the removal of a refused `.part` file before it throws, so the smoke check for leftovers can't race it. The notifications list now orders by `id DESC` (same order as before, exact for paging).

1. **Keys:** none added (21 stays). `docs/auth.md` drops the † from `tasks.use`, `messages.use` and `reports.upload`, and notes that `accounts.view` opens the report library.
2. **Reports are viewed with `accounts.view`**, not a new key (decision 3: Todd and all accounts staff).
3. **A task's job name is shown to every `tasks.use` holder.** All four roles holding `tasks.use` also hold `jobs.view`; a per-user override that removes `jobs.view` but keeps `tasks.use` sees the job's name on a task, which is accepted.
4. **"Involved" = follows.** Created, assigned, or commented → following. Nothing else follows automatically (no "everyone who can see the job").
5. **Channel membership is by role, not overrides.** A user without the role but with an override can't see a department channel; admin sees all.
6. **Files live under the uploads volume** (`uploads/files/`), not a new mount, and `/photos` is narrowed to top-level image files. Files uploaded during testing are dropped at cutover with the rest of the pre-cutover uploads (as `docs/cutover.md` step 3 already does); the integrator adds one line saying so to the runbook at 4.1.
7. **multer 2.4.0** (released 2026-09-14). The API is unchanged for our use; the photo smoke steps are the regression check.
8. **The reminder time is 7:00 Sydney on weekdays** (Todd, decision 4).

## 12. Changes after the M4 · 4.2 review (integrator, 2026-10-11)

1. **File size limit:** a file of exactly 25 MB is accepted; only a larger one is refused (multer gives busboy the limit + 1). `smoke-m4-reports.sh` now uploads 25 MB + 1 byte for the "too big" case.
2. **`files.single`:** an error that isn't a `MulterError` (a full disk, a permissions problem) is logged and answered 500 `Server error`, not 400. Multer's own errors stay 400. This replaces "400 otherwise" in §2.
3. **`files.accept`:** hashes the `.part` file before renaming it, so a failure at either step leaves only the `.part` to remove (no orphan stored file).
4. **Task attachment refusals** (403/409 after multer wrote the file) await the `.part` removal before replying, as §11.9 promised.
5. **`Content-Disposition` `filename*`** also percent-encodes `' ( ) *` (RFC 5987).
6. **`ccComments.mount`** takes `heading: false` (the job page passes it), so the job page shows one "Comments" heading; the Follow button stays on the right.
