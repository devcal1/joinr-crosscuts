// Individual invoices on the Supplier accounts page (0.2.7, docs/plans/m28-contracts.md section 2).
// accounts.view sees; invoices.edit adds and edits; Paid is users.admin only. Rules in lib/payables.js.
const fs = require("fs");
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const payables = require("../lib/payables");
const suppliers = require("../lib/suppliers");
const files = require("../lib/files");
const { bad, notFound, sendError } = require("../lib/httperror");

const r = defineRoutes("/api/payables");
const VIEW = "accounts.view";
const EDIT = "invoices.edit";

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[payables]");
    }
  };
}
function idOr404(v) {
  if (typeof v !== "string" || !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) throw notFound();
  return Number(v);
}
function body(req) {
  const b = req.body;
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

// 200 {period, lines, counts, totalCents, leftCents}.
r.get("/months/:period", VIEW, handle((req, res) => {
  res.json(payables.month(db, payables.periodOr404(req.params.period)));
}));

r.post("/", EDIT, handle((req, res) => {
  res.status(201).json(payables.create(db, req, body(req)));
}));

// Stops future occurrences of a recurring invoice (lines already listed stay).
r.post("/recurrences/:id/stop", EDIT, handle((req, res) => {
  payables.stopRecurrence(db, req, idOr404(req.params.id));
  res.status(204).end();
}));

r.get("/:id", VIEW, handle((req, res) => {
  res.json(payables.get(db, idOr404(req.params.id)));
}));

r.patch("/:id", EDIT, handle((req, res) => {
  res.json(payables.update(db, req, idOr404(req.params.id), body(req)));
}));

r.delete("/:id", EDIT, handle((req, res) => {
  payables.remove(db, req, idOr404(req.params.id));
  res.status(204).end();
}));

// Paid: users.admin only (the library refuses anyone else with 403).
r.post("/:id/paid", ["users.admin"], handle((req, res) => {
  res.json(payables.setPaid(db, req, idOr404(req.params.id), body(req)));
}));

r.post("/:id/convert", EDIT, handle((req, res) => {
  res.status(201).json(payables.convert(db, req, idOr404(req.params.id), suppliers));
}));

r.post("/:id/file", EDIT, files.single("file"), async (req, res) => {
  let accepted = null;
  try {
    const id = idOr404(req.params.id);
    if (!req.file) throw bad("Choose a file");
    accepted = await files.accept(req.file);
    const out = payables.attach(db, req, id, accepted);
    accepted = null;
    res.status(201).json(out);
  } catch (e) {
    if (accepted) files.discard(accepted);
    else if (req.file && req.file.path) await fs.promises.rm(req.file.path, { force: true }).catch(() => {});
    sendError(res, e, "[payables]");
  }
});

r.delete("/:id/file", EDIT, handle((req, res) => {
  res.json(payables.detach(db, req, idOr404(req.params.id)));
}));

module.exports = r.router;
