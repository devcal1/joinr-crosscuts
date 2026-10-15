// The alarm code key and its encryption (docs/plans/m13-contracts.md section 5.1): AES-256-GCM with
// a 32-byte key kept in CONFIG_DIR/alarm-code-key (never in the database), each code bound to its
// slot row. Wave 1 C.
//
// The key file holds 64 lowercase hex characters and a newline. It is read fresh on every call, so
// a key restored from a backup works without a restart. Its three states:
//   ready   - the file holds a valid key;
//   none    - no key file and no stored code: the key is made on the first code saved;
//   missing - some slot has a code but there is no valid key file, or the file exists and doesn't
//             hold a valid key. A file that exists is never overwritten, and a new key is never made
//             while codes saved under the old one exist, so a lost file can't silently orphan them.
//
// Nothing here may throw an Error whose message holds a code or the key (sendError's 500 path logs
// the whole error), and nothing here logs either. Every failure is an HttpError with a fixed
// sentence; any underlying error is caught and dropped, except its code (EACCES ...) in the one
// "could not create" log line.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { HttpError } = require("./httperror");
const { CONFIG_DIR } = require("./config");

const KEY_FILE = path.join(CONFIG_DIR, "alarm-code-key");
// A dotfile, so the backup's config/ rule never archives a half-made key (backup-contracts 5.2).
const TMP_FILE = path.join(CONFIG_DIR, ".alarm-code-key.new");
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/; // written lowercase; a hand-restored uppercase copy still reads
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Section 5.3's sentences.
const MSG_MISSING_SHOW =
  "The alarm code key is missing, so codes can't be shown. Restore config/alarm-code-key from a backup.";
const MSG_MISSING_SAVE =
  "The alarm code key is missing. Restore config/alarm-code-key from a backup, or clear every saved code, before saving a new one.";
const MSG_UNREADABLE =
  "This code can't be read with the current alarm code key. Restore the key it was saved with, or type the code again.";
const MSG_CREATE = "The alarm code key couldn't be created in the config folder";

// --------------------------------------------------------------- the key ---

// "absent" (no file), "invalid" (a file without a valid key) or {hex}. Never throws.
function readKeyFile() {
  let text;
  try {
    text = fs.readFileSync(KEY_FILE, "utf8");
  } catch (e) {
    return e && e.code === "ENOENT" ? "absent" : "invalid";
  }
  const hex = text.trim().toLowerCase();
  return KEY_HEX_RE.test(hex) ? { hex } : "invalid";
}

function keyIdOf(hex) {
  return crypto.createHash("sha256").update("crosscuts-alarm-code-key:" + hex).digest("hex").slice(0, 16);
}

function hasStoredCodes(db) {
  return !!db.prepare("SELECT 1 AS x FROM alarm_slots WHERE code_ct IS NOT NULL LIMIT 1").get();
}

// "ready" | "none" | "missing".
function keyState(db) {
  const k = readKeyFile();
  if (typeof k === "object") return "ready";
  if (k === "invalid") return "missing"; // a file is there: never overwritten
  return hasStoredCodes(db) ? "missing" : "none";
}

// 16 hex, or null without a valid key file.
function currentKeyId() {
  const k = readKeyFile();
  return typeof k === "object" ? keyIdOf(k.hex) : null;
}

function errCode(e) {
  return e && typeof e.code === "string" && /^[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : "unknown";
}

// Makes the key (only in state "none"): the temporary dotfile, mode 600, linked into place so the
// key file is never seen half-written; if another request linked one first, that one is used.
// Returns the key hex. Throws HttpError 409 when the folder won't take it.
function createKey() {
  const hex = crypto.randomBytes(32).toString("hex");
  try {
    // A temporary left by a crash never holds a key in use (it was never linked), so it can go.
    fs.rmSync(TMP_FILE, { force: true });
    fs.writeFileSync(TMP_FILE, hex + "\n", { mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(TMP_FILE, 0o600);
    } catch (_) {
      // Windows dev boxes ignore modes.
    }
    try {
      fs.linkSync(TMP_FILE, KEY_FILE);
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
      // Someone made one first: use theirs (if it is a valid key; else it is "missing").
      const k = readKeyFile();
      if (typeof k === "object") return k.hex;
      throw new HttpError(409, MSG_MISSING_SAVE);
    }
    return hex;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error(`[alarms] could not create the alarm code key (${errCode(e)})`);
    throw new HttpError(409, MSG_CREATE);
  } finally {
    try {
      fs.rmSync(TMP_FILE, { force: true });
    } catch (_) {
      // Left for the next creation to clear.
    }
  }
}

// The key for saving a code: the current one, or a new one in state "none". Throws HttpError 409
// in state "missing".
function keyForSaving(db) {
  const k = readKeyFile();
  if (typeof k === "object") return k.hex;
  if (k === "invalid" || hasStoredCodes(db)) throw new HttpError(409, MSG_MISSING_SAVE);
  return createKey();
}

// --------------------------------------------------------- the codes ---

function aad(slotId) {
  return Buffer.from(`alarm_slot:${slotId}`, "utf8");
}

// {ct, iv, tag, keyId}, all text for the row's columns. The caller validates the code (section 5.2);
// this only refuses a non-string, with a sentence that never repeats it.
function encrypt(db, slotId, code) {
  if (typeof code !== "string" || !code.length) throw new HttpError(400, "The code must be 1 to 12 digits");
  if (!Number.isSafeInteger(slotId) || slotId < 1) throw new HttpError(400, "No such slot");
  const hex = keyForSaving(db);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, Buffer.from(hex, "hex"), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(slotId));
  const ct = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ct: ct.toString("base64"), iv: iv.toString("base64"), tag: tag.toString("base64"), keyId: keyIdOf(hex) };
}

// True when the row has a code saved under the current key (no decryption tried).
function readable(db, row) {
  if (!row || row.code_ct == null) return false;
  const id = currentKeyId();
  return id !== null && row.code_key_id === id;
}

// The row's code (a string). Check order as section 5.3: no code, the key missing, then the key id
// and the GCM tag. Every refusal is an HttpError 409 with a fixed sentence.
function decrypt(db, row) {
  if (!row || row.code_ct == null) {
    throw new HttpError(409, `Slot ${row && row.slot != null ? row.slot : "?"} has no code saved`);
  }
  const k = readKeyFile();
  if (typeof k !== "object") throw new HttpError(409, MSG_MISSING_SHOW);
  if (row.code_key_id !== keyIdOf(k.hex)) throw new HttpError(409, MSG_UNREADABLE);
  let code;
  try {
    const iv = Buffer.from(String(row.code_iv), "base64");
    const tag = Buffer.from(String(row.code_tag), "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("bad sizes");
    const decipher = crypto.createDecipheriv(ALGO, Buffer.from(k.hex, "hex"), iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(row.id));
    decipher.setAuthTag(tag);
    code = Buffer.concat([decipher.update(Buffer.from(String(row.code_ct), "base64")), decipher.final()]).toString("utf8");
  } catch (_) {
    // GCM authentication failed (another key, a tampered tag, a ciphertext from another row) or the
    // stored text is damaged. The caught error is dropped on purpose.
    throw new HttpError(409, MSG_UNREADABLE);
  }
  return code;
}

module.exports = {
  KEY_FILE,
  keyState,
  encrypt,
  decrypt,
  readable,
  currentKeyId,
};
