// The one rule for a login's username (Todd 2026-10-20: logins are the staff's email addresses).
// Used by user creation, user rename (routes/users.js) and first-run setup (routes/auth.js).
//
// A username is trimmed and lowercased, then must be one of:
//   - a plain name: 2-32 characters from a-z 0-9 . _ -          (the original rule; "sam", "j.smith")
//   - an email-like address: local@domain, 64 characters at most in all, with
//       local   letters, digits and . _ + -
//       domain  letters, digits and -, in dot-separated parts, at least one dot (no empty part)
//     exactly one @.
// Matching is case-insensitive everywhere (the users.username column is COLLATE NOCASE), so
// "Todd@TH.com.au" signs in as "todd@th.com.au". Usernames already stored stay valid: the rule is
// applied only when a username is created or changed.

const MAX_LENGTH = 64;
const PLAIN_RE = /^[a-z0-9._-]{2,32}$/;
const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const MESSAGE =
  "Username must be a name (2-32 characters: letters, numbers, dot, dash, underscore) " +
  "or an email address (up to 64 characters)";

// Returns the cleaned username (trimmed, lowercased), or null when it breaks the rule.
function cleanUsername(v) {
  if (typeof v !== "string") return null;
  const u = v.trim().toLowerCase();
  if (u.length < 2 || u.length > MAX_LENGTH) return null;
  return PLAIN_RE.test(u) || EMAIL_RE.test(u) ? u : null;
}

module.exports = { cleanUsername, MESSAGE, MAX_LENGTH };
