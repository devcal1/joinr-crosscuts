// Business details and invoice numbering settings. Wave 1 B.
// See docs/plans/m2-contracts.md section 4. Both routes need users.admin.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const settings = require("../lib/settings");

const r = defineRoutes("/api/settings");

const ACCESS = "users.admin";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bad(message) {
  return new HttpError(400, message);
}

// camelCase body field -> settings key, for the `business` group.
const BUSINESS_FIELDS = {
  tradingName: "business.trading_name",
  legalName: "business.legal_name",
  abn: "business.abn",
  address: "business.address",
  phone: "business.phone",
  email: "business.email",
  bankAccountName: "bank.account_name",
  bsb: "bank.bsb",
  accountNumber: "bank.account_number",
  termsText: "invoice.terms_text",
};
// M24: the board group.
const BOARD_FIELDS = { leadWeeks: "board.lead_weeks" };
const INVOICE_FIELDS = {
  prefix: "invoice.prefix",
  nextNumber: "invoice.next_number",
  pad: "invoice.pad",
  defaultDays: "invoice.default_days",
  termsText: "invoice.terms_text",
};
// Changing these once an invoice has a number would break the sequence.
const NUMBERING_KEYS = ["invoice.prefix", "invoice.next_number", "invoice.pad"];

const MAX_SHORT = 200;
const MAX_ADDRESS = 500;
const MAX_TERMS = 5000;
const MAX_NEXT_NUMBER = 999999999;

function numberLocked() {
  return !!db.prepare("SELECT 1 FROM invoices WHERE number IS NOT NULL LIMIT 1").get();
}

function current() {
  const s = settings.getAll(db);
  return {
    business: settings.business(db),
    invoice: {
      prefix: s["invoice.prefix"],
      nextNumber: Number(s["invoice.next_number"]),
      pad: Number(s["invoice.pad"]),
      defaultDays: Number(s["invoice.default_days"]),
      termsText: s["invoice.terms_text"],
      numberLocked: numberLocked(),
    },
    board: { leadWeeks: Number(s["board.lead_weeks"]) },
  };
}

// A trimmed string, or null for "clear it". Anything else is a 400.
function text(label, v, max) {
  if (v === null) return null;
  if (typeof v !== "string") throw bad(`${label} must be text`);
  const t = v.trim();
  if (t.length > max) throw bad(`${label} is too long (${max} characters at most)`);
  return t === "" ? null : t;
}

function integer(label, v, min, max) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw bad(`${label} must be a whole number from ${min} to ${max}`);
  }
  return String(v);
}

// Validates one field and returns the value to store (a string, or null to clear).
function parseField(field, v) {
  switch (field) {
    case "abn": {
      const t = text("ABN", v, MAX_SHORT);
      if (t === null) return null;
      const digits = t.replace(/\s+/g, "");
      if (!/^\d{11}$/.test(digits)) throw bad("ABN must be 11 digits");
      return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
    }
    case "bsb": {
      const t = text("BSB", v, MAX_SHORT);
      if (t === null) return null;
      const digits = t.replace(/[\s-]+/g, "");
      if (!/^\d{6}$/.test(digits)) throw bad("BSB must be 6 digits");
      return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    }
    case "address":
      return text("Address", v, MAX_ADDRESS);
    case "termsText":
      return text("Terms", v, MAX_TERMS);
    case "tradingName":
      return text("Trading name", v, MAX_SHORT);
    case "legalName":
      return text("Legal name", v, MAX_SHORT);
    case "phone":
      return text("Phone", v, MAX_SHORT);
    case "email":
      return text("Email", v, MAX_SHORT);
    case "bankAccountName":
      return text("Account name", v, MAX_SHORT);
    case "accountNumber":
      return text("Account number", v, MAX_SHORT);
    case "prefix": {
      if (typeof v !== "string" || !/^\S{1,10}$/.test(v.trim())) {
        throw bad("Prefix must be 1 to 10 characters with no spaces");
      }
      return v.trim();
    }
    case "nextNumber":
      return integer("Next number", v, 1, MAX_NEXT_NUMBER);
    case "pad":
      return integer("Number padding", v, 1, 10);
    case "defaultDays":
      return integer("Payment days", v, 0, 365);
    case "leadWeeks":
      return integer("Board lead weeks", v, 0, 12);
    default:
      throw bad(`Unknown field: ${field}`);
  }
}

// Collects { settingsKey: storedValue } from one group of the body.
function parseGroup(group, body, fields, ignore) {
  if (body === undefined) return {};
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw bad(`${group} must be an object`);
  }
  const out = {};
  for (const [field, v] of Object.entries(body)) {
    if (ignore.includes(field)) continue;
    if (!Object.prototype.hasOwnProperty.call(fields, field)) throw bad(`Unknown field: ${group}.${field}`);
    out[fields[field]] = parseField(field, v);
  }
  return out;
}

r.get("/", ACCESS, (req, res) => {
  res.json(current());
});

r.put("/", ACCESS, (req, res) => {
  try {
    const body = req.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw bad("Body must be an object");
    // termsText may arrive in either group; the invoice group wins if both are sent.
    const changes = {
      ...parseGroup("business", body.business, BUSINESS_FIELDS, []),
      ...parseGroup("invoice", body.invoice, INVOICE_FIELDS, ["numberLocked"]),
      ...parseGroup("board", body.board, BOARD_FIELDS, []),
    };
    db.transaction(() => {
      // Echoing the stored value back (the panel sends the whole form) is not a change.
      if (numberLocked()) {
        for (const key of NUMBERING_KEYS) {
          if (key in changes && changes[key] !== settings.get(db, key)) {
            throw new HttpError(409, "Invoice numbering is locked once an invoice has been numbered");
          }
        }
      }
      for (const [key, value] of Object.entries(changes)) settings.set(db, key, value, req);
    })();
    res.json(current());
  } catch (e) {
    if (e instanceof HttpError) {
      res.status(e.status).json({ error: e.message });
    } else {
      console.error("settings route error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
});

module.exports = r.router;
