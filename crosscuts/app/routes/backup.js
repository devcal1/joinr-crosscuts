// Backups (docs/plans/backup-contracts.md section 9). Both routes need users.admin (no new key).
// Logged out: 401 and any other role: 403, both from the auth layer.
//
// Neither body ever holds a secret, an address or a path: status() reports each config file's
// state only, and every sentence is fixed text with numbers (lib/backup/sentences.js).
const { defineRoutes } = require("../lib/routes");
const db = require("../db");
const backup = require("../lib/backup");

const r = defineRoutes("/api/backup");

const ACCESS = "users.admin";

// 200 status(db).
r.get("/status", ACCESS, (req, res) => {
  const body = backup.status(db);
  if (!body) return res.status(500).json({ error: "Server error" });
  res.set("Cache-Control", "no-store");
  return res.json(body);
});

// Back up now: 202 (started, or joined the run in flight) / 409 / 429, {error} on 409 and 429.
// It answers at once; the run goes on in the background and the page polls /status.
r.post("/run", ACCESS, async (req, res) => {
  let result;
  try {
    result = await backup.requestRun(db, req);
  } catch {
    result = null;
  }
  if (!result || typeof result.status !== "number") return res.status(500).json({ error: "Server error" });
  if (result.status === 429 && result.body && Number.isFinite(result.body.retryAfterSeconds)) {
    res.set("Retry-After", String(result.body.retryAfterSeconds));
  }
  return res.status(result.status).json(result.body);
});

module.exports = r.router;
