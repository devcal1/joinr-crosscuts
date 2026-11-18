// Supplier order lines: /api/job-records/:id/orders and /api/orders.
// See docs/plans/m3-contracts.md section 4 and docs/plans/m10-contracts.md section 5. The rules
// (who may mark a line ordered or received, the delivery note, the all-ordered and materials-in
// rules) live in lib/orders.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const orders = require("../lib/orders");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[orders]");
    }
  };
}

function parseId(v) {
  const id = Number(v);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// The id in the path, or a 404.
function idOr404(req) {
  const id = parseId(req.params.id);
  if (!id) throw notFound();
  return id;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

r.get("/job-records/:id/orders", "jobs.view", handle((req, res) => {
  const id = idOr404(req);
  const all = req.query.all;
  if (all !== undefined && all !== "" && all !== "0" && all !== "1") throw bad("all must be 0 or 1");
  res.json(orders.listForJob(db, id, { includeCancelled: all === "1" }));
}));

r.post("/job-records/:id/orders", "orders.edit", handle((req, res) => {
  const id = idOr404(req);
  const b = body(req);
  res.status(201).json(
    orders.createLine(
      db,
      id,
      {
        supplier: b.supplier,
        description: b.description,
        quantity: b.quantity,
        expectedDate: b.expectedDate,
        notes: b.notes,
      },
      req
    )
  );
}));

// 0.2.22 (docs/plans/jobcards-plan.md): add items to a job card, all or nothing.
// Body {lines: [{supplier, description, quantity}]}, 1 to 50 lines -> 201 {orders: [...], job}.
r.post("/job-records/:id/orders/batch", "orders.edit", handle((req, res) => {
  const id = idOr404(req);
  const b = body(req);
  res.status(201).json(orders.createLines(db, id, b.lines, req));
}));

// Registered before the /orders/:id routes. M10: orders.view (order lines without the job pages).
// 0.2.22: also suggests the Supplier accounts names (suppliers table).
r.get("/orders/suppliers", "orders.view", handle((req, res) => {
  res.json(orders.suppliers(db, typeof req.query.q === "string" ? req.query.q : ""));
}));

// 0.2.22: the job cards on the Orders page. ?finished=1 adds jobs whose lines are all received
// (and archived jobs). -> {cards: [...]}
r.get("/orders/cards", "orders.view", handle((req, res) => {
  const f = req.query.finished;
  if (f !== undefined && f !== "" && f !== "0" && f !== "1") throw bad("finished must be 0 or 1");
  res.json(orders.cards(db, { finished: f === "1" }));
}));

// 0.2.22: the supplier order's Mark N ordered. Body {orderIds, orderedDate, expectedDate, supplierRef}
// -> 200 {count, jobCount, orders: [...]}. One transaction; 409 and nothing changed if any line is no
// longer to order. The finer rules are in lib/orders.js markOrderedMany.
r.post("/orders/mark-ordered", "orders.mark_ordered", handle((req, res) => {
  const b = body(req);
  res.json(
    orders.markOrderedMany(
      db,
      b.orderIds,
      { orderedDate: b.orderedDate, expectedDate: b.expectedDate, supplierRef: b.supplierRef },
      req
    )
  );
}));

// M10 (docs/plans/m10-contracts.md section 4.4): the Deliveries page. Registered before the
// /orders/:id routes.
r.get("/orders/deliveries", "orders.receive", handle((req, res) => {
  res.json(orders.deliveries(db));
}));

r.get("/orders", "orders.view", handle((req, res) => {
  const q = req.query;
  for (const k of ["status", "supplier", "jobId"]) {
    if (q[k] !== undefined && typeof q[k] !== "string") throw bad(`${k} must be a single value`);
  }
  res.json(orders.list(db, { status: q.status, supplier: q.supplier, jobId: q.jobId }));
}));

// The finer rules (which key each change needs) are in lib/orders.js updateLine.
r.patch("/orders/:id", ["orders.edit", "orders.mark_ordered", "orders.receive"], handle((req, res) => {
  const id = idOr404(req);
  res.json(orders.updateLine(db, id, body(req), req));
}));

r.post("/orders/:id/cancel", "orders.edit", handle((req, res) => {
  const id = idOr404(req);
  res.json(orders.cancelLine(db, id, req));
}));

module.exports = r.router;
