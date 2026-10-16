# M7 interface contracts: Staff planner (binding for all M7 subagents)

Read `docs/plans/m7-plan.md` first. Its **Decisions (M7 · 1.3)** section is binding and wins over the plan's earlier text, and `docs/plans/planner-notes.md` (Todd's 8 answers and the 4 settled points) is binding too. This file is the *what*. Everything in `m1-contracts.md` … `m6-contracts.md` and `backup-contracts.md` still holds (UTC ISO timestamps with milliseconds, Sydney `YYYY-MM-DD` business dates, `defineRoutes`, audit, `lib/httperror.js`, errors `{error}`). If a contract looks wrong, report it instead of working around it. Points the integrator decided while writing this file are listed in §17.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), Node 24, no build step, no framework.

**Version.** Local `main` is already at **0.1.9** (the held shield favicon, `8e96032`, not pushed). M7 ships in that same release, so the build makes **no further bump**. If anything is pushed before M7 is finished, the next push is 0.1.10 and must bump `crosscuts/app/package.json` and the root version in `crosscuts/app/package-lock.json` first.

**Not touched in M7:** `schedule.html`, `schedule.css`, `schedule.js`, `workers.html`, `exportJpg()`, `alignPanels()`, `public/shared.js`, `public/lookahead.*`, and every write path of the source modules (`lib/schedule.js`, `lib/orders.js`, `lib/inspections.js`, `lib/availability.js`, `lib/invoices.js`, `lib/tasks.js`). The planner only **reads** their tables, with its own queries. The TV stays board-only: the board has no shell, so nothing in this file appears on it.

**Keys:** two new feature keys, `planner.view` and `planner.edit` (21 becomes 23). **Role:** one new role, `workshop`.

## 1. Files and module boundaries

| File | What it is | Owner |
|---|---|---|
| `db/migrations/017_workshop_role.js` | the `user_roles` rebuild (§2), complete | scaffold |
| `db/migrations/018_planner.sql` | three tables and four indexes (§3), complete | scaffold |
| `lib/permissions.js` | `workshop` role, two keys, presets (§4) | scaffold |
| `lib/settings.js` | one `DEFAULTS` key: `"planner.reminder_swept_to": null` | scaffold |
| `lib/time.js` | `sydneyInstant` (§6) | scaffold |
| `lib/pages.js` | `"/planner.html": "planner.view"` | scaffold |
| `lib/planner/layers.js` | the single source of who sees, posts and edits (§5), complete | scaffold |
| `lib/planner/events.js` | hand-made events: validation, CRUD, repeats, exceptions, splits, audit (§7) | stub in scaffold, then A |
| `lib/planner/reminders.js` | the reminder sweep (§10) | stub in scaffold, then A |
| `lib/planner/auto.js` | the automatic events (§8) | stub in scaffold, then B |
| `routes/planner.js` | `defineRoutes('/api/planner')`, thin and complete (§9) | scaffold |
| `server.js` | mounts `routes/planner.js`; starts the sweep after `listen` | scaffold |
| `public/tokens.css` | the seven `--layer-*` tokens (§13) | scaffold |
| `public/users.js` | `workshop: "Workshop"` in `ROLE_LABELS` | scaffold |
| `ci/style-check.js` | the layer-token rule and the header line (§13) | scaffold |
| `CLAUDE.md` | the third named exception (§13) | scaffold |
| `docs/auth.md` | the Workshop column, the two keys, the layer table (§4) | scaffold |
| `ci/smoke.sh` | M7 users and jars, scaffold checks, the source loop (§15.1) | scaffold |
| `tools/screenshots/shoot.js` | three planner entries | scaffold |
| `ci/smoke-m7-events.sh` | §15.2 | A |
| `ci/smoke-m7-auto.sh` | §15.3 | B |
| `public/planner.html`, `public/planner.css`, `public/planner.js` | the page (§12) | C |
| `public/shell/shell.js` (and `shell.css` only if the bar needs it) | the Planner menu entry (§14.1) | D |
| `public/index.html`, `public/index.js`, `public/index.css` (`ix-` additions) | the home tile (§14.2) | D |
| `public/job.html`, `public/job.js`, `public/jobs.css` (`jo-` additions) | the job page section (§14.3) | D |
| `docs/how-to-add-user.md` | the workshop role and the TV (§14.4) | D |
| `ci/smoke-m7-access.sh` | §15.4 | E |

**Boundaries.**
- Every planner route and the sweep decide visibility, posting and editing through `lib/planner/layers.js` only. No other file compares role names or layer ids to decide access.
- Nothing under `lib/planner/` requires `../../db`. Every function takes `db` as its first argument (as `lib/tasks.js` does); `routes/planner.js` and `server.js` pass it in.
- `lib/planner/` reads the source tables with its own read-only queries. It never calls a source module's write function, and never `lib/schedule.js` (which opens the database at load and builds far more than the planner needs).
- Filtering happens in SQL and in the server's shaping, never on the page. The page receives only what the viewer may see.

## 2. Migration 017: `017_workshop_role.js` (scaffold, M7 · 2.2)

The one non-additive migration, signed off by Todd (Decisions 3). It changes no row.

**What the runner gives it** (`db/migrate.js`, read 2026-10-11): before the first pending migration, if the database has user tables, a `VACUUM INTO` copy is written to `data/db/backups/photos-pre-017-<stamp>.db` (reused if one already exists for 017). Each file then runs inside `db.transaction(...)` together with its `schema_migrations` row, so a throw rolls everything back and boot stops. Applied files are checksummed: **once 017 is applied anywhere (including `.dev`), it is never edited.**

**Foreign keys are ON while it runs.** Both `better-sqlite3` and `node:sqlite` open connections with foreign-key enforcement on (checked locally: `node:sqlite` reports `foreign_keys = 1` on open), and `PRAGMA foreign_keys` is a no-op inside a transaction, so 017 cannot switch them off and does not try. It doesn't need to: nothing references `user_roles`, so dropping and renaming it is safe with enforcement on. (Proved locally on `node:sqlite` 3.53.4 with enforcement on: the rebuild commits, `foreign_key_check` is empty, the primary-key index comes out as `sqlite_autoindex_user_roles_1`, and a row for a missing user is still refused afterwards.) The comment in `db/index.js` ("Foreign keys are enforced from here on") is therefore inaccurate; §17 lists it.

Exact file:

```js
// 017_workshop_role: allow the 'workshop' role (docs/plans/m7-contracts.md section 2; Todd's
// sign-off in docs/plans/m7-plan.md, Decisions 3). SQLite can't alter a CHECK, so user_roles is
// rebuilt: a new table with 'workshop' in the CHECK, every row copied, the copy compared, the old
// table dropped and the new one renamed. No row is added, changed or removed.
// The runner has already written its VACUUM INTO backup and wraps up(db) in a transaction, so
// any throw below rolls the whole file back and stops boot with the database unchanged.
// Foreign keys stay on (a PRAGMA can't change inside a transaction); nothing references
// user_roles, so the drop and rename are safe. Never require app code here (011's rule).
function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function up(db) {
  const orphans = db
    .prepare("SELECT COUNT(*) AS n FROM user_roles WHERE user_id NOT IN (SELECT id FROM users)")
    .get().n;
  if (orphans > 0) {
    throw new Error(`user_roles has ${orphans} row(s) for users that don't exist; nothing was changed. Stop and ask Todd.`);
  }
  const before = count(db, "user_roles");

  db.exec(`CREATE TABLE user_roles_new (
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('admin','accounts','design_pm','scheduling','showroom','workshop')),
    PRIMARY KEY (user_id, role)
  )`);
  db.exec("INSERT INTO user_roles_new (user_id, role) SELECT user_id, role FROM user_roles");

  const copied = count(db, "user_roles_new");
  const missing = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT user_id, role FROM user_roles EXCEPT SELECT user_id, role FROM user_roles_new)`
    )
    .get().n;
  if (copied !== before || missing !== 0) {
    throw new Error(`user_roles copy does not match (${before} before, ${copied} copied, ${missing} missing)`);
  }

  db.exec("DROP TABLE user_roles");
  db.exec("ALTER TABLE user_roles_new RENAME TO user_roles");

  const after = count(db, "user_roles");
  if (after !== before) throw new Error(`user_roles has ${after} row(s) after the rebuild, expected ${before}`);
  const fk = db.prepare("PRAGMA foreign_key_check(user_roles)").all();
  if (fk.length) throw new Error(`user_roles fails foreign_key_check after the rebuild (${fk.length} row(s))`);

  console.log(`[migrate] 017 user_roles rebuilt: ${after} row(s) kept, 'workshop' allowed`);
}

module.exports = { up };
```

`db.prepare("PRAGMA …").all()` works on both drivers (better-sqlite3 runs a PRAGMA through `prepare`; the shim maps `prepare` to `node:sqlite`). The scaffold proves 017 on: a fresh `.dev/m7/` database (boots, `user_roles` empty), and a full copy of the most recent local test database (counts equal, the backup written, then a `workshop` user created through `POST /api/users`).

## 3. Migration 018: `018_planner.sql` (scaffold, M7 · 2.2)

Additive: three new tables and four indexes on existing columns. No existing row changes; no backfill. The column `repeat` is not an SQLite keyword.

```sql
-- M7 Staff planner (docs/plans/m7-contracts.md section 3). Additive only: three new tables and
-- four indexes on existing date columns. No existing row changes; no backfill.

-- Hand-made events. A repeating event is one row (a series); its occurrences are worked out when
-- asked, never stored. Dates are Sydney YYYY-MM-DD; times are Sydney HH:MM wall clock.
CREATE TABLE planner_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  layer TEXT NOT NULL CHECK (layer IN ('company','install','accounts','design_pm','scheduling','workshop','personal')),
  owner_id INTEGER NOT NULL REFERENCES users(id),      -- the creator; for personal, the only person who sees it
  title TEXT NOT NULL,                                 -- 1..200 characters (checked in code)
  notes TEXT NOT NULL DEFAULT '',                      -- up to 4,000 characters (checked in code)
  job_id INTEGER REFERENCES jobs(id),
  all_day INTEGER NOT NULL CHECK (all_day IN (0,1)),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,                              -- inclusive; = start_date for a timed event
  start_time TEXT,                                     -- NULL when all-day
  end_time TEXT,                                       -- NULL when all-day; after start_time
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none','weekly','fortnightly','monthly')),
  repeat_until TEXT,                                   -- last allowed occurrence START date; NULL = no end
  repeat_day INTEGER CHECK (repeat_day IS NULL OR repeat_day BETWEEN 1 AND 31),  -- monthly only: the day aimed for
  split_from_id INTEGER REFERENCES planner_events(id), -- set on the second half of a split series
  reminder TEXT CHECK (reminder IS NULL OR reminder IN ('start','min15','hour1','day1','morning','day_before')),
  remind_layer INTEGER NOT NULL DEFAULT 0 CHECK (remind_layer IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  CHECK (end_date >= start_date),
  CHECK ((all_day = 1 AND start_time IS NULL AND end_time IS NULL)
      OR (all_day = 0 AND start_time IS NOT NULL AND end_time IS NOT NULL
          AND end_time > start_time AND end_date = start_date)),
  CHECK (repeat <> 'none' OR repeat_until IS NULL),
  CHECK ((repeat = 'monthly') = (repeat_day IS NOT NULL)),
  CHECK (layer <> 'personal' OR remind_layer = 0),
  CHECK (remind_layer = 0 OR reminder IS NOT NULL)
);
CREATE INDEX idx_planner_events_layer ON planner_events(layer, start_date);
CREATE INDEX idx_planner_events_owner ON planner_events(owner_id, layer);
CREATE INDEX idx_planner_events_job ON planner_events(job_id);

-- One-off changes to one occurrence of a series. NULL override = as the series. An exception can
-- never change the layer, the job, all-day-ness or the reminder, so who sees an occurrence is
-- always the series' rule.
CREATE TABLE planner_exceptions (
  event_id INTEGER NOT NULL REFERENCES planner_events(id),
  occurrence_date TEXT NOT NULL,                       -- the occurrence's ORIGINAL start date (the key)
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
  title TEXT,
  notes TEXT,
  start_date TEXT,
  end_date TEXT,
  start_time TEXT,
  end_time TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id),
  PRIMARY KEY (event_id, occurrence_date),
  CHECK ((start_date IS NULL) = (end_date IS NULL)),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK ((start_time IS NULL) = (end_time IS NULL)),
  CHECK (end_time IS NULL OR end_time > start_time)
);
CREATE INDEX idx_planner_exceptions_dates ON planner_exceptions(start_date, end_date);

-- Reminders already sent (the dedupe record). A moved occurrence gets a new fire_at and reminds
-- again. Never pruned (tiny).
CREATE TABLE planner_reminders_sent (
  event_id INTEGER NOT NULL REFERENCES planner_events(id),
  occurrence_date TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  fire_at TEXT NOT NULL,                               -- UTC ISO with milliseconds
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (event_id, occurrence_date, user_id, fire_at)
);

-- Ranged reads for the automatic events (section 8). The other sources are indexed already.
CREATE INDEX idx_jobs_promised_install ON jobs(promised_install_date);
CREATE INDEX idx_jobs_materials_ordered ON jobs(materials_ordered_date);
CREATE INDEX idx_jobs_materials_in ON jobs(materials_in_date);
CREATE INDEX idx_orders_expected ON orders(expected_date);
```

Already indexed (no change): `week_rows(week_start, panel, sort_order)`, `inspections(status, date)`, `leave(date_from, date_to)`, `invoices(status, due_date)`, `tasks(assignee_id, status, due_date)`.

## 4. Roles, keys and presets (`lib/permissions.js`, scaffold)

- `KEYS` gains `"planner.view"` and `"planner.edit"`, appended after `"messages.use"` (23 keys).
- `ROLES` becomes `["admin", "accounts", "design_pm", "scheduling", "showroom", "workshop"]` (appended last, so `routes/users.js` `shapeUser` keeps today's order for the others).
- `PRESETS`:
  - `admin`: `[...KEYS]` (unchanged; it gets both keys automatically);
  - `accounts`, `design_pm`, `scheduling`: each gains `"planner.view", "planner.edit"`;
  - `showroom`: unchanged (no planner; Decisions 5);
  - `workshop`: `["board.view", "planner.view"]`.

| Key | Admin | Accounts | Design/PM | Scheduling | Showroom | Workshop |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `board.view` | Yes | Yes | Yes | Yes | | Yes |
| `planner.view` | Yes | Yes | Yes | Yes | | Yes |
| `planner.edit` | Yes | Yes | Yes | Yes | | |
| every other key | as today | as today | as today | as today | as today | |

**The TV.** Todd switches the TV account to the workshop role at 6.1. Workshop has no `board.edit`; if anyone edits the board from the TV, that account keeps `board.edit` through a grant override on the Users page (the 6.1 note says so).

**`docs/auth.md` (scaffold):** the key table gains a **Workshop** column and the two planner rows (as above); the intro paragraph gains: "M7 (Staff planner) adds `planner.view` and `planner.edit` and the **workshop** role (`board.view` and `planner.view` only). Which planner layers a person sees and posts to is decided by their **roles**, not their keys (`lib/planner/layers.js`): see `docs/plans/m7-contracts.md` section 5." Then the layer table from §5 below, in plain words.

**`public/users.js` (scaffold):** `ROLE_LABELS` gains `workshop: "Workshop"`. The Users page reads its role list from `GET /api/users/meta` (`permissions.ROLES`), so the tick box appears with no other change.

## 5. Layers (`lib/planner/layers.js`, scaffold, complete)

### 5.1 The layers

In this order everywhere (lists, toggles, sorting, print):

| id | Label | Print prefix | Marker token | Marker |
|---|---|---|---|---|
| `company` | Company-wide | `[Company-wide]` | `--layer-company` | teal |
| `install` | Install & hardware | `[Install & hardware]` | `--layer-install` | orange |
| `accounts` | Accounts | `[Accounts]` | `--layer-accounts` | light grey |
| `design_pm` | Design/PM | `[Design/PM]` | `--layer-design` | violet |
| `scheduling` | Scheduling/Production | `[Scheduling/Production]` | `--layer-scheduling` | fuchsia |
| `workshop` | Workshop | `[Workshop]` | `--layer-workshop` | mid grey |
| `personal` | Personal | `[Personal]` | `--layer-personal` | hollow outline |

### 5.2 Who sees, posts and edits

"Admin" below means the **admin role** (`user.roles.includes('admin')`), not the `users.admin` key. Layers follow roles; a per-user key override never adds a department layer. `planner.view` gates seeing anything; `planner.edit` gates any write.

| Layer | Sees (with `planner.view`) | Posts to it (with `planner.edit`) | Changes or deletes an event (with `planner.edit`) |
|---|---|---|---|
| Company-wide | everyone | everyone | its owner, admin |
| Install & hardware | everyone | design_pm, scheduling, admin | design_pm, scheduling, admin |
| Accounts | accounts, admin | accounts, admin | accounts, admin |
| Design/PM | design_pm, admin | design_pm, admin | design_pm, admin |
| Scheduling/Production | scheduling, admin | scheduling, admin | scheduling, admin |
| Workshop | scheduling, workshop, admin | scheduling, admin | scheduling, admin |
| Personal | its owner only (admin excluded), and only with `planner.edit` | anyone with `planner.edit`, for themselves | its owner only |

What that gives each role (a user with several roles gets the union):

| Role | Visible | Postable | Default for a new event |
|---|---|---|---|
| admin | all seven (Personal: own only) | all seven | `company` |
| accounts | company, install, accounts, personal | company, accounts, personal | `accounts` |
| design_pm | company, install, design_pm, personal | company, install, design_pm, personal | `design_pm` |
| scheduling | company, install, scheduling, workshop, personal | company, install, scheduling, workshop, personal | `scheduling` |
| workshop | company, install, workshop | none | `null` |
| showroom | none (no `planner.view`) | none | `null` |

Notes:
- "Its creator (while still in the department)" from the plan falls out of the department rule: on a department layer, anyone currently holding that layer's posting role edits; a creator who has lost the role can't. Only Company-wide and Personal look at `owner_id`.
- A user given `planner.view` by an override (no planner role) sees Company-wide and Install & hardware only; given `planner.edit` too, they also post to Company-wide and keep Personal.
- Personal is visible exactly when the user holds `planner.edit`, so workshop logins have no Personal layer and create nothing (Decisions; answer 3).

### 5.3 Signatures (binding)

```js
const LAYERS;   // ['company','install','accounts','design_pm','scheduling','workshop','personal']
const LABELS;   // {company:'Company-wide', install:'Install & hardware', accounts:'Accounts',
                //  design_pm:'Design/PM', scheduling:'Scheduling/Production', workshop:'Workshop', personal:'Personal'}

// user: {id, roles: string[], perms: Set<string>|string[]} (req.user, or userById below).
function visibleLayers(user);            // ids in LAYERS order
function postableLayers(user);           // ids in LAYERS order
function defaultLayer(user);             // admin → 'company'; else the first of accounts, design_pm,
                                         // scheduling that is postable; else 'company' if postable; else null
// ev: a planner_events row ({layer, owner_id}) or {layer, ownerId}.
function canSee(user, ev);               // layer visible AND (layer !== 'personal' OR owner === user.id)
function canEdit(user, ev);              // planner.edit AND canSee AND (personal: owner; company: owner or
                                         // admin; else layer is postable)
// SQL fragment for the hand-made events query: the visible layers (narrowed by `wanted`, an array
// of ids, when given) and the personal-owner rule. alias defaults to 'e'.
function sqlFilter(user, wanted, alias); // {clause: "(e.layer IN (?,?,…) AND (e.layer <> 'personal' OR e.owner_id = ?))", args: [...]}
                                         // an empty layer set gives {clause: '0', args: []}
// For GET /api/planner/layers.
function describe(user);                 // {layers: [{id, label, canPost}], default, canEdit}
// For the sweep (no req.user there). Same rule as lib/auth.js loadUser: null when missing or disabled.
function userById(db, id);               // {id, roles, perms: Set} | null
// Enabled users who can see a non-personal layer, ids ascending. Throws on 'personal'.
function usersWhoSee(db, layer);
```

`perms` may be a `Set` (as `req.user.perms` is) or an array. The module requires only `../permissions` (for `computeEffective`).

## 6. The time model (`lib/time.js`, scaffold)

- Hand-made events are stored as **Sydney wall clock**: a date `YYYY-MM-DD` and, for timed events, `HH:MM` 24-hour. Never UTC. A weekly 9:00 stays 9:00 across daylight saving, and the page shows Sydney time even on a laptop in another zone.
- All repeat and range maths is **calendar maths on date strings** (`addDays`, `parseDateUTC`), never instants.
- Instants are needed only for the bell (§10), through one new helper:

```js
// The UTC instant of Sydney wall-clock `time` ("HH:MM") on `date` ("YYYY-MM-DD").
// A time that doesn't exist (the spring-forward hour, e.g. 02:30 on the first Sunday in October)
// moves an hour later (03:30 AEDT). A time that happens twice (the fall-back hour, 02:00-02:59 on
// the first Sunday in April) uses the first (still AEDT). Throws TypeError on a bad date or time.
function sydneyInstant(date, time);   // → Date
```

**Method (binding):** let `wall` = `Date.UTC(y, m-1, d, h, mi)`. Take the two candidate offsets `offsetAt(wall − 1 day)` and `offsetAt(wall + 1 day)`, where `offsetAt(ms)` = (the Sydney wall clock of `ms`, read through `SYDNEY_CLOCK_FMT`, as UTC ms) − `ms` floored to the minute. For each distinct offset, `t = wall − offset`; keep the `t` whose Sydney wall clock is exactly `date time`. If one or two match, return the earliest. If none match (a gap), return `sydneyInstant` of the wall clock one hour later. Exported beside the existing helpers.

**Fixed values** (the scaffold unit-checks these; the smoke uses them):

| Sydney | `sydneyInstant` | Why |
|---|---|---|
| 2035-10-01 09:00 | 2035-09-30T23:00:00.000Z | AEST (+10) |
| 2035-10-08 09:00 | 2035-10-07T22:00:00.000Z | AEDT (+11); DST starts Sunday 7 Oct 2035 |
| 2035-10-07 02:30 | 2035-10-06T16:30:00.000Z | gap: becomes 03:30 AEDT |
| 2035-10-07 02:00 | 2035-10-06T16:00:00.000Z | gap edge: becomes 03:00 AEDT |
| 2035-04-01 02:30 | 2035-03-31T15:30:00.000Z | overlap: the first (AEDT); DST ends Sunday 1 Apr 2035 |
| 2035-04-01 03:00 | 2035-03-31T17:00:00.000Z | AEST again |
| 2035-10-08 07:00 | 2035-10-07T20:00:00.000Z | the all-day "7:00 on the day" |

(The Sydney change-over Sundays near now: 4 Oct 2026, 5 Apr 2026, 4 Apr 2027, 3 Oct 2027. The smoke uses 2035 so it never collides with today's data.)

## 7. Hand-made events (`lib/planner/events.js`, Wave 1 A)

### 7.1 Rules

- **All-day:** `startDate` to `endDate` inclusive, at most **92 days** (`endDate − startDate ≤ 91`). No times.
- **Timed:** one day only (`endDate = startDate`); `endTime` after `startTime`. If `endTime` is absent it defaults to `startTime` + 60 minutes, capped at `23:59`; a start of `23:59` with no end is a 400. Timed events never cross midnight.
- **Repeat:** `none`, `weekly` (every 7 days from the start date), `fortnightly` (every 14 days from the start date) or `monthly`. An optional `repeatUntil` is the last date an occurrence may **start** (inclusive). A multi-day event repeats with the same length. A repeating event can't be longer than its step: weekly ≤ 7 days, fortnightly ≤ 14 days, monthly ≤ 28 days (span in days, inclusive).
- **Monthly** aims for `repeat_day` (1–31) every month and uses the month's last day when the month is shorter (31 Jan → 28 Feb, or 29 Feb in a leap year → 31 Mar → 30 Apr). `repeat_day` is set from the start date's day when the series is created or its start date is changed; a split copies it (§7.4). For a monthly series, `start_date` must equal `min(repeat_day, days in its month)`.
- **No limit on how far ahead**: occurrences are worked out only inside the range asked for, arithmetically from the first one that can overlap it (never by looping from the series' start).

Occurrence *n* (n ≥ 0) of a series with start `S`, inclusive span `L` days:
- weekly / fortnightly: start `S + n·step`;
- monthly: year/month of `S` plus *n* months, day `min(repeat_day, daysInMonth)`;
- end = start + (L − 1) days;
- it exists when its start ≤ `repeat_until` (or there is no `repeat_until`), and it overlaps `[from, to]` when start ≤ `to` and end ≥ `from`.
- The first candidate *n* for a range: weekly/fortnightly `max(0, ceil((from − (L−1) − S) / step))` days-wise; monthly `max(0, monthsBetween(S, from − (L−1)) − 1)`, stepping forward from there.

### 7.2 One-off changes (exceptions)

- An exception row is keyed by `(event_id, occurrence_date)`, where `occurrence_date` is the occurrence's **original** start date.
- It may change only `title`, `notes`, `startDate`/`endDate` (both, together) and `startTime`/`endTime` (both, together; timed series only). It never changes the layer, job, all-day-ness, repeat or reminder. A field equal to the series' value is stored as NULL.
- `cancelled = 1` hides the occurrence.
- A moved occurrence is shown on its new dates; it keeps its key, so a range that contains its new dates shows it even if the original date is outside the range (the query in §7.5 fetches exceptions by their new dates too), and a range that contains only its original date doesn't.
- A moved all-day occurrence follows the 92-day rule; a moved timed occurrence stays on one day with end after start.

### 7.3 Scope of an edit or delete

The page offers **This one** and **This and all later** (Decisions; settled point 4). The API also takes `all`, the whole series (what the page's "this and all later" on the first occurrence means). For a non-repeating event `scope` and `occurrence` are ignored: every edit is the whole event.

| Scope | Edit (PATCH) | Delete |
|---|---|---|
| `one` | upsert that occurrence's exception with the changed one-off fields (§7.2); any other field in the body → 400 | upsert the exception with `cancelled = 1` |
| `later`, occurrence D after the series' first | **split**, in one transaction: the original's `repeat_until` = D − 1 day; a new event = the original with the edits applied, `start_date` = the edited start or D (end keeping the length unless edited), the same `repeat`, `repeat_day` and `repeat_until` unless edited, `split_from_id` = original id, **`owner_id` = the original's owner**; the original's exceptions on or after D stay with the original and are no longer shown | the original's `repeat_until` = D − 1 day |
| `later` at the first occurrence, or `all` | update the series row itself | soft-delete the row (`removed_at`, `removed_by`) |

- **A whole-series edit that changes `start_date`, `repeat`, `repeat_day` or `all_day`** deletes that series' exception rows in the same transaction (their keys no longer line up; a one-off change keeps the shape it was made in, times on a timed series and dates on an all-day one, so switching All day clears them too, 4.3), and the audit row records `exceptionsCleared: N`. The page warns first (also when All day is switched): "One-off changes to this event will be replaced." (The split's equivalent warning: "Later one-off changes will be replaced.")
- **Layer changes** (scope `later` or `all` only): the new layer must be postable by the user, and `canEdit` must hold on the old row and on the row with the new layer. Moving to or from `personal` is therefore possible only for the owner. Moving to `personal` sets `remind_layer = 0`.
- **Job changes:** setting or changing `jobId` needs `jobs.view` (403 otherwise); leaving it as it is needs nothing.
- **Concurrency:** every PATCH and DELETE carries the series' `updatedAt`; a mismatch is 409. Every write to the series or to any of its exceptions sets the series' `updated_at` to a fresh stamp (the `nextStamp` rule from `lib/tasks.js`: later than the previous one even within the same millisecond) and `updated_by`.

### 7.4 Validation (400 unless said) and error sentences

| Field | Rule | Sentence |
|---|---|---|
| body | a JSON object | `JSON body required` |
| `title` | trimmed, 1–200 characters | `Title is required` / `Title is too long (200 characters at most)` |
| `notes` | string, ≤ 4,000 (trimmed of trailing space only) | `Notes are too long (4,000 characters at most)` |
| `layer` | one of LAYERS | `Unknown layer` |
| `layer` | postable (POST, or a change) | **403** `You can't add events to that layer` |
| `allDay` | boolean | `allDay must be true or false` |
| `startDate`, `endDate` | real dates 2000-01-01 … 2099-12-31 | `startDate must be a date (YYYY-MM-DD)` (and `endDate`) |
| span | `endDate ≥ startDate` | `endDate can't be before startDate` |
| span | ≤ 92 days | `An event can last 92 days at most` |
| times on all-day | absent or null | `An all-day event has no times` |
| `startTime`, `endTime` | `^([01]\d|2[0-3]):[0-5]\d$` | `startTime must be a time (HH:MM)` (and `endTime`) |
| timed order | end after start | `The end time must be after the start time` |
| timed day | `endDate` absent or = `startDate` | `A timed event starts and ends on the same day` |
| `repeat` | none/weekly/fortnightly/monthly/annually/custom (annually added 2026-10-16, custom 2026-10-17) | `repeat must be one of none, weekly, fortnightly, monthly, annually, custom` |
| `repeatEvery`, `repeatUnit` | only with `repeat` custom: a whole number 1 to 99 and day/week/month/year (2026-10-17) | `repeatEvery must be a whole number from 1 to 99` / `repeatUnit must be day, week, month or year` / `repeatEvery and repeatUnit only go with repeat custom` |
| `repeatUntil` | null or a date ≥ start; null when `repeat` is none | `repeatUntil must be a date (YYYY-MM-DD)` / `repeatUntil can't be before the start date` |
| length vs step | §7.1 | `A weekly event can't last longer than a week` / `A fortnightly event can't last longer than two weeks` / `A monthly event can't last longer than 28 days` / `An annual event can't last longer than 28 days` / custom: `An event that repeats every 3 weeks can't last longer than 21 days` |
| `reminder` | timed: null/start/min15/hour1/day1; all-day: null/morning/day_before | `That reminder doesn't fit a timed event` / `That reminder doesn't fit an all-day event` |
| `remindLayer` | boolean; never on personal; needs a reminder | `Personal events can't remind anyone else` / `Choose a reminder first` |
| `jobId` | null or an existing job id | `Unknown job` |
| `jobId` | needs `jobs.view` to set or change; without it, any value other than the current one is a 403 **before** the id is looked up, so a missing id answers the same as a real one (4.3) | **403** `You can't link a job` |
| `updatedAt` (PATCH, DELETE) | required string | `updatedAt is required` |
| `scope` (repeating series) | `one`, `later` or `all` | `scope must be one, later or all` |
| `occurrence` (scope one/later) | a date that is an occurrence of the series (on its rule, ≥ start, ≤ `repeat_until`, not cancelled) | `occurrence must be a date (YYYY-MM-DD)` / `That date isn't an occurrence of this event` |
| scope `one` | only title, notes, dates, times | `Change that for this and all later occurrences` |
| stale | `updatedAt` ≠ stored | **409** `Someone else changed this event. Reload to see it.` with `{event: <series object>}` |

Check order for PATCH and DELETE: (1) 404 if missing, removed or `!canSee`; (2) 403 if `!canEdit`; (3) 400 for `updatedAt`, `scope`, `occurrence`; (4) 409 if stale; (5) 400 field validation; (6) 403 for the new layer or job. POST: body and field 400s, then the 403s.

### 7.5 Signatures (binding; internals A's)

```js
const TITLE_MAX = 200, NOTES_MAX = 4000, SPAN_MAX_DAYS = 92;
const REMINDERS_TIMED = ['start','min15','hour1','day1'];
const REMINDERS_ALL_DAY = ['morning','day_before'];
const REMINDER_LABELS;  // {start:'At the start', min15:'15 minutes before', hour1:'1 hour before',
                        //  day1:'1 day before', morning:'7:00 on the day', day_before:'7:00 the day before'}

// Pure (no db): original occurrence start dates of a series row whose span overlaps [from, to].
function occurrenceDates(series, from, to);           // string[] ascending
function isOccurrence(series, date);                  // boolean (ignores exceptions)
// Pure: effective occurrences overlapping [from, to], exceptions applied, cancelled dropped.
function expand(series, exceptions, from, to);        // [{occurrence, start, end, startTime, endTime, title, notes, changed}]

// Reads. Visibility through layers.sqlFilter(user, wanted). One query for the series (joined to
// users for the owner name and jobs for the job name), one for their exceptions.
// The series query: e.removed_at IS NULL AND the filter AND (
//   (e.repeat = 'none' AND e.start_date <= :to AND e.end_date >= :from)
//   OR (e.repeat <> 'none' AND e.start_date <= :to
//       AND (e.repeat_until IS NULL OR e.repeat_until >= date(:from, '-91 days')))
//   OR e.id IN (SELECT event_id FROM planner_exceptions
//               WHERE cancelled = 0 AND start_date <= :to AND end_date >= :from))
function listOccurrences(db, user, {from, to, layers});         // [occurrence item §9.2]
function listForJob(db, user, jobId, {from, to, limit});        // {rows: [occurrence item], more}
function getSeries(db, user, id);                               // series object §9.3, or throws notFound()

// Writes (each one transaction, audited per §11.2).
function create(db, req, body);                       // series object
function update(db, req, id, body);                   // series object (the new series after a split)
function remove(db, req, id, {scope, occurrence, updatedAt});

// For the sweep: every non-removed series with a reminder, all layers, expanded over [from, to]
// (start dates), with owner_id and layer. Not filtered by any viewer.
function occurrencesForSweep(db, {from, to});         // [{event: row, occ: expand item}]
```

## 8. Automatic events (`lib/planner/auto.js`, Wave 1 B)

Worked out on read (plan §4): one ranged query per source, shaped in memory, nothing stored, no hooks in the source modules. A source is queried only when its layer is in the viewer's visible layers **and** in the `layers` the request asked for. Every automatic item is read-only, has no reminder, and carries `sourceLabel` (shown small, uppercase, letterspaced).

```js
// layers: the effective layer set (visible ∩ requested). today: Sydney date.
function listAuto(db, user, {from, to, today, layers});   // {events: [automatic item §9.2], weeks: [week band §9.2]}
```

**Never exposed** by any source: job values, client names, phones, emails, addresses, inspection hosts or notes, order suppliers or descriptions, leave kind or note, invoice amounts. The queries below don't select them.

**Job filter** (`JOB_LIVE`) for the job-based sources: `j.archived = 0 AND (j.stage IS NULL OR j.stage NOT IN ('lost','archived'))`.

| `source` | Layer | Query (`:from`, `:to` inclusive) | Item | `id` | `sourceLabel` | Link (only when the viewer holds the key) |
|---|---|---|---|---|---|---|
| board weeks | install | `SELECT wr.id, wr.week_start, wr.panel, wr.sort_order, j.id AS job_id, j.name FROM week_rows wr JOIN jobs j ON j.id = wr.job_id WHERE wr.week_start >= mondayOf(:from) AND wr.week_start <= :to ORDER BY wr.week_start, wr.panel, wr.sort_order, wr.id`; plus `SELECT DISTINCT a.week_row_id, a.day FROM assignments a JOIN week_rows wr ON wr.id = a.week_row_id WHERE wr.panel = 'installing' AND wr.week_start >= … AND wr.week_start <= …` | goes in `weeks`, not `events` (below) | — | Board | `jobs.view`: `/job.html?id=N`; else `board.view`: `/schedule.html`; else none |
| `promised_install` | install | `SELECT j.id, j.name, j.promised_install_date AS d FROM jobs j WHERE j.promised_install_date BETWEEN :from AND :to AND JOB_LIVE` | all-day, "Promised install: *job*" | `a:promised_install:<jobId>` | Job | `jobs.view`: `/job.html?id=N` |
| `materials_ordered` | install | same on `materials_ordered_date` | all-day, "Materials ordered: *job*" | `a:materials_ordered:<jobId>` | Orders | `jobs.view`: `/job.html?id=N#orders` |
| `materials_due` | install | `SELECT o.job_id, j.name, o.expected_date AS d, COUNT(*) AS lines FROM orders o JOIN jobs j ON j.id = o.job_id WHERE o.status = 'ordered' AND o.expected_date BETWEEN :from AND :to AND JOB_LIVE GROUP BY o.job_id, o.expected_date` | all-day, "Materials due: *job* (3 lines)" / "(1 line)" | `a:materials_due:<jobId>:<date>` | Orders | `jobs.view`: `/job.html?id=N#orders` |
| `materials_in` | install | same as promised on `materials_in_date` | all-day, "Materials in: *job*" | `a:materials_in:<jobId>` | Orders | `jobs.view`: `/job.html?id=N#orders` |
| `inspection` | install | `SELECT i.id, i.job_id, j.name, i.date, i.time FROM inspections i JOIN jobs j ON j.id = i.job_id WHERE i.status IN ('booked','done') AND i.date BETWEEN :from AND :to AND j.archived = 0` | "Inspection: *job*", timed at `time` (`endTime` null) or all-day when no time | `a:inspection:<id>` | Inspection | `jobs.view`: `/job.html?id=N#inspection` |
| `leave` | company | `SELECT l.id, l.date_from, l.date_to, w.name FROM leave l JOIN workers w ON w.id = l.worker_id WHERE l.removed_at IS NULL AND l.date_to >= :from AND l.date_from <= :to AND w.archived = 0` (never `kind` or `note`) | "*Sam* away", all-day, **one item per run of weekdays** (Mon–Fri) inside both the leave and the range | `a:leave:<leaveId>:<runStart>` | Availability | `scheduling.view`: `/availability.html` |
| `invoice_due` | accounts | `SELECT i.id, i.number, i.due_date, j.id AS job_id, j.name FROM invoices i JOIN jobs j ON j.id = i.job_id WHERE i.status = 'issued' AND i.due_date BETWEEN :from AND :to` | all-day, "*CC-0123* due: *job*"; `overdue: true` when `due_date < today` | `a:invoice_due:<invoiceId>` | Accounts | `accounts.view`: `/accounts.html?invoice=<id>` |
| `invoices_overdue` | accounts | only when `from ≤ today ≤ to`: `SELECT COUNT(*) AS n FROM invoices WHERE status = 'issued' AND due_date < :today`; nothing when 0 | all-day on today, "3 invoices overdue" / "1 invoice overdue", `overdue: true` | `a:invoices_overdue:<today>` | Accounts | `accounts.view`: `/accounts.html?view=overdue` |
| `task_due` | personal (the viewer's own) | `SELECT id, title, due_date FROM tasks WHERE assignee_id = :viewer AND status = 'open' AND due_date BETWEEN :from AND :to` | all-day, "Task due: *title*" | `a:task_due:<taskId>` | Tasks | `tasks.use`: `/tasks.html?task=<id>` |

- Job and task titles are truncated to 120 characters in a title (the full name stays in `job.name`).
- **The board-week band** (`weeks`): one entry per Monday in `[mondayOf(from), to]` that has rows; `manufacturing` and `installing` list each job once (first row's order), with its `link`. An installing job carries `days`: the dates (Mon–Fri of that week, inside `[from, to]`) on which any worker is assigned to it. Regular days off and part-time patterns are not shown; only leave.
- **Who's away covers board workers only** (leave is per board worker); office staff away goes on Company-wide by hand (plan §12 trap 8).

## 9. API (`routes/planner.js`, `defineRoutes('/api/planner')`, scaffold, complete)

The router is thin and complete in the scaffold: it parses the query, calls the library and shapes errors with `sendError(res, e, '[planner]')`. Its handlers reach `events.js`, `auto.js` and `reminders.js`, whose scaffold stubs throw `new HttpError(501, 'Not built')`, so A and B never edit the router. Logged out: 401 (auth layer). Without the key: 403 `{"error":"Forbidden"}`.

### 9.1 Routes

| Route | Access | Behaviour |
|---|---|---|
| `GET /layers` | `planner.view` | 200 `{today, ...layers.describe(user)}` (§9.4) |
| `GET /events?from&to[&layers=a,b]` | `planner.view` | 200 `{from, to, today, events, weeks}`; `events` = hand-made occurrences plus automatic items, sorted (§9.2) |
| `GET /events/:id` | `planner.view` | 200 series object (§9.3); **404** when missing, removed or not visible (never 403) |
| `POST /events` | `planner.edit` | 201 series object |
| `PATCH /events/:id` | `planner.edit` | 200 series object; body `{updatedAt, scope?, occurrence?, ...fields}` |
| `DELETE /events/:id?scope&occurrence&updatedAt` | `planner.edit` | 204; `updatedAt` URL-encoded in the query |
| `GET /job/:jobId` | `planner.view` | 200 `{rows, more}`: the job's hand-made occurrences the viewer can see, from today to today + 89 (Sydney), at most 20; 404 `Not found` when the job doesn't exist, for a viewer with `jobs.view` only: without `jobs.view` a missing job answers 200 `{"rows":[],"more":false}`, the same as a job with nothing on it, so job ids can't be probed (4.3) |
| `POST /reminders/run` | `users.admin` | 200 `{sent, from, to}`; body `{at?: ISO, windowMinutes?: 1–360}` (default now and 360); runs the sweep for `(at − windowMinutes, at]` **without moving the stored mark** (§10) |

Route order inside the file: `/layers`, `/events`, `/events/:id` (GET, PATCH, DELETE), `POST /events`, `/job/:jobId`, `/reminders/run`. `:id` and `:jobId` that are not positive integers → 404.

**Range rules (`GET /events`):** `from` and `to` required real dates (400 `from and to must be dates (YYYY-MM-DD)`); `to ≥ from` (400 `to must be on or after from`); at most **62 days** inclusive (400 `Ask for 62 days at most`). `layers` (optional): comma-separated ids; an unknown id → 400 `Unknown layer: <id>`; ids the viewer can't see are silently dropped (it only narrows). The page asks for the month grid (42 days) and the two weeks (14 days) separately.

**Sort order** (`events`): `start`, then all-day before timed, then `startTime`, then the layer order of §5.1, then `title` (`localeCompare`), then `id`.

**Reminder run (`POST /reminders/run`):** `at` must parse as a date (400 `at must be an ISO time`); `windowMinutes` an integer 1–360 (400 `windowMinutes must be 1 to 360`). No body at all means now and 360.

### 9.2 Item shapes

**Hand-made occurrence:**
```js
{ id: "e:12:2035-10-08",          // e:<eventId>:<occurrence>
  source: "event", sourceLabel: null,
  eventId: 12, occurrence: "2035-10-08",   // the ORIGINAL start date: the key for scope edits
  layer: "company", title, notes,
  allDay: false,
  start: "2035-10-08", end: "2035-10-08",  // effective dates (a moved occurrence shows its new ones)
  startTime: "09:00", endTime: "10:00",     // null when all-day
  repeat: "weekly", repeatUntil: null,
  changed: false,                          // this occurrence has a one-off change
  reminder: "hour1", remindLayer: false,
  job: {id: 7, name: "Smith kitchen"} | null,
  link: "/job.html?id=7" | null,           // only with jobs.view
  createdBy: {id, name},
  updatedAt: "<series updated_at>",
  overdue: false, readOnly: false, canEdit: true }
```

**Automatic item:**
```js
{ id: "a:inspection:41", source: "inspection", sourceLabel: "Inspection",
  eventId: null, occurrence: null,
  layer: "install", title: "Inspection: Smith kitchen", notes: "",
  allDay: false, start: "2035-10-09", end: "2035-10-09", startTime: "10:30", endTime: null,
  repeat: "none", repeatUntil: null, changed: false, reminder: null, remindLayer: false,
  job: {id, name} | null, link: "/job.html?id=7#inspection" | null,
  createdBy: null, updatedAt: null,
  overdue: false, readOnly: true, canEdit: false }
```

**Week band** (`weeks[]`, only when `install` is in the effective layers):
```js
{ weekStart: "2035-10-08",
  manufacturing: [{jobId, name, link}],
  installing:   [{jobId, name, link, days: ["2035-10-08", "2035-10-09"]}] }
```

### 9.3 Series object (`GET /events/:id`, POST, PATCH, and the 409 body)

```js
{ id, layer, title, notes, allDay, startDate, endDate, startTime, endTime,
  repeat, repeatUntil, repeatDay, splitFromId,
  reminder, remindLayer,
  job: {id, name} | null, link: "/job.html?id=N" | null,
  createdBy: {id, name}, createdAt, updatedAt, updatedBy: {id, name} | null,
  canEdit,
  exceptions: [{occurrence, cancelled, title, notes, startDate, endDate, startTime, endTime}] }  // occurrence order
```

### 9.4 Layers response

```js
{ today: "2026-10-11",
  layers: [{id: "company", label: "Company-wide", canPost: true}, ...],   // visible layers only, §5.1 order
  default: "accounts" | null,
  canEdit: true }                                                          // planner.edit
```

## 10. Reminders (`lib/planner/reminders.js`, Wave 1 A)

- **Offsets** (set on the series; every occurrence uses it at its own time):
  - timed: `start` (at the start), `min15` (15 minutes before), `hour1` (1 hour before) — elapsed time before `sydneyInstant(start, startTime)`; `day1` (1 day before) — the **same wall-clock time the day before**, `sydneyInstant(start − 1 day, startTime)`;
  - all-day: `morning` = `sydneyInstant(start, "07:00")`; `day_before` = `sydneyInstant(start − 1 day, "07:00")` (7:00 matches the task reminder).
- **Recipients**, checked **when it fires**: the owner, if `layers.userById` finds them enabled and `canSee` holds; plus, when `remind_layer = 1` (never on personal), `layers.usersWhoSee(db, layer)`. Duplicates once. Someone who has lost the role gets nothing. On Company-wide and Install & hardware "everyone on the layer" includes workshop logins and the TV account (harmless: the TV has no bell).
- **The sweep** `startReminders(db)`, started in `server.js` after `listen` (wrapped in try/catch like the task reminder):
  - off with `PLANNER_REMINDER_DISABLED=1`; a 60 s `setInterval`, `unref()`; started once;
  - **first start:** if `planner.reminder_swept_to` is null, set it to now (`{audit:false}`), log the seeding, send nothing;
  - **each tick:** window = `(max(mark, now − 6 h), now]`; `runSweep(db, {from, to: now})`; then the mark = now. The sends and the mark commit in **one transaction**, so a crash neither loses nor doubles;
  - `runSweep` expands `occurrencesForSweep(db, {from: sydneyDate(from) − 1 day, to: sydneyDate(now) + 2 days})`, computes each occurrence's `fire_at`, keeps those with `from < fire_at ≤ to`, skips occurrences that have **already ended** at `to` (the end is timed: `sydneyInstant(start, endTime)`; all-day: `sydneyInstant(end + 1 day, "00:00")`; taken as `max(end, fire_at)`, and an occurrence counts as ended only when that end is after `fire_at` and at or before `to`, so a start in the spring-forward gap, moved an hour later past its own end time, still reminds, 4.3) and cancelled ones (already dropped by `expand`), then for each recipient `INSERT OR IGNORE INTO planner_reminders_sent` and, only when a row was inserted, `notify.toUser`;
  - **one bad row can't stop the sweep** (4.3): each occurrence's sends run in their own savepoint inside the sweep's transaction, and a failure rolls back only that occurrence and logs `[planner] reminder skipped for event <id>: <code>` (the error's code or name, never its message); a series whose occurrences can't be worked out is skipped the same way;
  - a reminder whose fire time had already passed when the event was made or moved never fires (the window has moved on). Accepted.
- **The admin route** (`POST /api/planner/reminders/run`) calls `runNow(db, {at, windowMinutes})`: `runSweep` for `(at − windowMinutes, at]`, the "already ended" test made against `at`, the mark untouched. Running it twice for the same window sends nothing the second time.

```js
function fireAt(occ, reminder);           // Date | null (pure; uses sydneyInstant)
function runSweep(db, {from, to});        // {sent}; from/to are Dates; one transaction
function runNow(db, {at, windowMinutes}); // {sent, from, to} (ISO strings)
function startReminders(db);
```

## 11. Bell, audit and logs

### 11.1 Bell

| Kind | Title | Body | Link | entityType / entityId |
|---|---|---|---|---|
| `planner.reminder` | timed: "Starting now: *title*, 9:00" / "In 15 minutes: …" / "In 1 hour: …" / "Tomorrow: *title*, 9:00"; all-day: "Today: *title*" / "Tomorrow: *title*" | "*Layer label* · Thu 8 Oct, 9:00–10:00" (all-day: "Thu 8 Oct", or "Thu 8 Oct – Sun 11 Oct") | `/planner.html?date=<effective start>&event=e:<id>:<occurrence>` | `planner_event` / `<id>:<occurrence>` |

Titles are cut at 120 characters. Times are 24-hour "H:MM" (no leading zero). Notes never go in the bell. Personal reminders go only to the owner. No other bell kinds: creating or changing an event notifies nobody (plan §14). Automatic events have no reminders (their sources already alert).

### 11.2 Audit (entity `planner_event`, entity id the series id; actor `req.user`)

| Action | When | before / after (shared layers) |
|---|---|---|
| `planner.event.create` | POST | after: `{layer, title, notes, allDay, startDate, endDate, startTime, endTime, repeat, repeatUntil, reminder, remindLayer, jobId}` |
| `planner.event.update` | whole-series edit (`all`, or `later` at the first occurrence) | changed columns only; plus `exceptionsCleared` when §7.3 cleared any |
| `planner.event.split` | `later` after the first occurrence | entity the original; before `{repeatUntil}`; after `{repeatUntil, newEventId, from: D, changed: {…changed fields}}` |
| `planner.event.delete` | soft delete, or a `later` delete | after `{scope, from?: D}` |
| `planner.event.occurrence.update` | scope `one` edit | after `{occurrence, changed: {…}}` |
| `planner.event.occurrence.delete` | scope `one` delete | after `{occurrence}` |

**Personal events are redacted** (plan trap 2: admin holds `audit.view`). When the row is `personal` before **or** after the change, both before and after hold only `{layer: "personal", fields: [names of the changed fields]}` (plus `newEventId` on a split and `scope` on a delete). Never the title, notes, dates, times, occurrence date or job. Admin can see that a personal event was made, changed or deleted, and by whom, but nothing in it. Reminder sends are not audited (they are their own record).

### 11.3 Logs

Prefix `[planner]`. Allowed: counts, window bounds, event ids, layer ids, error messages from code. **Never** a title, notes, job name or worker name (personal content must not reach the container log). Examples: `[planner] first start: reminder mark seeded to 2026-10-12T03:00:00.000Z, nothing sent`; `[planner] reminders: 3 sent (2026-10-12T02:59:00.000Z to 2026-10-12T03:00:00.000Z)` (only when > 0); `[planner] reminder sweep failed: <message>`; `[planner] reminder skipped for event 42: TypeError` (4.3: one occurrence, by id and code only).

## 12. The Planner page (Wave 1 C: `public/planner.html`, `planner.css`, `planner.js`)

Built against §9's shapes. Until A and B merge the API answers 501, so C develops against stubbed responses in headless Edge (as Backup's D stubbed `/api/backup/status`) and against the real routes once Wave 1 is merged at 4.1.

**Frame.** `planner.html` follows `lookahead.html`: `tokens.css` (linked first, as `invoice.html` does, so the shell doesn't append it after `planner.css` and its `html` ground beat the print rule; 4.3), `index.css` then `planner.css`, `<div id="cc-shell">`, `shared.js`, `planner.js`, `shell/shell.js`; `<main class="dash">`. Title "Planner - Crosscuts". Page classes prefixed **`pl-`**; the shell keeps `cc-`; never `ph-`. All user text through `textContent`. Dialogs use the shell's `cc-dialog` styling (`<dialog class="cc-dialog pl-dialog">`). Passes `node ci/style-check.js`.

**Loading.** `GET /api/planner/layers` first (gives `today`, the layers and the default), then two event requests: the month grid (`from` = the Monday on or before the 1st, 42 days) and the two weeks (this Sydney Monday, 14 days). "Today" always comes from the server's `today`, never the browser's clock. After any save or delete, both are fetched again. Prev / Today / Next move the month only; the two-week view always stays on this week and next.

**Layout: the fortnight is the hero (Todd, 2026-10-11; supersedes the 4.3 month-first layout).** From **1280 px** the two weeks take about two thirds of the width on the left and the month about one third on the right, both in view at once (seven tiles are about 110 px wide at 1280, 125 at 1440, 167 at 1920; the page is up to 1880 px wide). From **641 to 1279 px** the two weeks go full width on top, still seven tiles a row, and the month full size underneath. **Phone (640 px and below):** below.
- **Two weeks (the hero):** two rows, "This week" (the Monday-to-Sunday week holding the server's today) and "Next week", each under a section bar with its range ("THIS WEEK 5–11 Oct") and that week's board band ("Manufacturing: A, B" / "Installing: C", only when Install & hardware is on) directly above its row. Each row has **all seven day tiles**, empty ones included ("Nothing on." quietly). Tiles are taller than the month cells (at least 176 px; a row grows to its tallest tile) and show each item in full: the when line ("9:00–10:00"; automatic timed items only the start; "All day"; "12–14 Oct" for an item over several days, which appears on every day it covers), the title over up to three lines, the source label on automatic items and the layer name, small, with the layer marker; overdue in red. All-day items first, then timed items in time order; an installing job's assigned days also show "Installing: *job*" (Board). Up to **six** items a tile on screen, then "+N more" (the day's dialog). Today's tile is ringed in teal. With `planner.edit` and a postable layer, a small outlined "Add" button and the tile's empty area start New event on that date; workshop logins get neither.
- **Month (the side, slightly smaller):** six week rows, Monday to Sunday, day numbers; days outside the month dimmed (`--muted`); today ringed in teal. At the top of each week row, the board-week band from `weeks`, in small body text (only when Install & hardware is on). Then up to **three** items per day, multi-day items as bars across the week row, then "+N more" (a button that lists the day in a dialog). In the side column the cells are compact (smaller type and chips, no source labels; below 1680 px the start time also goes so the title shows). Prev / Today / Next move only the month. **Clicking a day number** that falls in the two weeks scrolls that tile into view and highlights it; any other day opens its day dialog. Clicking an empty part of a day opens New event on that date (with `planner.edit`).
- **Item chips:** the title in white or body text on the surface, the time before it for timed items, a small uppercase letterspaced `sourceLabel` on automatic items, and the layer **marker**: a 3 px left edge in `var(--layer-<id>)`; Personal has a 1 px outline in `var(--layer-personal)` and no filled edge. Invoice items with `overdue` show "overdue" and their text in `var(--stop-tint)` (red only for overdue). No other use of layer colours.

**Layer buttons** along the top: outlined uppercase `hs-btn` buttons, one per visible layer, each with its marker, `aria-pressed` when on. Off hides that layer's items everywhere (grid, two weeks, print). The choice is remembered per user in `localStorage` key `cc.planner.layersOff.<userId>` (a JSON array of the ids switched **off**, so a newly visible layer starts on); every read and write in try/catch; all on when nothing is stored or storage fails. Switching doesn't refetch (the page holds everything the viewer may see).

**Event detail** (a dialog): title, layer label, when ("Thu 8 Oct, 9:00–10:00"; "Mon 8 Oct – Fri 12 Oct"), repeat ("Every week until 30 Nov" / "Every month"), reminder label, the job (a link when `link`), notes (text, line breaks kept), "Added by *name*", and **Edit** and **Delete** when `canEdit`. Automatic items show their `sourceLabel` and an **Open** link (when `link`) instead.

**New / Edit event** (a dialog; New needs `planner.edit`, the button hidden otherwise):
- Title; Layer (a select of `canPost` layers only, pre-selected: the last used, from `localStorage` key `cc.planner.lastLayer.<userId>` if still postable, else `default`);
- All day (checkbox). All-day: Start date and End date. Timed: Date, Start time and End time (end defaults to an hour after start);
- Repeats (Never / Every week / Every two weeks / Every month) with Until (optional date);
- Reminder (the offsets that fit all-day or timed, from §7.5's labels) and, on shared layers only, "Remind everyone on this layer" (never on Personal);
- Job: the tasks job picker (`/api/job-records?archived=0`), shown only with `jobs.view`;
- Notes.
- **Editing an occurrence of a repeating event** first asks "This one" or "This and all later" (no "All" button). "This one" disables Layer, All day, Repeats, Until, Reminder and Job with the note "Change these for this and all later." The split warning ("Later one-off changes will be replaced.") and the whole-series warning ("One-off changes to this event will be replaced.") show before saving when they apply.
- **Delete** asks the same question for a repeating event, otherwise "Delete this event?".
- Errors show the server's `{error}` in the dialog (`role="alert"`). A 409 shows the server's sentence and reloads the event.

**Deep links.** `?date=YYYY-MM-DD` opens that date's month; `&event=<item id>` (the bell's link) opens that item's detail once loaded, or shows "That event isn't on the planner any more." in a status line.

**Phone (640 px and below).** The two weeks come first, as a list of days (this week then next, every day shown, "Nothing on." on empty ones, each with its Add button). The month becomes a compact grid of day numbers, each with up to three 6 px marker **dots** (Personal: a hollow dot) and a count; tapping a day lists it below the grid. The layer buttons sit in a collapsible row ("Layers"). No horizontal scroll at 375 px.

**Print / PDF.** A **Print** button asks "Month" or "Two weeks", adds `pl-print-month` or `pl-print-weeks` to `<body>`, writes `@page { size: A4 landscape; margin: 10mm; }` (both; the two weeks were portrait until 2026-10-11) into a `<style id="plPageSize">`, calls `window.print()`, and removes the class on `afterprint`. Save as PDF comes from the browser, as for invoices. The print CSS sits between `/* style-check: print-start */` and `/* style-check: print-end */`: black on white; the shell, toolbar, layer buttons, dialogs and the other view hidden; **no markers**; every item prefixed with its layer name in brackets (`[Accounts] 9:00 Site meeting`); the month fits **one A4 landscape page however busy** (4.3): every item and board-band line on one line (cut with an ellipsis), up to **four** items a day then "+N more" as text, and every week row the same fixed height; the two weeks print in their two-row layout on A4 landscape (seven day columns a row, every item, each run on as one line with its layer name in brackets and wrapping inside its day), on one page when they fit, otherwise a page a week (a week row never splits); only layers switched on are printed; a footer lists them and the print date: "Layers: Company-wide, Accounts. Printed 11 Oct 2026."

**House style.** Ink ground, surface cards, white and body text, teal for actions and today, red only for overdue invoices, Arial 400/700, uppercase letterspaced, no icons, no emoji, no shadows. The markers are the planner's named exception (§13) and appear nowhere else.

## 13. House style: tokens, CLAUDE.md and the style check (scaffold)

**`public/tokens.css`**, in `:root` after the colour roles, under a comment naming the exception. Each is an existing token; no new hex value:

```css
  /* Planner layer markers: the named exception in CLAUDE.md "Look and feel" (Todd, 2026-10-11).
     Used only by planner.html, planner.css and planner.js; ci/style-check.js enforces that. */
  --layer-company: var(--teal);
  --layer-install: var(--orange);
  --layer-accounts: var(--label);
  --layer-design: var(--violet);
  --layer-scheduling: var(--fuchsia);
  --layer-workshop: var(--muted);
  --layer-personal: var(--label);  /* drawn as a hollow outline, never a fill; the quiet label grey (M7 · 4.3) */
```

(4.3, Todd: Personal's outline moved from `--body` to the quieter `--label`, so it reads no louder than the other layers. CLAUDE.md's exception text names no colour for Personal, so it is unchanged.)

**`CLAUDE.md`, "Look and feel"** (the plan's 1.3 step said this lands with the decisions; it hasn't, so the scaffold makes it). Replace the line

> - **Two named exceptions, both approved by Todd on 2026-10-10. There are no others.**

with

> - **Three named exceptions, approved by Todd (the first two on 2026-10-10, the third on 2026-10-11). There are no others.**

and add, after the "Board icons" bullet, at the same indent:

> - **Planner layer markers (approved by Todd 2026-10-11):** on the Planner page only (`planner.html`, `planner.css`, `planner.js`), each layer's events carry a small marker (a 3 px left edge on chips and bars, a 6 px dot in compact cells) in its layer colour: teal, violet, fuchsia, orange, two greys, and a hollow outline for Personal, from the `--layer-*` tokens. Event text stays white or body on the surface. Print shows the layer name in words, black on white.

**`ci/style-check.js`.** The header's exception list gains a line:

```js
//   - planner layer markers: the --layer-* tokens, only in planner.html, planner.css and
//     planner.js (approved by Todd on 2026-10-11)
```

and the "approved by Todd on 2026-10-10" line becomes "approved by Todd on 2026-10-10 and 2026-10-11". One new constant and one new check, run on the line **after comments are stripped but before** `var(--…)` references are collapsed (the existing rules see `var()` only, so they can't see a layer token):

```js
const LAYER_OK = new Set(["tokens.css", "planner.html", "planner.css", "planner.js"]);
// …inside lines.forEach, replacing the single `const line = …` statement:
    const code = raw.replace(/\/\*.*?\*\//g, "").replace(/^\s*(\/\/|\*|\/\*).*$/, "").replace(/<!--.*?-->/g, "");
    if (/--layer-/.test(code) && !LAYER_OK.has(rel)) {
      problems.push(`${rel}:${i + 1}: planner layer token outside the planner: ${raw.trim().slice(0, 140)}`);
    }
    // Token references (var(--orange)) are how colours should be used.
    const line = code.replace(/var\(--[\w-]+\)/g, "var()");
```

`rel` is the path relative to `public/` (so `shell/shell.css` or `index.js` fail; only the four top-level files pass). The rule is not exempted inside print blocks. The scaffold proves it locally: the whole tree passes; a planted `color: var(--layer-company);` in `index.css` fails with that message; removing it passes again.

## 14. Menu, home tile, job page and docs (Wave 2 D)

### 14.1 Menu (`public/shell/shell.js`)

`LINK_GROUPS` gains, **first**: `{ label: "Planner", items: [{ label: "Planner", href: "/planner.html", key: "planner.view" }] }`. Re-measure the bar with the full admin link set at 1100, 1280, 1365, 1366, 1440, 1600, 1680 and 1920 px, and the phone Menu at 375 px; if anything overlaps, adjust `shell.css` breakpoints (D then owns `shell.css` too) and report the widths in the commit. A workshop login sees two links (Planner, Board).

### 14.2 Home tile (`public/index.{html,js}`, `index.css` `ix-` additions)

Under "Your work", a **Planner** tile (`id="ix-planner"`, shown with `planner.view`; it also unhides `work-section`): `GET /api/planner/events?from=<today>&to=<tomorrow>` (today from the response), the first **6** `events` (the `weeks` band is not shown), each a link to `/planner.html?date=<start>&event=<id>` showing "Today" or "Tomorrow", the time (or "All day"), the title and the layer label **in words** (no markers: the exception is the Planner page only). Overdue invoice items use the existing `ix-overdue` red. Empty: "Nothing on today or tomorrow." Error: "The planner could not be loaded." Button: "Open planner".

### 14.3 Job page (`public/job.{html,js}`, `jobs.css` `jo-` additions)

A **Planner** section `<section id="planner" class="jo-sec">` after Inspection (shown with `planner.view`): `GET /api/planner/job/:id`; a `hs-table` of date (and time), title, layer label in words, and "Open" (`/planner.html?date=<start>&event=<id>`); "And more on the planner" when `more`; empty: "Nothing on the planner for this job." Same layer rules as the planner, so nobody sees another person's personal events or another department's events here. No markers.

### 14.4 Docs

`docs/how-to-add-user.md`, "Roles, in plain English", gains: "**Workshop:** the board and the Planner (Company-wide, Install & hardware and Workshop, read-only). For the workshop TV and workshop logins. It can't edit the board: if the TV account must, give it a **Grant** override for `board.edit`." (`docs/auth.md` is the scaffold's, §4.)

## 15. Tests

All smoke files follow the M-suite rules: sourced by `ci/smoke.sh`, no shebang, no `set`, the shared helpers (`step`, `req`, `hdr`, `expect_status`, `expect_jq`, `expect_eq`, `expect_refused`, `jqr`, `create_user`, `login`, `own_password`, `new_jar`, `fail`, `ok`), `step "m7-…"` first, prefixed variables (`M7E_`, `M7A_`, `M7X_`), no pristine-DB assumption, and **far-future dates (2035)** so the live reminder timer and today's data never meet them. Step b's logged-out sweep gives every new route its 401.

### 15.1 `ci/smoke.sh` (scaffold)

After the M6 loop and before the Backup suite:

```bash
# M7 (docs/plans/m7-contracts.md section 15.1): three more users, then the M7 suites.
# $WORK is the temp directory, so the workshop jar is $WSHOP.
create_user wshop "CI Workshop" "Tmp-Wshop-Passw0rd-1" workshop
WSHOP_ID=$CREATED_ID
create_user acct2 "CI Accounts Two" "Tmp-Acct2-Passw0rd-1" accounts
ACCT2_ID=$CREATED_ID
create_user multi "CI Accounts and Design" "Tmp-Multi-Passw0rd-1" accounts
MULTI_ID=$CREATED_ID
req PATCH "/api/users/$MULTI_ID" "$ADMIN" '{"roles":["accounts","design_pm"]}'
expect_status 200 "multi gets two roles"
WSHOP="$WORK/jar-wshop"; ACCT2="$WORK/jar-acct2"; MULTI="$WORK/jar-multi"
for j in "$WSHOP" "$ACCT2" "$MULTI"; do new_jar "$j"; done
login "$WSHOP" wshop "Tmp-Wshop-Passw0rd-1"; expect_status 200 "login wshop"
own_password "$WSHOP" "Tmp-Wshop-Passw0rd-1" "Wshop-Passw0rd-1"
login "$ACCT2" acct2 "Tmp-Acct2-Passw0rd-1"; expect_status 200 "login acct2"
own_password "$ACCT2" "Tmp-Acct2-Passw0rd-1" "Acct2-Passw0rd-1"
login "$MULTI" multi "Tmp-Multi-Passw0rd-1"; expect_status 200 "login multi"
own_password "$MULTI" "Tmp-Multi-Passw0rd-1" "Multi-Passw0rd-1"
for f in "$(dirname "$0")"/smoke-m7-*.sh; do [ -f "$f" ] && source "$f"; done
```

The scaffold also adds, in step d after the showroom preset: `GET /api/users/meta` as admin → `.roles` includes `"workshop"`, `.keys | length == 23`, `.presets.workshop == ["board.view","planner.view"]`; and after the users above, `GET /api/auth/me` as wshop → `.user.roles == ["workshop"]`. (Creating `wshop` at all proves 017: before it, the CHECK refused the role.) Step k (cutover rehearsal) must still pass: the old app's database is migrated through 017 and 018 there. The container keeps the planner timer on (far-future dates make it harmless); the M7 files check its seeding line in `docker logs`.

### 15.2 `ci/smoke-m7-events.sh` (Wave 1 A), `step "m7-events. hand-made events, repeats and reminders"`

- **Create and read:** acct creates an all-day Company-wide event, a 3-day all-day Accounts event, a timed Accounts event (end defaulting to an hour later), and a Personal event linked to a job → 201 each, with the series shape (§9.3). `GET /events` over a 2035 range lists each once with the right `start`, `end`, `startTime`, `endTime`; `GET /events/:id` returns `exceptions: []`.
- **Validation:** each 400 sentence in §7.4 that a body can trigger (title empty and 201 characters, notes 4,001, 93-day span, end before start, times on all-day, `24:00`, end time = start time, a timed event over two days, a weekly 8-day event, an all-day `hour1` reminder, `remindLayer` on personal, `remindLayer` without a reminder, an unknown `jobId`); acct posting to Install → 403; a job link as a user without `jobs.view` is covered in §15.4.
- **Range:** 63 days → 400 `Ask for 62 days at most`; 62 → 200; `to < from` → 400; `layers=nope` → 400.
- **Weekly across daylight saving:** a timed weekly Company-wide event, Monday 2035-10-01 09:00–10:00 → `GET /events?from=2035-09-24&to=2035-10-21` shows 10-01, 10-08 and 10-15, each `09:00`.
- **Fortnightly:** from 2035-10-01 → 10-01, 10-15, 10-29 in October, nothing on 10-08.
- **Monthly with clamping:** from 2035-01-31 → 01-31, 02-28, 03-31, 04-30; one from 2036-01-31 → 2036-02-29; `repeatUntil` 2035-03-31 → no April.
- **This one:** move the weekly's 10-08 occurrence to 2035-10-09 11:00–12:00 and retitle it → 10-08 gone, 10-09 shows the new title with `changed: true` and `id` `e:<id>:2035-10-08`; a range of just 10-09 includes it, a range of just 10-08 doesn't. Delete scope one on 10-15 → gone, 10-22 still there.
- **This and all later:** on the monthly 31st series at the 2035-04-30 occurrence, retitle with scope `later` → the original's `repeatUntil` is `2035-04-29`; a new series with `splitFromId` = the original, start `2035-04-30`, `repeatDay` 31; May shows 2035-05-31 with the new title. Repeat on the weekly at 10-22 → the 10-09 exception still shows (it's before the split).
- **All:** scope `all` on a weekly with an exception, moving its start date → 200, `exceptions` empty, and the audit row has `exceptionsCleared: 1`.
- **Delete scopes:** `later` at the third occurrence → `repeatUntil` = the day before; `later` at the first → the series is gone (404 on GET).
- **Concurrency:** two PATCHes with the same `updatedAt` → the second is 409 with the sentence and `.event.id`; an exception write changes the series' `updatedAt`.
- **Reminders** (`POST /reminders/run` as admin; as acct → 403):
  - the weekly with `hour1`: run at `2035-10-07T21:00:30Z` window 5 → `sent ≥ 1`, and acct has an unread `planner.reminder` whose link is `/planner.html?date=2035-10-08&event=e:<id>:2035-10-08` and title starts "In 1 hour:"; the same run again → `sent == 0`; a run at `2035-10-07T22:00:30Z` window 5 (the naive, wrong-offset instant) sends nothing for it;
  - `day1` on 10-08 09:00 → fires at `2035-10-06T22:00:00Z`; `start` on an event at 2035-10-07 02:30 (the gap) → fires at `2035-10-06T16:30:00Z`; `min15` once; all-day `morning` on 2035-10-08 → `2035-10-07T20:00:00Z`; `day_before` → `2035-10-06T20:00:00Z`;
  - a cancelled occurrence never fires; an occurrence moved later fires at its new time;
  - **remind everyone on this layer:** acct2 makes an Accounts event with `remindLayer` → the run alerts acct, acct2, multi and admin, and not dpm or sched; a Personal event's reminder reaches only its owner;
  - **re-checked at send:** a throwaway accounts user `m7rem` makes an Accounts event with a reminder; admin PATCHes `m7rem`'s roles to `["design_pm"]`; the run sends `m7rem` nothing.
- **Audit:** admin `GET /api/audit?entityType=planner_event&entityId=<shared id>` has `planner.event.create` with the title; for acct's Personal event the rows exist but neither the title, the notes nor `"09:` appears anywhere in the body, and `after_json` holds only `layer` and `fields`.
- **Timer:** `docker logs "$CONTAINER"` contains `[planner] first start: reminder mark seeded`.

### 15.3 `ci/smoke-m7-auto.sh` (Wave 1 B), `step "m7-auto. automatic events"`

All on jobs and rows it creates itself in a 2035 range (`M7A_` names), through the existing routes only:
- **Each source on its layer:** a job with `promisedInstallDate` (`PATCH /api/job-records/:id`), materials marked ordered (`POST /api/job-records/:id/materials-ordered`), two order lines `ordered` with the same expected date and one with another, every line received (materials in), a booked inspection with a time and one without, a board row in each panel for a 2035 week with a worker assigned Tue and Thu on the installing row, leave for a worker over a Saturday (two weekday runs), an issued invoice due in range and one overdue (made through the M2 routes as `smoke-m2-invoices.sh` does; if the routes can't backdate a due date, set it with `docker exec … node` and `better-sqlite3`, CI only, as `bk_rewind` does), and an open task assigned to acct due in range. Each appears once with the §8 title, layer, `id`, `sourceLabel`, `readOnly: true`, `canEdit: false`; `materials_due` says "(2 lines)"; the board band lists both jobs and `days` is exactly the Tue and Thu dates; the leave comes back as two items.
- **Nothing private:** the leave items' JSON (the whole response) contains neither the leave `kind` nor its `note` text; no response contains the job's client name, value or address, the inspection host, or the order supplier.
- **Stays in step:** change the order line's expected date → the next `GET` shows it on the new date only; cancel the inspection → gone; remove the leave → gone; mark the invoice paid → gone; mark the task done → gone; archive the job → its promised install is gone; move the board row to another week → the band follows.
- **Who sees what:** invoices only for acct, acct2, multi and admin (never dpm, sched or wshop, whatever `layers=` says); the overdue line on today only for those, and only when the range covers today; the task only for acct (not admin); leave and the job-based items for every planner role including wshop.
- **Links per viewer:** sched gets `link` `/job.html?id=N#orders` on materials items; wshop gets `link: null` on every job-based item, `/schedule.html` on the band, and no Availability link; acct gets `/accounts.html?invoice=<id>`.

### 15.4 `ci/smoke-m7-access.sh` (Wave 2 E), `step "m7-access. layer visibility and privacy"`

- **Layers per role** (`GET /layers`): exactly the §5.2 table for admin, acct, dpm, sched, wshop and multi (multi: company, install, accounts, design_pm, personal; default `accounts`); show → 403.
- **Seed:** one event per layer by a permitted poster (company by acct, install by dpm, accounts by acct, design_pm by dpm, scheduling by sched, workshop by sched, personal by acct and by admin), all in one 2035 week.
- **The visibility matrix:** for each of admin, acct, acct2, dpm, sched, wshop and multi, the hand-made ids in `GET /events` for that week are exactly the expected set, and `GET /events/:id` is 200 for each visible one and **404** for each hidden one (including admin on acct's personal, and dpm on the accounts event).
- **Writes:** wshop → 403 on POST, PATCH and DELETE; show → 403; acct → 403 posting to install, design_pm, scheduling or workshop; sched → 201 on workshop; acct2 edits acct's Accounts event → 200; acct2 on acct's Personal → 404; acct2 on acct's Company-wide → 403; admin on acct's Company-wide → 200; sched edits dpm's Install event → 200; dpm deletes sched's Workshop event → 404 (dpm can't see Workshop).
- **Layer moves:** acct moves its own Company-wide event to Personal → 200, and then admin gets 404 on it; acct2 tries to move acct's Accounts event to Personal → 403.
- **`layers` narrows only:** dpm `?layers=accounts,design_pm` → only design_pm items; acct `?layers=accounts` → no company items.
- **Job page route:** acct's personal event linked to a job → `GET /job/:jobId` lists it for acct, not for admin or acct2; an unknown job → 404 for admin (who has `jobs.view`; without it the answer is 200 `{"rows":[],"more":false}`, 4.3); a job link by wshop is impossible (no `planner.edit`), and by a user with `planner.edit` but `jobs.view` revoked by override → 403 `You can't link a job` (then remove the override).
- **Pages:** `/planner.html`, `/planner.css`, `/planner.js` → 200 for admin, acct, dpm, sched and wshop; `/planner.html` → 403 for show; `planner.css` contains `style-check: print-start` and `@media print`.
- **No leak through the bell:** after a personal reminder run, only the owner has a `planner.reminder` for it.

### 15.5 Local checks (every task)

Docker isn't on the dev box (and no jq), so smoke files get `bash -n` only; CI is their real run. Every task: `node --check` on its JS, `node ci/style-check.js`, a shim boot on a fresh `.dev/<task>/` (`REMINDER_DISABLED=1 ROUNDUP_DISABLED=1 BACKUP_SCHEDULE_DISABLED=1`, plus `PLANNER_REMINDER_DISABLED=1` unless testing the timer) and `fetch` calls against its routes. In addition:
- **Scaffold:** 017 on a fresh `.dev/m7/` and on a copy of the latest local test database (§2); the `sydneyInstant` table in §6 as a node unit check; `layers.js` against the §5.2 tables for every role and for override-only users; the style-check rule proved (§13); `GET /api/planner/layers` per role; every other planner route 501.
- **A:** a node unit check of `occurrenceDates`/`expand` (weekly, fortnightly, monthly from the 29th, 30th and 31st, leap years, multi-day overlaps at both range edges, a series from 2027 viewed in 2035 costing the same, moved and cancelled exceptions, a split), `fireAt` against §6's values, and the sweep's window and dedupe with fixed times.
- **B:** a node unit check of the leave weekday runs (a run across a weekend, a range edge, a one-day Saturday leave giving nothing) and of the board `days`.
- **C:** headless-Edge screenshots at 1440, 1100 and 375 with stubbed responses (busy month, empty month, all seven layers, overdue invoices, a moved occurrence), the layer toggles surviving a reload, both print previews (Edge print to PDF: A4 landscape month, A4 portrait two weeks, black on white, layer names in brackets, no markers), keyboard reach of every button and dialog.
- **D:** the menu bar widths (§14.1), the home tile and the job page section with real data on the merged Wave 1.
- **E:** headless-Edge screenshots of the merged page at 1440, 1100 and 375 and both print previews, kept under `.dev/` (not committed), listed in its report.

## 16. Waves and file ownership

**Two build waves** (M7 · 3.1 and 3.2).

| Step | Who | Owns (only these files) | Depends on |
|---|---|---|---|
| **M7 · 2.2 Scaffold** | integrator | `db/migrations/017_workshop_role.js`, `db/migrations/018_planner.sql`, `lib/permissions.js`, `lib/settings.js` (one key), `lib/time.js` (`sydneyInstant`), `lib/pages.js`, `lib/planner/layers.js` (complete), `lib/planner/{events,reminders,auto}.js` (stubs with the binding signatures and constants; `startReminders` a no-op), `routes/planner.js` (complete), `server.js`, `public/tokens.css`, `public/users.js` (one label), `ci/style-check.js`, `CLAUDE.md` (the exception), `docs/auth.md`, `ci/smoke.sh` (§15.1), `tools/screenshots/shoot.js` (`["planner", "/planner.html", 1440, true]`, `["planner-1100", "/planner.html", 1100, true]`, `["phone-planner", "/planner.html", 375, true]`) | — |
| **M7 · 3.1 Wave 1, A: hand-made events and reminders** | worktree | `lib/planner/events.js`, `lib/planner/reminders.js`, `ci/smoke-m7-events.sh` | scaffold |
| **M7 · 3.1 Wave 1, B: automatic events** | worktree | `lib/planner/auto.js`, `ci/smoke-m7-auto.sh` | scaffold |
| **M7 · 3.1 Wave 1, C: the page** | worktree | `public/planner.html`, `public/planner.css`, `public/planner.js` | scaffold (codes against §9 with stubbed responses) |
| **M7 · 3.2 Wave 2, D: menu, home tile, job page, docs** | worktree | `public/shell/shell.js` (and `shell.css` only if the bar needs it), `public/index.{html,js}`, `public/index.css` (`ix-` additions), `public/job.{html,js}`, `public/jobs.css` (`jo-` additions), `docs/how-to-add-user.md` | Wave 1 merged |
| **M7 · 3.2 Wave 2, E: the access smoke and screenshots** | worktree | `ci/smoke-m7-access.sh` | Wave 1 merged; in parallel with D |
| **M7 · 4.1 Integrate** | integrator | merges; `tools/screenshots/seed.js` (planner sample data); STATUS; `CLAUDE.md` Layout gains `lib/planner/`; the timing check (a seeded year: a month's `GET /events` under 100 ms on the shim) | all |

**Merge order:** Wave 1: A, B, C (no shared files; any order). Wave 2: D, then E. A task that needs a change in a scaffold file (`layers.js`, `routes/planner.js`, `time.js`, the migrations, `tokens.css`, `style-check.js`, `smoke.sh`) reports it; the integrator makes it on `main`. **Migrations 017 and 018 are applied in `.dev` at the scaffold and are never edited after that**; a wave that finds a schema problem reports it, and the fix is a new numbered migration.

**Worktree base:** agent worktrees have been created at an old commit before. Each agent runs `git log -1` first and resets to the scaffold commit the integrator names, and junctions `crosscuts/app/node_modules` from the main checkout (unlinking the junction before the worktree is removed).

**Not in any wave:** the board files, `public/shared.js`, `public/lookahead.*`, the source modules' write paths, the old app, and anything in `tenon-umbrel-store` (5.2 only, with Todd's go). No pushes.

## 17. Findings and to check

**Decided in these contracts** (integrator's calls, for Todd's attention only if he disagrees):
1. **Workshop sees three layers** (Company-wide, Install & hardware and Workshop, read-only), per Decisions 1. The plan's §3 and §13 smoke text ("only Company-wide and Install & hardware") predate that decision.
2. **The workshop smoke jar is `$WSHOP`**, not the plan's `$WORK`: `$WORK` is already `smoke.sh`'s temp directory. The M7 users (`wshop`, `acct2`, `multi`) are made once in `smoke.sh`, so all three M7 files share them.
3. **An exception can't switch an occurrence between all-day and timed** (and so the exceptions table has no `all_day` column, unlike the plan's list). A reminder's offset then always fits its occurrence. To change that, edit "this and all later".
4. **`repeat_day` column** for monthly series, so a split at a clamped occurrence (30 April of a 31st series) keeps aiming for the 31st afterwards.
5. **The API takes `scope: one | later | all`.** The page shows only "This one" and "This and all later" (no All button, as decided); `all` is the whole series, which is what "this and all later" from the first occurrence does.
6. **A whole-series edit that moves the start date or changes the rule deletes that series' one-off changes** (their keys no longer line up), audited with a count, and the page warns first. The plan only covered the split case.
7. **Personal is visible exactly with `planner.edit`.** That is what keeps workshop logins out of Personal without naming roles.
8. **On department layers edit rights follow the current role** (the plan's "creator while still in the department" falls out). Only Company-wide and Personal use the owner.
9. **A split keeps the original owner**, so a Company-wide series split by admin stays editable by its creator.
10. **"1 day before" on a timed event is the same clock time the day before**, not 24 hours (they differ by an hour across a change-over).
11. **Board weeks come back in their own `weeks` array**, not as events, so the page can draw them as a band; leave of archived workers is not shown.
12. **`routes/planner.js` is complete in the scaffold** (thin), so A and B never share a file. The Users page "Workshop" label also moved to the scaffold (the plan had it in D), since the role exists from 2.2.
13. **The menu entry is a one-item "Planner" group first in `LINK_GROUPS`**, so it shows before the groups and in the phone Menu.
14. **The job page list covers the next 90 days, 20 items.**
15. **Layer toggles store the layers switched off**, so a layer gained later starts on.
16. **Audit action names** are `planner.event.occurrence.update` and `.delete` (prefix-consistent, so `?action=planner.event` finds them all). `DELETE` carries `updatedAt` in the query string.
17. **Repeating events can't outlast their step** (weekly ≤ 7 days, fortnightly ≤ 14, monthly ≤ 28), so a series never overlaps itself.
18. **The timing check moves to 4.1** (it needs A and B's code); the plan had it at 2.2.
19. **The smoke keeps the planner timer on** and uses 2035 dates, so it also checks the first-start seeding line.
20. **`CLAUDE.md` still lists two named exceptions** although the plan's 1.3 step said it would gain the third; the scaffold adds it with the wording in §13.

**To check** (couldn't verify from here):
1. **Foreign keys during migrations.** `node:sqlite` opens with enforcement on (checked); `better-sqlite3` is believed to be compiled with `SQLITE_DEFAULT_FOREIGN_KEYS=1` but that wasn't checked in the image. 017 is written to work either way. The comment in `db/index.js` saying enforcement starts after the migrations is inaccurate (a comment fix for a later change, not M7).
2. **017 on Todd's real database** runs for the first time at 6.1 (after the automatic backup). The orphan check stops it, unchanged, if `user_roles` has a row for a missing user; users are never hard-deleted today, so none is expected.
3. **The image's ICU** gives `Intl` the Australia/Sydney rules for 2035 (the existing code already relies on it for today). The smoke's daylight-saving reminder checks prove it in CI.
4. **The menu bar at 1100–1600 px** with one more link (plan trap 7): D measures it.
5. **Print page size switching** by writing `@page` before `window.print()` in Edge and Chrome (Todd's browsers); C checks Edge locally, 6.1 checks a real PDF.
6. **Load on a busy month:** the month grid shows at most three items a day; whether Install & hardware is too busy in real use is a 6.1 look (it can be switched off).
7. **Invoice backdating in smoke:** whether the M2 routes can make an issued invoice already past due; B falls back to a CI-only `docker exec` write if not.
8. **Reminders to the TV account** on "remind everyone" for Company-wide and Install & hardware write bell rows nobody reads. Harmless; noted for 6.1.

**Changed at 4.3 (review fixes, Todd's calls where named):**
1. **Switching All day on a whole series clears its one-off changes** (§7.3), counted in `exceptionsCleared`, and the page shows "One-off changes to this event will be replaced." when All day changes too. Before, a moved occurrence kept its old shape: a timed series made all-day lost its morning reminder on that occurrence, and an all-day multi-day series made timed could show one occurrence across midnight.
2. **The job route doesn't confirm job ids to viewers without `jobs.view`** (§9.1): a missing job answers 200 `{"rows":[],"more":false}` for them (404 still for anyone with `jobs.view`), and linking a job without `jobs.view` is a 403 before the id is looked up (§7.4), so a missing id and a real one answer the same.
3. **Reminders** (§10): the "already ended" test uses `max(end, fire_at)`, so a start in the spring-forward gap still reminds; each occurrence runs in its own savepoint and a failure is logged by event id and code only (§11.3), so one bad row can't stop every reminder.
4. **Layout (Todd):** side by side from 1440 px with the two-week column as tall as the month and scrolling on its own; below 1440 px the month on top and the two weeks underneath (§12). The phone layout is unchanged.
5. **Print:** `planner.html` links `tokens.css` first and the print rule outranks the ink ground in any order, so html and body print white; the month prints four items a day, one line each, with fixed week rows, so a busy month fits one A4 landscape page with its footer (§12).
6. **Personal's outline is `--label`** (Todd), no louder than the other layers (§13).

**Changed after 4.3, Todd 2026-10-11: the fortnight is the hero.** "Make the month grid slightly smaller; the hero is the two weeks. Present the fortnight in two rows, one week per row, all days present even if empty. Make these tiles taller than the monthly, as they will display more detail." He chose the fortnight on the left (about two thirds) and the month on the right (about one third), both in view on a desktop. This supersedes 4.3's item 4 (month-first, side by side from 1440 px). As built (§12): side by side from 1280 px; 641–1279 px the two weeks full width on top (seven tiles) and the month underneath; the phone a list of days then the compact month; the two weeks print as two rows on one A4 landscape page (the month print unchanged).

**Added 2026-10-16: annual repeat (migration 027).** Planner events can repeat `annually` as well as weekly, fortnightly and monthly.
- **Storage:** the `repeat` CHECK in 018 can't be widened without a table rebuild, so 027 adds one column, `planner_events.repeat_months INTEGER NOT NULL DEFAULT 1 CHECK (repeat_months IN (1,12))`. An annual event is stored as `repeat = 'monthly'`, `repeat_day = <the day>`, `repeat_months = 12`; every older row reads as 1 and is unchanged. `repeat_months = 12` is only ever set together with `repeat = 'monthly'` (the code does it; there is no table check).
- **API and page:** `lib/planner/events.js` translates at the edge (`rowRepeat` on read, `storedRepeat` on write), so callers send and receive `repeat: "annually"` and never see the column. The new sentence is `repeat must be one of none, weekly, fortnightly, monthly, annually`; an annual event can't last longer than 28 days (`An annual event can't last longer than 28 days`). The page's Repeats select gains "Every year".
- **Rule:** the same month and day each year from the start date, using the monthly clamp: a 29 Feb series falls on 28 Feb in a year that isn't a leap year and on 29 Feb in one that is. `repeatUntil`, one-off changes and cancellations (`scope=one`), splits (`scope=later`), whole-series edits and deletes behave as for monthly; switching between monthly and annually is a whole-series edit and clears the one-off changes (it changes `repeat`). The reminder sweep and the job page's list use `expand` in the same file, and the dashboard tile and the page read the API, so none of them needed a change; no other code reads `planner_events.repeat`.
- **Smoke:** `ci/smoke-m7-events.sh`, section "annual repeats" (create, years of occurrences, leap day, `repeatUntil`, a timed annual event, one-off move and cancel, split, whole-series edit and back, delete scopes). The route still allows 62 days a request, so the suite asks month by month.

**Added 2026-10-17: custom repeat (migration 030).** Planner events can repeat "every N days / weeks / months / years" (every 3 weeks, every 10 days, every 6 months, every 2 years). The five existing options (Does not repeat, Weekly, Fortnightly, Monthly, Every year) are unchanged.
- **Storage:** no table rebuild, so 030 adds two columns, `planner_events.repeat_unit TEXT` (day/week/month/year) and `repeat_every INTEGER` (1 to 99), both NULL or both set (CHECK), and `repeat_every` may be 1 only for days (CHECK). A custom day or week repeat is stored as `repeat = 'weekly'` (`repeat_day` NULL); a custom month or year repeat as `repeat = 'monthly'`, `repeat_day = <the day>`, `repeat_months = 1`. Every older CHECK still holds, and every older row has NULL in both new columns.
- **API and page:** `lib/planner/events.js` translates at the edge again (`rowRepeat` returns `custom` whenever `repeat_unit` is set; `storedRepeat` writes the columns). Callers send and receive `repeat: "custom"`, `repeatEvery: N`, `repeatUnit: "day"|"week"|"month"|"year"` on the series and on every occurrence item; both are null for the other repeats. `repeatEvery` is a JSON integer (not a digit string) from 1 to 99. They may be sent only with `repeat: "custom"` (400 otherwise). On a PATCH of an already-custom event, whichever of the two is left out keeps its value. They are not one-off fields: a `scope=one` PATCH that changes them is the usual `Change that for this and all later occurrences`.
- **N = 1:** "every 1 week / month / year" has a plain option, so the server saves it as Weekly, Monthly or Every year (`repeat` comes back `weekly`/`monthly`/`annually`, `repeatEvery` and `repeatUnit` null) rather than refusing the typed number. "Every 1 day" has none, so it stays custom (the page says "Every day"). The limit check runs after that, so it uses the plain option's limit.
- **Rule:** days: the start plus k x N days (weekends included); weeks: the same weekday every N weeks (N x 7 days); months: the same day of the month every N months from the start, clamped to the month's end as monthly is (31st: 28 Feb, back to the 31st); years: the same month and day every N years (29 Feb is 28 Feb in a year that isn't a leap year). Internally the monthly, annual and custom month/year rules are one rule (a step in months: 1, 12, N, 12N) and weekly, fortnightly and custom day/week another (a step in days: 7, 14, N, 7N), in `stepOf`.
- **Length:** an event can't last longer than its step for days and weeks (N days, N x 7 days), so occurrences never overlap, and 28 days for months and years (as monthly and annual). The 400 sentence is `An event that repeats every <N> <unit>s can't last longer than <D> days` (`every day ... 1 day` for every 1 day), e.g. `An event that repeats every 3 weeks can't last longer than 21 days`.
- **Everything else:** `repeatUntil`, one-off moves and cancellations (`scope=one`), splits (`scope=later`, which may change N or the unit for the new half), whole-series edits and deletes, switching between custom and any other option (a whole-series edit; it changes `repeat` or the rule, so it clears the one-off changes), the reminder sweep, the 62-day range, the dashboard tile and the job page's list (the last three read `expand`/the API and needed no change) behave as for the other repeats. The audit `fields` list can now name `repeatEvery` and `repeatUnit`.
- **Page:** the Repeats select gains "Custom..."; choosing it shows a row "Every [number] [days|weeks|months|years]" (starting at 2 weeks; the unit reads singular for 1) and editing a custom event shows its values. The label reads "Every 3 weeks" (with "until ..." when there is an end) in the detail dialog and the edit dialog's note. House style as everything else on the page (an outlined number box and select, no icons).
- **Smoke:** `ci/smoke-m7-events.sh`, section "custom repeats" (3-weekly across a span with and without an end, 14-day events every 2 weeks, every 10 days timed with a reminder, move, cancel and split with a new interval, every 6 months from the 31st with cancel and delete scopes, every 2 years from 29 Feb, every day, every 1 week/month/year as the plain options, switching between custom and weekly/annual/never, and the 400 sentences).
