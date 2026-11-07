// Invoice email settings (0.2.13): the Resend API key and the From address. users.admin only.
// The key lives in a file in CONFIG_DIR (lib/resend.js) and never leaves it: responses carry
// keyStatus() (last four only) and the audit rows carry the word 'set' or 'cleared'.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const audit = require("../lib/audit");
const settings = require("../lib/settings");
const resend = require("../lib/resend");
const invoiceEmail = require("../lib/invoiceemail");
const { HttpError, bad, sendError } = require("../lib/httperror");

const r = defineRoutes("/api/invoice-email");
const ACCESS = "users.admin";

function payload() {
  const from = invoiceEmail.fromSetting(db);
  return { from: from ? from.text : "", key: resend.keyStatus() };
}

r.get("/settings", ACCESS, (req, res) => {
  try {
    res.json(payload());
  } catch (e) {
    sendError(res, e, "[invoice-email settings]");
  }
});

// {from?, apiKey?}. Everything is checked before anything is written.
r.put("/settings", ACCESS, (req, res) => {
  try {
    const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    if (b.from !== undefined && typeof b.from !== "string") throw bad("The From address must be text");
    if (b.apiKey !== undefined && b.apiKey !== null && typeof b.apiKey !== "string") throw bad("The API key must be text");
    const hasKey = typeof b.apiKey === "string" && b.apiKey.trim() !== "";
    let from = null;
    if (typeof b.from === "string" && b.from.trim()) {
      from = invoiceEmail.parseFrom(b.from);
      if (!from) throw bad('The From address must look like: Name <address@example.com.au>');
    }
    if (hasKey && !/^[\x21-\x7e]{8,200}$/.test(b.apiKey.trim())) throw bad("The API key must be 8 to 200 characters with no spaces");
    if (hasKey && resend.keyStatus().fromEnv) throw new HttpError(409, "The API key is set by the server's environment and can't be changed here");
    if (from) settings.set(db, invoiceEmail.FROM_KEY, from.text, req);
    if (hasKey) {
      resend.setKey(b.apiKey);
      audit.log(req, { action: "invoice-email.settings", entityType: "invoice-email", entityId: "settings", after: { key: "set" } });
    }
    res.json(payload());
  } catch (e) {
    sendError(res, e, "[invoice-email settings]");
  }
});

r.delete("/settings/key", ACCESS, (req, res) => {
  try {
    resend.clearKey();
    audit.log(req, { action: "invoice-email.settings", entityType: "invoice-email", entityId: "settings", after: { key: "cleared" } });
    res.json(payload());
  } catch (e) {
    sendError(res, e, "[invoice-email settings]");
  }
});

module.exports = r.router;
