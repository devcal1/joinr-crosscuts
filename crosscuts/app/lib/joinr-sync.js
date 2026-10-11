// Pulls won quotes from Joinr (m6-contracts.md sections 2 and 4; the wire contract is
// docs/integrations/joinr-crosscuts-intake.md).
//
// Rules that matter here:
// - The API key goes only into the Authorization header. It never appears in a URL, an
//   error message, a log line, a response or the database.
// - A network pull runs inside a timer, so nothing may escape as an unhandled rejection
//   (that would stop Node, and the board with it). run() never throws.
// - One sync at a time: the timer, POST /sync and POST /import share one in-flight lock.
// - One transaction per item, and the stored cursor moves with the item it was handled for,
//   so the cursor only ever advances past items that were applied (or refused as invalid).
const config = require("./joinr-config");
const notify = require("./notify");

const PATH = "/api/integrations/crosscuts/won-quotes";
const TIMEOUT_MS = 15 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_TICK_MS = 30 * 1000;
const NOT_SET_UP = "Joinr is not set up";

const EVENTS = ["won", "unwon", "changed", "deleted"];
const STATUSES = ["draft", "ready", "sent", "won", "lost"];
const STANDINGS = ["active", "alternative", "superseded"];
const BENCHTOPS = ["laminate", "stone", "none"];
const HOUR_KEYS = ["office", "factory", "site", "travel"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------------ helpers ---

function nowIso() {
  return new Date().toISOString();
}

// Belt and braces: whatever produced a message, the key is never stored or shown.
function scrub(message) {
  let m = String(message == null ? "" : message);
  const key = config.getKey();
  if (key && m.includes(key)) m = m.split(key).join("****");
  return m.slice(0, 300);
}

// A cursor as it may appear in a log line: short and printable only.
function logCursor(c) {
  if (typeof c !== "string" && typeof c !== "number") return "?";
  return String(c).replace(/[^\x21-\x7e]/g, "").slice(0, 40) || "?";
}

function ensureRow(db) {
  db.prepare("INSERT OR IGNORE INTO integration_sync (name) VALUES ('joinr')").run();
}

function syncRow(db) {
  return db.prepare("SELECT * FROM integration_sync WHERE name = 'joinr'").get() || null;
}

function setCursor(db, cursor) {
  db.prepare("UPDATE integration_sync SET cursor = ? WHERE name = 'joinr'").run(String(cursor));
}

// A cursor from Joinr: an opaque non-empty string (a whole number is tolerated).
function asCursor(v) {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && v.length >= 1 && v.length <= 100 && /^[\x21-\x7e]+$/.test(v)) return v;
  return null;
}

// --------------------------------------------------------------- fetchPage ---

// An error whose message was written here and is safe to store and show.
class JoinrError extends Error {}

// One page from Joinr. Throws a plain Error whose message never holds the key or the URL.
async function fetchPage({ after, backfill, limit } = {}) {
  const key = config.getKey();
  if (!key) throw new JoinrError(NOT_SET_UP);
  const params = new URLSearchParams();
  if (backfill) params.set("backfill", "won");
  if (after !== undefined && after !== null && after !== "") params.set("after", String(after));
  params.set("limit", String(limit || PAGE_LIMIT));

  let url;
  try {
    url = new URL(config.getBaseUrl() + PATH);
  } catch {
    throw new JoinrError("The Joinr address is not a valid URL");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new JoinrError("The Joinr address must be a plain http(s) URL");
  }
  url.search = params.toString();

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      // A redirect could carry the key somewhere else; the contract has none.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new JoinrError(networkMessage(e));
  }

  try {
    if (!res.ok) {
      if (res.status === 401) throw new JoinrError("Joinr refused the API key (HTTP 401)");
      if (res.status === 429) throw new JoinrError("Joinr is limiting requests (HTTP 429); trying again next time");
      throw new JoinrError(`Joinr answered HTTP ${res.status}`);
    }
    const type = String(res.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("application/json")) throw new JoinrError("Joinr sent a response that is not JSON");
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new JoinrError("Joinr sent a response over 2 MB");
    const text = await readCapped(res);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new JoinrError("Joinr sent a response that is not valid JSON");
    }
    return checkEnvelope(body);
  } catch (e) {
    // Release the socket on every refusal (a no-op once the body was read).
    try {
      if (res.body && !res.bodyUsed) await res.body.cancel();
    } catch {
      // ignore
    }
    if (e instanceof JoinrError) throw e;
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) throw new JoinrError(networkMessage(e));
    throw new JoinrError("Joinr's response could not be read");
  }
}

function networkMessage(e) {
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return `Joinr did not answer within ${TIMEOUT_MS / 1000} seconds`;
  }
  const code = e && e.cause && typeof e.cause.code === "string" ? e.cause.code : "";
  if (/redirect/i.test(String((e && e.cause && e.cause.message) || ""))) {
    return "Joinr redirected the request; check the Joinr address";
  }
  return code && /^[A-Z_]+$/.test(code) ? `Could not reach Joinr (${code})` : "Could not reach Joinr";
}

// Reads the body as text, refusing more than MAX_BYTES as it streams in.
async function readCapped(res) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new JoinrError("Joinr sent a response over 2 MB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
}

function checkEnvelope(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new JoinrError("Joinr sent a response in an unexpected shape");
  }
  if (body.contract !== undefined && body.contract !== 1) {
    throw new JoinrError("Joinr sent a different contract version");
  }
  const cursor = asCursor(body.cursor);
  if (cursor === null) throw new JoinrError("Joinr sent a response without a valid cursor");
  if (!Array.isArray(body.items)) throw new JoinrError("Joinr sent a response without an items list");
  if (body.items.length > 1000) throw new JoinrError("Joinr sent too many items in one page");
  if (body.more !== undefined && typeof body.more !== "boolean") {
    throw new JoinrError("Joinr sent a response in an unexpected shape");
  }
  return { cursor, items: body.items, more: body.more === true };
}

// ------------------------------------------------------------ validateItem ---

function invalid(reason) {
  return new Error(reason);
}

function optString(item, name, max) {
  const v = item[name];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw invalid(`${name} must be a string or null`);
  const t = v.trim();
  if (t.length > max) throw invalid(`${name} is too long`);
  return t || null;
}

function optIso(item, name) {
  const v = item[name];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v))) {
    throw invalid(`${name} must be an ISO date-time or null`);
  }
  return v;
}

function oneOf(item, name, allowed) {
  const v = item[name];
  if (!allowed.includes(v)) throw invalid(`${name} must be one of ${allowed.join(", ")}`);
  return v;
}

function stringList(raw, name) {
  const v = raw[name];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 500) throw invalid(`raw.${name} must be a list of strings`);
  return v.map((s) => {
    if (typeof s !== "string" || s.length > 1000) throw invalid(`raw.${name} must be a list of strings`);
    return s;
  });
}

// Checks one item against the wire contract. Returns a normalised copy holding only the
// contract's fields (in a fixed order), or throws an Error whose message names the field.
// Messages never quote the values.
function validateItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid("the item is not an object");
  const cursor = asCursor(item.cursor);
  if (cursor === null) throw invalid("cursor is missing or not a string");
  const event = oneOf(item, "event", EVENTS);
  for (const name of ["quoteId", "rootQuoteId"]) {
    if (typeof item[name] !== "string" || !UUID.test(item[name])) throw invalid(`${name} must be a uuid`);
  }
  if (!Number.isSafeInteger(item.revision) || item.revision < 0) throw invalid("revision must be a whole number");
  const quoteNumber = optString(item, "quoteNumber", 100);
  const status = oneOf(item, "status", STATUSES);
  const standing = oneOf(item, "standing", STANDINGS);
  const deletedAt = optIso(item, "deletedAt");
  const wonAt = optIso(item, "wonAt");
  const updatedAt = optIso(item, "updatedAt");
  if (!updatedAt) throw invalid("updatedAt is required");
  if (item.clientName !== null && item.clientName !== undefined && typeof item.clientName !== "string") {
    throw invalid("clientName must be a string");
  }
  const clientName = (item.clientName || "").trim();
  if (clientName.length > 500) throw invalid("clientName is too long");
  const clientPhone = optString(item, "clientPhone", 100);
  const clientEmail = optString(item, "clientEmail", 320);
  const siteAddress = optString(item, "siteAddress", 500);
  const label = optString(item, "label", 500);
  const reference = optString(item, "reference", 500);
  let quoteDate = null;
  if (item.quoteDate !== null && item.quoteDate !== undefined) {
    if (typeof item.quoteDate !== "string" || !YMD.test(item.quoteDate) || Number.isNaN(Date.parse(item.quoteDate))) {
      throw invalid("quoteDate must be YYYY-MM-DD or null");
    }
    quoteDate = item.quoteDate;
  }
  let valueIncGstCents = null;
  if (item.valueIncGstCents !== null && item.valueIncGstCents !== undefined) {
    const v = item.valueIncGstCents;
    if (!Number.isSafeInteger(v) || v < 0 || v > 1e12) throw invalid("valueIncGstCents must be whole cents or null");
    valueIncGstCents = v;
  }
  let estimatedHours = null;
  if (item.estimatedHours !== null && item.estimatedHours !== undefined) {
    const h = item.estimatedHours;
    if (!h || typeof h !== "object" || Array.isArray(h)) throw invalid("estimatedHours must be an object or null");
    estimatedHours = {};
    for (const k of HOUR_KEYS) {
      if (typeof h[k] !== "number" || !Number.isFinite(h[k]) || h[k] < 0 || h[k] > 1e6) {
        throw invalid(`estimatedHours.${k} must be a number`);
      }
      estimatedHours[k] = h[k];
    }
  }
  const s = item.spec;
  if (!s || typeof s !== "object" || Array.isArray(s)) throw invalid("spec must be an object");
  let sheetCount = null;
  if (s.sheetCount !== null && s.sheetCount !== undefined) {
    if (!Number.isSafeInteger(s.sheetCount) || s.sheetCount < 0 || s.sheetCount > 100000) {
      throw invalid("spec.sheetCount must be a whole number or null");
    }
    sheetCount = s.sheetCount;
  }
  let twoPac = null;
  if (s.twoPac !== null && s.twoPac !== undefined) {
    if (typeof s.twoPac !== "boolean") throw invalid("spec.twoPac must be true, false or null");
    twoPac = s.twoPac;
  }
  let benchtop = null;
  if (s.benchtop !== null && s.benchtop !== undefined) {
    if (!BENCHTOPS.includes(s.benchtop)) throw invalid("spec.benchtop must be laminate, stone, none or null");
    benchtop = s.benchtop;
  }
  let jobType = null;
  if (s.jobType !== null && s.jobType !== undefined) {
    if (typeof s.jobType !== "string" || s.jobType.length > 200) throw invalid("spec.jobType must be a string or null");
    jobType = s.jobType.trim() || null;
  }
  const r = item.raw === undefined || item.raw === null ? {} : item.raw;
  if (typeof r !== "object" || Array.isArray(r)) throw invalid("raw must be an object");
  const raw = {
    doorsPanels: stringList(r, "doorsPanels"),
    benchtops: stringList(r, "benchtops"),
    jobTypes: stringList(r, "jobTypes"),
  };
  let url;
  try {
    url = new URL(item.url);
  } catch {
    throw invalid("url must be an http(s) link");
  }
  if (typeof item.url !== "string" || item.url.length > 1000 || !/^https?:$/.test(url.protocol)) {
    throw invalid("url must be an http(s) link");
  }

  return {
    cursor,
    event,
    quoteId: item.quoteId.toLowerCase(),
    rootQuoteId: item.rootQuoteId.toLowerCase(),
    revision: item.revision,
    quoteNumber,
    status,
    standing,
    deletedAt,
    wonAt,
    updatedAt,
    clientName,
    clientPhone,
    clientEmail,
    siteAddress,
    label,
    reference,
    quoteDate,
    valueIncGstCents,
    estimatedHours,
    spec: { sheetCount, twoPac, benchtop, jobType },
    raw,
    url: item.url,
  };
}

// --------------------------------------------------------------- applyItem ---

// JSON with sorted keys, so two payloads compare equal whatever their key order.
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}

// The fields that matter for "did Joinr change it": everything but cursor and updatedAt.
function comparable(p) {
  if (!p || typeof p !== "object") return {};
  const { cursor, updatedAt, ...rest } = p; // eslint-disable-line no-unused-vars
  return rest;
}

const LABELS = {
  quoteId: "revision",
  revision: "revision",
  quoteNumber: "quote number",
  status: "status",
  standing: "standing",
  deletedAt: "deleted",
  wonAt: "won date",
  clientName: "client",
  clientPhone: "client phone",
  clientEmail: "client email",
  siteAddress: "site",
  label: "label",
  reference: "reference",
  quoteDate: "quote date",
  valueIncGstCents: "value",
  estimatedHours: "estimated hours",
  spec: "spec",
  raw: "spec",
  url: "link",
  event: "event",
};

function changedFields(oldP, newP) {
  const a = comparable(oldP);
  const b = comparable(newP);
  const out = [];
  for (const k of Object.keys(LABELS)) {
    if (k === "event") continue;
    if (canonical(a[k]) !== canonical(b[k])) {
      const label = LABELS[k];
      if (!out.includes(label)) out.push(label);
    }
  }
  return out;
}

function isLive(item) {
  return item.status === "won" && !item.deletedAt;
}

function titleFor(prefix, item) {
  const where = item.siteAddress || item.label || item.clientName || "";
  return `${prefix}: ${[item.quoteNumber, where].filter(Boolean).join(" ")}`.trim().slice(0, 200);
}

function alert(db, kind, id, title, body) {
  notify.toUsers(
    db,
    notify.usersWithKey(db, "design.view"),
    { kind, title, body: String(body || "").slice(0, 500), link: `/intake.html?item=${id}`, entityType: "joinr_intake", entityId: id },
    { dedupeUnread: true }
  );
}

function changeBody(item, row, fields) {
  if (item.event === "deleted" || item.deletedAt) return "The quote was deleted in Joinr. The job has not been changed.";
  if (item.event === "unwon" || item.status !== "won") {
    return `The quote is no longer won in Joinr (status ${item.status}). The job has not been changed.`;
  }
  if (item.quoteId !== row.quote_id) {
    return `Revision ${item.revision} of the quote was won in Joinr. The job has not been changed.`;
  }
  return fields.length
    ? `Changed in Joinr: ${fields.join(", ")}. The job has not been changed.`
    : "The quote was updated in Joinr. The job has not been changed.";
}

// Applies one validated item in its own transaction (nested in a caller's transaction it
// becomes a savepoint). Returns {action}. Section 4 of m6-contracts.md; the job is never edited.
function applyItem(db, item) {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM joinr_intake WHERE root_quote_id = ?").get(item.rootQuoteId);
    const payload = JSON.stringify(item);
    const now = nowIso();

    if (!row) {
      if (item.event !== "won" || !isLive(item)) return { action: "skipped" };
      const info = db
        .prepare(
          `INSERT INTO joinr_intake (root_quote_id, quote_id, quote_number, joinr_status, last_event, payload, state, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)`
        )
        .run(item.rootQuoteId, item.quoteId, item.quoteNumber, item.status, item.event, payload, now, now);
      const id = Number(info.lastInsertRowid);
      alert(db, "joinr.new", id, titleFor("New from Joinr", item), item.clientName || "");
      return { action: "created" };
    }

    const update = (extraSql = "", extraArgs = []) =>
      db
        .prepare(
          `UPDATE joinr_intake
              SET quote_id = ?, quote_number = ?, joinr_status = ?, last_event = ?, payload = ?, last_seen_at = ?${extraSql}
            WHERE id = ?`
        )
        .run(item.quoteId, item.quoteNumber, item.status, item.event, payload, now, ...extraArgs, row.id);

    let stored = null;
    try {
      stored = JSON.parse(row.payload);
    } catch {
      stored = null;
    }
    const fields = changedFields(stored, item);

    if (row.state === "new") {
      // A won quote that is gone (un-won, deleted, or no longer won) leaves the inbox.
      if (item.event === "unwon" || item.event === "deleted" || !isLive(item)) {
        update(", state = 'withdrawn'");
        return { action: "withdrawn" };
      }
      update();
      return { action: "updated" };
    }

    if (row.state === "withdrawn") {
      if (item.event === "won" && isLive(item)) {
        update(", state = 'new'");
        alert(db, "joinr.new", row.id, titleFor("New from Joinr", item), item.clientName || "");
        return { action: "restored" };
      }
      update();
      return { action: "updated" };
    }

    const differs =
      fields.length > 0 ||
      item.event === "unwon" ||
      item.event === "deleted" ||
      (item.event === "won" && item.quoteId !== row.quote_id);

    if (row.state === "ignored") {
      // Stays ignored; a real change is flagged silently.
      if (differs) update(", changed = 1");
      else update();
      return { action: "ignored" };
    }

    // accepted or linked
    if (!differs) {
      update();
      return { action: "skipped" };
    }
    const body = changeBody(item, row, fields);
    update(", changed = 1");
    alert(db, "joinr.changed", row.id, titleFor("Changed in Joinr", item), body);
    return { action: "flagged" };
  })();
}

// --------------------------------------------------------------------- run ---

let inflight = null; // {promise, backfill}

function record(db, fields) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE integration_sync SET ${sets} WHERE name = 'joinr'`).run(...Object.values(fields));
}

// Applies one page's items in order. Each item and the cursor move commit together.
// Returns {handled, skipped}; throws (after committing what was handled) on a database fault.
function applyPage(db, page, { moveCursor }) {
  let handled = 0;
  let skipped = 0;
  for (const raw of page.items) {
    let item;
    try {
      item = validateItem(raw);
    } catch (e) {
      const c = raw && typeof raw === "object" ? asCursor(raw.cursor) : null;
      console.warn(`[joinr] skipped item ${logCursor(c)}: ${scrub(e.message)}`);
      if (moveCursor && c !== null) setCursor(db, c);
      handled++;
      skipped++;
      continue;
    }
    db.transaction(() => {
      applyItem(db, item);
      if (moveCursor) setCursor(db, item.cursor);
    })();
    handled++;
  }
  return { handled, skipped };
}

async function runOnce(db, opts) {
  const backfill = !!(opts && opts.backfill);
  if (!config.getKey()) return { ok: false, items: 0, skipped: 0, error: NOT_SET_UP };
  let items = 0;
  let skipped = 0;
  try {
    ensureRow(db);
    record(db, { last_run_at: nowIso() });
    const stored = syncRow(db).cursor || null;

    if (backfill) {
      // Every currently won quote, once. The stored cursor is left alone unless there is
      // none yet, so no event between it and now is skipped.
      let after = null;
      let finalCursor = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await fetchPage({ backfill: true, after, limit: PAGE_LIMIT });
        const r = applyPage(db, page, { moveCursor: false });
        items += r.handled;
        skipped += r.skipped;
        after = page.cursor;
        if (!page.more) {
          finalCursor = page.cursor;
          break;
        }
      }
      if (finalCursor !== null && !stored) setCursor(db, finalCursor);
    } else if (!stored) {
      // First run with a key: start from now, no history.
      const page = await fetchPage({ limit: PAGE_LIMIT });
      setCursor(db, page.cursor);
      console.log("[joinr] first sync: cursor stored, no history fetched");
    } else {
      let after = stored;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await fetchPage({ after, limit: PAGE_LIMIT });
        const r = applyPage(db, page, { moveCursor: true });
        items += r.handled;
        skipped += r.skipped;
        // Every item on the page is handled, so the page's own cursor is safe to keep.
        setCursor(db, page.cursor);
        after = page.cursor;
        if (!page.more) break;
      }
    }

    record(db, { last_ok_at: nowIso(), last_error: null, last_error_at: null, last_items: items });
    if (items) console.log(`[joinr] sync${backfill ? " (import)" : ""}: ${items} item(s), ${skipped} skipped`);
    return { ok: true, items, skipped, error: null };
  } catch (e) {
    const error = scrub(e && e.message ? e.message : "Sync failed");
    try {
      ensureRow(db);
      record(db, { last_error: error, last_error_at: nowIso(), last_items: items });
    } catch (e2) {
      console.error("[joinr] could not record the sync error:", scrub(e2 && e2.message));
    }
    console.error(`[joinr] sync${backfill ? " (import)" : ""} failed: ${error}`);
    return { ok: false, items, skipped, error };
  }
}

// One sync run. Never throws. A call while a run is in flight waits for that run and
// returns its result; an import asked for during an ordinary run waits, then imports.
async function run(db, opts = {}) {
  const backfill = !!(opts && opts.backfill);
  try {
    while (inflight) {
      const current = inflight;
      const result = await current.promise;
      if (!backfill || current.backfill) return result;
    }
    const entry = { backfill, promise: null };
    entry.promise = runOnce(db, opts)
      .catch((e) => ({ ok: false, items: 0, skipped: 0, error: scrub(e && e.message ? e.message : "Sync failed") }))
      .finally(() => {
        if (inflight === entry) inflight = null;
      });
    inflight = entry;
    return await entry.promise;
  } catch (e) {
    return { ok: false, items: 0, skipped: 0, error: scrub(e && e.message ? e.message : "Sync failed") };
  }
}

// ------------------------------------------------------------------- timer ---

let started = false;
let timer = null;

// One timer tick: runs only with a key and when no run is in flight. Never rejects.
// Returns 'no-key', 'busy' or the run's result (for tests).
async function tick(db) {
  try {
    if (!config.getKey()) return "no-key";
    if (inflight) {
      console.log("[joinr] timer: a sync is already running, skipped");
      return "busy";
    }
    return await run(db);
  } catch (e) {
    console.error("[joinr] timer tick failed:", scrub(e && e.message ? e.message : e));
    return "error";
  }
}

// Every 5 minutes (and once shortly after boot), only while a key is configured.
// JOINR_SYNC_DISABLED=1 turns it off. opts.intervalMs / opts.firstMs exist for tests.
function start(db, opts = {}) {
  if (process.env.JOINR_SYNC_DISABLED === "1") return;
  if (started) return;
  started = true;
  const every = opts.intervalMs || INTERVAL_MS;
  const first = setTimeout(() => {
    tick(db).catch(() => {});
  }, opts.firstMs || FIRST_TICK_MS);
  first.unref();
  timer = setInterval(() => {
    tick(db).catch(() => {});
  }, every);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
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
    running: !!inflight,
  };
}

module.exports = { fetchPage, validateItem, applyItem, run, start, status, tick, stop, NOT_SET_UP };
