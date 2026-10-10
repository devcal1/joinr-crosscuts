// App settings: key/value rows in app_settings (business details, invoice
// numbering, round-up bookkeeping). See docs/plans/m2-contracts.md section 2.
// Synchronous; safe inside a caller's db.transaction.
const audit = require("./audit");

const DEFAULTS = {
  "business.trading_name": null,
  "business.legal_name": null,
  "business.abn": null,
  "business.address": null,
  "business.phone": null,
  "business.email": null,
  "bank.account_name": null,
  "bank.bsb": null,
  "bank.account_number": null,
  "invoice.terms_text": null,
  "invoice.prefix": "CC-",
  "invoice.next_number": "1",
  "invoice.pad": "4",
  "invoice.default_days": "10",
  "roundup.last_run": null,
};
const KEYS = Object.keys(DEFAULTS);

function get(db, key) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  if (row && row.value != null) return row.value;
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? DEFAULTS[key] : null;
}

function getAll(db) {
  const out = { ...DEFAULTS };
  for (const { key, value } of db.prepare("SELECT key, value FROM app_settings").all()) {
    if (value != null) out[key] = value;
  }
  return out;
}

function set(db, key, value, req) {
  const before = get(db, key);
  const v = value == null ? null : String(value);
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).run(key, v, new Date().toISOString(), (req && req.user && req.user.id) || null);
  if (!key.startsWith("roundup.") && before !== v) {
    audit.log(req, {
      action: "settings.update",
      entityType: "settings",
      entityId: key,
      before: { value: before },
      after: { value: v },
    });
  }
}

function business(db) {
  const s = getAll(db);
  return {
    tradingName: s["business.trading_name"],
    legalName: s["business.legal_name"],
    abn: s["business.abn"],
    address: s["business.address"],
    phone: s["business.phone"],
    email: s["business.email"],
    bankAccountName: s["bank.account_name"],
    bsb: s["bank.bsb"],
    accountNumber: s["bank.account_number"],
    termsText: s["invoice.terms_text"],
  };
}

function businessReady(db) {
  const b = business(db);
  return !!((b.tradingName || b.legalName) && b.abn && b.address);
}

module.exports = { KEYS, DEFAULTS, get, getAll, set, business, businessReady };
