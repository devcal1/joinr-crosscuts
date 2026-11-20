// Notifications (the bell) and the round-up trigger. Wave 1 B.
// See docs/plans/m2-contracts.md section 4. Every user sees only their own rows.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const roundup = require("../lib/roundup");
const tasks = require("../lib/tasks");
const teamTasks = require("../lib/team-tasks");
const messages = require("../lib/messages");
const { can } = require("../lib/httperror");
const { sydneyToday } = require("../lib/time");

const r = defineRoutes("/api/notifications");

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function shape(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    link: row.link,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

function unreadCount(userId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL")
    .get(userId).n;
}

// ?before=<id> (M4): the page of rows older than that id. `more` says whether
// older rows exist after this page.
r.get("/", "login", (req, res) => {
  let limit = DEFAULT_LIMIT;
  if (req.query.limit !== undefined) {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      res.status(400).json({ error: `limit must be a whole number from 1 to ${MAX_LIMIT}` });
      return;
    }
  }
  let before = null;
  if (req.query.before !== undefined) {
    before = Number(req.query.before);
    if (!Number.isInteger(before) || before < 1) {
      res.status(400).json({ error: "before must be a notification id" });
      return;
    }
  }
  // Ids only grow, so ordering by id is the same as by created_at and makes paging exact.
  const rows = db
    .prepare(
      `SELECT * FROM notifications WHERE user_id = ? AND (? IS NULL OR id < ?)
        ORDER BY id DESC LIMIT ?`
    )
    .all(req.user.id, before, before, limit + 1);
  const more = rows.length > limit;
  res.json({ rows: rows.slice(0, limit).map(shape), unread: unreadCount(req.user.id), more });
});

// The menu bar counts (one poll for all three buttons). M4 adds tasks, tasksOverdue
// and messages; unread is unchanged.
r.get("/unread-count", "login", (req, res) => {
  const t = can(req, "tasks.use") ? tasks.countsFor(db, req.user.id, sydneyToday(), { teams: teamTasks.teamsOf(req.user) }) : { open: 0, overdue: 0 };
  res.json({
    unread: unreadCount(req.user.id),
    tasks: t.open,
    tasksOverdue: t.overdue,
    messages: messages.unreadTotal(db, req.user),
  });
});

r.post("/read-all", "login", (req, res) => {
  db.prepare(
    "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL"
  ).run(new Date().toISOString(), req.user.id);
  res.status(204).end();
});

// Badges (0.2.24, docs/plans/badges-plan.md section 2): where the caller's unread alerts point.
r.get("/unread-places", "login", (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, kind, link FROM notifications
        WHERE user_id = ? AND read_at IS NULL AND link IS NOT NULL
        ORDER BY id DESC LIMIT 500`
    )
    .all(req.user.id);
  res.json({ rows });
});

// Opening a page marks the caller's unread alerts that point at it read. The link is compared
// exactly (path and query); a #hash is dropped from both sides. Never touches another user's rows.
r.post("/read-link", "login", (req, res) => {
  const link = req.body && req.body.link;
  if (typeof link !== "string" || !/^\/(?![\/\\])/.test(link) || link.length > 1000) {
    res.status(400).json({ error: "link must be a site-relative path" });
    return;
  }
  const hash = link.indexOf("#");
  const bare = hash >= 0 ? link.slice(0, hash) : link;
  db.prepare(
    `UPDATE notifications SET read_at = ?
      WHERE user_id = ? AND read_at IS NULL AND link IS NOT NULL
        AND (CASE WHEN instr(link, '#') > 0 THEN substr(link, 1, instr(link, '#') - 1) ELSE link END) = ?`
  ).run(new Date().toISOString(), req.user.id, bare);
  res.status(204).end();
});

r.post("/roundup/run", "users.admin", (req, res) => {
  res.json(roundup.run(db, { force: true }));
});

r.post("/:id/read", "login", (req, res) => {
  const id = Number(req.params.id);
  // Another user's notification looks exactly like one that does not exist.
  const row = Number.isInteger(id)
    ? db.prepare("SELECT id FROM notifications WHERE id = ? AND user_id = ?").get(id, req.user.id)
    : null;
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL").run(
    new Date().toISOString(),
    id
  );
  res.status(204).end();
});

module.exports = r.router;
