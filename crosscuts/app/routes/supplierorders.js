// Saved supplier orders (purchase orders): /api/supplier-orders (0.2.23,
// docs/plans/purchase-orders-plan.md). Viewing, printing and downloading need orders.view. A saved
// order is created only by POST /api/orders/mark-ordered (routes/orders.js); there is no edit or
// delete. The rules are in lib/purchaseorders.js.
const path = require("path");
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const po = require("../lib/purchaseorders");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[supplierorders]");
    }
  };
}

function idOr404(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw notFound();
  return id;
}

// ?q=<text>&supplier=<name> -> {orders: [...], suppliers: [...]}, newest first.
r.get("/supplier-orders", "orders.view", handle((req, res) => {
  const q = req.query;
  for (const k of ["q", "supplier"]) {
    if (q[k] !== undefined && typeof q[k] !== "string") throw bad(`${k} must be a single value`);
  }
  res.json(po.list(db, { q: q.q, supplier: q.supplier }));
}));

// The saved order: its snapshot and each item's current state.
r.get("/supplier-orders/:id", "orders.view", handle((req, res) => {
  res.json(po.detail(db, idOr404(req)));
}));

// The frozen PDF. Made from the snapshot on first use when it is missing; never re-rendered once made.
// ?download=1 -> Content-Disposition: attachment with "PO-0007 Supplier.pdf".
r.get("/supplier-orders/:id/pdf", "orders.view", async (req, res) => {
  try {
    const id = idOr404(req);
    const d = req.query.download;
    if (d !== undefined && d !== "" && d !== "0" && d !== "1") throw bad("download must be 0 or 1");
    const order = po.detail(db, id); // 404 first
    let out;
    try {
      out = await po.ensurePdf(db, id);
    } catch (e) {
      if (e && typeof e.status === "number") throw e;
      console.error("[supplierorders] PDF failed:", e && e.message ? e.message : e);
      return res.status(502).json({ error: "The order PDF couldn't be made (" + (e && e.message ? e.message : "unknown problem") + ")." });
    }
    const name = po.downloadName(order);
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `${d === "1" ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    // root: so the dotfile check covers only the file name, not the folders above the data dir.
    res.sendFile(path.basename(out.file), { root: path.dirname(out.file), dotfiles: "deny", cacheControl: false, lastModified: false });
  } catch (e) {
    sendError(res, e, "[supplierorders]");
  }
});

module.exports = r.router;
