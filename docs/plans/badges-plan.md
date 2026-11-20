# Red badges, Intake on the Projects page, Done on task rows (0.2.24 plan)

Asked by Todd 2026-11-20. Decisions taken the same day (one question each). Mockup: `docs/plans/mockups/badges-A.html`. Version **0.2.24**. **No migration** (next migration stays 067).

## 1. Intake moves to the Projects landing page

- On `/notes.html?dept=design`, the **Available now** section (New from Joinr tile and Benchtops tile) is removed. In its place, at the bottom of the page, an **Intake** section holds what `intake.html` holds today: the sync line and Sync now, the tabs (Waiting for a person, Changed, Made into jobs, Ignored, Withdrawn) and the quote cards with Accept, Link and Ignore. Shown only with `design.view`, as now.
- The intro paragraph is cut to one line under the heading.
- **Intake leaves the Projects menu.** `intake.html` becomes a redirect: `/intake.html?item=N` goes to `/notes.html?dept=design&item=N#intake`, so old alerts and links still land on the card.
- **Benchtops** stays in the Projects menu; its tile is gone.
- Build: `intake.js` takes its elements from the Intake section (ids prefixed `in-` so they don't clash with the notes page's `#message`). `routes/joinr.js` is unchanged.

## 2. Red badges where the alert is (new named exception)

**Look (Todd 2026-11-20, a ninth named exception to the house style):** a solid red `#EF4444` disc with a white bold count (`9+` above 9), 16 px high, right after the text it marks. Not an icon: a count. It means "new for you here". Red stays otherwise only for overdue and destructive. The Alerts bell count turns red to match; the Tasks and Messages counts stay as they are (teal, orange when overdue), because they count open work, not new things.

**Where a badge shows.** Every unread alert already links to a page. The badge follows that link:

1. **Menu bar:** the department name carries the total for its pages; inside the open menu, the page's item carries its own count (e.g. Projects 3, then Jobs 2 and Pipeline 1). Phones: the same counts in the Menu panel.
2. **On the page, at the heading:** the section heading the alert belongs to (e.g. a new issue on a job: the job page's Workshop tab and the Issues heading). Tabs carry the sum of their sections.
3. **On list rows:** where the alert points to one item on a list page (a task on Tasks, a quote in Intake, an invoice in Accounts, a job in Jobs), the disc sits next to that row's name.

**Which heading.** A table in `shell.js` maps alert kind to section, e.g. `job.issue` to Issues, `comment.new` to Comments, `materials.in`, `job.all_ordered`, `order.delivery_note`, `orders.eta_nudge` to Orders, `inspection.*` to Inspection, `stock.reserve` to Stock reservations, `joinr.job` to Quote. A kind with no section badges only the page in the menu (and its row, if it is a list item). Pages mark their headings with `data-cc-badge="issues"`; list rows with `data-cc-badge-link="/tasks.html?task=12"`. Lists drawn after load call `cc.refreshBadges()`.

**When it clears (Todd: opening the page clears it).** Opening the page an alert links to marks it read, in the bell too. The badges on that page stay visible until you leave it, so you can see what was new; the menu counts drop straight away. Read all in the bell clears every badge. Opening an item from a list (e.g. a task dialog) clears that row's alert.

**Server (no schema change):** `GET /api/notifications/unread-places` (login) returns `{rows: [{id, kind, link}]}` for the caller's unread alerts, newest 500. `POST /api/notifications/read-link` (login) with `{link}` marks the caller's unread alerts with exactly that link read (path and query; the hash ignored). The 60 s poll uses `unread-places` in place of the count when the shell has a page to badge.

## 3. Done on task rows

- An outlined **DONE** button at the end of each open task row on the Tasks page, the job page's Tasks section and the dashboard's My tasks tile.
- One click marks it done (the existing `POST /api/tasks/:id/done`); the row leaves the list and the message line says "Marked done" with **Undo** for 8 seconds (Undo = reopen).
- The button shows only where the dialog's Done shows today (open tasks; maintenance occurrences only for `maintenance.manage`). The click does not open the dialog.
- Undo within the 8 seconds also removes the unread "finished a task" alert it sent, so the creator isn't told twice.

## 4. Checks

- Smoke: `unread-places` and `read-link` (own rows only, another user's link touches nothing); the `intake.html` redirect; task done and undo from the list.
- `ci/style-check.js`: allow the red badge class (`cc-new`) only in `shell.css`, and add the ninth exception to `CLAUDE.md`.
- Browser check: badges in the bar, on a job tab and heading, on a Tasks row; Intake at the bottom of Projects; Done and Undo.
