// Department notes: /api/notes. See docs/plans/notes-contracts.md section 3. Every route is
// open to anyone holding any of the five department keys; the department's own key is checked
// inside lib/notes.js (403 without it).
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const notes = require("../lib/notes");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api/notes");
const ANY_DEPT = notes.DEPT_KEYS;

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[notes]");
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

r.get("/", ANY_DEPT, handle((req, res) => {
  res.json(
    notes.list(db, req, single(req, "dept"), { before: single(req, "before"), limit: single(req, "limit") })
  );
}));

r.post("/", ANY_DEPT, handle((req, res) => {
  const b = body(req);
  res.status(201).json(notes.create(db, req, b.dept, b.body));
}));

r.patch("/:id", ANY_DEPT, handle((req, res) => {
  const id = idOr404(req.params.id);
  const b = body(req);
  if (b.updatedAt !== undefined && b.updatedAt !== null && typeof b.updatedAt !== "string") {
    throw bad("updatedAt must be text");
  }
  res.json(notes.update(db, req, id, b.body, b.updatedAt));
}));

r.delete("/:id", ANY_DEPT, handle((req, res) => {
  notes.remove(db, req, idOr404(req.params.id));
  res.status(204).end();
}));

module.exports = r.router;
