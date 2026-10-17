// Pulls Joinr's open-quotes list (task J3, Crosscuts side; wire contract version 3 in
// docs/integrations/joinr-crosscuts-intake.md, "Open-quotes list"; Crosscuts side in
// docs/plans/m3-contracts.md section 13).
//
// What it does: GET {base}/api/integrations/crosscuts/open-quotes with the same API key as the
// won-quotes pull (and nothing else: Joinr's own server-side secret is Joinr's business), checks
// the answer strictly, and replaces the cache (tables joinr_open_quotes and
// joinr_open_quotes_meta, migration 031) in one transaction. The Pipeline's Quoted column reads
// the cache. joinr_intake and the inbox are not touched.
//
// Rules that matter here (the same as lib/joinr-sync.js):
// - The API key goes only into the Authorization header. It never appears in a URL, an error
//   message, a log line, a response or the database. The request has NO query string at all
//   (Joinr refuses any parameter with 400).
// - It runs inside a timer, so nothing may escape as an unhandled rejection. refresh() never throws.
// - Never more than one fetch a minute (the guard is the stored last_attempt_at, so it holds
//   across restarts, the timer and the Refresh button alike), and a 429 is honoured: no attempt
//   before its Retry-After has passed.
// - 400, 401, 404 and 503 mean "not available (yet)": the endpoint doesn't exist on a Joinr that
//   hasn't released J3, or the key/deployment isn't set up. That is quiet (one log line when it
//   changes) and leaves the cache exactly as it was, so Crosscuts carries on as before.
const config = require("./joinr-config");
const sync = require("./joinr-sync");
const intake = require("./intake");

const PATH = "/api/integrations/crosscuts/open-quotes";
const MIN_GAP_MS = 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_TICK_MS = 40 * 1000;
const MAX_LINES = 1000; // Joinr sends at most 200 (500 in an earlier draft); more than twice that is not Joinr
const MAX_RETRY_AFTER_S = 60 * 60;
const DEFAULT_RETRY_AFTER_S = 60;
const NOT_AVAILABLE = [400, 401, 404, 503];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_CENTS = 99999999999; // the same cap lib/intake.js applies

// An error whose message was written here and is safe to store and show.
class OpenQuotesError extends Error {
  constructor(message, kind, retryAfterSeconds) {
    super(message);
    this.kind = kind; // 'unavailable' | 'limited' | 'failed'
    this.retryAfterSeconds = retryAfterSeconds || 0;
  }
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- validation ---

function invalid(msg) {
  return new Error(msg);
}

// A text field: a string, or null/undefined when allowed. Blank becomes null (or "" when not nullable).
function text(v, field, max, nullable) {
  if (v === null || v === undefined) {
    if (nullable) return null;
    throw invalid(`${field} must be text`);
  }
  if (typeof v !== "string") throw invalid(`${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw invalid(`${field} is too long`);
  return t === "" && nullable ? null : t;
}

function isoUtc(v, field, nullable) {
  if (v === null || v === undefined) {
    if (nullable) return null;
    throw invalid(`${field} must be a date and time`);
  }
  if (typeof v !== "string" || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v))) {
    throw invalid(`${field} must be an ISO date and time`);
  }
  return new Date(v).toISOString(); // one format, so the text sorts as time
}

// One line of the answer, or an Error naming the field (never the value).
function validateLine(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("line is not an object");
  if (typeof raw.quoteId !== "string" || !UUID.test(raw.quoteId)) throw invalid("quoteId must be a uuid");
  if (typeof raw.rootQuoteId !== "string" || !UUID.test(raw.rootQuoteId)) throw invalid("rootQuoteId must be a uuid");
  if (raw.status !== "sent" && raw.status !== "won") throw invalid("status must be sent or won");
  let value = null;
  if (raw.valueIncGstCents !== null && raw.valueIncGstCents !== undefined) {
    const c = raw.valueIncGstCents;
    if (!Number.isInteger(c) || c < 0 || c > MAX_CENTS) throw invalid("valueIncGstCents must be a whole number of cents");
    value = c;
  }
  const url = typeof raw.url === "string" ? intake.httpUrl(raw.url) : null;
  if (!url) throw invalid("url must be an http(s) link");
  const wonAt = isoUtc(raw.wonAt, "wonAt", true);
  return {
    quoteId: raw.quoteId.toLowerCase(),
    rootQuoteId: raw.rootQuoteId.toLowerCase(),
    quoteNumber: text(raw.quoteNumber, "quoteNumber", 100, true),
    status: raw.status,
    clientName: text(raw.clientName, "clientName", 200, false),
    siteAddress: text(raw.siteAddress, "siteAddress", 300, true),
    label: text(raw.label, "label", 200, true),
    valueIncGstCents: value,
    sentAt: isoUtc(raw.sentAt, "sentAt", true),
    wonAt: raw.status === "won" ? wonAt : null,
    updatedAt: isoUtc(raw.updatedAt, "updatedAt", false),
    url,
  };
}

// The envelope, then every line. Bad lines are dropped and logged by field, never by value.
function checkAnswer(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OpenQuotesError("Joinr sent a response in an unexpected shape", "failed");
  }
  if (body.contract !== 3) throw new OpenQuotesError("Joinr sent a different contract version", "failed");
  let generatedAt;
  try {
    generatedAt = isoUtc(body.generatedAt, "generatedAt", false);
  } catch {
    throw new OpenQuotesError("Joinr sent a response without a valid generatedAt", "failed");
  }
  if (typeof body.truncated !== "boolean") throw new OpenQuotesError("Joinr sent a response in an unexpected shape", "failed");
  if (!Array.isArray(body.quotes)) throw new OpenQuotesError("Joinr sent a response without a quotes list", "failed");
  if (body.quotes.length > MAX_LINES) throw new OpenQuotesError("Joinr sent too many quotes", "failed");

  const lines = [];
  const seen = new Set();
  let dropped = 0;
  body.quotes.forEach((raw, i) => {
    try {
      const line = validateLine(raw);
      if (seen.has(line.quoteId)) throw invalid("quoteId is listed twice");
      seen.add(line.quoteId);
      lines.push(line);
    } catch (e) {
      dropped++;
      if (dropped <= 5) console.warn(`[joinr] open-quotes: dropped line ${i}: ${sync.scrub(e.message)}`);
    }
  });
  if (dropped > 5) console.warn(`[joinr] open-quotes: dropped ${dropped} lines in all`);
  return { generatedAt, truncated: body.truncated, lines, dropped };
}

// -------------------------------------------------------------------- fetch ---

function retryAfterOf(res) {
  const n = Number(res.headers.get("retry-after"));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETRY_AFTER_S;
  return Math.min(Math.ceil(n), MAX_RETRY_AFTER_S);
}

// One read of the list. Throws OpenQuotesError; the message never holds the key or the URL.
async function fetchList() {
  const key = config.getKey();
  if (!key) throw new OpenQuotesError(sync.NOT_SET_UP, "failed");
  let url;
  try {
    url = new URL(config.getBaseUrl() + PATH);
  } catch {
    throw new OpenQuotesError("The Joinr address is not a valid URL", "failed");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new OpenQuotesError("The Joinr address must be a plain http(s) URL", "failed");
  }
  url.search = ""; // Joinr refuses any query parameter

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error", // a redirect could carry the key somewhere else
      signal: AbortSignal.timeout(sync.TIMEOUT_MS),
    });
  } catch (e) {
    throw new OpenQuotesError(sync.networkMessage(e), "failed");
  }

  try {
    if (!res.ok) {
      if (res.status === 429) {
        throw new OpenQuotesError("Joinr is limiting requests (HTTP 429)", "limited", retryAfterOf(res));
      }
      if (NOT_AVAILABLE.includes(res.status)) {
        throw new OpenQuotesError(`Joinr's quote list is not available (HTTP ${res.status})`, "unavailable");
      }
      throw new OpenQuotesError(`Joinr answered HTTP ${res.status}`, "failed");
    }
    const type = String(res.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("application/json")) throw new OpenQuotesError("Joinr sent a response that is not JSON", "failed");
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) {
      throw new OpenQuotesError("Joinr sent a response over 2 MB", "failed");
    }
    const raw = await sync.readCapped(res);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new OpenQuotesError("Joinr sent a response that is not valid JSON", "failed");
    }
    return checkAnswer(body);
  } catch (e) {
    try {
      if (res.body && !res.bodyUsed) await res.body.cancel();
    } catch {
      // ignore
    }
    if (e instanceof OpenQuotesError) throw e;
    if (e instanceof sync.JoinrError) throw new OpenQuotesError(e.message, "failed");
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new OpenQuotesError(sync.networkMessage(e), "failed");
    }
    throw new OpenQuotesError("Joinr's response could not be read", "failed");
  }
}

// --------------------------------------------------------------------- store ---

function metaRow(db) {
  return db.prepare("SELECT * FROM joinr_open_quotes_meta WHERE id = 1").get() || null;
}

function ensureMeta(db) {
  db.prepare("INSERT OR IGNORE INTO joinr_open_quotes_meta (id) VALUES (1)").run();
}

// A good fetch: the list and the meta row are replaced together, or not at all.
function storeAnswer(db, answer, fetchedAt) {
  db.transaction(() => {
    ensureMeta(db);
    db.prepare("DELETE FROM joinr_open_quotes").run();
    const ins = db.prepare(
      `INSERT INTO joinr_open_quotes
         (quote_id, root_quote_id, quote_number, status, client_name, site_address, label,
          value_inc_gst_cents, sent_at, won_at, updated_at, url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of answer.lines) {
      ins.run(
        l.quoteId, l.rootQuoteId, l.quoteNumber, l.status, l.clientName, l.siteAddress, l.label,
        l.valueIncGstCents, l.sentAt, l.wonAt, l.updatedAt, l.url, fetchedAt
      );
    }
    db.prepare(
      `UPDATE joinr_open_quotes_meta
          SET fetched_at = ?, generated_at = ?, truncated = ?, line_count = ?,
              last_attempt_at = ?, last_error = NULL, retry_after_until = NULL
        WHERE id = 1`
    ).run(fetchedAt, answer.generatedAt, answer.truncated ? 1 : 0, answer.lines.length, fetchedAt);
  })();
}

function recordFailure(db, message, retryAfterSeconds) {
  const until = retryAfterSeconds ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString() : null;
  ensureMeta(db);
  db.prepare("UPDATE joinr_open_quotes_meta SET last_attempt_at = ?, last_error = ?, retry_after_until = ? WHERE id = 1").run(
    nowIso(),
    String(message).slice(0, 300),
    until
  );
}

// ------------------------------------------------------------------- refresh ---

let inflight = null;
// Bumped by reset(): a fetch that started before it stores nothing.
let epoch = 0;
let lastLogged = null;

function logOnChange(line) {
  if (line === lastLogged) return;
  lastLogged = line;
  console.log(line);
}

// What a refresh did, for the Refresh button and the tests:
//   {status: 'ok', lines, dropped}         fetched and stored
//   {status: 'recent', retryAfterSeconds}  the once-a-minute guard
//   {status: 'limited', retryAfterSeconds} Joinr said 429 (now or earlier)
//   {status: 'unavailable'}                400/401/404/503: Joinr has no such list (yet)
//   {status: 'failed'}                     anything else (network, 5xx, a bad answer)
//   {status: 'not-set-up'}                 no API key
async function runOnce(db) {
  const myEpoch = epoch;
  const attemptAt = nowIso();
  ensureMeta(db);
  db.prepare("UPDATE joinr_open_quotes_meta SET last_attempt_at = ? WHERE id = 1").run(attemptAt);
  try {
    const answer = await fetchList();
    if (epoch !== myEpoch) return { status: "failed" }; // the Joinr settings changed under this fetch
    storeAnswer(db, answer, nowIso());
    logOnChange(`[joinr] open-quotes: ${answer.lines.length} line(s)${answer.truncated ? " (truncated)" : ""}`);
    return { status: "ok", lines: answer.lines.length, dropped: answer.dropped };
  } catch (e) {
    if (epoch !== myEpoch) return { status: "failed" };
    const known = e instanceof OpenQuotesError;
    const message = known ? e.message : "Joinr's open-quotes list could not be fetched";
    const kind = known ? e.kind : "failed";
    try {
      recordFailure(db, message, kind === "limited" ? e.retryAfterSeconds : 0);
    } catch (e2) {
      console.error("[joinr] open-quotes: could not record the failure:", sync.scrub(e2 && e2.message));
    }
    if (kind === "unavailable") logOnChange(`[joinr] open-quotes: not available (${sync.scrub(message)})`);
    else logOnChange(`[joinr] open-quotes: ${sync.scrub(message)}`);
    if (kind === "limited") return { status: "limited", retryAfterSeconds: e.retryAfterSeconds };
    return { status: kind === "unavailable" ? "unavailable" : "failed" };
  }
}

// One refresh: the timer and the Refresh button both come through here. Never throws.
async function refresh(db) {
  try {
    if (!config.getKey()) return { status: "not-set-up" };
    if (inflight) return await inflight; // a fetch is already under way: share its result
    const meta = metaRow(db);
    const now = Date.now();
    if (meta && meta.retry_after_until) {
      const wait = Date.parse(meta.retry_after_until) - now;
      if (wait > 0) return { status: "limited", retryAfterSeconds: Math.ceil(wait / 1000) };
    }
    if (meta && meta.last_attempt_at) {
      const wait = MIN_GAP_MS - (now - Date.parse(meta.last_attempt_at));
      if (wait > 0) return { status: "recent", retryAfterSeconds: Math.ceil(wait / 1000) };
    }
    const mine = runOnce(db)
      .catch(() => ({ status: "failed" }))
      .finally(() => {
        if (inflight === mine) inflight = null;
      });
    inflight = mine;
    return await mine;
  } catch (e) {
    console.error("[joinr] open-quotes refresh failed:", sync.scrub(e && e.message ? e.message : e));
    return { status: "failed" };
  }
}

// ------------------------------------------------------------------- timer ---

let started = false;
let timer = null;

// Every 5 minutes (and once shortly after boot), only while a key is configured, on the
// won-quotes poll's schedule. JOINR_SYNC_DISABLED=1 turns it off (with the won-quotes poll);
// JOINR_OPEN_QUOTES_TIMER_DISABLED=1 turns off only this timer (CI only: the smoke suite fetches
// by pressing Refresh and must not have a timer tick eat a request it is counting). opts exist
// for tests.
function start(db, opts = {}) {
  if (process.env.JOINR_SYNC_DISABLED === "1") return;
  if (process.env.JOINR_OPEN_QUOTES_TIMER_DISABLED === "1") return;
  if (started) return;
  started = true;
  const tick = () => {
    refresh(db).catch(() => {});
  };
  const first = setTimeout(tick, opts.firstMs || FIRST_TICK_MS);
  first.unref();
  timer = setInterval(tick, opts.intervalMs || INTERVAL_MS);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

// The Joinr address changed or its key was removed: the list belongs to the old connection.
function reset(db) {
  epoch++;
  lastLogged = null;
  db.transaction(() => {
    db.prepare("DELETE FROM joinr_open_quotes").run();
    db.prepare("DELETE FROM joinr_open_quotes_meta").run();
  })();
}

module.exports = {
  refresh,
  start,
  stop,
  reset,
  validateLine,
  checkAnswer,
  MIN_GAP_MS,
  PATH,
};
