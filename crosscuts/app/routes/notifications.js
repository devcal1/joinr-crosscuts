// Notifications (the bell) and the round-up trigger. Wave 1 B.
// See docs/plans/m2-contracts.md section 4. Every user sees only their own rows.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const roundup = require("../lib/roundup");

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

r.get("/", "login", (req, res) => {
  let limit = DEFAULT_LIMIT;
  if (req.query.limit !== undefined) {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      res.status(400).json({ error: `limit must be a whole number from 1 to ${MAX_LIMIT}` });
      return;
    }
  }
  const rows = db
    .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(req.user.id, limit);
  res.json({ rows: rows.map(shape), unread: unreadCount(req.user.id) });
});

r.get("/unread-count", "login", (req, res) => {
  res.json({ unread: unreadCount(req.user.id) });
});

r.post("/read-all", "login", (req, res) => {
  db.prepare(
    "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL"
  ).run(new Date().toISOString(), req.user.id);
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
