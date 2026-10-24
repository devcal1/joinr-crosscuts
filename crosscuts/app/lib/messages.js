// Messages (chat): fixed channels, unread markers, polling. See
// docs/plans/m4-contracts.md sections 2 and 4. Messages never create notifications.
// Scaffold (M4 · 2.2): channelsFor and unreadTotal are complete and frozen (the menu
// bar count uses them). Wave 1 B fills in the rest; the signatures are binding.
const audit = require("./audit");
const { bad, forbidden, notFound, conflict, can } = require("./httperror");

// Channels the user can see: messages.use, and a channel for everyone (role NULL), or
// one whose role the user holds, or any channel for an admin. Not archived. In order.
function channelsFor(db, user) {
  if (!user || !can({ user }, "messages.use")) return [];
  const roles = new Set(user.roles || []);
  return db
    .prepare("SELECT * FROM channels WHERE archived = 0 ORDER BY position, id")
    .all()
    .filter((c) => c.role == null || roles.has("admin") || roles.has(c.role));
}

// Unread messages by others over the user's channels (id > last_read_id, not removed).
function unreadTotal(db, user) {
  const channels = channelsFor(db, user);
  if (channels.length === 0) return 0;
  const count = db.prepare(
    `SELECT COUNT(*) AS n FROM messages m
      WHERE m.channel_id = ? AND m.author_id <> ? AND m.removed_at IS NULL
        AND m.id > COALESCE((SELECT last_read_id FROM channel_reads
                              WHERE user_id = ? AND channel_id = ?), 0)`
  );
  let n = 0;
  for (const c of channels) n += Number(count.get(c.id, user.id, user.id, c.id).n) || 0;
  return n;
}

// --- Wave 1 B ---------------------------------------------------------------

const BODY_MAX = 4000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const isAdmin = (user) => !!user && Array.isArray(user.roles) && user.roles.includes("admin");

// The channel row if the user can see it, else a 404 (a hidden channel looks absent).
function visibleChannel(db, user, channelId) {
  const id = Number(channelId);
  const ch = Number.isInteger(id) ? channelsFor(db, user).find((c) => c.id === id) : null;
  if (!ch) throw notFound();
  return ch;
}

// A message row (messages JOIN users) as the API object.
function present(row, user) {
  const removed = row.removed_at != null;
  return {
    id: row.id,
    channelId: row.channel_id,
    author: { id: row.author_id, name: row.author_name || "Unknown" },
    body: removed ? null : row.body,
    removed,
    createdAt: row.created_at,
    canRemove: !removed && (row.author_id === user.id || isAdmin(user)),
  };
}

const SELECT_MESSAGE = `SELECT m.*, u.display_name AS author_name
  FROM messages m LEFT JOIN users u ON u.id = m.author_id`;

function lastReadOf(db, userId, channelId) {
  const r = db
    .prepare("SELECT last_read_id FROM channel_reads WHERE user_id = ? AND channel_id = ?")
    .get(userId, channelId);
  return r ? Number(r.last_read_id) || 0 : 0;
}

// [{id, slug, name, unread, lastMessageAt}] for the channels the user can see.
function listChannels(db, user) {
  const unread = db.prepare(
    `SELECT COUNT(*) AS n FROM messages m
      WHERE m.channel_id = ? AND m.author_id <> ? AND m.removed_at IS NULL
        AND m.id > COALESCE((SELECT last_read_id FROM channel_reads
                              WHERE user_id = ? AND channel_id = ?), 0)`
  );
  const last = db.prepare(
    "SELECT created_at FROM messages WHERE channel_id = ? AND removed_at IS NULL ORDER BY id DESC LIMIT 1"
  );
  return channelsFor(db, user).map((c) => {
    const l = last.get(c.id);
    return {
      id: c.id,
      slug: c.slug,
      // 0.2.0: the design channel reads "Projects" (its stored name stays as it was).
      name: c.slug === "design" ? "Projects" : c.name,
      unread: Number(unread.get(c.id, user.id, user.id, c.id).n) || 0,
      lastMessageAt: l ? l.created_at : null,
    };
  });
}

function cursor(v, name, min = 1) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw bad(`${name} must be a whole number`);
  return n;
}

// {rows, lastReadId, more}. No cursor: the newest `limit`. after: id > after, oldest first
// (the poll; `more` says newer ones remain beyond the limit). before: the `limit` before it
// (`more` says older ones exist). Rows are oldest first; removed messages are included.
function listMessages(db, user, channelId, opts = {}) {
  const ch = visibleChannel(db, user, channelId);
  const after = cursor(opts.after, "after", 0);
  const before = cursor(opts.before, "before");
  if (after !== null && before !== null) throw bad("Use after or before, not both");
  let limit = DEFAULT_LIMIT;
  if (opts.limit !== undefined && opts.limit !== null && opts.limit !== "") {
    limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw bad("limit must be a positive whole number");
    limit = Math.min(limit, MAX_LIMIT);
  }
  let rows;
  let more = false;
  if (after !== null) {
    rows = db
      .prepare(`${SELECT_MESSAGE} WHERE m.channel_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`)
      .all(ch.id, after, limit + 1);
    if (rows.length > limit) {
      more = true;
      rows.length = limit;
    }
  } else {
    const cond = before !== null ? "AND m.id < ?" : "";
    const params = before !== null ? [ch.id, before, limit + 1] : [ch.id, limit + 1];
    rows = db
      .prepare(`${SELECT_MESSAGE} WHERE m.channel_id = ? ${cond} ORDER BY m.id DESC LIMIT ?`)
      .all(...params);
    if (rows.length > limit) {
      more = true;
      rows.length = limit;
    }
    rows.reverse();
  }
  return { rows: rows.map((r) => present(r, user)), lastReadId: lastReadOf(db, user.id, ch.id), more };
}

// Posts a message and moves the author's read marker to it. Returns the message object.
function post(db, req, channelId, body) {
  const user = req.user;
  const ch = visibleChannel(db, user, channelId);
  if (typeof body !== "string") throw bad("body must be text");
  const text = body.trim();
  if (!text) throw bad("Write something to send");
  if (text.length > BODY_MAX) throw bad(`Messages are ${BODY_MAX.toLocaleString("en-AU")} characters at most`);
  return db.transaction(() => {
    const info = db
      .prepare("INSERT INTO messages (channel_id, author_id, body) VALUES (?, ?, ?)")
      .run(ch.id, user.id, text);
    const id = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO channel_reads (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`
    ).run(user.id, ch.id, id);
    return present(db.prepare(`${SELECT_MESSAGE} WHERE m.id = ?`).get(id), user);
  })();
}

// Moves the read marker forward only, and never beyond the channel's newest message.
function markRead(db, user, channelId, lastId) {
  const ch = visibleChannel(db, user, channelId);
  const n = Number(lastId);
  if (lastId === null || lastId === "" || typeof lastId === "boolean" || !Number.isInteger(n) || n < 0) {
    throw bad("lastId must be a whole number");
  }
  const newest = Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE channel_id = ?").get(ch.id).n);
  const target = Math.min(n, newest);
  db.prepare(
    `INSERT INTO channel_reads (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`
  ).run(user.id, ch.id, target);
}

// Soft-removes a message: its author or an admin. Audited with the text it had.
function remove(db, req, id) {
  const user = req.user;
  const mid = Number(id);
  const row = Number.isInteger(mid) ? db.prepare("SELECT * FROM messages WHERE id = ?").get(mid) : null;
  if (!row) throw notFound();
  visibleChannel(db, user, row.channel_id);
  if (row.author_id !== user.id && !isAdmin(user)) throw forbidden();
  if (row.removed_at) throw conflict("That message was already removed");
  db.transaction(() => {
    db.prepare("UPDATE messages SET removed_at = ?, removed_by = ? WHERE id = ?").run(
      new Date().toISOString(),
      user.id,
      row.id
    );
    audit.log(req, {
      action: "message.remove",
      entityType: "message",
      entityId: row.id,
      before: { body: row.body },
    });
  })();
}

module.exports = {
  channelsFor,
  unreadTotal,
  listChannels,
  listMessages,
  post,
  markRead,
  remove,
};
