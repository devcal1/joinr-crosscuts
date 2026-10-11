// /api/auth: setup, login, logout, lock/unlock, PIN and password.
// Contract: docs/plans/m1-contracts.md ("T1: /api/auth").
const { defineRoutes } = require("../lib/routes");
const { hashSecret, verifySecret } = require("../lib/password");
const audit = require("../lib/audit");
const auth = require("../lib/auth");

const r = defineRoutes("/api/auth");

const { db } = auth;

const PASSWORD_MAX_FAILURES = 10;
const PASSWORD_IP_MAX_FAILURES = 30; // per IP, across all usernames
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;
const SCRYPT_MAX_INFLIGHT = 4; // global cap on concurrent password/PIN verifications
const MIN_PASSWORD = 8;
const MAX_SECRET_LEN = 200; // keeps scrypt input bounded

// Express 4 does not catch rejected promises from async handlers.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const nowIso = () => new Date().toISOString();

function userCount() {
  return db().prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

function str(v) {
  return typeof v === "string" ? v : "";
}

// ---- attempts / rate limiting (auth_attempts table)

// Limits are checked, then the attempt is reserved (inserted as a failure)
// BEFORE any await, so concurrent bursts count against the limits while their
// scrypt runs. A success flips the row with settleAttempt().
function reserveAttempt({ kind, username, userId, deviceId, ip }) {
  try {
    const info = db()
      .prepare(
        "INSERT INTO auth_attempts (kind, username, user_id, device_id, ip, success) VALUES (?, ?, ?, ?, ?, 0)"
      )
      .run(kind, username ? String(username).toLowerCase().slice(0, 100) : null, userId || null, deviceId || null, ip || null);
    return Number(info.lastInsertRowid);
  } catch (e) {
    console.error("[auth] could not record attempt:", e);
    return null;
  }
}

function settleAttempt(id) {
  if (id == null) return;
  try {
    db().prepare("UPDATE auth_attempts SET success = 1 WHERE id = ?").run(id);
  } catch (e) {
    console.error("[auth] could not settle attempt:", e);
  }
}

// Global cap on concurrent scrypt verifications. Callers that get false send
// sendBusy() and record nothing; callers that get true must releaseScrypt().
let scryptInFlight = 0;
function tryAcquireScrypt() {
  if (scryptInFlight >= SCRYPT_MAX_INFLIGHT) return false;
  scryptInFlight++;
  return true;
}
function releaseScrypt() {
  scryptInFlight--;
}

function sendBusy(res) {
  res.set("Retry-After", "2");
  return res.status(429).json({ error: "Busy, try again", retryAfterSec: 2 });
}

// Returns null, or { retryAfterSec } when 10 password failures for this
// username+IP, or 30 for this IP across any usernames, fall inside the last
// 15 minutes. In-flight (reserved) attempts count as failures.
function passwordLockout(username, ip) {
  const since = new Date(Date.now() - PASSWORD_WINDOW_MS).toISOString();
  const uname = String(username).toLowerCase().slice(0, 100);
  const byUser = failureLockout("username = ? AND ip IS ?", [uname, ip || null], since, PASSWORD_MAX_FAILURES);
  const byIp = failureLockout("ip IS ?", [ip || null], since, PASSWORD_IP_MAX_FAILURES);
  if (byUser && byIp) return { retryAfterSec: Math.max(byUser.retryAfterSec, byIp.retryAfterSec) };
  return byUser || byIp;
}

function failureLockout(where, params, since, max) {
  const rows = db()
    .prepare(
      `SELECT at FROM auth_attempts
       WHERE kind = 'password' AND success = 0 AND ${where} AND at > ?
       ORDER BY at DESC LIMIT ?`
    )
    .all(...params, since, max);
  if (rows.length < max) return null;
  // The lockout lifts when the max-th most recent failure leaves the window.
  const liftsAt = Date.parse(rows[max - 1].at) + PASSWORD_WINDOW_MS;
  return { retryAfterSec: Math.max(1, Math.ceil((liftsAt - Date.now()) / 1000)) };
}

function sendLockout(res, lock) {
  res.set("Retry-After", String(lock.retryAfterSec));
  return res.status(429).json({
    error: "Too many failed attempts. Try again later.",
    retryAfterSec: lock.retryAfterSec,
  });
}

// Verifies against a throwaway hash when the user doesn't exist, so response
// time doesn't reveal which usernames are real.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashSecret("crosscuts-dummy-password");
  return dummyHashPromise;
}

// Re-checks the logged-in user's current password (for /pin and /password),
// counting failures like a login. Returns true when the response was sent.
async function rejectIfBadCurrentPassword(req, res, context) {
  const currentPassword = str(req.body && req.body.currentPassword);
  if (!currentPassword) {
    res.status(400).json({ error: "Current password is required" });
    return true;
  }
  const ip = auth.clientIp(req);
  const lock = passwordLockout(req.user.username, ip);
  if (lock) {
    sendLockout(res, lock);
    return true;
  }
  if (!tryAcquireScrypt()) {
    sendBusy(res);
    return true;
  }
  const attemptId = reserveAttempt({ kind: "password", username: req.user.username, userId: req.user.id, deviceId: req.session.deviceId, ip });
  let ok;
  try {
    const row = db().prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
    ok = row && (await verifySecret(currentPassword, row.password_hash));
  } finally {
    releaseScrypt();
  }
  if (ok) settleAttempt(attemptId);
  if (!ok) {
    audit.log(req, {
      action: "auth.login_failed",
      entityType: "user",
      entityId: String(req.user.id),
      after: { context },
    });
    // 403 rather than 401: a 401 makes shared.js send the user to the login page.
    res.status(403).json({ error: "Current password is incorrect" });
    return true;
  }
  return false;
}

// ---- routes

r.get("/status", "public", (req, res) => {
  const user = req.user;
  const locked = !!(user && req.session && req.session.locked);
  res.json({
    setupNeeded: userCount() === 0,
    loggedIn: !!user && !locked,
    locked,
    user: user ? { displayName: user.displayName } : null,
    pinAvailable: auth.pinState(req).ok,
  });
});

r.post("/setup", "public", wrap(async (req, res) => {
  if (userCount() > 0) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  const username = str(b.username).trim();
  const displayName = str(b.displayName).trim();
  const password = str(b.password);
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 2-64 characters: letters, numbers and . _ @ -" });
  }
  if (!displayName || displayName.length > 100) return res.status(400).json({ error: "Display name is required (max 100 characters)" });
  if (password.length < MIN_PASSWORD || password.length > MAX_SECRET_LEN) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  }
  const hash = await hashSecret(password);
  let userId;
  try {
    // Re-check inside the transaction: two simultaneous setups can't both win.
    userId = db().transaction(() => {
      if (userCount() > 0) throw Object.assign(new Error("exists"), { code: "SETUP_DONE" });
      const info = db()
        .prepare("INSERT INTO users (username, display_name, password_hash, password_changed_at) VALUES (?, ?, ?, ?)")
        .run(username, displayName, hash, nowIso());
      const id = Number(info.lastInsertRowid);
      db().prepare("INSERT INTO user_roles (user_id, role) VALUES (?, 'admin')").run(id);
      return id;
    })();
  } catch (e) {
    if (e && e.code === "SETUP_DONE") return res.status(404).json({ error: "Not found" });
    throw e;
  }
  auth.startSession(req, res, userId, true);
  audit.log(req, { action: "auth.setup", entityType: "user", entityId: String(userId), actorId: userId, actorLabel: username });
  res.status(201).json({ user: auth.publicUser(auth.loadUser(userId)) });
}));

r.post("/login", "public", wrap(async (req, res) => {
  const b = req.body || {};
  const username = str(b.username).trim();
  const password = str(b.password);
  const remember = b.remember === true || b.remember === "true" || b.remember === 1;
  if (!username || !password) return res.status(400).json({ error: "Username and password are required" });
  if (password.length > MAX_SECRET_LEN || username.length > 100) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const ip = auth.clientIp(req);
  const lock = passwordLockout(username, ip);
  if (lock) return sendLockout(res, lock);

  if (!tryAcquireScrypt()) return sendBusy(res);
  const row = db().prepare("SELECT * FROM users WHERE username = ?").get(username);
  const attemptId = reserveAttempt({ kind: "password", username, userId: row ? row.id : null, ip });
  let ok;
  try {
    ok = row ? await verifySecret(password, row.password_hash) : (await verifySecret(password, await dummyHash()), false);
  } finally {
    releaseScrypt();
  }
  if (!ok || row.disabled) {
    audit.log(req, {
      action: "auth.login_failed",
      entityType: "user",
      entityId: row ? String(row.id) : null,
      actorLabel: username.slice(0, 100),
      after: { username: username.slice(0, 100), disabled: !!(row && row.disabled) },
    });
    return res.status(401).json({ error: "Invalid username or password" });
  }

  settleAttempt(attemptId);
  // Six months old: the password must be changed before anything else.
  const expired = !row.must_change_password && auth.passwordExpired(row);
  if (expired) {
    db().prepare("UPDATE users SET must_change_password = 1, updated_at = ? WHERE id = ?").run(nowIso(), row.id);
  }
  const sess = auth.startSession(req, res, row.id, remember);
  audit.log(req, {
    action: "auth.login",
    entityType: "user",
    entityId: String(row.id),
    actorId: row.id,
    actorLabel: row.username,
    after: expired ? { remember: sess.remember, passwordExpired: true } : { remember: sess.remember },
  });
  res.json({ user: auth.publicUser(auth.loadUser(row.id)) });
}));

r.post("/logout", "public", (req, res) => {
  if (req.session) {
    auth.revokeSession(req.session.id);
    if (req.user) {
      audit.log(req, { action: "auth.logout", entityType: "user", entityId: String(req.user.id), actorId: req.user.id, actorLabel: req.user.username });
    }
  }
  auth.clearSessionCookie(res);
  res.status(204).end();
});

r.get("/me", "login", (req, res) => {
  res.json({ user: auth.publicUser(req.user), session: { remember: req.session.remember } });
});

r.post("/lock", "login", (req, res) => {
  db().prepare("UPDATE sessions SET locked = 1 WHERE id = ?").run(req.session.id);
  audit.log(req, { action: "auth.lock", entityType: "user", entityId: String(req.user.id) });
  res.status(204).end();
});

r.post("/unlock", "public", wrap(async (req, res) => {
  if (!req.user || !req.session) return res.status(401).json({ error: "Not logged in" });
  if (!req.session.locked) return res.status(400).json({ error: "Session is not locked" });
  const b = req.body || {};
  const ip = auth.clientIp(req);
  const user = req.user;
  const havePin = b.pin !== undefined && b.pin !== null && b.pin !== "";

  const finish = (method) => {
    db().prepare("UPDATE sessions SET locked = 0 WHERE id = ?").run(req.session.id);
    audit.log(req, { action: "auth.unlock", entityType: "user", entityId: String(user.id), after: { method } });
    res.json({ user: auth.publicUser(user) });
  };

  if (havePin) {
    const state = auth.pinState(req);
    if (!state.ok) {
      return res.status(403).json({ error: "PIN unlock is not available here. Use your password.", pinAvailable: false });
    }
    const pin = str(b.pin);
    if (!tryAcquireScrypt()) return sendBusy(res);
    try {
      // Reserve the failure before any await: concurrent guesses each take a
      // slot, so no more than DEVICE_PIN_MAX_FAILURES ever reach scrypt.
      const devId = state.device.id;
      db().prepare("UPDATE devices SET pin_failures = pin_failures + 1 WHERE id = ? AND pin_locked = 0").run(devId);
      const dev = db().prepare("SELECT pin_failures, pin_locked FROM devices WHERE id = ?").get(devId);
      if (dev.pin_locked || dev.pin_failures > auth.DEVICE_PIN_MAX_FAILURES) {
        db().prepare("UPDATE devices SET pin_locked = 1 WHERE id = ?").run(devId);
        return res.status(403).json({ error: "PIN unlock is not available here. Use your password.", pinAvailable: false });
      }
      const attemptId = reserveAttempt({ kind: "pin", username: user.username, userId: user.id, deviceId: devId, ip });
      const ok = /^\d{4,6}$/.test(pin) && (await verifySecret(pin, state.pinHash));
      if (!ok) {
        db().prepare("UPDATE devices SET pin_locked = 1 WHERE id = ? AND pin_failures >= ?").run(devId, auth.DEVICE_PIN_MAX_FAILURES);
        const failures = db().prepare("SELECT pin_failures FROM devices WHERE id = ?").get(devId).pin_failures;
        audit.log(req, { action: "auth.unlock_failed", entityType: "user", entityId: String(user.id), after: { method: "pin" } });
        const stillOk = failures < auth.DEVICE_PIN_MAX_FAILURES && !auth.userPinDisabled(user.id);
        return res.status(401).json({ error: "Incorrect PIN", pinAvailable: stillOk });
      }
      settleAttempt(attemptId);
      db().prepare("UPDATE devices SET pin_failures = 0 WHERE id = ? AND pin_locked = 0").run(devId);
    } finally {
      releaseScrypt();
    }
    return finish("pin");
  }

  const password = str(b.password);
  if (!password) return res.status(400).json({ error: "PIN or password is required" });
  const lock = passwordLockout(user.username, ip);
  if (lock) return sendLockout(res, lock);
  if (!tryAcquireScrypt()) return sendBusy(res);
  const attemptId = reserveAttempt({ kind: "password", username: user.username, userId: user.id, deviceId: req.session.deviceId, ip });
  let ok;
  try {
    const row = db().prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id);
    ok = password.length <= MAX_SECRET_LEN && row && (await verifySecret(password, row.password_hash));
  } finally {
    releaseScrypt();
  }
  if (ok) settleAttempt(attemptId);
  if (!ok) {
    audit.log(req, { action: "auth.unlock_failed", entityType: "user", entityId: String(user.id), after: { method: "password" } });
    return res.status(401).json({ error: "Incorrect password" });
  }
  if (req.session.deviceId != null) {
    db().prepare("UPDATE devices SET pin_failures = 0, pin_locked = 0 WHERE id = ?").run(req.session.deviceId);
  }
  finish("password");
}));

r.post("/pin", "login", wrap(async (req, res) => {
  const pin = req.body ? req.body.pin : undefined;
  if (pin !== null && !(typeof pin === "string" && /^\d{4,6}$/.test(pin))) {
    return res.status(400).json({ error: "PIN must be 4 to 6 digits, or null to clear it" });
  }
  if (await rejectIfBadCurrentPassword(req, res, "pin_set")) return;
  const hash = pin === null ? null : await hashSecret(pin);
  db().prepare("UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?").run(hash, nowIso(), req.user.id);
  // The password was just verified, so PIN is re-armed on this device.
  if (req.session.deviceId != null) {
    db().prepare("UPDATE devices SET pin_failures = 0, pin_locked = 0 WHERE id = ?").run(req.session.deviceId);
  }
  audit.log(req, { action: "auth.pin_set", entityType: "user", entityId: String(req.user.id), after: { pinSet: pin !== null } });
  res.status(204).end();
}));

r.post("/password", "login", wrap(async (req, res) => {
  const newPassword = str(req.body && req.body.newPassword);
  if (newPassword.length < MIN_PASSWORD || newPassword.length > MAX_SECRET_LEN) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters` });
  }
  if (newPassword === str(req.body.currentPassword)) {
    return res.status(400).json({ error: "New password must be different from the current one" });
  }
  if (await rejectIfBadCurrentPassword(req, res, "password_change")) return;
  const hash = await hashSecret(newPassword);
  // Other sessions and remembered devices die with the old password; this
  // session (and the device it runs on) stays.
  db().transaction(() => {
    const now = nowIso();
    db()
      .prepare("UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ?")
      .run(hash, now, now, req.user.id);
    db()
      .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL")
      .run(now, req.user.id, req.session.id);
    db()
      .prepare("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND id IS NOT ? AND revoked_at IS NULL")
      .run(now, req.user.id, req.session.deviceId);
  })();
  audit.log(req, {
    action: "user.password_reset",
    entityType: "user",
    entityId: String(req.user.id),
    after: { self: true },
  });
  res.status(204).end();
}));

module.exports = r.router;
