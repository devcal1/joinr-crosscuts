# Crosscuts — Milestone 1 plan (draft for approval, 2026-10-10)

Source of truth: `crosscuts-brief.md`. This plan answers the M1 questions in brief §10 and breaks the work into parallel tasks. Nothing is built until Todd approves.

## 1. Repo and app setup

**Store decision: a second, separate community store.** The new public repo `devcal1/joinr-crosscuts` *is* the store (store id `crosscuts`; the repo name doesn't affect ids).
- Umbrel silently drops any app whose id doesn't start with its store's id (umbreld `app-repository.ts` L184). Inside the old `thcabinets` store the app would have to be `thcabinets-crosscuts`, and the old repo would need editing.
- A separate store with `id: crosscuts` gives the clean id `crosscuts` and never touches the old repo.
- umbrelOS 2.0 supports several stores at once. App data dirs and containers are keyed by app id, so nothing collides.
- At cutover, the old store and app are retired on their own.

**What gets copied:** the old repo's committed `HEAD` (`37a5559`, v1.9.0), via `git archive` rather than the working tree, so the `/api/tags` WIP can't ride along (Q1). The old repo is only read.
- Copied: `app/`, `icon.svg`, the `data/` `.gitkeep`s, `.gitignore`, `publish.yml`.
- Not copied: `archive/`, `joinery-quoter/` or the old `CLAUDE.md`. Crosscuts gets a new `CLAUDE.md`, and the brief docs move into `docs/`.

**New layout.**
```
umbrel-app-store.yml        id: crosscuts, name: Crosscuts
crosscuts/umbrel-app.yml    id: crosscuts, port: 4091, version: 0.1.0
crosscuts/docker-compose.yml
crosscuts/app/              Docker build context
crosscuts/data/{db,uploads,config}/.gitkeep
docs/  (brief, agent-briefing, plans/, auth.md, runbooks)
.github/workflows/publish.yml
```

**Every rename.** The build/deploy audit found all occurrences.

| Thing | Old | New |
|---|---|---|
| Store id / name | `thcabinets` / TH Cabinets | `crosscuts` / Crosscuts |
| App id | `thcabinets-splash` | `crosscuts` |
| Manifest port | 4090 | **4091** (free in all 393 official manifests; 4080 and 4096 are taken) |
| `APP_HOST` | `thcabinets-splash_web_1` | `crosscuts_web_1` |
| Image | `ghcr.io/devcal1/thcabinets-web` | `ghcr.io/devcal1/crosscuts-web` |
| Repo, icon and gallery URLs in manifest | `thcabinets-umbrel-store` | `joinr-crosscuts` |
| CI path filters, version guard, smoke tag | `thcabinets-splash/...` | `crosscuts/...` |
| Version | 1.9.0 | 0.1.0 (1.0.0 at cutover) |

Internal `APP_PORT` stays 3000. The showroom's "TH Cabinets" wording stays. Volumes are identical, so cutover is a file copy.

**Proxy auth (verified in umbrelOS 2.0 source):**
- The compose file sets `PROXY_AUTH_ADD: "false"` on `app_proxy`, and the WHITELIST and BLACKLIST lines are deleted.
- umbreld's built-in gateway treats auth as on unless that value is `"false"`, and with auth off it never reads the lists (`app-gateway.ts` L93-97, L268-273). navidrome, jellyfin and vaultwarden do the same.
- **Caveat:** 2.0's per-app "Require Umbrel login" UI toggle overrides compose, so it must stay **off**.
- Verify logged out over LAN and Tailscale: pages should 302 to `/login`, and the API should return 401.

**CI:** copied and renamed, with each architecture built on a native runner (`ubuntu-24.04` and `-arm`) instead of QEMU.
- Each architecture smoke-tests the exact image it then pushes by digest, and a final job merges the manifest.
- This fixes the known stall, and the old flaw of publishing a rebuilt, untested image.
- The repo is public, so native arm runners are free.

## 2. Data model for M1

**Migrations:**
- Numbered `app/db/migrations/NNN_name.sql` (or `.js`) files are applied at boot, one transaction each, and recorded in `schema_migrations` (with a checksum).
- **Before any pending migration runs, the runner writes `VACUUM INTO data/db/backups/photos-pre-NNN-<ts>.db`.** Every migration gets a restorable copy.
- A failure rolls back and blocks boot. An edited, already-applied file also blocks boot.
- `photos.db` is never renamed.
- After migrations, `foreign_keys = ON` (it affects new writes only), and a `foreign_key_check` result is logged.

| # | Migration | Effect on existing data |
|---|---|---|
| 001 | Baseline: today's `CREATE IF NOT EXISTS` schema, moved out of `db.js` | None. A no-op on the copied DB. |
| 002 | Auth: `users`, `user_roles`, `permission_overrides`, `sessions`, `devices` | New tables only |
| 003 | Jobs extension and backfill (below), plus nullable `photos.job_id` | Additive columns, one UPDATE |
| 004 | `audit_log`, with triggers that block UPDATE and DELETE (append-only) | New table |
| 005 | Orphan sweep: `DELETE FROM day_flags WHERE week_row_id NOT IN (SELECT id FROM week_rows)` | Deletes rows nothing can reach. **Needs your sign-off.** |

**Auth tables:**
- `users`: username (unique, case-insensitive), display name, password and PIN hashes, disabled, must-change-password, last login.
- `user_roles`: one row per role, checked against the five presets.
- `permission_overrides`: key, grant or revoke, who set it and when.
- `sessions`: hashed token, user, device, remember, locked, expiry, last seen, IP, user agent, revoked.
- `devices`: hashed token, user, PIN failure counter and lockout, revoked.
- Role → key mappings live in code, so they ship with releases; there is no `roles` table to drift.

**Jobs extension** (all nullable and additive):
- `stage` (CHECK against the 10 lifecycle values) and `stage_changed_at`.
- `source` (default `manual`) and `external_ref` (unique when set).
- Client name, phone and email, and site address.
- Spec: `sheet_count` INTEGER, `is_two_pac` 0/1, `benchtop` laminate/stone/none, `job_type`.
- `value_cents`.
- Eight business dates as Sydney-local `YYYY-MM-DD`.
- Design-folder and Joinr URLs, and `updated_at` (UTC).
- Existing columns are unchanged. The typed spec fields keep a future solver hand-off clean.

**Backfill rule (for sign-off).** It runs once, inside 003. Let *M* = this week's Monday in Australia/Sydney.
1. Job has any `week_rows` with `week_start >= M` → `on_board`
2. Otherwise, job is in `backlog` → `ready_to_cut`
3. Otherwise → `complete`

Rules are checked in that order, so a job in both backlog and a future week becomes `on_board`. Archived jobs get a stage too; `archived` is untouched. `source` = `manual` for all rows. **No dates are invented:** `completed_date` and the rest stay empty.

**Data-risk notes.**
- A job whose last rows are in a past week but which isn't actually finished would backfill as `complete`. This happens if Finish week was skipped. Finish week always creates next week's rows, so this only bites if it wasn't run. Before cutover I'll list every job the rule marks `complete` whose last row is within the last two weeks, for you to eyeball.
- It is proven in CI (smoke item 8) on every build, then on a fresh copy of the live DB before cutover (§9a).

**Ongoing stage hooks** (server-side only; nothing changes on screen):
- Placing a job on a week → `on_board`.
- Finish week "complete" → `complete` plus `completed_date`. Today that outcome records nothing.
- Board quick-add creates `ready_to_cut` with `source=board_quick_add`. That covers both the backlog "add" and typing a new name into a panel.
- Design/PM setting `ready_to_cut` adds the job to the backlog.

## 3. Auth design

- **Password hashing:** Node's built-in `crypto.scrypt` (N=2^15, r=8, p=1), with its parameters stored in the hash so they can be raised later.
  - I'm deliberately departing from bcrypt/argon2 (D20): scrypt is just as memory-hard, and it needs no new native package that could break the multi-arch build or your Windows box.
- **First admin:** `/setup` works only while there are no users; after that it returns 404. You do this straight after install, and CI uses the same path.
- **Sessions:** a server-side row and an opaque random cookie, `crosscuts_sid` (`HttpOnly; SameSite=Lax`).
  - There's no `Secure` flag, because the LAN and Tailscale URLs are plain http.
  - The name is unique because browsers share cookies across ports.
  - **Default: 12 hours absolute.**
  - **"Remember this device": 30 days, sliding**, so a Chromebook in daily use never logs out.
  - Disabling a user, resetting a password, or "sign out everywhere" kills their sessions.
- **PIN (4–6 digits, optional):**
  - A password login with "remember" ticked registers the browser as a device (a hashed `crosscuts_dev` cookie).
  - "Lock" in the user menu locks the session, and a PIN unlocks it only if the device, the device record and the remembered session all belong to that user.
  - It never works on a fresh browser, after logout, or on a non-remembered session.
- **Rate limits:**
  - 5 wrong PINs on a device disables PIN there until the next password login. 10 wrong PINs across all devices in an hour disables PIN for that user.
  - 10 failed passwords per user and IP in 15 minutes triggers a 15-minute lockout.
  - All attempts are audited.
- **Enforcement:**
  - **APIs:** every `/api` route declares its feature key in one route table. **The server refuses to boot if any route lacks one.** Logged-out requests get 401 JSON, and wrong-role requests get 403.
  - **Pages:** gated before static files are served. Logged out gets a 302 to `/login?next=`, and a wrong role gets a 403 page. Uploaded images need any login.
  - **Always open:** `/healthz`, `/login`, `/setup` and their assets.
- **CSRF:** `SameSite=Lax`, plus a same-origin `Origin` check on every non-GET request.

## 4. Feature keys and presets

Keys marked † gate only a shell page in M1. They come alive in later milestones.

| Key | Admin | Accounts | Design/PM | Scheduling | Showroom |
|---|:-:|:-:|:-:|:-:|:-:|
| `board.view` (board, schedule APIs read) | ✓ | ✓ | ✓ | ✓ | |
| `board.edit` (rows, chips, flags, backlog, Finish week, quick-add) | ✓ | | | ✓ | |
| `workers.edit` | ✓ | | | ✓ | |
| `jobs.view` | ✓ | ✓ | ✓ | ✓ | |
| `jobs.edit` (create, edit, move stage) | ✓ | | ✓ | | |
| `jobs.value` (see/edit job value) | ✓ | ✓ | ✓ | | |
| `photos.search` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `photos.admin` (upload, tag, delete, AI) | ✓ | | ✓ | | |
| `accounts.view`† | ✓ | ✓ | | | |
| `invoices.edit`† (mark invoiced/paid) | ✓ | ✓ | | | |
| `reports.upload`† | ✓ | ✓ | | | |
| `design.view`† | ✓ | | ✓ | | |
| `orders.edit`† | ✓ | | ✓ | | |
| `orders.mark_ordered`† (fires 50% prompt) | ✓ | | | | |
| `inspections.edit`† | ✓ | | ✓ | | |
| `scheduling.view` | ✓ | | ✓ | ✓ | |
| `leave.edit`† | ✓ | | | ✓ | |
| `tasks.use`†, `messages.use`† | ✓ | ✓ | ✓ | ✓ | |
| `users.admin`, `audit.view` | ✓ | | | | |

Effective permissions are the union of the user's role keys, with that user's overrides then applied. Aaron and Jordan hold design_pm and scheduling. `PATCH /api/jobs/:id` (the board's name/notes edit) accepts either `board.edit` or `jobs.edit`.

**Known M1 limit:** the board UI doesn't hide edit controls from view-only users, because we're not touching the board. The server refuses their edits with a 403 toast.

## 5. Shared UI shell

- **The shell:** `public/shell/shell.js` and `shell.css`, with every class namespaced `.cc-` so it can't collide with the board's global `.nav`.
  - A top bar with the brand, a department switcher showing only permitted entries, a bell placeholder, and a user menu (Set PIN, Lock, Sign out).
- **Where it's used:** login and setup, the home dashboard (replacing `index.html`), the jobs list and job page, user admin, the audit screen, the department shells, and photo admin. Photo admin needs one `<div>` and one `<script>`; its darker theme stays.
- **Inter** is vendored through a local `@font-face` in `tokens.css`.
- **The board is excluded.** `schedule.html`, `schedule.css` and `schedule.js` are not edited; `exportJpg`, `alignPanels`, `.nav` and `--nav-h` are untouched.
  - The board's only changes come through shared files: Inter now loads locally, and `shared.js` `api()` gains one branch (a 401 sends you to `/login?next=`).
  - `workers.html` keeps its board-style nav. `search.html` stays chrome-free for customers and only gets the same 401 redirect.
- **Dashboard:** permitted department tiles, a one-line "this week" board summary, and tasks/notifications tiles labelled "coming in M4".

## 6. Work breakdown

**Wave 0, one Sonnet agent, done before anything else so the parallel tasks don't collide:**
- Copy and rename the repo.
- Split `server.js` into `routes/photos.js`, `routes/schedule.js` and a thin `server.js`. This is a mechanical move with no behaviour change.
- Build the migration runner and 001.
- Create stub files with agreed signatures: `requireLogin`, `requirePerm(key)`, `audit.log(...)`, `KEYS`.
- Run `node --check` on everything and do a local boot against `node:sqlite`.

**Wave 1, in parallel, each in its own git worktree:**

| Task | Model | Owns (only these files) |
|---|---|---|
| T1 Auth | Sonnet | `lib/password.js`, `lib/auth.js`, `routes/auth.js`, migration 002, `public/login.*`, `public/setup.*` |
| T2 Permissions + user admin | Sonnet | `lib/permissions.js`, `routes/users.js`, `public/users.*` |
| T3 Jobs | Sonnet | migration 003, `routes/jobs.js`, `public/jobs.*`, `public/job.*`, stage hooks in `routes/schedule.js` (the only Wave 1 task allowed in that file) |
| T4 Audit | Sonnet | migration 004, `lib/audit.js`, `routes/audit.js`, `public/audit.*` |
| T5 Shell + dashboard | Sonnet | `public/shell/*`, `public/index.*`, `public/{accounts,design,scheduling}.html`, `public/vendor/inter/*`, `tokens.css`, `shared.js`, `admin.html`, the raw-fetch 401 handling in `admin.js`/`search.js`, `routes/dashboard.js` |
| T6 Build + CI | Haiku for the lockfile, Sonnet for CI | `package.json`, `package-lock.json` (pins `@img/sharp-linuxmusl-x64` and `-arm64`), `Dockerfile` (`npm ci --omit=dev`), `.github/workflows/publish.yml` |
| T7 Docs | Haiku | `docs/auth.md`, `docs/how-to-add-user.md`, `docs/how-to-add-feature-key.md`, `docs/rollback.md`, `CLAUDE.md` |

**Integration (me):**
- Own `server.js` and its route-to-key table, migration 005, and the Sydney-time default for `/api/schedule` (`lib/time.js`).
- Review every task's diff before merging.
- Run one Sonnet code-review pass on the whole integrated diff.
- Live-data migration dry-run moves to the cutover runbook (Crosscuts starts empty; CI rehearsal item 8 covers it until then).
- When you say push, run CI. Then you install from the store and we do the LAN and Tailscale checks together.

## 7. Smoke-test additions

The existing photo and schedule suite runs unchanged, logged in as admin through a cookie jar. New checks:
1. Setup creates the admin; a second setup returns 404.
2. Logged out: every routed API returns 401, pages 302 to login, and `/healthz` returns 200.
3. One user per preset gets one permitted (200) and one forbidden (403) call. A `board.edit` revoke override then turns the scheduling user's row move into a 403.
4. Wrong passwords trigger the lockout. Remember-me sets a cookie of about 30 days; without it the cookie is session-only.
5. PIN: lock, then unlock with the PIN (200). A fresh browser's PIN is refused, and 5 wrong PINs lock the device.
6. A foreign `Origin` on a POST returns 403.
7. Audit rows exist for logins, user and override changes, and job edits. An UPDATE on `audit_log` fails.
8. **Cutover rehearsal:**
   - Boot the old public image and seed past, current, future and backlog jobs plus orphan flags through its API.
   - Boot Crosscuts on the same volume and assert the stages, the sweep, an identical board, and that the pre-migration backup exists.
   - Restart and confirm nothing re-applies.
9. With no `?week=`, `/api/schedule` returns the Sydney Monday.

## 8. Decisions from Todd (2026-10-10)

1. **`/api/tags` WIP:** left behind; a new version will be built later.
2. **Repo:** `https://github.com/devcal1/joinr-crosscuts` (public, empty).
3. **Live data:** Crosscuts starts **empty** during the build (test data only, no snapshot). Live data is copied in **at cutover** per §9a, so the migrations still run against the real `photos.db` then — dry-run on a fresh copy first, as the runbook requires.
4. **Backfill rule (§2): approved as written.** Before cutover I list any job it marks `complete` whose last row is within two weeks.
5. **Migration 005 orphan `day_flags` sweep: approved.**
6. Note: leave umbrelOS's "Require Umbrel login" toggle **off** for Crosscuts.
