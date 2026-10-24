// Benchtop designer (0.2.0, docs/plans/m21-benchtop-designer.md): one plan per job, its pieces in
// design_json, the printed revisions (A, B, C...) frozen as snapshots, and the admin lists of
// materials and edge finishes. Every function takes db first. Every write runs in one
// db.transaction with its audit row. The routes declare only the coarse access value.
const audit = require("./audit");
const { bad, notFound, conflict } = require("./httperror");

const SHAPES = { straight: 1, l: 2, u: 3, leg: 0 };
const EDGE_COUNT = { straight: 4, l: 6, u: 8, leg: 4 };
const CUTOUT_KINDS = ["sink", "cooktop", "tap", "other"];
const LINE_STYLES = ["heavy", "thin", "double", "dashed", "dotted"];
const MAX_PIECES = 30;

const now = () => new Date().toISOString();

function letterFor(seq) {
  let s = "";
  let n = seq;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// --- validation ----------------------------------------------------------------------------------

function int(v, lo, hi, what) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
    throw bad(`${what} must be a whole number of mm from ${lo} to ${hi}`);
  }
  return v;
}

function str(v, max, what, { required = false } = {}) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw bad(`${what} must be text`);
  const s = v.trim();
  if (s.length > max) throw bad(`${what} is too long (at most ${max})`);
  if (required && !s) throw bad(`${what} is required`);
  return s;
}

function obj(v, what) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`${what} must be an object`);
  return v;
}

function runLength(piece, run) {
  return piece.runs[run].len;
}

// The design as typed on the designer, checked and normalised. Unknown keys are dropped.
function cleanDesign(db, raw) {
  const d = obj(raw, "design");
  if (!Array.isArray(d.pieces)) throw bad("design.pieces must be a list");
  if (d.pieces.length > MAX_PIECES) throw bad(`At most ${MAX_PIECES} pieces`);
  const matIds = new Set(db.prepare("SELECT id FROM benchtop_materials").all().map((r) => r.id));
  const finIds = new Set(db.prepare("SELECT id FROM benchtop_edge_finishes").all().map((r) => r.id));
  const ids = new Set();
  const pieces = d.pieces.map((p0, i) => {
    const p = obj(p0, `piece ${i + 1}`);
    const what = `Piece ${i + 1}`;
    if (typeof p.id !== "string" || !/^[a-z0-9]{1,12}$/.test(p.id) || ids.has(p.id)) throw bad(`${what}: a bad id`);
    ids.add(p.id);
    if (!Object.prototype.hasOwnProperty.call(SHAPES, p.shape)) throw bad(`${what}: shape must be straight, l, u or leg`);
    const out = { id: p.id, name: str(p.name, 80, `${what} name`), shape: p.shape };
    if (p.materialId === null || p.materialId === undefined) out.materialId = null;
    else if (!matIds.has(p.materialId)) throw bad(`${what}: unknown material`);
    else out.materialId = p.materialId;
    if (p.shape === "leg") {
      const leg = obj(p.leg, `${what} leg`);
      out.leg = {
        width: int(leg.width, 50, 3000, `${what} width`),
        height: int(leg.height, 50, 3000, `${what} height`),
        attachTo: leg.attachTo == null || leg.attachTo === "" ? null : str(leg.attachTo, 12, `${what} attached piece`),
        end: leg.end === "end" ? "end" : "start",
      };
      out.runs = [];
    } else {
      if (!Array.isArray(p.runs) || p.runs.length !== SHAPES[p.shape]) throw bad(`${what}: ${SHAPES[p.shape]} run(s) needed`);
      out.runs = p.runs.map((r, k) => {
        const rr = obj(r, `${what} run ${k + 1}`);
        return { len: int(rr.len, 50, 10000, `${what} run ${k + 1} length`), depth: int(rr.depth, 50, 2000, `${what} run ${k + 1} depth`) };
      });
      if (p.shape === "l" && (out.runs[0].len <= out.runs[1].depth || out.runs[1].len <= out.runs[0].depth)) {
        throw bad(`${what}: each run must be longer than the other run's depth`);
      }
      if (p.shape === "u") {
        const [b, l, r] = out.runs;
        if (b.len <= l.depth + r.depth || l.len <= b.depth || r.len <= b.depth) {
          throw bad(`${what}: the runs must be longer than the depths they meet`);
        }
      }
    }
    const edges = {};
    const e0 = p.edges === undefined || p.edges === null ? {} : obj(p.edges, `${what} edges`);
    for (const [k, v] of Object.entries(e0)) {
      const m = /^e(\d)$/.exec(k);
      if (!m || Number(m[1]) >= EDGE_COUNT[p.shape]) throw bad(`${what}: unknown edge ${k}`);
      if (v === null) continue;
      if (!finIds.has(v)) throw bad(`${what}: unknown edge finish`);
      edges[k] = v;
    }
    out.edges = edges;
    const joins = p.joins == null ? [] : p.joins;
    if (!Array.isArray(joins) || joins.length > 10) throw bad(`${what}: at most 10 joins`);
    out.joins = p.shape === "leg" ? [] : joins.map((j0) => {
      const j = obj(j0, `${what} join`);
      if (!Number.isInteger(j.run) || j.run < 0 || j.run >= out.runs.length) throw bad(`${what}: a join on an unknown run`);
      const len = runLength(out, j.run);
      return { run: j.run, at: int(j.at, 1, len - 1, `${what} join position`) };
    });
    const cuts = p.cutouts == null ? [] : p.cutouts;
    if (!Array.isArray(cuts) || cuts.length > 20) throw bad(`${what}: at most 20 cut-outs`);
    out.cutouts = cuts.map((c0) => {
      const c = obj(c0, `${what} cut-out`);
      if (!CUTOUT_KINDS.includes(c.kind)) throw bad(`${what}: cut-out kind must be sink, cooktop, tap or other`);
      const m = typeof c.edge === "string" ? /^e(\d)$/.exec(c.edge) : null;
      if (!m || Number(m[1]) >= EDGE_COUNT[p.shape]) throw bad(`${what}: a cut-out needs a reference edge`);
      const w = int(c.w, 10, 3000, `${what} cut-out size`);
      return {
        kind: c.kind,
        label: str(c.label, 40, `${what} cut-out label`),
        w,
        h: c.kind === "tap" ? w : int(c.h, 10, 3000, `${what} cut-out size`),
        edge: c.edge,
        along: int(c.along, 0, 10000, `${what} cut-out distance along`),
        in: int(c.in, 0, 3000, `${what} cut-out distance in`),
      };
    });
    return out;
  });
  for (const p of pieces) {
    if (p.shape === "leg" && p.leg.attachTo !== null && !pieces.some((q) => q.id === p.leg.attachTo && q.shape !== "leg")) {
      throw bad("A waterfall leg is joined to a piece that is not in the plan");
    }
  }
  return { pieces };
}

// --- reads ---------------------------------------------------------------------------------------

function jobOr404(db, jobId) {
  const job = db.prepare("SELECT id, name, archived, client_name, site_address FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw notFound();
  return job;
}

function jobShape(job) {
  return {
    id: job.id,
    name: job.name,
    clientName: job.client_name || "",
    siteAddress: job.site_address || "",
    archived: Number(job.archived) !== 0,
  };
}

function revisionsOf(db, planId) {
  return db
    .prepare(
      `SELECT r.seq, r.letter, r.printed_at, u.display_name AS by_name
       FROM benchtop_plan_revisions r LEFT JOIN users u ON u.id = r.printed_by
       WHERE r.plan_id = ? ORDER BY r.seq DESC`
    )
    .all(planId)
    .map((r) => ({ letter: r.letter, printedAt: r.printed_at, printedBy: r.by_name || null }));
}

function contentKey(design, notes) {
  return JSON.stringify({ design, notes });
}

function latestSnapshot(db, planId) {
  const r = db.prepare("SELECT * FROM benchtop_plan_revisions WHERE plan_id = ? ORDER BY seq DESC LIMIT 1").get(planId);
  return r ? { row: r, snap: JSON.parse(r.snapshot_json) } : null;
}

function planShape(db, row) {
  const job = jobOr404(db, row.job_id);
  const design = JSON.parse(row.design_json);
  const last = latestSnapshot(db, row.id);
  return {
    id: row.id,
    job: jobShape(job),
    design,
    notes: row.notes,
    updatedAt: row.updated_at,
    revision: last ? last.row.letter : null,
    changedSinceRevision: last ? contentKey(last.snap.design, last.snap.notes) !== contentKey(design, row.notes) : true,
    revisions: revisionsOf(db, row.id),
  };
}

function planRowOr404(db, id) {
  const row = db.prepare("SELECT * FROM benchtop_plans WHERE id = ?").get(id);
  if (!row) throw notFound();
  return row;
}

function get(db, id) {
  return planShape(db, planRowOr404(db, id));
}

function forJob(db, jobId) {
  const job = jobOr404(db, jobId);
  const row = db.prepare("SELECT * FROM benchtop_plans WHERE job_id = ?").get(jobId);
  return { job: jobShape(job), plan: row ? planShape(db, row) : null };
}

function list(db) {
  return db
    .prepare(
      `SELECT p.id, p.job_id, p.design_json, p.updated_at, j.name AS job_name, j.archived,
         (SELECT letter FROM benchtop_plan_revisions r WHERE r.plan_id = p.id ORDER BY seq DESC LIMIT 1) AS letter
       FROM benchtop_plans p JOIN jobs j ON j.id = p.job_id
       ORDER BY p.updated_at DESC`
    )
    .all()
    .map((r) => ({
      id: r.id,
      jobId: r.job_id,
      jobName: r.job_name,
      archived: Number(r.archived) !== 0,
      pieces: (JSON.parse(r.design_json).pieces || []).length,
      revision: r.letter || null,
      updatedAt: r.updated_at,
    }));
}

// --- writes --------------------------------------------------------------------------------------

function create(db, req, jobId, b) {
  const job = jobOr404(db, jobId);
  if (Number(job.archived) !== 0) throw conflict("The job is archived");
  const design = cleanDesign(db, b.design === undefined ? { pieces: [] } : b.design);
  const notes = str(b.notes, 4000, "Notes");
  const id = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM benchtop_plans WHERE job_id = ?").get(jobId)) throw conflict("This job already has a benchtop plan");
    const t = now();
    const uid = req.user ? req.user.id : null;
    const info = db
      .prepare("INSERT INTO benchtop_plans (job_id, design_json, notes, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(jobId, JSON.stringify(design), notes, t, uid, t, uid);
    const newId = Number(info.lastInsertRowid);
    audit.log(req, { action: "benchtop_plan.create", entityType: "benchtop_plan", entityId: newId, after: { jobId, design, notes } });
    return newId;
  })();
  return get(db, id);
}

function update(db, req, id, b) {
  const row = planRowOr404(db, id);
  const job = jobOr404(db, row.job_id);
  if (Number(job.archived) !== 0) throw conflict("The job is archived");
  if (b.expectUpdatedAt !== undefined && b.expectUpdatedAt !== row.updated_at) {
    throw conflict("Someone else has changed this plan. Reload to see their changes.");
  }
  const design = cleanDesign(db, b.design);
  const notes = str(b.notes, 4000, "Notes");
  db.transaction(() => {
    db.prepare("UPDATE benchtop_plans SET design_json = ?, notes = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .run(JSON.stringify(design), notes, now(), req.user ? req.user.id : null, id);
    audit.log(req, {
      action: "benchtop_plan.update",
      entityType: "benchtop_plan",
      entityId: id,
      before: { design: JSON.parse(row.design_json), notes: row.notes },
      after: { design, notes },
    });
  })();
  return get(db, id);
}

// Print: if the plan changed since its last revision (or has none), freeze it as the next letter.
function print(db, req, id, business) {
  const row = planRowOr404(db, id);
  const design = JSON.parse(row.design_json);
  if (!design.pieces.length) throw bad("Add a piece before printing");
  return db.transaction(() => {
    const last = latestSnapshot(db, id);
    if (last && contentKey(last.snap.design, last.snap.notes) === contentKey(design, row.notes)) {
      return { letter: last.row.letter, created: false };
    }
    const seq = last ? last.row.seq + 1 : 1;
    const letter = letterFor(seq);
    const t = now();
    const used = new Set(design.pieces.map((p) => p.materialId).filter((v) => v != null));
    const materials = {};
    for (const m of db.prepare("SELECT * FROM benchtop_materials").all()) if (used.has(m.id)) materials[m.id] = materialShape(m);
    const finishes = {};
    for (const f of db.prepare("SELECT * FROM benchtop_edge_finishes").all()) finishes[f.id] = finishShape(f);
    const job = jobShape(jobOr404(db, row.job_id));
    const snap = { letter, date: t, job, design, notes: row.notes, materials, finishes, business };
    db.prepare("INSERT INTO benchtop_plan_revisions (plan_id, seq, letter, snapshot_json, printed_at, printed_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, seq, letter, JSON.stringify(snap), t, req.user ? req.user.id : null);
    audit.log(req, { action: "benchtop_plan.revision", entityType: "benchtop_plan", entityId: id, after: { letter } });
    return { letter, created: true };
  })();
}

function revision(db, id, letter) {
  planRowOr404(db, id);
  const r = db.prepare("SELECT * FROM benchtop_plan_revisions WHERE plan_id = ? AND letter = ?").get(id, letter);
  if (!r) throw notFound();
  const by = r.printed_by ? db.prepare("SELECT display_name FROM users WHERE id = ?").get(r.printed_by) : null;
  const pages = db.prepare("SELECT letter FROM benchtop_plan_revisions WHERE plan_id = ? ORDER BY seq DESC LIMIT 1").get(id);
  return { planId: id, ...JSON.parse(r.snapshot_json), printedBy: by ? by.display_name : null, latest: pages.letter === letter };
}

// --- the admin lists -----------------------------------------------------------------------------

function materialShape(m) {
  return { id: m.id, supplier: m.supplier, range: m.range_name, colour: m.colour, thickness: m.thickness_mm, active: m.active === 1 };
}

function finishShape(f) {
  return { id: f.id, code: f.code, name: f.name, lineStyle: f.line_style, sort: f.sort, active: f.active === 1 };
}

function lists(db) {
  return {
    materials: db.prepare("SELECT * FROM benchtop_materials ORDER BY supplier, range_name, colour, thickness_mm").all().map(materialShape),
    finishes: db.prepare("SELECT * FROM benchtop_edge_finishes ORDER BY sort, id").all().map(finishShape),
    lineStyles: LINE_STYLES,
  };
}

function cleanMaterial(b, partial) {
  const out = {};
  if (!partial || b.supplier !== undefined) out.supplier = str(b.supplier, 120, "Supplier", { required: true });
  if (!partial || b.range !== undefined) out.range_name = str(b.range, 120, "Range");
  if (!partial || b.colour !== undefined) out.colour = str(b.colour, 120, "Colour", { required: true });
  if (!partial || b.thickness !== undefined) {
    if (!Number.isInteger(b.thickness) || b.thickness < 5 || b.thickness > 200) throw bad("Thickness must be a whole number of mm from 5 to 200");
    out.thickness_mm = b.thickness;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") throw bad("active must be true or false");
    out.active = b.active ? 1 : 0;
  }
  return out;
}

function cleanFinish(b, partial) {
  const out = {};
  if (!partial || b.code !== undefined) out.code = str(b.code, 12, "Code", { required: true }).toUpperCase();
  if (!partial || b.name !== undefined) out.name = str(b.name, 80, "Name", { required: true });
  if (!partial || b.lineStyle !== undefined) {
    if (!LINE_STYLES.includes(b.lineStyle)) throw bad("Line style must be one of " + LINE_STYLES.join(", "));
    out.line_style = b.lineStyle;
  }
  if (b.sort !== undefined) {
    if (!Number.isInteger(b.sort) || b.sort < 0 || b.sort > 999) throw bad("sort must be 0 to 999");
    out.sort = b.sort;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") throw bad("active must be true or false");
    out.active = b.active ? 1 : 0;
  }
  return out;
}

const LIST_TABLES = {
  materials: { table: "benchtop_materials", clean: cleanMaterial, shape: materialShape, entity: "benchtop_material" },
  finishes: { table: "benchtop_edge_finishes", clean: cleanFinish, shape: finishShape, entity: "benchtop_finish" },
};

function listCreate(db, req, kind, b) {
  const L = LIST_TABLES[kind];
  const c = L.clean(b, false);
  const t = now();
  const cols = Object.keys(c);
  const id = db.transaction(() => {
    const info = db
      .prepare(`INSERT INTO ${L.table} (${cols.join(", ")}, created_at, updated_at) VALUES (${cols.map(() => "?").join(", ")}, ?, ?)`)
      .run(...cols.map((k) => c[k]), t, t);
    const newId = Number(info.lastInsertRowid);
    audit.log(req, { action: `${L.entity}.create`, entityType: L.entity, entityId: newId, after: c });
    return newId;
  })();
  return L.shape(db.prepare(`SELECT * FROM ${L.table} WHERE id = ?`).get(id));
}

function listUpdate(db, req, kind, id, b) {
  const L = LIST_TABLES[kind];
  const before = db.prepare(`SELECT * FROM ${L.table} WHERE id = ?`).get(id);
  if (!before) throw notFound();
  const c = L.clean(b, true);
  const cols = Object.keys(c);
  if (!cols.length) throw bad("Nothing to change");
  db.transaction(() => {
    db.prepare(`UPDATE ${L.table} SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...cols.map((k) => c[k]), now(), id);
    audit.log(req, { action: `${L.entity}.update`, entityType: L.entity, entityId: id, before: L.shape(before), after: c });
  })();
  return L.shape(db.prepare(`SELECT * FROM ${L.table} WHERE id = ?`).get(id));
}

module.exports = { letterFor, cleanDesign, get, forJob, list, create, update, print, revision, lists, listCreate, listUpdate, LINE_STYLES };
