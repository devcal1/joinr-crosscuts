CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin','accounts','design_pm','scheduling','showroom')),
  PRIMARY KEY (user_id, role)
);
CREATE TABLE permission_overrides (
  user_id INTEGER NOT NULL REFERENCES users(id),
  feature_key TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('grant','revoke')),
  set_by INTEGER REFERENCES users(id),
  set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, feature_key)
);
CREATE TABLE devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  pin_failures INTEGER NOT NULL DEFAULT 0,
  pin_locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- sha256 hex of the cookie token
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id INTEGER REFERENCES devices(id),
  remember INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  revoked_at TEXT
);
CREATE TABLE auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('password','pin')),
  username TEXT,
  user_id INTEGER REFERENCES users(id),
  device_id INTEGER REFERENCES devices(id),
  ip TEXT,
  success INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_devices_user ON devices(user_id);
CREATE INDEX idx_attempts_user ON auth_attempts(username, kind, at);
CREATE INDEX idx_attempts_uid ON auth_attempts(user_id, kind, at);
