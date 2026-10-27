// Board and edge tape reservations (0.2.6, docs/plans/m27-contracts.md section 5).
//
// When a job's order list reaches Ordering, the order manager (orders.mark_ordered) may reserve a
// boards or edging line, or part of it, from the workshop's stock instead of ordering it new: pick
// the stock item and a quantity no more than its free amount (on hand - reserved). "Nothing left to
// order" (covers) makes the line count as ordered for the all-ordered rule (lib/orders.js); else the
// rest is still ordered as usual. The workshop manager (stock.count) gets a bell, labels the stock for
// the job and ticks Reserved (confirmed). At the end of a shift they record which jobs have been cut
// 100%: every confirmed reservation of those jobs is cut, and its quantity comes off on hand. Either
// of them may release a reservation before it is cut (back to free stock). Everything is audited.
//
// Every function takes db first; nothing here requires ../db.
const audit = require("./audit");
const notify = require("./notify");
const boards = require("./boards");
const { bad, notFound, conflict, can } = require("./httperror");
const { sydneyToday, sydneyMonday } = require("./time");

const SECTIONS = ["boards", "edging"];
const LIVE = ["reserved", "confirmed"];
const QTY_MAX = 9999;
const IDS_MAX = 100;

const nowIso = () => new Date().toISOString();
const userId = (req) => (req && req.user && req.user.id != null ? req.user.id : null);

function boardName(b) {
  return [b.thickness != null ? `${b.thickness} mm` : "", b.name, b.finish, b.kind === "edge" && b.width != null ? `${b.width} mm wide` : "", b.colour]
    .filter(Boolean)
    .join(" ");
}

const unitOf = (b, n) => (b.kind === "edge" ? (n === 1 ? "roll" : "rolls") : n === 1 ? "sheet" : "sheets");

function fmtQty(q) {
  return String(Math.round(q * 2) / 2);
}

const SELECT = `SELECT r.*, b.name AS b_name, b.kind AS b_kind, b.thickness AS b_thickness, b.finish AS b_finish,
       b.width AS b_width, b.colour AS b_colour, j.name AS job_name,
       ur.display_name AS reserved_by_name, uc.display_name AS confirmed_by_name,
       ux.display_name AS cut_by_name, ul.display_name AS released_by_name,
       m.name AS material_name, m.section AS material_section
  FROM stock_reservations r
  JOIN boards b ON b.id = r.board_id
  JOIN jobs j ON j.id = r.job_id
  LEFT JOIN job_materials m ON m.id = r.material_id
  LEFT JOIN users ur ON ur.id = r.reserved_by
  LEFT JOIN users uc ON uc.id = r.confirmed_by
  LEFT JOIN users ux ON ux.id = r.cut_by
  LEFT JOIN users ul ON ul.id = r.released_by`;

const who = (id, name, at) => (at ? { at, by: { id, name: name || "Unknown" } } : null);

function present(r) {
  const b = { name: r.b_name, kind: r.b_kind, thickness: r.b_thickness, finish: r.b_finish, width: r.b_width, colour: r.b_colour };
  return {
    id: r.id,
    jobId: r.job_id,
    jobName: r.job_name,
    orderId: r.order_id,
    materialId: r.material_id,
    line: r.material_name || null,
    section: r.material_section || null,
    boardId: r.board_id,
    board: boardName(b),
    kind: r.b_kind,
    qty: r.qty,
    unit: unitOf(b, r.qty),
    covers: r.covers === 1,
    status: r.status,
    reserved: who(r.reserved_by, r.reserved_by_name, r.reserved_at),
    confirmed: who(r.confirmed_by, r.confirmed_by_name, r.confirmed_at),
    cut: who(r.cut_by, r.cut_by_name, r.cut_at),
    released: who(r.released_by, r.released_by_name, r.released_at),
  };
}

function load(db, id) {
  const r = db.prepare(`${SELECT} WHERE r.id = ?`).get(id);
  if (!r) throw notFound();
  return r;
}

function requireJob(db, jobId) {
  const j = db.prepare("SELECT id, name FROM jobs WHERE id = ?").get(jobId);
  if (!j) throw notFound();
  return j;
}

function cutOf(db, jobId) {
  const c = db.prepare("SELECT c.*, u.display_name AS name FROM job_cuts c LEFT JOIN users u ON u.id = c.cut_by WHERE c.job_id = ?").get(jobId);
  return c ? { date: c.date, at: c.cut_at, by: { id: c.cut_by, name: c.name || "Unknown" } } : null;
}

// The stock list with free amounts: [{id, kind, name, onHand, reserved, free}].
function stock(db) {
  return boards.list(db, {}).map((b) => ({
    id: b.id,
    kind: b.kind,
    name: boardName(b),
    onHand: b.onHand,
    reserved: b.reserved,
    free: b.free,
  }));
}

// GET /api/job-records/:id/reservations: the job's boards and edging order lines (from its order
// list), each with its reservations; the stock to reserve from; and its cut 100% record.
function forJob(db, req, jobId) {
  requireJob(db, jobId);
  const lines = db
    .prepare(
      `SELECT o.id AS order_id, o.status, o.description, o.supplier, m.id AS material_id, m.section, m.name, m.qty, m.unit
         FROM orders o JOIN job_materials m ON m.order_id = o.id
        WHERE o.job_id = ? AND o.status <> 'cancelled' AND m.removed_at IS NULL AND m.section IN ('boards', 'edging')
        ORDER BY m.section, m.position, m.id`
    )
    .all(jobId);
  const all = db.prepare(`${SELECT} WHERE r.job_id = ? ORDER BY r.id`).all(jobId).map(present);
  return {
    jobId,
    lines: lines.map((l) => ({
      orderId: l.order_id,
      materialId: l.material_id,
      section: l.section,
      name: l.name,
      qty: l.qty,
      unit: l.unit || null,
      description: l.description,
      supplier: l.supplier,
      orderStatus: l.status,
      reservations: all.filter((r) => r.orderId === l.order_id),
      covered: all.some((r) => r.orderId === l.order_id && r.covers && r.status !== "released"),
    })),
    reservations: all,
    stock: stock(db),
    cut: cutOf(db, jobId),
    canReserve: can(req, "orders.mark_ordered"),
    canConfirm: can(req, "stock.count"),
  };
}

// POST /api/job-records/:id/reservations {orderId, boardId, qty, covers?} (orders.mark_ordered).
function reserve(db, req, jobId, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!b) throw bad("JSON body required");
  if (!Number.isSafeInteger(b.orderId) || b.orderId < 1) throw bad("orderId must be an order line id");
  if (!Number.isSafeInteger(b.boardId) || b.boardId < 1) throw bad("boardId must be a stock item id");
  const qty = b.qty;
  if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0 || qty > QTY_MAX || !Number.isInteger(qty * 2)) {
    throw bad("qty must be more than 0, in whole or half sheets (whole rolls for edge tape)");
  }
  if (b.covers !== undefined && typeof b.covers !== "boolean") throw bad("covers must be true or false");
  const covers = b.covers === true;
  const job = requireJob(db, jobId);
  const id = db.transaction(() => {
    const line = db
      .prepare(
        `SELECT o.*, m.id AS material_id, m.section FROM orders o LEFT JOIN job_materials m ON m.order_id = o.id AND m.removed_at IS NULL
          WHERE o.id = ? AND o.job_id = ?`
      )
      .get(b.orderId, jobId);
    if (!line) throw bad("That order line isn't on this job");
    if (!line.material_id || !SECTIONS.includes(line.section)) throw bad("Only a boards or edging line of the order list can be reserved from stock");
    if (line.status !== "to_order") throw conflict("That line is no longer to order");
    if (covers && db.prepare("SELECT 1 FROM stock_reservations WHERE order_id = ? AND covers = 1 AND status IN ('reserved','confirmed','cut')").get(line.id)) {
      throw conflict("That line is already wholly reserved from stock");
    }
    const item = boards.boardRow(db, b.boardId);
    if (!item || !item.active) throw bad("There is no such stock item");
    if (item.kind === "edge" && !Number.isInteger(qty)) throw bad("Edge tape is reserved in whole rolls");
    if (line.section === "edging" && item.kind !== "edge") throw bad("An edging line is reserved from edge tape");
    if (line.section === "boards" && item.kind !== "board") throw bad("A boards line is reserved from boards");
    const free = Math.max((item.on_hand || 0) - boards.reservedOf(db, item.id), 0);
    if (qty > free) throw conflict(`Only ${fmtQty(free)} ${unitOf(item, free)} of ${boardName(item)} free`);
    const at = nowIso();
    const info = db
      .prepare(
        `INSERT INTO stock_reservations (job_id, order_id, material_id, board_id, qty, covers, status, reserved_by, reserved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`
      )
      .run(jobId, line.id, line.material_id, item.id, qty, covers ? 1 : 0, userId(req), at);
    const newId = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "stock_reservation.create",
      entityType: "job",
      entityId: jobId,
      after: { reservationId: newId, orderId: line.id, boardId: item.id, qty, covers },
    });
    notify.toKey(
      db,
      "stock.count",
      {
        kind: "stock.reserve",
        title: `Reserve from stock: ${job.name}`,
        body: `${fmtQty(qty)} ${unitOf(item, qty)} of ${boardName(item)}. Label it for the job and tick Reserved.`,
        link: "/reserve.html",
        entityType: "job",
        entityId: jobId,
      },
      { exceptUserId: userId(req) }
    );
    if (covers) require("./orders").afterReservation(db, req, jobId);
    return newId;
  })();
  return present(load(db, id));
}

// POST /api/reservations/:id/confirm (stock.count): labelled for the job.
function confirm(db, req, id) {
  db.transaction(() => {
    const r = load(db, id);
    if (r.status !== "reserved") throw conflict(r.status === "confirmed" ? "Already ticked Reserved" : `This reservation is ${r.status}`);
    db.prepare("UPDATE stock_reservations SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ?").run(userId(req), nowIso(), id);
    audit.log(req, { action: "stock_reservation.confirm", entityType: "job", entityId: r.job_id, before: { reservationId: id, status: "reserved" }, after: { status: "confirmed" } });
    require("./orders").refreshMaterialsIn(db, r.job_id, req);
  })();
  return present(load(db, id));
}

// POST /api/reservations/:id/release (orders.mark_ordered or stock.count): before it is cut.
function release(db, req, id) {
  db.transaction(() => {
    const r = load(db, id);
    if (!LIVE.includes(r.status)) throw conflict(`This reservation is ${r.status}`);
    db.prepare("UPDATE stock_reservations SET status = 'released', released_by = ?, released_at = ? WHERE id = ?").run(userId(req), nowIso(), id);
    audit.log(req, { action: "stock_reservation.release", entityType: "job", entityId: r.job_id, before: { reservationId: id, status: r.status }, after: { status: "released" } });
    require("./orders").refreshMaterialsIn(db, r.job_id, req);
  })();
  return present(load(db, id));
}

// The jobs offered for "cut 100%": live jobs with a live reservation, or on this week's board in a
// row other than installing, not yet recorded as cut.
function cutCandidates(db, today = sydneyToday()) {
  const ids = new Set(
    db
      .prepare("SELECT DISTINCT job_id FROM stock_reservations WHERE status IN ('reserved','confirmed')")
      .all()
      .map((r) => r.job_id)
  );
  for (const r of db
    .prepare("SELECT DISTINCT job_id FROM week_rows WHERE week_start = ? AND panel <> 'installing' AND job_id IS NOT NULL")
    .all(sydneyMonday(today))) {
    ids.add(r.job_id);
  }
  const out = [];
  for (const id of ids) {
    const j = db.prepare("SELECT id, name, client_name, archived FROM jobs WHERE id = ?").get(id);
    if (!j || j.archived || cutOf(db, id)) continue;
    const res = db.prepare(`${SELECT} WHERE r.job_id = ? AND r.status IN ('reserved','confirmed') ORDER BY r.id`).all(id).map(present);
    out.push({ jobId: j.id, name: j.name, clientName: j.client_name || null, reservations: res });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.jobId - b.jobId);
}

// GET /api/reservations: the To reserve page.
function page(db, req) {
  const live = db.prepare(`${SELECT} WHERE r.status IN ('reserved','confirmed') ORDER BY r.reserved_at, r.id`).all().map(present);
  return {
    toLabel: live.filter((r) => r.status === "reserved"),
    reservedNotCut: live.filter((r) => r.status === "confirmed"),
    toCut: cutCandidates(db),
    stock: stock(db),
    canConfirm: can(req, "stock.count"),
    canRelease: can(req, "stock.count") || can(req, "orders.mark_ordered"),
  };
}

// POST /api/workshop/cut {jobIds} (stock.count): the jobs cut 100% this shift.
function cut(db, req, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!b || !Array.isArray(b.jobIds) || !b.jobIds.length) throw bad("jobIds must list the jobs cut 100%");
  if (b.jobIds.length > IDS_MAX) throw bad(`At most ${IDS_MAX} jobs at a time`);
  if (!b.jobIds.every((n) => Number.isSafeInteger(n) && n > 0)) throw bad("jobIds must be job ids");
  const ids = [...new Set(b.jobIds)];
  const date = sydneyToday();
  const done = [];
  const skipped = [];
  db.transaction(() => {
    for (const jobId of ids) {
      const job = db.prepare("SELECT id, name FROM jobs WHERE id = ?").get(jobId);
      if (!job) throw bad(`No such job: ${jobId}`);
      if (cutOf(db, jobId)) {
        skipped.push({ jobId, reason: "already cut" });
        continue;
      }
      const at = nowIso();
      db.prepare("INSERT INTO job_cuts (job_id, date, cut_by, cut_at) VALUES (?, ?, ?, ?)").run(jobId, date, userId(req), at);
      const taken = [];
      for (const r of db.prepare("SELECT * FROM stock_reservations WHERE job_id = ? AND status = 'confirmed'").all(jobId)) {
        const item = boards.boardRow(db, r.board_id);
        const onHand = Math.max((item.on_hand || 0) - r.qty, 0);
        db.prepare("UPDATE boards SET on_hand = ?, on_hand_at = ? WHERE id = ?").run(onHand, at, item.id);
        db.prepare("UPDATE stock_reservations SET status = 'cut', cut_by = ?, cut_at = ? WHERE id = ?").run(userId(req), at, r.id);
        taken.push({ reservationId: r.id, boardId: item.id, qty: r.qty, onHandBefore: item.on_hand, onHandAfter: onHand });
      }
      audit.log(req, { action: "job.cut_complete", entityType: "job", entityId: jobId, after: { date, taken } });
      done.push({ jobId, name: job.name, taken: taken.length });
    }
  })();
  return { date, cut: done, skipped, ...page(db, req) };
}

// For the dashboard: reservations to label and jobs to mark cut (with confirmed reservations).
function counts(db) {
  const toLabel = db.prepare("SELECT COUNT(*) AS n FROM stock_reservations WHERE status = 'reserved'").get().n;
  const toCut = db
    .prepare(
      `SELECT COUNT(DISTINCT r.job_id) AS n FROM stock_reservations r JOIN jobs j ON j.id = r.job_id
        WHERE r.status = 'confirmed' AND j.archived = 0 AND NOT EXISTS (SELECT 1 FROM job_cuts c WHERE c.job_id = r.job_id)`
    )
    .get().n;
  return { toLabel: Number(toLabel) || 0, toCut: Number(toCut) || 0 };
}

module.exports = { forJob, reserve, confirm, release, page, cut, cutOf, cutCandidates, counts };
