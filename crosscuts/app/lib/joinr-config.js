// Joinr connection settings (m6-contracts.md section 2). The API key and the base URL live in
// files in CONFIG_DIR, as the Gemini key does: never in the database (settings are audited in
// full and copied into backups), never in a URL, a response or a log. Env vars win for tests.
const fs = require("fs");
const path = require("path");
const { CONFIG_DIR } = require("./config");
const { HttpError } = require("./httperror");

const DEFAULT_BASE = "https://app.joinr.com.au";
const KEY_FILE = path.join(CONFIG_DIR, "joinr-api-key");
const BASE_FILE = path.join(CONFIG_DIR, "joinr-base-url");

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function getKey() {
  if (process.env.JOINR_API_KEY && process.env.JOINR_API_KEY.trim()) return process.env.JOINR_API_KEY.trim();
  return readFile(KEY_FILE) || null;
}

function getBaseUrl() {
  const v = (process.env.JOINR_BASE_URL && process.env.JOINR_BASE_URL.trim()) || readFile(BASE_FILE) || DEFAULT_BASE;
  return v.replace(/\/+$/, "");
}

function keyStatus() {
  const key = getKey();
  return {
    configured: !!key,
    last4: key ? key.slice(-4) : null,
    fromEnv: !!(process.env.JOINR_API_KEY && process.env.JOINR_API_KEY.trim()),
  };
}

function setKey(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length < 8 || v.length > 200 || !/^[\x21-\x7e]+$/.test(v)) {
    throw new HttpError(400, "The API key must be 8 to 200 characters with no spaces");
  }
  fs.writeFileSync(KEY_FILE, v + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(KEY_FILE, 0o600);
  } catch {
    // Windows dev boxes ignore modes.
  }
}

function clearKey() {
  if (process.env.JOINR_API_KEY && process.env.JOINR_API_KEY.trim()) {
    throw new HttpError(409, "The API key is set by the server's environment and can't be removed here");
  }
  fs.rmSync(KEY_FILE, { force: true });
}

function baseUrlFromEnv() {
  return !!(process.env.JOINR_BASE_URL && process.env.JOINR_BASE_URL.trim());
}

// Plain http is allowed only where the key can't cross the internet in clear (M6 · 4.3):
// loopback (localhost, 127.0.0.0/8, ::1), the private IPv4 ranges (10/8, 172.16/12,
// 192.168/16) and *.local names. Everything else must be https.
function isLocalHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".local")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Checks an address and returns it normalised (no trailing slash), or null for "use the
// standard address" (null/undefined/""). Throws HttpError 400.
function normaliseBaseUrl(url) {
  if (url === null || url === undefined || url === "") return null;
  if (typeof url !== "string") throw new HttpError(400, "The Joinr address must be text");
  if (!url.trim()) return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    throw new HttpError(400, "The Joinr address must be a full http(s) URL");
  }
  if (!/^https?:$/.test(u.protocol) || u.search || u.hash || u.username || u.password || url.length > 200) {
    throw new HttpError(400, "The Joinr address must be a plain http(s) URL with no query, fragment or credentials");
  }
  if (u.protocol === "http:" && !isLocalHost(u.hostname)) throw new HttpError(400, "Use an https address");
  return u.toString().replace(/\/+$/, "");
}

function setBaseUrl(url) {
  const v = normaliseBaseUrl(url);
  if (v === null) {
    fs.rmSync(BASE_FILE, { force: true });
    return;
  }
  fs.writeFileSync(BASE_FILE, v + "\n");
}

module.exports = {
  DEFAULT_BASE,
  getKey,
  getBaseUrl,
  baseUrlFromEnv,
  keyStatus,
  setKey,
  clearKey,
  normaliseBaseUrl,
  setBaseUrl,
  isLocalHost,
};
