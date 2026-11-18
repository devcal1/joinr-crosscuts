# Supplier orders kept as purchase orders with a frozen PDF (0.2.23)

Asked for and approved by Todd on 2026-11-18. The mockups are `docs/plans/mockups/po-A-orders.html` (the Supplier orders tab, the saved message, the open order, and the PO link on job cards) and `po-B-pdf.html` (the PDF). This file is binding for the build. It builds on 0.2.22's job cards and supplier orders (`docs/plans/jobcards-plan.md`, `lib/orders.js` `markOrderedMany`, `public/supplierorder.js`, `public/jobcards.js`, `public/orderprint.*`).

## Todd's decisions (binding)

1. **Saved order + frozen PDF.** When Mark ordered is pressed on a supplier order, Crosscuts records the order: supplier, order date, expected date, supplier ref, who placed it, and the exact items and quantities with each item's job. It also keeps a PDF of it as it was at that moment. Later changes to the items never alter the saved order's snapshot or its PDF. The PDF can be viewed, printed or downloaded at any time, and printing gives only the items in that order.
2. **PO numbers.** Each saved order gets the next number: PO-0001, PO-0002 and so on, never reused. The number is on the PDF and the orders list. It is also added to each item's notes alongside the supplier ref, e.g. `PO-0007` or `PO-0007 · Ref: BH-55120`. This replaces 0.2.22's `Ref: x` line for supplier orders.
3. **Where orders are found.**
   - A **Supplier orders** tab on Ordering > Orders, between Job cards and All order lines. It lists every saved order, newest first: PO number, supplier, order date, expected date, supplier ref, item count, job numbers and who placed it. It has a Find box (PO number, supplier ref, job number or name) and a Supplier filter.
   - Opening an order shows its items grouped by job, with each item's current state (Ordered, Received with date, or "Undone since" with date and who if the line is now back to To order or cancelled). It has **View PDF**, **Print** and **Download PDF** buttons.
   - Each ordered item on a job card shows its PO number as a link that opens that order.

## Lead's defaults (shown in the mockups; approved with them)

- **After Mark ordered:** the supplier order view returns to the Orders page with a message: "PO-0007 saved. 5 items marked ordered for 3 jobs from Blum Hardware", with View PDF and Download PDF buttons.
- **Who:**
  - Viewing, printing and downloading saved orders needs `orders.view`.
  - Creating one happens only through the supplier order's Mark ordered (`orders.mark_ordered`, plus the existing `orders.edit` rule for the expected date and notes).
  - No new key. No delete or edit of a saved order.
- **What is frozen:** a `snapshot_json` written in the **same transaction** as the mark-ordered. It holds the PO number, supplier, dates, ref, the orderer's display name, the business details at that moment (trading name, address, phone, email, ABN from `lib/settings.js` business.*), and the items (order line id, job id, job number, job name, hardware/description, qty) in the screen's order. The PDF is rendered **from the snapshot only**, so it is the same whenever it is made.
- **The PDF file:**
  - It is made with the existing headless Chromium method in `lib/invoicepdf.js` (loopback-only, one-time token, no session). Reuse or generalise that code rather than copying the security logic. Keep its review notes true and extend its comment.
  - Render after the transaction commits.
  - Store the file on disk under the uploads data dir, in a folder **the NAS backup copies**. Check `lib/backup/copy.js` and `constants.js`, which copy `uploads/files`: use e.g. `uploads/files/purchase-orders/PO-0007.pdf`, or whatever that check shows is covered. Record its path and made-at time on the order.
  - If rendering fails, the order and its snapshot are still saved. The PDF is made on the first View or Download (from the same snapshot), and the message says the PDF will be made when opened. `PDF_FAKE=1` must work for smoke tests, as for invoices.
  - Once made, the file is never re-rendered.
- **The PDF layout (po-B):**
  - A4, black on white.
  - Company name and details at the top left. "PURCHASE ORDER" and the PO number at the top right.
  - Then supplier, order date, supplier reference, expected date, ordered by, and **Deliver to** (the business address; there is no separate workshop address setting).
  - Then the items grouped by job (job number · name), each with item and qty, an item count, the line "Please quote PO-0007 and the job number on the delivery docket.", and a footer with "Page X of Y".
  - Build it as a print page mode (e.g. `orderprint.html?po=N`, or its own `po.html`) that renders from the snapshot. That one layout serves the screen Print button and the PDF.
- **Items marked ordered one at a time** (not through a supplier order) and anything ordered before this change have no PO. The job card shows no link for them.
- A line can belong to more than one saved order over time: ordered on PO-0005, undone, then ordered again on PO-0009. Keep the history. The job card links to the order matching the line's current ordered state, the latest one containing it.
- **Download filename:** `PO-0007 Blum Hardware.pdf` (made filename-safe).

## Data and API

- **Migration `064_purchase_orders.sql`** (additive, new tables only):
  - `supplier_orders`: id, `po_seq` INTEGER UNIQUE NOT NULL, supplier, ordered_date, expected_date, supplier_ref, created_by, created_at, snapshot_json, pdf_path, pdf_made_at.
  - `supplier_order_lines`: supplier_order_id, order_id, sort, with a PRIMARY KEY on both ids and an index on order_id.
  - PO number = 'PO-' plus po_seq padded to 4 digits; after 9999 it is just longer. Allocate po_seq as MAX+1 inside the transaction.
- `lib/orders.js` (or a new `lib/purchaseorders.js` that orders.js calls): `markOrderedMany` creates the saved order and its lines and the snapshot in its existing transaction, and returns the order's id and number. All who-may-do-what rules stay in lib.
- Routes through `defineRoutes` with access values:
  - `GET /api/supplier-orders` (list, `orders.view`)
  - `GET /api/supplier-orders/:id` (detail with items' current state, `orders.view`)
  - `GET /api/supplier-orders/:id/pdf` (`orders.view`; serves the stored file, making it from the snapshot if missing; `?download=1` sets `Content-Disposition: attachment` with the filename above)
  - `GET /api/orders` and the job card data gain each line's current PO (`poId`, `poNumber`) where there is one.
- Audit: one `supplier_order.create` row with the PO number and line count, alongside the existing per-line rows.

## Pages

- `public/orders.html`/`orders.js`: the new tab, plus `public/supplierorders.js`/`.css` (or similar).
- `public/supplierorder.js`: the saved message with View/Download PDF.
- `public/jobcards.js`: the PO link column.
- The PO print page mode.
- House style (`node ci/style-check.js` must pass), no icons, a page-prefixed CSS class, and no sideways page scroll at 375 px.

## Not touched

Board files (CLAUDE.md non-negotiable 7), `public/shared.js`, migrations 001 to 063, invoices' behaviour (only shared PDF plumbing may be generalised; the invoice PDF must still work, and its smokes must pass), and Joinr.

## Tests and docs

- New smoke `ci/smoke-purchase-orders.sh`, wired into `ci/smoke.sh`, with made-up names and `PDF_FAKE=1`. It covers:
  - a supplier order creating PO-0001 then PO-0002
  - the snapshot frozen after an item is edited, undone or received (the detail shows current states; the snapshot and PDF bytes unchanged)
  - list, filter and find
  - PDF download headers and the filename
  - the PDF made on demand when missing
  - access (`orders.view` yes; a login without it gets 403)
  - the notes line
  - the job card / orders `poNumber`
  - a line on two POs over time
  - the existing invoice PDF smokes still passing
- Update `ci/smoke-jobcards.sh` where 0.2.22's `Ref:` note format changes.
- Docs: update `docs/how-to-job-cards.md` (a Supplier orders section) and add a STATUS "Start here" entry.
- Version **0.2.23**, bumped once (`crosscuts/app/package.json` and both versions in `crosscuts/app/package-lock.json`). The next migration after this is 065.

## Delete lines and cards (Todd 2026-11-18)

Added to 0.2.23 by Todd on 2026-11-18 (same version, no extra bump).

### Todd's decisions (binding)

1. **Delete line on a job card** (and on the job page's order lines). Only lines with status `to_order` can be deleted. Ordered and received lines can't be; the confirm or error says to Undo ordered first.
2. **Delete is a soft delete.** Nothing is erased:
   - The line gets `deleted_at` (UTC ISO) and `deleted_by`.
   - It disappears everywhere: job cards and their counts, the job page, All order lines, the supplier order list and its counts, Deliveries, `GET /api/orders` and the cards endpoint.
   - It is audited (`order.delete` with job, supplier and description).
3. **Delete card** works only when every non-cancelled, non-deleted line on the job is still `to_order`. Then it deletes them all (soft) in one transaction after a confirm naming the job and line count, and the card disappears. If any line is ordered or received, it refuses with a 409 saying so (e.g. "2 items on this card are already ordered or received"). The page then offers "Delete the N To order items instead", which deletes just those.

### Lead's defaults (binding)

- Access: `orders.edit` for deleting a line or a card. Every rule lives in `lib/orders.js`.
- Data: a new migration `065_order_soft_delete.sql` (additive): `orders.deleted_at TEXT`, `orders.deleted_by INTEGER REFERENCES users(id)`. The status CHECK is not touched.
- Deleting a job's last outstanding to_order line behaves exactly like cancelling it today (`markMaterialsOrdered` and `onAllOrdered`). Deleted lines count like cancelled ones in `allOrdered`. A deleted line can't be edited, ordered or received (409).
- Restore (admins only): the All order lines tab's status filter gets a "Deleted" option, visible to `users.admin` only. It lists deleted lines with who and when, and a **Restore** button (`users.admin`). Restore clears `deleted_at`/`deleted_by`, audits `order.restore`, and puts the line back as to_order. If the job had become all-ordered because of the delete, that step stays done: invoices and hand-offs are not reversed.
- Routes through `defineRoutes`: `POST /api/orders/:id/delete` (`orders.edit`); `POST /api/job-records/:id/orders/delete-card` with body `{onlyToOrder?: true}` (`orders.edit`); `POST /api/orders/:id/restore` (`users.admin`); `GET /api/orders?status=deleted` (`users.admin`, enforced in lib).
- UI: the open job card gets a **Delete** text button on each To order line (`hs-btn-stop`); the card header gets **Delete card** (`hs-btn-stop`). Confirm dialogs in the existing house dialog style, no icons. After deleting a card, return to the cards list with a message.
- Purchase orders: a deleted line can't be on a new PO (only to_order lines can be deleted and a PO only takes to_order lines). PO snapshots are untouched.
- Smoke and docs: covered in the smokes; a short "Deleting items and cards" section in `docs/how-to-job-cards.md`.

## New supplier order starts unticked (Todd 2026-11-18)

On New supplier order every item starts unticked (0.2.22 ticked them all). The tick-all box starts unticked; "Mark N ordered" and Print list are disabled until at least one item is ticked, and the count reads "0 of N items"; changing the supplier resets every item to unticked; tick-all still ticks or unticks everything.

## Lead's decisions on the build's open questions (2026-11-18, binding)

- **PO link reflects the current ordered state.** A job card's PO link (an order line's `poId`/`poNumber`) shows a saved order only while the line's latest move to `ordered` came from that saved order. A line that was undone, or undone and then ordered singly, has no link. This is kept in a new additive migration **`066_order_po_link.sql`** (`orders.supplier_order_id`): `markOrderedMany` sets it, and a move back to To order, a cancel, or a single re-order clears it (received keeps it). The old order's detail still shows the line as "Undone since" (or "now on PO-n" via `laterPo`); `supplier_order_lines` keeps the history.
- **One supplier per supplier order.** `markOrderedMany` refuses lines from more than one supplier with a 400, "A supplier order is for one supplier" (names compared trimmed, any case), before any write. The snapshot's supplier is the first item's.
- The next migration after this release is **067**.
