# M6 interface contracts (binding for all M6 subagents)

Read `docs/plans/m6-plan.md` (its §10 decisions are binding) and the shared wire contract `docs/integrations/joinr-crosscuts-intake.md` (binding on both repos). This file is the Crosscuts-internal *what*, plus the scope of the Joinr-side task. Everything in `m1-contracts.md` … `m5-contracts.md` still holds. If a contract looks wrong, report it instead of working around it.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (shim locally), Node 24 (global `fetch`, `AbortSignal.timeout`). **No version bump** during the build. **No new feature keys.** The board files are not touched.

## 1. Migration (scaffold, M6 · 2.2): `014_joinr.sql`

```sql
-- M6 Joinr intake (docs/plans/m6-contracts.md section 1). Additive only.
CREATE TABLE joinr_intake (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_quote_id TEXT NOT NULL UNIQUE,                 -- Joinr rootQuoteId (uuid): one record per quote
  quote_id TEXT NOT NULL,                             -- the latest revision's quoteId
  quote_number TEXT,
  joinr_status TEXT NOT NULL,                         -- the quote's status in Joinr, as last seen
  last_event TEXT NOT NULL CHECK (last_event IN ('won','unwon','changed','deleted')),
  payload TEXT NOT NULL,                              -- the last item, as JSON
  state TEXT NOT NULL DEFAULT 'new'
    CHECK (state IN ('new','accepted','linked','ignored','withdrawn')),
  changed INTEGER NOT NULL DEFAULT 0,                 -- 1: Joinr changed it after a decision
  job_id INTEGER REFERENCES jobs(id),
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT
);
CREATE INDEX idx_joinr_intake_state ON joinr_intake(state, last_seen_at);
CREATE INDEX idx_joinr_intake_job ON joinr_intake(job_id);

CREATE TABLE integration_sync (
  name TEXT PRIMARY KEY,                              -- 'joinr'
  cursor TEXT,
  last_run_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  last_items INTEGER NOT NULL DEFAULT 0
);
```

## 2. Libraries

### `lib/joinr-config.js` (scaffold, complete)

The key and base URL live in files in `CONFIG_DIR`, never in the database, never in a URL, never in a response or log.

```js
const DEFAULT_BASE = "https://app.joinr.com.au";
function getKey();          // env JOINR_API_KEY, else file CONFIG_DIR/joinr-api-key (trimmed), else null
function getBaseUrl();      // env JOINR_BASE_URL, else file CONFIG_DIR/joinr-base-url, else DEFAULT_BASE (no trailing slash)
function keyStatus();       // {configured: bool, last4: string|null, fromEnv: bool}
function setKey(value);     // writes the file (mode 0o600); 8–200 printable chars, no whitespace, else HttpError 400
function clearKey();        // removes the file (env keys can't be cleared: 409)
function setBaseUrl(url);   // http(s) URL, no query/fragment, ≤ 200; null/"" removes the file (back to default)
```

### `lib/joinr-sync.js` (Wave 1 A)

```js
// Fetches one page: GET {base}/api/integrations/crosscuts/won-quotes with the key as a Bearer
// header, 15 s timeout (AbortSignal.timeout), 2 MB response cap, JSON only. Throws a plain Error
// whose message never contains the key or the full URL with credentials.
async function fetchPage({after, backfill, limit});
// Validates an item against the wire contract; returns a normalised object or throws.
function validateItem(item);
// Applies one validated item in its own transaction (rules in section 4). Returns
// {action: 'created'|'updated'|'withdrawn'|'restored'|'flagged'|'ignored'|'skipped'}.
function applyItem(db, item);
// One sync run: pages until more=false (max 20 pages), applies items, advances the cursor past
// each handled item, records integration_sync. Never throws. Returns {ok, items, error}.
// opts.backfill: the one-off import (section 3). One run at a time: a second call while one is
// running waits for it and returns its result.
async function run(db, opts);
// Every 5 minutes, only when a key is configured; JOINR_SYNC_DISABLED=1 turns it off; unref().
// First run with a key and no cursor: asks with no `after` and stores the cursor (no history).
function start(db);
function status(db);        // {configured, baseUrl, lastRunAt, lastOkAt, lastError, lastErrorAt, lastItems, running}
```

### `lib/intake.js` (Wave 1 B)

```js
function list(db, user, {state});            // intake objects (section 3), newest last_seen first
function get(db, user, id);
function matches(db, id);                    // jobs with the same quote_number and no external_ref
function accept(db, req, id);                // section 5; returns {item, job}
function link(db, req, id, jobId);           // section 5
function ignore(db, req, id);
function acknowledge(db, req, id);           // clears `changed`
function forJob(db, user, jobId);            // the intake object linked to a job, or null
```

## 3. API (`routes/joinr.js`, `defineRoutes('/api/joinr')`)

**Intake object:** `{id, rootQuoteId, quoteId, quoteNumber, joinrStatus, lastEvent, state, changed, job:{id,name}|null, firstSeenAt, lastSeenAt, decidedBy:{id,name}|null, decidedAt, matches (count), quote:{clientName, clientPhone, clientEmail, siteAddress, label, reference, quoteDate, wonAt, valueIncGstCents (null without jobs.value), estimatedHours, spec, raw, url}}`.

| Route | Access | Owner | Behaviour |
|---|---|---|---|
| `GET /intake?state=new\|changed\|decided\|ignored\|withdrawn\|all` | `design.view` | B | default `new`; `changed` = any state with `changed=1`; `decided` = accepted + linked → `{rows, sync: status}` |
| `GET /intake/:id` | `design.view` | B | one object, plus `matchJobs: [{id, name, clientName, stage}]` when `jobs.edit` |
| `POST /intake/:id/accept` | `jobs.edit` | B | 409 unless state `new`; 409 if a job already has that `external_ref` |
| `POST /intake/:id/link` `{jobId}` | `jobs.edit` | B | 409 unless state `new`; the job must have no `external_ref` |
| `POST /intake/:id/ignore` | `jobs.edit` | B | from `new` or `withdrawn` |
| `POST /intake/:id/acknowledge` | `jobs.edit` | B | clears `changed` |
| `GET /job/:jobId` | `jobs.view` | B | `forJob` → object or 404 |
| `POST /sync` | `jobs.edit` | A | awaits `run(db)` → `{ok, items, error}`; 409 `{error:'Joinr is not set up'}` without a key |
| `POST /import` | `users.admin` | A | awaits `run(db, {backfill:true})` |
| `GET /status` | `design.view` | A | `status(db)` |
| `GET /settings` | `users.admin` | C | `{baseUrl, key: keyStatus(), sync: status}` |
| `PUT /settings` `{baseUrl?, apiKey?}` | `users.admin` | C | audit `joinr.settings` with `{baseUrl changed?, key: 'set'}` only, never the key |
| `DELETE /settings/key` | `users.admin` | C | audit `joinr.settings` `{key:'cleared'}` |
| `POST /test` | `users.admin` | C | one `fetchPage({})` → `{ok:true, cursor}` or `{ok:false, error}` |

The scaffold creates `routes/joinr.js` with these registered as 501 stubs in three marked blocks (A, B, C); each wave replaces only its block.

## 4. Applying items (Wave 1 A, `applyItem`)

Keyed on `rootQuoteId`:
- **No record:** a `won` item with `status = won` and no `deletedAt` creates a record (`state new`) and alerts `joinr.new`. Any other item with no record is skipped.
- **State `new`:** a `won`/`changed` item updates `quote_id`, `quote_number`, `joinr_status`, `payload`, `last_seen_at`; `unwon` or `deleted` sets `state withdrawn`.
- **State `withdrawn`:** a `won` item sets `state new` again (alert `joinr.new`); others just update.
- **States `accepted` / `linked`:** any item whose fields differ from the stored payload (ignoring `cursor` and `updatedAt`), or any `unwon`/`deleted`, or a `won` for a different `quoteId`, sets `changed = 1`, updates the payload, and alerts `joinr.changed` (to `design.view` holders, deduped per record). The job is never edited.
- **State `ignored`:** updates the payload; sets `changed = 1` silently (no alert).
- Alerts: `notify.toUsers(db, usersWithKey('design.view'), {kind, title, body, link: '/intake.html?item=N', entityType: 'joinr_intake', entityId: N}, {dedupeUnread: true})`. Titles: "New from Joinr: <quote number> <site or client>", "Changed in Joinr: <quote number> …".
- An item that fails validation is logged (`[joinr] skipped item <cursor>: <reason>`), counted, and the cursor still advances past it.

## 5. Accept and Link (Wave 1 B)

- **Accept** creates a job in one transaction: `name` = siteAddress, else label, else clientName, else quoteNumber (≤ 200); `stage 'won'`, `won_date` = the Sydney date of `wonAt` (else today), `quoted_date` = `quoteDate`; `source 'joinr'`; `external_ref` = `rootQuoteId`; `quote_number`; `client_name/phone/email`; `site_address`; `sheet_count`, `is_two_pac`, `benchtop`, `job_type` from `spec` (null stays null); `value_cents` = `valueIncGstCents`; `joinr_quote_url` = `url`; `notes` = "From Joinr <quote number>: Doors/panels: …; Benchtop: …; Job type: …; Estimated hours: office x, factory y, site z, travel w." (only parts that exist). Then `state accepted`, `job_id`, `decided_*`. Audit `job.create` (as `routes/jobs.js` does) and `joinr.accept`.
- **Link** sets the job's `external_ref` and, only where empty, `joinr_quote_url`, `quote_number`, client name/phone/email, `site_address`, spec fields and `value_cents`. Audit `job.update` (changed fields) and `joinr.link`.
- **Ignore** / **acknowledge**: audit `joinr.ignore` / `joinr.acknowledge`.

## 6. Pages

- **`/intake.html`** (Wave 1 B; `design.view`; `in-` prefix): title "New from Joinr"; views New (default), Changed, Accepted and linked, Ignored, Withdrawn; a sync line ("Last checked 3 min ago", the last error in orange if any) with **Sync now** (`jobs.edit`). Each item: quote number, site, client, value, quote date, won date, spec (normalised values, then the raw strings muted), estimated hours, "Open in Joinr" (new tab, `rel="noopener noreferrer"`); buttons Accept, Link to a matching job (a select of `matchJobs`), Ignore; for changed items, what changed and Acknowledge. `?item=N` scrolls to and highlights it. User text via `textContent`; links only `http(s)`.
- **`/users.html` Joinr section** (Wave 1 C; `users.html` / `users.js` / `users.css` additions only): Joinr address, API key (password field; after saving shows "Set, ending ••••1234"; Remove), Test connection, Import currently won quotes (confirm first), and the sync status.
- **Design page tile and job page panel** (Wave 2 D): `design.html` gains a "New from Joinr" tile with the New count; `job.html` gains a "From Joinr" panel (quote number, Open in Joinr, status in Joinr, "Changed in Joinr" with Acknowledge) when `GET /api/joinr/job/:jobId` returns one.
- `lib/pages.js` (scaffold): `/intake.html: 'design.view'`.

## 7. Server (scaffold)

`server.js`: mount `routes/joinr.js`; after listen, `require('./lib/joinr-sync').start(db)` (a no-op stub until Wave 1 A).

## 8. Tests

- **`ci/fake-joinr.js`** (Wave 1 A): a dependency-free Node HTTP server implementing the wire contract for tests: `node fake-joinr.js <port> <key>`; serves `/api/integrations/crosscuts/won-quotes` from an in-memory event list; control endpoints `POST /_control/event` (append an item), `POST /_control/fail` `{status|"hang"|"garbage"}` for the next N calls, `GET /_control/requests` (what Crosscuts sent, with the Authorization header redacted to its last 4).
- **`ci/smoke-m6-intake.sh`** (A and B together; A writes it, B adds its assertions in a marked block): `docker cp ci/fake-joinr.js "$CONTAINER":/tmp/` then `docker exec -d "$CONTAINER" node /tmp/fake-joinr.js 4999 <test key>`; write `/data/config/joinr-base-url` (`http://127.0.0.1:4999`) and `joinr-api-key` through `docker exec`; then assert: no key → `POST /api/joinr/sync` 409 and no requests to the fake; with the key → first sync stores a cursor and creates nothing; a `won` event → one `new` record, a `joinr.new` alert for dpm, none for sched/show; the same event again → still one; Accept → a job at `won` with the mapped fields, `source joinr`, `external_ref` = root id; a later `changed` item with a new value → `changed=1`, the job's value unchanged; `unwon` on an undecided record → `withdrawn`; Link → the existing job gains `external_ref` and keeps its own non-empty fields; Ignore then a change → still ignored, `changed=1`, no alert; a garbage page / a 500 / a hang → `/status` shows the error, the app still serves `/api/schedule`; the key never appears in `/api/joinr/settings`, `/api/audit` or `docker logs`; access: show/sched 403 on intake, acct 403 on settings, dpm 403 on settings and import.
- Local: each task boots the shim on a fresh `.dev/<task>/` with `JOINR_SYNC_DISABLED=1` unless testing the timer, runs `ci/fake-joinr.js` on the host, and points Crosscuts at it with `JOINR_BASE_URL`/`JOINR_API_KEY` or the config files.

## 9. Waves and file ownership

| Step | Who | Owns |
|---|---|---|
| **M6 · 2.2 Scaffold** | integrator | `db/migrations/014_joinr.sql`, `lib/joinr-config.js`, `lib/joinr-sync.js` (stub `start`/`status`), `lib/intake.js` (stubs), `routes/joinr.js` (three stub blocks), `server.js`, `lib/pages.js`, `ci/smoke.sh` (source line `smoke-m6-*`), `docs/integrations/joinr-crosscuts-intake.md`, `docs/auth.md` |
| **3.1 A: the puller** | worktree | `lib/joinr-sync.js`, `routes/joinr.js` (block A), `ci/fake-joinr.js`, `ci/smoke-m6-intake.sh` |
| **3.1 B: the inbox** | worktree | `lib/intake.js`, `routes/joinr.js` (block B), `public/intake.{html,css,js}`, its block in `ci/smoke-m6-intake.sh` (after A merges; B writes `ci/smoke-m6-inbox.sh` instead if A is not merged yet) |
| **3.1 C: settings** | worktree | `routes/joinr.js` (block C), `public/users.{html,js,css}` (Joinr section only) |
| **3.1 J: the Joinr side** | worktree in `tenon-quotr` | see section 10 |
| **3.2 D: tile and job panel** | worktree | `public/design.html`, `public/job.{html,js}`, `public/jobs.css` (`jo-` additions) |

## 10. The Joinr side (task J, repo `tenon-quotr`)

Built on a short-lived branch in `C:\Users\todd\Desktop\Claude\code\tenon-quotr`, following that repo's `CLAUDE.md` and `PROJECT_PLAN.md` rules (read them first). **Nothing is merged, pushed, deployed or migrated in production without Todd's go**, and no new use of the service-role key. Scope:
- a migration: `org_api_keys` (id, org_id, label, key_hash, last4, created_by, created_at, revoked_at, last_used_at) with RLS (members of the org can see their keys' metadata; owners create/revoke), and a `security definer` function that resolves a key hash to an org id; the RLS isolation suite extended;
- an owner-only settings page to create (shown once), list and revoke keys;
- the endpoint `GET /api/integrations/crosscuts/won-quotes` exactly as the wire contract, authenticating through that function (constant-time hash compare), reading quotes and `quote_events` for that org only, pricing on the server with the engine (`valueIncGstCents`, `estimatedHours`), normalising per the contract, and allowlisted in the session middleware;
- tests (unit tests for normalisation and paging; the RLS suite); the contract document committed under `docs/integrations/`; that repo's docs duties.

## 11. Changes after the M6 · 4.2 review (M6 · 4.3)

The integrator's decisions on the independent review; these override the sections above where they differ.

1. **Address change (§3 `PUT /settings`).** When the effective base URL really changes (before vs after), the same request deletes the key file and resets `integration_sync` for `joinr` (`cursor`, `last_error`, `last_error_at` to null, through `joinrSync.reset(db)`), so the next run starts from now at the new address. A run in flight stops before its next item or cursor write. With the key in the environment the change is refused: 409 "Remove JOINR_API_KEY from the environment first"; with the address in the environment a different address is refused (409). A new `apiKey` in the same request is saved after the change. Audit `joinr.settings` `{baseUrl, key: 'cleared', cursor: 'reset'}`, plus `newKey: 'set'` when a key came with it (a key alone is still `{key: 'set'}`). The users page says "Changing the address removes the saved key; enter the key for the new address." Everything is validated before anything is written.
2. **Repeats after a decision (§4).** For `accepted`/`linked`/`ignored` records only a real difference found by `changedFields` (it compares the revision, status and `deletedAt` among the rest) flags the record (and alerts, for accepted/linked); an `unwon`/`deleted`/`won` event on its own is not a change. An identical repeat only updates `last_seen_at`.
3. **CI (§8).** `ci/smoke-m6-intake.sh` Block B now runs puller-driven decisions (Accept through the API, a `changed` value → flagged with one `joinr.changed` alert and the job untouched; the identical item again and a repeated `unwon` → nothing new, checked after acknowledging and marking alerts read so dedupe can't hide a second alert; Ignore then a change → flagged, no alert), paging faults (older position, stuck paging), and a settings section (key + address through the API, last four only, no key in `/api/audit`, DELETE, acct/dpm 403 on settings/test/import, https rule, an address change clearing the key and cursor, then restoring the stand-in). The import runs one item per page so it pages through opaque cursors. `ci/smoke-m6-inbox.sh` adds `countsOnly` and Link to a lost or archived job.
4. **Impossible dates.** `validateItem` refuses a `quoteDate`, and the date part of any date-time (`wonAt`, `deletedAt`, `updatedAt`), that does not survive a UTC round trip (2026-02-30 is invalid; `Date.parse` alone rolls it over). `quoteOf` (`lib/intake.js`) drops such a `quoteDate` or `wonAt` to null, so Accept falls back to today's Sydney date for `won_date` (as it does for `wonAt: null`).
5. **Cursor going backwards.** When the `after` sent and the page's cursor are both plain whole numbers, a lower page cursor fails the run ("Joinr sent an older position"): nothing on that page is applied and the stored cursor is unchanged. Cursors stay opaque (any printable string up to 100 characters): non-numeric ones are never judged older and are stored and sent back exactly as given.
6. **Stuck paging.** A page with `more: true` whose cursor equals the `after` sent (exact string compare) fails the run ("Joinr's paging did not move forward"), before anything on it is applied.
7. **Plain http.** `setBaseUrl` (via `normaliseBaseUrl`) accepts `http://` only for loopback (`localhost`, 127.0.0.0/8, `::1`), the private IPv4 ranges (10/8, 172.16/12, 192.168/16) and `*.local`; anything else is 400 "Use an https address".
8. **Truncated runs.** A run that stops at the 20-page limit with `more` still true returns `{ok: true, truncated: true, message}` (also on `POST /sync` and `POST /import`), and the status row gets `last_ok_at` and `last_error` "Stopped after 20 pages; run it again to continue". A sync keeps the cursor of what it handled; an import remembers (in memory) the last backfill cursor and resumes there on the next import, and leaves the stored cursor alone. The import button shows the message.
9. **Test connection (§3 `POST /test`).** Uses `fetchPage({})` (no `after`, no `backfill`) and returns its messages (`{ok: false, error}`; "No API key is set" without a key); block C's own fetch code is gone. `fetchPage`'s network messages now name the common faults (address not found, connection refused or reset, certificate problem) with the code in brackets.
10. **Nits.** (a) `GET /api/joinr/intake?countsOnly=1` returns `{counts}` only; the Design/PM tile uses it. (b) `GET`/`PUT /api/joinr/settings` add `baseUrlFromEnv: bool`; the users page disables the address field with a note when true and then leaves `baseUrl` out of its PUT. (c) Link refuses an archived job or one at stage `lost`/`archived` (409 "Link only to a live job"), and such jobs are no longer offered as matches (`matches`, `matchJobs`). (d) `validateItem` caps `valueIncGstCents` at 99,999,999,999, the same as `quoteOf`.
11. **The stand-in (`ci/fake-joinr.js`).** Backfill pages that are not the last carry an opaque cursor `b.<event id>.<rootQuoteId>` (as the real Joinr does) and `after` accepts it; `POST /_control/pagesize {max}` caps page size; `POST /_control/fail {"fail": {"page": {...}}}` answers with that envelope (a `"$after"` cursor echoes the `after` sent).
