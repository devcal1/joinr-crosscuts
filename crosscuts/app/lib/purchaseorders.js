// Saved supplier orders: purchase orders with a frozen PDF (0.2.23, docs/plans/purchase-orders-plan.md).
//
// A saved order is made only by lib/orders.js markOrderedMany (the supplier order's Mark ordered), in
// that function's own transaction: create() allocates the PO number, writes the snapshot and the lines.
// The PDF is made after the transaction commits (ensurePdf), from the snapshot only, so it is the same
// whenever it is made; once made the file is never re-rendered. Nothing here edits or deletes a saved
// order. All who-may-do-what rules live here and in lib/orders.js; the routes are thin.
//
// The snapshot (snapshot_json, version 1). BINDING: the print page (public/orderprint.js ?mode=po) and
// the PDF render from exactly this, and nothing else:
//   {
//     version: 1,
//     poNumber: "PO-0007",            // poNumberOf(poSeq)
//     poSeq: 7,
//     supplier: "Blum Hardware",      // the items' supplier (trimmed). When the items name more than
//                                     // one supplier (only possible through the API, never the page),
//                                     // their distinct names A-Z joined with ", "
//     orderedDate: "2026-11-18",      // YYYY-MM-DD
//     expectedDate: "2026-11-25",     // or null
//     supplierRef: "BH-55120",        // trimmed; "" when none
//     orderedBy: "Todd Harlow",       // the orderer's display name (else username), or null
//     createdAt: "2026-11-18T03:12:45.123Z",
//     business: { tradingName, legalName, abn, address, phone, email },  // settings.business(db) at that
//                                     // moment (strings or null; no bank details)
//     items: [                        // in the screen's order (the orderIds order)
//       { orderId: 41, jobId: 12, jobNumber: "J-1042" | null, jobName: "Harlow kitchen",
//         supplier: "Blum Hardware", description: "Soft-close hinge", quantity: 24 | null }
//     ]
//   }
//
// Stored PDFs: <UPLOADS_DIR>/files/<PO-0007>.pdf, directly in files/ (not a subfolder). The NAS backup
// (lib/backup/copy.js) copies only the regular files directly in uploads/files whose names match
// names.FILE_NAME_RE, encrypted like every private file; it does not walk subfolders. files/ is never
// served statically (server.js narrows /photos to top-level images), and private uploads there are
// named by multer's random hex, so a PO-NNNN.pdf name cannot collide. pdf_path holds the bare name.

/** "PO-0007"; past 9999 just longer ("PO-10000"). */
function poNumberOf(poSeq) {
  return "PO-" + String(poSeq).padStart(4, "0");
}

/**
 * Called by markOrderedMany INSIDE its transaction, after every line has been updated.
 * @param db
 * @param {{orderedDate: string, expectedDate: string|null, supplierRef: string,
 *          lines: Array<{orderId:number}>}} what  lines in the screen's order
 * @param req  the request (req.user is the orderer)
 * @returns {{id: number, poSeq: number, poNumber: string}}
 * Also writes one audit row: action "supplier_order.create", entityType "supplier_order", entityId id,
 * after {poNumber, lineCount, supplier}.
 */
function create(db, what, req) {
  throw new Error("not built yet");
}

/**
 * The PO number a line is about to get, for the notes line, computed inside the same transaction
 * before create() runs: MAX(po_seq)+1. markOrderedMany uses it to write "PO-0007" or
 * "PO-0007 · Ref: BH-55120" into each line's notes.
 */
function nextPoSeq(db) {
  throw new Error("not built yet");
}

/**
 * GET /api/supplier-orders. Newest first (po_seq DESC).
 * @param {{q?: string, supplier?: string}} filters  q: PO number ("PO-0007", "0007" or "7"), supplier ref,
 *        job number or job name (from the snapshot items), case-insensitive substring;
 *        supplier: exact, case-insensitive, trimmed.
 * @returns {{orders: Array<ListItem>, suppliers: string[]}}  suppliers: every saved order's supplier,
 *        distinct case-insensitively, A-Z (for the filter; not narrowed by the filters).
 * ListItem: {id, poNumber, poSeq, supplier, orderedDate, expectedDate, supplierRef, orderedBy,
 *            createdAt, itemCount, jobNumbers: string[] (distinct, in item order, nulls left out),
 *            jobs: [{jobId, jobNumber, jobName}] (distinct, in item order), pdfReady: boolean}
 */
function list(db, filters) {
  throw new Error("not built yet");
}

/**
 * GET /api/supplier-orders/:id. 404 when there is no such order.
 * @returns ListItem plus {pdfMadeAt, snapshot, items}
 *   snapshot: the parsed snapshot_json, unchanged
 *   items: the snapshot items in order, each plus {current: {
 *     status: the line's status now ("to_order"|"ordered"|"received"|"cancelled"),
 *     state: "ordered" | "received" | "undone",
 *       ordered/received: the line is ordered/received now and THIS is the latest saved order holding it
 *       undone: the line is back to to_order or cancelled, or is now on a later saved order
 *     receivedDate: YYYY-MM-DD or null (state received),
 *     undoneAt: the line's updated_at (ISO) when it is back to to_order/cancelled, else null,
 *     undoneBy: that update's display name, else null,
 *     laterPo: {id, poNumber} when the line is now ordered/received on a later saved order, else null
 *   }}
 */
function detail(db, id) {
  throw new Error("not built yet");
}

/**
 * The line's current saved order: the latest (highest po_seq) saved order holding it, but only while
 * the line is ordered or received; else null. Used for poId/poNumber on every order line (present()).
 */
function currentPoSql() {
  throw new Error("not built yet");
}

/**
 * Make the PDF if it is not made yet (or its file is missing), from the snapshot only, store it and
 * record pdf_path and pdf_made_at. Never re-renders a file that exists. One render per order at a time.
 * Rejects when the renderer fails (the order is unaffected).
 * @returns {Promise<{file: string (absolute path), fileName: string (download name)}>}
 */
async function ensurePdf(db, id) {
  throw new Error("not built yet");
}

/** "PO-0007 Blum Hardware.pdf", made filename-safe. */
function downloadName(order) {
  throw new Error("not built yet");
}

module.exports = { poNumberOf, create, nextPoSeq, list, detail, currentPoSql, ensurePdf, downloadName };
