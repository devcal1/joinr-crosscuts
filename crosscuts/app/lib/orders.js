// Supplier order lines per job, and the job's materials dates. See
// docs/plans/m3-contracts.md section 2, as changed by docs/plans/m10-contracts.md section 4
// (receiving deliveries: orders.receive, who received and last changed a line, the delivery note,
// the Deliveries list). markMaterialsOrdered is the scaffold's (the Materials ordered button calls
// it) and keeps its signature and return values. M11 (docs/plans/m11-contracts.md section 5): lines
// that are a job's drawers or a paint order's job line carry kind/drawers/paintOrderId, and plain
// calls (no opts.via) are refused the changes that belong to the Drawer order or paint order pages.
const audit = require("./audit");
const invoices = require("./invoices");
const notify = require("./notify");
const links = require("./orderlinks");
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
const DELIVERY_NOTE_MAX = 500; // m10-contracts.md section 4.2
const NOTE_BODY_CUT = 200; // the delivery-note notification's body (section 4.3)

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The names of who created, received and last changed a line (M10 section 4.1).
const LINE_COLUMNS = `o.*, u.display_name AS created_by_name,
  ur.display_name AS received_by_name, uu.display_name AS updated_by_name,
  ${links.COLUMNS_SQL}`;
const LINE_USERS = `LEFT JOIN users u ON u.id = o.created_by
  LEFT JOIN users ur ON ur.id = o.received_by
  LEFT JOIN users uu ON uu.id = o.updated_by
  ${links.JOIN_SQL}`;
const SELECT_LINE = `SELECT ${LINE_COLUMNS} FROM orders o ${LINE_USERS}`;

function nowIso() {
  return new Date().toISOString();
}

// "2026-10-03" -> "3 Oct 2026".
function dayLabel(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function userId(req) {
  return req && req.user && req.user.id != null ? req.user.id : null;
}

function loadLine(db, orderId) {
  return db.prepare(`${SELECT_LINE} WHERE o.id = ?`).get(orderId);
}

function person(id, name) {
  return id == null ? null : { id, name: name || null };
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
    receivedBy: person(row.received_by, row.received_by_name),
    updatedBy: person(row.updated_by, row.updated_by_name),
    deliveryNote: row.delivery_note || "",
    deliveryNoteAt: row.delivery_note_at || null,
    overdue:
      (row.status === "to_order" || row.status === "ordered") &&
      !!row.expected_date &&
      row.expected_date < today,
    // M11 section 4.2: {kind, drawers, paintOrderId}.
    ...links.presentLink(row),
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
  return listRows(
    db,
    where.join(" AND "),
    params,
    "(o.expected_date IS NULL), o.expected_date, j.name COLLATE NOCASE, o.id",
    sydneyToday()
  );
}

// list() rows: the order object plus jobName and jobStage.
function listRows(db, where, params, orderBy, today) {
  return db
    .prepare(
      `SELECT ${LINE_COLUMNS}, j.name AS job_name, j.stage AS job_stage
       FROM orders o
       JOIN jobs j ON j.id = o.job_id
       ${LINE_USERS}
       WHERE ${where}
       ORDER BY ${orderBy}`
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

// The delivery note (M10 section 4.2): a string, trimmed, at most 500; "" (or null) clears it.
function deliveryNoteField(v) {
  if (v === null) return "";
  if (typeof v !== "string") throw bad("The delivery note must be text");
  const t = v.trim();
  if (t.length > DELIVERY_NOTE_MAX) throw bad(`The delivery note must be ${DELIVERY_NOTE_MAX} characters or fewer`);
  return t;
}

// The note cut for a notification body: at most NOTE_BODY_CUT characters, "…" when cut.
function cutNote(t) {
  return t.length > NOTE_BODY_CUT ? `${t.slice(0, NOTE_BODY_CUT - 1)}…` : t;
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
      // One materials.in notification per job: toggling lines off and on again
      // re-sets the date but does not tell anyone a second time. M10 (Decision 4): it goes to
      // Scheduling and Ordering, each user once (admin holds both keys), except the actor.
      const already = db
        .prepare("SELECT 1 AS x FROM notifications WHERE kind = ? AND entity_type = ? AND entity_id = ? LIMIT 1")
        .get("materials.in", "job", String(jobId));
      if (!already) {
        notify.toUsers(
          db,
          [...notify.usersWithKey(db, "scheduling.view"), ...notify.usersWithKey(db, "orders.mark_ordered")],
          {
            kind: "materials.in",
            title: `Materials in: ${job.name}`,
            link: `/job.html?id=${jobId}#orders`,
            entityType: "job",
            entityId: jobId,
          },
          { exceptUserId: userId(req) }
        );
      }
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

// opts is accepted for symmetry with updateLine/cancelLine (M11 section 5.2); a plain call and a
// call from lib/drawers.js or lib/paint.js behave the same (they write their link row afterwards).
function createLine(db, jobId, { supplier, description, expectedDate, notes } = {}, req, opts = {}) { // eslint-disable-line no-unused-vars
  requireJob(db, jobId);
  const sup = textField("supplier", supplier, SUPPLIER_MAX, { required: true });
  const desc = textField("description", description, DESCRIPTION_MAX);
  const note = textField("notes", notes, NOTES_MAX);
  const expected = dateOrNull("expectedDate", expectedDate);
  return db.transaction(() => {
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO orders (job_id, supplier, description, status, expected_date, notes, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, 'to_order', ?, ?, ?, ?, ?, ?)`
      )
      .run(jobId, sup, desc, expected, note, now, now, userId(req), userId(req));
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

// opts.via: "drawers" | "paint" | undefined (M11 section 5.2). Only lib/drawers.js and lib/paint.js
// pass it; the routes never do.
function updateLine(db, orderId, patch, req, opts = {}) {
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
  const todayStr = sydneyToday();
  if (orderedDateIn && orderedDateIn > todayStr) throw bad("The ordered date can't be in the future");
  if (receivedDateIn && receivedDateIn > todayStr) throw bad("The received date can't be in the future");

  const noteIn = has("deliveryNote") ? deliveryNoteField(patch.deliveryNote) : undefined;

  if (line.status === "cancelled") throw conflict("Cancelled lines can't be changed");

  // M11 section 5.2: a plain call can't change what the Drawer order or a paint order owns.
  const link = links.linkOf(db, orderId);
  if (link && !opts.via) {
    if (link.kind === "paint") throw conflict(`This line is part of paint order ${link.paintOrderId}; change it there`);
    if (link.kind === "drawers") {
      if (has("status") && line.status === "to_order" && patch.status === "ordered") {
        throw conflict("Drawer lines are ordered from the Drawer order page");
      }
      // Contracts section 15.17: a line on a placed drawer order goes back only through Undo order
      // on the Drawer order page (lib/drawers.js, which calls with opts.via).
      if (has("status") && line.status === "ordered" && patch.status === "to_order" && link.drawerOrderId != null) {
        throw conflict("These drawers are on a placed drawer order. Use Undo order on the Drawer order page.");
      }
      if (("supplier" in text && text.supplier !== line.supplier) || ("description" in text && text.description !== line.description)) {
        throw conflict("The drawer grid sets this line; change the grid");
      }
    }
  }

  // The permission checks live here, so no caller can bypass them (plan Q1). The whole PATCH is
  // checked (every key it needs, every rule) before anything is written (M10 section 4.2).
  const changes = {}; // column -> new value
  for (const [col, v] of Object.entries(text)) {
    if (v !== line[col]) changes[col] = v;
  }
  // A call from lib/drawers.js or lib/paint.js has had its own access checked (M11 section 5.2).
  if (Object.keys(changes).length && !opts.via && !can(req, "orders.edit")) throw forbidden();

  // Marking a line ordered or received a second time is refused, not turned into a date edit (a
  // second person pressing Received on a line someone already received; M10 · 4.3, review P1).
  // A to_order line sent status to_order stays as it was (nothing about it changes).
  if (has("status") && patch.status === line.status && (line.status === "ordered" || line.status === "received")) {
    const on = line.status === "ordered" ? line.ordered_date : line.received_date;
    throw conflict(`It was already marked ${line.status}${on ? ` on ${dayLabel(on)}` : ""}`);
  }
  const statusChange = has("status") && patch.status !== line.status ? patch.status : null;
  let transition = null;
  if (statusChange) {
    const key = `${line.status}>${statusChange}`;
    if (key === "to_order>received") throw conflict("Mark it ordered first");
    const needs = {
      "to_order>ordered": "orders.mark_ordered",
      "ordered>received": "orders.receive",
      "ordered>to_order": "orders.mark_ordered",
      "received>ordered": "orders.receive",
    }[key];
    if (!needs) throw conflict(`A line can't go from ${line.status} to ${statusChange}`);
    if (!can(req, needs)) throw forbidden();
    transition = key;
    if (key === "to_order>ordered") changes.ordered_date = orderedDateIn || todayStr;
    else if (key === "ordered>received") {
      changes.received_date = receivedDateIn || todayStr;
      changes.received_by = userId(req);
    } else if (key === "ordered>to_order") {
      // Back to To order: the ordered date goes, and so does any delivery note (M10 · 4.3, B2).
      changes.ordered_date = null;
      if (line.delivery_note || line.delivery_note_at) {
        changes.delivery_note = "";
        changes.delivery_note_at = null;
      }
    } else {
      // received>ordered: the delivery note stays.
      changes.received_date = null;
      changes.received_by = null;
    }
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
      if (!can(req, "orders.receive")) throw forbidden();
      if (receivedDateIn !== line.received_date) changes.received_date = receivedDateIn;
    }
  }

  // The two dates stay in order (as M9's paid date and issue date). Each rule applies only when its
  // date changes in this PATCH, so an unchanged date sent along with something else isn't refused.
  // A received date being set (by the move to received, or alone) can't be before the line was
  // ordered; an ordered date moved on a received line can't be after it was received (M10 · 4.3).
  const orderedFinal = "ordered_date" in changes ? changes.ordered_date : line.ordered_date;
  const receivedFinal = "received_date" in changes ? changes.received_date : line.received_date;
  if (orderedFinal && receivedFinal && receivedFinal < orderedFinal) {
    if (changes.received_date) {
      throw bad(`The received date can't be before it was ordered (${dayLabel(orderedFinal)})`);
    }
    if (changes.ordered_date) {
      throw bad(`The ordered date can't be after it was received (${dayLabel(receivedFinal)})`);
    }
  }

  // The delivery note: orders.receive to change it. A non-empty note only on a line that is (after
  // this PATCH) ordered or received; "" clears it on any line that isn't cancelled (M10 · 4.3, B2).
  // Moving a line back to To order clears it already (above), so a "" sent with that move is moot.
  const noteBefore = line.delivery_note || "";
  const noteChanged = noteIn !== undefined && noteIn !== noteBefore && transition !== "ordered>to_order";
  if (noteChanged && !can(req, "orders.receive")) throw forbidden();
  if (noteIn) {
    const statusAfter = changes.status || line.status;
    if (statusAfter !== "ordered" && statusAfter !== "received") {
      throw conflict("Only an ordered or received line takes a delivery note");
    }
  }
  const ts = nowIso();
  if (noteChanged) {
    changes.delivery_note = noteIn;
    changes.delivery_note_at = ts;
  }

  return db.transaction(() => {
    const cols = Object.keys(changes);
    if (cols.length) {
      db.prepare(
        `UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`
      ).run(...cols.map((c) => changes[c]), ts, userId(req), orderId);
      // order.update: text and date fields and the delivery note; a status change's own dates and
      // received_by go in order.status.
      const plain = cols.filter(
        (c) =>
          c !== "status" &&
          c !== "received_by" &&
          c !== "delivery_note_at" &&
          !(transition && (c === "ordered_date" || c === "received_date")) &&
          !(transition === "ordered>to_order" && c === "delivery_note")
      );
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
        const was = (c) => (c in changes ? changes[c] : line[c]);
        const before = {
          status: line.status,
          ordered_date: line.ordered_date,
          received_date: line.received_date,
          received_by: line.received_by,
        };
        const after = {
          status: changes.status,
          ordered_date: was("ordered_date"),
          received_date: was("received_date"),
          received_by: was("received_by"),
        };
        // Back to To order with a note: the cleared note is part of the move (B2).
        if (transition === "ordered>to_order" && line.delivery_note) {
          before.delivery_note = line.delivery_note;
          after.delivery_note = changes.delivery_note;
        }
        audit.log(req, { action: "order.status", entityType: "order", entityId: orderId, before, after });
      }
    }
    // M11 section 5.2: a drawer line going back to To order leaves its placed drawer order (whose
    // frozen grid keeps it as history).
    if (transition === "ordered>to_order" && link && link.kind === "drawers") {
      db.prepare("UPDATE order_drawers SET drawer_order_id = NULL WHERE order_id = ?").run(orderId);
    }
    // The all-ordered rule: the last to_order line has just been ordered.
    if (transition === "to_order>ordered" && allOrdered(db, line.job_id)) {
      markMaterialsOrdered(db, line.job_id, req, changes.ordered_date);
    }
    // A new non-empty delivery note tells Ordering straight away, every time (M10 section 4.3).
    if (noteChanged && noteIn) {
      const job = db.prepare("SELECT name FROM jobs WHERE id = ?").get(line.job_id);
      notify.toKey(
        db,
        "orders.mark_ordered",
        {
          kind: "order.delivery_note",
          title: `Delivery note: ${job ? job.name : ""}`,
          body: `${"supplier" in changes ? changes.supplier : line.supplier}: ${cutNote(noteIn)}`,
          link: `/job.html?id=${line.job_id}#orders`,
          entityType: "order",
          entityId: orderId,
        },
        { exceptUserId: userId(req) }
      );
    }
    if (cols.length) refreshMaterialsIn(db, line.job_id, req);
    return { order: present(loadLine(db, orderId)), job: jobState(db, line.job_id) };
  })();
}

// Note (contracts section 11.8): a cancel by an orders.mark_ordered holder
// fires the all-ordered rule; a cancel by anyone else never does.
// opts.via as updateLine (M11 section 5.2): a paint order cancels its own job lines.
function cancelLine(db, orderId, req, opts = {}) {
  if (!opts.via && !can(req, "orders.edit")) throw forbidden();
  const line = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!line) throw notFound();
  if (line.status === "cancelled") throw conflict("Already cancelled");
  const link = links.linkOf(db, orderId);
  if (link && link.kind === "paint" && !opts.via) {
    throw conflict(`This line is part of paint order ${link.paintOrderId}; change it there`);
  }
  return db.transaction(() => {
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ?, updated_by = ? WHERE id = ?").run(
      nowIso(),
      userId(req),
      orderId
    );
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

// M10 (docs/plans/m10-contracts.md section 4.4): every ordered line on a job that isn't archived,
// in five groups by expected date (overdue, today, the next 7 days, later, no date yet); the lines
// received in the last 14 days (today included), newest first; and the overdue and today counts.
// M11 (section 5.2 and 9): paint order job lines are left out (they're received with their paint
// order), and `stock` lists the stock groups, paint orders and drawer stock rows waiting; their
// today and overdue counts are added in.
function deliveries(db, today = sydneyToday()) {
  const weekEnd = addDays(today, 7);
  const groups = [
    { id: "overdue", label: "Overdue", lines: [] },
    { id: "today", label: "Today", lines: [] },
    { id: "week", label: "Next 7 days", lines: [] },
    { id: "later", label: "Later", lines: [] },
    { id: "nodate", label: "No date yet", lines: [] },
  ];
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  const ordered = listRows(
    db,
    "o.status = 'ordered' AND j.archived = 0 AND poj.paint_order_id IS NULL",
    [],
    "o.expected_date, j.name COLLATE NOCASE, o.id",
    today
  );
  for (const line of ordered) {
    const d = line.expectedDate;
    const id = !d ? "nodate" : d < today ? "overdue" : d === today ? "today" : d <= weekEnd ? "week" : "later";
    byId[id].lines.push(line);
  }
  const recent = listRows(
    db,
    "o.status = 'received' AND o.received_date >= ? AND j.archived = 0 AND poj.paint_order_id IS NULL",
    [addDays(today, -13)],
    "o.received_date DESC, o.id DESC",
    today
  );
  const stock = require("./stockdeliveries").stockDeliveries(db, today);
  return {
    date: today,
    groups,
    recent,
    stock,
    counts: {
      overdue: byId.overdue.lines.length + stock.counts.overdue,
      today: byId.today.lines.length + stock.counts.today,
    },
  };
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
  deliveries,
  cancelLine,
  refreshMaterialsIn,
  upcoming,
  cutNote,
};
