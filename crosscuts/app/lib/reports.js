// The report library: monthly accounting reports (bank reconciliation, BAS and so on)
// filed by month. See docs/plans/m4-contracts.md sections 2 and 4.
//
// A report is one row in `reports` plus one private file (lib/files.js). Viewing is
// `accounts.view`, uploading and editing `reports.upload`; the uploader or an admin may
// edit or remove (decision 3). Removal is soft and also removes the file, so
// GET /api/files/:id answers 404 afterwards.
const audit = require("./audit");
const files = require("./files");
const { bad, notFound, forbidden } = require("./httperror");
const { sydneyToday } = require("./time");

const CATEGORIES = ["bank_reconciliation", "bas", "payroll", "aged_debtors", "other"];
const CATEGORY_LABELS = {
  bank_reconciliation: "Bank reconciliation",
  bas: "BAS",
  payroll: "Payroll",
  aged_debtors: "Aged debtors",
  other: "Other",
};
const TITLE_MAX = 200;
const NOTES_MAX = 2000;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const SELECT_REPORT = `SELECT r.*,
    ru.display_name AS report_by_name,
    f.id AS f_id, f.original_name AS f_original_name, f.size AS f_size, f.mime AS f_mime,
    f.uploaded_by AS f_uploaded_by, f.uploaded_at AS f_uploaded_at, fu.display_name AS f_uploaded_by_name
  FROM reports r
  JOIN files f ON f.id = r.file_id
  LEFT JOIN users ru ON ru.id = r.uploaded_by
  LEFT JOIN users fu ON fu.id = f.uploaded_by`;

function isAdmin(user) {
  return !!user && Array.isArray(user.roles) && user.roles.includes("admin");
}

function canEditRow(user, row) {
  return !!user && (isAdmin(user) || (row.uploaded_by != null && row.uploaded_by === user.id));
}

// The report object (contracts section 4).
function present(row, user) {
  return {
    id: row.id,
    period: row.period,
    category: row.category,
    title: row.title,
    notes: row.notes,
    file: files.toFile({
      id: row.f_id,
      original_name: row.f_original_name,
      size: row.f_size,
      mime: row.f_mime,
      uploaded_at: row.f_uploaded_at,
      uploaded_by: row.f_uploaded_by,
      uploaded_by_name: row.f_uploaded_by_name,
    }),
    uploadedBy: row.uploaded_by == null ? null : { id: row.uploaded_by, name: row.report_by_name || "Unknown" },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canEdit: canEditRow(user, row),
  };
}

function loadLive(db, id) {
  return db.prepare(`${SELECT_REPORT} WHERE r.id = ? AND r.removed_at IS NULL`).get(id);
}

function str(v, what) {
  if (typeof v !== "string") throw bad(`${what} must be text`);
  return v;
}

function checkPeriod(v) {
  const period = str(v, "Month").trim();
  if (!PERIOD_RE.test(period)) throw bad("Month must look like 2026-09");
  if (period > sydneyToday().slice(0, 7)) throw bad("Month can't be in the future");
  return period;
}
function checkCategory(v) {
  const category = str(v, "Category");
  if (!CATEGORIES.includes(category)) throw bad(`Category must be one of ${CATEGORIES.join(", ")}`);
  return category;
}
function checkTitle(v) {
  const title = str(v, "Title").trim();
  if (!title) throw bad("Title is required");
  if (title.length > TITLE_MAX) throw bad(`Title must be at most ${TITLE_MAX} characters`);
  return title;
}
function checkNotes(v) {
  const notes = str(v, "Notes").trim();
  if (notes.length > NOTES_MAX) throw bad(`Notes must be at most ${NOTES_MAX} characters`);
  return notes;
}

// {rows, years}. Filters: year (YYYY) and category. Newest period first, then category, then title.
function list(db, user, { year, category } = {}) {
  const where = ["r.removed_at IS NULL", "f.removed_at IS NULL"];
  const params = [];
  if (year !== undefined && year !== null && year !== "") {
    if (typeof year !== "string" || !/^\d{4}$/.test(year)) throw bad("year must be a four-digit year");
    where.push("substr(r.period, 1, 4) = ?");
    params.push(year);
  }
  if (category !== undefined && category !== null && category !== "") {
    if (typeof category !== "string" || !CATEGORIES.includes(category)) {
      throw bad(`category must be one of ${CATEGORIES.join(", ")}`);
    }
    where.push("r.category = ?");
    params.push(category);
  }
  const rows = db
    .prepare(`${SELECT_REPORT} WHERE ${where.join(" AND ")} ORDER BY r.period DESC, r.category, r.title, r.id`)
    .all(...params)
    .map((r) => present(r, user));
  const years = db
    .prepare(
      `SELECT DISTINCT substr(r.period, 1, 4) AS y FROM reports r JOIN files f ON f.id = r.file_id
       WHERE r.removed_at IS NULL AND f.removed_at IS NULL ORDER BY y DESC`
    )
    .all()
    .map((r) => r.y);
  return { rows, years };
}

// fields: {period, category, title, notes?} (strings from the multipart form). `accepted` is the
// result of files.accept. One transaction with files.insert. The caller discards the accepted
// file when this throws. Returns the report object.
function create(db, req, fields, accepted) {
  const f = fields || {};
  const period = checkPeriod(f.period);
  const category = checkCategory(f.category);
  const title = checkTitle(f.title);
  const notes = f.notes === undefined || f.notes === null ? "" : checkNotes(f.notes);
  const user = req.user;
  const id = db.transaction(() => {
    const fileId = files.insert(db, accepted, user.id);
    const info = db
      .prepare("INSERT INTO reports (period, category, title, notes, file_id, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(period, category, title, notes, fileId, user.id);
    const newId = Number(info.lastInsertRowid);
    audit.log(req, {
      action: "report.create",
      entityType: "report",
      entityId: newId,
      after: { period, category, title, notes, fileId, fileName: accepted.originalName, size: accepted.size },
    });
    return newId;
  })();
  return present(loadLive(db, id), user);
}

// fields: any of {period, category, title, notes}. 404 unknown or removed, 403 not the
// uploader or an admin. Audited with the changed columns only.
function update(db, req, id, fields) {
  const f = fields || {};
  return db.transaction(() => {
    const row = loadLive(db, id);
    if (!row) throw notFound();
    if (!canEditRow(req.user, row)) throw forbidden();
    const next = {};
    if (f.period !== undefined) next.period = checkPeriod(f.period);
    if (f.category !== undefined) next.category = checkCategory(f.category);
    if (f.title !== undefined) next.title = checkTitle(f.title);
    if (f.notes !== undefined) next.notes = checkNotes(f.notes);
    if (!Object.keys(next).length) throw bad("Nothing to change");
    const before = {};
    const after = {};
    for (const k of Object.keys(next)) {
      if (next[k] !== row[k]) {
        before[k] = row[k];
        after[k] = next[k];
      }
    }
    if (Object.keys(after).length) {
      db.prepare(
        `UPDATE reports SET ${Object.keys(after).map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
      ).run(...Object.values(after), new Date().toISOString(), id);
      audit.log(req, { action: "report.update", entityType: "report", entityId: id, before, after });
    }
    return present(loadLive(db, id), req.user);
  })();
}

// Soft remove: the report and its file. The file stays on disk.
function remove(db, req, id) {
  db.transaction(() => {
    const row = loadLive(db, id);
    if (!row) throw notFound();
    if (!canEditRow(req.user, row)) throw forbidden();
    db.prepare("UPDATE reports SET removed_at = ?, removed_by = ? WHERE id = ?").run(
      new Date().toISOString(),
      req.user.id,
      id
    );
    files.remove(db, row.file_id, req.user.id);
    audit.log(req, {
      action: "report.remove",
      entityType: "report",
      entityId: id,
      before: { period: row.period, category: row.category, title: row.title, fileName: row.f_original_name },
    });
  })();
}

module.exports = { CATEGORIES, CATEGORY_LABELS, list, create, update, remove };
