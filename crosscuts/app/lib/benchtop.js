// Benchtop designer (0.2.0, docs/plans/m21-benchtop-designer.md): one plan per job, its pieces in
// design_json, the printed revisions (A, B, C...) frozen as snapshots, and the admin lists of
// materials and edge finishes. Every function takes db first. Every write runs in one
// db.transaction with its audit row. The routes declare only the coarse access value.
const audit = require("./audit");
const { bad, notFound, conflict } = require("./httperror");

const SHAPES = { straight: 1, l: 2, lr: 2, u: 3 };
const EDGE_COUNT = { straight: 4, l: 6, lr: 6, u: 8 };
// The end edges of each shape: the only edges a waterfall finish may go on.
const END_EDGES = { straight: ["e1", "e3"], l: ["e1", "e4"], lr: ["e2", "e5"], u: ["e2", "e6"] };
// The internal (concave) corners of each shape, by vertex index: no radius there (Todd, 2026-10-25).
const INTERNAL_CORNERS = { straight: [], l: [3], lr: [4], u: [4, 5] };

// The edge lengths of a cleaned piece, in outline order (as public/benchtopdraw.js outline()).
function edgeLengths(p) {
  const R = p.runs;
  let pts;
  if (p.shape === "straight") pts = [[0, 0], [R[0].len, 0], [R[0].len, R[0].depth], [0, R[0].depth]];
  else if (p.shape === "l") {
    const [A, D1, B, D2] = [R[0].len, R[0].depth, R[1].len, R[1].depth];
    pts = [[0, 0], [A, 0], [A, D1], [D2, D1], [D2, B], [0, B]];
  } else if (p.shape === "lr") {
    const [A, D1, B, D2] = [R[0].len, R[0].depth, R[1].len, R[1].depth];
    pts = [[0, 0], [A, 0], [A, B], [A - D2, B], [A - D2, D1], [0, D1]];
  } else {
    const [A, D2, B1, D1, B2, D3] = [R[0].len, R[0].depth, R[1].len, R[1].depth, R[2].len, R[2].depth];
    pts = [[0, 0], [A, 0], [A, B2], [A - D3, B2], [A - D3, D2], [D1, D2], [D1, B1], [0, B1]];
  }
  return pts.map((a, i) => { const b = pts[(i + 1) % pts.length]; return Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])); });
}
const CUTOUT_KINDS = ["sink", "cooktop", "tap", "other"];
const LINE_STYLES = ["heavy", "thin", "double", "dashed", "dotted"];
// The finish marks drawn across an edge (Todd, 2026-10-25): X unfinished, // finished seen, [] square.
const MARKS = ["X", "//", "[]"];
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
  const fins = new Map(db.prepare("SELECT id, waterfall FROM benchtop_edge_finishes").all().map((r) => [r.id, r.waterfall === 1]));
  const ids = new Set();
  const pieces = d.pieces.map((p0, i) => {
    const p = obj(p0, `piece ${i + 1}`);
    const what = `Piece ${letterFor(i + 1)}`;
    if (typeof p.id !== "string" || !/^[a-z0-9]{1,12}$/.test(p.id) || ids.has(p.id)) throw bad(`${what}: a bad id`);
    ids.add(p.id);
    if (!Object.prototype.hasOwnProperty.call(SHAPES, p.shape)) throw bad(`${what}: shape must be straight, l, lr or u`);
    const out = { id: p.id, name: str(p.name, 80, `${what} name`), shape: p.shape };
    if (p.materialId === null || p.materialId === undefined) out.materialId = null;
    else if (!matIds.has(p.materialId)) throw bad(`${what}: unknown material`);
    else out.materialId = p.materialId;
    {
      if (!Array.isArray(p.runs) || p.runs.length !== SHAPES[p.shape]) throw bad(`${what}: ${SHAPES[p.shape]} run(s) needed`);
      out.runs = p.runs.map((r, k) => {
        const rr = obj(r, `${what} run ${k + 1}`);
        return { len: int(rr.len, 50, 10000, `${what} run ${k + 1} length`), depth: int(rr.depth, 50, 2000, `${what} run ${k + 1} depth`) };
      });
      if ((p.shape === "l" || p.shape === "lr") && (out.runs[0].len <= out.runs[1].depth || out.runs[1].len <= out.runs[0].depth)) {
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
      if (!fins.has(v)) throw bad(`${what}: unknown edge finish`);
      edges[k] = v;
    }
    out.edges = edges;
    // Waterfall finishes: only on end edges, each with its drop height.
    const drops = {};
    const d0 = p.drops === undefined || p.drops === null ? {} : obj(p.drops, `${what} drops`);
    for (const [k, v] of Object.entries(edges)) {
      if (!fins.get(v)) continue;
      if (!END_EDGES[p.shape].includes(k)) throw bad(`${what}: a waterfall goes on an end edge`);
      drops[k] = int(d0[k], 50, 1500, `${what} waterfall drop`);
    }
    out.drops = drops;
    // Edges built up to a thickness other than the material's (drawn bold), e.g. 40 mm.
    const thick = {};
    const t0 = p.thick === undefined || p.thick === null ? {} : obj(p.thick, `${what} edge thickness`);
    for (const [k, v] of Object.entries(t0)) {
      const mm = /^e(\d)$/.exec(k);
      if (!mm || Number(mm[1]) >= EDGE_COUNT[p.shape]) throw bad(`${what}: unknown edge ${k}`);
      if (v === null) continue;
      thick[k] = int(v, 5, 200, `${what} edge thickness`);
    }
    out.thick = thick;
    // The one reference edge every located cut-out on this piece is measured from.
    const dm = typeof p.datum === "string" ? /^e(\d)$/.exec(p.datum) : null;
    if (p.datum != null && (!dm || Number(dm[1]) >= EDGE_COUNT[p.shape])) throw bad(`${what}: unknown reference edge`);
    out.datum = p.datum == null ? "e0" : p.datum;
    // Corner radii {cN: mm}: external corners only, 1 to half the shorter of the two edges that
    // meet there (so two rounded corners on one edge never meet). 0 or null = square.
    const radii = {};
    const r0 = p.radii === undefined || p.radii === null ? {} : obj(p.radii, `${what} corner radii`);
    const lens = edgeLengths(out);
    for (const [k, v] of Object.entries(r0)) {
      const cm = /^c([0-9])$/.exec(k);
      if (!cm || Number(cm[1]) >= EDGE_COUNT[p.shape]) throw bad(`${what}: unknown corner ${k}`);
      if (v === null || v === 0) continue;
      const i = Number(cm[1]);
      if (INTERNAL_CORNERS[p.shape].includes(i)) throw bad(`${what}: a radius goes on an external corner only`);
      const max = Math.floor(Math.min(lens[i], lens[(i - 1 + lens.length) % lens.length]) / 2);
      radii[k] = int(v, 1, max, `${what} corner radius`);
    }
    out.radii = radii;
    // Where the piece sits in the All view (mm).
    out.x = p.x == null ? 0 : int(p.x, -50000, 50000, `${what} position`);
    out.y = p.y == null ? 0 : int(p.y, -50000, 50000, `${what} position`);
    const joins = p.joins == null ? [] : p.joins;
    if (!Array.isArray(joins) || joins.length > 10) throw bad(`${what}: at most 10 joins`);
    out.joins = joins.map((j0) => {
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
      const w = int(c.w, 10, 3000, `${what} cut-out size`);
      return {
        kind: c.kind,
        label: str(c.label, 40, `${what} cut-out label`),
        w,
        h: c.kind === "tap" ? w : int(c.h, 10, 3000, `${what} cut-out size`),
        edge: out.datum,
        located: c.located === true,
        along: int(c.along, 0, 10000, `${what} cut-out distance along`),
        in: int(c.in, 0, 3000, `${what} cut-out distance in`),
      };
    });
    return out;
  });
  return { pieces };
}

// Plans drawn before 2026-10-24 may hold waterfall leg pieces (unreleased); they are dropped on read.
function withoutLegs(d) {
  return { pieces: (d.pieces || []).filter((p) => p.shape !== "leg") };
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
  const design = withoutLegs(JSON.parse(row.design_json));
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
  const design = withoutLegs(JSON.parse(row.design_json));
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
  return { id: f.id, code: f.code, name: f.name, mark: f.mark, lineStyle: f.line_style, sort: f.sort, waterfall: f.waterfall === 1, active: f.active === 1 };
}

function lists(db) {
  return {
    materials: db.prepare("SELECT * FROM benchtop_materials ORDER BY supplier, range_name, colour, thickness_mm").all().map(materialShape),
    finishes: db.prepare("SELECT * FROM benchtop_edge_finishes ORDER BY sort, id").all().map(finishShape),
    marks: MARKS,
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
  if (!partial || b.mark !== undefined) {
    if (!MARKS.includes(b.mark)) throw bad("Mark must be one of " + MARKS.join(" "));
    out.mark = b.mark;
  }
  if (b.lineStyle !== undefined) {
    if (!LINE_STYLES.includes(b.lineStyle)) throw bad("Line style must be one of " + LINE_STYLES.join(", "));
    out.line_style = b.lineStyle;
  } else if (!partial) {
    out.line_style = "thin";
  }
  if (b.waterfall !== undefined) {
    if (typeof b.waterfall !== "boolean") throw bad("waterfall must be true or false");
    out.waterfall = b.waterfall ? 1 : 0;
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
