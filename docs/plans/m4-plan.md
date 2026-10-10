# Crosscuts — Milestone 4 plan: Collaboration (2026-10-11)

Status: **draft, awaiting Todd's answers** (M4 · 1.1 audit and 1.2 plan done; questions in §13). Steps: M4 · 1.1 (audit, §1), M4 · 1.2 (plan and questions), M4 · 1.3 (decisions).

Source of truth: `crosscuts-brief.md` §4 (home screen tiles), §5.1.5 (task queue), §5.1.6 (report library), §5.2.6 (tasks and comments on the job), §6.1 (bell, messaging), §8 (tables); roadmap M4 row; M2 decisions 1 and 6 (no phone push yet; report library and attachments moved to M4).

## 1. Audit findings (M4 · 1.1)

Three read-only surveys of the code, 2026-10-11: notifications/access, file uploads, pages/tests.

**What already exists:**
- **Feature keys are already defined:** `tasks.use` and `messages.use` (admin, accounts, design_pm, scheduling; not showroom) and `reports.upload` (admin, accounts) in `lib/permissions.js`. Nothing uses them yet, and `docs/auth.md` still marks them †. There is no key to *view* reports; `accounts.view` (admin, accounts) is the natural one.
- **The bell** (M2): a `notifications` table with `kind`, `title`, `body`, `link`, `entity_type`, `entity_id`, `read_at` (006). `notify.toUser` / `notify.toKey` are synchronous and safe inside a transaction. The shell polls `/api/notifications/unread-count` every 60 s and on focus, and the panel lists the latest 30. Links are site-relative only (`safeLink`, private to `shell.js`). Kinds in use: `invoice.due`, `invoice.roundup`, `inspection.*`, `materials.in`.
- **A timer pattern:** `lib/roundup.js` (60 s check, idempotent through a settings row, seeded on first start, `ROUNDUP_DISABLED=1` in tests).
- **The dashboard** (`index.html`) has a "Notifications" section (latest 5) and a "Coming later" placeholder for "My tasks". There is no messages tile.
- **The job page** sections (Orders, Inspection, Photos, Invoices) follow one pattern: a `jo-sec` section shown by key after `cc.ready`, a loader, a render with `replaceChildren`, and hash links (`#orders`) that the bell uses. Tasks and Comments slot in after Photos.
- **Audit:** `audit.log(req, {action, entityType, entityId, before, after})`, changed columns only.
- **Uploads:** multer, a 25 MB limit, a jpeg/png/webp allowlist and every file decoded by sharp; UUID file names, never the client's name; hard delete.
- **Tests:** smoke step b sweeps every `/api` route logged out (new routes get their 401 check for free). Per-milestone smoke files are sourced by glob (`smoke-m2-*`, `smoke-m3-*`); role jars `$ADMIN $SCHED $ACCT $DPM $SHOW`.

**What doesn't exist:**
- No tables, routes or pages for tasks, comments, chat or reports.
- No endpoint an ordinary user can call to list other people (for an assignee picker or author names). `/api/users` is admin-only and returns roles, permissions and sessions, so it mustn't be reused.
- No idea of "involved in" (who should hear about a new comment), no unread counts for chat, no notification paging or retention.
- No file download route anywhere (no `Content-Disposition`, no `sendFile`), and no security headers (no `nosniff`, no CSP).
- No shared escaping helper. Pages build the DOM with `textContent` through per-page `el()` helpers (good), and two old spots use `innerHTML` with error text.

**Traps found:**
1. **Uploaded files are open to every logged-in user.** `server.js` serves the whole uploads folder at `/photos/*` behind `requireLogin` only, with no key check and a 30-day cache. A report saved there could be opened by the showroom account. `assertAllRoutesGuarded` only checks `/api`, so it wouldn't catch this. Reports and attachments need a private folder and a download route that checks permission.
2. **Uploaded HTML or SVG would run as the app.** With no headers set, a file served inline with a client-chosen type is stored XSS. Attachments get no sharp-style decode check, so they need a type allowlist checked by the file's first bytes, an extension taken from that allowlist, `nosniff`, and download (not inline) for anything but PDF and images.
3. **multer 1.4.5 is deprecated** with known denial-of-service fixes only in 2.x. Widening uploads to accounts staff is the time to move to 2.x (the photo smoke tests cover the change).
4. **Uploads aren't backed up**, and the cutover moves the pre-cutover uploads folder aside. Files uploaded during testing are dropped at cutover, as the database is (consistent; say so in the runbook). The later Backup milestone must cover any new folder.
5. **The actor gets notified unless the caller says otherwise** (`exceptUserId`). Comment and task notifications must skip the person who acted.
6. **Chat must not go through the bell.** The bell shows 30 items with no paging; one notification per chat message would bury the invoice prompts. Chat needs its own read markers and unread count.
7. **The menu bar is full.** It was measured to fit at 1100–1600 px in M3; three more links would break it. New entries need another home (beside Alerts, or inside existing pages).
8. **Unlisted pages default to "any logged-in user"** (`lib/pages.js`). Every new page must be listed, and smoke must check the showroom account gets 403.
9. **User text is new territory.** Comments and chat are the first free text other people read. Render with `textContent` only; any auto-linking needs an `http(s)` allowlist.
10. **No edit-conflict rule** for text today (job notes are last-write-wins). Tasks need one (two people editing the same task).
11. **`usersWithKey` runs one query per user.** Fine for the bell, too slow to call on every chat message.
12. **Department channels** have no concept of department except roles, so a department channel means "people with this role".

## 2. How it works, in one paragraph

Anyone with an office login can **raise a task** for someone else (title, notes, who, when it's due, optionally a job and a file), and the person gets a bell alert. **Tasks** and **Messages** sit beside **Alerts** at the right of the menu bar, each with its own count. Each task, and each job, has a **comment thread**: plain text, newest at the bottom, with the people involved alerted when someone writes. **Messages** is a simple chat: one company-wide channel plus one per department, with unread counts, refreshed every few seconds while open. Accounts staff **upload monthly reports** (bank reconciliation, BAS and so on) into a library filed by month, which Todd browses and downloads. Those files are private: only Todd and accounts can open them. The home page gets real "My tasks" and "Messages" tiles in place of the placeholder.

## 3. Data (migration `012_collaboration.sql`, additive only)

New tables only; nothing existing changes. Timestamps are UTC ISO; business dates (`due_date`, the report month) are Sydney dates.

- `tasks`: `id`, `title`, `notes`, `assignee_id`, `created_by`, `job_id` (nullable), `due_date` (nullable), `status` (`open`, `done`, `cancelled`), `done_at`, `done_by`, `created_at`, `updated_at`. Cancel is the soft delete.
- `comments`: `id`, `entity_type` (`task` or `job`), `entity_id`, `author_id`, `body`, `created_at`, `removed_at`, `removed_by`. One flat thread per task or job (no replies to replies).
- `follows`: `user_id`, `entity_type`, `entity_id`. This is what "involved" means: you follow a task you created or are assigned, and anything you've commented on. A **Stop following** button removes the row.
- `channels`: `id`, `slug`, `name`, `role` (null = everyone with `messages.use`), `archived`. Seeded with **All**, **Accounts**, **Design/PM**, **Scheduling**. Todd sees every channel.
- `messages`: `id`, `channel_id`, `author_id`, `body`, `created_at`, `removed_at`, `removed_by`.
- `channel_reads`: `user_id`, `channel_id`, `last_read_id` (unread = messages after it).
- `files`: `id`, `stored_name` (UUID plus allowlisted extension), `original_name`, `mime`, `size`, `sha256`, `uploaded_by`, `uploaded_at`, `removed_at`, `removed_by`.
- `reports`: `id`, `period` (`YYYY-MM`), `category` (Bank reconciliation, BAS, Payroll, Aged debtors, Other), `title`, `notes`, `file_id`, `uploaded_by`, `created_at`, `removed_at`, `removed_by`.
- `task_files`: `task_id`, `file_id`.

Bodies are capped (comments and messages 4,000 characters, task notes 10,000) and stored as typed. Removed comments and messages show as "Removed" in the thread; the text stays in the database (soft delete, brief §8.5).

## 4. Tasks

- **Who:** `tasks.use` (admin, accounts, design_pm, scheduling). The showroom account has none of this.
- **Raising a task:** title, assignee (picked from a new `GET /api/people`, which returns only `{id, displayName}` of enabled users holding `tasks.use`), optional notes, due date, job and attachments. You can assign a task to yourself.
- **Lifecycle:** open → done (anyone who can see it; it records who and when) → reopen if needed. Cancel by the creator or Todd. Editing (title, notes, assignee, due date) by the creator, the assignee or Todd, with a stale-edit check: the page sends the `updated_at` it loaded, and a mismatch returns 409 ("someone else changed this task; reload").
- **Pages:** `/tasks.html` with the views **Mine** (assigned to me, open, overdue first in red), **Raised by me**, **All open** and **Done**. A task opens in a dialog with its comments and files. The job page gets a **Tasks** section listing that job's tasks, with "New task" pre-filled with the job.
- **The accounts queue** (brief §5.1.5) is these same tasks between Todd and accounts staff; the Accounts page gets a Tasks link to Mine. No separate mechanism.
- **Alerts:** `task.assigned` to the new assignee (not if they assigned it themselves), `task.done` to the creator, `task.reopened` to the assignee. A **morning reminder** (weekdays 7:30 Sydney, the round-up's timer pattern) sends one alert per person listing their tasks due today or overdue (question 4).

## 5. Comments

- On **tasks** (visible to whoever can see the task) and on **jobs** (read with `jobs.view`, write with `messages.use`).
- Plain text with line breaks; `http(s)` links become clickable (new tab, `rel="noopener"`), nothing else is interpreted.
- Writing a comment makes you a follower. Every other follower gets one `comment.new` alert linking to `/job.html?id=N#comments` or the task.
- **No editing.** You can remove your own comment; Todd can remove any (question 5). Removals are audited.

## 6. Messages (chat)

- `/messages.html`: the channel list on the left with unread counts, the thread on the right, a box at the bottom. Enter sends, Shift+Enter starts a new line.
- **Channels:** All (everyone with `messages.use`), and Accounts, Design/PM, Scheduling (people with that role; Todd in all). Fixed in M4: no creating channels (question 2).
- **Refresh:** the open channel polls every 5 s while the tab is visible, fetching only messages after the last one shown. The menu bar counts piggyback on the existing 60 s bell poll: `/api/notifications/unread-count` adds `messages` and `tasks` fields beside `unread`, so there is still one poll.
- Chat messages never create bell alerts. Removal works as for comments.
- No @mentions, reactions, files or editing in M4.

## 7. Report library

- `/reports.html`: months newest first, each with its reports (category, title, who uploaded it, when, size), filtered by year and category. Upload: pick the month (defaults to last month), category, title, notes, one file.
- **Who:** view and download with `accounts.view` (Todd and accounts); upload with `reports.upload`; remove (soft) by the uploader or Todd (question 3). Linked from the Accounts page and the Accounts tile, not the menu bar.
- **Files allowed:** PDF, Excel (xlsx, xls), CSV, Word (docx), PNG, JPEG; 25 MB each. The type is checked from the file's first bytes, and the stored name's extension comes from that check, never from the uploaded name.

## 8. Files: storage and safety (reports and task attachments)

- **Private folder:** files go to `/data/uploads/files/`, inside the existing uploads volume, so the compose file, the cutover copy and the future backup all cover them with no new mount.
- **Close the `/photos` hole:** the `/photos` static route is narrowed to top-level photo files (a UUID name with an image extension). Anything else under `/photos` (subfolders, `index.html`, directory redirects) is 404. Smoke proves `/photos/files/<real file>` is 404 even for admin.
- **Downloads** go only through `GET /api/files/:id`, which checks access to the report or task first. Headers: `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Content-Security-Policy: sandbox`. PDF and images open inline; everything else downloads (`Content-Disposition: attachment` with the original name).
- **multer 1.4.5 → 2.x** for every upload route, photos included (the existing photo smoke tests cover it).
- Removing a report or attachment hides it; the file stays on disk. Permanent deletion waits for an admin tool (later).

## 9. The bell, menu bar and home page

- **Menu bar right side:** `Tasks n` · `Messages n` · `Alerts n` (text buttons, teal count; orange when you have an overdue task). Re-measured at 1100–1600 px as in M3.
- **Bell:** the new kinds (`task.assigned`, `task.done`, `task.reopened`, `task.reminder`, `comment.new`), and a **Show older** button (paging by id), since it now carries more.
- **Home page:** "My tasks" (your open tasks, overdue first, up to 8) and "Messages" (channels with unread counts) replace the "Coming later" placeholder.

## 10. Pages and keys

| Page | Access | Notes |
|---|---|---|
| `/tasks.html` | `tasks.use` | new |
| `/messages.html` | `messages.use` | new |
| `/reports.html` | `accounts.view` | new; the upload button needs `reports.upload` |
| `/job.html` | `jobs.view` (unchanged) | the Tasks section needs `tasks.use`; Comments read with `jobs.view`, write with `messages.use` |

No new feature keys. `docs/auth.md` loses the † on the three keys.

## 11. Build, tests, release

- **Waves** (as M3):
  - **2.2 scaffold** by the lead: migration 012, `lib/files.js` (storage, type check, download headers) and the `/photos` narrowing, multer 2, `GET /api/people`, the unread-count fields, the shell buttons, empty guarded routers, the `smoke-m4-*` source hook.
  - **Wave 1** in parallel worktrees: **A** tasks, comments, follows and the morning reminder (backend and `/tasks.html`); **B** messages (backend and `/messages.html`); **C** files and the report library (backend and `/reports.html`).
  - **Wave 2:** **D** the job page Tasks and Comments sections, the home page tiles, bell paging, the Accounts links.
- **Smoke files** (`smoke-m4-tasks.sh`, `smoke-m4-messages.sh`, `smoke-m4-reports.sh`): access per role (showroom 403 everywhere; scheduling 403 on reports), the 409 stale edit, follower alerts that skip the author, unread counts, a report upload and download with its headers, refused `.html` and `.svg` uploads, the `/photos/files/` 404, and photo upload still working under multer 2.
- **Local checks** as before (node --check, bash -n, shim boot, style check, headless-Edge screenshots, a local end-to-end run), then the review (4.2) and fixes (4.3).
- **Release:** version 0.1.5 at the earliest (0.1.4 is published). Release timing stays Todd's call; per 2026-10-11 it waits for a future push.

## 12. Not in M4

- Phone push (waits for the companion app, M2 decision 1).
- @mentions, reactions, chat attachments, editing messages or comments, creating channels.
- Joinr intake alerts (M6) and board indicators (M5).
- Permanent deletion of files, and backup of the uploads folder (the Backup milestone).

## 13. Questions for Todd (M4 · 1.2) and decisions (M4 · 1.3)

Each has a recommended default; "defaults" takes them all.

1. **Who sees tasks?** (a) *Recommended:* everyone with office access sees every task, with "Mine" as the default view. Simple for eight people, and anyone can pick up a task when someone is away. (b) Private: only the creator, the assignee and Todd.
2. **Chat channels:** (a) *Recommended:* All, plus Accounts, Design/PM and Scheduling channels, fixed. (b) Only the company-wide channel.
3. **Report library access:** (a) *Recommended:* Todd and all accounts staff see every report; the uploader or Todd can remove one (hidden, not destroyed). (b) Accounts staff upload, but only Todd sees the library.
4. **Morning reminder** of tasks due today or overdue, weekdays at 7:30 Sydney, one alert per person: (a) *Recommended:* yes. (b) No: overdue tasks just show in red.
5. **Comments and messages:** (a) *Recommended:* not editable; you can remove your own, Todd can remove any. (b) Editable by the author (shown as "edited").
