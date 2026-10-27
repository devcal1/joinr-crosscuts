// Job issues (0.2.4, docs/plans/m25-contracts.md section 4): a problem a workshop person raises on a
// job from the shift page. On raise, the job's project owner (or, with no owner, every design.view
// holder) and every board.edit holder get a bell alert, and the issue is posted to the Workshop
// channel. Open issues show on the job page, the project page, My projects and Needs install date.
// The project owner, a board.edit holder or an admin resolves it.
//
// Every function takes db first; nothing here requires ../db.
const audit = require("./audit");
const notify = require("./notify");
const { can, bad, notFound, forbidden } = require("./httperror");

const BODY_MAX = 2000;
const RESOLUTION_MAX = 2000;
const userId = (req) => (req && req.user && req.user.id != null ? req.user.id : null);

function short(text, n = 80) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function parseIds(v) {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a.filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

function canResolve(db, req, jobId) {
  if (can(req, "users.admin") || can(req, "board.edit")) return true;
  const job = db.prepare("SELECT project_owner_id FROM jobs WHERE id = ?").get(jobId);
  return !!job && job.project_owner_id != null && Number(job.project_owner_id) === Number(userId(req));
}

const SELECT_ISSUE = `SELECT i.*, j.name AS job_name, ru.display_name AS raised_name, su.display_name AS resolved_name
  FROM job_issues i JOIN jobs j ON j.id = i.job_id
  LEFT JOIN users ru ON ru.id = i.raised_by LEFT JOIN users su ON su.id = i.resolved_by`;

function present(db, req, row) {
  const ids = parseIds(row.photo_ids);
  const photos = ids.length
    ? db
        .prepare(`SELECT id, filename, thumb_filename FROM photos WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
        .all(...ids)
        .map((p) => ({ id: p.id, url: `/photos/${p.filename}`, thumbUrl: `/photos/${p.thumb_filename}` }))
    : [];
  return {
    id: row.id,
    jobId: row.job_id,
    jobName: row.job_name,
    body: row.body,
    photos,
    raisedBy: row.raised_by == null ? null : { id: row.raised_by, name: row.raised_name },
    raisedAt: row.raised_at,
    status: row.status,
    resolvedBy: row.resolved_by == null ? null : { id: row.resolved_by, name: row.resolved_name },
    resolvedAt: row.resolved_at || null,
    resolution: row.resolution || null,
    canResolve: row.status === "open" && canResolve(db, req, row.job_id),
  };
}

// Open issues first (newest first), then resolved ones (newest first).
function listFor(db, req, jobId) {
  if (!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId)) throw notFound();
  const rows = db
    .prepare(`${SELECT_ISSUE} WHERE i.job_id = ? ORDER BY (i.status = 'open') DESC, i.raised_at DESC, i.id DESC`)
    .all(jobId);
  return rows.map((r) => present(db, req, r));
}

function openCount(db, jobId) {
  return db.prepare("SELECT COUNT(*) AS n FROM job_issues WHERE job_id = ? AND status = 'open'").get(jobId).n;
}

// Who hears about an issue: the owner (else design.view holders) and board.edit holders.
function recipients(db, job) {
  const ids = new Set();
  if (job.project_owner_id != null) ids.add(Number(job.project_owner_id));
  else for (const id of notify.usersWithKey(db, "design.view")) ids.add(Number(id));
  for (const id of notify.usersWithKey(db, "board.edit")) ids.add(Number(id));
  return [...ids];
}

// body: {body, photoIds?}. photoIds must be photos of this job. Returns the issue.
function raise(db, req, jobId, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("JSON body required");
  if (typeof body.body !== "string" || !body.body.trim()) throw bad("Say what the issue is");
  const text = body.body.trim();
  if (text.length > BODY_MAX) throw bad(`An issue is ${BODY_MAX.toLocaleString("en-AU")} characters at most`);
  let photoIds = [];
  if (body.photoIds !== undefined && body.photoIds !== null) {
    if (!Array.isArray(body.photoIds) || !body.photoIds.every((n) => Number.isInteger(n) && n > 0)) {
      throw bad("photoIds must be a list of photo ids");
    }
    photoIds = [...new Set(body.photoIds)];
  }
  return db.transaction(() => {
    const job = db.prepare("SELECT id, name, project_owner_id, archived FROM jobs WHERE id = ?").get(jobId);
    if (!job) throw notFound();
    if (job.archived) throw bad("That job is archived");
    for (const pid of photoIds) {
      const p = db.prepare("SELECT job_id FROM photos WHERE id = ?").get(pid);
      if (!p || Number(p.job_id) !== Number(jobId)) throw bad("A photo on an issue must be one of this job's photos");
    }
    const now = new Date().toISOString();
    const info = db
      .prepare("INSERT INTO job_issues (job_id, body, photo_ids, raised_by, raised_at) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, text, JSON.stringify(photoIds), userId(req), now);
    const id = Number(info.lastInsertRowid);
    audit.log(req, { action: "issue.raise", entityType: "job_issue", entityId: id, after: { jobId, body: text, photoIds } });
    const me = userId(req);
    notify.toUsers(
      db,
      recipients(db, job).filter((u) => me === null || u !== Number(me)),
      {
        kind: "job.issue",
        title: `Issue on ${job.name}: ${short(text)}`,
        body: req.user && req.user.displayName ? `Raised by ${req.user.displayName}` : undefined,
        link: `/job.html?id=${jobId}#issues`,
        entityType: "job",
        entityId: jobId,
      }
    );
    // The Workshop channel (migration 042), as the person who raised it.
    const ch = db.prepare("SELECT id FROM channels WHERE slug = 'workshop'").get();
    if (ch && me !== null) {
      db.prepare("INSERT INTO messages (channel_id, author_id, body) VALUES (?, ?, ?)").run(
        ch.id,
        me,
        `Issue on ${job.name}: ${text}${photoIds.length ? ` (${photoIds.length} ${photoIds.length === 1 ? "photo" : "photos"})` : ""}`
      );
    }
    return present(db, req, db.prepare(`${SELECT_ISSUE} WHERE i.id = ?`).get(id));
  })();
}

// body: {resolution?}. Only the project owner, board.edit or an admin.
function resolve(db, req, issueId, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  let note = null;
  if (b.resolution !== undefined && b.resolution !== null) {
    if (typeof b.resolution !== "string") throw bad("resolution must be text");
    note = b.resolution.trim() || null;
    if (note && note.length > RESOLUTION_MAX) throw bad(`A resolution is ${RESOLUTION_MAX.toLocaleString("en-AU")} characters at most`);
  }
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM job_issues WHERE id = ?").get(issueId);
    if (!row) throw notFound();
    if (!canResolve(db, req, row.job_id)) throw forbidden();
    if (row.status === "resolved") throw bad("That issue is already resolved");
    const now = new Date().toISOString();
    db.prepare("UPDATE job_issues SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ?").run(
      userId(req),
      now,
      note,
      issueId
    );
    audit.log(req, {
      action: "issue.resolve",
      entityType: "job_issue",
      entityId: issueId,
      before: { status: "open" },
      after: { status: "resolved", resolution: note, jobId: row.job_id },
    });
    return present(db, req, db.prepare(`${SELECT_ISSUE} WHERE i.id = ?`).get(issueId));
  })();
}

module.exports = { listFor, openCount, raise, resolve, canResolve };
