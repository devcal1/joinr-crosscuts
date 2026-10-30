// The routes of an account kind's monthly statements (docs/plans/m9-contracts.md section 7.2;
// admin accounts, section 13). routes/suppliers.js and routes/adminaccounts.js each call build()
// with their prefix and the matching lib/suppliers.js kind, so the two APIs cannot drift apart.
// Every route is declared with its access. Literal paths (/months) are registered before /:id.
//
// accounts.view reads everything; invoices.edit writes. Logged out: 401 and without the key:
// 403 {"error":"Forbidden"}, both from the auth layer.
const fs = require("fs");
const db = require("../db");
const { defineRoutes } = require("./routes");
const { bad, notFound, sendError } = require("./httperror");
const files = require("./files");
const Periods = require("../public/periods");

const VIEW = "accounts.view";
const EDIT = "invoices.edit";

// Positive integer path ids only; anything else is a 404.
function idOr404(v) {
  if (typeof v !== "string" || !/^[1-9]\d*$/.test(v)) throw notFound();
  const id = Number(v);
  if (!Number.isSafeInteger(id)) throw notFound();
  return id;
}

// A :period that isn't 'YYYY-MM' is a 404. (The range check, HISTORY_START to next month,
// is lib/suppliers.js's, section 7.2.)
function periodOr404(v) {
  if (!Periods.validPeriod(v)) throw notFound();
  return v;
}

// Bodies that aren't objects are treated as {}.
function body(req) {
  const b = req.body;
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

// `suppliers` is lib/suppliers.js (suppliers) or its .admin (admin accounts); `tag` prefixes log lines.
function build(prefix, suppliers, tag) {
  const r = defineRoutes(prefix);

  function handle(fn) {
    return (req, res) => {
      try {
        fn(req, res);
      } catch (e) {
        sendError(res, e, tag);
      }
    };
  }

  r.get("/", VIEW, handle((req, res) => {
    res.json({ suppliers: suppliers.list(db, { all: req.query.all === "1" }) });
  }));

  r.post("/", EDIT, handle((req, res) => {
    res.status(201).json(suppliers.create(db, req, body(req)));
  }));

  r.get("/months/:period", VIEW, handle((req, res) => {
    res.json(suppliers.month(db, periodOr404(req.params.period)));
  }));

  r.put("/months/:period/:supplierId", EDIT, handle((req, res) => {
    const period = periodOr404(req.params.period);
    res.json(suppliers.saveLine(db, req, period, idOr404(req.params.supplierId), body(req)));
  }));

  // Takes the supplier off this month's list (the line is kept, hidden).
  r.delete("/months/:period/:supplierId", EDIT, handle((req, res) => {
    const period = periodOr404(req.params.period);
    res.json(suppliers.removeLine(db, req, period, idOr404(req.params.supplierId)));
  }));

  // files.single has stored the upload as <uuid>.part; every way out of the handler either
  // renames it (files.accept) or removes it.
  r.post("/months/:period/:supplierId/file", EDIT, files.single("file"), async (req, res) => {
    let accepted = null;
    try {
      const period = periodOr404(req.params.period);
      const supplierId = idOr404(req.params.supplierId);
      if (!req.file) throw bad("Choose a file");
      accepted = await files.accept(req.file);
      const line = suppliers.attach(db, req, period, supplierId, accepted);
      accepted = null;
      res.status(201).json(line);
    } catch (e) {
      if (accepted) files.discard(accepted);
      // Awaited, so the .part file is gone before the reply (as routes/tasks.js).
      else if (req.file && req.file.path) await fs.promises.rm(req.file.path, { force: true }).catch(() => {});
      sendError(res, e, tag);
    }
  });

  // ?fileId=<id> (optional): the file the caller saw; 409 when the line now has another (review P4).
  r.delete("/months/:period/:supplierId/file", EDIT, handle((req, res) => {
    const period = periodOr404(req.params.period);
    const supplierId = idOr404(req.params.supplierId);
    const q = req.query.fileId;
    let fileId;
    if (q !== undefined) {
      if (typeof q !== "string" || !/^[1-9]\d*$/.test(q) || !Number.isSafeInteger(Number(q))) {
        throw bad("fileId must be a positive whole number");
      }
      fileId = Number(q);
    }
    res.json(suppliers.detach(db, req, period, supplierId, fileId));
  }));

  r.patch("/:id", EDIT, handle((req, res) => {
    res.json(suppliers.update(db, req, idOr404(req.params.id), body(req)));
  }));

  return r.router;
}

module.exports = build;
