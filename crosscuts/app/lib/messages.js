// Messages (chat): fixed channels, unread markers, polling. See
// docs/plans/m4-contracts.md sections 2 and 4. Messages never create notifications.
// Scaffold (M4 · 2.2): channelsFor and unreadTotal are complete and frozen (the menu
// bar count uses them). Wave 1 B fills in the rest; the signatures are binding.
const { HttpError, can } = require("./httperror");

const notBuilt = () => {
  throw new HttpError(501, "Not built");
};

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

function listChannels(db, user) { notBuilt(); }
function listMessages(db, user, channelId, opts) { notBuilt(); }
function post(db, req, channelId, body) { notBuilt(); }
function markRead(db, user, channelId, lastId) { notBuilt(); }
function remove(db, req, id) { notBuilt(); }

module.exports = {
  channelsFor,
  unreadTotal,
  listChannels,
  listMessages,
  post,
  markRead,
  remove,
};
