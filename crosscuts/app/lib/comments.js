// Comments on tasks and jobs, and follows. See docs/plans/m4-contracts.md sections 2 and 4.
//
// One flat thread per task or job, oldest first. No editing: an author can remove their own
// comment and an admin any (soft: the text stays in the database, brief section 8.5).
// "Involved" means following: you follow what you create, are assigned or comment on, and a
// new comment alerts every other follower once (while their earlier alert is unread).
const audit = require("./audit");
const notify = require("./notify");
const teamTasks = require("./team-tasks");
const { bad, notFound, forbidden, conflict } = require("./httperror");

const BODY_MAX = 4000;
const PREVIEW_CHARS = 140;
const TYPES = ["task", "job"];

function nowIso() {
  return new Date().toISOString();
}

function has(user, key) {
  return !!(user && user.perms && user.perms.has(key));
}

function isAdmin(user) {
  return !!(user && Array.isArray(user.roles) && user.roles.includes("admin"));
}

function parseType(v) {
  if (typeof v !== "string" || !TYPES.includes(v)) throw bad("entityType must be task or job");
  return v;
}

function parseEntityId(v) {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(n) || n < 1) throw bad("entityId must be a whole number");
  return n;
}

// The task title or job name the entity is called, or a 404 when it doesn't exist.
function entityLabel(db, type, id) {
  const row =
    type === "task"
      ? teamTasks.isTeamId(id)
        ? (() => { const t = teamTasks.labelOf(db, id); return t == null ? null : { label: t }; })()
        : db.prepare("SELECT title AS label FROM tasks WHERE id = ?").get(id)
      : db.prepare("SELECT name AS label FROM jobs WHERE id = ?").get(id);
  if (!row) throw notFound();
  return row.label;
}

// Reading needs tasks.use (task) or jobs.view (job); writing a job comment also needs messages.use.
// Returns the entity's label.
function assertAccess(db, user, type, id, { write = false } = {}) {
  if (type === "task") {
    if (!has(user, "tasks.use")) throw forbidden();
    // A team task (2026-10-18) is the team's: anyone else is told there is no such task.
    if (teamTasks.isTeamId(id) && !teamTasks.canSee(db, user, id)) throw notFound();
  } else {
    if (!has(user, "jobs.view")) throw forbidden();
    if (write && !has(user, "messages.use")) throw forbidden();
  }
  return entityLabel(db, type, id);
}

function present(user, row) {
  const removed = row.removed_at != null;
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    author: { id: row.author_id, name: row.author_name || "Unknown" },
    body: removed ? null : row.body,
    removed,
    createdAt: row.created_at,
    canRemove: !removed && (Number(row.author_id) === Number(user.id) || isAdmin(user)),
  };
}

const SELECT = `SELECT c.*, u.display_name AS author_name
    FROM comments c LEFT JOIN users u ON u.id = c.author_id`;

function isFollowing(db, userId, type, id) {
  return !!db
    .prepare("SELECT 1 FROM follows WHERE user_id = ? AND entity_type = ? AND entity_id = ?")
    .get(userId, type, id);
}

// {rows: [comment] oldest first (all of them, removed ones with body null), following}
function list(db, user, entityType, entityId) {
  const type = parseType(entityType);
  const id = parseEntityId(entityId);
  assertAccess(db, user, type, id);
  const rows = db
    .prepare(`${SELECT} WHERE c.entity_type = ? AND c.entity_id = ? ORDER BY c.id`)
    .all(type, id)
    .map((r) => present(user, r));
  return { rows, following: isFollowing(db, user.id, type, id) };
}

function follow(db, userId, entityType, entityId) {
  db.prepare("INSERT OR IGNORE INTO follows (user_id, entity_type, entity_id) VALUES (?, ?, ?)").run(
    userId,
    entityType,
    entityId
  );
}

function unfollow(db, userId, entityType, entityId) {
  db.prepare("DELETE FROM follows WHERE user_id = ? AND entity_type = ? AND entity_id = ?").run(
    userId,
    entityType,
    entityId
  );
}

// Posts a comment, makes the author a follower and alerts the other followers. Returns the comment.
function add(db, req, entityType, entityId, body) {
  const user = req.user;
  const type = parseType(entityType);
  const id = parseEntityId(entityId);
  if (typeof body !== "string") throw bad("body must be text");
  const text = body.trim();
  if (!text) throw bad("Write something first");
  if (text.length > BODY_MAX) throw bad(`A comment must be ${BODY_MAX.toLocaleString("en-AU")} characters or fewer`);
  const label = assertAccess(db, user, type, id, { write: true });

  const commentId = db.transaction(() => {
    const info = db
      .prepare("INSERT INTO comments (entity_type, entity_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(type, id, user.id, text, nowIso());
    follow(db, user.id, type, id);
    // Followers who can no longer see the entity are skipped.
    const team = type === "task" && teamTasks.isTeamId(id);
    const canSee = new Set(
      (team ? teamTasks.memberIds(db, teamTasks.teamOf(db, id) || "design") : notify.usersWithKey(db, type === "task" ? "tasks.use" : "jobs.view")).map(Number)
    );
    const followers = db
      .prepare("SELECT user_id FROM follows WHERE entity_type = ? AND entity_id = ?")
      .all(type, id)
      .map((f) => Number(f.user_id))
      .filter((uid) => canSee.has(uid));
    // Everyone on the team hears a comment on a team task, followers or not.
    if (team) for (const m of canSee) if (!followers.includes(m)) followers.push(m);
    notify.toUsers(
      db,
      followers,
      {
        kind: "comment.new",
        title: `${user.displayName} commented on ${label}`,
        body: text.slice(0, PREVIEW_CHARS),
        link: type === "task" ? `/tasks.html?task=${id}#comments` : `/job.html?id=${id}#comments`,
        entityType: type,
        entityId: id,
      },
      { exceptUserId: user.id, dedupeUnread: true }
    );
    return Number(info.lastInsertRowid);
  })();
  return present(user, db.prepare(`${SELECT} WHERE c.id = ?`).get(commentId));
}

// The author or an admin removes a comment (soft). 403 for anyone else, 409 if already removed.
function remove(db, req, id) {
  const user = req.user;
  db.transaction(() => {
    const row = db.prepare("SELECT * FROM comments WHERE id = ?").get(id);
    if (!row) throw notFound();
    if (!(isAdmin(user) || Number(row.author_id) === Number(user.id))) throw forbidden();
    if (row.removed_at != null) throw conflict("That comment was already removed");
    db.prepare("UPDATE comments SET removed_at = ?, removed_by = ? WHERE id = ?").run(nowIso(), user.id, id);
    audit.log(req, {
      action: "comment.remove",
      entityType: "comment",
      entityId: id,
      before: { body: row.body },
    });
  })();
}

module.exports = { list, add, remove, follow, unfollow, assertAccess, parseType, parseEntityId };
