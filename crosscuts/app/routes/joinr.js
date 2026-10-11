// Joinr intake: the inbox, the sync and the connection settings (m6-contracts.md section 3).
// Scaffold (M6 · 2.2): every route is registered with its final access value and answers 501.
// Each Wave 1 task replaces only its own marked block.
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/joinr");

const stub = (req, res) => res.status(501).json({ error: "Not built" });

// ---- Block A: the puller (Wave 1 A) ----------------------------------------------------
// A bare block, so its names can't collide with the other blocks' requires.
{
  const db = require("../db");
  const joinrSync = require("../lib/joinr-sync");
  const joinrConfig = require("../lib/joinr-config");
  const { sendError } = require("../lib/httperror");

  // Both wait for the run (shared lock with the timer). run() never throws; a failed pull
  // is still a 200 with ok:false and the error, and /status keeps it.
  const runRoute = (opts) => async (req, res) => {
    try {
      if (!joinrConfig.getKey()) return res.status(409).json({ error: joinrSync.NOT_SET_UP });
      const result = await joinrSync.run(db, opts);
      res.json({ ok: result.ok, items: result.items, skipped: result.skipped || 0, error: result.error || null });
    } catch (e) {
      sendError(res, e, "[joinr]");
    }
  };

  r.post("/sync", "jobs.edit", runRoute({}));
  r.post("/import", "users.admin", runRoute({ backfill: true }));
  r.get("/status", "design.view", (req, res) => {
    try {
      res.json(joinrSync.status(db));
    } catch (e) {
      sendError(res, e, "[joinr]");
    }
  });
}
// ---- end block A -----------------------------------------------------------------------

// ---- Block B: the inbox (Wave 1 B) -----------------------------------------------------
r.get("/intake", "design.view", stub);
r.get("/intake/:id", "design.view", stub);
r.post("/intake/:id/accept", "jobs.edit", stub);
r.post("/intake/:id/link", "jobs.edit", stub);
r.post("/intake/:id/ignore", "jobs.edit", stub);
r.post("/intake/:id/acknowledge", "jobs.edit", stub);
r.get("/job/:jobId", "jobs.view", stub);
// ---- end block B -----------------------------------------------------------------------

// ---- Block C: connection settings (Wave 1 C) -------------------------------------------
r.get("/settings", "users.admin", stub);
r.put("/settings", "users.admin", stub);
r.delete("/settings/key", "users.admin", stub);
r.post("/test", "users.admin", stub);
// ---- end block C -----------------------------------------------------------------------

module.exports = r.router;
