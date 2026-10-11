// The three backup config files in CONFIG_DIR (docs/plans/backup-contracts.md section 3.1).
//
//   backup-passphrase  the first line with only its line ending dropped (NOT trimmed: Joinr
//                      Backup's rule, so it matches the password manager exactly); 12-1024
//                      characters; no control characters
//   nas-url            the first line, trimmed; passes checkNasUrl (section 3.2)
//   nas-password       the first line, trimmed; 1-256 characters; no control characters
//
// Placed by the backup helper, read fresh on every call (rotating one needs no restart), and
// never written, shown, logged or returned by the app outside lib/backup/. No environment
// variable can supply them. A file is 'missing' when absent; 'not_usable' when it is not a regular
// file (lstat: a symlink is not usable), is larger than SECRET_MAX_BYTES, or breaks its rule
// (an empty file breaks every rule); else 'set'.
const fs = require("fs");
const path = require("path");
const {
  CONFIG_DIR,
  CONFIG_FILES,
  SECRET_MAX_BYTES,
  PASSPHRASE_MIN,
  PASSPHRASE_MAX,
  NAS_PASSWORD_MAX,
} = require("./constants");
const { checkNasUrl } = require("./nasurl");
const { safeSystemCode } = require("./tools");

// A control character (NUL included) makes a value unusable.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);

// The last read error code logged per file, so a lasting problem is logged once, not every call.
const lastLogged = {};
function noteReadError(file, code) {
  if (lastLogged[file] === code) return;
  lastLogged[file] = code;
  console.error(`[backup] a backup config file could not be read (${code})`);
}

function lineOf(text) {
  const at = text.indexOf("\n");
  const line = at === -1 ? text : text.slice(0, at);
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

// One file: {state: 'missing'} | {state: 'not_usable', mtimeMs} | {state: 'read', mtimeMs, line}.
// The line is the raw first line (line ending dropped); each rule trims or not.
function readOne(name) {
  const file = path.join(CONFIG_DIR, name);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    const code = safeSystemCode(e);
    if (ABSENT_CODES.has(code)) {
      lastLogged[name] = undefined;
      return { state: "missing" };
    }
    noteReadError(name, code);
    return { state: "not_usable", mtimeMs: null };
  }
  const mtimeMs = st.mtimeMs;
  if (!st.isFile() || st.size > SECRET_MAX_BYTES) return { state: "not_usable", mtimeMs };
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (e) {
    const code = safeSystemCode(e);
    if (ABSENT_CODES.has(code)) return { state: "missing" };
    noteReadError(name, code);
    return { state: "not_usable", mtimeMs };
  }
  const buffer = Buffer.alloc(SECRET_MAX_BYTES + 1);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > SECRET_MAX_BYTES) return { state: "not_usable", mtimeMs };
    let length = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (n <= 0) break;
      length += n;
      if (length > SECRET_MAX_BYTES) return { state: "not_usable", mtimeMs };
    }
    lastLogged[name] = undefined;
    return { state: "read", mtimeMs, line: lineOf(buffer.subarray(0, length).toString("utf8")) };
  } catch (e) {
    noteReadError(name, safeSystemCode(e));
    return { state: "not_usable", mtimeMs };
  } finally {
    buffer.fill(0);
    try {
      fs.closeSync(fd);
    } catch {
      // the descriptor is gone either way
    }
  }
}

function charCount(text) {
  return [...text].length;
}

// ---- the passphrase -----------------------------------------------------------------------------
function passphraseValue(raw) {
  if (raw.state !== "read") return { state: raw.state, value: null };
  const line = raw.line; // not trimmed
  const n = charCount(line);
  if (n < PASSPHRASE_MIN || n > PASSPHRASE_MAX || CONTROL_RE.test(line)) return { state: "not_usable", value: null };
  return { state: "set", value: line };
}

// {state: 'missing'|'not_usable'|'set', mtimeMs: number|null} (never the value)
function passphraseStatus() {
  const raw = readOne(CONFIG_FILES.passphrase);
  const { state } = passphraseValue(raw);
  return { state, mtimeMs: raw.mtimeMs == null ? null : raw.mtimeMs };
}

// {state, value: string|null}: the value only when 'set'. The caller keeps it in local scope.
function readPassphrase() {
  return passphraseValue(readOne(CONFIG_FILES.passphrase));
}

// ---- the NAS files ------------------------------------------------------------------------------
function urlValue(raw) {
  if (raw.state !== "read") return { state: raw.state, url: null, hasSubfolder: false };
  const check = checkNasUrl(raw.line.trim());
  if (!check.ok) return { state: "not_usable", url: null, hasSubfolder: false };
  return { state: "set", url: check.url, hasSubfolder: check.hasSubfolder };
}

function passwordValue(raw) {
  if (raw.state !== "read") return { state: raw.state, value: null };
  const line = raw.line.trim();
  const n = charCount(line);
  if (n < 1 || n > NAS_PASSWORD_MAX || CONTROL_RE.test(line)) return { state: "not_usable", value: null };
  return { state: "set", value: line };
}

function nasState(url, password) {
  const missing = (url === "missing" ? 1 : 0) + (password === "missing" ? 1 : 0);
  if (missing === 2) return "off";
  if (missing === 1) return "half";
  if (url !== "set" || password !== "set") return "invalid";
  return "ready";
}

function readBoth() {
  const rawUrl = readOne(CONFIG_FILES.nasUrl);
  const rawPassword = readOne(CONFIG_FILES.nasPassword);
  const u = urlValue(rawUrl);
  const p = passwordValue(rawPassword);
  return {
    u,
    p,
    status: {
      state: nasState(u.state, p.state),
      url: u.state,
      password: p.state,
      // The same two states under the names status().copy.files uses (section 9); readNas()
      // replaces `url` and `password` with the values, so callers of both can read these.
      files: { nasUrl: u.state, nasPassword: p.state },
      mtimes: {
        url: rawUrl.mtimeMs == null ? null : rawUrl.mtimeMs,
        password: rawPassword.mtimeMs == null ? null : rawPassword.mtimeMs,
      },
    },
  };
}

// {state: 'off'|'half'|'invalid'|'ready', url: 'missing'|'not_usable'|'set',
//  password: 'missing'|'not_usable'|'set', files: {nasUrl, nasPassword}, mtimes: {url, password}}
function nasStatus() {
  return readBoth().status;
}

// nasStatus() plus {url: canonical|null, hasSubfolder: bool, password: string|null}. The values
// replace the two per-file states (still in `files`), and are given only when the state is 'ready'.
function readNas() {
  const { u, p, status } = readBoth();
  const ready = status.state === "ready";
  return {
    ...status,
    url: ready ? u.url : null,
    hasSubfolder: ready ? u.hasSubfolder : false,
    password: ready ? p.value : null,
  };
}

module.exports = { passphraseStatus, readPassphrase, nasStatus, readNas };
