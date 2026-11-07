// The invoice PDF (0.2.13): the server prints the existing invoice page (public/invoice.html, its own
// print CSS, A4) with headless Chromium, so there is one layout for the screen, the print and the email.
//
// How the headless browser gets in without a login (reviewed for exposure):
//  - Chromium is only ever pointed at http://127.0.0.1:<port>/invoice.html?id=N&pt=<token>.
//  - The token is 32 random bytes, kept only as a SHA-256 hash in memory, bound to ONE invoice id,
//    valid for 60 seconds and consumed by its first use. It is never stored, logged or returned.
//  - middleware() answers that one request itself, before the login gate, and only when ALL hold:
//    the TCP peer is loopback, there is no proxy header (the Umbrel gateway always adds one, and it is
//    not a loopback peer anyway), the Host is loopback, the token is live and its invoice id matches.
//    Anything else falls through to the normal login gate, so a stranger learns nothing.
//  - What it serves is the invoice page with the invoice's data embedded in it and the shell scripts
//    removed (the shell would need a session). The page needs no API call, so no other route or
//    credential is opened to the headless browser. The invoice id is the only thing it can ever see.
//  - Chromium is told to resolve nothing but 127.0.0.1, so a page can never fetch anything outside.
// PDF_FAKE=1 returns a small valid PDF without Chromium (smoke tests on a machine without one).
// CHROMIUM_PATH picks the browser binary (default /usr/bin/chromium, the Alpine package).
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const invoices = require("./invoices");
const settings = require("./settings");
const { HttpError } = require("./httperror");

const TOKEN_TTL_MS = 60 * 1000;
const RENDER_TIMEOUT_MS = 45 * 1000;
const PAGE_FILE = path.join(__dirname, "..", "public", "invoice.html");

const tokens = new Map(); // sha256(token) -> { invoiceId, expires }

function hash(t) {
  return crypto.createHash("sha256").update(String(t)).digest("hex");
}

function makeToken(invoiceId) {
  const now = Date.now();
  for (const [h, v] of tokens) if (v.expires < now) tokens.delete(h);
  const t = crypto.randomBytes(32).toString("base64url");
  tokens.set(hash(t), { invoiceId, expires: now + TOKEN_TTL_MS });
  return t;
}

// True when the token is live and for this invoice; it is used up either way a match is found.
function consumeToken(t, invoiceId) {
  if (typeof t !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(t)) return false;
  const h = hash(t);
  const v = tokens.get(h);
  if (!v) return false;
  tokens.delete(h);
  return v.expires >= Date.now() && v.invoiceId === invoiceId;
}

function isLoopbackPeer(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
function isLoopbackHost(host) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(host || ""));
}

// JSON that is safe inside a <script> element.
function scriptJson(v) {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// The invoice page for the headless browser: data embedded, shell scripts removed.
function pageFor(db, invoiceId) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
  if (!inv) return null;
  const data = { invoice: invoices.present(db, inv), business: settings.business(db), contract: invoices.contractOf(db, inv) };
  let html = fs.readFileSync(PAGE_FILE, "utf8");
  html = html
    .replace(/\s*<script src="\/shell\/busy\.js"><\/script>/, "")
    .replace(/\s*<script src="\/shell\/shell\.js"><\/script>/, "")
    .replace(/\s*<script src="invoicesend\.js"><\/script>/, "")
    .replace('<script src="invoice.js"></script>', `<script>window.__INVOICE_DATA__ = ${scriptJson(data)};</script>\n  <script src="invoice.js"></script>`);
  return html;
}

// Express middleware, mounted before the login gate (see server.js).
function middleware(db) {
  return function pdfRenderGate(req, res, next) {
    try {
      if (req.method !== "GET" || req.path !== "/invoice.html" || typeof req.query.pt !== "string") return next();
      if (!isLoopbackPeer(req.socket && req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) return next();
      for (const h of ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded", "cookie", "origin"]) {
        if (req.headers[h] !== undefined) return next();
      }
      const id = Number(req.query.id);
      if (!Number.isInteger(id) || id < 1 || !consumeToken(req.query.pt, id)) return next();
      const html = pageFor(db, id);
      if (!html) return next();
      res.set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      return res.send(html);
    } catch (e) {
      console.error("[invoicepdf] render gate failed:", e && e.message ? e.message : e);
      return next();
    }
  };
}

// --- the headless browser ------------------------------------------------------------------------

const FAKE_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n"
);

function chromiumPath() {
  if (process.env.CHROMIUM_PATH && process.env.CHROMIUM_PATH.trim()) return process.env.CHROMIUM_PATH.trim();
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser"]) if (fs.existsSync(p)) return p;
  return null;
}

function port() {
  return Number(process.env.PORT) || 3000;
}

// One Chromium at a time.
let chain = Promise.resolve();
function queued(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

function killTree(child) {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

function runChromium(bin, url, out, profile) {
  return new Promise((resolve, reject) => {
    const args = [
      "--headless",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-breakpad",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      // The container runs as root, where Chromium refuses to start with its sandbox. The only page it
      // ever opens is this server's own invoice page, and it can resolve nothing but loopback.
      ...(typeof process.getuid === "function" && process.getuid() === 0 ? ["--no-sandbox"] : []),
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--user-data-dir=" + profile,
      "--no-pdf-header-footer",
      "--print-to-pdf=" + out,
      url,
    ];
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: profile } });
    let err = "";
    child.stderr.on("data", (d) => {
      if (err.length < 2000) err += d;
    });
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error("the PDF took too long to make"));
    }, RENDER_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error("the PDF maker could not start (" + (e && e.code ? e.code : "error") + ")"));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error("the PDF maker failed (exit " + code + ")"));
    });
  });
}

// Chromium on Linux has written the file when it exits; some launchers (Edge on a Windows dev box)
// exit first. Wait, briefly, for the file to exist and stop growing.
async function fileReady(file) {
  const until = Date.now() + 20000;
  let last = -1;
  while (Date.now() < until) {
    let size = -1;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = -1;
    }
    if (size > 0 && size === last) return;
    last = size;
    await new Promise((r) => setTimeout(r, size > 0 ? 300 : 200));
  }
  throw new Error("the PDF was not written");
}

// The PDF of an invoice as a Buffer. Only an issued or paid invoice has one.
async function renderInvoicePdf(db, invoiceId) {
  const inv = db.prepare("SELECT id, status FROM invoices WHERE id = ?").get(invoiceId);
  if (!inv) throw new HttpError(404, "Not found");
  if (inv.status !== "issued" && inv.status !== "paid") {
    throw new HttpError(409, `Only an issued invoice has a PDF (this one is ${inv.status})`);
  }
  if (process.env.PDF_FAKE === "1") return FAKE_PDF;
  const bin = chromiumPath();
  if (!bin) throw new Error("the PDF maker is not installed on this server");
  return queued(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pdf-"));
    try {
      const out = path.join(dir, "invoice.pdf");
      const url = `http://127.0.0.1:${port()}/invoice.html?id=${invoiceId}&pt=${makeToken(invoiceId)}`;
      await runChromium(bin, url, out, path.join(dir, "profile"));
      await fileReady(out);
      const pdf = fs.readFileSync(out);
      if (pdf.length < 1000 || pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("the PDF came out empty");
      return pdf;
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch {
        // a launcher that is still shutting down holds its profile; the temp folder is harmless
      }
    }
  });
}

function fileName(inv) {
  const n = String(inv.number || ("invoice-" + inv.id)).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "invoice";
  return `Invoice-${n}.pdf`;
}

module.exports = { middleware, renderInvoicePdf, fileName, makeToken, consumeToken, pageFor };
