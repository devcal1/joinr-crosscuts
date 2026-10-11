// Joinr intake: the inbox, the sync and the connection settings (m6-contracts.md section 3).
// Scaffold (M6 · 2.2): every route is registered with its final access value and answers 501.
// Each Wave 1 task replaces only its own marked block.
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/joinr");

const stub = (req, res) => res.status(501).json({ error: "Not built" });

// ---- Block A: the puller (Wave 1 A) ----------------------------------------------------
r.post("/sync", "jobs.edit", stub);
r.post("/import", "users.admin", stub);
r.get("/status", "design.view", stub);
// ---- end block A -----------------------------------------------------------------------

// ---- Block B: the inbox (Wave 1 B) -----------------------------------------------------
const intake = require("../lib/intake");
const inboxDb = require("../db");
const { sendError: inboxSendError, can: inboxCan } = require("../lib/httperror");

function handleB(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      inboxSendError(res, e, "[joinr]");
    }
  };
}

r.get("/intake", "design.view", handleB((req, res) => {
  const rows = intake.list(inboxDb, req.user, { state: req.query.state });
  res.json({ rows, counts: intake.counts(inboxDb), sync: require("../lib/joinr-sync").status(inboxDb) });
}));

r.get("/intake/:id", "design.view", handleB((req, res) => {
  const item = intake.get(inboxDb, req.user, req.params.id);
  if (inboxCan(req, "jobs.edit")) item.matchJobs = intake.matches(inboxDb, req.params.id);
  res.json(item);
}));

r.post("/intake/:id/accept", "jobs.edit", handleB((req, res) => {
  res.json(intake.accept(inboxDb, req, req.params.id));
}));

r.post("/intake/:id/link", "jobs.edit", handleB((req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  res.json(intake.link(inboxDb, req, req.params.id, b.jobId));
}));

r.post("/intake/:id/ignore", "jobs.edit", handleB((req, res) => {
  res.json({ item: intake.ignore(inboxDb, req, req.params.id) });
}));

r.post("/intake/:id/acknowledge", "jobs.edit", handleB((req, res) => {
  res.json({ item: intake.acknowledge(inboxDb, req, req.params.id) });
}));

r.get("/job/:jobId", "jobs.view", handleB((req, res) => {
  const item = intake.forJob(inboxDb, req.user, req.params.jobId);
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json(item);
}));
// ---- end block B -----------------------------------------------------------------------

// ---- Block C: connection settings (Wave 1 C) -------------------------------------------
r.get("/settings", "users.admin", stub);
r.put("/settings", "users.admin", stub);
r.delete("/settings/key", "users.admin", stub);
r.post("/test", "users.admin", stub);
// ---- end block C -----------------------------------------------------------------------

module.exports = r.router;
