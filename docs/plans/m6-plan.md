# Crosscuts — Milestone 6 plan: Joinr intake (2026-10-11)

Status: **approved by Todd 2026-10-11** (M6 · 1.3): every recommended answer in §10. Steps: M6 · 1.1 (audit, §1), M6 · 1.2 (plan and questions), M6 · 1.3 (decisions).

Source of truth: `crosscuts-brief.md` §6.4 and D3; the Workshop Scheduler note 07 and `joinr.md` on Todd's Drive; the `tenon-quotr` repo (read-only survey at `54d001d`); roadmap M6 row.

**M6 scope:** quotes marked **won** in Joinr reach Crosscuts as candidate jobs, with client, site, spec, sheet count, two-pac, benchtop and value filled in, without anyone retyping them; a shared **contract document** in both repos; and the Joinr endpoint that serves them.

**Two halves, two repos:**
- **Crosscuts side** (this repo): the puller, the intake inbox, the key and sync status, the alerts. Buildable and testable now against a stand-in Joinr.
- **Joinr side** (`tenon-quotr`): a per-org API key and one read-only endpoint. That repo deploys to production on merge and has its own rules (Todd's go for migrations and the service-role key), so it is a separate piece of work (question 2).

## 1. Audit findings (M6 · 1.1)

Three read-only surveys, 2026-10-11: the Joinr code, the Crosscuts side, and the Drive notes.

**Joinr (`tenon-quotr`):**
- Next.js 16 (App Router) on Vercel, Supabase Postgres with row-level security per org (`orgs`, `memberships`); TH Cabinets is org #1 (33 live quotes).
- **Quotes:** `quotes` has `id` (uuid), `org_id`, `quote_number` (typed by hand, nullable, e.g. `JRQ23104`), `client_name`, `status` (`draft`, `ready`, `sent`, `won`, `lost`), `data` (jsonb: job name = the site address, phone, email, reference, quote date, rooms with quantities and a per-room spec), revisions (new uuid, same `quote_number`, same `root_quote_id`), `standing` (active / alternative / superseded), soft delete then a purge after 90 days.
- **There is no won timestamp:** the time a quote was won is only in `quote_events` (`status_change` to `won`, with a growing bigint `id`, a good cursor). A won quote can be un-won, marked lost, deleted, or have a variation revision win later with the same number and a new uuid.
- **The total isn't stored:** it is computed by the pricing engine (job inc GST, options priced separately), in float dollars.
- **Spec fields are per room and free text per org:** two-pac comes from "Doors/panels" text (e.g. "2pac (S4)"), benchtop from per-org lists (including solid surface), job type per room (often blank), sheet count summed from board quantities (can be fractional, and the board section includes non-sheet items).
- **No integration API exists:** no API keys, no `/api/integrations`, no CORS. There are good patterns to reuse (the cron bearer check with a constant-time compare). The quote link `app.joinr.com.au/org/<org>/quotes/<id>` works for members only. Joinr's PROJECT_PLAN lists "a jobs table / any scheduler" under "not doing": this endpoint only reads quotes, it adds no jobs table.
- **Its rules:** short-lived branch, CI green, Todd's go; merging deploys to production; migrations and any new use of the service-role key need Todd's go; the RLS isolation suite must stay green.

**Crosscuts:**
- `jobs` already has `source` (`manual`, `joinr`, `board_quick_add`), `external_ref` (unique when set), `quote_number`, the client fields, `site_address`, the typed spec (`sheet_count`, `is_two_pac`, `benchtop` laminate/stone/none, free-text `job_type`), `value_cents` (GST-inclusive), `won_date`, `joinr_quote_url`. Jobs created by hand already carry the Joinr number in `quote_number`, not `external_ref`.
- Patterns to reuse: the round-up/reminder timers (env kill switch, first-start seeding, `unref`), the Gemini key file in `CONFIG_DIR` (never sent to the browser), `notify.toUsers` with dedupe, the job stage rules (`won` sets `won_date`).
- The smoke container runs with no env and no extra network: a stand-in Joinr can run inside the container (`docker exec`), pointed at by a file in the mounted config folder.

**Drive notes:** intent only (a won quote flows in pre-filled; the admin adds due date and priority; a job must stand on its own). Nothing on statuses, keys, endpoints or inbox vs auto-create.

**Traps found:**
1. **Duplicates.** Existing jobs match won quotes by `quote_number`, not `external_ref`; a variation revision gets a new uuid. Matching must use Joinr's stable `root_quote_id` and offer to link to an existing job with the same quote number.
2. **Reversals.** A won quote can be un-won, lost or deleted after Crosscuts has it. Crosscuts must flag that, never silently change or delete a job.
3. **Secrets.** A key in `app_settings` would be written in full into the audit log and the backups. It belongs in a file in `CONFIG_DIR` (as the Gemini key), write-only from the UI.
4. **Async timer.** The existing timers are synchronous. A network pull needs an in-flight guard, a timeout, a response size cap, every promise caught (an unhandled rejection stops Node and the board), and one transaction per quote.
5. **Messy upstream data.** Spec values are free text per org, so Joinr should send both a normalised value (or null when unsure) and the raw strings; Crosscuts never guesses beyond what is sent.
6. **No install date in Joinr**; client phone/email are mostly blank; the quote link is members-only.

## 2. How it works, in one paragraph

Every 5 minutes (and on **Sync now**), Crosscuts asks Joinr for anything that changed since its last cursor. A newly won quote appears in a **New from Joinr** list on the Design/PM page, with the client, site, value, spec and a link to the quote, and Design/PM gets a bell alert. They **Accept** it (a job is created at Won, filled in, `source = joinr`), **Link** it to an existing job (when the quote number already matches one; nothing is duplicated), or **Ignore** it (it stays ignored on later syncs). If Joinr later un-wins, loses, deletes or replaces a quote Crosscuts already took, the item is flagged "Changed in Joinr" with an alert; the job itself is never changed automatically. If Joinr is down or sends something odd, the sync status says so on the page and the rest of Crosscuts carries on.

## 3. The contract (shared document, in both repos)

`docs/integrations/joinr-crosscuts-intake.md`, version 1, committed to both repos. Proposed:

- **Endpoint:** `GET https://app.joinr.com.au/api/integrations/crosscuts/won-quotes?after=<cursor>&limit=<n ≤ 100>` with `Authorization: Bearer <org API key>`. The key fixes the org; no org id is ever accepted from the caller.
- **Response:** `{ cursor, items: [...], more }`. `cursor` is the last `quote_events.id` covered; `after` omitted means "from now" (returns the current cursor and no history) unless `backfill=won` asks for every currently won quote once.
- **Item** (one per quote that entered or left `won`, or changed while won): `quoteId`, `rootQuoteId`, `revision`, `quoteNumber`, `status`, `standing`, `deletedAt`, `wonAt` (from the event), `updatedAt`, `clientName`, `clientPhone`, `clientEmail`, `siteAddress` (the job name), `label`, `reference`, `quoteDate` (Sydney date), `valueIncGstCents` (job total inc GST, options excluded, priced on the server), `estimatedHours` (`{office, factory, site, travel}`), `spec: {sheetCount (number or null), twoPac (true/false/null), benchtop ('laminate'|'stone'|'none'|null), jobType (string or null)}`, `raw: {doorsPanels[], benchtops[], jobTypes[]}`, `url` (the members-only quote link).
- **Errors:** 401 bad key, 429 rate limited, 5xx; Crosscuts backs off and shows the error.
- **Rules:** idempotent (the same item may be sent again); ordered by cursor; no write endpoints.

## 4. Crosscuts data (migration `014_joinr.sql`, additive only)

- `joinr_intake`: `id`, `root_quote_id` (unique), `quote_id` (latest), `quote_number`, `status`, `payload` (the last item, JSON), `state` (`new`, `accepted`, `linked`, `ignored`), `job_id` (nullable), `changed` (flag: Joinr changed it after a decision), `first_seen_at`, `last_seen_at`, `decided_by`, `decided_at`.
- `integration_sync`: one row for Joinr: `cursor`, `last_ok_at`, `last_error`, `last_error_at`, `items_last_run`.
- `jobs.external_ref` holds the Joinr **root** quote id for jobs created or linked from Joinr.
- The key and the base URL are files in `CONFIG_DIR` (`joinr-api-key`, `joinr-base-url`), with env overrides; never in the database, never sent to the browser, never in a URL.

## 5. Intake behaviour

- **Accept** (`jobs.edit`): creates the job at `won` (`won_date` = the Joinr won date), `source = joinr`, `external_ref` = root quote id, `quote_number`, client, site, value, spec (only normalised values; raw strings go into the notes), `joinr_quote_url`. Audited `job.create` plus `joinr.accept`.
- **Link** (`jobs.edit`): offered when a job without an `external_ref` has the same `quote_number`; sets `external_ref` and the Joinr link on that job, fills only empty fields, changes nothing else.
- **Ignore** (`jobs.edit`): kept as ignored; a later change in Joinr marks it "Changed in Joinr" but doesn't bring it back as new.
- **After a decision:** if Joinr un-wins, loses, deletes or replaces the quote (a new revision wins), the item gets `changed` and Design/PM gets one alert. The job is never edited or archived automatically; the job page shows "Changed in Joinr" with the details.
- **Who sees it:** the inbox and status on the Design/PM page (`design.view`); alerts `joinr.new` and `joinr.changed` to `design.view` holders, deduped per quote.

## 6. The puller

- Every 5 minutes, only when a key is configured; `JOINR_SYNC_DISABLED=1` turns it off. One run at a time (Sync now shares the lock).
- `fetch` with a 15 s timeout, a 2 MB response cap, schema checks on every item before any write; one transaction per item, so a bad item is logged and skipped without blocking the rest; the cursor only advances past items handled.
- First start with a key: asks for the current cursor (no history), unless an admin presses **Import currently won quotes** once (`backfill=won`).
- Errors never throw out of the timer; the status row and the page show the last success and the last error.

## 7. Settings page

- On `/users.html` (admin), a **Joinr** section: Joinr address (default `https://app.joinr.com.au`), API key (write-only; shows "Set, ending ••••1234" after saving; Remove), Test connection, Import currently won quotes. Audited without the key.

## 8. Joinr side (if Todd says build it; question 2)

In `tenon-quotr`, on its own branch, following its CLAUDE.md and PROJECT_PLAN rules, nothing merged or deployed without Todd's go:
- a migration: `org_api_keys` (hashed key, label, created/revoked, last used), RLS-suite cases;
- an owner-only page to create and revoke keys (shown once);
- the endpoint per §3, authenticating by key hash through a security-definer function (no new service-role use), pricing on the server with the engine;
- tests and the contract document.

## 9. Build, tests, release

- **Crosscuts waves:** 2.2 scaffold (migration 014, contract doc, key/base-URL file helpers, empty routers); Wave 1: **A** the puller and sync status (with a stand-in Joinr for tests), **B** the inbox page and Accept/Link/Ignore, **C** the settings section; Wave 2: **D** job-page "From Joinr" panel and alerts polish.
- **Tests:** a `smoke-m6-*.sh` runs a stand-in Joinr inside the container (`docker exec … node -e`), points Crosscuts at it through the config folder, and checks: no key = no calls; new won quote → inbox + alert; Accept → job at Won with the fields; same quote again → nothing new; a revision → same item; un-won → "Changed in Joinr", job untouched; bad payload → skipped and reported; Joinr down → status error, app fine; the key never appears in any API response or the audit log.
- **Release:** Crosscuts 0.1.6 (with M5) or later, as Todd decides; the Joinr side has its own release.

## 10. Questions for Todd (M6 · 1.2) and decisions (M6 · 1.3, 2026-10-11)

1. **Intake:** (a) *Recommended:* a "New from Joinr" inbox where Design/PM accepts, links or ignores each won quote (safe with reversals, variations and jobs you already typed in). (b) Create the job automatically at Won as soon as Joinr says won.
   - **Decision: (a)**, the inbox.
2. **Who builds the Joinr endpoint:** (a) *Recommended:* I write the contract and build the Joinr side too, on a branch in `tenon-quotr` under its rules, nothing merged or deployed without your go. (b) Contract only for now; the Joinr side waits.
   - **Decision: (a)**, both sides; the Joinr side on a `tenon-quotr` branch under its rules, nothing merged or deployed (and no production migration) without Todd's go.
3. **Jobs you already typed in:** (a) *Recommended:* when a won quote's number matches an existing job, offer **Link** (no duplicate). (b) Always create a new job.
   - **Decision: (a)**, offer Link.
4. **Value:** (a) *Recommended:* fill the job value from Joinr's total inc GST (options left out). (b) Leave the value for Design/PM to enter.
   - **Decision: (a)**, total inc GST, options left out.
5. **First sync:** (a) *Recommended:* start from now; an admin can import the currently won quotes once with a button. (b) Import every won quote automatically on the first sync.
   - **Decision: (a)**, from now, plus the one-off import button.
