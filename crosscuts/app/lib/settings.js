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
  "tasks.reminder_last_run": null,
  // Backups (docs/plans/backup-contracts.md section 2): written with {audit: false}, never
  // exposed by /api/settings.
  "backup.seeded_at": null,
  "backup.snapshot_seed_slot": null,
  "backup.copy_seed_slot": null,
  "backup.overdue_alerted_snapshot": null,
  "backup.overdue_alerted_copy": null,
  // The planner reminder sweep's mark (docs/plans/m7-contracts.md section 10), written with
  // {audit: false}.
  "planner.reminder_swept_to": null,
  // Pay runs (docs/plans/m8-contracts.md section 4): read by lib/payroll.js, changed through
  // PUT /api/payruns/settings only (never /api/settings).
  "pay.anchor": "2026-10-05",
  "pay.ordinary_mon_thu_min": "480",
  "pay.ordinary_fri_min": "360",
  "pay.ot_band_min": "120",
  // M11 (docs/plans/m11-contracts.md section 3.3): changed through PUT /api/drawers/settings and
  // PUT /api/paint/settings only (never /api/settings).
  "drawers.supplier.edge": "Finista EDGE",
  "drawers.supplier.dtc": "DTC DragonPro",
  "paint.litres_per_kg": "0.85",
  // M24 (docs/plans/m24-contracts.md section 1): weeks from this Monday to the manufacturing row a
  // job gets at Send to Ordering; 0 = don't place automatically. PUT /api/settings {board}.
  "board.lead_weeks": "2",
  // 0.2.4 (docs/plans/m25-contracts.md section 5): the weekday end-of-shift reminder, Sydney HH:MM
  // (empty is off; Todd 2026-10-27: 16:00). PUT /api/settings {shift}. The last run is {audit: false}.
  "shift.reminder_time": "16:00",
  "shift.reminder_last_run": null,
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

// Upserts one setting. Unknown keys are a programming error, not user input.
// {audit:false} is for bookkeeping writes already covered by another audit row
// (the invoice counter, whose step is recorded by invoice.issue).
function set(db, key, value, req, { audit: auditIt = true } = {}) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    throw new Error(`Unknown setting key: ${key}`);
  }
  const before = get(db, key);
  const v = value == null ? null : String(value);
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).run(key, v, new Date().toISOString(), (req && req.user && req.user.id) || null);
  if (auditIt && !key.startsWith("roundup.") && before !== v) {
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
