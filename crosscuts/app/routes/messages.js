// Messages (chat): /api/messages. Wave 1 B.
// See docs/plans/m4-contracts.md section 4. The rules (who sees a channel, the read
// marker, removal) live in lib/messages.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const messages = require("../lib/messages");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api/messages");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[messages]");
    }
  };
}

function idOr404(v) {
  const id = Number(v);
  if (!Number.isInteger(id) || id < 1) throw notFound();
  return id;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

function single(req, name) {
  const v = req.query[name];
  if (v !== undefined && typeof v !== "string") throw bad(`${name} must be a single value`);
  return v;
}

r.get("/channels", "messages.use", handle((req, res) => {
  res.json({ rows: messages.listChannels(db, req.user) });
}));

r.get("/channels/:id", "messages.use", handle((req, res) => {
  const id = idOr404(req.params.id);
  res.json(
    messages.listMessages(db, req.user, id, {
      after: single(req, "after"),
      before: single(req, "before"),
      limit: single(req, "limit"),
    })
  );
}));

r.post("/channels/:id", "messages.use", handle((req, res) => {
  const id = idOr404(req.params.id);
  res.status(201).json(messages.post(db, req, id, body(req).body));
}));

r.post("/channels/:id/read", "messages.use", handle((req, res) => {
  const id = idOr404(req.params.id);
  messages.markRead(db, req.user, id, body(req).lastId);
  res.status(204).end();
}));

r.delete("/:id", "messages.use", handle((req, res) => {
  const id = idOr404(req.params.id);
  messages.remove(db, req, id);
  res.status(204).end();
}));

module.exports = r.router;
