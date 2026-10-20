// User admin API (T2). Mounted at /api/users; every route needs users.admin.
// Contract: docs/plans/m1-contracts.md, "T2: /api/users"; the owner's guards and the ownership
// transfer: docs/plans/m13-contracts.md section 3.4.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const permissions = require("../lib/permissions");
const { hashSecret, verifySecret } = require("../lib/password");
const audit = require("../lib/audit");
const auth = require("../lib/auth");
const { cleanUsername, MESSAGE: USERNAME_MESSAGE } = require("../lib/username");

const r = defineRoutes("/api/users");

const ACCESS = "users.admin";
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_NAME = 80;

const ROLE_SET = new Set(permissions.ROLES);
const KEY_SET = new Set(permissions.KEYS);
const OWNER_ONLY_SET = new Set(permissions.OWNER_ONLY_KEYS);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wrap an async handler so thrown HttpErrors become {error} responses.
function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        res.status(e.status).json({ error: e.message });
      } else {
        console.error("users route error:", e);
        res.status(500).json({ error: "Server error" });
      }
    }
  };
}

// The acting user's id, or null when auth is the dev stub (req.user === null).
function actorId(req) {
  return req.user && Number.isInteger(req.user.id) ? req.user.id : null;
}

function parseId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "Not found");
  return id;
}

function nowIso() {
  return new Date().toISOString();
}

// --- Shaping ---

function shapeUser(row, roles, overrideRows, activeSessions) {
  const sortedRoles = permissions.ROLES.filter((x) => roles.includes(x));
  const overrides = overrideRows
    .map((o) => ({ key: o.feature_key, effect: o.effect }))
    .sort((a, b) => a.key.localeCompare(b.key));
  // M13 (section 3.2): the owner holds every key, whatever the roles and overrides.
  const isOwner = Number(row.is_owner) === 1;
  const perms = [...permissions.computeEffective(sortedRoles, overrideRows, isOwner)].sort();
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roles: sortedRoles,
    isOwner,
    overrides,
    disabled: !!row.disabled,
    mustChangePassword: !!row.must_change_password,
    workerId: row.worker_id == null ? null : row.worker_id,
    lastLoginAt: row.last_login_at || null,
    activeSessions,
    perms,
  };
}

function loadUser(id) {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!row) return null;
  const roles = db.prepare("SELECT role FROM user_roles WHERE user_id = ?").all(id).map((x) => x.role);
  const overrideRows = db
    .prepare("SELECT feature_key, effect FROM permission_overrides WHERE user_id = ?")
    .all(id);
  const activeSessions = db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?")
    .get(id, nowIso()).n;
  return shapeUser(row, roles, overrideRows, activeSessions);
}

function requireUser(id) {
  const u = loadUser(id);
  if (!u) throw new HttpError(404, "Not found");
  return u;
}

function listUsers() {
  const users = db.prepare("SELECT * FROM users ORDER BY disabled ASC, display_name COLLATE NOCASE ASC, id ASC").all();
  const rolesBy = new Map();
  for (const x of db.prepare("SELECT user_id, role FROM user_roles").all()) {
    if (!rolesBy.has(x.user_id)) rolesBy.set(x.user_id, []);
    rolesBy.get(x.user_id).push(x.role);
  }
  const ovBy = new Map();
  for (const x of db.prepare("SELECT user_id, feature_key, effect FROM permission_overrides").all()) {
    if (!ovBy.has(x.user_id)) ovBy.set(x.user_id, []);
    ovBy.get(x.user_id).push(x);
  }
  const sessBy = new Map();
  for (const x of db
    .prepare(
      "SELECT user_id, COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ? GROUP BY user_id"
    )
    .all(nowIso())) {
    sessBy.set(x.user_id, x.n);
  }
  return users.map((u) => shapeUser(u, rolesBy.get(u.id) || [], ovBy.get(u.id) || [], sessBy.get(u.id) || 0));
}

// What goes in audit before/after: no hashes, no perms (derivable).
function snapshot(u) {
  return {
    username: u.username,
    displayName: u.displayName,
    roles: u.roles,
    overrides: u.overrides,
    disabled: u.disabled,
    mustChangePassword: u.mustChangePassword,
    workerId: u.workerId,
  };
}

// --- Validation ---

function cleanDisplayName(v) {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, "Display name is required");
  const name = v.trim();
  if (name.length > MAX_NAME) throw new HttpError(400, `Display name must be at most ${MAX_NAME} characters`);
  return name;
}

function cleanPassword(v) {
  if (typeof v !== "string" || v.length < MIN_PASSWORD) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (v.length > MAX_PASSWORD) throw new HttpError(400, `Password must be at most ${MAX_PASSWORD} characters`);
  return v;
}

function cleanRoles(v) {
  if (!Array.isArray(v)) throw new HttpError(400, "roles must be an array");
  const out = [];
  for (const role of v) {
    if (typeof role !== "string" || !ROLE_SET.has(role)) {
      throw new HttpError(400, `Unknown role: ${String(role)}`);
    }
    if (!out.includes(role)) out.push(role);
  }
  return out;
}

function cleanKey(v) {
  if (typeof v !== "string" || !KEY_SET.has(v)) throw new HttpError(400, `Unknown permission key: ${String(v)}`);
  return v;
}

function enabledAdminCount() {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id " +
        "WHERE ur.role = 'admin' AND u.disabled = 0"
    )
    .get().n;
}

// Revokes the user's sessions and remembered devices (a revoked device can't
// PIN-unlock; the next remembered login creates a fresh one). Returns the
// number of sessions revoked.
function revokeSessions(userId) {
  const now = nowIso();
  db.prepare("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, userId);
  return db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(now, userId).changes;
}

function isUniqueError(e) {
  return !!e && /UNIQUE|constraint/i.test(String(e.message || e.code || ""));
}

// --- The owner (M13, docs/plans/m13-contracts.md section 3.4) ---
// Check order on every guarded route: 404 (no such user), then these 403s, then the existing
// validation (400) and rules (409).

// True when the actor is the owner (req.user is loaded fresh on every request).
function actorIsOwner(req) {
  return !!(req.user && req.user.isOwner);
}

// The owner's id, or null (only a database that had no admin when 026 ran: section 3.3).
function ownerId() {
  const row = db.prepare("SELECT id FROM users WHERE is_owner = 1 LIMIT 1").get();
  return row ? row.id : null;
}

// Nobody but the owner acts on the owner's login.
function guardOwnerTarget(req, target, message) {
  if (target.isOwner && !actorIsOwner(req)) throw new HttpError(403, message);
}

// Only the owner grants or revokes an owner-only key (for anyone, the actor included).
function guardOwnerOnlyKey(req, key) {
  if (OWNER_ONLY_SET.has(key) && !actorIsOwner(req)) {
    throw new HttpError(403, `Only the owner can grant or revoke ${key}`);
  }
}

// Only the owner resets the password of a login holding an owner-only key by a grant override
// (Problem 1): names the first such key in KEYS order.
function guardOwnerOnlyHolder(req, target) {
  if (actorIsOwner(req)) return;
  const granted = new Set(target.overrides.filter((o) => o.effect === "grant").map((o) => o.key));
  const key = permissions.KEYS.find((k) => OWNER_ONLY_SET.has(k) && granted.has(k));
  if (key) throw new HttpError(403, `Only the owner can reset the password of someone holding ${key}`);
}

// --- Routes ---

r.get("/meta", ACCESS, (req, res) => {
  res.json({
    roles: permissions.ROLES,
    keys: permissions.KEYS,
    presets: permissions.PRESETS,
    ownerOnlyKeys: permissions.OWNER_ONLY_KEYS,
    ownerId: ownerId(),
    // The board workers a login can be linked to (033): name and hue for the picker.
    workers: db
      .prepare("SELECT id, name, hue, archived FROM workers ORDER BY archived ASC, sort_order ASC, id ASC")
      .all()
      .map((w) => ({ id: w.id, name: w.name, hue: w.hue, archived: !!w.archived })),
  });
});

r.get("/", ACCESS, (req, res) => {
  res.json(listUsers());
});

r.post(
  "/",
  ACCESS,
  handler(async (req, res) => {
    const body = req.body || {};
    const username = cleanUsername(body.username);
    if (!username) throw new HttpError(400, USERNAME_MESSAGE);
    const displayName = cleanDisplayName(body.displayName);
    const password = cleanPassword(body.password);
    const roles = body.roles === undefined ? [] : cleanRoles(body.roles);

    if (db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
      throw new HttpError(409, "That username is already taken");
    }
    const hash = await hashSecret(password);

    let id;
    try {
      db.transaction(() => {
        const info = db
          .prepare(
            "INSERT INTO users (username, display_name, password_hash, must_change_password) VALUES (?, ?, ?, 1)"
          )
          .run(username, displayName, hash);
        id = Number(info.lastInsertRowid);
        const ins = db.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, ?)");
        for (const role of roles) ins.run(id, role);
      })();
    } catch (e) {
      if (isUniqueError(e)) throw new HttpError(409, "That username is already taken");
      throw e;
    }

    const user = requireUser(id);
    audit.log(req, { action: "user.create", entityType: "user", entityId: String(id), before: null, after: snapshot(user) });
    res.status(201).json(user);
  })
);

r.patch(
  "/:id",
  ACCESS,
  handler(async (req, res) => {
    const id = parseId(req);
    const before = requireUser(id);
    guardOwnerTarget(req, before, "Only the owner can change the owner's login");
    const body = req.body || {};

    let displayName;
    if (body.displayName !== undefined) displayName = cleanDisplayName(body.displayName);
    let disabled;
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") throw new HttpError(400, "disabled must be true or false");
      disabled = body.disabled;
    }
    let roles;
    if (body.roles !== undefined) roles = cleanRoles(body.roles);

    const self = actorId(req) === id;
    const disabling = disabled === true && !before.disabled;
    const enabling = disabled === false && before.disabled;
    const rolesChanged = roles !== undefined && roles.slice().sort().join() !== before.roles.slice().sort().join();

    if (self && disabling) throw new HttpError(409, "You can't disable your own account");
    if (self && rolesChanged && before.roles.includes("admin") && !roles.includes("admin")) {
      throw new HttpError(409, "You can't remove your own admin role");
    }
    // Last-admin protection: the change must not leave zero enabled admins.
    const wasEnabledAdmin = !before.disabled && before.roles.includes("admin");
    if (wasEnabledAdmin) {
      const willBeDisabled = disabled === undefined ? before.disabled : disabled;
      const willBeAdmin = roles === undefined ? true : roles.includes("admin");
      if ((willBeDisabled || !willBeAdmin) && enabledAdminCount() <= 1) {
        throw new HttpError(409, "There must be at least one enabled admin");
      }
    }

    let revoked = 0;
    db.transaction(() => {
      if (displayName !== undefined || disabled !== undefined) {
        db.prepare(
          "UPDATE users SET display_name = ?, disabled = ?, updated_at = ? WHERE id = ?"
        ).run(
          displayName !== undefined ? displayName : before.displayName,
          disabled !== undefined ? (disabled ? 1 : 0) : before.disabled ? 1 : 0,
          nowIso(),
          id
        );
      }
      if (rolesChanged) {
        db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(id);
        const ins = db.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, ?)");
        for (const role of roles) ins.run(id, role);
        db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(nowIso(), id);
      }
      if (disabling) revoked = revokeSessions(id);
    })();

    const after = requireUser(id);
    const entity = { entityType: "user", entityId: String(id) };
    if (displayName !== undefined && displayName !== before.displayName) {
      audit.log(req, {
        ...entity,
        action: "user.update",
        before: { displayName: before.displayName },
        after: { displayName: after.displayName },
      });
    }
    if (rolesChanged) {
      audit.log(req, { ...entity, action: "user.roles", before: { roles: before.roles }, after: { roles: after.roles } });
    }
    if (disabling) {
      audit.log(req, {
        ...entity,
        action: "user.disable",
        before: { disabled: false },
        after: { disabled: true, sessionsRevoked: revoked },
      });
    } else if (enabling) {
      audit.log(req, { ...entity, action: "user.enable", before: { disabled: true }, after: { disabled: false } });
    }
    res.json(after);
  })
);

// 2026-10-20 (Todd): change a login's username (logins are staff email addresses). Body {username}.
// Only the username changes: sessions, password, roles, overrides and the worker link all key on the
// user id, so they carry over. The owner's username is changed only by the owner. Check order:
// 404, 403 (owner), 400 (rule), 409 (taken, case-insensitively).
r.patch(
  "/:id/username",
  ACCESS,
  handler(async (req, res) => {
    const id = parseId(req);
    const before = requireUser(id);
    guardOwnerTarget(req, before, "Only the owner can change the owner's username");
    const username = cleanUsername((req.body || {}).username);
    if (!username) throw new HttpError(400, USERNAME_MESSAGE);
    if (username !== before.username) {
      if (db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?").get(username, id)) {
        throw new HttpError(409, "That username is already taken");
      }
      try {
        db.prepare("UPDATE users SET username = ?, updated_at = ? WHERE id = ?").run(username, nowIso(), id);
      } catch (e) {
        if (isUniqueError(e)) throw new HttpError(409, "That username is already taken");
        throw e;
      }
      audit.log(req, {
        action: "user.username",
        entityType: "user",
        entityId: String(id),
        before: { username: before.username },
        after: { username },
      });
    }
    res.json(requireUser(id));
  })
);

r.post(
  "/:id/password",
  ACCESS,
  handler(async (req, res) => {
    const id = parseId(req);
    const before = requireUser(id);
    guardOwnerTarget(req, before, "Only the owner can reset the owner's password");
    guardOwnerOnlyHolder(req, before);
    const password = cleanPassword((req.body || {}).password);
    const hash = await hashSecret(password);
    let revoked = 0;
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = NULL, updated_at = ? WHERE id = ?").run(
        hash,
        nowIso(),
        id
      );
      revoked = revokeSessions(id);
    })();
    audit.log(req, {
      action: "user.password_reset",
      entityType: "user",
      entityId: String(id),
      before: { mustChangePassword: before.mustChangePassword },
      after: { mustChangePassword: true, sessionsRevoked: revoked },
    });
    res.status(204).end();
  })
);

r.put(
  "/:id/overrides/:key",
  ACCESS,
  handler(async (req, res) => {
    const id = parseId(req);
    const before = requireUser(id);
    guardOwnerTarget(req, before, "Only the owner can change the owner's login");
    guardOwnerOnlyKey(req, req.params.key);
    const key = cleanKey(req.params.key);
    const effect = (req.body || {}).effect;
    if (effect !== "grant" && effect !== "revoke") throw new HttpError(400, "effect must be 'grant' or 'revoke'");
    // M13: the owner holds every key, so an override on the owner would do nothing.
    if (before.isOwner) throw new HttpError(409, "The owner holds every key, so overrides don't apply");
    // Revoking users.admin from yourself would lock you out of this screen.
    if (actorId(req) === id && key === "users.admin" && effect === "revoke") {
      throw new HttpError(409, "You can't revoke your own users.admin access");
    }
    db.prepare(
      "INSERT INTO permission_overrides (user_id, feature_key, effect, set_by, set_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, feature_key) DO UPDATE SET effect = excluded.effect, set_by = excluded.set_by, set_at = excluded.set_at"
    ).run(id, key, effect, actorId(req), nowIso());
    const after = requireUser(id);
    const prev = before.overrides.find((o) => o.key === key);
    if (!prev || prev.effect !== effect) {
      audit.log(req, {
        action: "user.override",
        entityType: "user",
        entityId: String(id),
        before: { key, effect: prev ? prev.effect : null },
        after: { key, effect },
      });
    }
    res.json(after);
  })
);

r.delete(
  "/:id/overrides/:key",
  ACCESS,
  handler(async (req, res) => {
    const id = parseId(req);
    const before = requireUser(id);
    guardOwnerTarget(req, before, "Only the owner can change the owner's login");
    guardOwnerOnlyKey(req, req.params.key);
    // M13: the owner may clear a leftover override on their own login (from before M13 or a transfer).
    const key = cleanKey(req.params.key);
    const prev = before.overrides.find((o) => o.key === key);
    if (prev) {
      db.prepare("DELETE FROM permission_overrides WHERE user_id = ? AND feature_key = ?").run(id, key);
      audit.log(req, {
        action: "user.override",
        entityType: "user",
        entityId: String(id),
        before: { key, effect: prev.effect },
        after: { key, effect: null },
      });
    }
    res.json(requireUser(id));
  })
);

// 033: links a login to a board worker (or none). Body {workerId: <worker id> | null}. A worker has
// at most one login (409 naming the other login). The worker's colour then shows on this login's
// names on Pipeline job tiles.
r.put(
  "/:id/worker",
  ACCESS,
  handler(async (req, res) => {
    const id = parseId(req);
    const before = requireUser(id);
    guardOwnerTarget(req, before, "Only the owner can change the owner's login");
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || body.workerId === undefined) {
      throw new HttpError(400, "workerId is required (a worker id, or null for none)");
    }
    const workerId = body.workerId;
    if (workerId !== null) {
      if (!Number.isInteger(workerId) || workerId <= 0) throw new HttpError(400, "workerId must be a worker id or null");
      const w = db.prepare("SELECT id, archived FROM workers WHERE id = ?").get(workerId);
      if (!w) throw new HttpError(400, "No such worker");
      if (w.archived && before.workerId !== workerId) throw new HttpError(400, "That worker is archived");
      const other = db.prepare("SELECT id, display_name FROM users WHERE worker_id = ? AND id != ?").get(workerId, id);
      if (other) throw new HttpError(409, `That worker is already linked to ${other.display_name}`);
    }
    if (workerId !== before.workerId) {
      try {
        db.prepare("UPDATE users SET worker_id = ?, updated_at = ? WHERE id = ?").run(workerId, nowIso(), id);
      } catch (e) {
        if (isUniqueError(e)) throw new HttpError(409, "That worker is already linked to another login");
        throw e;
      }
      audit.log(req, {
        action: "user.worker",
        entityType: "user",
        entityId: String(id),
        before: { workerId: before.workerId },
        after: { workerId },
      });
    }
    res.json(requireUser(id));
  })
);

r.post(
  "/:id/sessions/revoke",
  ACCESS,
  handler(async (req, res) => {
    const id = parseId(req);
    const before = requireUser(id);
    guardOwnerTarget(req, before, "Only the owner can sign the owner out");
    const revoked = revokeSessions(id);
    audit.log(req, {
      action: "user.sessions_revoked",
      entityType: "user",
      entityId: String(id),
      before: { activeSessions: before.activeSessions },
      after: { sessionsRevoked: revoked },
    });
    res.status(204).end();
  })
);

const NOT_ENABLED_ADMIN = "The new owner must be an enabled admin";

// M13 · 4.3 (review A-m3): the transfer's password check counts like /api/auth/password's
// (routes/auth.js rejectIfBadCurrentPassword): the same lockout (10 failures per username and IP,
// 30 per IP, in 15 minutes: 429 "Too many failed attempts. Try again later."), the same attempt
// record in auth_attempts, the scrypt concurrency cap (429 "Busy, try again"), and a failure audit
// row (auth.login_failed, context owner_transfer). A wrong password stays 403 "That password isn't
// right" (section 3.4). Returns true when the answer was sent.
async function rejectIfBadOwnerPassword(req, res, password) {
  const user = req.user;
  const ip = auth.clientIp(req);
  const lock = auth.passwordLockout(user.username, ip);
  if (lock) {
    auth.sendLockout(res, lock);
    return true;
  }
  const deviceId = req.session ? req.session.deviceId : null;
  const tooLong = password.length > MAX_PASSWORD; // wrong without a hash check (section 12.1)
  if (!tooLong && !auth.tryAcquireScrypt()) {
    auth.sendBusy(res);
    return true;
  }
  const attemptId = auth.reserveAttempt({ kind: "password", username: user.username, userId: user.id, deviceId, ip });
  let ok = false;
  if (!tooLong) {
    try {
      const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id);
      ok = !!row && !!(await verifySecret(password, row.password_hash));
    } finally {
      auth.releaseScrypt();
    }
  }
  if (ok) {
    auth.settleAttempt(attemptId);
    return false;
  }
  audit.log(req, {
    action: "auth.login_failed",
    entityType: "user",
    entityId: String(user.id),
    after: { context: "owner_transfer" },
  });
  res.status(403).json({ error: "That password isn't right" });
  return true;
}

// M13 (section 3.4): the owner hands ownership to another enabled admin. Body
// {confirmUsername, password}: the new owner's username typed, and the owner's own password.
r.post(
  "/:id/owner",
  ACCESS,
  handler(async (req, res) => {
    const id = parseId(req);
    const target = requireUser(id);
    if (!actorIsOwner(req)) throw new HttpError(403, "Only the owner can hand over ownership");
    const body = req.body;
    if (
      !body || typeof body !== "object" || Array.isArray(body) ||
      typeof body.confirmUsername !== "string" || typeof body.password !== "string"
    ) {
      throw new HttpError(400, "confirmUsername and password are required");
    }
    const fromId = actorId(req);
    if (id === fromId) throw new HttpError(409, "You're already the owner");
    if (target.disabled || !target.roles.includes("admin")) {
      throw new HttpError(409, NOT_ENABLED_ADMIN);
    }
    if (body.confirmUsername.trim().toLowerCase() !== String(target.username).toLowerCase()) {
      throw new HttpError(400, `Type ${target.username} to confirm`);
    }
    if (await rejectIfBadOwnerPassword(req, res, body.password)) return;

    db.transaction(() => {
      // Re-checked inside the transaction: the actor must still be the owner. The old owner is
      // cleared first, because the partial unique index allows only one is_owner = 1.
      const cleared = db
        .prepare("UPDATE users SET is_owner = 0, updated_at = ? WHERE id = ? AND is_owner = 1")
        .run(nowIso(), fromId).changes;
      if (cleared !== 1) throw new HttpError(403, "Only the owner can hand over ownership");
      // M13 · 4.3 (review A-M1): the target is re-checked by the UPDATE itself, because it may have
      // been disabled, or lost the admin role, while the password was being checked. The throw
      // rolls the whole transaction back, the old owner's clear with it.
      const made = db
        .prepare(
          "UPDATE users SET is_owner = 1, updated_at = ? WHERE id = ? AND disabled = 0 AND " +
            "EXISTS (SELECT 1 FROM user_roles WHERE user_id = users.id AND role = 'admin')"
        )
        .run(nowIso(), id).changes;
      if (made !== 1) throw new HttpError(409, NOT_ENABLED_ADMIN);
      audit.log(req, {
        action: "user.owner",
        entityType: "user",
        entityId: String(id),
        before: { ownerId: fromId },
        after: { ownerId: id },
      });
    })();
    res.json({ from: requireUser(fromId), to: requireUser(id) });
  })
);

module.exports = r.router;
