// The tax invoice document (/invoice.html?id=<id>). Read-only: it shows
// GET /api/invoices/:id as an A4 sheet, and "Save as PDF" is the browser's own
// print dialog. No edit controls. See docs/plans/m2-plan.md section 6.
(function () {
  "use strict";

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var sheet = document.getElementById("sheet");
  var btnPdf = document.getElementById("btn-pdf");
  var btnBack = document.getElementById("btn-back");
  var stateEl = document.getElementById("inv-state");

  // ---- formatting ----------------------------------------------------------

  // 1234567 -> "$12,345.67"; negative -> "-$12.00".
  function money(cents) {
    var n = Number(cents) || 0;
    var abs = Math.abs(n);
    var dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (n < 0 ? "-" : "") + "$" + dollars + "." + String(abs % 100).padStart(2, "0");
  }

  // "2026-10-10" -> "10 Oct 2026". Anything else is returned as it came.
  function fmtDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    if (!m) return s || "";
    return Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] + " " + m[1];
  }

  // Stored as "XX XXX XXX XXX"; tidy a raw 11-digit value the same way.
  function fmtAbn(s) {
    var d = String(s || "").replace(/\s+/g, "");
    if (/^\d{11}$/.test(d)) return d.slice(0, 2) + " " + d.slice(2, 5) + " " + d.slice(5, 8) + " " + d.slice(8);
    return String(s || "").trim();
  }

  // Stored as "NNN-NNN".
  function fmtBsb(s) {
    var d = String(s || "").trim();
    if (/^\d{6}$/.test(d)) return d.slice(0, 3) + "-" + d.slice(3);
    return d;
  }

  function has(v) {
    return v !== null && v !== undefined && String(v).trim() !== "";
  }

  // ---- tiny DOM helpers (text only, never innerHTML) -----------------------

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  // A label/value pair for the small key-value blocks.
  function kv(dl, label, value) {
    add(dl, el("dt", "inv-k", label), el("dd", "inv-v", value));
  }

  // ---- the document --------------------------------------------------------

  function isDraft(inv) {
    return inv.status === "pending" || inv.status === "due";
  }

  function fileTitle(inv) {
    var name = (inv.job && inv.job.name) || "";
    var first = isDraft(inv) || !inv.number ? "DRAFT" : inv.number;
    return (first + " " + name).trim();
  }

  function mark(text) {
    var m = el("div", "inv-mark", text);
    m.setAttribute("aria-hidden", "true");
    return m;
  }

  function banner(text, extra) {
    var b = el("div", "inv-banner");
    add(b, el("p", "inv-banner-head", text), extra);
    return b;
  }

  function buildHead(inv, biz) {
    var draft = isDraft(inv);
    var head = el("header", "inv-head");

    // Left: logo and the business.
    var brand = el("div", "inv-brand");
    var logo = el("img", "inv-logo");
    logo.src = "logo.png";
    logo.alt = "TH Cabinets";
    brand.appendChild(logo);

    var b = el("div", "inv-biz");
    var trading = has(biz.tradingName) ? biz.tradingName.trim() : "";
    var legal = has(biz.legalName) ? biz.legalName.trim() : "";
    var name = trading || legal;
    if (name) b.appendChild(el("p", "inv-biz-name", name));
    if (legal && legal !== name) b.appendChild(el("p", "inv-biz-line", legal));
    if (has(biz.abn)) b.appendChild(el("p", "inv-biz-line", "ABN " + fmtAbn(biz.abn)));
    if (has(biz.address)) b.appendChild(el("p", "inv-biz-line inv-pre", biz.address.trim()));
    if (has(biz.phone)) b.appendChild(el("p", "inv-biz-line", biz.phone.trim()));
    if (has(biz.email)) b.appendChild(el("p", "inv-biz-line", biz.email.trim()));
    brand.appendChild(b);
    head.appendChild(brand);

    // Right: the words, the number and the dates.
    var title = el("div", "inv-title");
    title.appendChild(el("h1", "inv-h1", "Tax invoice"));
    var dl = el("dl", "inv-meta");
    if (draft || !has(inv.number)) {
      if (inv.status !== "waived") kv(dl, "Invoice number", "Assigned on issue");
    } else {
      kv(dl, "Invoice number", inv.number);
    }
    if (has(inv.issueDate)) kv(dl, "Issue date", fmtDate(inv.issueDate));
    else if (draft) kv(dl, "Issue date", "On issue");
    if (has(inv.dueDate)) kv(dl, "Due date", fmtDate(inv.dueDate));
    else if (draft) kv(dl, "Due date", "On issue");
    title.appendChild(dl);

    if (inv.status === "paid") {
      title.appendChild(el("p", "inv-paid", "Paid" + (has(inv.paidDate) ? " " + fmtDate(inv.paidDate) : "")));
    }
    head.appendChild(title);
    return head;
  }

  function party(label, lines) {
    var p = el("div", "inv-party");
    p.appendChild(el("p", "inv-label", label));
    lines.forEach(function (l) {
      p.appendChild(el("p", l.cls || "inv-party-line inv-pre", l.text));
    });
    return p;
  }

  function buildParties(inv) {
    var job = inv.job || {};
    var wrap = el("section", "inv-parties");

    var billName = has(inv.billToName) ? inv.billToName : job.clientName;
    var billAddr = has(inv.billToAddress) ? inv.billToAddress : "";
    var billAbn = has(inv.billToAbn) ? inv.billToAbn : job.clientAbn;
    var bill = [];
    if (has(billName)) bill.push({ text: billName.trim(), cls: "inv-party-name" });
    if (has(billAddr)) bill.push({ text: billAddr.trim() });
    if (has(billAbn)) bill.push({ text: "ABN " + fmtAbn(billAbn), cls: "inv-party-line" });
    if (bill.length) wrap.appendChild(party("Bill to", bill));

    var site = has(inv.siteAddress) ? inv.siteAddress : job.siteAddress;
    var jobBits = [];
    if (has(job.name)) jobBits.push({ text: job.name.trim(), cls: "inv-party-name" });
    if (has(site)) jobBits.push({ text: site.trim() });
    if (jobBits.length) wrap.appendChild(party("Job and site", jobBits));
    return wrap.children.length ? wrap : null;
  }

  function buildLines(inv) {
    var table = el("table", "inv-lines");
    var thead = el("thead");
    var hr = el("tr");
    add(hr, el("th", "inv-col-desc", "Description"), el("th", "inv-col-amt", "Amount"));
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    (inv.lines || []).forEach(function (l) {
      var tr = el("tr");
      add(tr, el("td", "inv-col-desc inv-pre", l.description || ""), el("td", "inv-col-amt", money(l.amountCents)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function buildTotals(inv) {
    var box = el("div", "inv-totals");
    var row = el("div", "inv-total-row");
    add(row, el("span", "inv-total-k", "Total (including GST)"), el("span", "inv-total-v", money(inv.totalCents)));
    box.appendChild(row);
    box.appendChild(el("p", "inv-gst", "Total includes GST of " + money(inv.gstCents)));
    return box;
  }

  // Deposit, progress and final only, and only when the job has a value.
  function buildContract(inv, contract) {
    if (!contract || inv.kind === "extra" || contract.valueCents === null || contract.valueCents === undefined) return null;
    var invoiced = contract.invoicedToDateCents || 0;
    var balance = contract.valueCents - invoiced - inv.totalCents;
    var sec = el("section", "inv-contract");
    sec.appendChild(el("p", "inv-label", "Contract summary"));
    var dl = el("dl", "inv-sum");
    kv(dl, "Contract price (including GST)", money(contract.valueCents));
    kv(dl, "Invoiced to date", money(invoiced));
    kv(dl, "This invoice", money(inv.totalCents));
    kv(dl, "Balance remaining", money(balance));
    sec.appendChild(dl);
    return sec;
  }

  function buildPayment(inv, biz) {
    var sec = el("section", "inv-pay");
    sec.appendChild(el("p", "inv-label", "Payment details"));
    var dl = el("dl", "inv-sum");
    if (has(biz.bankAccountName)) kv(dl, "Account name", biz.bankAccountName.trim());
    if (has(biz.bsb)) kv(dl, "BSB", fmtBsb(biz.bsb));
    if (has(biz.accountNumber)) kv(dl, "Account number", biz.accountNumber.trim());
    if (dl.children.length) sec.appendChild(dl);
    if (has(biz.termsText)) sec.appendChild(el("p", "inv-terms inv-pre", biz.termsText.trim()));
    var ref = has(inv.number) && !isDraft(inv)
      ? "Please use invoice number " + inv.number + " as the reference."
      : "Please use the invoice number as the reference.";
    sec.appendChild(el("p", "inv-terms", ref));
    return sec;
  }

  // The watermark word, plus the notice box at the top of the sheet.
  function statusParts(inv) {
    if (isDraft(inv)) {
      return { mark: "DRAFT – NOT A TAX INVOICE", banner: banner("DRAFT – NOT A TAX INVOICE") };
    }
    if (inv.status === "void") {
      var reason = has(inv.voidReason) ? el("p", "inv-banner-text inv-pre", "Reason: " + inv.voidReason.trim()) : null;
      var bn = banner("VOID", reason);
      if (inv.replacedById) {
        var p = el("p", "inv-banner-text");
        var a = el("a", "inv-link", "Replaced by a new invoice (view)");
        a.href = "/invoice.html?id=" + encodeURIComponent(inv.replacedById);
        p.appendChild(a);
        bn.appendChild(p);
      }
      return { mark: "VOID", banner: bn };
    }
    if (inv.status === "waived") {
      var w = has(inv.waiveReason) ? el("p", "inv-banner-text inv-pre", "Reason: " + inv.waiveReason.trim()) : null;
      return { mark: "WAIVED", banner: banner("WAIVED – NOT A TAX INVOICE", w) };
    }
    return { mark: null, banner: null };
  }

  function render(data) {
    var inv = data.invoice;
    var biz = data.business || {};
    var s = statusParts(inv);

    sheet.textContent = "";
    sheet.className = "inv-sheet inv-status-" + inv.status;
    if (s.mark) sheet.appendChild(mark(s.mark));

    var body = el("div", "inv-body");
    if (s.banner) body.appendChild(s.banner);
    body.appendChild(buildHead(inv, biz));
    body.appendChild(el("hr", "inv-rule"));
    var parties = buildParties(inv);
    if (parties) body.appendChild(parties);
    body.appendChild(buildLines(inv));
    body.appendChild(buildTotals(inv));
    var foot = el("div", "inv-foot");
    add(foot, buildContract(inv, data.contract), buildPayment(inv, biz));
    body.appendChild(foot);
    sheet.appendChild(body);

    // The page title is the default PDF filename, so Ctrl+P is right too.
    document.title = fileTitle(inv);
    btnPdf.disabled = false;
    btnPdf.onclick = function () {
      document.title = fileTitle(inv);
      window.print();
    };

    var labels = { pending: "Draft", due: "Draft", issued: "Issued", paid: "Paid", waived: "Waived", void: "Void" };
    stateEl.className = "hs-badge " + (
      inv.status === "paid" ? "hs-badge-go" :
      inv.status === "void" || inv.overdue ? "hs-badge-stop" :
      isDraft(inv) ? "hs-badge-check" :
      inv.status === "issued" ? "hs-badge-teal" : "hs-badge-na"
    );
    stateEl.textContent = inv.overdue ? "Overdue" : labels[inv.status] || inv.status;
  }

  function fail(message) {
    sheet.textContent = "";
    sheet.className = "inv-sheet inv-sheet-error";
    sheet.appendChild(el("p", "inv-error", message));
    btnPdf.disabled = true;
    document.title = "Invoice - Crosscuts";
  }

  var id = new URLSearchParams(location.search).get("id");
  if (!id || !/^\d+$/.test(id)) {
    fail("Invoice not found");
  } else {
    btnBack.href = "/accounts.html?invoice=" + encodeURIComponent(id);
    api("/api/invoices/" + encodeURIComponent(id))
      .then(render)
      .catch(function (e) {
        var msg = e && e.message ? e.message : "";
        fail(/not found/i.test(msg) || /\(404\)/.test(msg) ? "Invoice not found" : msg || "The invoice could not be loaded");
      });
  }
})();
