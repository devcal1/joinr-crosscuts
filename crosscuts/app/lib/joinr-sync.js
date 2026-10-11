// Pulls won quotes from Joinr (m6-contracts.md sections 2 and 4; the wire contract is
// docs/integrations/joinr-crosscuts-intake.md). Scaffold (M6 · 2.2): status() is complete;
// start() is a no-op and the rest are stubs until Wave 1 A.
const config = require("./joinr-config");
const { HttpError } = require("./httperror");

const notBuilt = () => {
  throw new HttpError(501, "Not built");
};

function syncRow(db) {
  return db.prepare("SELECT * FROM integration_sync WHERE name = 'joinr'").get() || null;
}

function status(db) {
  const r = syncRow(db) || {};
  return {
    configured: config.keyStatus().configured,
    baseUrl: config.getBaseUrl(),
    lastRunAt: r.last_run_at || null,
    lastOkAt: r.last_ok_at || null,
    lastError: r.last_error || null,
    lastErrorAt: r.last_error_at || null,
    lastItems: Number(r.last_items) || 0,
    running: false,
  };
}

async function fetchPage(opts) { notBuilt(); }
function validateItem(item) { notBuilt(); }
function applyItem(db, item) { notBuilt(); }
async function run(db, opts) { return { ok: false, items: 0, error: "Not built" }; }
// Called by server.js after listen; a no-op until Wave 1 A builds the timer.
function start(db) {}

module.exports = { fetchPage, validateItem, applyItem, run, start, status };
