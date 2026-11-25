// Supplier orders tab on the Orders page (/orders.html, orders.view), 0.2.23
// (docs/plans/purchase-orders-plan.md). Every saved purchase order, newest first, from
// GET /api/supplier-orders; opening one shows its items grouped by job with each item's current
// state (GET /api/supplier-orders/:id) and the View PDF, Print and Download PDF buttons. An order
// is linkable as /orders.html?po=N. The saved order and its PDF are frozen by the server; this
// page only reads them. Everything is set as text.
(function () {
  "use strict";
  const P = window.OrdersPage;
  if (!P) return;
  const { el, can, fmtDate } = P;
  const $ = (id) => document.getElementById(id);

  const findEl = $("poFind");
  const supEl = $("poSupplier");
  const countEl = $("poCount");
  const msgEl = $("poMessage");
  const boxEl = $("poListBox");
  const rowsEl = $("poRows");
  const panelEl = $("poPanel");

  let seq = 0;
  let openSeq = 0;
  let orders = [];
  let openId = null;
  let suppliers = new Set();

  function setMessage(text, kind) {
    msgEl.textContent = text || "";
    msgEl.className = "or-message " + (kind || "");
  }

  function fail(e) {
    return e instanceof TypeError ? "Couldn't reach the server. Try again." : e.message;
  }

  // A UTC timestamp as its Sydney day, "19 Nov 2026".
  function fmtDay(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric" }).format(new Date(t));
  }

  function dash() {
    return el("span", { class: "jc-dash", text: "–" });
  }

  function cell(label, cls, ...kids) {
    return el("td", { class: cls || null, "data-label": label }, ...kids);
  }

  function textOrDash(label, cls, text) {
    return cell(label, cls, text ? document.createTextNode(text) : dash());
  }

  function pdfUrl(id, download) {
    return "/api/supplier-orders/" + encodeURIComponent(id) + "/pdf" + (download ? "?download=1" : "");
  }

  // ------------------------------------------------------------------- list ---

  function fillSuppliers(list) {
    for (const s of list || []) if (s) suppliers.add(s);
    const keep = supEl.value;
    const sorted = [...suppliers].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    supEl.replaceChildren(el("option", { value: "", text: "All suppliers" }), ...sorted.map((s) => el("option", { value: s, text: s })));
    supEl.value = suppliers.has(keep) ? keep : "";
  }

  function renderList() {
    rowsEl.replaceChildren();
    boxEl.hidden = orders.length === 0;
    const filtered = !!(findEl.value.trim() || supEl.value);
    countEl.textContent = orders.length === 0
      ? (filtered ? "No supplier orders match." : "No supplier orders yet. They appear here when a supplier order is marked ordered.")
      : orders.length + (orders.length === 1 ? " order" : " orders");
    for (const o of orders) {
      const on = o.id === openId;
      const btn = el("button", {
        type: "button",
        class: "hs-btn hs-btn-quiet",
        "data-po": String(o.id),
        "aria-expanded": on ? "true" : "false",
        "aria-label": (on ? "Close " : "Open ") + o.poNumber,
        text: on ? "Close" : "Open",
      });
      rowsEl.append(el(
        "tr",
        { class: "po-row" + (on ? " po-sel" : ""), "data-po": String(o.id) },
        cell("Order", "po-no", document.createTextNode(o.poNumber)),
        cell("Supplier", "jc-sup", el("span", { text: o.supplier })),
        textOrDash("Order date", "jc-date", fmtDate(o.orderedDate)),
        textOrDash("Expected", "jc-date", fmtDate(o.expectedDate)),
        textOrDash("Supplier ref", "jc-text", o.supplierRef),
        cell("Items", "jc-num", document.createTextNode(String(o.itemCount))),
        textOrDash("Jobs", "jc-text", [...(o.hasStock ? ["STOCK"] : []), ...((o.jobNumbers || []).length ? o.jobNumbers : (o.jobs || []).map((j) => j.jobName))].join(", ")),
        textOrDash("By", "", o.orderedBy),
        cell("", "jc-acts", btn)
      ));
    }
  }

  async function load() {
    const mine = ++seq;
    const qs = new URLSearchParams();
    const q = findEl.value.trim();
    if (q) qs.set("q", q);
    if (supEl.value) qs.set("supplier", supEl.value);
    let r;
    try {
      r = await api("/api/supplier-orders" + (qs.toString() ? "?" + qs.toString() : ""));
    } catch (e) {
      if (mine !== seq) return false;
      setMessage(fail(e), "err");
      return false;
    }
    if (mine !== seq) return null;
    setMessage("", "");
    orders = Array.isArray(r && r.orders) ? r.orders : [];
    fillSuppliers(r && r.suppliers);
    renderList();
    return true;
  }

  // ------------------------------------------------------------- one order ---

  function stateCell(it) {
    const c = it.current || {};
    const td = cell("Now", "po-now");
    if (c.state === "received") {
      td.append(el("span", { class: "hs-badge hs-badge-go", text: "Received" + (c.receivedDate ? " " + fmtDate(c.receivedDate) : "") }));
    } else if (c.state === "undone") {
      if (c.laterPo && c.laterPo.id) {
        td.append(el("span", { class: "hs-badge hs-badge-na", text: "Undone" }), document.createTextNode(" "));
        const note = el("span", { class: "po-undone" }, document.createTextNode("now on "), poLink(c.laterPo.id, c.laterPo.poNumber));
        td.append(note);
      } else if (c.status === "ordered" || c.status === "received") {
        // undone from this order, then ordered (or received) on its own, not through a supplier order
        td.append(el("span", { class: "hs-badge hs-badge-na", text: "Undone" }), document.createTextNode(" "));
        td.append(el("span", { class: "po-undone", text: "now ordered separately" }));
      } else {
        const [label, badge] = c.status === "cancelled" ? ["Cancelled", "hs-badge-na"] : ["To order", "hs-badge-check"];
        td.append(el("span", { class: "hs-badge " + badge, text: label }), document.createTextNode(" "));
        const day = fmtDay(c.undoneAt);
        td.append(el("span", { class: "po-undone", text: "Undone since" + (day ? " " + day : "") + (c.undoneBy ? " by " + c.undoneBy : "") }));
      }
    } else {
      td.append(el("span", { class: "hs-badge hs-badge-teal", text: "Ordered" }));
    }
    return td;
  }

  function poLink(id, number) {
    const a = el("a", { class: "po-link", href: "/orders.html?po=" + encodeURIComponent(id), text: number });
    a.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      openOrder(id, true);
    });
    return a;
  }

  function renderPanel(o) {
    const heading = el("h2", { class: "jc-ptitle", id: "poPTitle", tabindex: "-1" }, el("span", { class: "po-no po-bigno", text: o.poNumber }), document.createTextNode("  " + o.supplier));
    const bits = ["Ordered " + fmtDate(o.orderedDate) + (o.orderedBy ? " by " + o.orderedBy : "")];
    if (o.expectedDate) bits.push("expected " + fmtDate(o.expectedDate));
    if (o.supplierRef) bits.push("supplier ref " + o.supplierRef);
    const btns = el(
      "div",
      { class: "jc-pbtns" },
      el("a", { class: "hs-btn hs-btn-primary", href: pdfUrl(o.id, false), target: "_blank", rel: "noopener", text: "View PDF" }),
      el("a", { class: "hs-btn", href: "/orderprint.html?mode=po&id=" + encodeURIComponent(o.id), target: "_blank", rel: "noopener", text: "Print" }),
      el("a", { class: "hs-btn", href: pdfUrl(o.id, true), text: "Download PDF" }),
      el("button", { type: "button", class: "hs-btn hs-btn-quiet", "data-po-close": "1", text: "Close" })
    );
    const head = el("div", { class: "jc-phead" }, el("div", {}, heading, el("div", { class: "jc-client", text: bits.join(" · ") })), btns);

    const items = Array.isArray(o.items) ? o.items : [];
    let body;
    if (!items.length) body = el("p", { class: "jc-pnote", text: "No items on this order." });
    else {
      const tb = el("tbody");
      const seen = new Set();
      for (const it of items) {
        const key = it.stock ? "stock" : it.jobId;
        if (!seen.has(key)) {
          seen.add(key);
          const g = el("td", { colspan: "3" });
          if (it.stock) g.append(el("span", { class: "jc-jno", text: "STOCK" }));
          else {
            if (it.jobNumber) g.append(el("span", { class: "jc-jno", text: it.jobNumber }));
            g.append(document.createTextNode(it.jobName || ""));
          }
          tb.append(el("tr", { class: "po-group" }, g));
        }
        const hardware = el("span", { text: it.description || "" });
        const monthTag = it.stock && it.month && window.Periods && window.Periods.validPeriod(it.month)
          ? el("span", { class: "so-month", text: " " + window.Periods.longLabel(it.month) })
          : null;
        tb.append(el(
          "tr",
          { class: "po-line" },
          cell("Hardware", "jc-sup", hardware, monthTag),
          cell("Qty", "jc-num" + (it.quantity == null ? " jc-blank" : ""), document.createTextNode(window.OrderUI.fmtQty(it.quantity))),
          stateCell(it)
        ));
      }
      body = el(
        "div",
        { class: "jc-pwrap" },
        el(
          "table",
          { class: "hs-table jc-table po-items" },
          el("thead", {}, el("tr", {},
            el("th", { scope: "col" }, "Hardware"),
            el("th", { scope: "col", class: "jc-num" }, "Qty"),
            el("th", { scope: "col" }, "Now"))),
          tb
        )
      );
    }
    panelEl.replaceChildren(head, body);
    panelEl.setAttribute("aria-labelledby", "poPTitle");
    panelEl.hidden = false;
  }

  function setUrl(id) {
    try {
      history.replaceState(null, "", id ? "/orders.html?po=" + encodeURIComponent(id) : "/orders.html");
    } catch (e) {
      /* the address bar is a nicety */
    }
  }

  function closeOrder() {
    const was = openId;
    openId = null;
    openSeq++;
    panelEl.hidden = true;
    panelEl.replaceChildren();
    setUrl(null);
    renderList();
    const b = was && rowsEl.querySelector('button[data-po="' + was + '"]');
    if (b) b.focus();
  }

  async function openOrder(id, switchTab) {
    id = Number(id);
    if (!Number.isInteger(id) || id < 1) return;
    if (switchTab && P.currentView() !== "pos") P.showView("pos");
    const mine = ++openSeq;
    openId = id;
    setMessage("", "");
    panelEl.replaceChildren(el("p", { class: "jc-pnote", text: "Loading..." }));
    panelEl.hidden = false;
    renderList();
    let o;
    try {
      o = await api("/api/supplier-orders/" + encodeURIComponent(id));
    } catch (e) {
      if (mine !== openSeq) return;
      openId = null;
      panelEl.hidden = true;
      panelEl.replaceChildren();
      setMessage(fail(e), "err");
      renderList();
      return;
    }
    if (mine !== openSeq) return;
    setUrl(id);
    renderList();
    renderPanel(o);
    panelEl.scrollIntoView({ block: "start" });
    const h = $("poPTitle");
    if (h) h.focus({ preventScroll: true });
  }

  // ----------------------------------------------------------------- events ---

  rowsEl.addEventListener("click", (e) => {
    const row = e.target.closest && e.target.closest("tr[data-po]");
    if (!row) return;
    const id = Number(row.getAttribute("data-po"));
    if (id === openId) closeOrder();
    else openOrder(id, false);
  });

  panelEl.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("button[data-po-close]")) closeOrder();
  });

  let timer = null;
  findEl.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(load, 200);
  });
  supEl.addEventListener("change", load);

  P.onShow("pos", load);
  window.SupplierOrders = { open: (id) => openOrder(id, true), load };

  // ------------------------------------------------------------------ start ---

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    if (!can("orders.view")) {
      $("tabPos").hidden = true;
      return;
    }
    const po = Number(new URLSearchParams(location.search).get("po"));
    if (Number.isInteger(po) && po > 0) {
      P.showView("pos");
      openOrder(po, false);
    }
  })();
})();
