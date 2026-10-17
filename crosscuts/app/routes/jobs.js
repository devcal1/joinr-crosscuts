// /api/job-records: the lifecycle job records (client, spec, value, dates, links).
// Contract: docs/plans/m1-contracts.md ("T3: /api/job-records"). Not to be
// confused with the board's /api/jobs routes in routes/schedule.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const audit = require("../lib/audit");
const jobstage = require("../lib/jobstage");
const orders = require("../lib/orders");
const invoices = require("../lib/invoices");
const { HttpError, bad, sendError, can } = require("../lib/httperror");
const { DATE_RE, parseDateUTC, formatDateUTC, sydneyToday } = require("../lib/time");

const r = defineRoutes("/api/job-records");

// Stage lists and rules live in lib/jobstage.js. on_board / complete / invoiced
// are derived (board hooks, accounts), so only users.admin may set them by PATCH.
const { STAGES, STAGE_DATE } = jobstage;
const MANUAL_STAGES = new Set(jobstage.MANUAL_STAGES);
const BENCHTOPS = new Set(["laminate", "stone", "none"]);

// --- field table: body key -> column, kind -------------------------------
// kinds: text, date, int, bool, url, enum:<set>. All are nullable unless noted.
const FIELDS = {
  name: { col: "name", kind: "text", required: true },
  notes: { col: "notes", kind: "notes" },
  archived: { col: "archived", kind: "bool", notNull: true },
  externalRef: { col: "external_ref", kind: "text" },
  clientName: { col: "client_name", kind: "text" },
  clientPhone: { col: "client_phone", kind: "text" },
  clientEmail: { col: "client_email", kind: "text" },
  clientAbn: { col: "client_abn", kind: "text" },
  siteAddress: { col: "site_address", kind: "text" },
  sheetCount: { col: "sheet_count", kind: "int" },
  isTwoPac: { col: "is_two_pac", kind: "bool" },
  benchtop: { col: "benchtop", kind: "enum", set: BENCHTOPS },
  jobType: { col: "job_type", kind: "text" },
  quoteNumber: { col: "quote_number", kind: "text" },
  valueCents: { col: "value_cents", kind: "int", perm: "jobs.value" },
  enquiryDate: { col: "enquiry_date", kind: "date" },
  quotedDate: { col: "quoted_date", kind: "date" },
  wonDate: { col: "won_date", kind: "date" },
  designSignedOffDate: { col: "design_signed_off_date", kind: "date" },
  readyToCutDate: { col: "ready_to_cut_date", kind: "date" },
  promisedInstallDate: { col: "promised_install_date", kind: "date" },
  completedDate: { col: "completed_date", kind: "date" },
  designFolderUrl: { col: "design_folder_url", kind: "url" },
  joinrQuoteUrl: { col: "joinr_quote_url", kind: "url" },
};

function validDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = parseDateUTC(s);
  return !Number.isNaN(d.getTime()) && formatDateUTC(d) === s; // rejects 2026-02-31
}

// Returns the value to store (null allowed) or throws a 400.
function coerce(key, f, v) {
  const nullish = v === null || (typeof v === "string" && v.trim() === "" && f.kind !== "notes");
  if (f.required && (nullish || typeof v !== "string")) throw bad(`${key} is required`);
  if (nullish) {
    if (f.kind === "notes") return ""; // jobs.notes is NOT NULL DEFAULT ''
    if (f.notNull) throw bad(`${key} cannot be empty`);
    return null;
  }
  switch (f.kind) {
    case "text":
      if (typeof v !== "string") throw bad(`${key} must be a string`);
      return v.trim();
    case "notes":
      if (typeof v !== "string") throw bad(`${key} must be a string`);
      return v;
    case "date":
      if (!validDate(v)) throw bad(`${key} must be a valid YYYY-MM-DD date`);
      return v;
    case "int":
      if (!Number.isInteger(v) || v < 0) throw bad(`${key} must be a non-negative integer`);
      return v;
    case "bool":
      if (typeof v !== "boolean" && v !== 0 && v !== 1) throw bad(`${key} must be true or false`);
      return v === true || v === 1 ? 1 : 0;
    case "url":
      if (typeof v !== "string" || !/^https?:\/\/\S+$/i.test(v.trim())) {
        throw bad(`${key} must be an http:// or https:// URL`);
      }
      return v.trim();
    case "enum":
      if (!f.set.has(v)) throw bad(`${key} must be one of ${[...f.set].join(", ")}`);
      return v;
    default:
      throw bad(`${key} is not supported`);
  }
}

// Validate a request body into { col: value } for the keys present. Throws
// HttpError (400 validation, 403 for valueCents without jobs.value).
function parseBody(req, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("JSON body required");
  // Not a plain field: it is set by POST /:id/materials-ordered, which also
  // makes the progress invoice due. It is still returned in the job object.
  if (body.materialsOrderedDate !== undefined) throw bad("Use Materials ordered");
  const out = {};
  for (const [key, f] of Object.entries(FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(body, key) || body[key] === undefined) continue;
    if (f.perm && !can(req, f.perm)) throw new HttpError(403, "Forbidden");
    out[f.col] = coerce(key, f, body[key]);
  }
  return out;
}

function parseStage(req, v) {
  if (typeof v !== "string" || !STAGES.includes(v)) throw bad(`stage must be one of ${STAGES.join(", ")}`);
  if (v === "lead") throw bad(jobstage.RETIRED_STAGE_MSG); // retired 2026-10-17; old rows may still hold it
  if (!MANUAL_STAGES.has(v) && !can(req, "users.admin")) {
    throw bad(`stage '${v}' is set automatically and cannot be changed by hand`);
  }
  return v;
}

// --- output ---------------------------------------------------------------

function camel(col) {
  return col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function toJob(req, row, boardWeeks, inBacklog, people) {
  const showValue = can(req, "jobs.value");
  const out = {};
  for (const [col, v] of Object.entries(row)) {
    if (col === "value_cents" && !showValue) continue;
    out[camel(col)] = v;
  }
  out.archived = !!row.archived;
  out.isTwoPac = row.is_two_pac == null ? null : !!row.is_two_pac;
  out.onBoardWeeks = boardWeeks;
  out.inBacklog = inBacklog;
  out.people = people || [];
  return out;
}

function weeksMap(jobId) {
  const q = jobId == null
    ? db.prepare("SELECT DISTINCT job_id, week_start FROM week_rows ORDER BY week_start ASC")
    : db.prepare("SELECT DISTINCT job_id, week_start FROM week_rows WHERE job_id = ? ORDER BY week_start ASC");
  const rows = jobId == null ? q.all() : q.all(jobId);
  const m = new Map();
  for (const w of rows) {
    if (!m.has(w.job_id)) m.set(w.job_id, []);
    m.get(w.job_id).push(w.week_start);
  }
  return m;
}

function backlogSet(jobId) {
  const rows = jobId == null
    ? db.prepare("SELECT job_id FROM backlog").all()
    : db.prepare("SELECT job_id FROM backlog WHERE job_id = ?").all(jobId);
  return new Set(rows.map((b) => b.job_id));
}

// The names on job tiles (033): job id -> [{userId, name, hue|null}], oldest first. One query for the
// whole list, or for one job. hue is the linked board worker's colour, or null for a login with no worker.
function peopleMap(jobId) {
  const sql =
    "SELECT jp.job_id, jp.user_id, u.display_name, w.hue FROM job_people jp " +
    "JOIN users u ON u.id = jp.user_id LEFT JOIN workers w ON w.id = u.worker_id" +
    (jobId == null ? "" : " WHERE jp.job_id = ?") +
    " ORDER BY jp.added_at ASC, jp.user_id ASC";
  const rows = jobId == null ? db.prepare(sql).all() : db.prepare(sql).all(jobId);
  const m = new Map();
  for (const x of rows) {
    if (!m.has(x.job_id)) m.set(x.job_id, []);
    m.get(x.job_id).push({ userId: x.user_id, name: x.display_name, hue: x.hue == null ? null : x.hue });
  }
  return m;
}

function loadOne(req, id) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  if (!row) return null;
  return toJob(req, row, weeksMap(id).get(id) || [], backlogSet(id).has(id), peopleMap(id).get(id) || []);
}

function parseId(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      if (e && /UNIQUE constraint failed: jobs\.external_ref/.test(e.message)) {
        return res.status(409).json({ error: "externalRef is already used by another job" });
      }
      // 4xx errors (HttpError, or anything with a 4xx status) go to the client,
      // including a 409's extra ({stage}); the rest is a logged 500.
      sendError(res, e, "[job-records]");
    }
  };
}

// --- routes ---------------------------------------------------------------

r.get("/", "jobs.view", handle((req, res) => {
  const where = [];
  const args = [];
  if (req.query.stage !== undefined && req.query.stage !== "") {
    if (!STAGES.includes(req.query.stage)) throw bad(`stage must be one of ${STAGES.join(", ")}`);
    // A job still at the retired 'lead' stage counts as quoted.
    if (req.query.stage === "quoted") where.push("stage IN ('quoted','lead')");
    else {
      where.push("stage = ?");
      args.push(req.query.stage);
    }
  }
  if (req.query.archived !== undefined && req.query.archived !== "") {
    if (req.query.archived !== "0" && req.query.archived !== "1") throw bad("archived must be 0 or 1");
    where.push("archived = ?");
    args.push(Number(req.query.archived));
  }
  const text = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(
      "(name LIKE ? ESCAPE '\\' OR client_name LIKE ? ESCAPE '\\' OR site_address LIKE ? ESCAPE '\\' " +
        "OR external_ref LIKE ? ESCAPE '\\' OR job_type LIKE ? ESCAPE '\\')"
    );
    args.push(like, like, like, like, like);
  }
  const sql =
    "SELECT * FROM jobs" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY name COLLATE NOCASE ASC, id ASC";
  const rows = db.prepare(sql).all(...args);
  const weeks = weeksMap(null);
  const backlog = backlogSet(null);
  const people = peopleMap(null);
  res.json(rows.map((row) => toJob(req, row, weeks.get(row.id) || [], backlog.has(row.id), people.get(row.id) || [])));
}));

r.get("/:id", "jobs.view", handle((req, res) => {
  const id = parseId(req);
  const job = id && loadOne(req, id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
}));

r.post("/", "jobs.edit", handle((req, res) => {
  const body = req.body;
  const values = parseBody(req, body);
  if (!values.name) throw bad("name is required");
  const stage = body.stage === undefined || body.stage === null ? "quoted" : parseStage(req, body.stage);

  // Entry effects of a manual stage (the same as a hand move into it): the
  // stage's key date if the body didn't send one, and archived for the
  // archived stage. Derived stages (admin only) have no effects.
  if (MANUAL_STAGES.has(stage)) {
    const dateCol = STAGE_DATE[stage];
    if (dateCol && !values[dateCol]) values[dateCol] = sydneyToday();
    if (stage === "archived") values.archived = 1;
  }

  const now = new Date().toISOString();
  const id = db.transaction(() => {
    const cols = Object.keys(values);
    const info = db
      .prepare(
        `INSERT INTO jobs (${[...cols, "source", "stage", "stage_changed_at", "updated_at"].join(", ")})
         VALUES (${[...cols.map(() => "?"), "'manual'", "?", "?", "?"].join(", ")})`
      )
      .run(...cols.map((c) => values[c]), stage, now, now);
    const newId = info.lastInsertRowid;
    const after = { ...values, source: "manual", stage };
    // Throws on error, so the whole create rolls back (no silent half-move).
    if (stage === "ready_to_cut" && jobstage.addToBacklog(db, newId)) after.toStart = "added";
    audit.log(req, { action: "job.create", entityType: "job", entityId: newId, after });
    return newId;
  })();
  res.status(201).json(loadOne(req, id));
}));

r.patch("/:id", "jobs.edit", handle((req, res) => {
  const id = parseId(req);
  const existing = id && db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const body = req.body;
  const values = parseBody(req, body);
  if ("name" in values && !values.name) throw bad("name is required");
  const newStage = body.stage === undefined ? undefined : parseStage(req, body.stage);

  db.transaction(() => {
    // Only fields whose value actually changes are written and audited.
    const changed = Object.keys(values).filter((c) => values[c] !== existing[c]);
    if (changed.length) {
      db.prepare(`UPDATE jobs SET ${changed.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
        ...changed.map((c) => values[c]),
        new Date().toISOString(),
        id
      );
      const before = {};
      const after = {};
      for (const c of changed) {
        before[c] = existing[c];
        after[c] = values[c];
      }
      audit.log(req, { action: "job.update", entityType: "job", entityId: id, before, after });
      // An invoice waiting for a value falls due once the job has one.
      if (changed.includes("value_cents") && values.value_cents != null) invoices.onValueSet(db, id, req);
    }
    if (newStage !== undefined) {
      if (MANUAL_STAGES.has(newStage)) {
        // The pipeline rules, key dates, archived link and To start effects.
        // No `from` check; users.admin may also leave on_board (when it has no
        // current or future rows), complete and invoiced. A same-stage PATCH
        // does nothing. Throws on a rule break, rolling back the field update.
        jobstage.moveStage(db, id, { stage: newStage }, req, { override: can(req, "users.admin") });
      } else {
        // A derived stage (users.admin only; parseStage refused everyone else):
        // the admin's hand override, as in M2. A ready_to_cut job leaves To start
        // (unless it has current or future rows), in the same transaction.
        const removed = existing.stage === "ready_to_cut" && jobstage.removeFromBacklog(db, id);
        const auditExtra = removed ? { toStart: "removed" } : undefined;
        if (newStage === "complete" && existing.stage !== "invoiced") {
          // Same as Finish week -> Complete: completed_date, and the final invoice
          // falls due. A completedDate sent in the same PATCH is kept.
          // (invoiced -> complete is an admin override: plain setStage.)
          jobstage.onFinishedComplete(db, id, req, values.completed_date || undefined, auditExtra);
        } else {
          jobstage.setStage(db, id, newStage, req, undefined, auditExtra);
        }
        // Leaving the archived stage unticks archived (the stage and the checkbox are linked).
        if (existing.stage === "archived" && newStage !== "archived") {
          const now = db.prepare("SELECT archived FROM jobs WHERE id = ?").get(id);
          if (now && Number(now.archived) === 1) {
            db.prepare("UPDATE jobs SET archived = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
            audit.log(req, {
              action: "job.update",
              entityType: "job",
              entityId: id,
              before: { archived: 1 },
              after: { archived: 0 },
            });
          }
        }
      }
    }
  })();
  res.json(loadOne(req, id));
}));

// A hand move of the stage (pipeline). The pipeline rules apply to everyone,
// admin included (the admin's override is PATCH). `from` is the stage the page
// last saw; a mismatch is a 409 with the real stage.
r.post("/:id/stage", "jobs.edit", handle((req, res) => {
  const id = parseId(req);
  if (!id) return res.status(404).json({ error: "Not found" });
  const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  if (b.from === undefined) throw bad("from is required");
  if (b.from !== null && typeof b.from !== "string") throw bad("from must be a stage name or null");
  jobstage.moveStage(db, id, { stage: b.stage, from: b.from }, req);
  res.json(loadOne(req, id));
}));

// "Materials ordered": sets materials_ordered_date and makes the progress
// invoice due (orders.markMaterialsOrdered; the M3 orders path calls it too).
r.post("/:id/materials-ordered", "orders.mark_ordered", handle((req, res) => {
  const id = parseId(req);
  const existing = id && db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const date = b.date === undefined || b.date === null || b.date === "" ? sydneyToday() : b.date;
  if (!validDate(date)) throw bad("date must be a valid YYYY-MM-DD date");
  // The update, audit and invoice hook live in lib/orders.js (M3), shared with
  // the orders path. It returns false when the date was already set.
  if (!orders.markMaterialsOrdered(db, id, req, date)) throw new HttpError(409, "Materials already marked ordered");
  res.json(loadOne(req, id));
}));

// Names on job tiles (033). Anyone with jobs.edit adds or removes their own name; users.admin removes
// anyone's. Everyone with jobs.view sees them (the list and the job carry "people").
r.post("/:id/people", "jobs.edit", handle((req, res) => {
  const id = parseId(req);
  const job = id && db.prepare("SELECT id, name FROM jobs WHERE id = ?").get(id);
  if (!job) return res.status(404).json({ error: "Not found" });
  const me = req.user && Number.isInteger(req.user.id) ? req.user.id : null;
  if (me == null) throw bad("Sign in to add your name");
  const info = db
    .prepare("INSERT OR IGNORE INTO job_people (job_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)")
    .run(id, me, me, new Date().toISOString());
  if (info.changes) {
    audit.log(req, {
      action: "job.person_add",
      entityType: "job",
      entityId: id,
      before: null,
      after: { userId: me, name: req.user.displayName },
    });
  }
  res.status(info.changes ? 201 : 200).json(loadOne(req, id));
}));

r.delete("/:id/people/:userId", ["jobs.edit", "users.admin"], handle((req, res) => {
  const id = parseId(req);
  const job = id && db.prepare("SELECT id FROM jobs WHERE id = ?").get(id);
  if (!job) return res.status(404).json({ error: "Not found" });
  const target = Number(req.params.userId);
  if (!Number.isInteger(target) || target <= 0) return res.status(404).json({ error: "Not found" });
  const me = req.user && Number.isInteger(req.user.id) ? req.user.id : null;
  // Your own name needs jobs.edit (or users.admin); someone else's needs users.admin.
  if (target === me ? !(can(req, "jobs.edit") || can(req, "users.admin")) : !can(req, "users.admin")) {
    throw new HttpError(403, "Forbidden");
  }
  const row = db
    .prepare("SELECT u.display_name FROM job_people jp JOIN users u ON u.id = jp.user_id WHERE jp.job_id = ? AND jp.user_id = ?")
    .get(id, target);
  if (row) {
    db.prepare("DELETE FROM job_people WHERE job_id = ? AND user_id = ?").run(id, target);
    audit.log(req, {
      action: "job.person_remove",
      entityType: "job",
      entityId: id,
      before: { userId: target, name: row.display_name },
      after: null,
    });
  }
  res.json(loadOne(req, id));
}));

module.exports = r.router;
