// The Stock section on the Orders page (/orders.html, Job cards tab), 0.2.27
// (docs/plans/stock-orders-plan.md and stock-orders-contracts.md). One stock order per calendar month,
// with no job attached: three month cards (last, this, next), the middle month open underneath with
// its items in blocks by supplier, an Add item row, and an Order button per supplier that opens
// New supplier order with that month's stock items ticked (supplierorder.js). Talks to
// /api/stock-lines (routes/stocklines.js). The server decides who may do what; this page only
// hides what a user can't use. Every value is set as text. Classes are sk-.
(function () {
  "use strict";
  const P = window.OrdersPage;
  const J = window.JobCards;
  const Per = window.Periods;
  if (!P || !J || !J.ui || !Per) return;
  const { el, can } = P;
  const { typeahead, modal, field } = J.ui;
  const $ = (id) => document.getElementById(id);
  const QTY_SENTENCE = "Quantity must be a number above 0 and up to 99999, with at most 2 decimals";

  const section = $("skSection");
  const prevBtn = $("skPrev");
  const nowBtn = $("skNow");
  const nextBtn = $("skNext");
  const printBtn = $("skPrint");
  const msgEl = $("skMessage");
  const countEl = $("skCount");
  const cardsEl = $("skCards");
  const openEl = $("skOpen");
  const titleEl = $("skOpenTitle");
  const tagEl = $("skTag");
  const groupsEl = $("skGroups");
  const addForm = $("skAddForm");
  const addSup = $("skAddSupplier");
  const addItem = $("skAddItem");
  const addQty = $("skAddQty");
  const addBtn = $("skAddBtn");
  const addErr = $("skAddError");

  let info = null; // {current, first, last, months}
  let month = ""; // the month open now
  let lines = null; // null while the open month loads
  let loadError = "";
  let monthsSeq = 0;
  let linesSeq = 0;
  let picked = null; // the stock list item chosen in the Add item row: {id, supplier, item, code}
  let adding = false;
  let stockItems = null; // GET /api/stock-lines/items, loaded when first needed
  let stockItemsLoading = null;

  const longLabel = (m) => Per.longLabel(m);

  function setMessage(text, kind) {
    msgEl.textContent = text || "";
    msgEl.className = "or-message " + (kind || "");
  }

  function fail(e) {
    return e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message;
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  const qtyText = (q) => window.OrderUI.fmtQty(q);

  // "6 Oct" from a YYYY-MM-DD day.
  function shortDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return "";
    return Number(m[3]) + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1];
  }

  // "25 Nov, 11:14 am" (Sydney) from a UTC stamp: when an item was added.
  function addedAt(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(t));
  }

  // The Sydney calendar month, for when the months call has not answered.
  function sydneyMonth() {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit" }).format(new Date());
    return /^\d{4}-\d{2}/.test(p) ? p.slice(0, 7) : new Date().toISOString().slice(0, 7);
  }

  function range() {
    if (info) return info;
    const cur = sydneyMonth();
    return { current: cur, first: cur, last: Per.addMonths(cur, 1), months: [] };
  }

  // Anyone here can add (orders.view). Ordering and admin change any item; the person who added one by hand
  // changes or deletes it while it is still to order. The server enforces the same.
  const canEdit = (l) => canMark() || (l.source === "hand" && l.status === "to_order" && !!l.createdBy && l.createdBy.id === myId());
  const canMark = () => can("orders.mark_ordered");
  const myId = () => (window.cc && window.cc.me ? window.cc.me.id : null);

  // ------------------------------------------------------------------ data ---

  async function loadMonths() {
    const mine = ++monthsSeq;
    let r;
    try {
      r = await api("/api/stock-lines/months");
    } catch (e) {
      if (mine !== monthsSeq) return false;
      setMessage(fail(e), "err");
      renderAll();
      return false;
    }
    if (mine !== monthsSeq) return null;
    if (r && Per.validPeriod(r.current) && Per.validPeriod(r.first) && Per.validPeriod(r.last)) info = r;
    renderAll();
    return true;
  }

  // blank: show "Loading" at once (a month change), so the old month's items are never shown under
  // the new month's name. A reload after an edit keeps what is there until the new list arrives.
  async function loadLines(blank) {
    const mine = ++linesSeq;
    const m = month;
    if (blank) {
      lines = null;
      loadError = "";
      renderOpen();
    }
    let r;
    try {
      r = await api("/api/stock-lines?month=" + encodeURIComponent(m));
    } catch (e) {
      if (mine !== linesSeq || m !== month) return false;
      lines = null;
      loadError = fail(e);
      renderOpen();
      return false;
    }
    if (mine !== linesSeq || m !== month || !r || r.month !== m) return null; // a newer month or request won
    lines = Array.isArray(r.lines) ? r.lines : [];
    loadError = "";
    renderAll();
    return true;
  }

  function reload() {
    return Promise.all([loadMonths(), loadLines(false)]);
  }

  async function loadStockItems() {
    if (stockItems) return stockItems;
    if (!stockItemsLoading) {
      stockItemsLoading = api("/api/stock-lines/items")
        .then((r) => {
          stockItems = Array.isArray(r) ? r : [];
          return stockItems;
        })
        .finally(() => {
          stockItemsLoading = null;
        });
    }
    return stockItemsLoading;
  }

  // ---------------------------------------------------------------- counts ---

  function countsFor(m) {
    if (m === month && Array.isArray(lines)) {
      const f = (s) => lines.filter((l) => l.status === s).length;
      return { toOrder: f("to_order"), ordered: f("ordered"), received: f("received") };
    }
    const hit = ((info && info.months) || []).find((x) => x.month === m);
    return hit ? { toOrder: hit.toOrder || 0, ordered: hit.ordered || 0, received: hit.received || 0 } : { toOrder: 0, ordered: 0, received: 0 };
  }

  // ------------------------------------------------------------- the cards ---

  function renderCards() {
    const r = range();
    const cards = [Per.addMonths(month, -1), month, Per.addMonths(month, 1)].map((p) => {
      const inRange = Per.compare(p, r.first) >= 0 && Per.compare(p, r.last) <= 0;
      const here = p === month;
      const k = countsFor(p);
      const head = el("div", { class: "sk-h" }, el("h3", { text: longLabel(p) }));
      if (p === r.current) head.append(el("span", { class: "sk-tag", text: "This month" }));
      const counts = el(
        "div",
        { class: "jc-counts" },
        el("span", { class: k.toOrder ? "jc-att" : "" }, el("b", { text: String(k.toOrder) }), document.createTextNode("to order")),
        el("span", {}, el("b", { text: String(k.ordered) }), document.createTextNode("ordered")),
        el("span", {}, el("b", { text: String(k.received) }), document.createTextNode("received"))
      );
      const b = el("button", {
        type: "button",
        class: "jc-card" + (here ? " sk-cur" : ""),
        "data-month": p,
        "data-pos": here ? "mid" : p < month ? "prev" : "next",
        "aria-current": here ? "true" : false,
        "aria-label": longLabel(p) + (here ? ", open" : "") + ": " + k.toOrder + " to order, " + k.ordered + " ordered, " + k.received + " received",
        disabled: !inRange,
      }, head, counts);
      return b;
    });
    cardsEl.replaceChildren(...cards);
    prevBtn.disabled = Per.compare(month, r.first) <= 0;
    nextBtn.disabled = Per.compare(month, r.last) >= 0;
    nowBtn.disabled = month === r.current;
  }

  // -------------------------------------------------------------- the month ---

  function actionable(l) {
    if (l.status === "to_order") return canEdit(l);
    if (l.status === "ordered") return canMark();
    return false;
  }

  const STATUS = {
    to_order: ["To order", "hs-badge-check"],
    ordered: ["Ordered", "hs-badge-teal"],
    received: ["Received", "hs-badge-go"],
  };

  function statusBadge(l) {
    if (l.status === "ordered" && l.overdue) return el("span", { class: "hs-badge hs-badge-stop", text: "Overdue" });
    const [label, cls] = STATUS[l.status] || [l.status, "hs-badge-na"];
    return el("span", { class: "hs-badge " + cls, text: label });
  }

  function poLink(l) {
    if (!l.supplierOrderId || !l.poNumber) return null;
    const a = el("a", { class: "po-link", href: "/orders.html?po=" + encodeURIComponent(l.supplierOrderId), text: l.poNumber });
    a.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button || !window.SupplierOrders) return;
      e.preventDefault();
      P.showView("pos");
      window.SupplierOrders.open(l.supplierOrderId);
    });
    return a;
  }

  function lineRow(l) {
    const name = actionable(l)
      ? el("button", { type: "button", class: "sk-item", "data-act": "edit", "data-id": String(l.id), "aria-label": "Edit " + l.item + ", " + qtyText(l.quantity), text: l.item })
      : el("span", { class: "sk-item-plain", text: l.item });
    const sub = el("div", { class: "sk-sub" });
    if (l.code) sub.append(el("span", { text: l.code }));
    if (l.source === "count") sub.append(el("span", { class: "sk-src", text: "Count" }));
    const by = [l.createdBy && l.createdBy.name, addedAt(l.createdAt)].filter(Boolean).join(", ");
    if (by) sub.append(el("span", { text: (l.source === "count" ? "by " : "Added by ") + by }));
    const po = poLink(l);
    if (po) sub.append(po);
    if (l.notes) sub.append(el("span", { class: "sk-note", text: l.notes }));
    const itemTd = el("td", { class: "sk-i" }, name);
    if (sub.childNodes.length) itemTd.append(sub);
    return el(
      "tr",
      { class: "sk-line sk-" + l.status },
      itemTd,
      el("td", { class: "n", text: qtyText(l.quantity) }),
      el("td", { class: "d", text: shortDate(l.orderedDate) || "–" }),
      el("td", { class: "s" }, statusBadge(l))
    );
  }

  function groupBlocks(list) {
    const by = new Map();
    for (const l of list) {
      const key = (l.supplier || "").trim().toLowerCase();
      if (!by.has(key)) by.set(key, { name: (l.supplier || "").trim() || "No supplier", lines: [] });
      by.get(key).lines.push(l);
    }
    return [...by.values()];
  }

  function renderOpen() {
    titleEl.textContent = longLabel(month);
    tagEl.textContent = month === range().current ? "This month" : "";
    openEl.hidden = false;
    const r = range();
    const canAdd = Per.compare(month, r.current) >= 0 && Per.compare(month, Per.addMonths(r.current, 1)) <= 0;
    addForm.hidden = !canAdd;
    addForm.setAttribute("aria-label", "Add an item to the " + longLabel(month) + " stock order");
    printBtn.disabled = false;
    if (loadError) {
      countEl.textContent = "";
      groupsEl.replaceChildren(el("p", { class: "sk-none sk-err", text: loadError }));
      return;
    }
    if (lines === null) {
      countEl.textContent = "Loading...";
      groupsEl.replaceChildren(el("p", { class: "sk-none", text: "Loading..." }));
      return;
    }
    const f = (s) => lines.filter((l) => l.status === s).length;
    countEl.textContent = lines.length
      ? longLabel(month) + ": " + plural(lines.length, "item", "items") + ", " + f("to_order") + " to order, " + f("ordered") + " ordered, " + f("received") + " received"
      : longLabel(month) + ": nothing on the stock order yet";
    if (!lines.length) {
      groupsEl.replaceChildren(el("p", { class: "sk-none", text: "Nothing on the stock order for this month yet." }));
      return;
    }
    const blocks = groupBlocks(lines).map((g) => {
      const head = el("div", {}, el("span", { class: "sk-sup", text: g.name }));
      const waiting = g.lines.filter((l) => l.status === "to_order");
      if (waiting.length && canMark()) {
        head.append(el("button", {
          type: "button",
          class: "hs-btn hs-btn-primary",
          "data-act": "order",
          "data-supplier": g.name,
          "data-ids": waiting.map((l) => l.id).join(","),
          "aria-label": "Order from " + g.name + ": " + plural(waiting.length, "item", "items"),
          text: "Order",
        }));
      }
      return el(
        "div",
        { class: "sk-grp" },
        el("table", { class: "sk-t", "aria-label": g.name + ", " + longLabel(month) }, el("tbody", {}, el("tr", { class: "g" }, el("td", { colspan: "4" }, head)), ...g.lines.map(lineRow)))
      );
    });
    groupsEl.replaceChildren(el("div", { class: "sk-groups" }, ...blocks));
  }

  function renderAll() {
    renderCards();
    renderOpen();
  }

  // ------------------------------------------------------------- navigation ---

  function setUrl() {
    try {
      const q = new URLSearchParams(location.search);
      if (month && month !== range().current) q.set("stock", month);
      else q.delete("stock");
      const s = q.toString();
      history.replaceState(null, "", location.pathname + (s ? "?" + s : ""));
    } catch (e) {
      /* the address bar is a nicety */
    }
  }

  // Open another month. Everything for the old month is dropped first so no stale items show.
  function go(m, focus) {
    if (!Per.validPeriod(m)) return;
    const r = range();
    if (Per.compare(m, r.first) < 0 || Per.compare(m, r.last) > 0) return;
    month = m;
    setUrl();
    setMessage("", "");
    addErr.textContent = "";
    renderCards();
    loadLines(true);
    if (focus) {
      const t = focus === "mid" ? cardsEl.querySelector('[data-pos="mid"]') : $(focus);
      if (t && !t.disabled) t.focus();
      else cardsEl.querySelector('[data-pos="mid"]').focus();
    }
  }

  cardsEl.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-month]");
    if (!b || b.disabled) return;
    if (b.getAttribute("data-pos") === "mid") return;
    go(b.getAttribute("data-month"), "mid");
  });
  prevBtn.addEventListener("click", () => go(Per.addMonths(month, -1), "skPrev"));
  nextBtn.addEventListener("click", () => go(Per.addMonths(month, 1), "skNext"));
  nowBtn.addEventListener("click", () => go(range().current, "skNow"));
  printBtn.addEventListener("click", () => {
    window.open("/orderprint.html?mode=stock&month=" + encodeURIComponent(month), "_blank");
  });

  // ------------------------------------------------------- supplier / item lookups ---

  // Supplier names: the stock list's, order lines' and Supplier accounts' (/api/orders/suppliers).
  async function supplierLoad(text) {
    const [fromOrders, items] = await Promise.all([
      api("/api/orders/suppliers?q=" + encodeURIComponent(text)).catch(() => []),
      loadStockItems().catch(() => []),
    ]);
    const seen = new Map();
    const t = text.toLowerCase();
    for (const s of [...items.map((i) => i.supplier), ...(Array.isArray(fromOrders) ? fromOrders : [])]) {
      const name = typeof s === "string" ? s.trim() : "";
      if (name && name.toLowerCase().includes(t) && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).slice(0, 12);
  }

  // Stock list items matching the typed words, this supplier's first when one is typed.
  async function itemLoad(text, supplierInput) {
    const items = await loadStockItems();
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const sup = supplierInput.value.trim().toLowerCase();
    const hits = items.filter((i) => {
      const hay = (i.item + " " + (i.code || "") + " " + i.supplier).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    hits.sort((a, b) => (b.supplier.toLowerCase() === sup) - (a.supplier.toLowerCase() === sup) || a.item.localeCompare(b.item, undefined, { sensitivity: "base" }));
    return hits.slice(0, 10);
  }

  function renderItem(li, i) {
    li.append(el("span", { class: "jc-sname", text: i.item }));
    if (i.code) li.append(el("span", { class: "jc-sclient", text: i.code }));
    li.append(el("span", { class: "jc-has", text: i.supplier }));
  }

  // Wire a supplier + item pair of inputs (the Add item row, or the edit dialog's supplier).
  function wireSupplier(input, after) {
    return typeahead(input, {
      openOnFocus: true,
      load: supplierLoad,
      render: (li, name) => (li.textContent = name),
      pick: (name) => {
        input.value = name;
        if (after) after();
      },
    });
  }

  wireSupplier(addSup, () => {
    if (picked && picked.supplier.toLowerCase() !== addSup.value.trim().toLowerCase()) picked = null;
    addItem.focus();
  });
  typeahead(addItem, {
    openOnFocus: true,
    load: (text) => itemLoad(text, addSup),
    render: renderItem,
    pick: (i) => {
      picked = i;
      addSup.value = i.supplier;
      addItem.value = i.item;
      addQty.focus();
    },
  });
  addItem.addEventListener("input", () => {
    if (picked && picked.item !== addItem.value.trim()) picked = null;
  });
  addSup.addEventListener("input", () => {
    if (picked && picked.supplier.toLowerCase() !== addSup.value.trim().toLowerCase()) picked = null;
  });

  // ------------------------------------------------------------- add item ---

  function setAddBusy(on) {
    adding = on;
    for (const n of [addSup, addItem, addQty, addBtn]) n.disabled = on;
  }

  function addBad(msg, input) {
    addErr.textContent = msg;
    if (input) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
    }
  }

  addForm.addEventListener("input", () => {
    addErr.textContent = "";
    for (const i of [addSup, addItem, addQty]) i.removeAttribute("aria-invalid");
  });

  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (adding) return;
    addErr.textContent = "";
    const supplier = addSup.value.trim();
    const item = addItem.value.trim();
    const q = addQty.value.trim();
    if (!supplier) return addBad("Type the supplier", addSup);
    if (!item) return addBad("Type the item", addItem);
    if (!q) return addBad("Type the quantity", addQty);
    if (!(/^\d+(\.\d{1,2})?$/.test(q) && Number(q) > 0 && Number(q) <= 99999)) return addBad(QTY_SENTENCE, addQty);
    const m = month;
    const body = { month: m, supplier, item, quantity: Number(q) };
    if (picked && picked.supplier.toLowerCase() === supplier.toLowerCase() && picked.item === item) body.stockItemId = picked.id;
    setAddBusy(true);
    try {
      await api("/api/stock-lines", { method: "POST", body: JSON.stringify(body) });
    } catch (ex) {
      setAddBusy(false);
      addErr.textContent = fail(ex);
      addItem.focus();
      return;
    }
    setAddBusy(false);
    addItem.value = "";
    addQty.value = "";
    picked = null;
    setMessage(item + " added to the " + longLabel(m) + " stock order.", "ok");
    await reload();
    addItem.focus();
  });

  // ------------------------------------------------------------ edit / delete ---

  async function editLine(line, opener) {
    const toOrder = line.status === "to_order";
    const full = toOrder && canEdit(line);
    const r = await modal("Edit stock item", false, (dlg, form, ctl) => {
      const sup = el("input", { class: "hs-input", type: "text", maxlength: "200", autocomplete: "off" });
      const item = el("input", { class: "hs-input", type: "text", maxlength: "500", autocomplete: "off" });
      const qty = el("input", { class: "hs-input", type: "text", inputmode: "decimal", maxlength: "9", autocomplete: "off" });
      const notes = el("textarea", { class: "hs-input", maxlength: "2000", rows: "3" });
      sup.value = line.supplier;
      item.value = line.item;
      qty.value = qtyText(line.quantity);
      notes.value = line.notes || "";
      for (const n of [sup, item, qty]) n.disabled = !full;
      notes.disabled = !canEdit(line);
      const err = el("p", { class: "cc-dialog-error", role: "alert" });
      const cancel = el("button", { type: "button", class: "hs-btn", text: "Close" });
      const actions = el("div", { class: "cc-dialog-actions" }, cancel);
      const del = toOrder && canEdit(line) ? el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Delete" }) : null;
      const undo = line.status === "ordered" && canMark() ? el("button", { type: "button", class: "hs-btn", text: "Undo ordered" }) : null;
      const save = canEdit(line) ? el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: "Save" }) : null;
      for (const b of [del, undo, save]) if (b) actions.append(b);
      const note = !full
        ? line.status === "ordered"
          ? "Ordered: only the notes can change here. Undo ordered puts it back to To order."
          : "Only the notes can change."
        : line.source === "count"
          ? "This quantity came from a stock count. The next count replaces it until the item is ordered."
          : "";
      form.append(
        field("Supplier", sup),
        field("Item", item),
        field("Quantity", qty, "sk-qtyfield"),
        field("Notes", notes),
        note ? el("p", { class: "cc-dialog-note", text: note }) : null,
        err,
        actions
      );
      wireSupplier(sup, () => item.focus());
      cancel.addEventListener("click", () => dlg.close());
      if (del) del.addEventListener("click", () => ctl.finish({ del: true }));
      if (undo) undo.addEventListener("click", () => ctl.finish({ undo: true }));
      let sending = false;
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (sending || !save) return;
        err.textContent = "";
        const patch = {};
        if (full) {
          const s = sup.value.trim();
          const i = item.value.trim();
          const q = qty.value.trim();
          if (!s) return (err.textContent = "Type the supplier"), sup.focus();
          if (!i) return (err.textContent = "Type the item"), item.focus();
          if (!(/^\d+(\.\d{1,2})?$/.test(q) && Number(q) > 0 && Number(q) <= 99999)) return (err.textContent = QTY_SENTENCE), qty.focus();
          if (s !== line.supplier) patch.supplier = s;
          if (i !== line.item) patch.item = i;
          if (Number(q) !== Number(line.quantity)) patch.quantity = Number(q);
        }
        const n = notes.value.trim();
        if (n !== (line.notes || "")) patch.notes = n;
        if (!Object.keys(patch).length) return ctl.finish(null);
        sending = true;
        ctl.busy(true);
        for (const x of form.querySelectorAll("button, input, textarea")) x.disabled = true;
        try {
          await api("/api/stock-lines/" + encodeURIComponent(line.id), { method: "PATCH", body: JSON.stringify(patch) });
        } catch (ex) {
          sending = false;
          ctl.busy(false);
          for (const x of form.querySelectorAll("button, input, textarea")) x.disabled = false;
          for (const x of [sup, item, qty]) x.disabled = !full;
          notes.disabled = !canEdit(line);
          err.textContent = fail(ex);
          return;
        }
        ctl.finish({ saved: true });
      });
      setTimeout(() => (full ? item : notes).focus(), 0);
    });
    if (!r) return;
    if (r.saved) {
      setMessage("Saved: " + line.item + ".", "ok");
      await reload();
    } else if (r.del) {
      await deleteLine(line);
    } else if (r.undo) {
      await undoLine(line);
    }
    const again = groupsEl.querySelector('button[data-act="edit"][data-id="' + line.id + '"]');
    if (again) again.focus();
    else if (opener && opener.isConnected) opener.focus();
  }

  async function deleteLine(line) {
    const yes = await P.confirmDialog("Delete " + line.item + "?", "It comes off the " + longLabel(line.month || month) + " stock order. The audit log keeps a record.", "Delete", "Keep it");
    if (!yes) return;
    try {
      await api("/api/stock-lines/" + encodeURIComponent(line.id), { method: "DELETE" });
    } catch (e) {
      setMessage(fail(e), "err");
      await reload();
      return;
    }
    setMessage("Deleted: " + line.item + ".", "ok");
    await reload();
  }

  async function undoLine(line) {
    const yes = await P.confirmDialog("Undo ordered for " + line.item + "?", "It goes back to To order and comes off its purchase order's live status. The saved PO itself is not changed.", "Undo ordered", "Keep it ordered");
    if (!yes) return;
    try {
      await api("/api/stock-lines/" + encodeURIComponent(line.id), { method: "PATCH", body: JSON.stringify({ status: "to_order" }) });
    } catch (e) {
      setMessage(fail(e), "err");
      await reload();
      return;
    }
    setMessage(line.item + " is back to To order.", "ok");
    await reload();
  }

  // ------------------------------------------------------------ the open month ---

  groupsEl.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-act]");
    if (!b) return;
    const act = b.getAttribute("data-act");
    if (act === "edit") {
      const line = (lines || []).find((l) => l.id === Number(b.getAttribute("data-id")));
      if (line) editLine(line, b);
    } else if (act === "order") {
      if (!window.SupplierOrder || typeof window.SupplierOrder.open !== "function") {
        setMessage("New supplier order isn't available. Reload the page.", "err");
        return;
      }
      const ids = b.getAttribute("data-ids").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
      window.SupplierOrder.open({ supplier: b.getAttribute("data-supplier"), stockLineIds: ids });
    }
  });

  window.StockOrders = { reload, setMessage };
  P.onShow("cards", reload);

  // ------------------------------------------------------------------ start ---

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    if (!can("orders.view")) return;
    section.hidden = false;
    const want = new URLSearchParams(location.search).get("stock");
    month = range().current;
    renderAll();
    await loadMonths();
    const r = range();
    month = want && Per.validPeriod(want) && Per.compare(want, r.first) >= 0 && Per.compare(want, r.last) <= 0 ? want : r.current;
    if (want && month !== want) setUrl();
    renderAll();
    loadLines(true);
  })();
})();
