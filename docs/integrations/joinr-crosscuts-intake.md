# Joinr → Crosscuts intake: shared contract (version 2, 2026-10-14)

This document is committed, identical, in both repos: `devcal1/joinr-crosscuts` (`docs/integrations/joinr-crosscuts-intake.md`) and `devcal1/tenon-quotr` (`docs/integrations/joinr-crosscuts-intake.md`). Change it only in both at once, with a version bump here, and with Todd's OK. Approved by Todd 2026-10-11 (Crosscuts `docs/plans/m6-plan.md` §10).

**Version 2 (M11, plan approved by Todd 2026-10-13)** adds one optional item field, `drawers` (the won quote's drawer lines). The wire `contract` number stays **1**: the field is optional, an older Crosscuts ignores it, and a Joinr that doesn't send it is read as "no drawer data". The version 2 text was written in the Crosscuts repo first; the copy in `tenon-quotr` follows in task J2 (Crosscuts `docs/plans/m11-contracts.md` §13), which needs Todd's go.

## Purpose

Crosscuts (TH Cabinets' operations app on an Umbrel server, on the workshop LAN) learns about quotes that are **won** in Joinr, so Design/PM can turn them into jobs without retyping. Crosscuts **pulls**; Joinr never calls Crosscuts (it has no public address). The endpoint is read-only.

## Endpoint

```
GET {base}/api/integrations/crosscuts/won-quotes?after={cursor}&limit={n}
GET {base}/api/integrations/crosscuts/won-quotes?backfill=won&limit={n}[&after={cursor}]
Authorization: Bearer {org API key}
Accept: application/json
```

- `{base}` is `https://app.joinr.com.au` in production.
- **Authentication:** an org API key, created and revoked by an org owner in Joinr. The key alone identifies the org; the endpoint never accepts an org id from the caller. Keys are stored hashed; comparison is constant-time. A revoked or unknown key → 401.
- `limit`: 1–100, default 50.
- **Without `after` and without `backfill`:** returns `{cursor: <current>, items: [], more: false}`, i.e. "start from now".
- **`after={cursor}`:** items for quotes whose status-change events (in `quote_events`) have ids greater than `cursor`, in event order, plus changes listed under "Which events produce an item".
- **`backfill=won`:** every quote of the org that is currently `won` and not deleted, one item each (paged with `after` = the last item's `cursor`), then normal use resumes from the `cursor` returned by the final page.
- Rate limit: up to 60 requests per minute per key; beyond that 429 with `Retry-After`.

## Response

```json
{
  "contract": 1,
  "cursor": "12345",
  "more": false,
  "items": [ { ...item... } ]
}
```

- `cursor` is an opaque string (it is a `quote_events.id` in Joinr today). Crosscuts stores it and sends it back as `after`. It only grows.
- `more: true` means call again with `after = cursor` straight away.
- The same item may be sent more than once (Crosscuts is idempotent on `rootQuoteId`).

## Item

| Field | Type | Meaning |
|---|---|---|
| `cursor` | string | the event id this item was produced for |
| `event` | `"won"` \| `"unwon"` \| `"changed"` \| `"deleted"` | see below |
| `quoteId` | uuid | this revision's id |
| `rootQuoteId` | uuid | the id shared by all revisions of the quote (Crosscuts' key) |
| `revision` | integer | revision number |
| `quoteNumber` | string \| null | e.g. `JRQ23104`, as typed in Joinr |
| `status` | `draft`\|`ready`\|`sent`\|`won`\|`lost` | the quote's status now |
| `standing` | `active`\|`alternative`\|`superseded` | |
| `deletedAt` | ISO UTC \| null | soft-deleted in Joinr |
| `wonAt` | ISO UTC \| null | when it was last marked won (from the event) |
| `updatedAt` | ISO UTC | |
| `clientName` | string | |
| `clientPhone` | string \| null | blank → null |
| `clientEmail` | string \| null | blank → null |
| `siteAddress` | string \| null | Joinr's job name (the job address) |
| `label` | string \| null | the quote's label |
| `reference` | string \| null | |
| `quoteDate` | `YYYY-MM-DD` \| null | Sydney date |
| `valueIncGstCents` | integer \| null | the job total including GST, options excluded, priced on Joinr's server with its engine, rounded to the cent; null if it can't be priced |
| `estimatedHours` | `{office, factory, site, travel}` numbers \| null | from the engine |
| `spec.sheetCount` | integer \| null | see Normalisation |
| `spec.twoPac` | boolean \| null | see Normalisation |
| `spec.benchtop` | `"laminate"`\|`"stone"`\|`"none"` \| null | see Normalisation |
| `spec.jobType` | string \| null | see Normalisation |
| `raw.doorsPanels` | string[] | every room's Doors/panels value, as typed |
| `raw.benchtops` | string[] | every room's benchtop value, as typed |
| `raw.jobTypes` | string[] | every room's job type, as typed |
| `drawers` | `{section, name, qty}[]` \| absent (version 2, optional) | the revision's lines in the catalogue sections with id `drawers` and `innerDrawers`; see Normalisation. `section` is that id (`"drawers"` or `"innerDrawers"`). `name` is the catalogue item name as stored on the line. `qty` is the sum for that name in that section across every room, a positive number. Absent means "not reported"; `[]` means the quote has no such lines |
| `url` | string | `{base}/org/{orgId}/quotes/{quoteId}` (members-only link) |

## Which events produce an item

- **`won`:** the quote's status changed to `won`.
- **`unwon`:** a quote that was `won` changed to any other status (including `lost`).
- **`deleted`:** a quote that was `won` (or had been sent as `won` earlier) was soft-deleted.
- **`changed`:** a quote currently `won` was edited in a way that changes any item field (Joinr may send `changed` for any save of a won quote; Crosscuts compares fields itself).
- A revision of a won quote that is itself marked `won` produces a `won` item with the same `rootQuoteId` and its own `quoteId`.

## Normalisation (Joinr computes; Crosscuts never guesses further)

- **`twoPac`:** true if any room's Doors/panels value, or any board item name, contains "2pac", "2-pac", "2 pac" or "two pac" (case-insensitive); false if every room has a non-empty Doors/panels value and none matches; otherwise null.
- **`benchtop`:** per room: contains "stone", "caesarstone", "quartz", "granite", "marble" or "porcelain" → stone; contains "laminate" → laminate; is "none", "n/a", "no benchtop" or "by others" → none; anything else → unknown. The quote's value is the highest of its rooms' known values (stone > laminate > none); null if no room has a known value. Solid surface and other materials → unknown.
- **`sheetCount`:** the sum of quantities of board-section catalogue items whose unit is a sheet (items priced per length, per metre or per each are excluded), rounded **up** to a whole number; null if the quote has no such items.
- **`jobType`:** if every non-blank room job type is the same, that value; if they differ, the distinct values joined with " / "; null if all are blank.
- **`drawers` (version 2):** Joinr walks the quote's catalogue sections with id `drawers` and `innerDrawers` and, for each room, reads the quantity of every item in them.
  - Rows with the same `name` in the same section are added together across all rooms (`qty` is the sum).
  - It skips lines whose name isn't in the quote's card (stale lines, as the pricing engine's quantity sum does), lines whose quantity isn't a positive finite number, and the room-level custom items.
  - It sends `[]` when the quote has no such lines, or when the org has deleted both sections.
  - Order: by section (`drawers` first), then by name.
  - Crosscuts accepts at most 200 entries. Each needs a `section` of `drawers` or `innerDrawers`, a non-empty `name` of at most 200 characters (trimmed), and a `qty` that is a number above 0 and at most 100000. A fractional `qty` is rounded half up to a whole number, and an entry that rounds to 0 is dropped. A bad entry refuses the item, naming the field (`drawers[<i>]`), never the value.

## Errors

- `401 {"error":"unauthorised"}`: missing, unknown or revoked key.
- `400 {"error":"..."}`: bad `limit`, `after` or `backfill`.
- `429` with `Retry-After` seconds.
- `5xx`: Crosscuts retries on its next run.

## What Crosscuts does with an item (for reference; not binding on Joinr)

One intake record per `rootQuoteId`. `won` → shown as new (or updated if not yet decided); after a decision (accepted, linked, ignored), any later item marks the record "Changed in Joinr" and alerts Design/PM; jobs are never edited or deleted automatically. The key is kept in a file on the Umbrel, never in a URL or a log.

**Drawers (version 2).** Crosscuts maps each `drawers` name to a drawer brand, height and length through a list its Ordering team keeps, and fills in a drawer grid on the job when the record is accepted or linked. It never changes a grid by itself afterwards: the job page says "Changed in Joinr" and offers a refill.
- **Absent or `null`** is "not reported". An older Joinr gets no grid, and a job accepted before this field existed has none.
- **Changed detection:** `drawers` counts as a change only when both the stored and the new item have an array and the two differ. The first item to report `drawers` where the stored one had none is stored, but not flagged "Changed in Joinr", so the first sync after Joinr starts sending the field doesn't mark every accepted record changed.

## Version history

- **Version 1 (2026-10-11):** the first contract.
- **Version 2 (2026-10-14):** the optional `drawers` field. The wire `contract` stays 1.
