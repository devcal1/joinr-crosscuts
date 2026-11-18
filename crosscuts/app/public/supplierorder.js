// New supplier order, on the Orders page (/orders.html), 0.2.22 (docs/plans/jobcards-plan.md).
// Pick a supplier, see every to-order line for it across all jobs (grouped by job, all ticked),
// untick any that are not in this order, set the order date (and an optional expected date and
// supplier ref), then Mark N ordered (POST /api/orders/mark-ordered, one transaction) or Print
// list (/orderprint.html, marks nothing). Who may do what is decided by the server. Text only.
(function () {
  "use strict";
  const P = window.OrdersPage;
  if (!P) return;
  const { el, can } = P;
  const $ = (id) => document.getElementById(id);

  const selEl = $("soSupplier");
  const rowsEl = $("soRows");
  const panelEl = $("soPanel");
  const emptyEl = $("soEmpty");
  const msgEl = $("soMessage");
  const allEl = $("soAll");
  const dateEl = $("soDate");
  const expEl = $("soExpected");
  const refEl = $("soRef");
  const sumEl = $("soSum");
  const markEl = $("soMark");
  const printEl = $("soPrint");

  let groups = new Map(); // lower(trim(supplier)) -> {name, lines: [order...]}
  let seq = 0;
  let busy = false;
  let today = "";

  function setMessage(text, kind) {
    msgEl.textContent = text || "";
    msgEl.className = "or-message " + (kind || "");
  }

  function fail(e) {
    return e instanceof TypeError ? "Couldn't reach the server. Try again." : e.message;
  }

  // A UTC timestamp as its Sydney day, "14 Nov".
  function fmtDay(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short" }).format(new Date(t));
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function validDate(s) {
    return window.OrderUI.ui.validDate(s);
  }

  // ------------------------------------------------------------------- data ---

  async function load() {
    const mine = ++seq;
    let list;
    try {
      list = await api("/api/orders?status=to_order");
    } catch (e) {
      if (mine !== seq) return false;
      setMessage(fail(e), "err");
      return false;
    }
    if (mine !== seq) return null;
    const next = new Map();
    for (const o of Array.isArray(list) ? list : []) {
      if (o.kind || o.reservedFromStock) continue;
      const name = (o.supplier || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!next.has(key)) next.set(key, { name, lines: [] });
      next.get(key).lines.push(o);
    }
    groups = next;
    fillSelect();
    renderLines();
    return true;
  }

  function fillSelect() {
    const keep = selEl.value;
    const sorted = [...groups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, undefined, { sensitivity: "base" }));
    selEl.replaceChildren(...sorted.map(([key, g]) => el("option", { value: key, text: g.name + " (" + g.lines.length + " to order)" })));
    selEl.value = groups.has(keep) ? keep : sorted.length ? sorted[0][0] : "";
    const none = sorted.length === 0;
    emptyEl.hidden = !none;
    panelEl.hidden = none;
    selEl.disabled = none;
  }

  // ------------------------------------------------------------------ lines ---

  function ticked() {
    return [...rowsEl.querySelectorAll('input[type="checkbox"][data-id]:checked')].map((c) => Number(c.getAttribute("data-id")));
  }

  function renderLines() {
    rowsEl.replaceChildren();
    const g = groups.get(selEl.value);
    if (!g) {
      refreshSummary();
      return;
    }
    const lines = g.lines.slice().sort((a, b) => a.id - b.id);
    const byJob = new Map();
    for (const o of lines) {
      if (!byJob.has(o.jobId)) byJob.set(o.jobId, []);
      byJob.get(o.jobId).push(o);
    }
    for (const [, list] of byJob) {
      const first = list[0];
      const head = el("td", { colspan: "4", class: "so-grouphead" });
      if (first.jobNumber) head.append(el("span", { class: "jc-jno", text: first.jobNumber }));
      head.append(document.createTextNode(first.jobName || ""));
      if (first.clientName) head.append(el("span", { class: "so-groupclient", text: " · " + first.clientName }));
      rowsEl.append(el("tr", { class: "so-group" }, el("td", {}), head));
      for (const o of list) {
        const name = (o.description || "Item") + (o.quantity != null ? ", " + window.OrderUI.fmtQty(o.quantity) : "");
        rowsEl.append(el(
          "tr",
          { class: "so-line" },
          el("td", { class: "so-tick" }, el("input", { type: "checkbox", "data-id": String(o.id), "aria-label": "In this order: " + name })),
          el("td", { class: "jc-sup", "data-label": "Hardware" }, el("span", { text: o.description || "" })),
          el("td", { class: "jc-num" + (o.quantity == null ? " jc-blank" : ""), "data-label": "Qty" }, document.createTextNode(window.OrderUI.fmtQty(o.quantity))),
          el("td", { class: "jc-date", "data-label": "Added" }, document.createTextNode(fmtDay(o.createdAt))),
          el("td", { class: "jc-text jc-notes" + (o.notes ? "" : " jc-blank"), "data-label": "Notes" }, el("span", { text: o.notes || "" }))
        ));
      }
    }
    refreshSummary();
  }

  function refreshSummary() {
    const g = groups.get(selEl.value);
    const total = g ? g.lines.length : 0;
    const ids = new Set(ticked());
    const n = ids.size;
    const jobs = new Set(g ? g.lines.filter((o) => ids.has(o.id)).map((o) => o.jobId) : []);
    sumEl.replaceChildren(el("b", { text: n + " of " + total }), document.createTextNode(" items, " + plural(jobs.size, "job", "jobs")));
    allEl.checked = total > 0 && n === total;
    allEl.indeterminate = n > 0 && n < total;
    markEl.textContent = "Mark " + n + " ordered";
    markEl.disabled = busy || n === 0;
    printEl.disabled = busy || n === 0;
  }

  rowsEl.addEventListener("change", () => {
    setMessage("", "");
    refreshSummary();
  });
  allEl.addEventListener("change", () => {
    for (const c of rowsEl.querySelectorAll('input[type="checkbox"][data-id]')) c.checked = allEl.checked;
    setMessage("", "");
    refreshSummary();
  });
  selEl.addEventListener("change", () => {
    setMessage("", "");
    renderLines();
  });

  // ---------------------------------------------------------------- actions ---

  // 0.2.23: "PO-0007 saved. 5 items marked ordered for 3 jobs from Blum Hardware." with View PDF
  // and Download PDF. It stays until dismissed or the next view change (orders.js showView).
  function showSaved(po, summary, supplierName) {
    const box = $("poSaved");
    const base = "/api/supplier-orders/" + encodeURIComponent(po.id) + "/pdf";
    const text = el("span", {}, el("b", { text: po.poNumber + " saved." }), document.createTextNode(" " + summary + (supplierName ? " from " + supplierName : "") + "."));
    if (po.pdfReady === false) text.append(document.createTextNode(" The PDF will be made when it is opened."));
    const open = el("a", { class: "hs-btn hs-btn-primary", href: base, target: "_blank", rel: "noopener", text: "View PDF" });
    const dl = el("a", { class: "hs-btn", href: base + "?download=1", text: "Download PDF" });
    const order = el("a", { class: "hs-btn hs-btn-quiet", href: "/orders.html?po=" + encodeURIComponent(po.id), text: "Open order" });
    order.addEventListener("click", (e) => {
      if (!window.SupplierOrders) return;
      e.preventDefault();
      P.showView("pos");
      window.SupplierOrders.open(po.id);
    });
    const close = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Dismiss" });
    close.addEventListener("click", () => { box.hidden = true; });
    box.replaceChildren(text, el("div", { class: "po-push" }, open, dl, order, close));
    box.hidden = false;
  }

  printEl.addEventListener("click", () => {
    const g = groups.get(selEl.value);
    const ids = ticked();
    if (!g || !ids.length) return;
    const qs = new URLSearchParams({ mode: "supplier", supplier: g.name, ids: ids.join(",") });
    if (validDate(dateEl.value)) qs.set("date", dateEl.value);
    const ref = refEl.value.trim();
    if (ref) qs.set("ref", ref);
    window.open("/orderprint.html?" + qs.toString(), "_blank");
  });

  function setBusy(on) {
    busy = on;
    for (const n of [selEl, allEl, dateEl, expEl, refEl, $("soBack")]) n.disabled = on;
    for (const c of rowsEl.querySelectorAll("input")) c.disabled = on;
    if (!on) selEl.disabled = groups.size === 0;
    refreshSummary();
  }

  markEl.addEventListener("click", async () => {
    if (busy) return;
    const ids = ticked();
    if (!ids.length) return;
    const orderedDate = dateEl.value;
    if (!validDate(orderedDate)) {
      setMessage("Choose the order date.", "err");
      dateEl.focus();
      return;
    }
    if (orderedDate > today) {
      setMessage("The order date can't be in the future.", "err");
      dateEl.focus();
      return;
    }
    if (expEl.value && !validDate(expEl.value)) {
      setMessage("The expected date isn't a whole date.", "err");
      expEl.focus();
      return;
    }
    const supplierName = (groups.get(selEl.value) || {}).name || "";
    const body = { orderIds: ids, orderedDate, expectedDate: expEl.value || null };
    const ref = refEl.value.trim();
    if (ref) body.supplierRef = ref;
    setBusy(true);
    setMessage("Saving...", "");
    let r;
    try {
      r = await api("/api/orders/mark-ordered", { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      setBusy(false);
      const sentence = fail(e);
      // A line that is no longer to order (someone else ordered or cancelled it): show the
      // server's sentence and the list as it is now.
      await load();
      setMessage(sentence, "err");
      return;
    }
    setBusy(false);
    const count = r && Number.isFinite(r.count) ? r.count : ids.length;
    const jobCount = r && Number.isFinite(r.jobCount) ? r.jobCount : 0;
    P.showView("cards");
    const po = r && r.supplierOrder && r.supplierOrder.id ? r.supplierOrder : null;
    const summary = plural(count, "item", "items") + " marked ordered for " + plural(jobCount, "job", "jobs");
    if (po) showSaved(po, summary, supplierName);
    else if (window.JobCards) window.JobCards.setMessage(summary + ".", "ok");
    P.reloadLines();
  });

  // ------------------------------------------------------------------ start ---

  function start() {
    today = window.OrderUI.ui.todayISO();
    dateEl.value = today;
    dateEl.max = today;
    expEl.value = "";
    refEl.value = "";
    const edit = can("orders.edit");
    $("soExpectedBox").hidden = !edit;
    $("soRefBox").hidden = !edit;
    markEl.hidden = !can("orders.mark_ordered");
    setMessage("", "");
    load().then(() => selEl.focus());
  }

  P.onShow("supplier", start);
  $("soBack").addEventListener("click", () => P.showView("cards"));
  $("soNew").addEventListener("click", () => P.showView("supplier"));

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    $("soNew").hidden = !can("orders.mark_ordered");
  })();
})();
