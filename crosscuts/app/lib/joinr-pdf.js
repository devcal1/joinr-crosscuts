// A job's Joinr quote PDF (job page Quote tab; docs/plans/jobpage-contracts.md sections B and D;
// the wire format is version 5 of docs/integrations/joinr-crosscuts-intake.md, "Quote PDF").
//
// What it does: GET {base}/api/integrations/crosscuts/quote-pdf?quoteId={uuid} with the same API key as
// the won-quotes pull, checks the answer strictly (application/pdf, starts "%PDF-", at most 20 MB) and
// keeps the last good copy as a file directly in <UPLOADS_DIR>/files, recorded in joinr_quote_pdfs
// (migration 067). The file name matches names.FILE_NAME_RE, so the NAS backup copies it like the
// purchase order PDFs (lib/purchaseorders.js); it is written as <name>.part and renamed, so a half
// file is never named like a copy and is never backed up.
//
// Rules that matter here (the same as lib/joinr-sync.js and lib/joinr-open-quotes.js):
// - The API key goes only into the Authorization header. It never appears in a URL, an error message,
//   a log line, a response or the database. The one query parameter is the quote id (a uuid).
// - redirect: "manual", never followed (a redirect could carry the key somewhere else; a Joinr before version 5 answers the route with a 3xx to its sign-in page), a 30 second timeout.
// - One attempt a minute per job (the guard is the stored last_attempt_at, so it holds across restarts
//   and across the page and the Refresh button alike). A 429 is honoured: no attempt before its
//   Retry-After has passed (kept in memory: a restart forgets it, and the minute guard still holds).
// - A failure keeps the old copy and says so. A 3xx reads "Joinr doesn't offer the PDF yet."; 404, 401 and 503 have their own
//   plain words (contract v5). The file's sha256 is stored for the record only: the PDF is not byte-stable, so it is never used to detect change.
// - ensure() never throws.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./joinr-config");
const sync = require("./joinr-sync");
const { UPLOADS_DIR } = require("./config");

// Absolute, as res.sendFile needs. The same folder as lib/files.js (never served statically).
const FILES_DIR = path.resolve(UPLOADS_DIR, "files");
const PATH = "/api/integrations/crosscuts/quote-pdf";
const MIN_GAP_MS = 60 * 1000;
const TIMEOUT_MS = 30 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_RETRY_AFTER_S = 60 * 60;
const DEFAULT_RETRY_AFTER_S = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^joinr-quote-\d+-[0-9a-f]{12}\.pdf$/;

// "Not offered / not available" answers, in plain words. None of them ever removes a kept copy.
const UNAVAILABLE_TEXT = "Joinr doesn't offer the PDF yet."; // a 3xx: a Joinr before version 5 redirects to its sign-in page
const NOT_WON_TEXT = "Joinr says this quote isn't available (not won, or deleted).";
const KEY_TEXT = "Joinr didn't accept the API key.";
const BUSY_TEXT = "Joinr couldn't make the PDF just now.";
const UNAVAILABLE_TEXTS = [UNAVAILABLE_TEXT, NOT_WON_TEXT, KEY_TEXT, BUSY_TEXT];

class PdfError extends Error {
  constructor(message, kind, retryAfterSeconds) {
    super(message);
    this.kind = kind; // 'unavailable' | 'limited' | 'failed'
    this.retryAfterSeconds = retryAfterSeconds || 0;
  }
}

const nowIso = () => new Date().toISOString();

function retryAfterOf(res) {
  const n = Number(res.headers.get("retry-after"));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETRY_AFTER_S;
  return Math.min(Math.ceil(n), MAX_RETRY_AFTER_S);
}

async function cancelBody(res) {
  try {
    if (res.body && !res.bodyUsed) await res.body.cancel();
  } catch {
    // ignore
  }
}

// One read of the PDF. Resolves to a Buffer; throws PdfError whose message never holds the key or the URL.
async function fetchPdf(quoteId) {
  const key = config.getKey();
  if (!key) throw new PdfError(sync.NOT_SET_UP, "failed");
  if (typeof quoteId !== "string" || !UUID.test(quoteId)) throw new PdfError("This job's Joinr record has no quote id", "failed");
  let url;
  try {
    url = new URL(config.getBaseUrl() + PATH);
  } catch {
    throw new PdfError("The Joinr address is not a valid URL", "failed");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new PdfError("The Joinr address must be a plain http(s) URL", "failed");
  }
  url.search = "";
  url.searchParams.set("quoteId", quoteId.toLowerCase()); // exactly one parameter

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/pdf" },
      redirect: "manual", // never follow: a redirect could carry the key somewhere else
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new PdfError(sync.networkMessage(e), "failed");
  }

  try {
    if (res.status >= 300 && res.status < 400) throw new PdfError(UNAVAILABLE_TEXT, "unavailable");
    if (!res.ok) {
      if (res.status === 429) throw new PdfError("Joinr is limiting requests (HTTP 429)", "limited", retryAfterOf(res));
      if (res.status === 404) throw new PdfError(NOT_WON_TEXT, "unavailable");
      if (res.status === 401) throw new PdfError(KEY_TEXT, "unavailable");
      if (res.status === 503) throw new PdfError(BUSY_TEXT, "unavailable");
      throw new PdfError(`Joinr answered HTTP ${res.status}`, "failed");
    }
    const type = String(res.headers.get("content-type") || "").toLowerCase();
    if (!type.startsWith("application/pdf")) throw new PdfError("Joinr sent something that is not a PDF", "failed");
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new PdfError("Joinr sent a PDF over 20 MB", "failed");
    if (!res.body) throw new PdfError("Joinr sent an empty PDF", "failed");
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
        throw new PdfError("Joinr sent a PDF over 20 MB", "failed");
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    if (buf.length < 8 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new PdfError("Joinr sent something that is not a PDF", "failed");
    }
    return buf;
  } catch (e) {
    await cancelBody(res);
    if (e instanceof PdfError) throw e;
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) throw new PdfError(sync.networkMessage(e), "failed");
    throw new PdfError("Joinr's PDF could not be read", "failed");
  }
}

// --------------------------------------------------------------------- store ---

const intakeRow = (db, id) =>
  db.prepare("SELECT id, job_id, state, quote_id, quote_number, changed, last_seen_at, payload FROM joinr_intake WHERE id = ?").get(id) || null;
const pdfRow = (db, id) => db.prepare("SELECT * FROM joinr_quote_pdfs WHERE intake_id = ?").get(id) || null;

function ensureRow(db, row) {
  db.prepare("INSERT OR IGNORE INTO joinr_quote_pdfs (intake_id, quote_id) VALUES (?, ?)").run(row.id, row.quote_id);
}

function fileExists(name) {
  return typeof name === "string" && NAME_RE.test(name) && fs.existsSync(path.join(FILES_DIR, name));
}

function rmQuiet(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) return;
  try {
    fs.rmSync(path.join(FILES_DIR, name), { force: true });
  } catch {
    // ignore
  }
}

// Does the copy need fetching again? (No row, no file, another revision, or the record changed since.)
function stale(row, pdf) {
  if (!pdf || !pdf.file || !pdf.fetched_at || !fileExists(pdf.file)) return true;
  if (String(pdf.quote_id).toLowerCase() !== String(row.quote_id).toLowerCase()) return true;
  // A real change Joinr flagged after the copy was taken. (last_seen_at moves on every sighting, so it
  // only counts while the change is unacknowledged.)
  return !!row.changed && String(row.last_seen_at) > String(pdf.fetched_at);
}

// ------------------------------------------------------------------- refresh ---

const inflight = new Map(); // intake id -> Promise
const limitedUntil = new Map(); // intake id -> epoch ms
let epoch = 0;
let lastLogged = null;

function logOnChange(line) {
  if (line === lastLogged) return;
  lastLogged = line;
  console.log(line);
}

async function runOnce(db, row) {
  const myEpoch = epoch;
  const quoteId = String(row.quote_id).toLowerCase();
  ensureRow(db, row);
  db.prepare("UPDATE joinr_quote_pdfs SET last_attempt_at = ? WHERE intake_id = ?").run(nowIso(), row.id);
  let name = null;
  try {
    const buf = await fetchPdf(quoteId);
    if (epoch !== myEpoch) return { status: "failed" }; // the Joinr settings changed under this fetch
    name = `joinr-quote-${row.id}-${crypto.randomBytes(6).toString("hex")}.pdf`;
    const full = path.join(FILES_DIR, name);
    fs.mkdirSync(FILES_DIR, { recursive: true });
    fs.writeFileSync(full + ".part", buf);
    fs.renameSync(full + ".part", full);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const old = pdfRow(db, row.id);
    db.prepare(
      `UPDATE joinr_quote_pdfs
          SET quote_id = ?, file = ?, size = ?, sha256 = ?, fetched_at = ?, last_error = NULL
        WHERE intake_id = ?`
    ).run(quoteId, name, buf.length, sha, nowIso(), row.id);
    if (old && old.file && old.file !== name) rmQuiet(old.file);
    limitedUntil.delete(row.id);
    logOnChange(`[joinr] quote pdf: stored (${buf.length} bytes)`);
    return { status: "ok" };
  } catch (e) {
    if (name) {
      rmQuiet(name);
      try {
        fs.rmSync(path.join(FILES_DIR, name + ".part"), { force: true });
      } catch {
        // ignore
      }
    }
    if (epoch !== myEpoch) return { status: "failed" };
    const known = e instanceof PdfError;
    const message = known ? e.message : "Joinr's quote PDF could not be fetched";
    const kind = known ? e.kind : "failed";
    try {
      db.prepare("UPDATE joinr_quote_pdfs SET last_error = ? WHERE intake_id = ?").run(sync.scrub(message), row.id);
    } catch (e2) {
      console.error("[joinr] quote pdf: could not record the failure:", sync.scrub(e2 && e2.message));
    }
    if (kind === "limited") limitedUntil.set(row.id, Date.now() + e.retryAfterSeconds * 1000);
    logOnChange(`[joinr] quote pdf: ${sync.scrub(message)}`);
    if (kind === "limited") return { status: "limited", retryAfterSeconds: e.retryAfterSeconds };
    return { status: kind === "unavailable" ? "unavailable" : "failed" };
  }
}

// Brings a job's copy up to date when it needs it. What it did (for the page and the tests):
//   {status: 'fresh'}                      nothing to do (the copy is current)
//   {status: 'ok'}                         fetched and stored
//   {status: 'recent', retryAfterSeconds}  the once-a-minute guard
//   {status: 'limited', retryAfterSeconds} Joinr said 429 (now or earlier)
//   {status: 'unavailable'}                401/404/503: Joinr does not offer it (yet)
//   {status: 'failed'}                     anything else
//   {status: 'not-set-up'}                 no API key
//   {status: 'no-record'}                  no such intake record
// force (Refresh) fetches even a current copy, but never past the guard or a 429.
async function ensure(db, intakeId, { force = false } = {}) {
  try {
    const row = intakeRow(db, intakeId);
    if (!row) return { status: "no-record" };
    const pdf = pdfRow(db, intakeId);
    if (!force && !stale(row, pdf)) return { status: "fresh" };
    if (!config.getKey()) return { status: "not-set-up" };
    if (inflight.has(intakeId)) return await inflight.get(intakeId);
    const lim = limitedUntil.get(intakeId);
    if (lim && lim > Date.now()) return { status: "limited", retryAfterSeconds: Math.ceil((lim - Date.now()) / 1000) };
    if (pdf && pdf.last_attempt_at) {
      const wait = MIN_GAP_MS - (Date.now() - Date.parse(pdf.last_attempt_at));
      if (wait > 0) return { status: "recent", retryAfterSeconds: Math.ceil(wait / 1000) };
    }
    const mine = runOnce(db, row)
      .catch(() => ({ status: "failed" }))
      .finally(() => {
        if (inflight.get(intakeId) === mine) inflight.delete(intakeId);
      });
    inflight.set(intakeId, mine);
    return await mine;
  } catch (e) {
    console.error("[joinr] quote pdf failed:", sync.scrub(e && e.message ? e.message : e));
    return { status: "failed" };
  }
}

// The Joinr address changed or its key was removed: forget back-offs and the guard, and let a fetch
// that started before this store nothing. Copies already held stay (they are quotes, not settings).
function reset(db) {
  epoch++;
  lastLogged = null;
  limitedUntil.clear();
  try {
    db.prepare("UPDATE joinr_quote_pdfs SET last_attempt_at = NULL, last_error = NULL").run();
  } catch (e) {
    console.error("[joinr] quote pdf: reset failed:", sync.scrub(e && e.message));
  }
}

// ---------------------------------------------------------------------- view ---

// What pdf-status sends. The caller has checked jobs.view AND jobs.value.
function status(db, intakeId) {
  const row = intakeRow(db, intakeId);
  if (!row) return null;
  const pdf = pdfRow(db, intakeId);
  const has = !!(pdf && pdf.file && pdf.fetched_at && fileExists(pdf.file));
  let url = null;
  try {
    const p = JSON.parse(row.payload);
    if (p && typeof p.url === "string" && /^https?:\/\/\S+$/i.test(p.url)) url = p.url;
  } catch {
    url = null;
  }
  const error = pdf && pdf.last_error ? pdf.last_error : null;
  const lim = limitedUntil.get(intakeId);
  return {
    configured: !!config.getKey(),
    has,
    quoteNumber: row.quote_number,
    joinrUrl: url,
    fetchedAt: has ? pdf.fetched_at : null,
    size: has ? pdf.size : null,
    // The copy is for an earlier revision, or Joinr flagged a change after it was taken.
    outdated: has ? stale(row, pdf) : false,
    error,
    unavailable: UNAVAILABLE_TEXTS.includes(error),
    retryAfterSeconds: lim && lim > Date.now() ? Math.ceil((lim - Date.now()) / 1000) : 0,
    pdfUrl: `/api/job-records/${row.job_id}/joinr-quote/pdf`,
  };
}

// The stored copy for serving: {full, name} or null.
function copyOf(db, intakeId) {
  const pdf = pdfRow(db, intakeId);
  if (!pdf || !pdf.file || !fileExists(pdf.file)) return null;
  return { name: pdf.file, root: FILES_DIR };
}

module.exports = { ensure, reset, status, copyOf, FILES_DIR, MIN_GAP_MS, PATH, UNAVAILABLE_TEXT };
