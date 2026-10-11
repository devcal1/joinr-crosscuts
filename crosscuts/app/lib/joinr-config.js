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

function setBaseUrl(url) {
  if (url === null || url === undefined || url === "") {
    fs.rmSync(BASE_FILE, { force: true });
    return;
  }
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    throw new HttpError(400, "The Joinr address must be a full http(s) URL");
  }
  if (!/^https?:$/.test(u.protocol) || u.search || u.hash || u.username || u.password || String(url).length > 200) {
    throw new HttpError(400, "The Joinr address must be a plain http(s) URL with no query, fragment or credentials");
  }
  fs.writeFileSync(BASE_FILE, u.toString().replace(/\/+$/, "") + "\n");
}

module.exports = { DEFAULT_BASE, getKey, getBaseUrl, keyStatus, setKey, clearKey, setBaseUrl };
