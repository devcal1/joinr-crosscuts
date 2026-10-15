# M13 interface contracts: Owner-only (binding for all M13 subagents)

Read `docs/plans/m13-plan.md` first. Its **Decisions** (section 5, 1–8) are binding and win over its sections 2 and 4; its **Lead's defaults** (section 4) hold where section 5 is silent. This file is the *what*.

Everything in `m1-contracts.md` … `m12-contracts.md` and `backup-contracts.md` still holds:
- UTC ISO timestamps with milliseconds, Sydney `YYYY-MM-DD` business dates.
- `defineRoutes`, audit, `lib/httperror.js`, errors as `{error}`, money in integer cents.
- Dates in refusal sentences are written `d Mon yyyy` ("16 Oct 2026"), money `$1,234.56`.

If a contract looks wrong, report it instead of working around it. Points the integrator decided while writing this file are in §13; Todd can change any of them.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), Node 24, no build step, no framework.

**This repo is public, and these are the most private pages in Crosscuts.** Smoke, screenshot and seed data use made-up names and figures only (`M13 Test Job`, `M13 Person`, `M13 Alarm Co`, `M13 Lender`). No code, password, account number, rate, balance, bonus figure, lender or staff name from the workbook appears in code, docs, tests or screenshots.

**Version.** M13 ships as **0.1.17**. The scaffold bumps `crosscuts/app/package.json` and the root version in `crosscuts/app/package-lock.json`; there's no further bump during the build.

**Not touched in M13:**
- The board files (`schedule.*`, `workers.html`, `exportJpg()`, `alignPanels()`) and `public/shared.js`.
- Roles: no role is added and `user_roles` is not rebuilt. "Owner" is a mark on a login, not a role (lead's default 1).
- The Planner and `lib/planner/layers.js` (layers follow roles; the owner-only keys play no part in them), chat channels, comments (`lib/comments.js` keeps `TYPES = ["task", "job"]`), tasks and notices: **M13 sends no notice and creates no task, comment or Planner item** (lead's default 3).
- Pay runs: bonuses stay out of the pay run (Decision 5). `lib/payroll.js` changes only by exporting two existing helpers (§1, Problem 3).
- `lib/backup/`: nothing changes. The alarm code key file is an ordinary `CONFIG_DIR` file and already goes into every archive (§5.1).
- Migrations 001–025.
- tenon-quotr (CLAUDE.md rule 12): nothing in M13 needs a Joinr change. The quoted hours are doubled back on the Crosscuts side (§4.5).

## Problems for the integrator

Checked against the code on 2026-10-16. None blocks the build; each has a resolution in this file, and items 1 and 2 need Todd's yes or no.

1. **An owner-only key granted to someone else is only as safe as that person's password reset.** The plan guards the owner's own login, but any `users.admin` holder can today reset any other user's password (`routes/users.js` `POST /:id/password`) and then sign in as them. If the owner grants `loans.manage` to an Accounts login, a non-owner admin could reset that login's password and read the loans. **This file adds a guard** (§3.4): only the owner may reset the password of a login that holds an owner-only key by override. Disabling that login or signing it out stays open to admins (they only take access away). Todd to confirm.
2. **The bonus price and GST.** A job's value (`jobs.value_cents`) is **including GST** (it comes from Joinr's `valueIncGstCents`). The workbook's "Total Price" doesn't say which it is. This file prefills a new bonus's price from the job's value **as stored (inc GST)**, editable per bonus (§4.4). If Todd's rate is meant on the ex-GST price, the prefill becomes `round(value ÷ 1.1)` (a one-line change in `lib/bonuses.js`). Todd to confirm.
3. **`pay_people` rows for board workers are created lazily** (M8: a worker with no row counts as on the pay run), and `lib/payroll.js` doesn't export the helpers that find or create them. Bonus holders, who ran or checked a job, and alarm holders all key on `pay_people.id`, so the scaffold **exports `ensureWorkerRow` and `personById`** from `lib/payroll.js` (no behaviour change). Pickers send `{personId}` or, for a worker with no row yet, `{workerId}` (§4.2).
4. **The intake contract's two copies would differ.** M11 kept `docs/integrations/joinr-crosscuts-intake.md` identical in both repos. Lead's default 8 adds the "factory and site are halved" line to the **Crosscuts copy only**; the tenon-quotr copy follows only if Todd okays a Joinr change. Noted so nobody "fixes" the difference by editing tenon-quotr.
5. **A database restore without `--config` makes the alarm codes unreadable.** `tools/restore.js db` restores `config/` only with `--config` (backup-contracts §13). The plan says a restore needs both; `docs/restore.md` must say so plainly (integrator, 4.1). Also, plainly stated: the key file sits beside the database in `data/config/` and in the same archive, so the encryption protects the codes in the **plain pre-migration copies** and in the database file on its own, not against someone holding the Umbrel or the backup passphrase (as the plan's §2.1 limit already says).

## 1. Files and owners

| File | What it is | Owner |
|---|---|---|
| `db/migrations/026_owner_only.sql` | `users.is_owner` with its backfill, and every new table (§2), complete | scaffold |
| `lib/permissions.js` | three keys, `OWNER_ONLY_KEYS`, the admin preset, `computeEffective`'s owner argument (§3.1), complete | scaffold |
| `lib/payroll.js` | exports `ensureWorkerRow` and `personById` (no other change) | scaffold |
| `lib/pages.js` | five page gates (§9) | scaffold |
| `public/shell/shell.js` | Admin: Bonuses, Alarms; Accounts: Loans; `PAGE_ALIASES` (§9) | scaffold |
| `server.js` | `require("./routes/bonuses")`, `("./routes/alarms")`, `("./routes/loans")` after `stone` | scaffold |
| `routes/bonuses.js`, `routes/alarms.js`, `routes/loans.js` | every route of §7 declared with its access value; handlers 501 (the two summaries answer empty, §7) | scaffold, then B / C / D |
| `lib/bonuses.js`, `lib/alarms.js`, `lib/alarmcode.js`, `lib/loans.js` | the binding exports of §4–§6 as stubs throwing 501 | scaffold, then B / C / C / D |
| `public/bonuses.html`, `bonusprint.html`, `alarms.html`, `loans.html`, `loanprint.html` | placeholder pages (the shell and an `h1`) so the gates and menu can be checked | scaffold, then E / E / F / F / F |
| `ci/smoke.sh` | the M13 source loop (§11.1) | scaffold |
| `crosscuts/app/package.json`, `crosscuts/app/package-lock.json` | 0.1.17 | scaffold |
| `lib/auth.js` (`loadUser`, `publicUser`), `routes/auth.js` (setup), `routes/users.js`, `lib/notify.js` (`usersWithKey`), `lib/audit.js` (§3.6 exports), `routes/audit.js` | the owner, its guards, transfer, the audit filter (§3) | A |
| `ci/smoke.sh` (the two key counts and the admin preset line, §11.1), `ci/smoke-m13-owner.sh` | §11.2 | A |
| `lib/bonuses.js`, `routes/bonuses.js`, `ci/smoke-m13-bonuses.sh` | §4, §7.1, §11.3 | B |
| `lib/alarmcode.js`, `lib/alarms.js`, `routes/alarms.js`, `ci/smoke-m13-alarms.sh` | §5, §7.2, §11.4 | C |
| `lib/loans.js`, `routes/loans.js`, `ci/smoke-m13-loans.sh` | §6, §7.3, §11.5 | D |
| `public/users.{html,css,js}`, `public/bonuses.{html,css,js}`, `public/bonusprint.{html,css,js}` | §10.1–§10.3, §8.1 (prefixes `us-`, `bo-`, `bp-`) | E |
| `public/alarms.{html,css,js}`, `public/loans.{html,css,js}`, `public/loanprint.{html,css,js}`, `public/index.{js,html,css}` (the leavers line only) | §10.4–§10.7, §8.2 (prefixes `al-`, `ln-`, `lp-`) | F |
| `docs/auth.md`, `docs/how-to-add-user.md`, `docs/how-to-add-feature-key.md` (the admin preset is every key **except** the owner-only ones), `docs/restore.md` (Problem 5), `docs/integrations/joinr-crosscuts-intake.md` (Crosscuts copy, Problem 4), `docs/plans/menu-plan.md`, `docs/crosscuts-brief.md` §3 (Todd's sign-off as in M10), new `docs/how-to-bonuses.md`, `docs/how-to-alarm-codes.md`, `docs/how-to-loans.md`, `tools/screenshots/seed.js`, `tools/screenshots/shoot.js`, `ci/smoke-backup.sh` (one assertion, §11.6) | docs, screenshots, made-up data | integrator, 4.1 |

**Boundaries.**
- Every rule about who may do what lives in `lib/` or in the route file that owns it (`routes/users.js` keeps its own rules, as now). Routes declare only the coarse access value; pages hide controls but never decide access.
- Every write runs in one `db.transaction` with its audit row. Every function in `lib/bonuses.js`, `lib/alarms.js`, `lib/alarmcode.js` and `lib/loans.js` takes `db` first and never requires `../db`.
- **No alarm code ever appears** in a log line, an error message, an audit row, a notice, a URL, a GET response or a page's markup before Show. Only `POST …/reveal` answers with one (§5.3). Nothing under `lib/alarmcode.js` may throw an `Error` whose message holds a code or the key, because `sendError`'s 500 path logs the whole error.

## 2. Migration `026_owner_only.sql` (scaffold)

Additive only: one column on `users` (with its backfill and a partial unique index), new tables, and the seed rows of three single-row or fixed-row tables. No existing row changes except the one `is_owner` set to 1.

```sql
-- M13 Owner-only (docs/plans/m13-contracts.md section 2). Additive only: users.is_owner and its
-- backfill, and new tables for bonuses, alarm holders and loans.

-- The owner -----------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1));
-- At most one owner, ever. "Exactly one" is kept by the code (section 3.4).
CREATE UNIQUE INDEX idx_users_one_owner ON users(is_owner) WHERE is_owner = 1;

-- Backfill: the first-run setup user (the auth.setup audit row) while still an enabled admin; else
-- the earliest-created enabled admin; else the earliest admin. A database with no users (fresh, or
-- the old app's) gets nobody, and first-run setup marks the owner (section 3.3).
UPDATE users SET is_owner = 1 WHERE id = (
  SELECT u.id
    FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'admin'
   ORDER BY COALESCE(u.disabled = 0 AND u.id = (SELECT CAST(a.entity_id AS INTEGER) FROM audit_log a
                                                  WHERE a.action = 'auth.setup' ORDER BY a.id LIMIT 1), 0) DESC,
            u.disabled ASC, u.created_at ASC, u.id ASC
   LIMIT 1);

-- Bonuses -------------------------------------------------------------------------------------
-- The rate (one row).
CREATE TABLE bonus_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (rate_bp BETWEEN 0 AND 10000),   -- basis points of the price
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id)
);
INSERT INTO bonus_settings (id, rate_bp) VALUES (1, 0);

-- Who shares a job's bonus, and their points (the share total is the sum, never typed).
CREATE TABLE bonus_holders (
  person_id INTEGER PRIMARY KEY REFERENCES pay_people(id),
  points INTEGER NOT NULL CHECK (points BETWEEN 0 AND 1000),
  sort INTEGER NOT NULL
);

-- One bonus per job.
CREATE TABLE bonuses (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents BETWEEN 0 AND 10000000000),
  ran_by INTEGER REFERENCES pay_people(id),          -- who ran the job
  checked_by INTEGER REFERENCES pay_people(id),      -- who checked it
  quoted_factory_min INTEGER CHECK (quoted_factory_min IS NULL OR quoted_factory_min BETWEEN 0 AND 600000),
  quoted_install_min INTEGER CHECK (quoted_install_min IS NULL OR quoted_install_min BETWEEN 0 AND 600000),
  actual_factory_min INTEGER CHECK (actual_factory_min IS NULL OR actual_factory_min BETWEEN 0 AND 600000),
  actual_install_min INTEGER CHECK (actual_install_min IS NULL OR actual_install_min BETWEEN 0 AND 600000),
  quoted_from_joinr INTEGER NOT NULL DEFAULT 0 CHECK (quoted_from_joinr IN (0, 1)),
  check_drawn INTEGER NOT NULL DEFAULT 0 CHECK (check_drawn IN (0, 1)),
  check_ordered INTEGER NOT NULL DEFAULT 0 CHECK (check_ordered IN (0, 1)),
  check_assembled INTEGER NOT NULL DEFAULT 0 CHECK (check_assembled IN (0, 1)),
  check_installed INTEGER NOT NULL DEFAULT 0 CHECK (check_installed IN (0, 1)),
  check_no_fuss INTEGER NOT NULL DEFAULT 0 CHECK (check_no_fuss IN (0, 1)),
  check_on_time INTEGER NOT NULL DEFAULT 0 CHECK (check_on_time IN (0, 1)),
  check_hours INTEGER CHECK (check_hours IS NULL OR check_hours IN (0, 1)),  -- NULL: follow the suggestion
  note TEXT NOT NULL DEFAULT '',
  -- Frozen at confirm (section 4.4):
  confirmed_date TEXT,                               -- Sydney date (typed; default today)
  rate_bp INTEGER,
  possible_cents INTEGER,
  earned_cents INTEGER,
  shares_json TEXT,                                  -- [{personId, name, points}] and the total
  confirmed_at TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  CHECK ((status = 'draft' AND confirmed_date IS NULL AND rate_bp IS NULL AND possible_cents IS NULL
          AND earned_cents IS NULL AND shares_json IS NULL AND confirmed_at IS NULL)
      OR (status = 'confirmed' AND confirmed_date IS NOT NULL AND rate_bp IS NOT NULL AND possible_cents IS NOT NULL
          AND earned_cents IS NOT NULL AND shares_json IS NOT NULL AND confirmed_at IS NOT NULL
          AND price_cents IS NOT NULL AND check_hours IS NOT NULL))
);
CREATE INDEX idx_bonuses_status ON bonuses(status);

-- Each holder's share of a confirmed bonus (only shares above 0 cents), and its payment.
CREATE TABLE bonus_shares (
  bonus_id INTEGER NOT NULL REFERENCES bonuses(id),
  person_id INTEGER NOT NULL REFERENCES pay_people(id),
  points INTEGER NOT NULL,
  share_cents INTEGER NOT NULL CHECK (share_cents > 0),
  paid_date TEXT,                                    -- Sydney date
  pay_run_id INTEGER REFERENCES pay_runs(id),        -- optional: which pay run it went in
  paid_at TEXT,
  paid_by INTEGER REFERENCES users(id),
  PRIMARY KEY (bonus_id, person_id),
  CHECK ((paid_date IS NULL) = (paid_at IS NULL)),
  CHECK (paid_date IS NOT NULL OR pay_run_id IS NULL)
);
CREATE INDEX idx_bonus_shares_person ON bonus_shares(person_id);

-- Alarms --------------------------------------------------------------------------------------
-- A user slot on the alarm panel. The code is AES-256-GCM ciphertext (section 5.1); never plain.
CREATE TABLE alarm_slots (
  id INTEGER PRIMARY KEY,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 999),
  person_id INTEGER REFERENCES pay_people(id),       -- a staff holder ...
  holder_name TEXT,                                  -- ... or a typed name (temp, cleaner, outsider)
  holder_type TEXT NOT NULL CHECK (holder_type IN ('office', 'staff', 'temp')),
  given_date TEXT,
  removed_date TEXT,                                 -- set: the slot is no longer in use
  note TEXT NOT NULL DEFAULT '',
  code_ct TEXT,                                      -- base64 ciphertext
  code_iv TEXT,                                      -- base64, 12 bytes
  code_tag TEXT,                                     -- base64, 16 bytes
  code_key_id TEXT,                                  -- which key (section 5.1), 16 hex
  code_set_at TEXT,
  code_set_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  CHECK ((person_id IS NULL) <> (holder_name IS NULL)),
  CHECK ((code_ct IS NULL) = (code_iv IS NULL) AND (code_ct IS NULL) = (code_tag IS NULL)
     AND (code_ct IS NULL) = (code_key_id IS NULL) AND (code_ct IS NULL) = (code_set_at IS NULL)),
  CHECK (removed_date IS NULL OR code_ct IS NULL)    -- a removed slot keeps no code
);
-- A slot number is unique among slots in use.
CREATE UNIQUE INDEX idx_alarm_slots_active ON alarm_slots(slot) WHERE removed_date IS NULL;

-- The alarm company (one row). No monitoring password, by design (Decision 6).
CREATE TABLE alarm_company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id)
);
INSERT INTO alarm_company (id) VALUES (1);

-- The weekly times: arms in the evening, disarms in the morning (Decision 6). 1 = Monday.
CREATE TABLE alarm_times (
  day INTEGER PRIMARY KEY CHECK (day BETWEEN 1 AND 7),
  arms_at TEXT,                                      -- HH:MM or NULL
  disarms_at TEXT,                                   -- HH:MM or NULL
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id)
);
INSERT INTO alarm_times (day) VALUES (1), (2), (3), (4), (5), (6), (7);

-- Loans ---------------------------------------------------------------------------------------
CREATE TABLE loans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('lent_to_business', 'lent_by_business')),
  other_party TEXT NOT NULL DEFAULT '',
  opening_balance_cents INTEGER NOT NULL CHECK (opening_balance_cents BETWEEN 0 AND 10000000000),
  opening_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

-- The annual rate from a date (the rate history).
CREATE TABLE loan_rates (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  from_date TEXT NOT NULL,
  rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 5000),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  UNIQUE (loan_id, from_date)
);

-- A repayment: principal and interest paid on a date. The balance is never stored.
CREATE TABLE loan_repayments (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  paid_date TEXT NOT NULL,
  principal_cents INTEGER NOT NULL CHECK (principal_cents BETWEEN 0 AND 10000000000),
  interest_cents INTEGER NOT NULL CHECK (interest_cents BETWEEN 0 AND 10000000000),
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  CHECK (principal_cents + interest_cents > 0)
);
CREATE INDEX idx_loan_repayments_loan ON loan_repayments(loan_id, paid_date, id);
```

The runner's `VACUUM INTO` backup runs first as always. The scaffold proves 026 on a fresh `.dev/m13/` (no users: nobody marked), on a copy of the latest local test database (the setup user marked, `foreign_key_check` clean, every other row unchanged) and on a made-up database where the setup user is disabled (the earliest enabled admin is marked).

## 3. The owner and the keys

### 3.1 `lib/permissions.js` (scaffold, complete)

`KEYS` gains three keys, **appended**: `"bonuses.manage"`, `"alarms.manage"`, `"loans.manage"`, making **30 keys**.

```js
// M13 (docs/plans/m13-contracts.md section 3): owner-only keys. The admin preset doesn't get them;
// the owner holds every key; only the owner grants or revokes them.
const OWNER_ONLY_KEYS = ["bonuses.manage", "alarms.manage", "loans.manage"];
const OWNER_ONLY_SET = new Set(OWNER_ONLY_KEYS);

const PRESETS = {
  admin: KEYS.filter((k) => !OWNER_ONLY_SET.has(k)),   // 27 keys
  // every other preset unchanged
};

// isOwner true: every key, whatever the roles and overrides.
function computeEffective(roles, overrides, isOwner = false) { ... }

module.exports = { KEYS, ROLES, PRESETS, OWNER_ONLY_KEYS, computeEffective };
```

- **The owner's keys** are all 30, regardless of roles or overrides (`computeEffective(…, true)` returns `new Set(KEYS)`). The owner keeps the admin role as well (lead's default 1; §3.4 keeps it so).
- **Anyone else** gets their roles' presets, then overrides, as now. An override granting an owner-only key works like any other override; it can only have been set by the owner (§3.4).
- **What each key opens:**

| Key | Opens |
|---|---|
| `bonuses.manage` | The Bonuses page and print: settings, every job bonus, confirming, paying, the summary (§4, §7.1). Bonus audit rows (§3.6). |
| `alarms.manage` | The Alarms page: holder slots, **Show** a code, set or clear codes, the alarm company, the weekly times; the leavers line on the dashboard (§5, §7.2). Alarm audit rows. |
| `loans.manage` | The Loans page and statement print: loans, rates, repayments (§6, §7.3). Loan audit rows. |

One key per area, no view/edit pair: each area has one or two people who both read and record, and a read-only split has no user yet. The owner can give an Accounts login `loans.manage` alone (Decision 7).

### 3.2 Who holds the keys at runtime (A)

- **`lib/auth.js` `loadUser`** reads `users.is_owner` and returns `isOwner: boolean`; `perms = computeEffective(roles, overrides, isOwner)`. **`publicUser`** adds `isOwner`.
- **`routes/users.js` `shapeUser`** adds `isOwner` and passes it to `computeEffective`.
- **`lib/notify.js` `usersWithKey`** selects `is_owner` and passes it, so the owner counts as a holder of every key (M13 sends no notice for its own keys, but this keeps "holder" one rule everywhere).
- **`lib/planner/layers.js`** is not changed: its two `computeEffective` calls only test planner keys, which the owner already has through the admin role.

### 3.3 First-run setup (A, `routes/auth.js`)

`POST /api/auth/setup` inserts the user with `is_owner = 1` in its existing transaction, so the first admin is always the owner. Nothing else in setup changes.

A database with users but no owner can only be one that had no admin at all when 026 ran (the last-admin rule has kept at least one enabled admin since M1, so this shouldn't exist). Then nobody holds the owner-only keys and every "only the owner" guard refuses everyone. **No "claim ownership" route is added**; fixing such a database is a hand step for Todd (one `UPDATE`), to be written in `docs/auth.md`'s recovery note if it's ever needed.

### 3.4 The users routes (A, `routes/users.js`)

**Check order on every route below:** 404 (no such user) → the 403 owner guards → the existing validation (400) and rules (409). "The owner" is the user with `is_owner = 1`; "the actor" is `req.user`.

| Route | When | Answer |
|---|---|---|
| `PATCH /api/users/:id` (any field: display name, roles, disabled) | the target is the owner and the actor isn't | 403 `"Only the owner can change the owner's login"` |
| `POST /api/users/:id/password` | the target is the owner and the actor isn't | 403 `"Only the owner can reset the owner's password"` |
| `POST /api/users/:id/password` | the target holds an owner-only key **by a grant override** and the actor isn't the owner | 403 `"Only the owner can reset the password of someone holding <key>"` (the first such key in `KEYS` order) (Problem 1) |
| `POST /api/users/:id/sessions/revoke` | the target is the owner and the actor isn't | 403 `"Only the owner can sign the owner out"` |
| `PUT` or `DELETE /api/users/:id/overrides/:key` | the target is the owner and the actor isn't | 403 `"Only the owner can change the owner's login"` |
| `PUT` or `DELETE /api/users/:id/overrides/:key` | `key` is owner-only and the actor isn't the owner | 403 `"Only the owner can grant or revoke <key>"` |
| `PUT /api/users/:id/overrides/:key` | the target is the owner (so the actor is the owner) | 409 `"The owner holds every key, so overrides don't apply"` |

- `DELETE` of an override **on the owner, by the owner** is allowed (it clears a leftover from before M13, or from before a transfer).
- The existing self rules keep the owner an enabled admin: "You can't disable your own account" and "You can't remove your own admin role" (409) already apply to the owner acting on themselves, and nobody else may act on the owner. So **there is always exactly one owner, and the owner is always an enabled admin.**
- `POST /api/users` ignores any `isOwner` in the body (unknown fields are ignored there, as now).

**Ownership transfer** (new): `POST /api/users/:id/owner`, access `users.admin`, body `{confirmUsername, password}`.

| Check (in this order) | Answer |
|---|---|
| no such user | 404 |
| the actor isn't the owner | 403 `"Only the owner can hand over ownership"` |
| body not an object, or `confirmUsername`/`password` not strings | 400 `"confirmUsername and password are required"` |
| the target is the actor | 409 `"You're already the owner"` |
| the target is disabled or hasn't the admin role | 409 `"The new owner must be an enabled admin"` |
| `confirmUsername` isn't the target's username (case-blind, trimmed) | 400 `"Type <username> to confirm"` |
| `password` isn't the actor's current password (`verifySecret` against the actor's `password_hash`) | 403 `"That password isn't right"` |

Then, in one transaction: the old owner's `is_owner = 0`, then the target's `is_owner = 1` (the partial unique index needs that order), both `updated_at`. Audit `user.owner`, entity `user`, entity id the new owner: before `{ownerId: <old>}`, after `{ownerId: <new>}`. No sessions are ended. Answers 200 `{from: <user>, to: <user>}` (both shaped as `GET /api/users`). The old owner stays an admin and keeps only the admin preset's 27 keys unless the new owner grants them owner-only keys.

**`GET /api/users/meta`** answers `{roles, keys, presets, ownerOnlyKeys, ownerId}` (`ownerId` null only in §3.3's edge). **`GET /api/users`** and every user object gain `isOwner`. **`GET /api/auth/me`** (and login, setup, unlock, which use `publicUser`) gain `user.isOwner`.

### 3.5 What the guards don't cover (stated in `docs/auth.md`)

- Someone with the Umbrel itself, or the backup passphrase, can read the database (bonuses and loans in plain; alarm codes with the key file beside them). The guards protect the figures **inside Crosscuts** only (plan §2.1).
- A non-owner admin can still disable a holder of an owner-only key, or sign them out (that only takes access away), and can read every other part of Crosscuts as before.

### 3.6 The audit log (A, `lib/audit.js`, `routes/audit.js`)

`lib/audit.js` exports:

```js
// Entity types whose audit rows only the matching key's holders may read (section 3.6).
const PRIVATE_ENTITY_TYPES = {
  bonus: "bonuses.manage", bonus_settings: "bonuses.manage",
  alarm_slot: "alarms.manage", alarm_company: "alarms.manage", alarm_times: "alarms.manage",
  loan: "loans.manage",
};
// The private entity types the user may NOT read (perms: a Set or an array).
hiddenEntityTypes(perms) // -> string[]
```

- **`GET /api/audit`** (`audit.view`, unchanged access) adds `(entity_type IS NULL OR entity_type NOT IN (…))` for the caller's hidden types to its `WHERE`, so the hidden rows count in neither `rows` nor `total`. Asking for a hidden `entityType` answers `{rows: [], total: 0}` (not 403). The owner sees everything.
- **`GET /api/audit/actions`** lists only actions that occur on a row the caller may read (so `bonus.confirm` isn't even named to another admin).
- **Before/after keep their values** for these rows (lead's default 2), except alarm codes, which never enter the log: a code change records `code: "set"`, `"changed"` or `"cleared"` only, and a Show records the slot number only (§5.3).
- Rows about users (`user.override` naming an owner-only key, `user.owner`) are ordinary `user` rows, visible to `audit.view`.
- Each M13 library writes only the entity types in the table, so a new private area needs only a line here.

## 4. Bonuses (B, `lib/bonuses.js`)

### 4.1 The rule (Decision 3)

For a job with price `P` (cents), the rate `R` (basis points) and `t` checks ticked out of seven:

- **Possible** = `round(P × R / 10000)`.
- **Earned** = `round(P × R × t / 70000)`, worked from the price directly so it's rounded once (the workbook's (t ÷ 7) × possible, without rounding twice).
- **Lost** = possible − earned (0 when all seven are ticked).
- `round` is half up on whole numbers: `roundDiv(n, d) = Math.floor((2n + d) / (2d))` for `n ≥ 0`. All products stay below 2^53 (`P ≤ 10^10`, `R ≤ 10^4`, `t ≤ 7`).
- **Shares:** each holder with points `p > 0` of the total `T = Σp` gets `floor(earned × p / T)`; the cents left over (fewer than the number of holders) go one each to the holders with the **largest remainders**, ties by more points, then the holders' order in the settings, then the lower person id. The shares add up to earned exactly. A share of 0 cents gets no share row.

**The seven checks**, equal weight, in this order (key, column, label):

| Key | Column | Label |
|---|---|---|
| `drawn` | `check_drawn` | Drawn (Mozaik) |
| `ordered` | `check_ordered` | Ordered |
| `assembled` | `check_assembled` | Assembled |
| `installed` | `check_installed` | Installed |
| `noFuss` | `check_no_fuss` | No fuss |
| `onTime` | `check_on_time` | On time |
| `hours` | `check_hours` | Hours |

**The Hours check (Decision 4)** is suggested: `suggested = (actualFactory + actualInstall) ≤ (quotedFactory + quotedInstall)` when all four are known, else `null`. While `check_hours` is NULL the bonus follows the suggestion (ticked when it is `true`); `true`/`false` set by hand overrides it, and `null` sent again returns it to the suggestion. At confirm the effective value is frozen into the column (an unknown suggestion counts as not ticked).

### 4.2 People

- Holders, **ran by** and **checked by** are `pay_people` (lead's default 4): a board worker or a pay-only person. A body names one as `{personId}` (a `pay_people` id) or `{workerId}` (a worker who may not have a row yet; the library calls `payroll.ensureWorkerRow` inside its transaction). Anything else → 400 `"<Label> must be a person from the pay list"`. An archived person can't be newly chosen (same 400) but stays where already set.
- A person shows as `{personId, name, archived}` from `payroll.personById` (for a worker, `archived` is the worker's).
- No "Factory" pool: the plan's lead's default 4. A pool can be added later as a pay-only person named for it.

### 4.3 The bonus object

```js
{
  id, job: {id, name, archived},
  status: "draft" | "confirmed",
  priceCents,                                   // null until typed or prefilled
  ranBy: {personId, name, archived} | null,
  checkedBy: {personId, name, archived} | null,
  hours: { quotedFactoryMin, quotedInstallMin, actualFactoryMin, actualInstallMin,  // each null or minutes
           quotedFromJoinr },                   // true while the quoted pair is as filled from Joinr
  checks: { drawn, ordered, assembled, installed, noFuss, onTime, hours },          // booleans; hours effective
  hoursCheck: { setByHand: bool, suggested: bool | null },
  ticked,                                       // 0-7
  rateBp, possibleCents, earnedCents, lostCents,// draft: live from the settings (null without a price);
                                                // confirmed: frozen
  totalPoints,                                  // draft: the settings' sum; confirmed: frozen
  shares: [ { personId, name, points, shareCents,
              paid: {date, payRun: {id, startDate} | null, at, by: {id, name}} | null } ],
                                                // draft: the live preview (paid always null)
  owedCents,                                    // confirmed: Σ unpaid shares; draft: 0
  note, confirmedDate, confirmed: {at, by: {id, name}} | null,
  createdAt, createdBy: {id, name} | null, updatedAt, updatedBy: {id, name} | null,
}
```

### 4.4 Exports (binding signatures) and rules

```js
settings(db)                          // -> {rateBp, holders: [{personId, name, archived, points}], totalPoints}
putSettings(db, req, body)            // -> settings
people(db)                            // -> {people: payroll.listPeople(db)} (current, not archived)
jobs(db, req, {q})                    // -> {jobs: [{id, name, stage, archived, hasBonus}]}
list(db, {status})                    // -> {bonuses: [bonus]}
get(db, id)                           // -> bonus (404)
create(db, req, body)                 // -> bonus
update(db, req, id, body)             // -> bonus
fillHours(db, req, id)                // -> bonus (quoted hours from Joinr again)
confirm(db, req, id, body)            // -> bonus
reopen(db, req, id)                   // -> bonus
remove(db, req, id)                   // -> {ok: true}
markPaid(db, req, id, personId, body) // -> bonus
markPersonPaid(db, req, personId, body)  // -> summary
summary(db, today = sydneyToday())    // -> section 4.6
joinrHours(db, jobId)                 // -> {quotedFactoryMin, quotedInstallMin} | null   (section 4.5)
```

**Body keys** (create and update; any other key → 400 `"Unknown field: <key>"`):

| Key | Rule |
|---|---|
| `jobId` | create only: a job id (404 when none; archived jobs allowed) |
| `priceCents` | `null` or a whole number 0–10000000000, else 400 `"The price must be whole cents from $0 to $100,000,000"` |
| `ranBy`, `checkedBy` | `null` or a person (§4.2); labels "Ran by", "Checked by" |
| `quotedFactoryMin`, `quotedInstallMin`, `actualFactoryMin`, `actualInstallMin` | `null` or a whole number 0–600000, else 400 `"<Label> must be minutes from 0 to 600000"` (labels "Quoted factory hours", "Quoted install hours", "Actual factory hours", "Actual install hours"). Changing either quoted value clears `quoted_from_joinr` |
| `checks` | an object with any of §4.1's keys; each `true`/`false` (`hours` also `null`), else 400 `"<Label> must be true or false"` |
| `note` | text up to 1000 characters, else 400 `"Note must be 1000 characters or fewer"` |

| Action | Rule |
|---|---|
| **create** | One bonus per job: 409 `"This job already has a bonus"`. A price left out is prefilled from the job's `value_cents` **only when the caller holds `jobs.value`** (as stored, inc GST: Problem 2); quoted hours left out are prefilled from `joinrHours` (`quoted_from_joinr = 1` when both came from it). Status `draft`. 201. Audit `bonus.create` (after: the stored fields). |
| **update** | Draft only: 409 `"This bonus is confirmed; reopen it to change it"`. The keys present change. Nothing changed → 200, no audit row. Audit `bonus.update` (before/after: only the changed keys). |
| **fillHours** | Draft only (same 409). No Joinr hours → 409 `"No Joinr hours for this job"`. Sets both quoted values, `quoted_from_joinr = 1`. Audit `bonus.update`. |
| **confirm** | Body `{confirmedDate?}` (default today; not a date → 400 `"The confirmed date must be a date"`; in the future → 400 `"The confirmed date can't be in the future"`). Already confirmed → 409 `"This bonus is already confirmed"`. No price → 400 `"Fill in the price before confirming"`. Earned above 0 and the settings' total points 0 → 409 `"Set the share points before confirming"`. Freezes `rate_bp`, `possible_cents`, `earned_cents`, `check_hours` (effective), `shares_json` (`{holders: [{personId, name, points}], totalPoints}`), writes the share rows (§4.1), `confirmed_*`. Audit `bonus.confirm` (after: `{confirmedDate, rateBp, priceCents, ticked, possibleCents, earnedCents, shares: [{personId, shareCents}]}`). |
| **reopen** | Confirmed only: 409 `"Only a confirmed bonus can be reopened"`. Any share paid → 409 `"A share of this bonus has been paid; undo that first"`. Deletes the share rows and clears the frozen columns: the draft then follows the **current** settings again. Audit `bonus.reopen` (before: the frozen figures). |
| **remove** | Draft only: 409 `"Only a draft bonus can be deleted"`. Audit `bonus.delete` (before: the stored fields). |
| **markPaid** | Body `{paidDate?, payRunId?}` or `{undo: true}`. Draft → 409 `"Confirm the bonus first"`; no share for that person → 404. `paidDate` default today; not a date → 400 `"The paid date must be a date"`; future → 400 `"The paid date can't be in the future"`; before the confirmed date → 400 `"The paid date can't be before the bonus was confirmed (<d Mon yyyy>)"`. `payRunId`: `null` or an existing pay run, else 400 `"No such pay run"`. Already paid → 409 `"This share is already marked paid"`; undo when not paid → 409 `"This share isn't marked paid"`. Audit `bonus.paid` / `bonus.unpaid` (after: `{personId, shareCents, paidDate, payRunId}`). |
| **markPersonPaid** | Body `{bonusIds, paidDate?, payRunId?}`: `bonusIds` must equal exactly the person's owed bonus ids (order ignored), else 409 `"The owed list changed while you were looking; reload it"`; empty → 400 `"Nothing owed to mark paid"`. Date and pay-run rules as markPaid, the date checked against each bonus. One `bonus.paid` row per bonus. |

`list` statuses: `all` (default), `draft`, `confirmed`, `owed` (confirmed with any unpaid share); anything else → 400 `"Unknown status: <s>"`. Sorted drafts first (by job name, case-blind), then confirmed by confirmed date newest first, then id. `jobs` returns up to 50 jobs matching `q` (case-blind, in the name), not archived first, newest first.

Settings body `{rateBp, holders: [{personId | workerId, points}]}` (both keys required) replaces the rate and the whole holder list (order kept as `sort`). Rate → 400 `"The bonus rate must be from 0 to 10000 basis points (0% to 100%)"`; points → 400 `"Share points must be whole numbers from 0 to 1000"`; a person twice → 400 `"<name> is listed twice"`. Audit `bonus_settings.update` (before/after: rate and holders). Confirmed bonuses never change.

### 4.5 Quoted hours from Joinr (Decision 4)

`joinrHours(db, jobId)`: the job's Joinr intake record (`joinr_intake.job_id = jobId`, state `accepted` or `linked`, the newest by `last_seen_at`), `payload` read as JSON, `estimatedHours.factory` and `.site`:

- `quotedFactoryMin = round(factory × 2 × 60)`, `quotedInstallMin = round(site × 2 × 60)`, each only when it's a finite number ≥ 0 (else that one is null); `null` when there's no record, no `estimatedHours`, or the payload can't be read.
- **Why × 2:** Joinr's engine halves the factory and site hours for its overhead sum, and the intake sends those halved figures (the intake contract doesn't say so; plan §1.2, §1.3). Doubling gives back the hours typed on the quote, with no Joinr change. Office and travel hours aren't used.
- The API carries minutes; pages show hours to two decimals and take hours (any decimal, stored as `round(hours × 60)`).

### 4.6 The summary

`summary(db)`:

```js
{ people: [ { personId, name, archived, earnedCents, paidCents, owedCents,
              owed: [ {bonusId, jobId, jobName, confirmedDate, shareCents} ] } ],   // by confirmed date
  totals: { earnedCents, paidCents, owedCents },
  payRuns: [ {id, startDate, endDate, status} ] }   // newest first, at most 26 (for the pickers)
```

Over confirmed bonuses' share rows only. People are those with any share, by name (case-blind). A draft counts nowhere.

## 5. Alarms (C)

### 5.1 The code key (`lib/alarmcode.js`)

```js
KEY_FILE                          // path.join(CONFIG_DIR, "alarm-code-key")
keyState(db)                      // -> "ready" | "none" | "missing"
encrypt(db, slotId, code)         // -> {ct, iv, tag, keyId}   (creates the key when "none")
decrypt(db, row)                  // -> code   (throws HttpError 409, section 5.3)
readable(db, row)                 // -> boolean, without decrypting
currentKeyId()                    // -> 16 hex | null
```

- **The key:** 32 random bytes, stored in `KEY_FILE` as 64 lowercase hex characters and a newline, **read fresh on every call** (a restored file works without a restart). Never in the database, a log, an error, a response or an environment variable.
- **States:** `ready` = the file holds a valid key; `none` = no valid key file **and no stored code** (the key will be made on the first code saved); `missing` = no valid key file but some slot has a code (a file that exists but doesn't hold 64 hex characters counts as missing, and is **never overwritten**).
- **Creation** (only in state `none`): write `.alarm-code-key.new` (a dotfile, so never archived) with `{mode: 0o600, flag: "wx"}`, `chmod 600` (ignored on Windows), then `fs.linkSync` it to `KEY_FILE` (fails if another request made one first: then use that one) and unlink the temporary. A failure → 409 `"The alarm code key couldn't be created in the config folder"`, and `console.error("[alarms] could not create the alarm code key (<error code>)")`; nothing else logged.
- **Encryption:** AES-256-GCM, a fresh 12-byte IV per code, a 16-byte tag, additional data `alarm_slot:<slot row id>` (a ciphertext copied to another row won't open). `ct`, `iv` and `tag` are base64; `keyId` = the first 16 hex characters of `sha256("crosscuts-alarm-code-key:" + key hex)`, so a row saved under another key is known without trying it.
- **Backups:** `alarm-code-key` passes the archive rule for `config/` (backup-contracts §5.2), so it goes into every nightly, manual and pre-migration archive with the database, encrypted by the archive. The plain `VACUUM INTO` pre-migration copies on the Umbrel hold only ciphertext. A restore needs `restore.js db … --config` to bring the key back (Problem 5).

### 5.2 Slots (`lib/alarms.js`)

```js
{
  id, slot,                                   // slot: the panel's user number, 1-999
  personId,                                   // null for a typed name
  name,                                       // the person's name or the typed name
  personArchived,                             // true/false for a person; null for a typed name
  type: "office" | "staff" | "temp",
  givenDate, removedDate, note,
  leaver,                                     // personArchived && removedDate === null
  code: { set: bool, readable: bool, setAt, setBy: {id, name} | null },   // never the code
  createdAt, updatedAt, updatedBy: {id, name} | null,
}
```

```js
overview(db)                       // -> {slots, company, times, keyState, people}
createSlot(db, req, body)          // -> slot
updateSlot(db, req, id, body)      // -> slot
removeSlot(db, req, id, body)      // -> slot
restoreSlot(db, req, id)           // -> slot
reveal(db, req, id)                // -> {code}
putCompany(db, req, body)          // -> company
putTimes(db, req, body)            // -> times
summary(db)                        // -> {leavers: [{id, slot, name}]}
```

- `overview.slots`: slots in use by slot number, then removed ones by removed date newest first. `people` is `payroll.listPeople(db)`.
- **Leavers:** a slot whose holder is a person who has left (archived: a pay-only person archived, or a worker archived) and that isn't removed. `summary` lists them by slot number. Typed names are never leavers.

**Body keys** (create and update; any other → 400 `"Unknown field: <key>"`):

| Key | Rule |
|---|---|
| `slot` | a whole number 1–999, else 400 `"The slot number must be a whole number from 1 to 999"`; another slot in use with it → 409 `"Slot <n> is already in use"` |
| `personId` / `workerId` / `holderName` | exactly one (on create; on update, sending one replaces the other): a person as §4.2, or a name of 1–100 characters (trimmed); else 400 `"Give the holder: a person or a name"`, `"Holder name must be 100 characters or fewer"` |
| `type` | `office`, `staff` or `temp`, else 400 `"The type must be office, staff or temp"`; required on create |
| `givenDate` | `null` or a date not in the future: 400 `"Date given must be a date"`, `"The date given can't be in the future"` |
| `note` | text up to 500 characters |
| `code` | `null` (clear) or a string that, trimmed, is **1 to 12 digits** (leading zeros kept), else 400 `"The code must be 1 to 12 digits"` (the sentence never repeats the value) |

| Action | Rule |
|---|---|
| **createSlot** | 201. With a code: inserted, then encrypted with the new id, in one transaction. Audit `alarm_slot.create` (after: the fields, and `code: "set"` when one was given). |
| **updateSlot** | A removed slot → 409 `"Slot <n> was removed; restore it to change it"`. A new code → `"changed"` (or `"set"` when there was none); `code: null` → `"cleared"` (allowed whatever the key state). A code equal to the stored one is still re-encrypted and audited as `"changed"` (comparing would mean decrypting). Nothing changed → 200, no audit row. Audit `alarm_slot.update` (before/after: the changed keys, the code only as those words). |
| **removeSlot** | Body `{removedDate?}`, default today: not a date → 400 `"The removed date must be a date"`; in the future → 400 `"The removed date can't be in the future"`; before the date given → 400 `"The removed date can't be before the date given (<d Mon yyyy>)"`. Already removed → 409 `"Slot <n> is already removed"`. **Clears the code.** Audit `alarm_slot.remove` (after: `{removedDate, code: "cleared"}` when it had one). |
| **restoreSlot** | Only a removed slot (409 `"Slot <n> isn't removed"`); its number in use → 409 `"Slot <n> is already in use"`. Clears `removed_date`; the code stays empty. Audit `alarm_slot.restore`. |
| **putCompany** | `{name, accountNumber, contactName, phone}`, each optional text (200, 100, 200, 50 characters, labels "Company", "Account number", "Contact", "Phone"); any other key → 400 `"Unknown field: <key>"` (so there is nowhere to put a monitoring password). Audit `alarm_company.update` (before/after: the changed keys). |
| **putTimes** | `{days: [{day, armsAt, disarmsAt}]}` with each day 1–7 exactly once, else 400 `"Give all seven days, Monday to Sunday"`; each time `null` or `HH:MM` (`lib/time.js` `TIME_RE`), else 400 `"<Day> <arms at|disarms at> must be a time (HH:MM)"`. Audit `alarm_times.update` (before/after: the days that changed). |

### 5.3 Show, and a missing key

`reveal(db, req, id)` (route `POST /api/alarms/slots/:id/reveal`), check order:

| Case | Answer |
|---|---|
| no such slot | 404 |
| no code saved | 409 `"Slot <n> has no code saved"` |
| key state `missing` | 409 `"The alarm code key is missing, so codes can't be shown. Restore config/alarm-code-key from a backup."` |
| the row's key id isn't the current key's, or GCM authentication fails | 409 `"This code can't be read with the current alarm code key. Restore the key it was saved with, or type the code again."` |
| otherwise | 200 `{code}` with `Cache-Control: no-store`, and audit `alarm_slot.reveal` (after: `{slot: n}`), never the code |

- **Saving a code** in state `missing` → 409 `"The alarm code key is missing. Restore config/alarm-code-key from a backup, or clear every saved code, before saving a new one."` A new key is never made while codes saved under the old one exist, so a lost file can't silently orphan them; clearing them all (or removing their slots) returns the state to `none`.
- Nothing about a missing or unreadable key ever crashes a request or the page: `overview` answers as normal, with `keyState: "missing"` and each code's `readable: false`.
- A row whose key id differs while the state is `ready` (a different key restored) is unreadable on its own; saving a new code on any slot is allowed and uses the current key.

## 6. Loans (D, `lib/loans.js`)

### 6.1 The loan object

```js
{
  id, name, direction: "lent_to_business" | "lent_by_business", otherParty,
  openingBalanceCents, openingDate, note, archived,
  balanceCents,                     // opening - every principal (calculated, never stored)
  rateBp,                           // the rate in force today, or null
  lastPaidDate,                     // the latest repayment's date, or null
  fy: { label: "2026-27", principalCents, interestCents },   // the current Australian financial year
  createdAt, updatedAt, updatedBy: {id, name} | null,
}
// get() adds:
  rates: [ {id, fromDate, rateBp, note} ],                    // oldest first
  repayments: [ { id, paidDate, principalCents, interestCents, totalCents,
                  balanceAfterCents, rateBp,                  // the rate in force that day, or null
                  workedOutInterestCents,                     // section 6.2, or null without a rate
                  reference, note } ]                         // by paid date, then id
```

`direction` sets only words: `lent_to_business` is "Lent to the business" (the business repays; Decision 7, both current loans), `lent_by_business` is "Lent by the business" (repaid to it). The maths is the same either way.

### 6.2 The maths

- **Balance** after a repayment = the opening balance − the principal of it and every repayment before it (by paid date, then id). Interest never changes the balance (it's paid as it falls due, as the workbook does). **The balance is never typed or stored** (Decision 7).
- **The rate on a date** = the rate with the latest `from_date` on or before it; none → no rate.
- **Interest worked out** for a repayment on date `D` = `roundDiv(balanceBefore × rateBp, 120000)` (annual rate ÷ 12 on the balance, rounded half up to the cent), where `balanceBefore` is the balance just before that repayment. **Once a month:** only the first repayment of a calendar month that carries interest gets it; when another repayment earlier in the same month already has `interest_cents > 0`, the worked-out figure is **0**. This matches the workbook's "monthly on the balance" with fortnightly repayments, without day counts.
- `workedOutInterestCents` in `get()` applies this to each row in order (an earlier row of the month with interest makes it 0); the page shows it beside the typed interest when they differ.
- **The suggestion for a new or moved repayment** (`interest(db, id, {date, repaymentId})`): `balanceBefore` = opening − the principal of every other repayment dated on or before `D` (a repayment being edited, `repaymentId`, is left out); "already charged" = **any other** repayment in `D`'s month with interest > 0. Answers `{date, balanceCents, rateBp, interestCents, alreadyCharged: {repaymentId, date} | null}` (`rateBp` and `interestCents` null without a rate; `interestCents` 0 when already charged).
- Interest can always be changed to match a statement (Decision 7); the typed figure is what's stored and printed.

### 6.3 Exports (binding signatures) and rules

```js
list(db, {archived = false}, today = sydneyToday())   // -> {loans}
get(db, id, today)                  // -> loan with rates and repayments (404)
create(db, req, body)               // -> loan
update(db, req, id, body)           // -> loan
addRate(db, req, id, body)          // -> loan
updateRate(db, req, id, rateId, body)  // -> loan
deleteRate(db, req, id, rateId)     // -> loan
addRepayment(db, req, id, body)     // -> loan
updateRepayment(db, req, id, repId, body)  // -> loan
deleteRepayment(db, req, id, repId) // -> loan
interest(db, id, {date, repaymentId})  // -> section 6.2
statement(db, id, {from, to})       // -> section 8.2
```

| Field | Rule |
|---|---|
| `name` | required, 1–100 characters: 400 `"Name is required"`, `"Name must be 100 characters or fewer"` |
| `direction` | 400 `"Direction must be lent_to_business or lent_by_business"` |
| `otherParty` | text up to 200 |
| `openingBalanceCents` | 400 `"The opening balance must be whole cents from $0 to $100,000,000"` |
| `openingDate` | required date, not in the future: 400 `"The opening date must be a date"`, `"The opening date can't be in the future"` |
| `note` | text up to 1000 |
| `archived` | update only, `true`/`false` |
| rate `fromDate`, `rateBp`, `note` | a date; 0–5000 whole basis points: 400 `"The rate must be from 0 to 5000 basis points (0% to 50%)"`; the same from date twice → 409 `"There is already a rate from <d Mon yyyy>"` |
| repayment `paidDate` | a date, not in the future, not before the opening date: 400 `"A repayment can't be before the opening date (<d Mon yyyy>)"` |
| repayment `principalCents`, `interestCents` | whole cents 0–10000000000; both 0 → 400 `"Enter the principal, the interest or both"`. **`interestCents` left out on add** takes the suggestion (§6.2); with no rate → 400 `"No rate covers <d Mon yyyy>: type the interest or add a rate"` |
| repayment `reference`, `note` | text up to 100 and 500 |

- Unknown keys → 400 `"Unknown field: <key>"`, on every body.
- **Never below zero:** any write after which some running balance would be below 0 → 409 `"That would take the balance below zero on <d Mon yyyy>"` (the first such date). Changing the opening date to after a repayment → 409 `"A repayment is dated before that (<d Mon yyyy>)"`.
- **An archived loan** takes no rate or repayment writes: 409 `"This loan is archived; restore it to change it"`. `PATCH {archived: false}` restores it. Loans are never deleted; rates and repayments may be (audited with the row in `before`).
- Audit, entity `loan`, entity id the loan: `loan.create`, `loan.update` (changed keys), `loan.rate_add`, `loan.rate_update`, `loan.rate_delete`, `loan.repayment_add`, `loan.repayment_update`, `loan.repayment_delete` (before/after: the row).
- `list` sorts by name (case-blind); `archived: true` lists only archived loans.

## 7. Routes

Literal paths are registered before `/:id` ones. Ids are positive integers; anything else is 404. A body that isn't a JSON object → 400 `"JSON body required"` (routes with an optional body accept an empty one). Each route file maps errors with `sendError`.

### 7.1 `routes/bonuses.js` (`defineRoutes("/api/bonuses")`, B)

| Method & path | Access | Answers |
|---|---|---|
| `GET /api/bonuses` | `bonuses.manage` | `list`; query `status` |
| `POST /api/bonuses` | `bonuses.manage` | 201, the bonus |
| `GET /api/bonuses/settings` | `bonuses.manage` | `settings` |
| `PUT /api/bonuses/settings` | `bonuses.manage` | `settings` |
| `GET /api/bonuses/people` | `bonuses.manage` | `people` |
| `GET /api/bonuses/jobs` | `bonuses.manage` | `jobs`; query `q` |
| `GET /api/bonuses/summary` | `bonuses.manage` | `summary` (the scaffold stub answers `{people: [], totals: {earnedCents: 0, paidCents: 0, owedCents: 0}, payRuns: []}`) |
| `POST /api/bonuses/people/:personId/paid` | `bonuses.manage` | `markPersonPaid` → the summary |
| `GET /api/bonuses/:id` | `bonuses.manage` | the bonus |
| `PATCH /api/bonuses/:id` | `bonuses.manage` | the bonus |
| `DELETE /api/bonuses/:id` | `bonuses.manage` | `{ok: true}` |
| `POST /api/bonuses/:id/joinr-hours` | `bonuses.manage` | `fillHours` |
| `POST /api/bonuses/:id/confirm` | `bonuses.manage` | the bonus |
| `POST /api/bonuses/:id/reopen` | `bonuses.manage` | the bonus |
| `POST /api/bonuses/:id/shares/:personId/paid` | `bonuses.manage` | `markPaid` → the bonus |

### 7.2 `routes/alarms.js` (`defineRoutes("/api/alarms")`, C)

| Method & path | Access | Answers |
|---|---|---|
| `GET /api/alarms` | `alarms.manage` | `overview` |
| `GET /api/alarms/summary` | `alarms.manage` | `summary` (scaffold stub: `{leavers: []}`) |
| `POST /api/alarms/slots` | `alarms.manage` | 201, the slot |
| `PATCH /api/alarms/slots/:id` | `alarms.manage` | the slot |
| `POST /api/alarms/slots/:id/remove` | `alarms.manage` | the slot |
| `POST /api/alarms/slots/:id/restore` | `alarms.manage` | the slot |
| `POST /api/alarms/slots/:id/reveal` | `alarms.manage` | `{code}`, `Cache-Control: no-store` |
| `PUT /api/alarms/company` | `alarms.manage` | the company |
| `PUT /api/alarms/times` | `alarms.manage` | the times |

`company` is `{name, accountNumber, contactName, phone, updatedAt}`; `times` is `[{day, label, armsAt, disarmsAt}]` Monday first (`label` "Monday" …).

### 7.3 `routes/loans.js` (`defineRoutes("/api/loans")`, D)

| Method & path | Access | Answers |
|---|---|---|
| `GET /api/loans` | `loans.manage` | `list`; query `archived=1` |
| `POST /api/loans` | `loans.manage` | 201, the loan (with rates and repayments) |
| `GET /api/loans/:id` | `loans.manage` | the loan |
| `PATCH /api/loans/:id` | `loans.manage` | the loan |
| `GET /api/loans/:id/interest` | `loans.manage` | `interest`; query `date` (required, 400 `"date must be a date"`), `repaymentId` |
| `GET /api/loans/:id/statement` | `loans.manage` | `statement`; query `from`, `to` |
| `POST /api/loans/:id/rates` | `loans.manage` | 201, the loan |
| `PATCH /api/loans/:id/rates/:rateId` | `loans.manage` | the loan |
| `DELETE /api/loans/:id/rates/:rateId` | `loans.manage` | the loan |
| `POST /api/loans/:id/repayments` | `loans.manage` | 201, the loan |
| `PATCH /api/loans/:id/repayments/:repId` | `loans.manage` | the loan |
| `DELETE /api/loans/:id/repayments/:repId` | `loans.manage` | the loan |

### 7.4 `routes/users.js` (A)

`POST /api/users/:id/owner` (`users.admin`, §3.4) is new; every other users route keeps its path and access and gains §3.4's guards.

## 8. Prints

All A4 portrait, **black on white, no letterhead** (lead's default 6), between the `style-check: print-start` / `print-end` comments; the shell, buttons and screen chrome hidden; `document.title` names the sheet. A print page shows the sheet on screen on a white paper box with **Print** and **Back**; no access or 404 → a sentence.

### 8.1 `/bonusprint.html` (E, prefix `bp-`)

- **`?id=<bonusId>`, a job bonus** (`document.title` "Bonus <job name>"): "Job bonus", the job, **Confirmed** date (a draft prints a ruled **DRAFT – NOT CONFIRMED** box instead, with the live figures); price, rate (as a percent to two places), possible; the seven checks as `[x]`/`[ ]` with their labels and "Ticked n of 7" (Hours marked "(suggested)" when it follows the suggestion); earned and lost; ran by, checked by; the hours table (quoted and actual, factory and install, in hours); the shares table (person, points of the total, share, paid date and pay run or "Owed"); the note.
- **`?summary=1`, bonuses owed** (`document.title` "Bonuses owed <d Mon yyyy>"): the date, a table per person of earned, paid and owed, the totals, then each person with anything owed and their owed lines (job, confirmed date, share).

### 8.2 `/loanprint.html` (F, prefix `lp-`), the statement

`statement(db, id, {from, to})` (`from` default the opening date, `to` default today; not dates → 400 `"from and to must be dates"`; `to` before `from` → 400 `"The statement can't end before it starts"`):

```js
{ loan: {id, name, direction, otherParty, openingDate},
  from, to,
  balanceAtStartCents,             // the balance after every repayment before `from` (the opening balance if from <= openingDate)
  rows: [ {paidDate, reference, principalCents, interestCents, totalCents, balanceAfterCents} ],
  totals: {principalCents, interestCents, totalCents},
  balanceAtEndCents,
  rates: [ {fromDate, rateBp} ] }  // every rate in force at some point in the period
```

The print (`document.title` "Loan statement <name> <d Mon yyyy> to <d Mon yyyy>"): "Loan statement", the loan's name, its direction in words and the other party, the period; the balance at the start, a table (Date, Reference, Principal, Interest, Total, Balance), the totals, the balance at the end; the rates in force ("6.00% from 1 Jan 2025"). Long statements run on to further pages with the table header repeated.

## 9. Pages, menu and access (scaffold)

`lib/pages.js` gains:

```js
// M13 (docs/plans/m13-contracts.md section 9).
"/bonuses.html": "bonuses.manage",
"/bonusprint.html": "bonuses.manage",
"/alarms.html": "alarms.manage",
"/loans.html": "loans.manage",
"/loanprint.html": "loans.manage",
```

`public/shell/shell.js`:
- **Admin:** Users, Audit, then **Bonuses** (`/bonuses.html`, `bonuses.manage`) and **Alarms** (`/alarms.html`, `alarms.manage`). Admin stays plain (no department rule).
- **Accounts:** after Supplier accounts, **Loans** (`/loans.html`, `loans.manage`), before Reports.
- `PAGE_ALIASES` gains `"/bonusprint.html": "/bonuses.html"` and `"/loanprint.html": "/loans.html"`.
- The comment at Admin names this file. The bar's width doesn't change.

Who sees what: the owner sees all three; another admin sees none of them (Users and Audit as before). Someone granted `loans.manage` alone sees an Accounts menu with Loans.

## 10. The pages

All pages:
- Pass `node ci/style-check.js` and follow the house style (`tokens.css`, `components.css` `hs-`, the shell's `cc-dialog*`, `shared.js`), and carry `#cc-shell`.
- Put user text in through `textContent`, and hide every control the user can't use (`cc.can()`, `cc.me.isOwner`).
- Have no horizontal page scroll at 375 px (tables scroll inside their own box).
- Show a job name as a link to `/job.html?id=…` only with `jobs.view`.
- Money as `$1,234.56`, rates as percents to two places ("1.50%"), hours to two decimals.

### 10.1 Users page (E, `public/users.{html,css,js}`, new classes prefix `us-`)

- **The Owner mark:** an "OWNER" pill (uppercase, letterspaced) by the owner's name in the list and the detail title.
- **"of N":** the effective count reads "(<n> of 30)" from `meta.keys.length` (no change in code beyond §3's data).
- **The owner's detail**, seen by anyone else: the profile, roles, disable, sign-out, password and override controls are hidden, replaced by the line "Only the owner can change the owner's login." The owner's own detail shows "The owner holds every key." in place of the override list (Default/Grant/Revoke are pointless there); a leftover override on the owner shows with **Clear** only.
- **Owner-only keys** (`meta.ownerOnlyKeys`) in any other user's override list: for a non-owner viewer the three buttons are disabled with the note "Only the owner can grant this"; for the owner they work as any key, with a small "owner only" label.
- **Password reset** on a login holding an owner-only key by override, seen by a non-owner: hidden, with "Only the owner can reset this password (they hold <key>)."
- **Transfer ownership** (owner only, on another enabled admin's detail): a button opening a `cc-dialog`: the sentence "<name> becomes the owner and gets every key. You stay an admin without the owner-only keys unless they grant them back.", a text box "Type <username> to confirm", **Your password**, then **Transfer** (`POST /api/users/:id/owner`). On success the page reloads `cc.me` and the list. Refusals show their sentence in the dialog.

### 10.2 `/bonuses.html` (E, prefix `bo-`)

- **Tabs** (kept in the hash): **Jobs**, **Owed**, **Settings**.
- **Jobs:** a filter Draft / Confirmed / Owed / All; a table of Job, Status, Price, Ticked (n of 7), Earned, Lost, Owed, **Open**. **New bonus** opens a dialog with a job search (`GET /api/bonuses/jobs?q=`; jobs that already have a bonus are shown but not choosable), then creates it (`POST`) and opens it.
- **A bonus (`?id=`):**
  - The job (link), the status, **Price** (prefilled; a note "From the job's value, including GST" while it equals the job's value), **Ran by** and **Checked by** (selects from `GET /api/bonuses/people`), the four hours inputs (hours) with "From Joinr (factory and site doubled back from the quote)" while `quotedFromJoinr`, and **Fill from Joinr**.
  - **The seven checks** as checkboxes with their labels. Hours shows "Suggested: yes/no/unknown" and, while set by hand, **Use suggestion**.
  - The live figures: rate, possible, earned, lost; the shares preview (person, points of the total, share).
  - Buttons by state: **Save** (PATCH with only what changed), **Confirm** (a dialog with the confirmed date, default today, max today; saves first), **Delete** (draft, a confirm), **Reopen** (confirmed, when nothing is paid; the dialog says the current rate and points will apply when it is confirmed again), **Print** (`bonusprint.html?id=`).
  - Confirmed: read-only, with the frozen figures and per share **Mark paid** (a dialog: paid date, pay run from the summary's `payRuns`, optional) or **Undo paid**.
- **Owed:** the summary table per person (Earned, Paid, Owed) and the totals; each person's owed lines; per person **Mark all paid** (a dialog with the date and pay run; sends the owed `bonusIds` shown); **Print** (`bonusprint.html?summary=1`).
- **Settings:** the rate (percent input, stored in basis points), the holders list (person select, points, move up/down, remove, add), **the share total added up** live, **Save**. A line: "Confirmed bonuses keep the rate and shares they were confirmed with."

### 10.3 `/bonusprint.html` (E): §8.1.

### 10.4 `/alarms.html` (F, prefix `al-`)

- **Leavers first:** for each leaver an orange line "<name> has left: change or remove slot <n>".
- **Key state:** `missing` → an orange block with the §5.3 sentence ("The alarm code key file is missing, so saved codes can't be shown or changed. Restore config/alarm-code-key from a backup (restore with --config), or clear the saved codes."); `none` says nothing.
- **Slots in use:** a table of Slot, Holder (with "left" in orange for a leaver), Type, Given, Code, Note, actions. **Code** shows a fixed mask "••••••" (the same length whatever the code), "none", or "can't be read" (orange); **Show** reveals it in place for 30 seconds, then masks it again (**Hide** sooner). Nothing is copied to the clipboard and the code is never put in an attribute or the URL.
- **Add slot / Edit:** a dialog: slot number, holder (a person select from `people`, or **Someone else…** revealing a name input), type, date given, note, and **Code** (`inputmode="numeric"`, `autocomplete="off"`, empty means unchanged on edit; **Clear code** separately, with a confirm). The input is emptied after every save.
- **Remove** (a dialog with the removed date; says the code will be cleared) and, under **Removed slots** (collapsed), **Restore**.
- **Alarm company:** Company, Account number, Contact, Phone, **Save**. A line: "The monitoring password isn't kept in Crosscuts."
- **Weekly times:** Monday to Sunday, **Arms at** (evening) and **Disarms at** (morning) time inputs, **Save**.
- No print (a printed code list is what this page avoids).

### 10.5 `/loans.html` (F, prefix `ln-`)

- **No query: the list** — Name, Direction (words), Other party, Balance, Rate now, Last paid, This FY interest; **Show archived**; **New loan** (a dialog: name, direction, other party, opening balance, opening date, note).
- **`?id=`, a loan:** the details (editable, **Save**), **Archive** / **Restore**; the balance in large type.
  - **Rates:** the history (From, Rate, Note) with add, edit, delete.
  - **Repayments:** a table (Date, Reference, Principal, Interest, Total, Balance after), newest at the bottom; an interest that differs from `workedOutInterestCents` shows the worked-out figure beside it in small grey type ("worked out $x").
  - **Add repayment** (a dialog: date paid, principal, interest prefilled from `GET …/interest?date=` as the date changes and editable, with "Worked out: balance $x × r% ÷ 12" or "Interest already charged this month (d Mon)", reference, note); **Edit** and **Delete** per row (a confirm).
  - **Statement:** from and to dates (default the opening date and today), **Print statement** (`loanprint.html?id=&from=&to=`).
- Read-only on an archived loan except **Restore** and the statement.

### 10.6 `/loanprint.html` (F): §8.2.

### 10.7 Dashboard (F, `public/index.{js,html,css}`)

With `alarms.manage`, one call to `GET /api/alarms/summary`; each leaver is an orange line linking to `/alarms.html`, "<name> has left: change or remove slot <n>", at most five, then "and <n> more". Hidden when there are none or the call fails. Nothing else on the dashboard changes.

## 11. Tests and checks

### 11.1 `ci/smoke.sh`

- **Scaffold:** after the M12 loop and before the Backup suite: `for f in "$(dirname "$0")"/smoke-m13-*.sh; do [ -f "$f" ] && source "$f"; done`, with a comment naming this file. Step k must still pass (the old app's database migrated through 026: no users, so no owner until setup).
- **A:** step a's assertion becomes `(.user.roles | index("admin")) != null and (.user.perms | length) == 30 and .user.isOwner == true` ("setup user is the owner, an admin with all 30 keys"). Step d's `.keys | length == 27` becomes **30** (message naming M13's three keys), and a new line asserts `.presets.admin | length == 27 and (index("bonuses.manage") == null) and (index("alarms.manage") == null) and (index("loans.manage") == null)`.

### 11.2 `ci/smoke-m13-owner.sh` (A), `step "m13. the owner and owner-only keys"`

M-suite rules apply: sourced, no shebang, no `set`, the shared helpers and jars (`$ADMIN` is the owner, `$ACCT`, `$DPM`, `create_user`, `login`, `own_password`), prefix `M13_O_`, no pristine-DB assumption, made-up names with a run tag.

- **Meta:** `ownerOnlyKeys == ["bonuses.manage","alarms.manage","loans.manage"]`, `ownerId` is the admin's id, `keys` ends with the three.
- **A second admin:** `create_user` `m13adm<tag>` with role `admin`, log in, choose a password. `me`: `isOwner false`, 27 perms, none of the three.
- **Non-owner admin refused** (each with its sentence): grant itself `bonuses.manage` → 403; grant `loans.manage` to acct → 403; `PATCH` the owner's display name, roles, `disabled` → 403; reset the owner's password → 403; sign the owner out → 403; any override on the owner → 403. `GET /api/bonuses`, `/api/alarms`, `/api/loans` → 403; `/bonuses.html`, `/alarms.html`, `/loans.html` → 403. The owner's password still works (log in again with a fresh jar → 200).
- **The owner:** `PUT` an override on themselves → 409. Grants acct `loans.manage` → 200; acct `GET /api/loans` 200 and `/loans.html` 200, `/bonuses.html` 403. m13adm resets acct's password → 403 with the holder sentence. The owner deletes the override → acct `GET /api/loans` 403.
- **Audit filter:** insert three rows straight into `audit_log` in the container (`docker exec … better-sqlite3`, as the M9 suite does) with entity types `bonus`, `alarm_slot`, `loan` and an action `m13.test.<tag>`. The owner's `GET /api/audit?action=m13.test.<tag>` → total 3; m13adm's → total 0, and `/api/audit/actions` as m13adm lacks the action. The owner grants m13adm `loans.manage` → m13adm sees 1 row (the loan one); delete the override.
- **Transfer:** m13adm `POST /api/users/<admin id>/owner` → 403; the owner to acct (not an admin) → 409; to m13adm with a wrong `confirmUsername` → 400; with a wrong password → 403; to themselves → 409; then rightly → 200. `me` as m13adm: `isOwner true`, 30 perms; as the old owner: 27 perms. The old owner resets m13adm's password → 403. A `user.owner` audit row exists. m13adm transfers back to the admin → 200, and `meta.ownerId` is the admin again.
- **Clean-up:** the owner disables m13adm (200), so later suites see the users they expect.

### 11.3 `ci/smoke-m13-bonuses.sh` (B), `step "m13. bonuses"`

Prefix `M13_B_`. Reads the settings first and **puts them back at the end** (the database isn't pristine).

- **Access:** `/bonuses.html` and `/bonusprint.html`: admin 200, acct 403, dpm 403. `GET /api/bonuses`: admin 200, acct 403.
- **People:** acct adds three pay-only people `M13 Person A/B/C <tag>` (`POST /api/payruns/people`).
- **Settings:** a rate of 10001 → 400; points 1.5 → 400; a person twice → 400; then rate 150 (1.50%), holders A 2, B 1, C 1 → 200 with `totalPoints` 4.
- **A job and Joinr hours:** admin makes `M13 Test Job <tag>` with a value of $30,000.00; insert a `joinr_intake` row for it (state `accepted`, `estimatedHours: {office: 1, factory: 10.5, site: 4, travel: 0}`).
- **Create:** `POST {jobId}` → 201: price 3000000 (prefilled), quoted factory 1260 and install 480 minutes, `quotedFromJoinr` true, draft. A second bonus for the job → 409.
- **Maths:** tick drawn, ordered, assembled, installed, noFuss (5), actual hours 1200 and 500: `hoursCheck.suggested` true, so `ticked` 6, earned `round(3000000 × 150 × 6 / 70000)` = 38571, possible 45000, lost 6429. Set `checks.hours: false` → ticked 5, earned 32143, lost 12857, shares preview A 16071, B 8036, C 8036 (sum 32143; the two 1-point holders take the leftover cents). `checks.hours: null` → back to the suggestion.
- **Rules:** an unknown field → 400; a bad price → 400; actual hours −1 → 400.
- **Confirm** with `checks.hours: false` and a future date → 400; then today → 200, confirmed, three shares. PATCH → 409. Change the settings' rate to 200 → the confirmed bonus still reads 150 and 32143.
- **Paying:** mark B paid with `payRunId` 999999999 → 400; today → 200; again → 409; reopen → 409 (a share paid). Summary: A owed 16071, B paid 8036. `POST /api/bonuses/people/<A>/paid` with a wrong `bonusIds` → 409; with `[id]` → 200 and A owes 0. Undo B → 200.
- **Reopen and delete:** undo A's payment, reopen → draft, no shares, rate 200 live; delete → 200; `GET` → 404.
- **Audit:** `bonus.create`, `bonus.update`, `bonus.confirm`, `bonus.paid`, `bonus.reopen`, `bonus.delete` rows for its bonus as the owner; acct has no `audit.view` (403) and the owner-only filter itself is §11.2's.
- Settings put back; the three people archived (acct).

### 11.4 `ci/smoke-m13-alarms.sh` (C), `step "m13. alarm holders and codes"`

Prefix `M13_A_`. Uses slot numbers 900–909 and clears them first (removes any in use from an earlier run).

- **Access:** `/alarms.html`: admin 200, acct 403. `GET /api/alarms`: admin 200, acct 403, dpm 403. `GET /api/alarms/summary`: admin 200, acct 403.
- **Codes:** create slot 900 for a pay-only `M13 Person <tag>`, type staff, code `"0042"` → 201, `code.set` true, `readable` true, and the answer's text doesn't contain `0042`. The key file exists in the container with mode 600 (`stat -c %a`). `reveal` → `{code: "0042"}` with `Cache-Control: no-store`. A typed-name slot 901 (`M13 Temp <tag>`, temp) with code `"097531086420"` (12 digits) → 201; `"12a4"` → 400; 13 digits → 400.
- **Never in plain:** in the container's database, no column of the two rows contains `0042` or `097531086420`, and no `audit_log` row's before or after does; the `alarm_slot.reveal` row's after is exactly `{slot: 900}`; the update row after a code change says `"changed"`.
- **Slot rules:** a second slot 900 → 409; slot 1000 → 400; PATCH code `null` → `code.set` false, audited `"cleared"`.
- **Leaver:** acct archives the person (`PATCH /api/payruns/people/<id> {archived: true}`) → slot 900 `leaver` true, in `GET /api/alarms/summary` with its name; remove the slot (future date → 400; today → 200) → not a leaver, code cleared; restore → 200; remove again.
- **Missing key:** with a code saved on 901, `docker exec` moves the key file to `/tmp`; `GET /api/alarms` → 200, `keyState` `missing`, 901 `readable` false; reveal → 409 with the sentence; saving a code on another slot → 409 with the sentence; clearing 901's code → 200. Move the file back; set 901's code again and reveal it → 200.
- **Company and times:** `PUT /api/alarms/company` with `monitoringPassword` → 400 `"Unknown field: monitoringPassword"`; the four fields (`M13 Alarm Co`) → 200. Times with six days → 400; `"25:00"` → 400; seven days → 200, Monday first.
- Clean-up: remove its slots, restore the person (acct).

### 11.5 `ci/smoke-m13-loans.sh` (D), `step "m13. loans"`

Prefix `M13_L_`. Fixed past dates, so the figures are exact.

- **Access:** `/loans.html` and `/loanprint.html`: admin 200, acct 403. `GET /api/loans`: admin 200, acct 403, dpm 403.
- **Create** `M13 Lender <tag>` loan, `lent_to_business`, opening $120,000.00 on 2025-01-01 → 201, balance 12000000. A future opening date → 400; a bad direction → 400.
- **Rates:** 600 from 2025-01-01, 650 from 2025-03-01 → 201; 5001 → 400; 600 again from 2025-01-01 → 409.
- **Repayments:**
  - 2025-01-10, principal 200000, interest left out → 201, interest 60000 (12000000 × 600 ÷ 120000), balance after 11800000.
  - 2025-01-24, principal 200000, interest left out → interest 0 (already charged this month), balance 11600000.
  - `GET …/interest?date=2025-02-07` → balance 11600000, rate 600, interest 58000.
  - 2025-02-07 principal 200000, interest 57000 (typed, as a statement) → stored 57000, `workedOutInterestCents` 58000.
  - 2025-03-07, interest left out → 11400000 × 650 ÷ 120000 = 61750.
  - Half-up: a second loan with opening 1000100 and rate 600 → the suggestion is 5001 (5000.5 rounded up).
  - Before the opening date → 400; future → 400; both zero → 400; a principal that takes the balance below zero → 409 naming the date; a repayment with no rate (a loan with no rates, interest left out) → 400.
- **Edit and delete:** move the 2025-01-24 repayment's principal so a later balance would go below zero → 409; delete it → the later balances rise by 200000.
- **Statement:** `from=2025-02-01&to=2025-03-31` → `balanceAtStartCents` is the balance after January, two rows, totals and end balance as calculated; `to` before `from` → 400.
- **Archive:** PATCH `archived: true` → a new repayment → 409; restore → 200.
- **Audit:** `loan.create`, `loan.rate_add`, `loan.repayment_add`, `loan.repayment_update`, `loan.repayment_delete`, `loan.update` rows for the loan, as the owner.
- Clean-up: archive both loans.

### 11.6 Backup suite (integrator, 4.1)

`ci/smoke-backup.sh` step 7 adds one check: the archive made in that run contains `config/alarm-code-key` (the M13 alarm suite made it earlier in the run).

### 11.7 Pages (E, F): local checks

As M12 §10.4:
- `node --check`, the style check, a shim boot with made-up data.
- Headless-Edge screenshots at 1440, 1100 and 375:
  - **E:** the Users page as the owner (the Owner mark, an owner-only override, Transfer dialog) and as a second admin (the owner's locked detail, the disabled owner-only buttons); bonuses Jobs, a draft (suggested Hours), a confirmed bonus with a paid share, Owed, Settings; print to PDF of a bonus (draft and confirmed) and the owed summary.
  - **F:** alarms with a leaver, a masked and a shown code, the missing-key block, the slot dialog; loans list, a loan with rates and repayments (a typed interest beside the worked-out one), the repayment dialog; print to PDF of a statement; the dashboard leavers line.
- As the owner, a second admin (no M13 pages), and an Accounts login granted `loans.manage` (Loans only).
- Keyboard reach of every control and dialog, no console errors from page scripts. **No real code, figure or name in any screenshot.**
- Wave 2 runs against the merged Wave 1.

### 11.8 Local checks (every task)

As M12 §10.5:
- `bash -n` and the smoke harness on each smoke file (fresh, then again on the same DB). **Only the integrator runs the whole adapted smoke** (at 4.1), so no two agents run full smokes at once (the stand-in Joinr's ports 4999/4996 are fixed).
- `node --check`, `node ci/style-check.js`, a shim boot on a fresh `.dev/<task>/` with the four `*_DISABLED=1` flags.
- **Scaffold:** 026 as §2's last paragraph; the route matrix (every access value, 501s, the two summary stubs); the pages gated and the menu items seen per role; `smoke.sh`'s loop line.
- **A:** a node replay of every §11.2 assertion against the shim (two admins, the transfer both ways, the audit filter with inserted rows); `smoke.sh` steps a and d's changed lines; the M1 users assertions in `smoke.sh` step d still pass.
- **B:** a node run of §4.1's maths over the §11.3 vectors and a few random prices (shares always add up to earned), then the replay.
- **C:** a node run of `lib/alarmcode.js`: round trip with a leading zero, a tampered tag or swapped row id refused, the three key states, the key never created while codes exist, the file mode where the OS supports it; then the replay (the `docker exec` steps emulated against the shim's `CONFIG_DIR`).
- **D:** a node run of §6.2 over the §11.5 vectors, then the replay.

## 12. Waves and file ownership

| Step | Who | Owns (only these files) | Starts after |
|---|---|---|---|
| **M13 · 2.2 Scaffold** | integrator | §1's scaffold rows | — |
| **3.1 Wave 1, A: owner, keys, users, audit** | worktree | `lib/auth.js`, `routes/auth.js`, `routes/users.js`, `lib/notify.js`, `lib/audit.js`, `routes/audit.js`, `ci/smoke.sh` (§11.1 A lines only), `ci/smoke-m13-owner.sh` | scaffold |
| **3.1 Wave 1, B: bonuses backend** | worktree | `lib/bonuses.js`, `routes/bonuses.js`, `ci/smoke-m13-bonuses.sh` | scaffold |
| **3.1 Wave 1, C: alarms backend** | worktree | `lib/alarmcode.js`, `lib/alarms.js`, `routes/alarms.js`, `ci/smoke-m13-alarms.sh` | scaffold |
| **3.1 Wave 1, D: loans backend** | worktree | `lib/loans.js`, `routes/loans.js`, `ci/smoke-m13-loans.sh` | scaffold |
| **3.2 Wave 2, E: Users page and bonuses pages** | worktree | `public/users.{html,css,js}`, `public/bonuses.{html,css,js}`, `public/bonusprint.{html,css,js}` | Wave 1 merged |
| **3.2 Wave 2, F: alarms, loans, dashboard** | worktree | `public/alarms.{html,css,js}`, `public/loans.{html,css,js}`, `public/loanprint.{html,css,js}`, `public/index.{js,html,css}` | Wave 1 merged |
| **4.1 Integrate** | integrator | merges; §1's 4.1 rows; STATUS; the whole adapted smoke; real-data checks of E and F | all |

- **Two waves** (plan §2.6): the four backend tasks share no file, nor do the two page tasks.
- **Wave-specific rules:**
  - B, C and D test their audit rows as the owner (`$ADMIN`) and don't depend on A's filter; A proves the filter with inserted rows (§11.2).
  - Until A's wiring is merged, nobody holds the three keys at runtime (the scaffold's `computeEffective` takes the owner argument, but `loadUser` doesn't pass it yet). So **B, C and D's local replays give their admin the three keys by grant overrides** inserted straight into the shim's `permission_overrides` (the route that would set them is A's). The integrator's full smoke after the merge uses the real owner.
  - `lib/payroll.js`'s two exports are the scaffold's; B and C call them and don't edit `lib/payroll.js`.
  - E and F read `cc.me.isOwner` and `meta.ownerOnlyKeys` from A's merged work.
- **Worktree base:** each agent resets to the commit the integrator names, and junctions `crosscuts/app/node_modules` from the main checkout (PowerShell `New-Item -ItemType Junction` if `cmd //c mklink` is refused). Junctions are unlinked before a worktree is removed.
- Scratch goes in the agent's scratchpad, and is copied into `.dev/` by the integrator.
- **tenon-quotr is never touched** (CLAUDE.md rule 12); no agent is sent to it.

## 13. Points the integrator decided (Todd can change any)

1. **Key names:** `bonuses.manage`, `alarms.manage`, `loans.manage`, appended to the list (30 keys). One key per area, no view/edit pair, because each area has one or two people who both read and record.
2. **The owner holds every key whatever the roles and overrides,** and an override can't be set on the owner (409). The owner always keeps the admin role (the existing "can't remove your own admin role" and "can't disable your own account" rules, plus nobody else may change the owner).
3. **Backfill:** the first-run setup user if still an enabled admin, else the earliest enabled admin, else the earliest admin. On a database with no users, setup marks the owner.
4. **Non-owner admins can't touch the owner's login at all** (name, roles, disable, password, sign-out, overrides), and can't grant or revoke an owner-only key for anyone, themselves included.
5. **Only the owner may reset the password of someone holding an owner-only key** (Problem 1), so a granted Loans key can't be taken over by another admin resetting that login's password.
6. **Handing over ownership** needs the new owner's username typed and the owner's own password; the new owner must be an enabled admin. The old owner stays an admin without the owner-only keys unless the new owner grants them back.
7. **The audit filter** hides the three areas' rows (and their action names) from everyone without the matching key, the owner seeing all; asking for them answers an empty list, not a refusal. Before/after values are kept for the key holders, except alarm codes, which never enter the log.
8. **Bonus maths:** possible and earned each rounded once, to the cent, half up; shares split by largest remainder so they add up to the earned bonus exactly; a share of 0 cents makes no row.
9. **Share points are whole numbers 0–1000** (only their ratios matter: halves can be doubled), and the share total is always added up.
10. **The price is prefilled from the job's value including GST** (Problem 2), only for someone who may see job values, and can be changed per bonus.
11. **Hours are kept in minutes** and shown in hours; quoted factory and install come from Joinr's factory and site doubled back; office and travel aren't used.
12. **The Hours check is suggested on the total:** ticked when actual factory plus install is at most quoted factory plus install, and only when all four are filled in; a hand tick wins until **Use suggestion**.
13. **A confirmed bonus is locked;** Reopen (only before any share is paid) returns it to draft and it follows today's rate and points when confirmed again. Only drafts can be deleted.
14. **Each confirmed bonus has a confirmed date** (typed, default today), so bonuses have dates for the owed list and the prints; a share can't be marked paid before it.
15. **Paying:** per share, or **Mark all paid** for a person (guarded by the list the page showed), with a date and an optional pay run; bonuses never change a pay run.
16. **Alarm codes are 1 to 12 digits,** kept as text (leading zeros kept).
17. **The code key file** is `config/alarm-code-key` (32 random bytes as hex, mode 600), made on the first code saved, never overwritten, and **never remade while codes saved with it exist**, so a lost file can't silently orphan them. A missing key makes codes unreadable with a clear sentence, never a crash.
18. **Each code is bound to its slot** (the slot's id is part of the encryption), and each row records which key it was saved with.
19. **Show reveals a code for 30 seconds** and writes an audit row naming the slot only; the mask is the same length for every code; no clipboard, no print of codes.
20. **Removing a slot clears its code;** removed slots stay listed (history), and a slot number is unique among slots in use. A restored slot comes back with no code.
21. **A leaver** is a slot whose holder is a staff person who has left (pay-only person archived, or board worker archived) and that isn't removed; typed-name holders are never flagged.
22. **The alarm company has no note field and refuses unknown fields,** so there's nowhere to type the monitoring password. The weekly times are "Arms at" (evening) and "Disarms at" (morning) per day, each optional.
23. **Loan interest is worked out once a month:** the first repayment in a calendar month gets balance × annual rate ÷ 12 (on the balance just before it, rounded half up); later ones that month get 0. Interest left out on a new repayment takes that figure; a typed figure (to match a statement) is kept, and the worked-out one is shown beside it when they differ.
24. **Loan rates are basis points (0–50%)** from a date; the rate on a day is the latest from that day or before.
25. **The balance is opening balance minus principal,** never typed or stored, and can't go below zero; interest doesn't change it. Further borrowing on the same loan isn't recorded (a new loan, if it happens).
26. **Loans are archived, never deleted;** rates and repayments can be deleted (audited with the row).
27. **Repayment, removal and paid dates can't be in the future;** a repayment can't be before the loan's opening date.
28. **Prints:** a job bonus, the bonuses owed summary and a loan statement (from and to dates), A4, black on white, no letterhead. No alarm print.
29. **The owner's dashboard** shows only the leavers line (for whoever holds `alarms.manage`); M13 adds no notice, task, comment or Planner item.
30. **Menus:** Admin gains Bonuses and Alarms after Audit; Accounts gains Loans after Supplier accounts. No new colour.
