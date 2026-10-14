// Drawers (docs/plans/m11-contracts.md sections 4 and 6.1): a job's drawer lines and their grids,
// filling them from Joinr, the Drawer order page (totals, stock row, placing and undoing), the
// drawer name list and the two supplier settings.
//
// Every function takes db first and nothing here requires ../db. Sizes come from ../public/drawers.
// Order line statuses change only through lib/orders.js with {via: "drawers"} (section 5.2). Every
// write runs in one db.transaction with its audit row. The routes declare only the coarse access
// value; the rules about who may do what are checked here (checking a grid needs jobs.edit;
// placing and undoing also need orders.mark_ordered, because they mark job lines ordered).
//
// The Joinr payload is read straight from joinr_intake (the latest record tied to the job, as
// intake.forJob picks it), because intake's normalised quote leaves the drawer lines out and
// lib/intake.js calls fillFromJoinr (so this file must not require it back).
const crypto = require("crypto");
const audit = require("./audit");
const invoices = require("./invoices");
const notify = require("./notify");
const orders = require("./orders");
const settings = require("./settings");
const Drawers = require("../public/drawers");
const { bad, notFound, conflict, forbidden, can } = require("./httperror");
const { sydneyToday } = require("./time");

const NAME_MAX = 200;
const COUNTS_MAX = 100; // entries in one counts list (a brand has 28 cells)
const SUPPLIER_MAX = 200;
const DELIVERY_NOTE_MAX = 500;
const UNMAPPED_BODY_CUT = 300;
const PLACED_LIMIT = 50;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SUPPLIER_KEY = { edge: "drawers.supplier.edge", dtc: "drawers.supplier.dtc" };

// A job the Drawer order page counts (as intake's Link: not archived, not lost).
const LIVE_JOB = "j.archived = 0 AND j.stage NOT IN ('lost','archived')";

function nowIso() {
  return new Date().toISOString();
}

function userId(req) {
  return req && req.user && req.user.id != null ? req.user.id : null;
}

function person(id, name) {
  return id == null ? null : { id, name: name || null };
}

// "2026-10-03" -> "3 Oct 2026".
function dayLabel(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function need(req, key) {
  if (!can(req, key)) throw forbidden();
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

// --- sizes and counts --------------------------------------------------------------------------

function brandOr400(id) {
  const b = typeof id === "string" ? Drawers.brand(id) : null;
  if (!b) throw bad(`brand must be one of ${Drawers.BRANDS.map((x) => x.id).join(", ")}`);
  return b;
}

// [{height, length, qty}] in, the same out in brand order. A qty of 0 is dropped (a zero count is
// simply absent); a size that isn't the brand's, a bad qty or a cell sent twice is 400.
function parseCounts(brand, counts) {
  if (!Array.isArray(counts)) throw bad("counts must be a list of {height, length, qty}");
  if (counts.length > COUNTS_MAX) throw bad("counts has too many entries");
  const seen = new Set();
  const out = [];
  counts.forEach((c, i) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) throw bad(`counts[${i}] must be {height, length, qty}`);
    const { height, length, qty } = c;
    if (!Number.isInteger(height) || !Number.isInteger(length) || !Drawers.validSize(brand.id, height, length)) {
      throw bad(`counts[${i}] isn't an ${brand.label} drawer size`);
    }
    if (!Number.isInteger(qty) || qty < 0 || qty > Drawers.QTY_MAX) {
      throw bad(`counts[${i}].qty must be a whole number from 1 to ${Drawers.QTY_MAX}`);
    }
    const key = `${height}x${length}`;
    if (seen.has(key)) throw bad(`counts has ${height}/${length} twice`);
    seen.add(key);
    if (qty > 0) out.push({ height, length, qty });
  });
  return Drawers.sorted(brand.id, out);
}

function countsOf(db, orderId, brandId) {
  const rows = db.prepare("SELECT height, length, qty FROM order_drawer_counts WHERE order_id = ?").all(orderId);
  return Drawers.sorted(brandId, rows.map((r) => ({ height: r.height, length: r.length, qty: r.qty })));
}

function writeCounts(db, orderId, counts) {
  db.prepare("DELETE FROM order_drawer_counts WHERE order_id = ?").run(orderId);
  const ins = db.prepare("INSERT INTO order_drawer_counts (order_id, height, length, qty) VALUES (?, ?, ?, ?)");
  for (const c of counts) ins.run(orderId, c.height, c.length, c.qty);
}

function sameCounts(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stockDraft(db, brandId) {
  const rows = db.prepare("SELECT height, length, qty FROM drawer_stock_draft WHERE brand = ?").all(brandId);
  return Drawers.sorted(brandId, rows.map((r) => ({ height: r.height, length: r.length, qty: r.qty })));
}

// --- the drawer name list ----------------------------------------------------------------------

// lower(trim(name)), single spaces (the drawer_names.name_key rule).
function nameKey(name) {
  return String(name).trim().replace(/\s+/g, " ").toLowerCase();
}

// name_key -> {brand, height, length} | "ignored". A mapping whose size is no longer in
// public/drawers.js counts as not mapped.
function nameMap(db) {
  const map = new Map();
  for (const r of db.prepare("SELECT name_key, brand, height, length, ignored FROM drawer_names").all()) {
    if (r.ignored) map.set(r.name_key, "ignored");
    else if (Drawers.validSize(r.brand, r.height, r.length)) {
      map.set(r.name_key, { brand: r.brand, height: r.height, length: r.length });
    }
  }
  return map;
}

// --- the Joinr lines ---------------------------------------------------------------------------

// A payload's drawers, defensively: null when not reported, else [{section, name, qty}] (the
// shape lib/joinr-sync.js validateItem stores; anything else in an older payload is dropped).
function normaliseJoinr(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const d of list) {
    if (!d || typeof d !== "object") continue;
    if (d.section !== "drawers" && d.section !== "innerDrawers") continue;
    if (typeof d.name !== "string" || !d.name.trim()) continue;
    if (!Number.isInteger(d.qty) || d.qty <= 0) continue;
    out.push({ section: d.section, name: d.name.trim().slice(0, NAME_MAX), qty: d.qty });
  }
  return out;
}

// The latest intake payload tied to the job (intake.forJob's record): its drawers, or null.
function payloadFor(db, jobId) {
  const row = db.prepare("SELECT payload, quote_number FROM joinr_intake WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId);
  if (!row) return { found: false, drawers: null, quoteNumber: null };
  const p = parseJson(row.payload);
  return {
    found: true,
    drawers: normaliseJoinr(p && typeof p === "object" ? p.drawers : null),
    quoteNumber: typeof row.quote_number === "string" && row.quote_number.trim() ? row.quote_number.trim().slice(0, 100) : null,
  };
}

// Each entry with its current mapping, and the per-brand sums of the mapped ones.
function mapEntries(db, entries) {
  const map = nameMap(db);
  const mapped = entries.map((e) => ({ ...e, map: map.get(nameKey(e.name)) || null }));
  const byBrand = {};
  for (const e of mapped) {
    if (!e.map || e.map === "ignored") continue;
    const b = (byBrand[e.map.brand] = byBrand[e.map.brand] || {});
    const k = `${e.map.height}x${e.map.length}`;
    b[k] = b[k] || { height: e.map.height, length: e.map.length, qty: 0 };
    b[k].qty += e.qty;
  }
  for (const id of Object.keys(byBrand)) {
    // A sum over the cap is held at the cap (the grid's limit); Design/PM checks it anyway.
    byBrand[id] = Drawers.sorted(id, Object.values(byBrand[id]).map((c) => ({ ...c, qty: Math.min(c.qty, Drawers.QTY_MAX) })));
  }
  return { mapped, byBrand };
}

// The joinr_lines kept on a line (contracts section 4.5, review A-m5): every entry of the quote's
// drawer lines as Joinr sent it (section, name, qty), with the mapping it had at the time. All of
// them, not only the line's brand, so "Changed in Joinr" compares Joinr's own lines and a later
// change to our name list never shows as a change.
function linesForLine(mapped) {
  return mapped.map((e) => ({ section: e.section, name: e.name, qty: e.qty, map: e.map }));
}

// --- reading lines -----------------------------------------------------------------------------

function drawerRow(db, orderId) {
  const row = db
    .prepare(
      `SELECT o.id, o.job_id, o.status, od.brand, od.source, od.joinr_lines, od.checked_at, od.checked_by, od.drawer_order_id
       FROM orders o JOIN order_drawers od ON od.order_id = o.id WHERE o.id = ?`
    )
    .get(orderId);
  if (!row) throw notFound();
  return row;
}

function toOrderRow(db, orderId) {
  const row = drawerRow(db, orderId);
  if (row.status !== "to_order") throw conflict("Only a drawer line still to order can be changed");
  return row;
}

// The order object (orders.present, with kind and drawers) plus counts and joinrLines.
function presentLine(db, orderId) {
  const row = drawerRow(db, orderId);
  const order = orders.listForJob(db, row.job_id, { includeCancelled: true }).find((o) => o.id === orderId);
  return { ...order, counts: countsOf(db, orderId, row.brand), joinrLines: parseJson(row.joinr_lines) };
}

function result(db, orderId) {
  const order = presentLine(db, orderId);
  return { order, job: orders.jobState(db, order.jobId) };
}

function requireJob(db, jobId) {
  const job = db.prepare("SELECT id, name FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw notFound();
  return job;
}

function openLineOf(db, jobId, brandId) {
  return db
    .prepare(
      `SELECT o.id FROM orders o JOIN order_drawers od ON od.order_id = o.id
       WHERE o.job_id = ? AND od.brand = ? AND o.status = 'to_order' LIMIT 1`
    )
    .get(jobId, brandId);
}

// Any live (not cancelled) drawer line of the brand on the job, ordered or received too
// (contracts section 15.18: filling from Joinr skips such a brand).
function liveLineOf(db, jobId, brandId) {
  return db
    .prepare(
      `SELECT o.id FROM orders o JOIN order_drawers od ON od.order_id = o.id
       WHERE o.job_id = ? AND od.brand = ? AND o.status <> 'cancelled' LIMIT 1`
    )
    .get(jobId, brandId);
}

// Creates a drawer line (an orders row through orders.createLine, then its link row and counts),
// inside the caller's transaction. Returns the order id.
function insertLine(db, req, jobId, brand, counts, { source, joinrLines, notes, expectedDate, checked }) {
  const { order } = orders.createLine(
    db,
    jobId,
    { supplier: settings.get(db, SUPPLIER_KEY[brand.id]), description: Drawers.describe(brand.id, counts), notes, expectedDate },
    req,
    { via: "drawers" }
  );
  const at = checked ? nowIso() : null;
  db.prepare(
    `INSERT INTO order_drawers (order_id, brand, source, joinr_lines, checked_at, checked_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(order.id, brand.id, source, joinrLines ? JSON.stringify(joinrLines) : null, at, at ? userId(req) : null);
  writeCounts(db, order.id, counts);
  audit.log(req, {
    action: "order.drawers",
    entityType: "order",
    entityId: order.id,
    after: { brand: brand.id, source, counts, checked: !!checked },
  });
  return order.id;
}

// --- filling from Joinr (section 4.5) ----------------------------------------------------------

// Called by lib/intake.js accept() and link() inside their transactions, after the job is written,
// only when the payload's drawers is an array (section 4.5). Returns {created: [orderId], unmapped: [name]}.
function fillFromJoinr(db, jobId, payloadDrawers, req, { quoteNumber, noUnmappedNotice } = {}) {
  const entries = normaliseJoinr(payloadDrawers);
  if (!entries) return { created: [], unmapped: [] };
  return db.transaction(() => {
    const job = requireJob(db, jobId);
    const { mapped, byBrand } = mapEntries(db, entries);
    const created = [];
    for (const brand of Drawers.BRANDS) {
      const counts = byBrand[brand.id];
      if (!counts || !counts.length) continue;
      if (liveLineOf(db, jobId, brand.id)) continue; // while it is still to order, the job page offers Refill
      created.push(
        insertLine(db, req, jobId, brand, counts, {
          source: "joinr",
          joinrLines: linesForLine(mapped),
          notes: `From Joinr${quoteNumber ? ` ${quoteNumber}` : ""}.`,
        })
      );
    }
    const unmapped = [];
    const keys = new Set();
    for (const e of mapped) {
      if (e.map !== null || keys.has(nameKey(e.name))) continue;
      keys.add(nameKey(e.name));
      unmapped.push(e.name);
    }
    if (unmapped.length && !noUnmappedNotice) {
      const body = unmapped.join(", ");
      notify.toUsers(
        db,
        notify.usersWithKey(db, "stock.order"),
        {
          kind: "drawers.unmapped",
          title: `Drawer names to add: ${job.name}`,
          body: body.length > UNMAPPED_BODY_CUT ? `${body.slice(0, UNMAPPED_BODY_CUT - 1)}…` : body,
          link: "/drawers.html#names",
          entityType: "job",
          entityId: jobId,
        },
        { exceptUserId: userId(req) }
      );
    }
    if (created.length) {
      notify.toUsers(
        db,
        notify.usersWithKey(db, "jobs.edit"),
        {
          kind: "drawers.check",
          title: `Drawers to check: ${job.name}`,
          link: `/job.html?id=${jobId}#orders`,
          entityType: "job",
          entityId: jobId,
        },
        { exceptUserId: userId(req) }
      );
    }
    return { created, unmapped };
  })();
}

// --- a job's drawer lines (section 6.1) --------------------------------------------------------

// True when a line filled from Joinr no longer matches what Joinr now sends: a stored entry gone,
// a new one, or one with another quantity. It compares Joinr's own lines (section, name, qty) and
// ignores the mapping, so remapping a name on our side is never a change (review A-m5).
function lineChanged(stored, current) {
  const sum = (list) => {
    const m = new Map();
    for (const e of list || []) {
      const k = `${e.section}\u0000${nameKey(e.name)}`;
      m.set(k, (m.get(k) || 0) + e.qty);
    }
    return m;
  };
  const had = sum(stored);
  const now = sum(current);
  if (had.size !== now.size) return true;
  for (const [k, q] of had) if (now.get(k) !== q) return true;
  return false;
}

// The brands a Fill from Joinr would create a line for: the payload's mapped counts, minus the
// brands the job already has a live drawer line for (section 15.18).
function fillable(db, jobId) {
  const p = payloadFor(db, jobId);
  if (!p.drawers) return { payload: p, brands: [] };
  const { byBrand } = mapEntries(db, p.drawers);
  const brands = Drawers.BRANDS.filter((b) => byBrand[b.id] && byBrand[b.id].length && !liveLineOf(db, jobId, b.id));
  return { payload: p, brands };
}

// GET /api/job-records/:id/drawers: {lines, joinr}.
function forJob(db, user, jobId) {
  requireJob(db, jobId);
  const ids = db
    .prepare(
      `SELECT o.id FROM orders o JOIN order_drawers od ON od.order_id = o.id
       WHERE o.job_id = ? AND o.status <> 'cancelled' ORDER BY o.id`
    )
    .all(jobId)
    .map((r) => r.id);
  const lines = ids.map((id) => presentLine(db, id));
  const p = payloadFor(db, jobId);
  let joinr = null;
  if (p.found) {
    if (!p.drawers) joinr = { drawers: null, unmapped: [], changedSinceFill: false };
    else {
      const { mapped } = mapEntries(db, p.drawers);
      const changedSinceFill = lines.some(
        (l) => l.drawers.source === "joinr" && lineChanged(l.joinrLines, mapped)
      );
      joinr = { drawers: mapped, unmapped: mapped.filter((e) => e.map === null), changedSinceFill };
    }
  }
  // canFill: Fill from Joinr (POST .../drawers/fill) would create at least one line, and the user may.
  const canFill = can({ user }, "orders.edit") && fillable(db, jobId).brands.length > 0;
  return { lines, joinr, canFill };
}

// POST /api/job-records/:id/drawers/fill -> {lines, joinr, canFill, created: [orderId]} (section 15.18).
function fillForJob(db, req, jobId) {
  need(req, "orders.edit");
  return db.transaction(() => {
    requireJob(db, jobId);
    const { payload, brands } = fillable(db, jobId);
    if (!brands.length) throw conflict("Nothing to fill from Joinr");
    const { created } = fillFromJoinr(db, jobId, payload.drawers, req, {
      quoteNumber: payload.quoteNumber,
      noUnmappedNotice: true,
    });
    if (!created.length) throw conflict("Nothing to fill from Joinr");
    return { ...forJob(db, req.user, jobId), created };
  })();
}

function checkedFlag(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw bad("checked must be true or false");
  return v;
}

// POST /api/job-records/:id/drawers: {brand, counts, notes?, expectedDate?, checked?} -> {order, job}.
function createForJob(db, req, jobId, body) {
  need(req, "orders.edit");
  requireJob(db, jobId);
  const brand = brandOr400(body.brand);
  const counts = parseCounts(brand, body.counts);
  if (!counts.length) throw bad("Add at least one drawer");
  const checked = checkedFlag(body.checked);
  if (checked && !can(req, "jobs.edit")) throw forbidden();
  return db.transaction(() => {
    if (openLineOf(db, jobId, brand.id)) {
      throw conflict(`This job already has an ${brand.label} drawer line waiting to be ordered`);
    }
    const id = insertLine(db, req, jobId, brand, counts, {
      source: "manual",
      joinrLines: null,
      notes: body.notes,
      expectedDate: body.expectedDate,
      checked,
    });
    return result(db, id);
  })();
}

// Replaces a to_order line's counts (and joinr_lines/source when given), rewriting the
// description; the check follows section 4.2. Inside the caller's transaction.
function rewrite(db, req, row, counts, { notes, checked, source, joinrLines, action }) {
  const before = countsOf(db, row.id, row.brand);
  const changed = !sameCounts(before, counts);
  let checkedAt = row.checked_at;
  let checkedBy = row.checked_by;
  if (checked === true) {
    checkedAt = nowIso();
    checkedBy = userId(req);
  } else if (checked === false || changed || source === "joinr") {
    checkedAt = null;
    checkedBy = null;
  }
  const patch = { description: Drawers.describe(row.brand, counts) };
  if (notes !== undefined) patch.notes = notes;
  orders.updateLine(db, row.id, patch, req, { via: "drawers" });
  writeCounts(db, row.id, counts);
  const src = source || row.source;
  db.prepare(
    "UPDATE order_drawers SET source = ?, joinr_lines = ?, checked_at = ?, checked_by = ? WHERE order_id = ?"
  ).run(src, joinrLines !== undefined ? JSON.stringify(joinrLines) : row.joinr_lines, checkedAt, checkedBy, row.id);
  audit.log(req, {
    action,
    entityType: "order",
    entityId: row.id,
    before: { counts: before, source: row.source, checked: !!row.checked_at },
    after: { counts, source: src, checked: !!checkedAt },
  });
  return result(db, row.id);
}

// PUT /api/orders/:id/drawers: {counts, notes?, checked?} -> {order, job}.
function updateGrid(db, req, orderId, body) {
  need(req, "orders.edit");
  const checked = checkedFlag(body.checked);
  if (checked && !can(req, "jobs.edit")) throw forbidden();
  return db.transaction(() => {
    const row = toOrderRow(db, orderId);
    const counts = parseCounts(Drawers.brand(row.brand) || brandOr400(row.brand), body.counts);
    if (!counts.length) throw bad("Add at least one drawer, or cancel the line");
    return rewrite(db, req, row, counts, { notes: body.notes, checked, action: "order.drawers" });
  })();
}

// POST /api/orders/:id/drawers/check: {checked} -> {order, job}.
function setChecked(db, req, orderId, checked) {
  need(req, "jobs.edit");
  if (typeof checked !== "boolean") throw bad("checked must be true or false");
  return db.transaction(() => {
    const row = toOrderRow(db, orderId);
    const at = checked ? nowIso() : null;
    db.prepare("UPDATE order_drawers SET checked_at = ?, checked_by = ? WHERE order_id = ?").run(
      at,
      at ? userId(req) : null,
      orderId
    );
    if (!!row.checked_at !== checked) {
      audit.log(req, {
        action: "order.drawers_check",
        entityType: "order",
        entityId: orderId,
        before: { checked: !!row.checked_at },
        after: { checked },
      });
    }
    return result(db, orderId);
  })();
}

// POST /api/orders/:id/drawers/refill -> {order, job}.
function refill(db, req, orderId) {
  need(req, "orders.edit");
  return db.transaction(() => {
    const row = toOrderRow(db, orderId);
    const p = payloadFor(db, row.job_id);
    const { mapped, byBrand } = mapEntries(db, p.drawers || []);
    const counts = byBrand[row.brand];
    if (!p.drawers || !counts || !counts.length) throw conflict("No drawers from Joinr for this job");
    return rewrite(db, req, row, counts, {
      checked: false,
      source: "joinr",
      joinrLines: linesForLine(mapped),
      action: "order.drawers_refill",
    });
  })();
}

// --- the Drawer order page ---------------------------------------------------------------------

// The brand's to_order drawer lines on live jobs, by job name (case-blind), then order id.
function openLines(db, brandId) {
  return db
    .prepare(
      `SELECT o.id, o.job_id, o.notes, o.expected_date, j.name AS job_name, od.source,
         od.checked_at, od.checked_by, u.display_name AS checked_by_name
       FROM orders o
       JOIN order_drawers od ON od.order_id = o.id
       JOIN jobs j ON j.id = o.job_id
       LEFT JOIN users u ON u.id = od.checked_by
       WHERE o.status = 'to_order' AND od.brand = ? AND ${LIVE_JOB}
       ORDER BY j.name COLLATE NOCASE, o.id`
    )
    .all(brandId)
    .map((r) => {
      const counts = countsOf(db, r.id, brandId);
      return {
        orderId: r.id,
        jobId: r.job_id,
        jobName: r.job_name,
        notes: r.notes,
        expectedDate: r.expected_date || null,
        source: r.source,
        checked: r.checked_at == null ? null : { at: r.checked_at, by: person(r.checked_by, r.checked_by_name) },
        counts,
        total: Drawers.total(counts),
      };
    });
}

// A hash of what the sheet shows (line ids, counts, notes, check state, the stock row), so placing
// can tell that something changed while the page was open (contracts section 15.23).
function sheetKeyOf(brandId, rows, waiting, stock) {
  const line = (l) => [l.orderId, l.counts, l.notes || "", l.checked ? 1 : 0];
  return crypto
    .createHash("sha1")
    .update(JSON.stringify([brandId, rows.map(line), waiting.map(line), stock]))
    .digest("hex")
    .slice(0, 16);
}

// GET /api/drawers?brand=: {brand, supplier, sheetKey, rows, waiting, stock, totals, total}.
function board(db, brand) {
  const b = brandOr400(brand);
  const lines = openLines(db, b.id);
  const rows = lines.filter((l) => l.checked);
  const stock = stockDraft(db, b.id);
  const totals = Drawers.sum(b.id, [...rows.map((r) => r.counts), stock]);
  const waiting = lines.filter((l) => !l.checked);
  return {
    brand: b.id,
    supplier: settings.get(db, SUPPLIER_KEY[b.id]),
    sheetKey: sheetKeyOf(b.id, rows, waiting, stock),
    rows,
    waiting: waiting,
    stock,
    totals,
    total: Drawers.total(totals),
  };
}

// PUT /api/drawers/stock: {brand, counts} -> the board.
function saveStock(db, req, brand, counts) {
  need(req, "stock.order");
  const b = brandOr400(brand);
  const next = parseCounts(b, counts);
  db.transaction(() => {
    const before = stockDraft(db, b.id);
    if (sameCounts(before, next)) return;
    db.prepare("DELETE FROM drawer_stock_draft WHERE brand = ?").run(b.id);
    const ins = db.prepare("INSERT INTO drawer_stock_draft (brand, height, length, qty) VALUES (?, ?, ?, ?)");
    for (const c of next) ins.run(b.id, c.height, c.length, c.qty);
    audit.log(req, {
      action: "drawer_stock.update",
      entityType: "drawer_stock",
      entityId: b.id,
      before: { counts: before },
      after: { counts: next },
    });
  })();
  return board(db, b.id);
}

function dateOrNull(label, v) {
  if (v === undefined || v === null || v === "") return null;
  if (!invoices.validDate(v)) throw bad(`${label} must be a valid YYYY-MM-DD date`);
  return v;
}

// A placed drawer order. With grid: the frozen sheet (section 4.3).
function presentPlaced(db, row, withGrid) {
  const grid = parseJson(row.grid_json) || { rows: [], stock: [], totals: [], total: 0 };
  const linked = db
    .prepare(
      `SELECT o.status FROM order_drawers od JOIN orders o ON o.id = od.order_id WHERE od.drawer_order_id = ?`
    )
    .all(row.id);
  const stock = grid.stock || [];
  const out = {
    id: row.id,
    brand: row.brand,
    supplier: row.supplier,
    orderedDate: row.ordered_date,
    expectedDate: row.expected_date || null,
    createdAt: row.created_at,
    createdBy: person(row.created_by, row.created_by_name),
    jobs: (grid.rows || []).map((r) => ({ orderId: r.orderId, jobId: r.jobId, jobName: r.jobName })),
    total: Number(grid.total) || 0,
    stockTotal: Drawers.total(stock),
    stockReceived: row.stock_received_date
      ? { date: row.stock_received_date, by: person(row.stock_received_by, row.stock_received_by_name) }
      : null,
    stockDeliveryNote: row.stock_delivery_note || "",
    linesOrdered: linked.filter((l) => l.status === "ordered").length,
    linesReceived: linked.filter((l) => l.status === "received").length,
    undoable: !row.stock_received_date && !linked.some((l) => l.status === "received"),
  };
  if (withGrid) out.grid = grid;
  return out;
}

const SELECT_PLACED = `SELECT d.*, uc.display_name AS created_by_name, ur.display_name AS stock_received_by_name
  FROM drawer_orders d
  LEFT JOIN users uc ON uc.id = d.created_by
  LEFT JOIN users ur ON ur.id = d.stock_received_by`;

function placedRow(db, id) {
  const row = db.prepare(`${SELECT_PLACED} WHERE d.id = ?`).get(id);
  if (!row) throw notFound();
  return row;
}

// POST /api/drawers/place: {brand, orderedDate?, expectedDate?, orderIds, sheetKey} -> {drawerOrder}.
function place(db, req, body) {
  need(req, "stock.order");
  need(req, "orders.mark_ordered");
  const b = brandOr400(body.brand);
  if (!Array.isArray(body.orderIds) || !body.orderIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw bad("orderIds must be a list of order line ids");
  }
  if (typeof body.sheetKey !== "string" || !body.sheetKey) throw bad("sheetKey is required");
  const today = sydneyToday();
  const orderedDate = dateOrNull("orderedDate", body.orderedDate) || today;
  if (orderedDate > today) throw bad("The ordered date can't be in the future");
  const expectedDate = dateOrNull("expectedDate", body.expectedDate);
  if (expectedDate && expectedDate < orderedDate) {
    throw bad(`The expected date can't be before it was ordered (${dayLabel(orderedDate)})`);
  }
  const id = db.transaction(() => {
    const current = board(db, b.id);
    if (body.sheetKey !== current.sheetKey) {
      throw conflict("The drawer order changed while you were looking; reload it");
    }
    const want = [...new Set(body.orderIds)].sort((x, y) => x - y);
    const have = current.rows.map((r) => r.orderId).sort((x, y) => x - y);
    if (want.length !== body.orderIds.length || JSON.stringify(want) !== JSON.stringify(have)) {
      throw conflict("The drawer order changed while you were looking; reload it");
    }
    if (!current.rows.length && !current.stock.length) throw bad("Nothing to order");
    const grid = {
      brand: b.id,
      supplier: current.supplier,
      orderedDate,
      expectedDate,
      // A job's note goes into the frozen grid when it has one, so a reprint matches what was sent
      // (contracts section 4.3, 15.15). Orders placed before this have none.
      rows: current.rows.map((r) => {
        const row = { orderId: r.orderId, jobId: r.jobId, jobName: r.jobName, counts: r.counts };
        const note = typeof r.notes === "string" ? r.notes.trim() : "";
        if (note) row.notes = note;
        return row;
      }),
      stock: current.stock,
      totals: current.totals,
      total: current.total,
    };
    const info = db
      .prepare(
        `INSERT INTO drawer_orders (brand, supplier, ordered_date, expected_date, grid_json, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(b.id, current.supplier, orderedDate, expectedDate, JSON.stringify(grid), nowIso(), userId(req));
    const placedId = Number(info.lastInsertRowid);
    const link = db.prepare("UPDATE order_drawers SET drawer_order_id = ? WHERE order_id = ?");
    for (const r of current.rows) {
      const patch = { status: "ordered", orderedDate };
      if (expectedDate) patch.expectedDate = expectedDate;
      orders.updateLine(db, r.orderId, patch, req, { via: "drawers" });
      link.run(placedId, r.orderId);
    }
    db.prepare("DELETE FROM drawer_stock_draft WHERE brand = ?").run(b.id);
    audit.log(req, {
      action: "drawer_order.place",
      entityType: "drawer_order",
      entityId: placedId,
      after: {
        brand: b.id,
        supplier: current.supplier,
        orderedDate,
        expectedDate,
        orderIds: have,
        stock: current.stock,
        total: current.total,
      },
    });
    return placedId;
  })();
  return { drawerOrder: placedGet(db, id) };
}

// GET /api/drawers/placed?brand=: newest first, 50. An empty brand lists both.
function placedList(db, brand) {
  const where = brand ? "WHERE d.brand = ?" : "";
  const args = brand ? [brandOr400(brand).id] : [];
  return db
    .prepare(`${SELECT_PLACED} ${where} ORDER BY d.ordered_date DESC, d.id DESC LIMIT ${PLACED_LIMIT}`)
    .all(...args)
    .map((r) => presentPlaced(db, r, false));
}

function placedGet(db, id) {
  return presentPlaced(db, placedRow(db, id), true);
}

// POST /api/drawers/placed/:id/undo (section 6.2).
function undoPlaced(db, req, id) {
  need(req, "stock.order");
  need(req, "orders.mark_ordered");
  db.transaction(() => {
    const row = placedRow(db, id);
    const linked = db
      .prepare(
        `SELECT o.id, o.status FROM order_drawers od JOIN orders o ON o.id = od.order_id
         WHERE od.drawer_order_id = ? ORDER BY o.id`
      )
      .all(id);
    if (row.stock_received_date || linked.some((l) => l.status === "received")) {
      throw conflict("Something on this order has already been received");
    }
    // Back to To order through lib/orders.js, which also unlinks each line (section 5.2).
    for (const l of linked) {
      if (l.status === "ordered") orders.updateLine(db, l.id, { status: "to_order" }, req, { via: "drawers" });
    }
    db.prepare("UPDATE order_drawers SET drawer_order_id = NULL WHERE drawer_order_id = ?").run(id);
    const grid = parseJson(row.grid_json) || {};
    // A stock cell already typed on the page is added to; one that would pass the 999 cap is held at it.
    const up = db.prepare(
      `INSERT INTO drawer_stock_draft (brand, height, length, qty) VALUES (?, ?, ?, ?)
       ON CONFLICT (brand, height, length) DO UPDATE SET qty = MIN(qty + excluded.qty, ${Drawers.QTY_MAX})`
    );
    for (const c of grid.stock || []) {
      if (Number.isInteger(c.qty) && c.qty > 0) up.run(row.brand, c.height, c.length, c.qty);
    }
    db.prepare("DELETE FROM drawer_orders WHERE id = ?").run(id);
    audit.log(req, {
      action: "drawer_order.undo",
      entityType: "drawer_order",
      entityId: id,
      before: {
        brand: row.brand,
        supplier: row.supplier,
        orderedDate: row.ordered_date,
        expectedDate: row.expected_date,
        grid,
      },
      after: { orderIds: linked.filter((l) => l.status === "ordered").map((l) => l.id) },
    });
  })();
  return { undone: true };
}

// POST /api/drawers/placed/:id/stock-received: {receivedDate?, deliveryNote?} or {undo: true}.
function stockReceived(db, req, id, body) {
  need(req, "orders.receive");
  let note;
  if (body.deliveryNote !== undefined && body.deliveryNote !== null) {
    if (typeof body.deliveryNote !== "string") throw bad("The delivery note must be text");
    note = body.deliveryNote.trim();
    if (note.length > DELIVERY_NOTE_MAX) throw bad(`The delivery note must be ${DELIVERY_NOTE_MAX} characters or fewer`);
  }
  const today = sydneyToday();
  const receivedIn = dateOrNull("receivedDate", body.receivedDate);
  db.transaction(() => {
    const row = placedRow(db, id);
    const grid = parseJson(row.grid_json) || {};
    if (!(grid.stock || []).length) throw conflict("This drawer order has no stock row");
    const before = {
      stock_received_date: row.stock_received_date,
      stock_received_by: row.stock_received_by,
      stock_delivery_note: row.stock_delivery_note,
    };
    let after;
    if (body.undo === true) {
      if (!row.stock_received_date) throw conflict("The stock row hasn't been received");
      // As an order line moving back to Ordered, the delivery note stays.
      after = { stock_received_date: null, stock_received_by: null, stock_delivery_note: row.stock_delivery_note };
    } else {
      if (row.stock_received_date) {
        throw conflict(`It was already marked received on ${dayLabel(row.stock_received_date)}`);
      }
      const date = receivedIn || today;
      if (date > today) throw bad("The received date can't be in the future");
      if (date < row.ordered_date) {
        throw bad(`The received date can't be before it was ordered (${dayLabel(row.ordered_date)})`);
      }
      after = {
        stock_received_date: date,
        stock_received_by: userId(req),
        stock_delivery_note: note !== undefined ? note : row.stock_delivery_note,
      };
    }
    db.prepare(
      "UPDATE drawer_orders SET stock_received_date = ?, stock_received_by = ?, stock_delivery_note = ? WHERE id = ?"
    ).run(after.stock_received_date, after.stock_received_by, after.stock_delivery_note, id);
    audit.log(req, { action: "drawer_order.stock_received", entityType: "drawer_order", entityId: id, before, after });
    // A new non-empty delivery note tells Ordering, as an order line's does (section 15.20).
    if (after.stock_delivery_note && after.stock_delivery_note !== (row.stock_delivery_note || "")) {
      const brandRow = Drawers.brand(row.brand);
      notify.toKey(
        db,
        "orders.mark_ordered",
        {
          kind: "drawers.delivery_note",
          title: `Delivery note: Drawer stock (${brandRow ? brandRow.label : String(row.brand).toUpperCase()})`,
          body: `${row.supplier}: ${orders.cutNote(after.stock_delivery_note)}`,
          link: `/drawers.html?placed=${id}`,
          entityType: "drawer_order",
          entityId: id,
        },
        { exceptUserId: userId(req) }
      );
    }
  })();
  return placedGet(db, id);
}

// --- the drawer name list (section 6.1) --------------------------------------------------------

function presentName(r) {
  return {
    id: r.id,
    name: r.name,
    brand: r.brand,
    height: r.height,
    length: r.length,
    ignored: !!r.ignored,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: person(r.updated_by, r.updated_by_name),
  };
}

const SELECT_NAME = `SELECT n.*, u.display_name AS updated_by_name FROM drawer_names n
  LEFT JOIN users u ON u.id = n.updated_by`;

function nameRow(db, id) {
  const r = db.prepare(`${SELECT_NAME} WHERE n.id = ?`).get(id);
  if (!r) throw notFound();
  return r;
}

function names(db) {
  return db.prepare(`${SELECT_NAME} ORDER BY n.name COLLATE NOCASE, n.id`).all().map(presentName);
}

// {name, brand, height, length} or {name, ignored: true} -> the row's values.
function nameFields(v) {
  if (typeof v.name !== "string") throw bad("name is required");
  const name = v.name.trim();
  if (!name) throw bad("name is required");
  if (name.length > NAME_MAX) throw bad(`name must be ${NAME_MAX} characters or fewer`);
  if (v.ignored !== undefined && v.ignored !== null && typeof v.ignored !== "boolean") {
    throw bad("ignored must be true or false");
  }
  if (v.ignored === true) return { name, name_key: nameKey(name), brand: null, height: null, length: null, ignored: 1 };
  const b = brandOr400(v.brand);
  if (!Number.isInteger(v.height) || !Number.isInteger(v.length) || !Drawers.validSize(b.id, v.height, v.length)) {
    throw bad(`That isn't an ${b.label} drawer size`);
  }
  return { name, name_key: nameKey(name), brand: b.id, height: v.height, length: v.length, ignored: 0 };
}

function nameTaken(db, key, exceptId) {
  const r = db.prepare("SELECT id FROM drawer_names WHERE name_key = ?").get(key);
  return !!r && r.id !== exceptId;
}

function addName(db, req, body) {
  need(req, "stock.order");
  const f = nameFields(body);
  const id = db.transaction(() => {
    if (nameTaken(db, f.name_key, null)) throw conflict("That name is already on the list");
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO drawer_names (name, name_key, brand, height, length, ignored, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.name, f.name_key, f.brand, f.height, f.length, f.ignored, now, now, userId(req));
    const newId = Number(info.lastInsertRowid);
    audit.log(req, { action: "drawer_name.create", entityType: "drawer_name", entityId: newId, after: f });
    return newId;
  })();
  return presentName(nameRow(db, id));
}

// PATCH: any of name, brand, height, length, ignored; the result is checked as a whole.
function updateName(db, req, id, body) {
  need(req, "stock.order");
  db.transaction(() => {
    const r = nameRow(db, id);
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
    const sizeSent = has("brand") || has("height") || has("length");
    const merged = {
      name: has("name") ? body.name : r.name,
      ignored: has("ignored") ? body.ignored : sizeSent ? false : !!r.ignored,
      brand: has("brand") ? body.brand : r.brand,
      height: has("height") ? body.height : r.height,
      length: has("length") ? body.length : r.length,
    };
    const f = nameFields(merged);
    if (nameTaken(db, f.name_key, id)) throw conflict("That name is already on the list");
    const before = { name: r.name, brand: r.brand, height: r.height, length: r.length, ignored: r.ignored };
    db.prepare(
      `UPDATE drawer_names SET name = ?, name_key = ?, brand = ?, height = ?, length = ?, ignored = ?,
         updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(f.name, f.name_key, f.brand, f.height, f.length, f.ignored, nowIso(), userId(req), id);
    audit.log(req, { action: "drawer_name.update", entityType: "drawer_name", entityId: id, before, after: f });
  })();
  return presentName(nameRow(db, id));
}

function removeName(db, req, id) {
  need(req, "stock.order");
  db.transaction(() => {
    const r = nameRow(db, id);
    db.prepare("DELETE FROM drawer_names WHERE id = ?").run(id);
    audit.log(req, {
      action: "drawer_name.delete",
      entityType: "drawer_name",
      entityId: id,
      before: { name: r.name, brand: r.brand, height: r.height, length: r.length, ignored: r.ignored },
    });
  })();
  return { removed: true };
}

// Distinct unmapped names from the intake payloads of accepted or linked records whose job is
// live and has no ordered (or received) drawer line yet: one entry per name, with the first job
// it was seen on, the total quantity and every job ({jobId, jobName, qty}).
function unmapped(db) {
  const map = nameMap(db);
  const rows = db
    .prepare(
      `SELECT i.payload, j.id AS job_id, j.name AS job_name
       FROM joinr_intake i JOIN jobs j ON j.id = i.job_id
       WHERE i.state IN ('accepted','linked') AND ${LIVE_JOB}
         AND NOT EXISTS (SELECT 1 FROM orders o JOIN order_drawers od ON od.order_id = o.id
                         WHERE o.job_id = j.id AND o.status IN ('ordered','received'))
       ORDER BY j.name COLLATE NOCASE, j.id`
    )
    .all();
  const byKey = new Map();
  for (const r of rows) {
    const p = parseJson(r.payload);
    const entries = normaliseJoinr(p && typeof p === "object" ? p.drawers : null) || [];
    for (const e of entries) {
      const key = nameKey(e.name);
      if (map.has(key)) continue;
      let u = byKey.get(key);
      if (!u) {
        u = { name: e.name, section: e.section, qty: 0, jobId: r.job_id, jobName: r.job_name, jobs: [] };
        byKey.set(key, u);
      }
      u.qty += e.qty;
      const j = u.jobs.find((x) => x.jobId === r.job_id);
      if (j) j.qty += e.qty;
      else u.jobs.push({ jobId: r.job_id, jobName: r.job_name, qty: e.qty });
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// --- settings ----------------------------------------------------------------------------------

function getSettings(db) {
  return { supplierEdge: settings.get(db, SUPPLIER_KEY.edge), supplierDtc: settings.get(db, SUPPLIER_KEY.dtc) };
}

// {supplierEdge?, supplierDtc?}: each sent one is text, 1 to 200 characters (settings.set audits).
function saveSettings(db, req, body) {
  need(req, "stock.order");
  const out = {};
  for (const [field, key] of [["supplierEdge", SUPPLIER_KEY.edge], ["supplierDtc", SUPPLIER_KEY.dtc]]) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.trim() || v.trim().length > SUPPLIER_MAX) {
      throw bad(`${field} must be 1 to ${SUPPLIER_MAX} characters`);
    }
    out[key] = v.trim();
  }
  if (!Object.keys(out).length) throw bad("Send supplierEdge or supplierDtc");
  db.transaction(() => {
    for (const [key, v] of Object.entries(out)) settings.set(db, key, v, req);
  })();
  return getSettings(db);
}

// For the dashboard (section 11.8): drawer lines to order (checked) and waiting for a check, both
// brands, on live jobs.
function summary(db) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(od.checked_at IS NOT NULL), 0) AS to_order, COALESCE(SUM(od.checked_at IS NULL), 0) AS waiting
       FROM orders o
       JOIN order_drawers od ON od.order_id = o.id
       JOIN jobs j ON j.id = o.job_id
       WHERE o.status = 'to_order' AND ${LIVE_JOB}`
    )
    .get();
  return { toOrder: Number(r.to_order), waiting: Number(r.waiting) };
}

module.exports = {
  fillFromJoinr,
  fillForJob,
  forJob,
  createForJob,
  updateGrid,
  setChecked,
  refill,
  board,
  saveStock,
  place,
  placedList,
  placedGet,
  undoPlaced,
  stockReceived,
  names,
  addName,
  updateName,
  removeName,
  unmapped,
  getSettings,
  saveSettings,
  summary,
};
