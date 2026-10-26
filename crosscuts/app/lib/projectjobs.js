// Project jobs (0.2.1, Todd 2026-10-25; docs/plans/m22-project-jobs.md; migration 041).
//
// A job in Projects has one owner (jobs.project_owner_id) and a project page: the hours summary,
// the materials list (job_materials outside the hardware sections) with a colour and finish per line,
// the hardware list (the hardware and handles sections) with brand, code and supplier, and job notes.
// "Finalise order list" freezes the live lines as revision A, B, C... (project_order_lists); "Send to
// Ordering" turns the finalised lines into to_order order lines, grouped by supplier, and marks the
// job sent (jobs.sent_to_ordering_at: the Ordering half of design_ordering, lib/jobstage.js).
//
// Every function takes db first; nothing here requires ../db.
const crypto = require("crypto");
const audit = require("./audit");
const materials = require("./materials");
const jobstage = require("./jobstage");
const { computeEffective } = require("./permissions");
const { HttpError, bad, notFound, conflict } = require("./httperror");
const { sydneyToday } = require("./time");

const HARDWARE_SECTIONS = new Set(["hardware", "handles"]);
const NOTES_MAX = 5000;
const DESCRIPTION_MAX = 500;
const DAY_IDX = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4 };

const nowIso = () => new Date().toISOString();
const userId = (req) => (req && req.user && req.user.id != null ? req.user.id : null);

function requireJob(db, jobId) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw notFound();
  return job;
}

// ---- owners ----------------------------------------------------------------------------------

// Every enabled user holding design.view (the owner holds every key), A to Z, with the linked board
// worker's hue (null when none): [{id, name, hue}].
function owners(db) {
  const users = db
    .prepare(
      `SELECT u.id, u.display_name, u.is_owner, w.hue FROM users u LEFT JOIN workers w ON w.id = u.worker_id
        WHERE u.disabled = 0 ORDER BY u.display_name COLLATE NOCASE, u.id`
    )
    .all();
  const rolesOf = db.prepare("SELECT role FROM user_roles WHERE user_id = ?");
  const overridesOf = db.prepare("SELECT feature_key, effect FROM permission_overrides WHERE user_id = ?");
  return users
    .filter((u) =>
      computeEffective(rolesOf.all(u.id).map((r) => r.role), overridesOf.all(u.id), Number(u.is_owner) === 1).has("design.view")
    )
    .map((u) => ({ id: u.id, name: u.display_name, hue: u.hue == null ? null : u.hue }));
}

// null clears the owner. Anyone else must be in owners(). Throws 400 before anything is written.
function checkOwner(db, v) {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad("ownerId must be a user id or null");
  const o = owners(db).find((u) => u.id === n);
  if (!o) throw bad("The owner must be an active user with Projects access");
  return o;
}

function setOwner(db, req, jobId, v) {
  const owner = checkOwner(db, v);
  return db.transaction(() => {
    const job = requireJob(db, jobId);
    const next = owner ? owner.id : null;
    if (job.project_owner_id === next) return false;
    const before = job.project_owner_id;
    db.prepare("UPDATE jobs SET project_owner_id = ?, updated_at = ? WHERE id = ?").run(next, nowIso(), jobId);
    const prev = before == null ? null : db.prepare("SELECT display_name FROM users WHERE id = ?").get(before);
    audit.log(req, {
      action: "job.owner",
      entityType: "job",
      entityId: jobId,
      before: { ownerId: before, name: prev ? prev.display_name : null },
      after: { ownerId: next, name: owner ? owner.name : null },
    });
    // 0.2.2 (m23-contracts section 3): a Won job given an owner moves to Projects (an audited stage
    // move). A job the board holds stays where it is.
    if (owner && jobstage.pipelineStage(job) === "won") {
      try {
        jobstage.moveStage(db, jobId, { stage: "projects", from: "won" }, req);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
      }
    }
    return true;
  })();
}

// ---- the hours summary -------------------------------------------------------------------------

// Board bookings: one person on one day of a job's week row is one person-day. Days up to and
// including today are "to date", later ones "ahead". The board holds days, not hours.
function bookedDays(db, jobId) {
  const today = sydneyToday();
  const rows = db
    .prepare(
      `SELECT wr.panel, wr.week_start, a.day FROM assignments a JOIN week_rows wr ON wr.id = a.week_row_id
        WHERE wr.job_id = ?`
    )
    .all(jobId);
  const out = { manufacturing: { toDate: 0, ahead: 0 }, installing: { toDate: 0, ahead: 0 } };
  for (const r of rows) {
    const panel = out[r.panel];
    if (!panel || !(r.day in DAY_IDX)) continue;
    const [y, m, d] = r.week_start.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + DAY_IDX[r.day])).toISOString().slice(0, 10);
    if (date <= today) panel.toDate += 1;
    else panel.ahead += 1;
  }
  return out;
}

function hours(db, jobId) {
  const quoted = require("./bonuses").joinrHours(db, jobId);
  return {
    quotedFactoryMin: quoted ? quoted.quotedFactoryMin : null,
    quotedInstallMin: quoted ? quoted.quotedInstallMin : null,
    booked: bookedDays(db, jobId),
  };
}

// ---- the lines -----------------------------------------------------------------------------------

function liveLines(db, jobId) {
  const rows = db.prepare(`${materials.SELECT} WHERE m.job_id = ? AND m.removed_at IS NULL`).all(jobId);
  return materials.sortLines(rows.map(materials.present));
}

// The fields an order list freezes, per line.
const frozen = (l) => ({
  id: l.id,
  section: l.section,
  name: l.name,
  qty: l.qty,
  unit: l.unit,
  colour: l.colour,
  finish: l.finish,
  brand: l.brand,
  code: l.code,
  supplier: l.supplier,
  notes: l.notes,
  hardware: HARDWARE_SECTIONS.has(l.section),
});

function fingerprint(lines) {
  return crypto.createHash("sha256").update(JSON.stringify(lines.map(frozen))).digest("hex");
}

// The lines a finalise refuses: no supplier, or no quantity above 0.
function problemsOf(lines) {
  const out = [];
  for (const l of lines) {
    const missing = [];
    if (!l.supplier) missing.push("supplier");
    if (l.qty == null || !(l.qty > 0)) missing.push("quantity");
    if (missing.length) out.push({ id: l.id, name: l.name, missing });
  }
  return out;
}

const presentList = (r) => ({
  revision: r.revision,
  lineCount: r.line_count,
  finalisedAt: r.finalised_at,
  finalisedBy: r.finalised_by_name || null,
  sentAt: r.sent_at || null,
  sentBy: r.sent_by_name || null,
});

const LIST_SELECT = `SELECT l.*, uf.display_name AS finalised_by_name, us.display_name AS sent_by_name
  FROM project_order_lists l LEFT JOIN users uf ON uf.id = l.finalised_by LEFT JOIN users us ON us.id = l.sent_by`;

function revisions(db, jobId) {
  return db.prepare(`${LIST_SELECT} WHERE l.job_id = ? ORDER BY l.id ASC`).all(jobId);
}

// A, B, ... Z, then AA, AB, ...
function nextRevision(n) {
  let s = "";
  let i = n;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

// ---- the project page ----------------------------------------------------------------------------

// 0.2.2: the latest revision and whether the live lines changed since: {current: rev | null,
// changed: bool | null}. "Order list ready" is a current revision with no change (lib/projectsteps.js).
function listState(db, jobId) {
  const latest = db.prepare(`${LIST_SELECT} WHERE l.job_id = ? ORDER BY l.id DESC LIMIT 1`).get(jobId);
  if (!latest) return { current: null, changed: null };
  return { current: presentList(latest), changed: latest.fingerprint !== fingerprint(liveLines(db, jobId)) };
}

function summary(db, jobId) {
  const steps = require("./projectsteps");
  const job = requireJob(db, jobId);
  const lines = liveLines(db, jobId);
  const revs = revisions(db, jobId);
  const latest = revs.length ? revs[revs.length - 1] : null;
  const changed = latest ? latest.fingerprint !== fingerprint(lines) : null;
  const owner =
    job.project_owner_id == null
      ? null
      : db
          .prepare("SELECT u.id, u.display_name AS name, w.hue FROM users u LEFT JOIN workers w ON w.id = u.worker_id WHERE u.id = ?")
          .get(job.project_owner_id) || null;
  return {
    job: {
      id: job.id,
      name: job.name,
      clientName: job.client_name,
      siteAddress: job.site_address,
      quoteNumber: job.quote_number,
      stage: job.stage,
      pipelineStage: jobstage.pipelineStage(job),
      sentToOrderingAt: job.sent_to_ordering_at || null,
      projectNotes: job.project_notes || "",
      requestedInstallDate: job.requested_install_date || null,
      promisedInstallDate: job.promised_install_date || null,
      owner: owner ? { id: owner.id, name: owner.name, hue: owner.hue == null ? null : owner.hue } : null,
    },
    hours: hours(db, jobId),
    // 0.2.2 (m23-contracts section 2): the steps, their marks and the check measures.
    steps: steps.stepsOf(db, jobId),
    marks: steps.marksOf(db, jobId).marks,
    checkMeasures: steps.checkMeasuresOf(db, jobId),
    materials: lines.filter((l) => !HARDWARE_SECTIONS.has(l.section)),
    hardware: lines.filter((l) => HARDWARE_SECTIONS.has(l.section)),
    sections: materials.SECTIONS,
    problems: problemsOf(lines),
    orderList: {
      current: latest ? presentList(latest) : null,
      changed,
      nextRevision: nextRevision(revs.length),
      revisions: revs.map(presentList),
    },
  };
}

function setNotes(db, req, jobId, v) {
  if (typeof v !== "string") throw bad("notes must be text");
  if (v.length > NOTES_MAX) throw bad(`notes must be ${NOTES_MAX} characters or fewer`);
  return db.transaction(() => {
    const job = requireJob(db, jobId);
    if ((job.project_notes || "") === v) return false;
    db.prepare("UPDATE jobs SET project_notes = ?, updated_at = ? WHERE id = ?").run(v, nowIso(), jobId);
    audit.log(req, {
      action: "job.project_notes",
      entityType: "job",
      entityId: jobId,
      before: { projectNotes: job.project_notes || "" },
      after: { projectNotes: v },
    });
    return true;
  })();
}

// ---- finalise and send -------------------------------------------------------------------------

function finalise(db, req, jobId) {
  return db.transaction(() => {
    requireJob(db, jobId);
    const lines = liveLines(db, jobId);
    if (!lines.length) throw bad("Add materials or hardware before finalising");
    const problems = problemsOf(lines);
    if (problems.length) {
      throw new HttpError(
        400,
        `${problems.length} line${problems.length === 1 ? " needs" : "s need"} a supplier and a quantity before finalising`,
        { problems }
      );
    }
    const revs = revisions(db, jobId);
    const fp = fingerprint(lines);
    const latest = revs.length ? revs[revs.length - 1] : null;
    if (latest && latest.fingerprint === fp) {
      throw conflict(`Nothing has changed since revision ${latest.revision}`);
    }
    const revision = nextRevision(revs.length);
    const info = db
      .prepare(
        `INSERT INTO project_order_lists (job_id, revision, lines_json, line_count, fingerprint, finalised_at, finalised_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(jobId, revision, JSON.stringify(lines.map(frozen)), lines.length, fp, nowIso(), userId(req));
    audit.log(req, {
      action: "project.finalise",
      entityType: "job",
      entityId: jobId,
      after: { revision, listId: Number(info.lastInsertRowid), lineCount: lines.length },
    });
    return summary(db, jobId);
  })();
}

// One revision with its lines, for the print page.
function orderList(db, jobId, revision) {
  const job = requireJob(db, jobId);
  const rev = typeof revision === "string" ? revision.trim().toUpperCase() : "";
  const row = rev && db.prepare(`${LIST_SELECT} WHERE l.job_id = ? AND l.revision = ?`).get(jobId, rev);
  if (!row) throw notFound();
  let lines = [];
  try {
    lines = JSON.parse(row.lines_json);
  } catch (_) {
    lines = [];
  }
  const owner = job.project_owner_id == null ? null : db.prepare("SELECT display_name FROM users WHERE id = ?").get(job.project_owner_id);
  const latest = db.prepare("SELECT revision FROM project_order_lists WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId);
  return {
    job: {
      id: job.id,
      name: job.name,
      clientName: job.client_name,
      siteAddress: job.site_address,
      quoteNumber: job.quote_number,
      owner: owner ? owner.display_name : null,
    },
    ...presentList(row),
    superseded: !!(latest && latest.revision !== row.revision),
    sections: materials.SECTIONS,
    materials: lines.filter((l) => !l.hardware),
    hardware: lines.filter((l) => l.hardware),
  };
}

const fmtQty = (q) => String(Math.round(q * 1000) / 1000);

// "Hinge soft close, Blum 71B3550, 24 each" / "Board, Polytec Black Wenge, Matt, 12 sheets".
function orderDescription(l) {
  const parts = [l.name];
  for (const k of ["brand", "code", "colour", "finish"]) if (l[k]) parts.push(l[k]);
  if (l.qty != null) parts.push(fmtQty(l.qty) + (l.unit ? " " + l.unit : ""));
  const s = parts.join(", ");
  return s.length > DESCRIPTION_MAX ? s.slice(0, DESCRIPTION_MAX) : s;
}

// Needs a finalised latest revision with no changes since. Each frozen line still live and without
// a live order line becomes a to_order order line from its supplier (suppliers A to Z, then the
// list's order); lines already ordered are skipped. The job moves to Ordering (from Won or Projects).
function send(db, req, jobId) {
  const orders = require("./orders");
  return db.transaction(() => {
    const job = requireJob(db, jobId);
    const shown = jobstage.pipelineStage(job);
    // M24: a job already placed on the board (or at Ready to cut) can still send a later revision.
    if (!["won", "projects", "ordering", "on_board", "ready_to_cut"].includes(shown)) {
      throw conflict("Only a job at Won, Projects, Ordering, Ready to cut or On board can be sent to Ordering");
    }
    // 0.2.2 (m23-contracts section 4).
    if (!job.requested_install_date) throw bad("Enter a requested install date before sending to Ordering");
    const revs = revisions(db, jobId);
    const latest = revs.length ? revs[revs.length - 1] : null;
    if (!latest) throw conflict("Finalise the order list first");
    if (latest.fingerprint !== fingerprint(liveLines(db, jobId))) {
      throw conflict(`The list has changed since revision ${latest.revision}. Finalise it again first.`);
    }
    if (latest.sent_at) throw conflict(`Revision ${latest.revision} has already been sent to Ordering`);
    let lines = [];
    try {
      lines = JSON.parse(latest.lines_json);
    } catch (_) {
      lines = [];
    }
    lines = lines
      .map((l, i) => ({ ...l, i }))
      .sort((a, b) => a.supplier.localeCompare(b.supplier, "en", { sensitivity: "base" }) || a.i - b.i);
    const created = [];
    const skipped = [];
    const now = nowIso();
    for (const l of lines) {
      const row = db.prepare(`${materials.SELECT} WHERE m.id = ? AND m.job_id = ? AND m.removed_at IS NULL`).get(l.id, jobId);
      if (!row) continue;
      if (materials.present(row).ordered) {
        skipped.push({ id: l.id, reason: "already ordered" });
        continue;
      }
      const r = orders.createLine(db, jobId, { supplier: l.supplier, description: orderDescription(l), notes: l.notes || "" }, req);
      db.prepare("UPDATE job_materials SET order_id = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(r.order.id, now, userId(req), l.id);
      created.push({ id: l.id, orderId: r.order.id, supplier: l.supplier });
    }
    db.prepare("UPDATE project_order_lists SET sent_at = ?, sent_by = ? WHERE id = ?").run(now, userId(req), latest.id);
    if (shown === "won" || shown === "projects") jobstage.moveStage(db, jobId, { stage: "ordering", from: job.stage }, req);
    // M24 (m24-contracts section 2 and 3): the deposit, then the board row N weeks out.
    const handoff = require("./handoffs").onSent(db, req, jobId);
    const suppliers = [...new Set(created.map((c) => c.supplier))];
    audit.log(req, {
      action: "project.send",
      entityType: "job",
      entityId: jobId,
      after: { revision: latest.revision, created, skipped, suppliers },
    });
    // 0.2.2 (m23-contracts section 5): the order managers are told.
    require("./projectsteps").sentAlert(db, req, jobId, { revision: latest.revision, created: created.length, suppliers });
    return {
      revision: latest.revision,
      created: created.length,
      skipped: skipped.length,
      suppliers,
      depositDue: !!handoff.deposit,
      placed: handoff.placed,
      ...summary(db, jobId),
    };
  })();
}

module.exports = {
  HARDWARE_SECTIONS,
  owners,
  checkOwner,
  setOwner,
  bookedDays,
  summary,
  listState,
  setNotes,
  finalise,
  orderList,
  send,
  orderDescription,
  nextRevision,
};
