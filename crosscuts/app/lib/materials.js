// A job's Materials list (docs/plans/materials-contracts.md; migration 034_job_materials.sql).
//
// Lines are prefilled from the Joinr won-quote payload and a person can override, add and remove
// them; selected lines can be turned into to_order order lines. Every Joinr-sourced line is
// written through ONE function, fillFromJoinr(), whatever the entry point (Accept, Link, the
// automatic decision, the job page's "Fill from Joinr" and "Update materials from Joinr").
//
// Sync rules (fillFromJoinr is a merge, so it is safe to run again):
//   - a Joinr line is matched by its joinr_key;
//   - a new key is added; a removed line (removed_at) is never brought back;
//   - a line a person edited (overridden) is never touched;
//   - any other Joinr line is refreshed from the quote;
//   - a Joinr line the quote no longer has is marked gone_from_joinr ("No longer in Joinr"), never
//     deleted, unless a person has overridden it.
// Manual lines are never touched by a sync.
const audit = require("./audit");
const joinrQuote = require("./joinr-quote");
const { bad, notFound, conflict } = require("./httperror");

// The sections a typed line may use, in the order the page lists them.
const SECTIONS = [
  { id: "boards", label: "Boards" },
  { id: "edging", label: "Edging" },
  { id: "doors", label: "Doors and panels" },
  { id: "benchtop", label: "Benchtop" },
  { id: "handles", label: "Handles" },
  { id: "hardware", label: "Hardware" },
  { id: "drawers", label: "Drawers" },
  { id: "room_extras", label: "Room extras" },
  { id: "paint", label: "Paint and finish" },
  { id: "other", label: "Other" },
];
const SECTION_IDS = new Set(SECTIONS.map((s) => s.id));
const SECTION_ORDER = new Map(SECTIONS.map((s, i) => [s.id, i]));

const NAME_MAX = 300;
const UNIT_MAX = 30;
const NOTES_MAX = 1000;
const SECTION_MAX = 40;
const QTY_MAX = 1000000;
const LINES_MAX = 500;
const KEY_MAX = 400;
const ORDER_IDS_MAX = 200;
const SUPPLIER_MAX = 200;

const nowIso = () => new Date().toISOString();
const userId = (req) => (req && req.user && req.user.id != null ? req.user.id : null);

// ---- reading ---------------------------------------------------------------------------------

function requireJob(db, jobId) {
  const job = db.prepare("SELECT id, name FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw notFound();
  return job;
}

const SELECT = `SELECT m.*, o.status AS order_status
                  FROM job_materials m LEFT JOIN orders o ON o.id = m.order_id`;

// The line as the API shows it. `ordered` is true while its order line is not cancelled.
function present(r) {
  const ordered = r.order_id != null && r.order_status != null && r.order_status !== "cancelled";
  return {
    id: r.id,
    jobId: r.job_id,
    position: r.position,
    section: r.section,
    name: r.name,
    qty: r.qty,
    unit: r.unit,
    notes: r.notes,
    source: r.source,
    overridden: !!r.overridden,
    // JOINR (as the quote has it), EDITED (a Joinr line a person changed) or TYPED (added by hand).
    origin: r.source === "manual" ? "typed" : r.overridden ? "edited" : "joinr",
    goneFromJoinr: !!r.gone_from_joinr,
    orderId: r.order_id,
    orderStatus: r.order_status || null,
    ordered,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function sortLines(rows) {
  const rank = (s) => (SECTION_ORDER.has(s) ? SECTION_ORDER.get(s) : SECTIONS.length);
  return rows.sort((a, b) => rank(a.section) - rank(b.section) || a.position - b.position || a.id - b.id);
}

// The job's latest decided Joinr record, if any: what the page needs to offer Fill/Update.
function joinrRecord(db, jobId) {
  return db
    .prepare(
      `SELECT id, quote_number, changed, state, joinr_status, last_event FROM joinr_intake
        WHERE job_id = ? AND state IN ('accepted','linked') ORDER BY id DESC LIMIT 1`
    )
    .get(jobId);
}

function list(db, jobId) {
  requireJob(db, jobId);
  const rows = db.prepare(`${SELECT} WHERE m.job_id = ? AND m.removed_at IS NULL`).all(jobId);
  const lines = sortLines(rows.map(present));
  const rec = joinrRecord(db, jobId);
  const hasJoinrLines = lines.some((l) => l.source === "joinr");
  return {
    lines,
    sections: SECTIONS,
    joinr: {
      linked: !!rec,
      quoteNumber: rec ? rec.quote_number : null,
      changed: !!(rec && rec.changed),
      hasJoinrLines,
    },
  };
}

// ---- validation ------------------------------------------------------------------------------

function textOf(label, v, max, { required = false } = {}) {
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

function qtyOf(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > QTY_MAX) throw bad(`qty must be a number from 0 to ${QTY_MAX}`);
  return Math.round(n * 1000) / 1000;
}

function sectionOf(v) {
  if (typeof v !== "string" || !SECTION_IDS.has(v)) {
    throw bad(`section must be one of ${SECTIONS.map((s) => s.id).join(", ")}`);
  }
  return v;
}

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function loadLine(db, jobId, id) {
  const n = parseId(id);
  const row = n && db.prepare(`${SELECT} WHERE m.id = ? AND m.job_id = ? AND m.removed_at IS NULL`).get(n, jobId);
  if (!row) throw notFound();
  return row;
}

function nextPosition(db, jobId) {
  return db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM job_materials WHERE job_id = ?").get(jobId).p;
}

function liveCount(db, jobId) {
  return db.prepare("SELECT COUNT(*) AS n FROM job_materials WHERE job_id = ? AND removed_at IS NULL").get(jobId).n;
}

const auditShape = (r) => ({
  section: r.section,
  name: r.name,
  qty: r.qty,
  unit: r.unit,
  notes: r.notes,
});

// ---- typed lines -----------------------------------------------------------------------------

function create(db, req, jobId, body) {
  requireJob(db, jobId);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("JSON body required");
  const section = body.section === undefined || body.section === null ? "other" : sectionOf(body.section);
  const name = textOf("name", body.name, NAME_MAX, { required: true });
  const qty = qtyOf(body.qty);
  const unit = textOf("unit", body.unit, UNIT_MAX) || null;
  const notes = textOf("notes", body.notes, NOTES_MAX);
  return db.transaction(() => {
    if (liveCount(db, jobId) >= LINES_MAX) throw bad(`A job's materials list holds at most ${LINES_MAX} lines`);
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO job_materials (job_id, position, section, name, qty, unit, notes, source, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`
      )
      .run(jobId, nextPosition(db, jobId), section, name, qty, unit, notes, now, now, userId(req), userId(req));
    const id = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "material.create",
      entityType: "job_material",
      entityId: id,
      after: { jobId, ...auditShape({ section, name, qty, unit, notes }) },
    });
    return present(db.prepare(`${SELECT} WHERE m.id = ?`).get(id));
  })();
}

// patch: any of section, name, qty, unit, notes. Editing a Joinr line marks it overridden.
function update(db, req, jobId, id, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("JSON body required");
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined;
  const line = loadLine(db, jobId, id);
  const next = {};
  if (has("section")) {
    // A Joinr line may carry a section the typed list does not offer; sending it back unchanged is fine.
    next.section = patch.section === line.section ? line.section : sectionOf(patch.section);
  }
  if (has("name")) next.name = textOf("name", patch.name, NAME_MAX, { required: true });
  if (has("qty")) next.qty = qtyOf(patch.qty);
  if (has("unit")) next.unit = textOf("unit", patch.unit, UNIT_MAX) || null;
  if (has("notes")) next.notes = textOf("notes", patch.notes, NOTES_MAX);
  const changes = {};
  for (const [k, v] of Object.entries(next)) if (v !== line[k]) changes[k] = v;
  if (!Object.keys(changes).length) return present(line);
  return db.transaction(() => {
    const sets = Object.keys(changes);
    const makeOverridden = line.source === "joinr" && !line.overridden;
    const cols = [...sets.map((c) => `${c} = ?`), "updated_at = ?", "updated_by = ?"];
    const args = [...sets.map((c) => changes[c]), nowIso(), userId(req)];
    if (makeOverridden) cols.push("overridden = 1");
    db.prepare(`UPDATE job_materials SET ${cols.join(", ")} WHERE id = ?`).run(...args, line.id);
    const before = {};
    const after = {};
    for (const c of sets) {
      before[c] = line[c];
      after[c] = changes[c];
    }
    if (makeOverridden) {
      before.overridden = false;
      after.overridden = true;
    }
    audit.log(req, { action: "material.update", entityType: "job_material", entityId: line.id, before, after });
    return present(db.prepare(`${SELECT} WHERE m.id = ?`).get(line.id));
  })();
}

// A soft remove. A line whose order line is still live stays: cancel the order line first.
function remove(db, req, jobId, id) {
  const line = loadLine(db, jobId, id);
  if (present(line).ordered) throw conflict("This line has been turned into an order line. Cancel that order line first.");
  db.transaction(() => {
    const now = nowIso();
    db.prepare("UPDATE job_materials SET removed_at = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(
      now,
      now,
      userId(req),
      line.id
    );
    audit.log(req, {
      action: "material.remove",
      entityType: "job_material",
      entityId: line.id,
      before: { jobId, source: line.source, ...auditShape(line) },
    });
  })();
  return { ok: true };
}

// ---- Joinr lines -----------------------------------------------------------------------------

function parsePayload(payload) {
  let p = payload;
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch (_) {
      p = null;
    }
  }
  return p && typeof p === "object" && !Array.isArray(p) ? p : {};
}

const cut = (s, n) => (s.length > n ? s.slice(0, n) : s);
const textList = (v) => {
  const seen = new Set();
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const s of v) {
    if (typeof s !== "string") continue;
    const t = s.trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(cut(t, NAME_MAX));
    if (out.length >= 60) break;
  }
  return out;
};

// What the won-quote payload (contract version 1/2) carries today, as materials lines:
// [{key, section, name, qty, unit, notes}]. The key is stable for the same content, so a re-sync
// matches the line it made before.
//
// J4 (contract version 4, 2026-10-18): when the job's Joinr record has a quote snapshot
// (lib/joinr-quote.js), its materials lines (boards and edging, benchtops, handles, hardware, room
// extras, drawers and the additional items; never labour) replace the thin "Board sheets" and
// `drawers` stand-ins below, one line per room, section and item. The text lines for doors,
// benchtops and two-pac stay: the quote's lines do not carry them. Money figures never go into this
// table; they have their own job-page section, shown only to jobs.value holders. With no quote
// (quote null, an older Joinr) the thin mapping is used as before.
function linesFromPayload(payload, quote) {
  const p = parsePayload(payload);
  const spec = p.spec && typeof p.spec === "object" ? p.spec : {};
  const raw = p.raw && typeof p.raw === "object" ? p.raw : {};
  const out = [];
  const byKey = new Map();
  const add = (key, section, name, qty, unit, notes) => {
    const k = cut(key, KEY_MAX);
    const q = typeof qty === "number" && Number.isFinite(qty) && qty >= 0 && qty <= QTY_MAX ? Math.round(qty * 1000) / 1000 : null;
    const have = byKey.get(k);
    if (have) {
      if (q !== null) have.qty = (have.qty || 0) + q;
      return;
    }
    const line = { key: k, section, name: cut(name, NAME_MAX), qty: q, unit: unit || null, notes: notes || "" };
    byKey.set(k, line);
    out.push(line);
  };

  // Sheets: spec.sheetCount, a whole number (the sum of the quote's board sheets, rounded up).
  const sheets = typeof spec.sheetCount === "number" && Number.isFinite(spec.sheetCount) && spec.sheetCount > 0 ? Math.ceil(spec.sheetCount) : null;
  if (sheets !== null && !quote) add("sheets", "boards", "Board sheets", sheets, "sheets", "");

  // Doors/panels, as typed in each room.
  for (const t of textList(raw.doorsPanels)) add("doors:" + t.toLowerCase(), "doors", t, null, null, "");

  // The benchtop kind, then each room's benchtop as typed.
  if (spec.benchtop === "laminate" || spec.benchtop === "stone") {
    add("benchtop-kind", "benchtop", "Benchtop: " + (spec.benchtop === "stone" ? "stone" : "laminate"), null, null, "");
  }
  for (const t of textList(raw.benchtops)) add("benchtop:" + t.toLowerCase(), "benchtop", t, null, null, "");

  // A two-pac finish.
  if (spec.twoPac === true) add("twopac", "paint", "Two-pac finish", null, null, "");

  // Drawer lines (contract version 2): the quote's drawers and inner drawers, with their counts.
  if (Array.isArray(p.drawers) && !quote) {
    for (const d of p.drawers) {
      if (!d || typeof d !== "object") continue;
      const sec = d.section === "innerDrawers" ? "innerDrawers" : d.section === "drawers" ? "drawers" : null;
      const name = typeof d.name === "string" ? d.name.trim() : "";
      const qty = typeof d.qty === "number" && Number.isFinite(d.qty) && d.qty > 0 ? d.qty : null;
      if (!sec || !name || qty === null) continue;
      add(`drawers:${sec}:${name.toLowerCase()}`, "drawers", name, qty, "each", sec === "innerDrawers" ? "Inner drawers" : "");
    }
  }

  // The whole quote: one line per room, section and item (joinr-quote.materialLines).
  if (quote) {
    for (const l of joinrQuote.materialLines(quote)) add(l.key, l.section, l.name, l.qty, l.unit, l.notes);
  }
  return out;
}

// Merges the quote's lines into the job's list (see the rules at the top). `payload` is the
// stored joinr_intake.payload (a JSON string) or its parsed object. `req` may be a request or
// intake.SYSTEM_REQ. Returns {added, updated, gone, kept, removedKept} counts.
function fillFromJoinr(db, jobId, payload, req, opts = {}) {
  const desired = linesFromPayload(payload, opts.quote || null);
  const action = opts.action || "material.fill";
  return db.transaction(() => {
    requireJob(db, jobId);
    const existing = db.prepare("SELECT * FROM job_materials WHERE job_id = ? AND source = 'joinr'").all(jobId);
    const byKey = new Map(existing.map((r) => [r.joinr_key, r]));
    const seen = new Set();
    const stat = { added: 0, updated: 0, gone: 0, kept: 0, removedKept: 0 };
    const ids = { added: [], updated: [], gone: [] };
    const now = nowIso();
    const uid = userId(req);
    let pos = nextPosition(db, jobId);
    let total = liveCount(db, jobId);
    for (const d of desired) {
      seen.add(d.key);
      const ex = byKey.get(d.key);
      if (!ex) {
        if (total >= LINES_MAX) continue;
        const info = db
          .prepare(
            `INSERT INTO job_materials (job_id, position, section, name, qty, unit, notes, source, joinr_key, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'joinr', ?, ?, ?, ?, ?)`
          )
          .run(jobId, pos++, d.section, d.name, d.qty, d.unit, d.notes, d.key, now, now, uid, uid);
        stat.added += 1;
        total += 1;
        ids.added.push(Number(info.lastInsertRowid));
      } else if (ex.removed_at) {
        stat.removedKept += 1;
      } else if (ex.overridden) {
        stat.kept += 1;
      } else if (
        ex.section !== d.section || ex.name !== d.name || ex.qty !== d.qty || ex.unit !== d.unit || ex.notes !== d.notes || ex.gone_from_joinr
      ) {
        db.prepare(
          `UPDATE job_materials SET section = ?, name = ?, qty = ?, unit = ?, notes = ?, gone_from_joinr = 0, updated_at = ?, updated_by = ? WHERE id = ?`
        ).run(d.section, d.name, d.qty, d.unit, d.notes, now, uid, ex.id);
        stat.updated += 1;
        ids.updated.push(ex.id);
      }
    }
    for (const ex of existing) {
      if (seen.has(ex.joinr_key) || ex.removed_at || ex.overridden || ex.gone_from_joinr) continue;
      db.prepare("UPDATE job_materials SET gone_from_joinr = 1, updated_at = ?, updated_by = ? WHERE id = ?").run(now, uid, ex.id);
      stat.gone += 1;
      ids.gone.push(ex.id);
    }
    if (stat.added || stat.updated || stat.gone) {
      audit.log(req, {
        action,
        entityType: "job",
        entityId: jobId,
        after: { ...stat, lineIds: ids },
      });
    }
    return stat;
  })();
}

// The job page's "Fill from Joinr" and "Update materials from Joinr": merges the job's Joinr
// record (its latest stored payload) into the list.
function syncFromJoinr(db, req, jobId, { action = "material.fill" } = {}) {
  requireJob(db, jobId);
  const rec = db
    .prepare("SELECT id, payload FROM joinr_intake WHERE job_id = ? AND state IN ('accepted','linked') ORDER BY id DESC LIMIT 1")
    .get(jobId);
  if (!rec) throw conflict("This job is not tied to a Joinr quote");
  // J4: the latest quote snapshot (null when Joinr sent none or too large a one: the thin mapping).
  const snap = joinrQuote.latest(db, rec.id);
  const summary = fillFromJoinr(db, jobId, rec.payload, req, { action, quote: snap ? snap.quote : null });
  return { summary, ...list(db, jobId) };
}

// ---- feeding Ordering ------------------------------------------------------------------------

function fmtQty(q) {
  return String(Math.round(q * 1000) / 1000);
}

// "Board sheets, 24 sheets" (the name, then the quantity and unit when it has them).
function orderDescription(l) {
  const q = l.qty == null ? "" : fmtQty(l.qty) + (l.unit ? " " + l.unit : "");
  return cut(q ? `${l.name}, ${q}` : l.name, 500);
}

// Turns the chosen, not-yet-ordered lines into to_order order lines on the job (never automatic).
// body: {ids: [line id], supplier?: text (blank leaves the supplier to be chosen on the order)}.
// A line that already has a live order line is skipped (so a second press adds nothing); a line
// whose order line was cancelled gets a new one. Each new order line is a plain to_order line: it
// never marks anything ordered (the all-ordered rule runs only when a line is marked ordered, and
// a new to_order line stops it holding).
function toOrders(db, req, jobId, body) {
  const orders = require("./orders");
  requireJob(db, jobId);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("JSON body required");
  if (!Array.isArray(body.ids) || !body.ids.length) throw bad("ids must list the lines to order");
  if (body.ids.length > ORDER_IDS_MAX) throw bad(`Order at most ${ORDER_IDS_MAX} lines at a time`);
  const ids = [];
  for (const v of body.ids) {
    const n = parseId(v);
    if (!n) throw bad("ids must be line ids");
    if (!ids.includes(n)) ids.push(n);
  }
  const supplier = textOf("supplier", body.supplier, SUPPLIER_MAX);
  return db.transaction(() => {
    const created = [];
    const skipped = [];
    let state = null;
    for (const id of ids) {
      const row = db.prepare(`${SELECT} WHERE m.id = ? AND m.job_id = ? AND m.removed_at IS NULL`).get(id, jobId);
      if (!row) throw notFound();
      if (present(row).ordered) {
        skipped.push({ id, reason: "already ordered" });
        continue;
      }
      const r = orders.createLine(
        db,
        jobId,
        { supplier, description: orderDescription(row), notes: row.notes },
        req,
        { blankSupplier: true }
      );
      db.prepare("UPDATE job_materials SET order_id = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(
        r.order.id,
        nowIso(),
        userId(req),
        id
      );
      created.push({ id, orderId: r.order.id });
      state = r.job;
    }
    if (created.length) {
      audit.log(req, {
        action: "material.to_order",
        entityType: "job",
        entityId: jobId,
        after: { supplier: supplier || null, lines: created },
      });
    }
    return { created, skipped, job: state, ...list(db, jobId) };
  })();
}

module.exports = {
  SECTIONS,
  list,
  create,
  update,
  remove,
  fillFromJoinr,
  syncFromJoinr,
  toOrders,
  linesFromPayload,
  orderDescription,
};
