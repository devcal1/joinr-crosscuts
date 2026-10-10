# M1 interface contracts (binding for all M1 subagents)

Read `docs/plans/m1-plan.md` for the why. This file is the *what*: names, signatures and schemas every task codes against. Do not change anything here without the integrator's say-so. If a contract is wrong, report it instead of working around it.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3`, no build step, no framework.

## Timestamps and dates
- Timestamps are UTC ISO strings: `strftime('%Y-%m-%dT%H:%M:%fZ','now')` in SQL, or `new Date().toISOString()` in JS.
- Business dates are Australia/Sydney local `YYYY-MM-DD`.
- `lib/time.js` exports `sydneyToday()` and `sydneyMonday(dateStr?)`, both returning `YYYY-MM-DD`. They are built on `Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney'})`.

## Database (`db/index.js`; `require('./db')` returns the better-sqlite3 handle)
- The DB is opened at `${DB_DIR}/photos.db` with `journal_mode=WAL`.
- Next, `db/migrate.js` runs `migrate(db)`:
  - It applies every file in `db/migrations/` matching `NNN_name.sql|.js` whose version isn't in `schema_migrations`, in numeric order. Gaps are allowed.
  - Each file runs in its own transaction. A `.js` file exports `up(db)`.
  - It records `(version INTEGER PK, name, checksum sha256, applied_at)`.
  - If an applied file's checksum has changed, it throws and boot stops.
  - **Before the first pending migration**, if the DB already contains any user table, it runs `VACUUM INTO ${DB_DIR}/backups/photos-pre-<NNN>-<UTC yyyymmddThhmmss>.db`.
- After migrations: `PRAGMA foreign_keys=ON`, and the `PRAGMA foreign_key_check` result is logged. Then the first-run worker seed runs, unchanged from the old app.

| File | Owner |
|---|---|
| `001_baseline.sql` (the old schema, verbatim `CREATE … IF NOT EXISTS`) | Wave 0 |
| `002_auth.sql` (below) | Wave 0 |
| `003_jobs.js` (jobs extension and backfill) | T3 |
| `004_audit.sql` (below) | Wave 0 |
| `005_orphan_day_flags.sql`: `DELETE FROM day_flags WHERE week_row_id NOT IN (SELECT id FROM week_rows);` | Wave 0 |

### 002_auth.sql
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin','accounts','design_pm','scheduling','showroom')),
  PRIMARY KEY (user_id, role)
);
CREATE TABLE permission_overrides (
  user_id INTEGER NOT NULL REFERENCES users(id),
  feature_key TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('grant','revoke')),
  set_by INTEGER REFERENCES users(id),
  set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, feature_key)
);
CREATE TABLE devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  pin_failures INTEGER NOT NULL DEFAULT 0,
  pin_locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- sha256 hex of the cookie token
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id INTEGER REFERENCES devices(id),
  remember INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  revoked_at TEXT
);
CREATE TABLE auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('password','pin')),
  username TEXT,
  user_id INTEGER REFERENCES users(id),
  device_id INTEGER REFERENCES devices(id),
  ip TEXT,
  success INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_devices_user ON devices(user_id);
CREATE INDEX idx_attempts_user ON auth_attempts(username, kind, at);
CREATE INDEX idx_attempts_uid ON auth_attempts(user_id, kind, at);
```

### 004_audit.sql
```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_user_id INTEGER REFERENCES users(id),
  actor_label TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ip TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_log(actor_user_id);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
```

## Permissions (`lib/permissions.js`, written in full in Wave 0)
- `KEYS`: an array of the 21 keys: `board.view board.edit workers.edit jobs.view jobs.edit jobs.value photos.search photos.admin accounts.view invoices.edit reports.upload design.view orders.edit orders.mark_ordered inspections.edit scheduling.view leave.edit tasks.use messages.use users.admin audit.view`.
- `PRESETS`: a map of role to key array.
  - admin: every key.
  - accounts: `board.view jobs.view jobs.value photos.search accounts.view invoices.edit reports.upload tasks.use messages.use`.
  - design_pm: `board.view jobs.view jobs.edit jobs.value photos.search photos.admin design.view orders.edit inspections.edit scheduling.view tasks.use messages.use`.
  - scheduling: `board.view board.edit workers.edit jobs.view photos.search scheduling.view leave.edit tasks.use messages.use`.
  - showroom: `photos.search`.
- `ROLES`: the five role names.
- `computeEffective(roles, overrides)` returns a `Set`. It takes the union of the role presets, then applies each `{feature_key, effect}` override (`grant` adds, `revoke` removes). Unknown keys are ignored.

## Auth (`lib/auth.js`; Wave 0 writes pass-through stubs, T1 replaces them)
These are the exports, with their exact names:
- `authenticate`: middleware. It reads the `crosscuts_sid` cookie and sets `req.user = {id, username, displayName, roles:[], perms:Set, mustChangePassword}` or `null`. It also sets `req.session = {id, remember, locked, deviceId}` or `null`.
  - A locked session sets `req.user`, with `req.session.locked = true`.
- `originCheck`: middleware. A non-GET/HEAD request with an `Origin` header that doesn't match the `Host` header gets a 403 `{error}`.
- `requireLogin`: middleware. No user gets a 401 `{error:'Not logged in'}`. A locked session gets a 401 `{error:'Locked', locked:true}`.
- `requirePerm(access)`: returns middleware.
  - `access` is `'public'`, `'login'`, a key string, or an array of keys (the user needs any one of them).
  - It runs `requireLogin` first, then sends a 403 `{error:'Forbidden'}` if the user has none of the keys.
- `pageGate`: middleware for HTML page requests (a GET for a path ending in `.html`, or `/`). It uses `lib/pages.js`:
  - Logged out (or locked) → 302 to `/login.html?next=<path>`.
  - Wrong permission → 403 with a small HTML page.
  - Non-HTML static assets are never gated.
- Cookie `crosscuts_sid` is set `HttpOnly; SameSite=Lax; Path=/`, with no `Secure` flag.
  - "Remember this device" adds `Max-Age` = 30 days and is sliding. Otherwise it is a session cookie and expires 12 hours after login on the server side.
  - The device cookie is `crosscuts_dev`.
- `lib/password.js` (T1): `hashSecret(plain)` and `verifySecret(plain, stored)` use `crypto.scrypt`, stored as `scrypt$N$r$p$saltB64$hashB64`. These are used for both passwords and PINs.

## Pages (`lib/pages.js`, Wave 0): page → access
- `'/'` and `'/index.html'`: `'login'`.
- `'/login.html'` and `'/setup.html'`: `'public'`.
- `'/schedule.html'`: `board.view`.
- `'/workers.html'`: `workers.edit`.
- `'/search.html'`: `photos.search`.
- `'/admin.html'`: `photos.admin`.
- `'/jobs.html'` and `'/job.html'`: `jobs.view`.
- `'/users.html'`: `users.admin`.
- `'/audit.html'`: `audit.view`.
- `'/accounts.html'`: `accounts.view`.
- `'/design.html'`: `design.view`.
- `'/scheduling.html'`: `scheduling.view`.
- Any `.html` not listed: `'login'`.

## Route registration (`lib/routes.js`, Wave 0)
- `defineRoutes(prefix)` returns `{ router, get, post, patch, put, delete }`. Each method is `(path, access, ...handlers)`.
  - It prepends `requirePerm(access)`, which is resolved lazily from `lib/auth.js` at request time so T1 can swap the implementation.
  - It tags the route as guarded and records `{method, fullPath: prefix+path, access}` in a module-level registry.
- `assertAllRoutesGuarded(app)` walks the Express stack and throws if any route under `/api` lacks the guarded tag. `server.js` calls it after mounting and exits on failure.
- `listRoutes()` returns the registry.
- `GET /api/meta/routes` (access `users.admin`) returns `listRoutes()`. CI uses it to enumerate the routes for the logged-out sweep.

## Audit (`lib/audit.js`; Wave 0 stub no-op, T4 implements)
- `log(req, {action, entityType, entityId, before, after, actorId, actorLabel})`.
  - Actor and IP default from `req.user` and `req.ip`. `before` and `after` are JSON-stringified.
  - It never throws: failures are `console.error`'d.
- Action names:
  - `auth.login`, `auth.login_failed`, `auth.logout`, `auth.lock`, `auth.unlock`, `auth.unlock_failed`, `auth.pin_set`, `auth.setup`.
  - `user.create`, `user.update`, `user.disable`, `user.enable`, `user.password_reset`, `user.roles`, `user.override`, `user.sessions_revoked`.
  - `job.create`, `job.update`, `job.stage`.

## Server composition (`server.js`, Wave 0 writes it; the integrator owns it afterwards)
Middleware order:
1. `express.json()`
2. `GET /healthz` (open)
3. `auth.originCheck`
4. `auth.authenticate`
5. `auth.pageGate`
6. `/photos` static, behind `auth.requireLogin`, with `Cache-Control: private, max-age=2592000, immutable`
7. `express.static(public)`
8. Routers
9. `assertAllRoutesGuarded(app)`
10. `listen`

Routers are each a `defineRoutes` module, mounted by `server.js`:

| File | Prefix | Owner |
|---|---|---|
| `routes/photos.js` | `/api` | Wave 0, moved verbatim |
| `routes/schedule.js` | `/api` | Wave 0, moved verbatim; T3 adds stage hooks only |
| `routes/auth.js` | `/api/auth` | T1 |
| `routes/users.js` | `/api/users` | T2 |
| `routes/jobs.js` | `/api/job-records` | T3 |
| `routes/audit.js` | `/api/audit` | T4 |
| `routes/dashboard.js` | `/api/dashboard` | T5 |
| `routes/meta.js` | `/api/meta` | Wave 0 |

Wave 0 creates every router file. The ones owned by later tasks are created as empty stubs, so later tasks never edit `server.js`.

### Access for the moved (existing) routes
- `GET /api/photos`: `['photos.search','photos.admin']`.
- `POST /api/photos`, `PATCH|DELETE /api/photos/:id` and `POST /api/suggest-tags`: `photos.admin`.
- `GET /api/workers`, `GET /api/jobs` and `GET /api/schedule`: `board.view`.
- `POST /api/workers` and `PATCH /api/workers/:id`: `workers.edit`.
- `PATCH /api/jobs/:id`: `['board.edit','jobs.edit']`.
- Every rows, assignments, flags, backlog and finish-week mutation: `board.edit`.
- `/api/schedule` with no `?week=` defaults to `sydneyMonday()`.

## Front end
- `shared.js` `api()`: on a 401, go to `/login.html?next=` + the current path (T5).
- Shell: `public/shell/shell.js` and `shell.css` (T5).
  - Classes are prefixed `cc-`. A page includes `<div id="cc-shell"></div>` and `<script src="/shell/shell.js"></script>`.
  - `GET /api/auth/me` returns `{user:{id,username,displayName,roles,perms:[...]}}` (T1). The shell uses it to render.
- **Do not edit** `schedule.html`, `schedule.css`, `schedule.js` or `workers.html`.

## Local dev on Windows
`better-sqlite3` won't build on the dev box. `tools/dev-sqlite-shim.js` (Wave 0, outside the Docker context) maps the better-sqlite3 API onto `node:sqlite`. Boot with:

```
cd crosscuts/app && DB_DIR=../../.dev/db UPLOADS_DIR=../../.dev/uploads CONFIG_DIR=../../.dev/config node -r ../../tools/dev-sqlite-shim.js server.js
```

`.dev/` is git-ignored. CI is the real verification.
