// Paint orders (docs/plans/m11-contracts.md section 6.3): the paint list, paint orders and their
// lines, the job lines that become order lines on their jobs (Decision 6), and the litres factor.
// Wave 1 C.
//
// Order line statuses change only through lib/orders.js with {via: "paint"} (section 5.2), so the
// all-ordered rule (the progress invoice) and materials in run per job exactly as for any line.
// Every function takes db first and nothing here requires ../db. Every write runs in one
// db.transaction with its audit row.
//
// A paint order goes draft -> ordered -> received (and back one step at a time), or draft ->
// cancelled. While it is a draft, every write keeps exactly one order line per job in its lines
// (linked in paint_order_jobs); a job that leaves the lines has its order line cancelled and its
// link removed. Litres are worked out when read (kg lines only), never stored.
const { bad, notFound, conflict, forbidden, can } = require("./httperror");
const { sydneyToday } = require("./time");
const audit = require("./audit");
const notify = require("./notify");
const orders = require("./orders");
const settings = require("./settings");
const invoices = require("./invoices");

const KINDS = ["colour", "hardener", "thinners", "primer", "abrasive", "other"];
const UNITS = ["kg", "each"];
const STATUSES = ["draft", "ordered", "received", "cancelled"];
const TEXT_MAX = 200;
const SUPPLIER_MAX = 200; // as an order line's supplier (lib/orders.js)
const NOTES_MAX = 2000;
const DELIVERY_NOTE_MAX = 500; // as an order line's delivery note (m10-contracts.md section 4.2)
const DESCRIPTION_MAX = 500;
const LINES_MAX = 200;
const QTY_MAX = 9999;
const FACTOR_MIN = 0.1;
const FACTOR_MAX = 5;
const SETTING = "paint.litres_per_kg";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------- helpers ---

function nowIso() {
  return new Date().toISOString();
}

function userId(req) {
  return req && req.user && req.user.id != null ? req.user.id : null;
}

// "2026-10-03" -> "3 Oct 2026".
function dayLabel(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function person(id, name) {
  return id == null ? null : { id, name: name || null };
}

function text(label, v, max, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw bad(`${label} is required`);
    return "";
  }
  if (typeof v !== "string") throw bad(`${label} must be text`);
  const t = v.trim();
  if (required && !t) throw bad(`${label} is required`);
  if (t.length > max) throw bad(`${label} must be ${max} characters or fewer`);
  return t;
}

// null / "" -> null; a valid date -> itself; anything else -> 400.
function dateOrNull(label, v) {
  if (v === undefined || v === null || v === "") return null;
  if (!invoices.validDate(v)) throw bad(`${label} must be a valid YYYY-MM-DD date`);
  return v;
}

function boolField(label, v) {
  if (typeof v !== "boolean") throw bad(`${label} must be true or false`);
  return v;
}

function positiveId(v) {
  return Number.isSafeInteger(v) && v > 0;
}

// A quantity: above 0, at most QTY_MAX, in steps of 0.01. Stored rounded to the step.
function qtyField(label, v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > QTY_MAX) {
    throw bad(`${label} must be a number above 0 and at most ${QTY_MAX}`);
  }
  const cents = Math.round(v * 100);
  if (Math.abs(v * 100 - cents) > 1e-6) throw bad(`${label} must be in steps of 0.01`);
  return cents / 100;
}

// 4 -> "4", 2.5 -> "2.5", 0.25 -> "0.25".
function qtyText(q) {
  return String(Math.round(q * 100) / 100);
}

// kg x factor, rounded to 0.01; null for an "each" line.
function litresOf(unit, qty, factor) {
  if (unit !== "kg") return null;
  return Math.round(qty * factor * 100 + 1e-7) / 100;
}

function cut(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ------------------------------------------------------------- paint list ---

const ITEM_SQL = `SELECT pi.*, u.display_name AS updated_by_name
  FROM paint_items pi LEFT JOIN users u ON u.id = pi.updated_by`;

function toItem(r) {
  return {
    id: r.id,
    name: r.name,
    finish: r.finish,
    manufacturer: r.manufacturer,
    kind: r.kind,
    unit: r.unit,
    sort: r.sort,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: person(r.updated_by, r.updated_by_name),
  };
}

function itemRow(db, id) {
  return db.prepare(`${ITEM_SQL} WHERE pi.id = ?`).get(id);
}

function itemOr404(db, id) {
  const r = itemRow(db, id);
  if (!r) throw notFound();
  return r;
}

// The stored columns of an item, for audit rows.
function itemFields(r) {
  return { name: r.name, finish: r.finish, manufacturer: r.manufacturer, kind: r.kind, unit: r.unit, active: r.active };
}

// The active items by sort; with `all`, the inactive ones follow (by sort).
function items(db, { all = false } = {}) {
  const where = all ? "" : "WHERE pi.active = 1";
  return db.prepare(`${ITEM_SQL} ${where} ORDER BY pi.active DESC, pi.sort, pi.id`).all().map(toItem);
}

// The item fields in `body`: every field on create (name, kind and unit required), only those sent
// on a patch. Returns {column: value}.
function itemInput(body, { partial }) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  const out = {};
  if (!partial || has("name")) out.name = text("name", body.name, TEXT_MAX, { required: true });
  if (!partial || has("finish")) out.finish = text("finish", body.finish, TEXT_MAX);
  if (!partial || has("manufacturer")) out.manufacturer = text("manufacturer", body.manufacturer, TEXT_MAX);
  if (!partial || has("kind")) {
    if (!KINDS.includes(body.kind)) throw bad(`kind must be one of ${KINDS.join(", ")}`);
    out.kind = body.kind;
  }
  if (!partial || has("unit")) {
    if (!UNITS.includes(body.unit)) throw bad(`unit must be one of ${UNITS.join(", ")}`);
    out.unit = body.unit;
  }
  if (has("active")) out.active = boolField("active", body.active) ? 1 : 0;
  else if (!partial) out.active = 1;
  return out;
}

function createItem(db, req, body) {
  const f = itemInput(body, { partial: false });
  return db.transaction(() => {
    const now = nowIso();
    const { next } = db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM paint_items").get();
    const info = db
      .prepare(
        `INSERT INTO paint_items (name, finish, manufacturer, kind, unit, sort, active, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.name, f.finish, f.manufacturer, f.kind, f.unit, next, f.active, now, now, userId(req));
    const id = Number(info.lastInsertRowid);
    audit.log(req, { action: "paint_item.create", entityType: "paint_item", entityId: id, after: { ...f, sort: next } });
    return toItem(itemRow(db, id));
  })();
}

function updateItem(db, req, id, body) {
  const row = itemOr404(db, id);
  const f = itemInput(body, { partial: true });
  const changed = Object.keys(f).filter((c) => f[c] !== row[c]);
  if (!changed.length) return toItem(row);
  return db.transaction(() => {
    db.prepare(
      `UPDATE paint_items SET ${changed.map((c) => `${c} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(...changed.map((c) => f[c]), nowIso(), userId(req), id);
    const before = {};
    const after = {};
    for (const c of changed) {
      before[c] = row[c];
      after[c] = f[c];
    }
    audit.log(req, { action: "paint_item.update", entityType: "paint_item", entityId: id, before, after });
    return toItem(itemRow(db, id));
  })();
}

// `ids` is the whole paint list (active and inactive), each id once, in the new order.
function reorderItems(db, req, ids) {
  if (!Array.isArray(ids) || !ids.every(positiveId)) throw bad("ids must be a list of paint item ids");
  if (new Set(ids).size !== ids.length) throw bad("ids must not repeat an item");
  const current = db.prepare("SELECT id FROM paint_items ORDER BY sort, id").all().map((r) => r.id);
  const known = new Set(current);
  if (ids.length !== current.length || !ids.every((id) => known.has(id))) {
    throw conflict("The paint list changed while you were looking; reload it");
  }
  if (ids.every((id, i) => id === current[i])) return items(db, { all: true });
  return db.transaction(() => {
    const now = nowIso();
    const set = db.prepare("UPDATE paint_items SET sort = ?, updated_at = ?, updated_by = ? WHERE id = ?");
    ids.forEach((id, i) => set.run(i + 1, now, userId(req), id));
    audit.log(req, {
      action: "paint_item.reorder",
      entityType: "paint_item",
      entityId: null,
      before: { ids: current },
      after: { ids },
    });
    return items(db, { all: true });
  })();
}

// ----------------------------------------------------------- paint orders ---

const ORDER_SQL = `SELECT po.*, uo.display_name AS ordered_by_name, ur.display_name AS received_by_name,
    uc.display_name AS created_by_name, uu.display_name AS updated_by_name,
    (SELECT COUNT(*) FROM paint_order_lines l WHERE l.paint_order_id = po.id) AS line_count
  FROM paint_orders po
  LEFT JOIN users uo ON uo.id = po.ordered_by
  LEFT JOIN users ur ON ur.id = po.received_by
  LEFT JOIN users uc ON uc.id = po.created_by
  LEFT JOIN users uu ON uu.id = po.updated_by`;

function orderRow(db, id) {
  return db.prepare(`${ORDER_SQL} WHERE po.id = ?`).get(id);
}

function orderOr404(db, id) {
  const r = orderRow(db, id);
  if (!r) throw notFound();
  return r;
}

// The order's job links: one order line per job, by job name.
function jobLinks(db, paintOrderId) {
  return db
    .prepare(
      `SELECT poj.job_id, j.name AS job_name, poj.order_id, o.status AS order_status
       FROM paint_order_jobs poj
       JOIN jobs j ON j.id = poj.job_id
       JOIN orders o ON o.id = poj.order_id
       WHERE poj.paint_order_id = ?
       ORDER BY j.name COLLATE NOCASE, poj.job_id`
    )
    .all(paintOrderId)
    .map((r) => ({ jobId: r.job_id, jobName: r.job_name, orderId: r.order_id, orderStatus: r.order_status }));
}

function lineRows(db, paintOrderId) {
  return db
    .prepare(
      `SELECT l.*, j.name AS job_name FROM paint_order_lines l
       LEFT JOIN jobs j ON j.id = l.job_id
       WHERE l.paint_order_id = ? ORDER BY l.sort, l.id`
    )
    .all(paintOrderId);
}

function factor(db) {
  const n = Number(settings.get(db, SETTING));
  return Number.isFinite(n) && n > 0 ? n : Number(settings.DEFAULTS[SETTING]);
}

// The paint order object; `withLines` adds its lines (with litres) and the factor used.
function present(db, r, { withLines = false } = {}) {
  const out = {
    id: r.id,
    supplier: r.supplier,
    status: r.status,
    notes: r.notes,
    orderedDate: r.ordered_date || null,
    orderedBy: person(r.ordered_by, r.ordered_by_name),
    expectedDate: r.expected_date || null,
    receivedDate: r.received_date || null,
    receivedBy: person(r.received_by, r.received_by_name),
    deliveryNote: r.delivery_note || "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: person(r.created_by, r.created_by_name),
    updatedBy: person(r.updated_by, r.updated_by_name),
    lineCount: r.line_count,
    jobs: jobLinks(db, r.id),
  };
  if (withLines) {
    const f = factor(db);
    out.litresPerKg = f;
    out.lines = lineRows(db, r.id).map((l) => ({
      id: l.id,
      paintItemId: l.paint_item_id == null ? null : l.paint_item_id,
      name: l.name,
      finish: l.finish,
      manufacturer: l.manufacturer,
      unit: l.unit,
      qty: l.qty,
      litres: litresOf(l.unit, l.qty, f),
      jobId: l.job_id == null ? null : l.job_id,
      jobName: l.job_id == null ? null : l.job_name,
    }));
  }
  return out;
}

// `status`: open (draft or ordered; the default), all, or one status.
function list(db, { status } = {}) {
  const st = status === undefined || status === null || status === "" ? "open" : status;
  if (st !== "open" && st !== "all" && !STATUSES.includes(st)) {
    throw bad(`status must be one of open, all, ${STATUSES.join(", ")}`);
  }
  let where = "";
  const params = [];
  if (st === "open") where = "WHERE po.status IN ('draft', 'ordered')";
  else if (st !== "all") {
    where = "WHERE po.status = ?";
    params.push(st);
  }
  return db
    .prepare(`${ORDER_SQL} ${where} ORDER BY po.created_at DESC, po.id DESC`)
    .all(...params)
    .map((r) => present(db, r));
}

function get(db, id) {
  return present(db, orderOr404(db, id), { withLines: true });
}

// The lines of a create or update body, validated: [{paint_item_id, name, finish, manufacturer,
// unit, qty, job_id}]. An item's text and unit are copied from the paint list; a one-off line
// needs its own name and unit. A job must exist and not be archived.
function linesInput(db, v) {
  if (!Array.isArray(v)) throw bad("lines must be a list");
  if (v.length > LINES_MAX) throw bad(`A paint order takes at most ${LINES_MAX} lines`);
  return v.map((l, i) => {
    const at = `lines[${i}]`;
    if (!l || typeof l !== "object" || Array.isArray(l)) throw bad(`${at} must be an object`);
    const qty = qtyField(`${at}.qty`, l.qty);
    let jobId = null;
    if (l.jobId !== undefined && l.jobId !== null) {
      if (!positiveId(l.jobId)) throw bad(`${at}.jobId must be a job id`);
      const job = db.prepare("SELECT id, archived FROM jobs WHERE id = ?").get(l.jobId);
      if (!job || Number(job.archived) !== 0) throw bad(`${at}.jobId must be a job that isn't archived`);
      jobId = l.jobId;
    }
    if (l.paintItemId !== undefined && l.paintItemId !== null) {
      if (!positiveId(l.paintItemId)) throw bad(`${at}.paintItemId must be a paint item id`);
      const item = db.prepare("SELECT * FROM paint_items WHERE id = ?").get(l.paintItemId);
      if (!item) throw bad(`${at}.paintItemId is not on the paint list`);
      return {
        paint_item_id: item.id,
        name: item.name,
        finish: item.finish,
        manufacturer: item.manufacturer,
        unit: item.unit,
        qty,
        job_id: jobId,
      };
    }
    const unit = l.unit;
    if (!UNITS.includes(unit)) throw bad(`${at}.unit must be one of ${UNITS.join(", ")}`);
    return {
      paint_item_id: null,
      name: text(`${at}.name`, l.name, TEXT_MAX, { required: true }),
      finish: text(`${at}.finish`, l.finish, TEXT_MAX),
      manufacturer: text(`${at}.manufacturer`, l.manufacturer, TEXT_MAX),
      unit,
      qty,
      job_id: jobId,
    };
  });
}

// "Paint: 4 kg Example Colour (Matt, Example Maker); 1 × Hardener", cut to 500.
function describe(lines) {
  const parts = lines.map((l) => {
    const what = l.unit === "kg" ? `${qtyText(l.qty)} kg ${l.name}` : `${qtyText(l.qty)} × ${l.name}`;
    const extra = [l.finish, l.manufacturer].filter(Boolean).join(", ");
    return extra ? `${what} (${extra})` : what;
  });
  return cut(`Paint: ${parts.join("; ")}`, DESCRIPTION_MAX);
}

// Replaces the order's lines (stored as given, in order).
function writeLines(db, paintOrderId, lines) {
  db.prepare("DELETE FROM paint_order_lines WHERE paint_order_id = ?").run(paintOrderId);
  const ins = db.prepare(
    `INSERT INTO paint_order_lines (paint_order_id, paint_item_id, name, finish, manufacturer, unit, qty, job_id, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  lines.forEach((l, i) =>
    ins.run(paintOrderId, l.paint_item_id, l.name, l.finish, l.manufacturer, l.unit, l.qty, l.job_id, i + 1)
  );
}

// Decision 6, on every draft write: exactly one order line per job in the lines, linked in
// paint_order_jobs, with the order's supplier, the job's description and expected date; a job no
// longer in the lines has its order line cancelled and its link removed. Runs inside the caller's
// transaction; the order line writes go through lib/orders.js with {via: "paint"}.
function syncJobLines(db, req, paintOrderId, { supplier, expectedDate }, lines) {
  const byJob = new Map();
  for (const l of lines) {
    if (l.job_id == null) continue;
    if (!byJob.has(l.job_id)) byJob.set(l.job_id, []);
    byJob.get(l.job_id).push(l);
  }
  const links = db.prepare("SELECT job_id, order_id FROM paint_order_jobs WHERE paint_order_id = ?").all(paintOrderId);
  const linked = new Map(links.map((r) => [r.job_id, r.order_id]));
  const notes = `Paint order ${paintOrderId}`;
  for (const [jobId, orderId] of linked) {
    if (byJob.has(jobId)) continue;
    orders.cancelLine(db, orderId, req, { via: "paint" });
    db.prepare("DELETE FROM paint_order_jobs WHERE paint_order_id = ? AND job_id = ?").run(paintOrderId, jobId);
  }
  for (const [jobId, jobLines] of byJob) {
    const fields = { supplier, description: describe(jobLines), expectedDate, notes };
    if (linked.has(jobId)) {
      orders.updateLine(db, linked.get(jobId), fields, req, { via: "paint" });
    } else {
      const { order } = orders.createLine(db, jobId, fields, req, { via: "paint" });
      db.prepare("INSERT INTO paint_order_jobs (paint_order_id, job_id, order_id) VALUES (?, ?, ?)").run(
        paintOrderId,
        jobId,
        order.id
      );
    }
  }
}

// The audit view of an order's editable content.
function snapshot(db, r) {
  return {
    supplier: r.supplier,
    notes: r.notes,
    expected_date: r.expected_date || null,
    lines: lineRows(db, r.id).map((l) => ({
      paint_item_id: l.paint_item_id,
      name: l.name,
      unit: l.unit,
      qty: l.qty,
      job_id: l.job_id,
    })),
  };
}

// {supplier, notes?, expectedDate?, lines} -> a draft. `today` is unused (the signature is the
// scaffold's); a draft carries no ordered date.
function create(db, req, body, today = sydneyToday()) { // eslint-disable-line no-unused-vars
  const supplier = text("supplier", body.supplier, SUPPLIER_MAX, { required: true });
  const notes = text("notes", body.notes, NOTES_MAX);
  const expectedDate = dateOrNull("expectedDate", body.expectedDate);
  const lines = linesInput(db, body.lines);
  return db.transaction(() => {
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO paint_orders (supplier, status, notes, expected_date, created_at, updated_at, created_by, updated_by)
         VALUES (?, 'draft', ?, ?, ?, ?, ?, ?)`
      )
      .run(supplier, notes, expectedDate, now, now, userId(req), userId(req));
    const id = Number(info.lastInsertRowid);
    writeLines(db, id, lines);
    syncJobLines(db, req, id, { supplier, expectedDate }, lines);
    const row = orderRow(db, id);
    audit.log(req, { action: "paint_order.create", entityType: "paint_order", entityId: id, after: snapshot(db, row) });
    return present(db, row, { withLines: true });
  })();
}

// A draft only: replaces supplier and lines; notes and expectedDate when sent (absent keeps them).
function update(db, req, id, body) {
  const row = orderOr404(db, id);
  if (row.status !== "draft") throw conflict("Only a draft can be changed");
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  const supplier = text("supplier", body.supplier, SUPPLIER_MAX, { required: true });
  const notes = has("notes") ? text("notes", body.notes, NOTES_MAX) : row.notes;
  const expectedDate = has("expectedDate") ? dateOrNull("expectedDate", body.expectedDate) : row.expected_date || null;
  const lines = linesInput(db, body.lines);
  return db.transaction(() => {
    const before = snapshot(db, row);
    db.prepare(
      "UPDATE paint_orders SET supplier = ?, notes = ?, expected_date = ?, updated_at = ?, updated_by = ? WHERE id = ?"
    ).run(supplier, notes, expectedDate, nowIso(), userId(req), id);
    writeLines(db, id, lines);
    syncJobLines(db, req, id, { supplier, expectedDate }, lines);
    const after = orderRow(db, id);
    audit.log(req, { action: "paint_order.update", entityType: "paint_order", entityId: id, before, after: snapshot(db, after) });
    return present(db, after, { withLines: true });
  })();
}

// The status columns, for paint_order.status audit rows.
function statusFields(r) {
  return {
    status: r.status,
    ordered_date: r.ordered_date || null,
    ordered_by: r.ordered_by == null ? null : r.ordered_by,
    expected_date: r.expected_date || null,
    received_date: r.received_date || null,
    received_by: r.received_by == null ? null : r.received_by,
    delivery_note: r.delivery_note || "",
  };
}

function linkedOrderIds(db, paintOrderId) {
  return db
    .prepare("SELECT order_id FROM paint_order_jobs WHERE paint_order_id = ? ORDER BY job_id")
    .all(paintOrderId)
    .map((r) => r.order_id);
}

// Marking (or undoing) an order with job lines marks those lines ordered, which can make progress
// invoices due, so it also needs orders.mark_ordered (section 3.2).
function assertMayOrder(req, orderIds) {
  if (orderIds.length && !can(req, "orders.mark_ordered")) throw forbidden();
}

// The 409 for a paint order that isn't in the status a move needs: cancelled, or msgs[status].
function wrongStatus(r, msgs) {
  if (r.status === "cancelled") return conflict("This paint order was cancelled");
  return conflict(msgs[r.status] || "Reload the paint order");
}

function orderedOn(r) {
  return `It was already marked ordered${r.ordered_date ? ` on ${dayLabel(r.ordered_date)}` : ""}`;
}

function receivedOn(r) {
  return `It was already marked received${r.received_date ? ` on ${dayLabel(r.received_date)}` : ""}`;
}

const NOT_ORDERED = "It hasn't been marked ordered yet";
const UNDO_RECEIVED_FIRST = "It has been received; undo receiving first";

// {orderedDate?, expectedDate?}: draft -> ordered. Each job line goes to_order -> ordered with the
// order's dates (lib/orders.js runs the all-ordered rule per job).
function ordered(db, req, id, body, today = sydneyToday()) {
  const row = orderOr404(db, id);
  const orderIds = linkedOrderIds(db, id);
  assertMayOrder(req, orderIds);
  if (row.status !== "draft") throw wrongStatus(row, { ordered: orderedOn(row), received: UNDO_RECEIVED_FIRST });
  if (!row.line_count) throw bad("Add at least one line");
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  const orderedDate = dateOrNull("orderedDate", body.orderedDate) || today;
  if (orderedDate > today) throw bad("The ordered date can't be in the future");
  const expectedDate = has("expectedDate") ? dateOrNull("expectedDate", body.expectedDate) : row.expected_date || null;
  if (expectedDate && expectedDate < orderedDate) {
    throw bad(`The expected date can't be before it was ordered (${dayLabel(orderedDate)})`);
  }
  return db.transaction(() => {
    db.prepare(
      `UPDATE paint_orders SET status = 'ordered', ordered_date = ?, ordered_by = ?, expected_date = ?,
         updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(orderedDate, userId(req), expectedDate, nowIso(), userId(req), id);
    for (const orderId of orderIds) {
      orders.updateLine(db, orderId, { status: "ordered", orderedDate, expectedDate }, req, { via: "paint" });
    }
    const after = orderRow(db, id);
    audit.log(req, { action: "paint_order.status", entityType: "paint_order", entityId: id, before: statusFields(row), after: statusFields(after) });
    return present(db, after, { withLines: true });
  })();
}

// ordered -> draft. Each job line goes back to to_order (lib/orders.js clears its ordered date and
// delivery note); the order's ordered date and delivery note go too. A progress invoice that fell
// due stays due ("done once", as any undo).
function undoOrdered(db, req, id) {
  const row = orderOr404(db, id);
  const orderIds = linkedOrderIds(db, id);
  assertMayOrder(req, orderIds);
  if (row.status !== "ordered") throw wrongStatus(row, { draft: NOT_ORDERED, received: UNDO_RECEIVED_FIRST });
  return db.transaction(() => {
    db.prepare(
      `UPDATE paint_orders SET status = 'draft', ordered_date = NULL, ordered_by = NULL, delivery_note = '',
         updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(nowIso(), userId(req), id);
    for (const orderId of orderIds) {
      orders.updateLine(db, orderId, { status: "to_order" }, req, { via: "paint" });
    }
    const after = orderRow(db, id);
    audit.log(req, { action: "paint_order.status", entityType: "paint_order", entityId: id, before: statusFields(row), after: statusFields(after) });
    return present(db, after, { withLines: true });
  })();
}

// {receivedDate?, deliveryNote?}: ordered -> received, each job line with it (lib/orders.js sets
// received_by and runs materials in per job). {undo: true}: received -> ordered, the same way back;
// the delivery note stays, as on an order line.
function received(db, req, id, body, today = sydneyToday()) {
  const row = orderOr404(db, id);
  const orderIds = linkedOrderIds(db, id);
  if (body.undo !== undefined && body.undo !== false) {
    if (body.undo !== true) throw bad("undo must be true or false");
    if (row.status !== "received") throw wrongStatus(row, { draft: NOT_ORDERED, ordered: "It hasn't been received yet" });
    return db.transaction(() => {
      db.prepare(
        "UPDATE paint_orders SET status = 'ordered', received_date = NULL, received_by = NULL, updated_at = ?, updated_by = ? WHERE id = ?"
      ).run(nowIso(), userId(req), id);
      for (const orderId of orderIds) {
        orders.updateLine(db, orderId, { status: "ordered" }, req, { via: "paint" });
      }
      const after = orderRow(db, id);
      audit.log(req, { action: "paint_order.status", entityType: "paint_order", entityId: id, before: statusFields(row), after: statusFields(after) });
      return present(db, after, { withLines: true });
    })();
  }
  if (row.status !== "ordered") throw wrongStatus(row, { draft: "Mark it ordered first", received: receivedOn(row) });
  const receivedDate = dateOrNull("receivedDate", body.receivedDate) || today;
  if (receivedDate > today) throw bad("The received date can't be in the future");
  if (row.ordered_date && receivedDate < row.ordered_date) {
    throw bad(`The received date can't be before it was ordered (${dayLabel(row.ordered_date)})`);
  }
  // Absent keeps the note; null or "" clears it.
  const deliveryNote =
    body.deliveryNote === undefined
      ? row.delivery_note || ""
      : text("The delivery note", body.deliveryNote, DELIVERY_NOTE_MAX);
  return db.transaction(() => {
    db.prepare(
      `UPDATE paint_orders SET status = 'received', received_date = ?, received_by = ?, delivery_note = ?,
         updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(receivedDate, userId(req), deliveryNote, nowIso(), userId(req), id);
    for (const orderId of orderIds) {
      orders.updateLine(db, orderId, { status: "received", receivedDate }, req, { via: "paint" });
    }
    const after = orderRow(db, id);
    audit.log(req, { action: "paint_order.status", entityType: "paint_order", entityId: id, before: statusFields(row), after: statusFields(after) });
    // A new non-empty delivery note tells Ordering, as an order line's does (section 15.20).
    if (deliveryNote && deliveryNote !== (row.delivery_note || "")) {
      notify.toKey(
        db,
        "orders.mark_ordered",
        {
          kind: "paint.delivery_note",
          title: `Delivery note: Paint order ${id}`,
          body: `${row.supplier}: ${orders.cutNote(deliveryNote)}`,
          link: `/paint.html?id=${id}`,
          entityType: "paint_order",
          entityId: id,
        },
        { exceptUserId: userId(req) }
      );
    }
    return present(db, after, { withLines: true });
  })();
}

// A draft only: cancelled, with its job lines (their links stay, so each cancelled line still
// says which paint order it was).
function cancel(db, req, id) {
  const row = orderOr404(db, id);
  if (row.status !== "draft") {
    if (row.status === "cancelled") throw conflict("Already cancelled");
    throw conflict("Only a draft can be cancelled");
  }
  const orderIds = linkedOrderIds(db, id);
  return db.transaction(() => {
    db.prepare("UPDATE paint_orders SET status = 'cancelled', updated_at = ?, updated_by = ? WHERE id = ?").run(
      nowIso(),
      userId(req),
      id
    );
    for (const orderId of orderIds) {
      orders.cancelLine(db, orderId, req, { via: "paint" });
    }
    audit.log(req, {
      action: "paint_order.cancel",
      entityType: "paint_order",
      entityId: id,
      before: { status: row.status },
      after: { status: "cancelled", order_ids: orderIds },
    });
    return present(db, orderRow(db, id), { withLines: true });
  })();
}

// --------------------------------------------------------------- settings ---

function getSettings(db) {
  return { litresPerKg: factor(db) };
}

// {litresPerKg}: a number from 0.1 to 5 (audited by lib/settings.js as settings.update).
function saveSettings(db, req, body) {
  const v = body.litresPerKg;
  if (typeof v !== "number" || !Number.isFinite(v) || v < FACTOR_MIN || v > FACTOR_MAX) {
    throw bad(`litresPerKg must be a number from ${FACTOR_MIN} to ${FACTOR_MAX}`);
  }
  db.transaction(() => settings.set(db, SETTING, String(v), req))();
  return getSettings(db);
}

module.exports = {
  items,
  createItem,
  updateItem,
  reorderItems,
  list,
  create,
  get,
  update,
  ordered,
  undoOrdered,
  received,
  cancel,
  getSettings,
  saveSettings,
};
