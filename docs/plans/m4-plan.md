# Crosscuts — Milestone 4 plan: Collaboration (2026-10-11)

Status: **draft** (M4 · 1.1 audit done). Steps: M4 · 1.1 (audit, §1), M4 · 1.2 (plan and questions), M4 · 1.3 (decisions).

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
