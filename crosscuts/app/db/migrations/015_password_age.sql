-- Password expiry (Todd, 2026-10-11: passwords last 6 months). Additive: one nullable
-- users column. Every existing password is stamped as changed now, so the six months
-- start at this release and nobody is forced to change straight away.
ALTER TABLE users ADD COLUMN password_changed_at TEXT;
UPDATE users SET password_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');
