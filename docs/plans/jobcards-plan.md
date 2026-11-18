# Job cards and supplier orders (0.2.22)

Asked for and approved by Todd on 2026-11-18. The mockups are `docs/plans/mockups/jobcards-A-orders.html`, `jobcards-B-new.html` and `jobcards-C-supplier.html`. Todd approved them and added a print list. This file is binding for the build. Where it is silent, follow the mockups, then the existing order-line rules in `docs/plans/m10-contracts.md` and `docs/plans/m9-contracts.md`.

## What it is

On Ordering > Orders, Ordering keeps a **job card** for each job: the hardware to order for that job (supplier, hardware name, quantity). When an order is placed with a supplier, a **supplier order** screen lists every item still to order from that supplier across all job cards. The items in this order are ticked and marked ordered in one go, and each comes off its job card as Ordered with that date. A card can be opened from the page at any time, and shows each item's ordered, expected and received dates.

## Todd's decisions (binding)

1. **A job card is the job's existing order lines** (`orders` table), not a separate list. The same items show on the job's Orders & materials tab. Lines gain a **quantity**. Deliveries, the progress invoice (`markMaterialsOrdered` when the last line is ordered), hand-offs (`onAllOrdered`), alerts and audit keep working through the existing paths.
2. **The supplier order screen ticks items off.** Pick the supplier, see every `to_order` line for that supplier across all jobs, grouped by job, all ticked by default. Untick any not in this order, set the order date (default today, Sydney), and optionally an expected date and a supplier reference. Then press **Mark N ordered**. Each ticked line becomes `ordered` with that date (and the expected date if given), exactly as a single Mark ordered does today. Each line is ordered in full; there are no part quantities.
3. **Supplier: type-ahead, new names allowed.** Suggest names already used on order lines and the Supplier accounts names (`suppliers` table). A new name is accepted, and because it is then on an order line it is suggested next time.
4. **Cards per job on the Orders page.** The page opens on a **Job cards** tab with one card per job: job number, name, client, counts of to order / ordered / received, and its suppliers. Click a card to open it below. The open card shows each line with supplier, hardware, qty, status, ordered, expected and received dates, notes, and an Edit button. Today's line-by-line list moves unchanged to an **All order lines** tab.
5. **Print list (Todd's addition, 2026-11-18).**
   - The supplier order screen has a **Print list** button. It prints the ticked items for the chosen supplier, grouped by job: job number and name, hardware, qty, plus the order date and supplier ref if typed. The sheet is A4, black on white, with the small letterhead like the other print pages. Printing does not mark anything ordered.
   - The open job card has **Print card**: that job's lines with supplier, hardware, qty, status and dates, on the same kind of sheet.

## Lead's defaults (shown in the mockups; Todd approved them with the mockups)

- **Who:** adding items and editing lines needs `orders.edit`. The supplier order's Mark ordered needs `orders.mark_ordered`. Seeing cards and printing needs `orders.view`. No new key.
- **Quantity:** a positive number, whole or decimal (e.g. 2.4 for metres), up to 2 decimals, max 99999. Old lines have none and show blank. Quantity is required when adding through the job card; it stays optional on the job page's existing add form and in the edit dialog. It shows on the job page's order lines, the All order lines tab, Deliveries and the edit dialog.
- **Hardware name** is the line's existing `description` (required when adding from a card).
- **Supplier ref** (optional) is added to each ticked line's notes as `Ref: <text>` (appended on a new line if notes already exist; capped by the existing notes limit).
- **Which cards show:** a job shows when it has at least one line that is not received or cancelled. "Show finished cards" adds jobs whose lines are all received (cancelled lines are ignored; a job with only cancelled lines never shows). Find a job filters by job number, name or client. The Supplier filter shows jobs with a non-cancelled line from that supplier. Archived jobs show only with Show finished ticked.
- **New job card:** a type-ahead job picker (`/api/job-records?q=`, as the Benchtops page's New benchtop plan does in `public/benchtopplans.js`). A job that already has lines shows "Has a card", and picking it adds to that card. Archived jobs are not offered for new items. Then an Add items dialog with rows of supplier, hardware and qty, where a fresh row appears as the last is filled. **Add N items** creates all lines in one transaction and then opens that card.
- **Supplier order list:** the supplier select lists suppliers that have `to_order` lines, with counts, e.g. "Blum Hardware (6 to order)". Supplier names match case-insensitively and trimmed. Lines group by job, oldest added first. After Mark ordered, show what was done ("5 items marked ordered for 3 jobs") and return to the job cards. Undo stays per line, as today.
- **Mark ordered in bulk** runs as **one transaction** for all ticked lines. It reuses `updateLine`'s mark-ordered path, or a shared helper, so every rule, audit row, `markMaterialsOrdered` and `onAllOrdered` call happens per line and job exactly as for a single Mark ordered. It refuses (409, nothing changed) if any ticked line is no longer `to_order` (someone else ordered or cancelled it), with a clear sentence, and the screen reloads.

## Data and API

- **Migration `063_order_quantity.sql`** (additive): `ALTER TABLE orders ADD COLUMN quantity REAL;` (NULL for existing lines). Nothing else.
- `lib/orders.js`: `present()` adds `quantity`; `createLine` and `updateLine` accept `quantity` (null clears it, with validation). Add `createLines(db, jobId, lines[], req)` (all or nothing, 1 to 50 lines) and `markOrderedMany(db, orderIds[], {orderedDate, expectedDate, supplierRef}, req)` (1 to 200 ids). Every who-may-do-what rule stays in `lib/orders.js`.
- Routes through `defineRoutes` with access values. Suggested routes (the build may refine them, keeping the access values):
  - `POST /api/job-records/:id/orders/batch` (`orders.edit`)
  - `POST /api/orders/mark-ordered` (`orders.mark_ordered`)
  - `GET /api/orders/suppliers` extended to include Supplier accounts names (`orders.view`)
  - job cards, either computed on the page from `GET /api/orders?status=all` or from a new `GET /api/orders/cards` (`orders.view`); pick one and keep it efficient
- Every write gets an audit row, as the existing order writes do.

## Pages

- `public/orders.html`, `orders.css`, `orders.js`: tabs, the cards grid, the open card, New job card, and the supplier order view. These may be split into new files (e.g. `jobcards.js`, `supplierorder.js`) where cleaner.
- `public/orderui.js` (the shared edit dialog) gains Quantity. The job page's Orders section and Deliveries show qty.
- Print: a new print page (e.g. `orderprint.html/.css/.js`, built like `stoneprint.*` or `benchtopprint.*`) with two modes, supplier list and job card. A4, black on white, letterhead, Page X of Y if it runs long.
- House style (CLAUDE.md "Look and feel"): `node ci/style-check.js` must pass. No icons; the dialog's remove-row control is a text "×" in the destructive colour, as in the mockup. CSS classes get a page prefix that doesn't collide.
- Phone width: cards stack, the tables turn into cards as on other Ordering pages, and there is no sideways scroll at 375 px.

## Not touched

The board files (CLAUDE.md non-negotiable 7), `public/shared.js`, migrations 001 to 062, the stock order, drawer order and paint order pages, and Joinr (tenon-quotr).

## Tests and docs

- New smoke `ci/smoke-jobcards.sh`, wired into `ci/smoke.sh` the way the other suites are, with made-up names. It covers:
  - batch add: validation, all or nothing, access
  - quantity on create and edit, and clearing it
  - supplier suggestions including Supplier accounts names
  - mark ordered in bulk: dates, ref in notes, audit, access, the 409 when a line is no longer to_order with nothing changed, and the progress invoice firing when the last line of a job is ordered
  - cards' counts if there is an endpoint
  - the print page loading
- Update existing smokes that check the `orders` row shape.
- Docs: a new how-to `docs/how-to-job-cards.md`; mention it in `docs/how-to-receive-deliveries.md` if relevant; a STATUS "Start here" entry.
- Version **0.2.22**, bumped once (`crosscuts/app/package.json` and both versions in `crosscuts/app/package-lock.json`). Next migration after this: 064.
