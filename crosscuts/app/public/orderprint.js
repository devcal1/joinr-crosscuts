// The supplier order list and job card prints (/orderprint.html; docs/plans/jobcards-plan.md
// section 5). Gated by orders.view (lib/pages.js). Printing marks nothing ordered.
//
//   ?mode=supplier&supplier=<name>&ids=1,2,3&date=YYYY-MM-DD&ref=<text>
//       the order list for one supplier: only the listed lines (still to order), grouped by job,
//       with Hardware and Qty. date and ref are optional and go in the header.
//       GET /api/orders?status=to_order&supplier=<name>
//   ?mode=card&job=<jobId>
//       the job card: that job's lines (cancelled ones left out) with supplier, hardware, qty,
//       status and the ordered, expected and received dates.
//       GET /api/orders?status=all&jobId=<id>   (no lines: the header comes from
//       GET /api/orders/cards?finished=1)
//
// Page numbers: orderprint.css puts "Page X of Y" in the page's bottom-right margin (CSS page
// margin boxes, Chrome 131 and later); table headings repeat on each page. Older browsers print
// without it. Every value goes in through textContent; classes are op-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const STATUS = { to_order: "To order", ordered: "Ordered", received: "Received", cancelled: "Cancelled" };

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  function text(v) {
    return v == null ? "" : String(v).trim();
  }

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  // 24, 2.4, 2.45; blank when there is no quantity
  function fmtQty(q) {
    if (q == null || q === "" || !Number.isFinite(Number(q))) return "";
    return String(Number(Number(q).toFixed(2)));
  }

  function setStatus(msg) {
    $("opStatus").textContent = msg || "";
  }

  function refuse(msg) {
    const sheet = $("opSheet");
    sheet.className = "op-sheet op-sheet-error";
    sheet.replaceChildren(el("p", { class: "op-error", text: msg }));
    $("opPrint").disabled = true;
    document.title = "Order print - Crosscuts";
  }

  function failText(e, what) {
    if (e instanceof TypeError) return "Couldn't reach the server. Reload to try again.";
    const m = (e && e.message) || "";
    if (/not found/i.test(m)) return "There is no " + what + ".";
    if (/forbidden|permission|access|not allowed/i.test(m)) return "You don't have access to " + what + ".";
    return m || "That didn't load. Reload to try again.";
  }

  function banner() {
    const img = el("img", { class: "op-banner", src: "/assets/invoice-letterhead.png", alt: "TH Cabinets" });
    img.addEventListener("error", () => img.remove(), { once: true });
    return img;
  }

  function metaList(pairs) {
    const rows = pairs.filter(([, v]) => text(v));
    if (!rows.length) return null;
    const dl = el("dl", { class: "op-meta" });
    for (const [k, v] of rows) dl.append(el("dt", { text: k }), el("dd", { text: text(v) }));
    return dl;
  }

  function show(title, nodes, doneStatus) {
    const sheet = $("opSheet");
    sheet.className = "op-sheet";
    sheet.setAttribute("aria-label", title);
    sheet.replaceChildren(...nodes.filter(Boolean));
    document.title = title;
    $("opPrint").disabled = false;
    setStatus(doneStatus);
  }

  function cell(tag, value, cls) {
    return el(tag, { class: cls || null, text: value });
  }

  function jobLabel(o) {
    return [text(o.jobNumber), text(o.jobName)].filter(Boolean).join("  ") || "Job " + o.jobId;
  }

  // ---- the supplier order list ------------------------------------------------------------

  async function startSupplier(q) {
    const supplier = text(q.get("supplier"));
    const idsRaw = text(q.get("ids"));
    const date = text(q.get("date"));
    const ref = text(q.get("ref"));
    const ids = idsRaw.split(",").map((s) => s.trim());
    if (!supplier || !idsRaw || !ids.every((s) => /^[1-9]\d*$/.test(s))) {
      refuse("That isn't an order list. Open Orders, choose a supplier and press Print list.");
      return;
    }
    if (date && !fmtDate(date)) {
      refuse("That order date isn't a date. Open Orders, choose a supplier and press Print list.");
      return;
    }
    const want = new Set(ids.map(Number));
    let rows;
    try {
      rows = await api("/api/orders?status=to_order&supplier=" + encodeURIComponent(supplier));
    } catch (e) {
      refuse(failText(e, "order list for " + supplier));
      return;
    }
    const lines = (Array.isArray(rows) ? rows : []).filter((o) => want.has(o.id) && !o.kind);
    if (!lines.length) {
      refuse("None of those items are still to order for " + supplier + ". Go back to Orders and reload.");
      return;
    }
    // jobs in order of their oldest line; lines oldest first within the job
    lines.sort((a, b) => a.id - b.id);
    const groups = new Map();
    for (const o of lines) {
      if (!groups.has(o.jobId)) groups.set(o.jobId, []);
      groups.get(o.jobId).push(o);
    }
    const tbody = el("tbody");
    for (const list of groups.values()) {
      tbody.append(el("tr", { class: "op-group" }, el("td", { colspan: "2", text: jobLabel(list[0]) })));
      for (const o of list) tbody.append(el("tr", {}, cell("td", text(o.description)), cell("td", fmtQty(o.quantity), "op-num")));
    }
    const table = el("table", { class: "op-table" },
      el("thead", {}, el("tr", {}, cell("th", "Hardware"), cell("th", "Qty", "op-num"))), tbody);
    const n = lines.length;
    show("Order list " + supplier, [
      banner(),
      el("div", { class: "op-titlerow" },
        el("div", {}, el("h1", { class: "op-h1", text: "Order list" }), el("p", { class: "op-sub", text: supplier })),
        metaList([["Order date", fmtDate(date)], ["Supplier ref", ref]])),
      table,
      el("p", { class: "op-foot", text: n + (n === 1 ? " item" : " items") }),
    ], "Printing this list does not mark anything ordered.");
  }

  // ---- the job card -----------------------------------------------------------------------

  async function startCard(q) {
    const job = text(q.get("job"));
    if (!/^[1-9]\d*$/.test(job)) {
      refuse("That isn't a job card. Open Orders and press Print card on a card.");
      return;
    }
    let rows;
    try {
      rows = await api("/api/orders?status=all&jobId=" + encodeURIComponent(job));
    } catch (e) {
      refuse(failText(e, "job card " + job));
      return;
    }
    const lines = (Array.isArray(rows) ? rows : []).filter((o) => o.status !== "cancelled");
    lines.sort((a, b) => a.id - b.id);
    let number = "", name = "", client = "";
    if (lines.length) {
      number = text(lines[0].jobNumber);
      name = text(lines[0].jobName);
      client = text(lines[0].clientName);
    } else {
      try {
        const r = await api("/api/orders/cards?finished=1");
        const c = ((r && r.cards) || []).find((x) => String(x.jobId) === job);
        if (c) { number = text(c.jobNumber); name = text(c.name); client = text(c.client); }
      } catch (e) { /* the sentence below covers it */ }
      if (!name) {
        refuse("There is no job card for that job, or it has no items.");
        return;
      }
    }
    const tbody = el("tbody");
    for (const o of lines) {
      tbody.append(el("tr", {},
        cell("td", text(o.supplier)),
        cell("td", text(o.description)),
        cell("td", fmtQty(o.quantity), "op-num"),
        cell("td", STATUS[o.status] || text(o.status), "op-nowrap"),
        cell("td", fmtDate(o.orderedDate), "op-nowrap"),
        cell("td", fmtDate(o.expectedDate), "op-nowrap"),
        cell("td", fmtDate(o.receivedDate), "op-nowrap")));
    }
    if (!lines.length) tbody.append(el("tr", {}, el("td", { colspan: "7", text: "No items on this card." })));
    const heads = [["Supplier"], ["Hardware"], ["Qty", "op-num"], ["Status"], ["Ordered"], ["Expected"], ["Received"]];
    const table = el("table", { class: "op-table op-card" },
      el("thead", {}, el("tr", {}, ...heads.map(([h, c]) => cell("th", h, c)))), tbody);
    const n = lines.length;
    const heading = [number, name].filter(Boolean).join("  ");
    show("Job card " + heading, [
      banner(),
      el("div", { class: "op-titlerow" },
        el("div", {}, el("h1", { class: "op-h1", text: "Job card" }), el("p", { class: "op-sub", text: heading })),
        metaList([["Job no.", number], ["Client", client]])),
      table,
      el("p", { class: "op-foot", text: n + (n === 1 ? " item" : " items") }),
    ], "");
  }

  $("opPrint").addEventListener("click", () => window.print());

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    const q = new URLSearchParams(location.search);
    const mode = q.get("mode");
    if (mode === "supplier") startSupplier(q);
    else if (mode === "card") startCard(q);
    else refuse("Nothing to print. Open Orders, then print a supplier list or a job card.");
  })();
})();
