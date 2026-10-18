# Joinr → Crosscuts intake: shared contract (version 4, 2026-10-18)

This document is committed, identical, in both repos: `devcal1/joinr-crosscuts` (`docs/integrations/joinr-crosscuts-intake.md`) and `devcal1/tenon-quotr` (`docs/integrations/joinr-crosscuts-intake.md`). Change it only in both at once, with a version bump here, and with Todd's OK. Approved by Todd 2026-10-11 (Crosscuts `docs/plans/m6-plan.md` §10).

**Version 2 (M11, plan approved by Todd 2026-10-13)** adds one optional item field, `drawers` (the won quote's drawer lines). The wire `contract` number stays **1**: the field is optional, an older Crosscuts ignores it, and a Joinr that doesn't send it is read as "no drawer data". The version 2 text was written in the Crosscuts repo first; the copy in `tenon-quotr` follows in task J2 (Crosscuts `docs/plans/m11-contracts.md` §13), which needs Todd's go.

**M13 note (Crosscuts copy only, 2026-10-16):** this copy gains one explanatory line about `estimatedHours` (under "What Crosscuts does with an item"). It changes nothing on the wire, so there is no version bump. The `tenon-quotr` copy follows only with Todd's OK for a Joinr change (Crosscuts CLAUDE.md rule 12). Until then the copies differ by that line, and also by M11's version 2 (`drawers`), which the `tenon-quotr` copy gets with task J2; don't "fix" either difference by editing `tenon-quotr`.

**Version 3 (task J3, Todd's two yeses 2026-10-17)** adds a second, separate endpoint: the **open-quotes list** (`GET {base}/api/integrations/crosscuts/open-quotes`), the current state of every quote that is sent or won, so Crosscuts can list sent quotes beside won ones in its pipeline's Quoted column. It is the section "Open-quotes list (version 3)" below. **Nothing above that section changes**: the won-quotes endpoint, its items and its wire `contract` number (**1**) are as in versions 1 and 2, and an older Crosscuts that never calls the new endpoint works as before. The new endpoint's own wire `contract` number is **3**. Version 3 was written in `tenon-quotr` first, from the Crosscuts copy of version 2, so the two copies will be identical once the Crosscuts copy is updated to version 3: this text already carries the M13 `estimatedHours` line and the version 2 `drawers` text. Joinr does not yet send `drawers` (task J2 is not built); by version 2's own rule that reads as "not reported".

**Version 4 (task J4, Todd's two yeses 2026-10-18)** adds one optional won-quotes item field, `quote`: the **whole quote** — every room, every priced line of every section, the additional items, the labour, the options and the totals, money figures included (Todd, 2026-10-18: "Send all materials and labour, preferably everything, from Joinr's quote; we can work with it (or disregard it) in Crosscuts"; he chose to include rates, costs, markups, the tier and the margin, and Crosscuts shows them only to its job-value holders). It is the section "The quote object (version 4)" below, with one paging note under "Response". **Every other field and rule is unchanged**, the won-quotes wire `contract` number stays **1** (the field is optional, as version 2's `drawers` was: an older Crosscuts ignores it, and a Joinr that does not send it is read as "not reported"), and the open-quotes list (version 3) is untouched. Version 4 was written in `tenon-quotr` first, from version 3; the two copies are identical once the Crosscuts copy is updated to it.

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
- **(Version 4.)** A page can carry **fewer than `limit` items with `more: true`**: since each item carries its whole quote, Joinr ends a page before the item that would take the page past about 1 MB of item JSON (always carrying at least one item), so a response stays well under Crosscuts' 2 MB cap. And an item that would weigh over about 1.5 MB with its quote (a quote with enormous notes or options) is sent with `quote: null` and every other field as usual, so no page can pass 2 MB. The `cursor` is then the last carried item's (an event id, or a backfill cursor naming that quote) and the next call starts with the item left off. Call again with `after = cursor` straight away, as for any `more: true`.

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
| `quote` | object \| `null` \| absent (version 4, optional) | the whole quote, priced as Joinr's quote page prices it; see "The quote object (version 4)". Absent means "not reported" (an older Joinr); `null` means Joinr can't price the quote at all, or the quote is too large to send (over about 1.5 MB) |

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

**Hours (M13, Crosscuts copy only):** Joinr's `estimatedHours.factory` and `estimatedHours.site` are **half the hours typed on the quote** (Joinr's engine halves them for its overhead sum), so Crosscuts doubles them back for the quoted factory and install hours on a job's bonus; `office` and `travel` aren't used.

**Drawers (version 2).** Crosscuts maps each `drawers` name to a drawer brand, height and length through a list its Ordering team keeps, and fills in a drawer grid on the job when the record is accepted or linked. It never changes a grid by itself afterwards: the job page says "Changed in Joinr" and offers a refill.
- **Absent or `null`** is "not reported". An older Joinr gets no grid, and a job accepted before this field existed has none.
- **Changed detection:** `drawers` counts as a change only when both the stored and the new item have an array and the two differ. The first item to report `drawers` where the stored one had none is stored, but not flagged "Changed in Joinr", so the first sync after Joinr starts sending the field doesn't mark every accepted record changed.

## The quote object (version 4)

Each won-quotes item may carry `quote`: the whole quote as Joinr prices it, so Crosscuts can work from every material, every hour of labour and every figure Joinr has (or disregard them). It includes **money figures** (rates, costs, markups, the tier, the cost of goods and the margin): Todd chose to send them (2026-10-18), and Crosscuts shows them only to its job-value holders.

- **Optional.** Absent: "not reported" (a Joinr before version 4). `null`: Joinr can't price the quote at all (no rate card, or its engine fails on the quote), and then `valueIncGstCents` is null too; **or** the quote is too large to send — an item that would be over about 1.5 MB with it (see "Response") — and then every other field, `valueIncGstCents` included, is as usual. A quote Joinr prices to a figure that isn't a finite number (see "Money") gets an object whose affected figures are `null`, as its `valueIncGstCents` is. Otherwise an object, every field below always present (board-line and travel-line extras only on those lines).
- **On every item event** (`won`, `unwon`, `changed`, `deleted`): the quote as it is now. A re-save of a won quote is a `changed` item (above), and it carries the new figures.
- **As priced when the item is read, not a change signal.** `quote` is priced when Joinr builds the item. Some of its inputs change with no `changed` item: GST registration and rate (always today's), and for a quote with no frozen rate card the organisation's current card (rates, tiers, overheads, section titles). So the same quote can come back with different figures on a later item or a backfill. **Don't compare `quote` objects to detect edits in Joinr**; the item events are the edit signal.
- **How it is priced.** On Joinr's server, with Joinr's pricing engine and the same card Joinr's quote page, quote list and customer document use: the quote's **frozen rate card** when it has one (Joinr freezes a quote's rates when it is first saved, and they stay frozen until someone re-prices it in Joinr), else the organisation's current card; GST registration and rate are always today's (Joinr's rule for every quote). Never the current card for a frozen quote, so the figures are the quote document's.
- **Money is integer cents**, ex GST unless the name says `IncGst`. Each figure is rounded to the cent on its own (half up, as `valueIncGstCents`), so a sum of rounded parts can differ from the rounded total by a cent or two: **the totals are Joinr's, never re-add the parts**. A figure Joinr can't compute as a finite number is `null` (for example, a CNC profile with zero sheets per cutter makes every board line on it, and every total over them, infinite).
- **Quantities**, **hours**, **multipliers** and **fractions** follow the same rule: a plain number, `null` when it is not a finite number. **Quantities** are as typed, not rounded. **Multipliers** (`materialMarkup`, `markup`, `markupFactor`) are plain numbers: 1.3 = +30%, 1 = at cost. **Fractions** (`adjust`, `globalMarkup`, `gst.rate`, `cogsRatio`) are plain numbers: 0.05 = 5%.
- **Size.** Measured on Joinr's dev database (2026-10-18) with 101 won quotes copied from its demo organisation: an item with its quote is about 5 kB (4.6 to 14 kB), and a page of 100 items about 0.6 MB, served in under a second. The page limit under "Response" (about 1 MB of items) keeps every response well under Crosscuts' 2 MB cap.
- **Text** is as stored in Joinr (catalogue item names, section titles, room names, labels). An additional item's `description`, the `notes`, `tier.requested` and an option's `id` are trimmed, blank → `null`; any other `string | null` text is `null` only when Joinr has none.

### Top level

| Field | Type | Meaning |
|---|---|---|
| `pricedAt` | `"snapshot"` \| `"live"` | priced at the quote's frozen rate card, or at the organisation's current card |
| `gst.registered` | boolean | whether the business charges GST (today's setting) |
| `gst.rate` | number \| null | the GST rate applied: 0.1, or 0 when not registered |
| `tier.requested` | string \| null | the client tier code stored on the quote |
| `tier.code`, `tier.label` | string \| null | the tier the quote is priced at |
| `tier.materialMarkup` | number \| null | that tier's material markup multiplier (1 when the card has no tiers) |
| `tier.fallback` | boolean | true when the quote's tier is no longer on the card, so Joinr prices at the card's first tier (Joinr also warns, see `warnings`) |
| `globalMarkup` | number \| null | the quote's Global markup, a fraction (−0.15 to 0.15) |
| `kmFromFactory` | number \| null | the quote's distance from the factory, km |
| `cogsFactors.labour`, `cogsFactors.materials` | number \| null | the card's cost-of-goods factors (labour and materials multipliers) |
| `overheadRatePerHourCents` | integer \| null | the overhead recovered per hour of labour and travel |
| `notes` | string \| null | the quote's notes |
| `rooms` | room[] | in the quote's order |
| `labour` | object | see "Labour" |
| `options` | option[] | the quote's options, priced beside the total, never in it |
| `totals` | object | see "Totals" |
| `warnings` | `{severity: "red" \| "amber", message, roomName}`[] | the warnings Joinr shows on the quote (tier no longer exists, room profit too low, materials too high a share), worded as Joinr words them |

### Room

| Field | Type | Meaning |
|---|---|---|
| `id` | string \| null | Joinr's room id (options name their room by it) |
| `name` | string \| null | the room's name |
| `adjust` | number \| null | the room's Adjust, a fraction (0.05 = +5%) |
| `spec.doorsPanels`, `spec.benchtop`, `spec.jobType` | string | the room's three spec values as typed (`""` when blank); the same values as `raw` |
| `lines` | line[] | every priced catalogue line, in the card's section order and, within a section, the card's item order |
| `customItems` | custom item[] | the room's additional items, in order |
| `sections` | `{id, title, totalCents}`[] | each section that has a line, with Joinr's section total (the figure at the head of the section on the quote page) |
| `hours` | `{office, factory, site, travel}`, each number \| null | the room's hours, Joinr's engine figures (see "Labour") |
| `totals` | object | see below |

Room `totals` (the room's footer on Joinr's quote page):

| Field | Meaning |
|---|---|
| `labourOfficeCents`, `labourWorkshopCents` | office and workshop labour at cost (the footer's "Labour" is their sum) |
| `materialsCents` | materials and hardware at cost, the additional items included ("Materials") |
| `customItemsCents` | the additional items' part of that, at cost |
| `travelCents` | travel at cost |
| `overheadRecoveryCents` | overhead recovered on the room's hours |
| `overheadsCents` | overhead recovery plus travel ("Overheads") |
| `markupFactor` | the tier's material markup multiplier (a number, or null) |
| `markupCents` | the material markup ("Markup"); an additional item with its own markup is priced at its own, not the tier's |
| `subtotalCents` | labour + materials + markup + overheads: what the adjust applies to |
| `adjustCents` | the room's Adjust and the quote's Global markup together ("Adjust + markup") |
| `roomAdjustCents` | the room's own Adjust alone |
| `exGstCents`, `gstCents`, `incGstCents` | the room's price ex GST ("Ex GST"), its GST, and inc GST (the room's total) |
| `costOfGoodsCents`, `cogsRatio` | the room's cost of goods and its share of `incGstCents` ("COGS"); see "Totals" for how Joinr counts cost of goods |
| `marginCents` | `incGstCents` − `costOfGoodsCents` (the footer's "profit"; GST is not taken out) |
| `cogsWarning` | Joinr's "Room profit too low" flag |

### Line

One line per catalogue item per section per room, **as Joinr's engine prices it**: when a room holds the same item on more than one row of a section (two Whiteboard rows of 2 and 4 sheets), the line is their sum (6), because that is the quantity Joinr prices. Items with no quantity are not lines, and nor is a quantity left under an item the card no longer has (Joinr prices it at nothing and doesn't show it).

| Field | Type | Meaning |
|---|---|---|
| `section` | string | the catalogue section's id (`officeLabour`, `boardEdge`, `benchtops`, `drawers`, `innerDrawers`, `handles`, `hardware`, `roomExtras`, `factoryLabour`, `siteLabour`, `travel` on Joinr's standard card; an organisation can have others) |
| `sectionTitle` | string \| null | the section's title as the card names it (`"Board & Edge"`) |
| `kind` | string \| null | how the section prices: `board` (per sheet: board + edging + CNC), `travel` (per trip: km × rate per km), `labour` or `simple` (the item's rate) |
| `costBucket` | string \| null | `labourOffice`, `labourWorkshop`, `materials` or `overheads`: where the line's cost goes in the room totals |
| `hoursBucket` | string \| null | `office`, `factory`, `site` or `travel` for labour and travel lines, else null |
| `unit` | string \| null | the section's unit as the card names it (`sheets`, `hrs`, `m`, `ea`, `trips`) |
| `name` | string | the catalogue item's name |
| `qty` | number \| null | the quantity (hours, sheets, metres, each or trips) |
| `unitRateCents` | integer \| null | the rate per unit, ex GST, at cost (the quote page's rate column) |
| `lineTotalCents` | integer \| null | `qty` × the unit rate, ex GST, at cost (the line total column): before the room's markup, overheads, adjust and GST |
| `boardCostCents`, `edgingCents`, `cncCents` | integer \| null | **board lines only**: the unit rate's three parts — the sheet, edging (the card's cost per 100 m ÷ 4), and CNC cutting per sheet |
| `perKmCents` | integer \| null | **travel lines only**: the rate per km (the unit rate is `kmFromFactory` × this) |

### Custom item (Joinr's "additional items")

| Field | Type | Meaning |
|---|---|---|
| `description` | string \| null | as typed |
| `qty` | number \| null | |
| `unitPriceCents` | integer \| null | the price per unit, ex GST, at cost; may be negative (a credit) |
| `lineTotalCents` | integer \| null | `qty` × price, at cost (the line's figure on the quote page) |
| `markup` | number \| null | the material markup multiplier this line is priced at: its own when it has one, else the tier's |
| `markupFromTier` | boolean | true when `markup` is the tier's |
| `lineTotalWithMarkupCents` | integer \| null | `lineTotalCents` × `markup` (Joinr's "after markup" figure for the line) |

### Labour

`labour.office`, `labour.factory`, `labour.site` and `labour.travel`, each `{typed, hours, costCents}` (`typed` and `hours` a number or null), plus `labour.overheadRecoveryCents` (the quote's overhead recovery, all rooms):

| Field | Meaning |
|---|---|
| `typed` | what was entered on the quote, summed over every room: **hours** for office, factory and site; **trips** for travel |
| `hours` | Joinr's engine hours, **the same numbers as the item's `estimatedHours`** |
| `costCents` | the cost of the lines in that hours bucket, at cost (their unit rates × quantities; a labour line's unit rate is its hourly rate) |

How `hours` follows from `typed` — the precise statement behind the M13 note (under "What Crosscuts does with an item"):

- **office:** `hours` = `typed`.
- **factory** and **site:** `hours` = `typed` ÷ 2. Joinr's engine halves them because it recovers overhead on factory and site hours at half rate; so `typed` is the hours on the quote, and `estimatedHours.factory` × 2 = `labour.factory.typed`.
- **travel:** `typed` is trips; `hours` = trips × `kmFromFactory` ÷ 60 × 2 (a return trip at 60 km/h).

A kind has no single hourly rate in Joinr: each labour line carries its own (`unitRateCents`).

### Option

| Field | Type | Meaning |
|---|---|---|
| `id` | string \| null | Joinr's option id |
| `roomId`, `roomName` | string \| null | the room it belongs to; null for the whole job |
| `label` | string | as typed |
| `kind` | `"doorsPanels"` \| `"benchtop"` \| `"other"` | |
| `priceIncGstCents` | integer \| null | the option's price inc GST, as stored on the quote |
| `priceExGstCents` | integer \| null | ex GST, as Joinr's customer document prints it (inc GST ÷ (1 + `gst.rate`)) |
| `computed` | boolean | Joinr worked the price out from an item swap when the option was made |

### Totals

| Field | Meaning, and the figure it is on Joinr's quote page |
|---|---|
| `incGstCents` | **the customer total: equal to the item's `valueIncGstCents`**; the quote's "Total" and the customer document's total |
| `exGstCents`, `gstCents` | the document's subtotal ex GST and its GST (the "GST included" note) |
| `labourOfficeCents`, `labourWorkshopCents`, `materialsCents`, `markupCents`, `overheadsCents`, `adjustCents` | the rooms' figures of those names, summed: the price's pricing parts (together `exGstCents`, give or take rounding) |
| `costOfGoodsCents` | the quote's cost of goods: (office + workshop labour) × `cogsFactors.labour` + materials × `cogsFactors.materials` + overheads, summed over the rooms |
| `cogsRatio`, `cogsWarning` | `costOfGoodsCents` ÷ `incGstCents` (0 for an empty quote): the "COGS" percentage beside the quote's Total, and whether Joinr shows it red (over the card's threshold) |
| `marginCents` | `incGstCents` − `costOfGoodsCents`: the job summary's "Markup/Profit" (GST is not taken out) |
| `costs.officeCents`, `costs.labourCents`, `costs.materialsCents`, `costs.overheadsCents` | the job summary's "Where the price goes" in cost terms (labour and materials with the cost-of-goods factors applied) |
| `costs.labourFactoryCents`, `costs.labourSiteCents` | the job summary's "Labour split": factory and site labour in cost terms |

## Open-quotes list (version 3)

The current state of every **open** quote of the key's organisation, in one read: status `sent` (out with the client) or `won`. Crosscuts lists these in its pipeline's Quoted column. Read-only, like the won-quotes endpoint, and separate from it: it has no cursor, no events and no backfill, and Crosscuts' won-quotes intake is unchanged by it.

### Request

```
GET {base}/api/integrations/crosscuts/open-quotes
Authorization: Bearer {org API key}
Accept: application/json
```

- `{base}` is `https://app.joinr.com.au` in production.
- **Authentication:** the same org API key as the won-quotes endpoint (one key reads both). The key alone identifies the org; the request never names one. A revoked or unknown key → 401. Behind the endpoint, Joinr's database also demands Joinr's own server-side secret before it reads anything, exactly as for won quotes; Crosscuts never holds or sends that secret.
- **No query parameters.** Any parameter at all (for example `?status=sent` or `?limit=10`) is refused with 400, so a filter Crosscuts thinks it asked for is never silently ignored.
- **Rate limit:** up to 12 requests per minute per key, counted separately from the won-quotes endpoint's 60; beyond that 429 with `Retry-After`. Crosscuts is expected to read the list once per poll (every five minutes).

### Which quotes are listed

- Status `sent` or `won`, not soft-deleted, **not archived**. Drafts, ready, lost, deleted, archived and superseded quotes are never listed.
- **One line per job** (`rootQuoteId`), chosen in this order among the job's quotes that are not deleted and not archived:
  1. its **active** sent or won quote. When a won quote has an active revision beside it (a variation on a won job), the **won** quote is the line;
  2. otherwise its **newest sent quote that has been set aside** (standing `alternative`, newest by when it was created). This is the **revision rule** (Todd, 2026-10-17: keep showing the last sent revision while revising): revising a sent quote in Joinr sets the sent one aside and makes a new draft revision, and the job keeps showing the sent revision until the new one is sent; then the line moves to the new revision (its own `quoteId`, `quoteNumber`, value and `url`). A job whose quotes have all been set aside also shows its newest sent one, since "set aside" in Joinr means still on the table;
  3. otherwise no line. A **superseded** quote (one the client chose against, because another quote of the job was won) is never a line.
- **Archived quotes are excluded** (Todd, 2026-10-17). Joinr archives one quote at a time; an archived quote is left out before the one-line-per-job choice, as Joinr's own quote list leaves it out. So a job whose open quote is archived has no line, and a won quote that is archived beside an active sent revision that is not gives the job that sent revision's line. Unarchiving a quote in Joinr brings it back on the next read.
- **Newest first** by `updatedAt`, **at most 200 lines**. `truncated: true` means there were more and the least recently changed ones were left off. 200 is well over a year of one workshop's sent and won jobs (Joinr held 119 quotes in all on 2026-09-20); what would drop off first is old won jobs, which Crosscuts' won-quotes intake already holds. (Measured on Joinr's dev database: 500 lines took about 2 s, too close to the database's 3 s limit for this caller; 200 take about 0.8 s.)
- **The same job can change line.** Between two reads a job's line can move to another revision (a new revision sent, the revision rule above) and its `status` can change from `won` to `sent` without the job being un-won in the won-quotes feed: for example a won quote that is **archived** beside a live active sent revision lists that **sent** revision. Crosscuts should key on `rootQuoteId`, take `quoteId`, `status` and the other fields from the latest read, and not treat a `won` → `sent` change here as an un-win (the won-quotes feed is the record of wins).
- The list is a snapshot: a quote that stops being open (lost, deleted, archived, superseded, back to draft) simply isn't in the next answer. Match lines to Crosscuts' own records by `rootQuoteId`.

### Response

```json
{
  "contract": 3,
  "generatedAt": "2026-10-17T01:00:00.000Z",
  "truncated": false,
  "quotes": [ { ...line... } ]
}
```

- `generatedAt` is when Joinr's database took the snapshot, ISO UTC.
- An organisation with no open quotes gets `"quotes": []`.

### Line

Exactly these twelve fields, and nothing else (no phone, email, reference, rooms, spec, notes or price breakdown):

| Field | Type | Meaning |
|---|---|---|
| `quoteId` | uuid | this revision's id |
| `rootQuoteId` | uuid | the id shared by all revisions of the quote (the job; the same key as the won-quotes items) |
| `quoteNumber` | string \| null | as typed in Joinr; blank → null |
| `status` | `"sent"` \| `"won"` | the quote's status now |
| `clientName` | string | `""` when there is none |
| `siteAddress` | string \| null | Joinr's job name (the job address); blank, "New quote" or "Untitled quote" → null |
| `label` | string \| null | the quote's label, trimmed; blank → null |
| `valueIncGstCents` | integer \| null | the job total including GST, options excluded, priced on Joinr's server with its engine, rounded to the cent (the same figure as a won-quotes item for the same quote); null if it can't be priced |
| `sentAt` | ISO UTC \| null | when it was last marked sent; null when Joinr has no record of that (for example a quote imported as sent) |
| `wonAt` | ISO UTC \| null | when it was last marked won, for a quote that is `won` now; always null for a `sent` quote |
| `updatedAt` | ISO UTC | when the quote last changed in Joinr |
| `url` | string | `{base}/org/{orgId}/quotes/{quoteId}` (members-only link), built as the won-quotes items' `url` is |

Example line:

```json
{
  "quoteId": "4f0c…",
  "rootQuoteId": "4f0c…",
  "quoteNumber": "JRQ23110",
  "status": "sent",
  "clientName": "Jane Citizen",
  "siteAddress": "12 Harbour St, Balmain",
  "label": null,
  "valueIncGstCents": 1843500,
  "sentAt": "2026-10-15T23:12:04.000Z",
  "wonAt": null,
  "updatedAt": "2026-10-15T23:12:04.000Z",
  "url": "https://app.joinr.com.au/org/…/quotes/4f0c…"
}
```

### Errors

- `401 {"error":"unauthorised"}`: missing, malformed, unknown or revoked key (checked before the query, so a caller without a live key learns nothing about parameters).
- `400 {"error":"open-quotes takes no query parameters"}`: any query parameter.
- `429 {"error":"rate_limited"}` with `Retry-After` seconds.
- `503 {"error":"unavailable"}` or another `5xx`: Joinr isn't configured or its database is unavailable. The body never says why. Crosscuts retries on its next run.
- `405` for any method but `GET` (and `HEAD`, `OPTIONS`).

### Revoking

The key is the one created on Joinr's Settings › Integrations tab. Revoking it there stops both endpoints on the next request.

## Version history

- **Version 1 (2026-10-11):** the first contract.
- **Version 2 (2026-10-14):** the optional `drawers` field. The wire `contract` stays 1.
- **Version 3 (2026-10-17):** the open-quotes list, `GET /api/integrations/crosscuts/open-quotes` (wire `contract` 3), for sent and won quotes that are not archived, one line per job with the revision rule, at most 200 lines. The won-quotes endpoint and its items are unchanged (wire `contract` still 1). The two copies of this document are identical once the Crosscuts copy is updated to this version.
- **Version 4 (2026-10-18):** the optional won-quotes item field `quote` (the whole quote: rooms, every priced line, additional items, labour, options and totals, money figures included, priced as Joinr's quote page prices it), and a page that may end early (`more: true`) to stay under about 1 MB of items, an item over about 1.5 MB going with `quote: null`, so no page passes 2 MB. `quote` is as priced when the item is read, not an edit signal. The wire `contract` stays 1; the open-quotes list is unchanged. The two copies of this document are identical once the Crosscuts copy is updated to this version.
