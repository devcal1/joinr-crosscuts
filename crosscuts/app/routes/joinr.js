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
      const out = { ok: result.ok, items: result.items, skipped: result.skipped || 0, error: result.error || null };
      // Stopped at the page limit with more to come (M6 · 4.3): ok, but say so.
      if (result.truncated) Object.assign(out, { truncated: true, message: result.message });
      res.json(out);
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
  // ?countsOnly=1 (M6 · 4.3): the Design/PM tile needs only the counts.
  if (req.query.countsOnly === "1") return res.json({ counts: intake.counts(inboxDb) });
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
const configDb = require("../db");
const configLib = require("../lib/joinr-config");
const configSync = require("../lib/joinr-sync");
const configAudit = require("../lib/audit");
const { HttpError: ConfigHttpError, sendError: configSendError } = require("../lib/httperror");

// The key never leaves joinr-config: responses carry keyStatus() (last four only), the audit
// rows carry the word 'set' or 'cleared', and no error message below includes it.
const KEY_OK = /^[\x21-\x7e]{8,200}$/;

function settingsPayload() {
  return {
    baseUrl: configLib.getBaseUrl(),
    baseUrlFromEnv: configLib.baseUrlFromEnv(),
    key: configLib.keyStatus(),
    sync: configSync.status(configDb),
  };
}

// One request for the current position through the puller's own fetchPage (no `after`, no
// `backfill`), so the test and the sync share one fetch, one timeout and one set of messages.
async function testConnection() {
  try {
    const page = await configSync.fetchPage({});
    return { ok: true, cursor: page.cursor };
  } catch (e) {
    if (e && e.message === configSync.NOT_SET_UP) return { ok: false, error: "No API key is set" };
    if (e instanceof configSync.JoinrError) return { ok: false, error: e.message };
    return { ok: false, error: "Could not reach Joinr" };
  }
}

r.get("/settings", "users.admin", (req, res) => {
  try {
    res.json(settingsPayload());
  } catch (e) {
    configSendError(res, e, "[joinr settings]");
  }
});

// {baseUrl?, apiKey?}. Everything is checked before anything is written. When the address
// really changes (M6 · 4.3), the saved key belonged to the old address: it is removed and the
// sync position and error are reset, so the next run starts from now at the new address; a key
// sent in the same request is saved after that.
r.put("/settings", "users.admin", (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (body.baseUrl !== undefined && body.baseUrl !== null && typeof body.baseUrl !== "string") {
      throw new ConfigHttpError(400, "The Joinr address must be text");
    }
    if (body.apiKey !== undefined && body.apiKey !== null && typeof body.apiKey !== "string") {
      throw new ConfigHttpError(400, "The API key must be text");
    }
    const hasUrl = typeof body.baseUrl === "string";
    const hasKey = typeof body.apiKey === "string" && body.apiKey.trim() !== "";
    const keyFromEnv = configLib.keyStatus().fromEnv;
    if (hasKey) {
      if (keyFromEnv) {
        throw new ConfigHttpError(409, "The API key is set by the server's environment and can't be changed here");
      }
      if (!KEY_OK.test(body.apiKey.trim())) throw new ConfigHttpError(400, "The API key must be 8 to 200 characters with no spaces");
    }

    const before = configLib.getBaseUrl();
    let urlChanges = false;
    if (hasUrl) {
      const wanted = configLib.normaliseBaseUrl(body.baseUrl) || configLib.DEFAULT_BASE;
      if (wanted !== before) {
        if (configLib.baseUrlFromEnv()) {
          throw new ConfigHttpError(409, "The Joinr address is set by the server's environment and can't be changed here");
        }
        if (keyFromEnv) throw new ConfigHttpError(409, "Remove JOINR_API_KEY from the environment first");
        urlChanges = true;
      }
    }

    const detail = {};
    if (urlChanges) {
      configLib.setBaseUrl(body.baseUrl);
      configLib.clearKey();
      configSync.reset(configDb);
      detail.baseUrl = configLib.getBaseUrl();
      detail.key = "cleared";
      detail.cursor = "reset";
    }
    if (hasKey) {
      configLib.setKey(body.apiKey);
      if (urlChanges) detail.newKey = "set";
      else detail.key = "set";
    }
    if (Object.keys(detail).length) {
      configAudit.log(req, { action: "joinr.settings", entityType: "joinr", entityId: "settings", after: detail });
    }
    res.json(settingsPayload());
  } catch (e) {
    configSendError(res, e, "[joinr settings]");
  }
});

r.delete("/settings/key", "users.admin", (req, res) => {
  try {
    configLib.clearKey();
    configAudit.log(req, { action: "joinr.settings", entityType: "joinr", entityId: "settings", after: { key: "cleared" } });
    res.json(settingsPayload());
  } catch (e) {
    configSendError(res, e, "[joinr settings]");
  }
});

r.post("/test", "users.admin", async (req, res) => {
  try {
    res.json(await testConnection());
  } catch (e) {
    configSendError(res, e, "[joinr test]");
  }
});
// ---- end block C -----------------------------------------------------------------------

module.exports = r.router;
