// Notes on a job: a running list, newest first, each with optional files (docs/plans/jobs-tradify-contracts.md
// section 4.1). Anyone with jobs.view may add; the author edits; the author or an admin soft-deletes.
// Note files live in the private files table (job_note_files), never in photos, so never in the photo library.
const audit = require("./audit");
const files = require("./files");
const { bad, forbidden, notFound, conflict, can } = require("./httperror");

const MAX_BODY = 5000;
const MAX_FILES = 10;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg"]);

function jobExists(db, jobId) {
  if (!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId)) throw notFound();
}

function cleanBody(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  if (typeof b.body !== "string") throw bad("body is required");
  const body = b.body.trim();
  if (body.length < 1 || body.length > MAX_BODY) throw bad(`body must be 1 to ${MAX_BODY} characters`);
  return body;
}

// The live (not deleted) note on this job, or 404.
function liveNote(db, jobId, noteId) {
  const row = db.prepare("SELECT * FROM job_notes WHERE id = ? AND job_id = ? AND deleted_at IS NULL").get(noteId, jobId);
  if (!row) throw notFound();
  return row;
}

function isAuthor(req, row) {
  return Number(row.user_id) === Number(req.user.id);
}

function filesOf(db, noteIds) {
  const m = new Map();
  if (!noteIds.length) return m;
  const rows = db
    .prepare(
      `SELECT jnf.note_id, f.id, f.original_name, f.mime, f.size FROM job_note_files jnf
         JOIN files f ON f.id = jnf.file_id
        WHERE f.removed_at IS NULL AND jnf.note_id IN (${noteIds.map(() => "?").join(",")})
        ORDER BY jnf.added_at ASC, f.id ASC`
    )
    .all(...noteIds);
  for (const f of rows) {
    if (!m.has(f.note_id)) m.set(f.note_id, []);
    m.get(f.note_id).push({
      id: f.id,
      name: f.original_name,
      mime: f.mime,
      size: f.size,
      url: `/api/files/${f.id}`,
      image: IMAGE_MIMES.has(f.mime),
    });
  }
  return m;
}

function present(req, row, fileMap) {
  const mine = isAuthor(req, row);
  return {
    id: row.id,
    jobId: row.job_id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    author: { id: row.user_id, name: row.author_name || "Unknown" },
    files: fileMap.get(row.id) || [],
    canEdit: mine,
    canDelete: mine || can(req, "users.admin"),
  };
}

const SELECT =
  "SELECT n.*, u.display_name AS author_name FROM job_notes n LEFT JOIN users u ON u.id = n.user_id";

function getOne(db, req, jobId, noteId) {
  const row = db.prepare(`${SELECT} WHERE n.id = ? AND n.job_id = ? AND n.deleted_at IS NULL`).get(noteId, jobId);
  if (!row) throw notFound();
  return present(req, row, filesOf(db, [row.id]));
}

function list(db, req, jobId) {
  jobExists(db, jobId);
  const rows = db
    .prepare(`${SELECT} WHERE n.job_id = ? AND n.deleted_at IS NULL ORDER BY n.created_at DESC, n.id DESC`)
    .all(jobId);
  const fm = filesOf(db, rows.map((r) => r.id));
  return rows.map((r) => present(req, r, fm));
}

function add(db, req, jobId, b) {
  const body = cleanBody(b);
  let id;
  db.transaction(() => {
    jobExists(db, jobId);
    id = Number(
      db.prepare("INSERT INTO job_notes (job_id, user_id, body) VALUES (?, ?, ?)").run(jobId, req.user.id, body).lastInsertRowid
    );
    audit.log(req, { action: "job.note_add", entityType: "job_note", entityId: id, after: { jobId, body } });
  })();
  return getOne(db, req, jobId, id);
}

function edit(db, req, jobId, noteId, b) {
  const body = cleanBody(b);
  db.transaction(() => {
    jobExists(db, jobId);
    const row = liveNote(db, jobId, noteId);
    if (!isAuthor(req, row)) throw forbidden();
    db.prepare("UPDATE job_notes SET body = ?, edited_at = ? WHERE id = ?").run(body, new Date().toISOString(), noteId);
    audit.log(req, {
      action: "job.note_edit",
      entityType: "job_note",
      entityId: noteId,
      before: { jobId, body: row.body },
      after: { jobId, body },
    });
  })();
  return getOne(db, req, jobId, noteId);
}

function remove(db, req, jobId, noteId) {
  db.transaction(() => {
    jobExists(db, jobId);
    const row = liveNote(db, jobId, noteId);
    const mine = isAuthor(req, row);
    if (!mine && !can(req, "users.admin")) throw forbidden();
    db.prepare("UPDATE job_notes SET deleted_at = ?, deleted_by = ? WHERE id = ?").run(new Date().toISOString(), req.user.id, noteId);
    for (const f of db.prepare("SELECT file_id FROM job_note_files WHERE note_id = ?").all(noteId)) {
      files.remove(db, f.file_id, req.user.id);
    }
    const before = { jobId, body: row.body, authorId: row.user_id };
    if (!mine) before.byAdmin = true;
    audit.log(req, { action: "job.note_delete", entityType: "job_note", entityId: noteId, before, after: mine ? null : { byAdmin: true } });
  })();
  return { ok: true };
}

// The route calls this before accepting the upload; attachFile repeats it inside the transaction.
function assertCanAttach(db, req, jobId, noteId) {
  jobExists(db, jobId);
  const row = liveNote(db, jobId, noteId);
  if (!isAuthor(req, row)) throw forbidden();
  const n = db
    .prepare(
      "SELECT COUNT(*) AS n FROM job_note_files jnf JOIN files f ON f.id = jnf.file_id WHERE jnf.note_id = ? AND f.removed_at IS NULL"
    )
    .get(noteId).n;
  if (n >= MAX_FILES) throw conflict(`A note can carry at most ${MAX_FILES} files`);
  return row;
}

function attachFile(db, req, jobId, noteId, accepted) {
  db.transaction(() => {
    assertCanAttach(db, req, jobId, noteId);
    const fileId = files.insert(db, accepted, req.user.id);
    db.prepare("INSERT INTO job_note_files (note_id, file_id) VALUES (?, ?)").run(noteId, fileId);
    audit.log(req, {
      action: "job.note_file",
      entityType: "job_note",
      entityId: noteId,
      after: { jobId, fileId, name: accepted.originalName, size: accepted.size },
    });
  })();
  return getOne(db, req, jobId, noteId);
}

function removeFile(db, req, jobId, noteId, fileId) {
  db.transaction(() => {
    jobExists(db, jobId);
    const row = liveNote(db, jobId, noteId);
    const mine = isAuthor(req, row);
    if (!mine && !can(req, "users.admin")) throw forbidden();
    const f = db
      .prepare(
        `SELECT f.* FROM job_note_files jnf JOIN files f ON f.id = jnf.file_id
          WHERE jnf.note_id = ? AND f.id = ? AND f.removed_at IS NULL`
      )
      .get(noteId, fileId);
    if (!f) throw notFound();
    files.remove(db, f.id, req.user.id);
    const before = { jobId, fileId: f.id, name: f.original_name };
    if (!mine) before.byAdmin = true;
    audit.log(req, { action: "job.note_file_remove", entityType: "job_note", entityId: noteId, before });
  })();
  return getOne(db, req, jobId, noteId);
}

// GET /api/files/:id: true when the file is on a live job note (the caller's jobs.view is checked there).
function fileOnLiveNote(db, fileId) {
  return !!db
    .prepare(
      "SELECT 1 FROM job_note_files jnf JOIN job_notes n ON n.id = jnf.note_id WHERE jnf.file_id = ? AND n.deleted_at IS NULL"
    )
    .get(fileId);
}

module.exports = { list, add, edit, remove, assertCanAttach, attachFile, removeFile, fileOnLiveNote, MAX_FILES };
