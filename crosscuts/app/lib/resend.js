// Resend, the email service invoices are sent through (0.2.13). Plain HTTPS with Node's fetch, no SDK.
//
// The API key lives in a file in CONFIG_DIR (like the Joinr and Gemini keys): never in the database
// (settings are audited in full and copied into backups), never in a response, a URL or a log.
// RESEND_API_KEY in the environment wins (tests). The base URL is RESEND_BASE_URL, else the file
// resend-base-url in CONFIG_DIR (the smoke tests point it at a stand-in), else Resend's own.
const fs = require("fs");
const path = require("path");
const { CONFIG_DIR } = require("./config");
const { HttpError } = require("./httperror");

const DEFAULT_BASE = "https://api.resend.com";
const KEY_FILE = path.join(CONFIG_DIR, "resend-api-key");
const BASE_FILE = path.join(CONFIG_DIR, "resend-base-url");
const TIMEOUT_MS = 30000;
const KEY_OK = /^[\x21-\x7e]{8,200}$/;

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function envKey() {
  return process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim() ? process.env.RESEND_API_KEY.trim() : "";
}

function getKey() {
  return envKey() || readFile(KEY_FILE) || null;
}

function getBaseUrl() {
  const v = (process.env.RESEND_BASE_URL && process.env.RESEND_BASE_URL.trim()) || readFile(BASE_FILE) || DEFAULT_BASE;
  return v.replace(/\/+$/, "");
}

// What the browser may know: whether a key is set and its last four characters.
function keyStatus() {
  const key = getKey();
  return { configured: !!key, last4: key ? key.slice(-4) : null, fromEnv: !!envKey() };
}

function setKey(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!KEY_OK.test(v)) throw new HttpError(400, "The API key must be 8 to 200 characters with no spaces");
  if (envKey()) throw new HttpError(409, "The API key is set by the server's environment and can't be changed here");
  fs.writeFileSync(KEY_FILE, v + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(KEY_FILE, 0o600);
  } catch {
    // Windows dev boxes ignore modes.
  }
}

function clearKey() {
  if (envKey()) throw new HttpError(409, "The API key is set by the server's environment and can't be removed here");
  fs.rmSync(KEY_FILE, { force: true });
}

const NOT_SET_UP =
  "Email isn't set up yet. An administrator needs to add the Resend API key (Admin, Users, Invoice email).";

// A failure talking to Resend. `message` is safe to show the sender (never the key).
class ResendError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 0;
  }
}

function clip(s, n) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function call(method, urlPath, payload, extraHeaders) {
  const key = getKey();
  if (!key) throw new HttpError(409, NOT_SET_UP);
  let res;
  try {
    res = await fetch(getBaseUrl() + urlPath, {
      method,
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        "User-Agent": "crosscuts-invoices/1",
        ...(extraHeaders || {}),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new ResendError(
      timedOut
        ? "Resend took too long to answer. The email may or may not have gone: check the invoice's email history before trying again."
        : "Couldn't reach Resend. Check the internet connection and try again."
    );
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.ok) return data || {};
  const why = data && typeof data.message === "string" ? clip(data.message, 300) : "";
  if (res.status === 401) throw new ResendError("Resend didn't accept the API key. An administrator needs to check it.", 401);
  if (res.status === 429) throw new ResendError("Resend is busy (too many emails at once). Try again in a minute.", 429);
  if (res.status >= 500) throw new ResendError(`Resend had a problem (${res.status}). Try again shortly.`, res.status);
  throw new ResendError(`Resend refused the email${why ? ": " + why : ` (${res.status})`}`, res.status);
}

// {from, to[], cc[], replyTo, subject, text, attachments:[{filename, content: Buffer}]} -> Resend's id.
async function sendEmail(m, idempotencyKey) {
  const payload = {
    from: m.from,
    to: m.to,
    subject: m.subject,
    text: m.text,
    reply_to: m.replyTo,
    attachments: (m.attachments || []).map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
  };
  if (m.cc && m.cc.length) payload.cc = m.cc;
  if (m.bcc && m.bcc.length) payload.bcc = m.bcc;
  const out = await call("POST", "/emails", payload, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined);
  if (!out || typeof out.id !== "string" || !out.id) throw new ResendError("Resend answered without an email id. Check the invoice's email history before trying again.");
  return out.id;
}

// The email's last_event, e.g. "delivered", "bounced", "delivery_delayed" (null when Resend sends none).
async function getEmail(id) {
  const out = await call("GET", "/emails/" + encodeURIComponent(id));
  return { lastEvent: out && typeof out.last_event === "string" ? out.last_event : null };
}

module.exports = {
  DEFAULT_BASE,
  NOT_SET_UP,
  ResendError,
  getKey,
  getBaseUrl,
  keyStatus,
  setKey,
  clearKey,
  sendEmail,
  getEmail,
};
