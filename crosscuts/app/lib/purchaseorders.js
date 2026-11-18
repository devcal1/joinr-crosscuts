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

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const audit = require("./audit");
const settings = require("./settings");
const pdfrender = require("./pdfrender");
const { UPLOADS_DIR } = require("./config");
const { notFound } = require("./httperror");

// Absolute, as res.sendFile needs (UPLOADS_DIR is relative in a bare dev run). Same folder as lib/files.js.
const FILES_DIR = path.resolve(UPLOADS_DIR, "files");

/** "PO-0007"; past 9999 just longer ("PO-10000"). */
function poNumberOf(poSeq) {
  return "PO-" + String(poSeq).padStart(4, "0");
}

/**
 * The PO number a line is about to get, for the notes line, computed inside the same transaction
 * before create() runs: MAX(po_seq)+1. markOrderedMany uses it to write "PO-0007" or
 * "PO-0007 · Ref: BH-55120" into each line's notes.
 */
function nextPoSeq(db) {
  const r = db.prepare("SELECT COALESCE(MAX(po_seq), 0) + 1 AS n FROM supplier_orders").get();
  return r.n;
}

// The supplier of an order: the items' distinct names A-Z (case-insensitive) joined with ", ".
function supplierOf(items) {
  const byKey = new Map();
  for (const it of items) {
    const name = String(it.supplier || "").trim();
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  }
  return [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, n]) => n).join(", ");
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
  const lines = what.lines || [];
  const getItem = db.prepare(
    `SELECT o.id AS order_id, o.job_id, o.supplier, o.description, o.quantity, j.name AS job_name, j.job_number
     FROM orders o LEFT JOIN jobs j ON j.id = o.job_id WHERE o.id = ?`
  );
  const items = lines.map((l) => {
    const r = getItem.get(l.orderId);
    return {
      orderId: r.order_id,
      jobId: r.job_id,
      jobNumber: r.job_number || null,
      jobName: r.job_name || "",
      supplier: String(r.supplier || "").trim(),
      description: r.description,
      quantity: r.quantity == null ? null : Number(r.quantity),
    };
  });
  const poSeq = nextPoSeq(db);
  const poNumber = poNumberOf(poSeq);
  const supplier = supplierOf(items);
  const userId = req && req.user && req.user.id != null ? req.user.id : null;
  let orderedBy = null;
  if (userId != null) {
    const u = db.prepare("SELECT display_name, username FROM users WHERE id = ?").get(userId);
    orderedBy = (u && (u.display_name || u.username)) || (req.user.username || null);
  }
  const b = settings.business(db);
  const createdAt = new Date().toISOString();
  const snapshot = {
    version: 1,
    poNumber,
    poSeq,
    supplier,
    orderedDate: what.orderedDate,
    expectedDate: what.expectedDate || null,
    supplierRef: what.supplierRef || "",
    orderedBy,
    createdAt,
    business: {
      tradingName: b.tradingName || null,
      legalName: b.legalName || null,
      abn: b.abn || null,
      address: b.address || null,
      phone: b.phone || null,
      email: b.email || null,
    },
    items,
  };
  const info = db
    .prepare(
      `INSERT INTO supplier_orders (po_seq, supplier, ordered_date, expected_date, supplier_ref, created_by, created_at, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(poSeq, supplier, what.orderedDate, what.expectedDate || null, what.supplierRef || "", userId, createdAt, JSON.stringify(snapshot));
  const id = Number(info.lastInsertRowid);
  const ins = db.prepare("INSERT INTO supplier_order_lines (supplier_order_id, order_id, sort) VALUES (?, ?, ?)");
  items.forEach((it, i) => ins.run(id, it.orderId, i));
  audit.log(req, {
    action: "supplier_order.create",
    entityType: "supplier_order",
    entityId: id,
    after: { poNumber, lineCount: items.length, supplier },
  });
  return { id, poSeq, poNumber };
}

function pdfFile(row) {
  return row.pdf_path ? path.join(FILES_DIR, row.pdf_path) : null;
}

function pdfReadyOf(row) {
  const f = pdfFile(row);
  return !!f && fs.existsSync(f);
}

function listItem(row) {
  const snap = JSON.parse(row.snapshot_json);
  const items = Array.isArray(snap.items) ? snap.items : [];
  const jobs = [];
  const seen = new Set();
  const jobNumbers = [];
  for (const it of items) {
    if (!seen.has(it.jobId)) {
      seen.add(it.jobId);
      jobs.push({ jobId: it.jobId, jobNumber: it.jobNumber || null, jobName: it.jobName || "" });
      if (it.jobNumber && !jobNumbers.includes(it.jobNumber)) jobNumbers.push(it.jobNumber);
    }
  }
  return {
    snap,
    item: {
      id: row.id,
      poNumber: poNumberOf(row.po_seq),
      poSeq: row.po_seq,
      supplier: row.supplier,
      orderedDate: row.ordered_date,
      expectedDate: row.expected_date || null,
      supplierRef: row.supplier_ref || "",
      orderedBy: snap.orderedBy || null,
      createdAt: row.created_at,
      itemCount: items.length,
      jobNumbers,
      jobs,
      pdfReady: pdfReadyOf(row),
    },
  };
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
  const f = filters || {};
  const q = typeof f.q === "string" ? f.q.trim().toLowerCase() : "";
  const sup = typeof f.supplier === "string" ? f.supplier.trim().toLowerCase() : "";
  const numeric = /^(?:po-?)?(\d+)$/.exec(q);
  const rows = db.prepare("SELECT * FROM supplier_orders ORDER BY po_seq DESC").all();
  const byKey = new Map();
  const orders = [];
  for (const row of rows) {
    const name = String(row.supplier || "").trim();
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
    if (sup && name.toLowerCase() !== sup) continue;
    const { snap, item } = listItem(row);
    if (q) {
      const poHit = numeric ? row.po_seq === Number(numeric[1]) : item.poNumber.toLowerCase().includes(q);
      const hit =
        poHit ||
        String(row.supplier_ref || "").toLowerCase().includes(q) ||
        (snap.items || []).some(
          (it) => String(it.jobNumber || "").toLowerCase().includes(q) || String(it.jobName || "").toLowerCase().includes(q)
        );
      if (!hit) continue;
    }
    orders.push(item);
  }
  const suppliers = [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, n]) => n);
  return { orders, suppliers };
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
  const row = db.prepare("SELECT * FROM supplier_orders WHERE id = ?").get(id);
  if (!row) throw notFound();
  const { snap, item } = listItem(row);
  const getLine = db.prepare(
    `SELECT o.status, o.received_date, o.updated_at, u.display_name AS updated_by_name
     FROM orders o LEFT JOIN users u ON u.id = o.updated_by WHERE o.id = ?`
  );
  const latest = db.prepare(
    `SELECT so.id, so.po_seq FROM supplier_order_lines sol JOIN supplier_orders so ON so.id = sol.supplier_order_id
     WHERE sol.order_id = ? ORDER BY so.po_seq DESC LIMIT 1`
  );
  const items = (snap.items || []).map((it) => {
    const l = getLine.get(it.orderId);
    const status = l ? l.status : "cancelled";
    const live = status === "ordered" || status === "received";
    const top = live ? latest.get(it.orderId) : null;
    const later = top && top.id !== id ? { id: top.id, poNumber: poNumberOf(top.po_seq) } : null;
    const back = !live;
    return {
      ...it,
      current: {
        status,
        state: back || later ? "undone" : status,
        receivedDate: !back && !later && status === "received" ? (l.received_date || null) : null,
        undoneAt: back && l ? l.updated_at || null : null,
        undoneBy: back && l ? l.updated_by_name || null : null,
        laterPo: later,
      },
    };
  });
  return { ...item, pdfMadeAt: row.pdf_made_at || null, snapshot: snap, items };
}

/**
 * The line's current saved order: the latest (highest po_seq) saved order holding it, but only while
 * the line is ordered or received; else null. Used for poId/poNumber on every order line (present()).
 * Returns two SELECT-list columns ("... AS po_id, ... AS po_seq") over the alias `o` (orders), to be
 * added to a query's column list; the number is poNumberOf(po_seq).
 */
function currentPoSql() {
  const pick = (col) =>
    `(SELECT ${col} FROM supplier_order_lines sol JOIN supplier_orders so ON so.id = sol.supplier_order_id
      WHERE sol.order_id = o.id AND o.status IN ('ordered', 'received') ORDER BY so.po_seq DESC LIMIT 1)`;
  return `${pick("so.id")} AS po_id, ${pick("so.po_seq")} AS po_seq`;
}

/** "PO-0007 Blum Hardware.pdf", made filename-safe. */
function downloadName(order) {
  const po = String(order.poNumber || "PO").trim();
  const sup = String(order.supplier || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const room = 120 - po.length - 5; // " " + ".pdf"
  const cut = sup.slice(0, Math.max(room, 0)).replace(/[ .]+$/, "").trim();
  return cut ? `${po} ${cut}.pdf` : `${po}.pdf`;
}

const inflight = new Map(); // order id -> Promise

async function makePdf(db, row) {
  const poNumber = poNumberOf(row.po_seq);
  let pdf;
  if (process.env.PDF_FAKE === "1") {
    const sha = crypto.createHash("sha256").update(row.snapshot_json).digest("hex");
    pdf = pdfrender.fakePdf(`${poNumber} snapshot-sha256:${sha}`);
  } else {
    pdf = await pdfrender.renderPdf("po", row.id);
  }
  if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("the PDF came out empty");
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const name = `${poNumber}.pdf`;
  const file = path.join(FILES_DIR, name);
  const part = file + ".part";
  fs.writeFileSync(part, pdf);
  fs.renameSync(part, file);
  db.prepare("UPDATE supplier_orders SET pdf_path = ?, pdf_made_at = ? WHERE id = ?").run(name, new Date().toISOString(), row.id);
  return file;
}

/**
 * Make the PDF if it is not made yet (or its file is missing), from the snapshot only, store it and
 * record pdf_path and pdf_made_at. Never re-renders a file that exists. One render per order at a time.
 * Rejects when the renderer fails (the order is unaffected).
 * @returns {Promise<{file: string (absolute path), fileName: string (download name)}>}
 */
async function ensurePdf(db, id) {
  const row = db.prepare("SELECT * FROM supplier_orders WHERE id = ?").get(id);
  if (!row) throw notFound();
  const fileName = downloadName({ poNumber: poNumberOf(row.po_seq), supplier: row.supplier });
  const have = pdfFile(row);
  if (have && fs.existsSync(have)) return { file: have, fileName };
  let p = inflight.get(id);
  if (!p) {
    p = makePdf(db, row).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return { file: await p, fileName };
}

module.exports = { poNumberOf, create, nextPoSeq, list, detail, currentPoSql, ensurePdf, downloadName };
