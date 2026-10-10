// Supplier order lines per job, and the job's materials dates. See
// docs/plans/m3-contracts.md section 2. markMaterialsOrdered is the scaffold's
// (the Materials ordered button calls it) and keeps its signature and return
// values; the rest is Wave 1 B.
const audit = require("./audit");
const invoices = require("./invoices");
const notify = require("./notify");
const { bad, notFound, conflict, forbidden, can } = require("./httperror");
const { sydneyToday, addDays } = require("./time");

const STATUSES = ["to_order", "ordered", "received", "cancelled"];

// Set jobs.materials_ordered_date (the "done once" flag) and make the progress
// invoice due. Returns true if it was set now, false if it was already set.
// No job -> 404; invalid date -> 400. Moved from routes/jobs.js (M2).
// invoices.onMaterialsOrdered never throws: its failure is logged and the date
// is still saved (contracts section 11.7).
function markMaterialsOrdered(db, jobId, req, date = sydneyToday()) {
  if (!db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId)) throw notFound();
  if (!invoices.validDate(date)) throw bad("date must be a valid YYYY-MM-DD date");
  return db.transaction(() => {
    const job = db.prepare("SELECT materials_ordered_date FROM jobs WHERE id = ?").get(jobId);
    if (job.materials_ordered_date) return false;
    db.prepare("UPDATE jobs SET materials_ordered_date = ?, updated_at = ? WHERE id = ?").run(
      date,
      new Date().toISOString(),
      jobId
    );
    audit.log(req, {
      action: "job.update",
      entityType: "job",
      entityId: jobId,
      before: { materials_ordered_date: null },
      after: { materials_ordered_date: date },
    });
    invoices.onMaterialsOrdered(db, jobId, date, req);
    return true;
  })();
}

// --- Wave 1 B ---------------------------------------------------------------

const SUPPLIER_MAX = 200;
const DESCRIPTION_MAX = 500;
const NOTES_MAX = 2000;

const SELECT_LINE = `SELECT o.*, u.display_name AS created_by_name
  FROM orders o LEFT JOIN users u ON u.id = o.created_by`;

function nowIso() {
  return new Date().toISOString();
}

function loadLine(db, orderId) {
  return db.prepare(`${SELECT_LINE} WHERE o.id = ?`).get(orderId);
}

// The order object. `today` is the Sydney date used for `overdue`.
function present(row, today = sydneyToday()) {
  return {
    id: row.id,
    jobId: row.job_id,
    supplier: row.supplier,
    description: row.description,
    status: row.status,
    orderedDate: row.ordered_date || null,
    expectedDate: row.expected_date || null,
    receivedDate: row.received_date || null,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by == null ? null : row.created_by,
    createdByName: row.created_by_name || null,
    overdue:
      (row.status === "to_order" || row.status === "ordered") &&
      !!row.expected_date &&
      row.expected_date < today,
  };
}

function jobState(db, jobId) {
  const j = db
    .prepare("SELECT id, materials_ordered_date, materials_in_date FROM jobs WHERE id = ?")
    .get(jobId);
  if (!j) throw notFound();
  return {
    id: j.id,
    materialsOrderedDate: j.materials_ordered_date || null,
    materialsInDate: j.materials_in_date || null,
  };
}

function requireJob(db, jobId) {
  const job = db.prepare("SELECT id, name FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw notFound();
  return job;
}

function listForJob(db, jobId, { includeCancelled = false } = {}) {
  requireJob(db, jobId);
  const today = sydneyToday();
  return db
    .prepare(
      `${SELECT_LINE} WHERE o.job_id = ? ${includeCancelled ? "" : "AND o.status <> 'cancelled'"} ORDER BY o.id`
    )
    .all(jobId)
    .map((r) => present(r, today));
}

function list(db, { status, supplier, jobId } = {}) {
  const st = status === undefined || status === null || status === "" ? "open" : status;
  if (st !== "open" && st !== "all" && !STATUSES.includes(st)) {
    throw bad(`status must be one of open, all, ${STATUSES.join(", ")}`);
  }
  const where = [];
  const params = [];
  if (st === "open") where.push("o.status IN ('to_order','ordered')");
  else if (st !== "all") {
    where.push("o.status = ?");
    params.push(st);
  }
  if (supplier !== undefined && supplier !== null && String(supplier).trim() !== "") {
    where.push("lower(trim(o.supplier)) = ?");
    params.push(String(supplier).trim().toLowerCase());
  }
  if (jobId !== undefined && jobId !== null && jobId !== "") {
    const id = Number(jobId);
    if (!Number.isInteger(id) || id <= 0) throw bad("jobId must be a positive integer");
    where.push("o.job_id = ?");
    params.push(id);
  } else {
    where.push("j.archived = 0");
  }
  const today = sydneyToday();
  return db
    .prepare(
      `SELECT o.*, u.display_name AS created_by_name, j.name AS job_name, j.stage AS job_stage
       FROM orders o
       JOIN jobs j ON j.id = o.job_id
       LEFT JOIN users u ON u.id = o.created_by
       WHERE ${where.join(" AND ")}
       ORDER BY (o.expected_date IS NULL), o.expected_date, j.name COLLATE NOCASE, o.id`
    )
    .all(...params)
    .map((r) => ({ ...present(r, today), jobName: r.job_name, jobStage: r.job_stage }));
}

// Up to 50 distinct supplier names (by lower(trim())), the most recent
// spelling, most-used first. `q` is a case-insensitive prefix.
function suppliers(db, q) {
  const prefix = typeof q === "string" ? q.trim().toLowerCase() : "";
  const byKey = new Map();
  for (const { id, supplier } of db.prepare("SELECT id, supplier FROM orders ORDER BY id").all()) {
    const name = String(supplier).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const e = byKey.get(key) || { count: 0, lastId: 0, name };
    e.count += 1;
    e.lastId = id;
    e.name = name; // later rows win: the most recent spelling
    byKey.set(key, e);
  }
  return [...byKey.entries()]
    .filter(([key]) => !prefix || key.startsWith(prefix))
    .sort((a, b) => b[1].count - a[1].count || b[1].lastId - a[1].lastId)
    .slice(0, 50)
    .map(([, e]) => e.name);
}

// --- validation -------------------------------------------------------------

function textField(label, v, max, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw bad(`${label} is required`);
    return "";
  }
  if (typeof v !== "string") throw bad(`${label} must be a string`);
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

// --- the all-ordered and all-in rules ---------------------------------------

// At least one non-cancelled line, and none still to order.
function allOrdered(db, jobId) {
  const c = db
    .prepare(
      `SELECT COUNT(*) AS live, SUM(CASE WHEN status = 'to_order' THEN 1 ELSE 0 END) AS open
       FROM orders WHERE job_id = ? AND status <> 'cancelled'`
    )
    .get(jobId);
  return c.live > 0 && !(c.open > 0);
}

// Sets or clears jobs.materials_in_date. Returns 'set', 'cleared' or null.
function refreshMaterialsIn(db, jobId, req) {
  return db.transaction(() => {
    const job = db.prepare("SELECT id, name, materials_in_date FROM jobs WHERE id = ?").get(jobId);
    if (!job) throw notFound();
    const live = db
      .prepare("SELECT status, received_date FROM orders WHERE job_id = ? AND status <> 'cancelled'")
      .all(jobId);
    const allIn = live.length > 0 && live.every((l) => l.status === "received");
    if (allIn && !job.materials_in_date) {
      const latest = live.map((l) => l.received_date).filter(Boolean).sort().pop() || sydneyToday();
      db.prepare("UPDATE jobs SET materials_in_date = ?, updated_at = ? WHERE id = ?").run(latest, nowIso(), jobId);
      audit.log(req, {
        action: "job.update",
        entityType: "job",
        entityId: jobId,
        before: { materials_in_date: null },
        after: { materials_in_date: latest },
      });
      notify.toKey(
        db,
        "scheduling.view",
        {
          kind: "materials.in",
          title: `Materials in: ${job.name}`,
          link: `/job.html?id=${jobId}#orders`,
          entityType: "job",
          entityId: jobId,
        },
        { exceptUserId: req && req.user ? req.user.id : null }
      );
      return "set";
    }
    if (!allIn && job.materials_in_date) {
      db.prepare("UPDATE jobs SET materials_in_date = NULL, updated_at = ? WHERE id = ?").run(nowIso(), jobId);
      audit.log(req, {
        action: "job.update",
        entityType: "job",
        entityId: jobId,
        before: { materials_in_date: job.materials_in_date },
        after: { materials_in_date: null },
      });
      return "cleared";
    }
    return null;
  })();
}

// --- writes -----------------------------------------------------------------

function createLine(db, jobId, { supplier, description, expectedDate, notes } = {}, req) {
  requireJob(db, jobId);
  const sup = textField("supplier", supplier, SUPPLIER_MAX, { required: true });
  const desc = textField("description", description, DESCRIPTION_MAX);
  const note = textField("notes", notes, NOTES_MAX);
  const expected = dateOrNull("expectedDate", expectedDate);
  return db.transaction(() => {
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO orders (job_id, supplier, description, status, expected_date, notes, created_at, updated_at, created_by)
         VALUES (?, ?, ?, 'to_order', ?, ?, ?, ?, ?)`
      )
      .run(jobId, sup, desc, expected, note, now, now, req && req.user ? req.user.id : null);
    const id = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "order.create",
      entityType: "order",
      entityId: id,
      after: { job_id: jobId, supplier: sup, description: desc, status: "to_order", expected_date: expected, notes: note },
    });
    refreshMaterialsIn(db, jobId, req);
    return { order: present(loadLine(db, id)), job: jobState(db, jobId) };
  })();
}

function updateLine(db, orderId, patch, req) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("JSON body required");
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined;
  const line = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!line) throw notFound();

  // Validate the shape of everything sent (400).
  if (has("status")) {
    if (patch.status === "cancelled") throw bad("Use cancel");
    if (!STATUSES.includes(patch.status)) throw bad(`status must be one of ${STATUSES.join(", ")}`);
  }
  const text = {};
  if (has("supplier")) text.supplier = textField("supplier", patch.supplier, SUPPLIER_MAX, { required: true });
  if (has("description")) text.description = textField("description", patch.description, DESCRIPTION_MAX);
  if (has("notes")) text.notes = textField("notes", patch.notes, NOTES_MAX);
  if (has("expectedDate")) text.expected_date = dateOrNull("expectedDate", patch.expectedDate);
  const orderedDateIn = has("orderedDate") ? dateOrNull("orderedDate", patch.orderedDate) : undefined;
  const receivedDateIn = has("receivedDate") ? dateOrNull("receivedDate", patch.receivedDate) : undefined;

  if (line.status === "cancelled") throw conflict("Cancelled lines can't be changed");

  // The permission checks live here, so no caller can bypass them (plan Q1).
  const changes = {}; // column -> new value
  for (const [col, v] of Object.entries(text)) {
    if (v !== line[col]) changes[col] = v;
  }
  if (Object.keys(changes).length && !can(req, "orders.edit")) throw forbidden();

  const statusChange = has("status") && patch.status !== line.status ? patch.status : null;
  let transition = null;
  if (statusChange) {
    const key = `${line.status}>${statusChange}`;
    if (key === "to_order>received") throw conflict("Mark it ordered first");
    const needs = {
      "to_order>ordered": "orders.mark_ordered",
      "ordered>received": "orders.edit",
      "ordered>to_order": "orders.mark_ordered",
      "received>ordered": "orders.edit",
    }[key];
    if (!needs) throw conflict(`A line can't go from ${line.status} to ${statusChange}`);
    if (!can(req, needs)) throw forbidden();
    transition = key;
    const today = sydneyToday();
    if (key === "to_order>ordered") changes.ordered_date = orderedDateIn || today;
    else if (key === "ordered>received") changes.received_date = receivedDateIn || today;
    else if (key === "ordered>to_order") changes.ordered_date = null;
    else changes.received_date = null; // received>ordered
    changes.status = statusChange;
  } else {
    // A date edit without a status change.
    if (orderedDateIn !== undefined) {
      if (orderedDateIn === null) throw bad("orderedDate must be a valid YYYY-MM-DD date");
      if (line.status !== "ordered" && line.status !== "received") throw conflict("The line hasn't been ordered yet");
      if (!can(req, "orders.mark_ordered")) throw forbidden();
      if (orderedDateIn !== line.ordered_date) changes.ordered_date = orderedDateIn;
    }
    if (receivedDateIn !== undefined) {
      if (receivedDateIn === null) throw bad("receivedDate must be a valid YYYY-MM-DD date");
      if (line.status !== "received") throw conflict("The line hasn't been received yet");
      if (!can(req, "orders.edit")) throw forbidden();
      if (receivedDateIn !== line.received_date) changes.received_date = receivedDateIn;
    }
  }

  return db.transaction(() => {
    const cols = Object.keys(changes);
    if (cols.length) {
      db.prepare(`UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
        ...cols.map((c) => changes[c]),
        nowIso(),
        orderId
      );
      // order.update: text and date fields; a status change's own dates go in order.status.
      const plain = cols.filter((c) => c !== "status" && !(transition && (c === "ordered_date" || c === "received_date")));
      if (plain.length) {
        const before = {};
        const after = {};
        for (const c of plain) {
          before[c] = line[c];
          after[c] = changes[c];
        }
        audit.log(req, { action: "order.update", entityType: "order", entityId: orderId, before, after });
      }
      if (transition) {
        audit.log(req, {
          action: "order.status",
          entityType: "order",
          entityId: orderId,
          before: { status: line.status, ordered_date: line.ordered_date, received_date: line.received_date },
          after: {
            status: changes.status,
            ordered_date: "ordered_date" in changes ? changes.ordered_date : line.ordered_date,
            received_date: "received_date" in changes ? changes.received_date : line.received_date,
          },
        });
      }
    }
    // The all-ordered rule: the last to_order line has just been ordered.
    if (transition === "to_order>ordered" && allOrdered(db, line.job_id)) {
      markMaterialsOrdered(db, line.job_id, req, changes.ordered_date);
    }
    if (cols.length) refreshMaterialsIn(db, line.job_id, req);
    return { order: present(loadLine(db, orderId)), job: jobState(db, line.job_id) };
  })();
}

// Note (contracts section 11.8): a cancel by an orders.mark_ordered holder
// fires the all-ordered rule; a cancel by anyone else never does.
function cancelLine(db, orderId, req) {
  if (!can(req, "orders.edit")) throw forbidden();
  const line = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!line) throw notFound();
  if (line.status === "cancelled") throw conflict("Already cancelled");
  return db.transaction(() => {
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), orderId);
    audit.log(req, {
      action: "order.cancel",
      entityType: "order",
      entityId: orderId,
      before: { status: line.status },
      after: { status: "cancelled" },
    });
    if (can(req, "orders.mark_ordered") && allOrdered(db, line.job_id)) {
      markMaterialsOrdered(db, line.job_id, req);
    }
    refreshMaterialsIn(db, line.job_id, req);
    return { order: present(loadLine(db, orderId)), job: jobState(db, line.job_id) };
  })();
}

// {materials, materialsIn} for the Scheduling page; `from` is today.
function upcoming(db, from, to) {
  const materials = db
    .prepare(
      `SELECT o.id, o.job_id, j.name AS job_name, o.supplier, o.description, o.expected_date
       FROM orders o JOIN jobs j ON j.id = o.job_id
       WHERE o.status = 'ordered' AND o.expected_date IS NOT NULL AND o.expected_date <= ? AND j.archived = 0
       ORDER BY o.expected_date, j.name COLLATE NOCASE, o.id`
    )
    .all(to)
    .map((r) => ({
      id: r.id,
      jobId: r.job_id,
      jobName: r.job_name,
      supplier: r.supplier,
      description: r.description,
      expectedDate: r.expected_date,
      overdue: r.expected_date < from,
    }));
  const materialsIn = db
    .prepare(
      `SELECT id, name, materials_in_date FROM jobs
       WHERE materials_in_date IS NOT NULL AND materials_in_date >= ?
         AND stage NOT IN ('complete','invoiced','lost','archived')
       ORDER BY materials_in_date DESC, name COLLATE NOCASE, id`
    )
    .all(addDays(from, -13))
    .map((r) => ({ jobId: r.id, jobName: r.name, materialsInDate: r.materials_in_date }));
  return { materials, materialsIn };
}

module.exports = {
  STATUSES,
  markMaterialsOrdered,
  present,
  jobState,
  listForJob,
  list,
  suppliers,
  createLine,
  updateLine,
  cancelLine,
  refreshMaterialsIn,
  upcoming,
};
