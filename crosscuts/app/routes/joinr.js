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
const configDb = require("../db");
const configLib = require("../lib/joinr-config");
const configSync = require("../lib/joinr-sync");
const configAudit = require("../lib/audit");
const { HttpError: ConfigHttpError, sendError: configSendError } = require("../lib/httperror");

// The key never leaves joinr-config: responses carry keyStatus() (last four only), the audit
// rows carry the word 'set' or 'cleared', and no error message below includes it.
const KEY_OK = /^[\x21-\x7e]{8,200}$/;
const TEST_TIMEOUT_MS = 10000;
const TEST_MAX_BYTES = 1024 * 1024;

function settingsPayload() {
  return { baseUrl: configLib.getBaseUrl(), key: configLib.keyStatus(), sync: configSync.status(configDb) };
}

// Reads at most TEST_MAX_BYTES of the body as text.
async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > TEST_MAX_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error("Joinr's reply was too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// One request for the current position: no `after`, no `backfill`, so a healthy Joinr answers
// {cursor, items: [], more: false}. Returns {ok:true, cursor} or {ok:false, error}.
async function testConnection() {
  const key = configLib.getKey();
  if (!key) return { ok: false, error: "No API key is set" };
  const url = `${configLib.getBaseUrl()}/api/integrations/crosscuts/won-quotes`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (res.status === 401) return { ok: false, error: "Joinr rejected the API key (401)" };
    if (res.status >= 300 && res.status < 400) return { ok: false, error: `Joinr redirected the request (HTTP ${res.status}); check the address` };
    if (!res.ok) return { ok: false, error: `Joinr answered HTTP ${res.status}` };
    let body;
    try {
      body = JSON.parse(await readCapped(res));
    } catch (e) {
      return { ok: false, error: e.message === "Joinr's reply was too large" ? e.message : "Joinr's reply wasn't valid JSON" };
    }
    if (!body || typeof body !== "object" || !Array.isArray(body.items) || body.cursor === undefined || body.cursor === null) {
      return { ok: false, error: "Joinr's reply didn't look like the won-quotes feed; check the address" };
    }
    return { ok: true, cursor: String(body.cursor) };
  } catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      return { ok: false, error: `Joinr didn't answer within ${TEST_TIMEOUT_MS / 1000} seconds` };
    }
    const code = e && e.cause && e.cause.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { ok: false, error: "Couldn't find that address (DNS lookup failed)" };
    if (code === "ECONNREFUSED") return { ok: false, error: "Joinr refused the connection" };
    if (code === "ECONNRESET") return { ok: false, error: "The connection to Joinr was reset" };
    if (code && /CERT|SSL|TLS/i.test(String(code))) return { ok: false, error: "The secure connection to Joinr failed (certificate problem)" };
    return { ok: false, error: "Couldn't reach Joinr" };
  }
}

r.get("/settings", "users.admin", (req, res) => {
  try {
    res.json(settingsPayload());
  } catch (e) {
    configSendError(res, e, "[joinr settings]");
  }
});

r.put("/settings", "users.admin", (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const hasUrl = body.baseUrl !== undefined && body.baseUrl !== null;
    const hasKey = typeof body.apiKey === "string" && body.apiKey.trim() !== "";
    if (body.baseUrl !== undefined && body.baseUrl !== null && typeof body.baseUrl !== "string") {
      throw new ConfigHttpError(400, "The Joinr address must be text");
    }
    if (body.apiKey !== undefined && body.apiKey !== null && typeof body.apiKey !== "string") {
      throw new ConfigHttpError(400, "The API key must be text");
    }
    if (hasKey) {
      if (configLib.keyStatus().fromEnv) {
        throw new ConfigHttpError(409, "The API key is set by the server's environment and can't be changed here");
      }
      // Checked up front so a bad key doesn't leave a half-saved address behind.
      if (!KEY_OK.test(body.apiKey.trim())) throw new ConfigHttpError(400, "The API key must be 8 to 200 characters with no spaces");
    }
    const detail = {};
    if (hasUrl) {
      const before = configLib.getBaseUrl();
      configLib.setBaseUrl(body.baseUrl);
      const after = configLib.getBaseUrl();
      if (after !== before) detail.baseUrl = after;
    }
    if (hasKey) {
      configLib.setKey(body.apiKey);
      detail.key = "set";
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
