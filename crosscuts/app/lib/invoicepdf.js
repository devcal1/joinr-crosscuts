// The invoice PDF (0.2.13): the server prints the existing invoice page (public/invoice.html, its own
// print CSS, A4) with headless Chromium, so there is one layout for the screen, the print and the email.
//
// Since 0.2.23 the shared machinery (the one-time loopback token, the gate that serves the page without a
// login, Chromium and its queue) lives in lib/pdfrender.js, with its security review notes. This file is
// the invoice's thin layer over it: the "invoice" kind, its issued-or-paid rule, PDF_FAKE and the file name.
const pdfrender = require("./pdfrender");
const { HttpError } = require("./httperror");

// pdfrender.middleware answers the invoice page and the purchase order page; see server.js.
const middleware = pdfrender.middleware;

const makeToken = (invoiceId) => pdfrender.makeToken("invoice", invoiceId);
const consumeToken = (t, invoiceId) => pdfrender.consumeToken(t, "invoice", invoiceId);
const pageFor = (db, invoiceId) => pdfrender.pageFor(db, "invoice", invoiceId);

// The PDF of an invoice as a Buffer. Only an issued or paid invoice has one.
async function renderInvoicePdf(db, invoiceId) {
  const inv = db.prepare("SELECT id, status FROM invoices WHERE id = ?").get(invoiceId);
  if (!inv) throw new HttpError(404, "Not found");
  if (inv.status !== "issued" && inv.status !== "paid") {
    throw new HttpError(409, `Only an issued invoice has a PDF (this one is ${inv.status})`);
  }
  if (process.env.PDF_FAKE === "1") return pdfrender.fakePdf();
  return pdfrender.renderPdf("invoice", invoiceId);
}

function fileName(inv) {
  const n = String(inv.number || ("invoice-" + inv.id)).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "invoice";
  return `Invoice-${n}.pdf`;
}

module.exports = { middleware, renderInvoicePdf, fileName, makeToken, consumeToken, pageFor };
