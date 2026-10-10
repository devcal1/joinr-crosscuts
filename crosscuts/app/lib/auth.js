// Authentication and authorisation middleware, plus the session/cookie helpers
// routes/auth.js needs. Contract: docs/plans/m1-contracts.md ("Auth").
//
//  - Cookie `crosscuts_sid` holds 32 random bytes (base64url); the DB stores
//    only sha256(token) as sessions.id.
//  - Cookie `crosscuts_dev` (remembered devices) works the same way against
//    devices.token_hash.
//  - Cookies are parsed by hand, so there is no extra dependency.
const crypto = require("crypto");
const path = require("path");
const { computeEffective } = require("./permissions");
const { pageAccess, isPagePath } = require("./pages");

const SID_COOKIE = "crosscuts_sid";
const DEV_COOKIE = "crosscuts_dev";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_SESSION_MS = 12 * HOUR_MS; // absolute
const REMEMBER_SESSION_MS = 30 * DAY_MS; // sliding
const REFRESH_EVERY_MS = 5 * 60 * 1000; // at most one sliding write per 5 min
const DEVICE_COOKIE_MAX_AGE_SEC = 400 * 24 * 60 * 60; // browsers cap at 400 days

// Resolved lazily so requiring this file never opens the DB (or runs
// migrations) as a side effect.
let _db = null;
function db() {
  if (!_db) _db = require("../db");
  return _db;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- tokens

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// ---------------------------------------------------------------- cookies

function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue; // first wins
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function cookieString(name, value, maxAgeSec) {
  let c = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAgeSec != null) c += `; Max-Age=${maxAgeSec}`;
  return c;
}

function setSessionCookie(res, token, remember) {
  res.append(
    "Set-Cookie",
    cookieString(SID_COOKIE, token, remember ? Math.floor(REMEMBER_SESSION_MS / 1000) : null)
  );
}

function clearSessionCookie(res) {
  res.append("Set-Cookie", `${SID_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

function setDeviceCookie(res, token) {
  res.append("Set-Cookie", cookieString(DEV_COOKIE, token, DEVICE_COOKIE_MAX_AGE_SEC));
}

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || null;
}

function userAgent(req) {
  const ua = req.headers && req.headers["user-agent"];
  return ua ? String(ua).slice(0, 300) : null;
}

// ---------------------------------------------------------------- users

// Loads an enabled user with roles, overrides and effective perms. Returns
// null for a missing or disabled user.
function loadUser(userId) {
  const row = db().prepare("SELECT * FROM users WHERE id = ? AND disabled = 0").get(userId);
  if (!row) return null;
  const roles = db()
    .prepare("SELECT role FROM user_roles WHERE user_id = ? ORDER BY role")
    .all(row.id)
    .map((r) => r.role);
  const overrides = db()
    .prepare("SELECT feature_key, effect FROM permission_overrides WHERE user_id = ?")
    .all(row.id);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roles,
    perms: computeEffective(roles, overrides),
    mustChangePassword: !!row.must_change_password,
  };
}

// The JSON shape sent to clients ({perms} becomes a sorted array).
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    roles: user.roles,
    perms: [...user.perms].sort(),
    mustChangePassword: !!user.mustChangePassword,
  };
}

// ---------------------------------------------------------------- sessions

function revokeSession(sessionId) {
  db()
    .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(nowIso(), sessionId);
}

// Finds the user's live device for the crosscuts_dev cookie, or creates one
// (and sets the cookie). Counters reset: a fresh password login re-arms PIN.
function ensureDevice(req, res, userId) {
  const cookies = parseCookies(req);
  const tok = cookies[DEV_COOKIE];
  if (tok && TOKEN_RE.test(tok)) {
    const dev = db()
      .prepare("SELECT id FROM devices WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL")
      .get(hashToken(tok), userId);
    if (dev) {
      db()
        .prepare("UPDATE devices SET pin_failures = 0, pin_locked = 0, last_seen_at = ? WHERE id = ?")
        .run(nowIso(), dev.id);
      return dev.id;
    }
  }
  const token = newToken();
  const info = db()
    .prepare("INSERT INTO devices (user_id, token_hash, user_agent, last_seen_at) VALUES (?, ?, ?, ?)")
    .run(userId, hashToken(token), userAgent(req), nowIso());
  setDeviceCookie(res, token);
  return Number(info.lastInsertRowid);
}

// Starts a brand-new session after a successful password check: revokes any
// session the request already carried, registers the device when `remember`,
// writes the cookies and bumps last_login_at.
function startSession(req, res, userId, remember) {
  if (req.session && req.session.id) revokeSession(req.session.id);
  const now = Date.now();
  const deviceId = remember ? ensureDevice(req, res, userId) : null;
  const token = newToken();
  const expires = new Date(now + (remember ? REMEMBER_SESSION_MS : DEFAULT_SESSION_MS)).toISOString();
  db()
    .prepare(
      `INSERT INTO sessions (id, user_id, device_id, remember, locked, last_seen_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`
    )
    .run(hashToken(token), userId, deviceId, remember ? 1 : 0, new Date(now).toISOString(), expires, clientIp(req), userAgent(req));
  db().prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date(now).toISOString(), userId);
  setSessionCookie(res, token, !!remember);
  return { id: hashToken(token), deviceId, remember: !!remember };
}

// ---------------------------------------------------------------- middleware

function authenticate(req, res, next) {
  req.user = null;
  req.session = null;
  try {
    const token = parseCookies(req)[SID_COOKIE];
    if (token && TOKEN_RE.test(token)) {
      const id = hashToken(token);
      const s = db().prepare("SELECT * FROM sessions WHERE id = ? AND revoked_at IS NULL").get(id);
      const now = Date.now();
      if (s && s.expires_at > new Date(now).toISOString()) {
        const user = loadUser(s.user_id);
        if (user) {
          // Sliding refresh for remembered sessions (at most every 5 minutes).
          if (s.remember && now - Date.parse(s.last_seen_at) > REFRESH_EVERY_MS) {
            const iso = new Date(now).toISOString();
            db()
              .prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
              .run(iso, new Date(now + REMEMBER_SESSION_MS).toISOString(), id);
            if (s.device_id) db().prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(iso, s.device_id);
            setSessionCookie(res, token, true);
          }
          req.user = user;
          req.session = { id, remember: !!s.remember, locked: !!s.locked, deviceId: s.device_id == null ? null : s.device_id };
        }
      }
    }
  } catch (e) {
    console.error("[auth] authenticate failed:", e);
    req.user = null;
    req.session = null;
  }
  next();
}

// Non-GET/HEAD requests carrying an Origin that doesn't match Host are refused.
function originCheck(req, res, next) {
  const m = req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  const origin = req.headers.origin;
  if (origin === undefined) return next(); // non-browser client; SameSite covers browsers
  let originHost = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (!originHost || originHost.toLowerCase() !== String(req.headers.host || "").toLowerCase()) {
    return res.status(403).json({ error: "Cross-origin request refused" });
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user || !req.session) return res.status(401).json({ error: "Not logged in" });
  if (req.session.locked) return res.status(401).json({ error: "Locked", locked: true });
  next();
}

function hasAnyPerm(user, access) {
  const keys = Array.isArray(access) ? access : [access];
  return keys.some((k) => user.perms.has(k));
}

// access: 'public' | 'login' | a feature key | an array of keys (any one).
function requirePerm(access) {
  return function permGuard(req, res, next) {
    if (access === "public") return next();
    requireLogin(req, res, (err) => {
      if (err) return next(err);
      if (access === "login") return next();
      if (!hasAnyPerm(req.user, access)) return res.status(403).json({ error: "Forbidden" });
      next();
    });
  };
}

// Canonical form of a request path for the page table: decode once, flip
// backslashes, resolve "." / ".." / duplicate slashes, so "/./schedule.html"
// cannot dodge the entry that static serving would resolve it to. Trailing
// slashes go too (after decoding), so "/schedule.html%2f" is gated as
// "/schedule.html" instead of slipping past as a non-page path.
function canonicalPagePath(p) {
  let s = String(p || "/");
  try {
    s = decodeURIComponent(s);
  } catch {
    // keep as is
  }
  s = path.posix.normalize(s.replace(/\\/g, "/")).replace(/\/+$/, "");
  return s.startsWith("/") ? s : "/" + s;
}

const FORBIDDEN_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>No access</title>" +
  // Inline on purpose: this page cannot load tokens.css. The values are the house tokens
  // (ink ground, body text, white heading, teal-tint link, Arial).
  "<style>body{font-family:Arial,Helvetica,sans-serif;background:#101019;color:#d3d4dc;display:flex;min-height:100vh;" +
  "align-items:center;justify-content:center;margin:0}main{max-width:26rem;padding:1.5rem;text-align:center}" +
  "h1{color:#fff;font-size:22px;font-weight:700}a{color:#6ee7c9}</style></head><body><main><h1>No access</h1>" +
  "<p>Your account doesn't have permission to open this page.</p>" +
  '<p><a href="/">Back to home</a></p></main></body></html>';

function pageGate(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const p = canonicalPagePath(req.path);
  if (!isPagePath(p)) return next();
  const access = pageAccess(p);
  if (access === null || access === "public") return next();

  const locked = !!(req.user && req.session && req.session.locked);
  if (!req.user || locked) {
    const nextUrl = encodeURIComponent(req.originalUrl || req.url || "/").replace(/%2F/gi, "/");
    return res.redirect(302, `/login.html?${locked ? "locked=1&" : ""}next=${nextUrl}`);
  }
  if (access === "login" || hasAnyPerm(req.user, access)) return next();
  res.status(403).set("Content-Type", "text/html; charset=utf-8").send(FORBIDDEN_PAGE);
}

// ---------------------------------------------------------------- PIN state

const DEVICE_PIN_MAX_FAILURES = 5;
const USER_PIN_MAX_FAILURES = 10;
const USER_PIN_WINDOW_MS = 60 * 60 * 1000;

// True when this user's PIN has been disabled across all devices: 10 PIN
// failures in the last hour, counted since their last successful password
// check (login or password unlock).
function userPinDisabled(userId) {
  const since = new Date(Date.now() - USER_PIN_WINDOW_MS).toISOString();
  const lastOk = db()
    .prepare("SELECT MAX(at) AS at FROM auth_attempts WHERE kind = 'password' AND success = 1 AND user_id = ?")
    .get(userId);
  const from = lastOk && lastOk.at && lastOk.at > since ? lastOk.at : since;
  const n = db()
    .prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE kind = 'pin' AND success = 0 AND user_id = ? AND at > ?")
    .get(userId, from).n;
  return n >= USER_PIN_MAX_FAILURES;
}

// Whether a PIN may be used to unlock the request's session. Returns
// {ok, device, pinHash}; ok is false unless every condition in the contract
// holds (locked + remembered session, device cookie matching that session's
// device, device not PIN-locked/revoked, user has a PIN, user not PIN-disabled).
function pinState(req) {
  const no = { ok: false, device: null, pinHash: null };
  if (!req.user || !req.session || !req.session.locked || !req.session.remember) return no;
  if (req.session.deviceId == null) return no;
  const tok = parseCookies(req)[DEV_COOKIE];
  if (!tok || !TOKEN_RE.test(tok)) return no;
  const dev = db().prepare("SELECT * FROM devices WHERE id = ?").get(req.session.deviceId);
  if (!dev || dev.revoked_at || dev.pin_locked || dev.user_id !== req.user.id) return no;
  if (dev.token_hash !== hashToken(tok)) return no;
  const u = db().prepare("SELECT pin_hash FROM users WHERE id = ?").get(req.user.id);
  if (!u || !u.pin_hash) return no;
  if (userPinDisabled(req.user.id)) return no;
  return { ok: true, device: dev, pinHash: u.pin_hash };
}

module.exports = {
  authenticate,
  requirePerm,
  pageGate,
  originCheck,
  requireLogin,
  // helpers for routes/auth.js
  SID_COOKIE,
  DEV_COOKIE,
  db,
  nowIso,
  parseCookies,
  clearSessionCookie,
  clientIp,
  loadUser,
  publicUser,
  startSession,
  revokeSession,
  pinState,
  userPinDisabled,
  DEVICE_PIN_MAX_FAILURES,
  hashToken,
};
