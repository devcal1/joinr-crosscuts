// The alarm code key and its encryption (docs/plans/m13-contracts.md section 5.1): AES-256-GCM with
// a 32-byte key kept in CONFIG_DIR/alarm-code-key (never in the database), each code bound to its
// slot row. SCAFFOLD STUB (M13 · 2.2): the signatures are binding; every function throws
// HttpError(501, "Not built") until Wave 1 C replaces this file.
//
// Nothing here may throw an Error whose message holds a code or the key (sendError's 500 path logs
// the whole error).
const path = require("path");
const { HttpError } = require("./httperror");
const { CONFIG_DIR } = require("./config");

const KEY_FILE = path.join(CONFIG_DIR, "alarm-code-key");

function notBuilt() {
  throw new HttpError(501, "Not built");
}

function keyState(db) { return notBuilt(); }                        // "ready" | "none" | "missing"
function encrypt(db, slotId, code) { return notBuilt(); }           // {ct, iv, tag, keyId}
function decrypt(db, row) { return notBuilt(); }                    // code (HttpError 409, section 5.3)
function readable(db, row) { return notBuilt(); }                   // boolean, without decrypting
function currentKeyId() { return notBuilt(); }                      // 16 hex | null

module.exports = {
  KEY_FILE,
  keyState,
  encrypt,
  decrypt,
  readable,
  currentKeyId,
};
