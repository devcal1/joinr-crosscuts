// Paint orders (/paint.html; docs/plans/m11-contracts.md sections 6.3 and 11.6). Talks to
// /api/paint (routes/paint.js); every rule lives in lib/paint.js, and the page only hides what a
// user can't use (cc.can()).
//
//   /paint.html            stock.order: the tabs Orders, Paint list and Settings (kept in the hash)
//   /paint.html?id=N       one paint order: a draft is edited here (stock.order); an ordered one is
//                          received here too (orders.receive), and a receiver without stock.order
//                          sees it read-only with Received
//   /paint.html?id=new     a new draft (stock.order), saved on Save
//
// A line with a job becomes an order line on that job (Decision 6), so Mark ordered may need
// orders.mark_ordered as well (the server says 403 otherwise; the button is hidden). The dialogs
// are built on OrderUI's frame (orderui.js). Every value goes in as text. Page classes are pt-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const KINDS = [
    ["colour", "Colours", "Colour"], ["hardener", "Hardeners", "Hardener"], ["thinners", "Thinners", "Thinners"],
    ["primer", "Primers", "Primer"], ["abrasive", "Abrasives", "Abrasive"], ["other", "Other", "Other"],
  ];
  const KIND_ONE = Object.fromEntries(KINDS.map((k) => [k[0], k[2]]));
  const STATUS = {
    draft: ["Draft", "hs-badge-check"],
    ordered: ["Ordered", "hs-badge-teal"],
    received: ["Received", "hs-badge-go"],
    cancelled: ["Cancelled", "hs-badge-na"],
  };
  const QTY_MAX = 9999;
  const TEXT_MAX = 200;
  const NOTES_MAX = 2000;

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

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

  function ui() {
    return window.OrderUI.ui;
  }

  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  // A UTC timestamp as its Sydney date.
  function fmtStamp(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    return fmtDate(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(t)));
  }

  // 4 -> "4", 2.5 -> "2.5"
  function fmtQty(q) {
    return String(Math.round(Number(q) * 100) / 100);
  }

  // kg x factor, rounded to 0.01, as lib/paint.js works it out.
  function litresOf(qty, f) {
    return Math.round(qty * f * 100 + 1e-7) / 100;
  }

  function fmtLitres(l) {
    return l.toFixed(2) + " L";
  }

  function setStatus(text, kind) {
    const s = $("ptStatus");
    s.textContent = text || "";
    s.className = "pt-status" + (kind ? " pt-status-" + kind : "");
  }

  function failText(e) {
    return e instanceof TypeError ? "Couldn't reach the server. Try again." : (e && e.message) || "That didn't work. Try again.";
  }

  function focusNode(n) {
    if (!n) return false;
    n.focus();
    return document.activeElement === n;
  }

  function jobLink(jobId, name) {
    if (!can("jobs.view") || jobId == null) return el("span", { class: "pt-jobname", text: name || "" });
    return el("a", { href: "/job.html?id=" + encodeURIComponent(jobId) + "#orders", text: name || "" });
  }

  function badge(status) {
    const [label, cls] = STATUS[status] || [status, "hs-badge-na"];
    return el("span", { class: "hs-badge " + cls, text: label });
  }

  // A yes/no question on OrderUI's frame. Resolves true when confirmed.
  function confirmBox(title, note, yes, keep, danger) {
    return ui().dialog({
      title, note, submit: yes, cancel: keep, submitClass: danger ? "hs-btn-stop" : "hs-btn-primary", focus: "cancel",
      run: () => Promise.resolve(true),
    }).then((r) => r === true);
  }

  // ======================================================================= tabs ===

  const TABS = [
    { id: "orders", tab: "ptTabOrders", panel: "ptPanelOrders" },
    { id: "list", tab: "ptTabList", panel: "ptPanelList" },
    { id: "settings", tab: "ptTabSettings", panel: "ptPanelSettings" },
  ];
  let tab = null;
  const loaded = { orders: false, list: false, settings: false };

  function tabFromHash() {
    const h = location.hash.replace(/^#/, "");
    return TABS.some((t) => t.id === h) ? h : "orders";
  }

  function setTab(id, focus) {
    tab = id;
    for (const t of TABS) {
      const on = t.id === id;
      $(t.tab).setAttribute("aria-selected", on ? "true" : "false");
      $(t.tab).tabIndex = on ? 0 : -1;
      $(t.panel).hidden = !on;
    }
    const want = id === "orders" ? "" : "#" + id;
    if (location.hash !== want) history.replaceState(null, "", location.pathname + location.search + want);
    if (focus) $(TABS.find((t) => t.id === id).tab).focus();
    if (id === "orders" && !loaded.orders) loadOrders();
    if (id === "list" && !loaded.list) loadItemList();
    if (id === "settings" && !loaded.settings) loadSettings();
  }

  function startTabs() {
    $("ptIntro").hidden = false;
    $("ptTabs").hidden = false;
    setStatus("", "");
    for (const t of TABS) $(t.tab).addEventListener("click", () => setTab(t.id));
    $("ptTabs").addEventListener("keydown", (e) => {
      const i = TABS.findIndex((t) => t.id === tab);
      let to = null;
      if (e.key === "ArrowRight") to = TABS[(i + 1) % TABS.length].id;
      else if (e.key === "ArrowLeft") to = TABS[(i + TABS.length - 1) % TABS.length].id;
      else if (e.key === "Home") to = TABS[0].id;
      else if (e.key === "End") to = TABS[TABS.length - 1].id;
      if (to) {
        e.preventDefault();
        setTab(to, true);
      }
    });
    window.addEventListener("hashchange", () => setTab(tabFromHash()));
    $("ptFilter").addEventListener("change", loadOrders);
    $("ptAddForm").addEventListener("submit", addItem);
    $("ptSettingsForm").addEventListener("submit", saveSettings);
    $("ptItemRows").addEventListener("click", onItemClick);
    setTab(tabFromHash());
  }

  // --------------------------------------------------------------- orders tab ---

  let listSeq = 0;
  async function loadOrders() {
    const mine = ++listSeq;
    let r;
    try {
      r = await api("/api/paint/orders?status=" + encodeURIComponent($("ptFilter").value));
    } catch (e) {
      if (mine === listSeq) setStatus(failText(e), "err");
      return;
    }
    if (mine !== listSeq) return;
    loaded.orders = true;
    const orders = (r && r.orders) || [];
    $("ptListEmpty").hidden = orders.length > 0;
    $("ptListWrap").hidden = orders.length === 0;
    if (!orders.length) {
      $("ptListEmpty").textContent = $("ptFilter").value === "open" ? "No paint order is open. New paint order starts one." : "No paint orders match.";
    }
    $("ptListRows").replaceChildren(...orders.map((o) => {
      const date = o.orderedDate ? "Ordered " + fmtDate(o.orderedDate) : "Started " + fmtStamp(o.createdAt);
      // One child per cell, so the narrow card layout keeps it beside its label.
      const names = el("span");
      if (o.jobs && o.jobs.length) {
        o.jobs.forEach((j, i) => {
          if (i) names.append(document.createTextNode(", "));
          names.append(jobLink(j.jobId, j.jobName));
        });
      } else {
        names.append(el("span", { class: "pt-muted", text: "Workshop stock" }));
      }
      const jobs = el("td", { class: "pt-c-jobs", "data-label": "Jobs" }, names);
      return el("tr", null,
        el("td", { class: "pt-c-order", "data-label": "Order" }, el("a", { class: "pt-strong", href: "/paint.html?id=" + encodeURIComponent(o.id), text: "Paint order " + o.id })),
        el("td", { class: "pt-c-status", "data-label": "Status" }, el("span", null, badge(o.status))),
        el("td", { class: "pt-c-sup", "data-label": "Supplier", text: o.supplier }),
        el("td", { class: "pt-c-date", "data-label": "Date", text: date }),
        jobs,
        el("td", { class: "pt-c-num", "data-label": "Lines", text: String(o.lineCount) }));
    }));
  }

  // ----------------------------------------------------------- paint list tab ---

  let allItems = [];

  async function loadItemList() {
    try {
      const r = await api("/api/paint/items?all=1");
      allItems = (r && r.items) || [];
    } catch (e) {
      setStatus(failText(e), "err");
      return;
    }
    loaded.list = true;
    renderItemList();
  }

  // The whole list in its stored order (the reorder route needs every id).
  function bySort() {
    return allItems.slice().sort((a, b) => a.sort - b.sort || a.id - b.id);
  }

  function renderItemList() {
    const sorted = bySort();
    const shown = sorted.filter((i) => i.active).concat(sorted.filter((i) => !i.active));
    const active = sorted.filter((i) => i.active);
    $("ptItemsEmpty").hidden = shown.length > 0;
    $("ptItemsWrap").hidden = shown.length === 0;
    $("ptItemRows").replaceChildren(...shown.map((it) => {
      const at = active.indexOf(it);
      const acts = el("div", { class: "pt-acts" });
      if (it.active) {
        acts.append(el("button", { type: "button", class: "hs-btn", "data-act": "up", "data-id": String(it.id), text: "Up",
          "aria-label": "Move up: " + it.name, disabled: at <= 0 }));
        acts.append(el("button", { type: "button", class: "hs-btn", "data-act": "down", "data-id": String(it.id), text: "Down",
          "aria-label": "Move down: " + it.name, disabled: at === active.length - 1 }));
      }
      acts.append(el("button", { type: "button", class: "hs-btn", "data-act": "edit", "data-id": String(it.id), text: "Edit",
        "aria-label": "Edit: " + it.name }));
      const nameBox = el("span", null, el("span", { class: "pt-strong", text: it.name }));
      if (!it.active) nameBox.append(el("span", { class: "hs-badge hs-badge-na pt-inactive", text: "Not in use" }));
      const name = el("td", { class: "pt-c-name", "data-label": "Name" }, nameBox);
      return el("tr", { class: it.active ? "" : "pt-row-off" },
        name,
        el("td", { class: "pt-c-text" + (it.finish ? "" : " pt-blank"), "data-label": "Finish", text: it.finish }),
        el("td", { class: "pt-c-text" + (it.manufacturer ? "" : " pt-blank"), "data-label": "Manufacturer", text: it.manufacturer }),
        el("td", { class: "pt-c-kind", "data-label": "Kind", text: KIND_ONE[it.kind] || it.kind }),
        el("td", { class: "pt-c-unit", "data-label": "Unit", text: it.unit }),
        el("td", { class: "pt-c-acts" }, acts));
    }));
  }

  function itemButton(id, act) {
    for (const b of $("ptItemRows").querySelectorAll("button[data-act]")) {
      if (b.getAttribute("data-act") === act && b.getAttribute("data-id") === String(id)) return b;
    }
    return null;
  }

  let itemBusy = false;
  async function onItemClick(e) {
    const b = e.target.closest && e.target.closest("button[data-act]");
    if (!b || b.disabled || itemBusy) return;
    const id = Number(b.getAttribute("data-id"));
    const it = allItems.find((i) => i.id === id);
    if (!it) return;
    const act = b.getAttribute("data-act");
    if (act === "edit") return editItem(it);
    // Up or down: swap with the neighbouring item in use, then send the whole list.
    const sorted = bySort();
    const active = sorted.filter((i) => i.active);
    const at = active.indexOf(it);
    const other = active[act === "up" ? at - 1 : at + 1];
    if (!other) return;
    const ids = sorted.map((i) => i.id);
    const a = ids.indexOf(it.id);
    const o = ids.indexOf(other.id);
    ids[a] = other.id;
    ids[o] = it.id;
    itemBusy = true;
    try {
      const r = await api("/api/paint/items/reorder", { method: "POST", body: JSON.stringify({ ids }) });
      allItems = (r && r.items) || allItems;
      renderItemList();
      setStatus("Moved " + (act === "up" ? "up" : "down") + ": " + it.name + ".", "ok");
      if (!focusNode(itemButton(id, act)) || itemButton(id, act).disabled) focusNode(itemButton(id, act === "up" ? "down" : "up"));
    } catch (err) {
      setStatus(failText(err), "err");
      await loadItemList();
    } finally {
      itemBusy = false;
    }
  }

  function kindSelect(value) {
    const s = el("select", { class: "hs-input" }, ...KINDS.map((k) => el("option", { value: k[0], text: k[2] })));
    s.value = value;
    return s;
  }
  function unitSelect(value) {
    const s = el("select", { class: "hs-input" }, el("option", { value: "kg", text: "kg" }), el("option", { value: "each", text: "each" }));
    s.value = value;
    return s;
  }

  function editItem(it) {
    const U = ui();
    const name = U.textInput(it.name, TEXT_MAX);
    const finish = U.textInput(it.finish, TEXT_MAX);
    const maker = U.textInput(it.manufacturer, TEXT_MAX);
    const kind = kindSelect(it.kind);
    const unit = unitSelect(it.unit);
    const active = el("input", { type: "checkbox", class: "pt-check" });
    active.checked = it.active;
    const activeBox = el("label", { class: "pt-checkline ou-wide" }, active, el("span", { text: "In use (shown when choosing an item on an order)" }));
    return U.dialog({
      title: "Edit paint item",
      note: it.name + ".",
      fields: [U.field("Name", name, { wide: true }), U.field("Finish", finish), U.field("Manufacturer", maker),
        U.field("Kind", kind), U.field("Unit", unit), activeBox],
      hint: "Orders already made keep the text they were made with.",
      wide: true,
      submit: "Save",
      focus: name,
      run: () => {
        const body = {};
        const n = name.value.trim();
        if (!n) throw new Error("Type the name");
        if (n !== it.name) body.name = n;
        if (finish.value.trim() !== it.finish) body.finish = finish.value.trim();
        if (maker.value.trim() !== it.manufacturer) body.manufacturer = maker.value.trim();
        if (kind.value !== it.kind) body.kind = kind.value;
        if (unit.value !== it.unit) body.unit = unit.value;
        if (active.checked !== it.active) body.active = active.checked;
        if (!Object.keys(body).length) return undefined;
        return U.sendVia((b) => api("/api/paint/items/" + encodeURIComponent(it.id), { method: "PATCH", body: JSON.stringify(b) }), body);
      },
    }).then(async (r) => {
      if (!r) return;
      await loadItemList();
      if (!r.refused) setStatus("Saved: " + (r.name || it.name) + ".", "ok");
      focusNode(itemButton(it.id, "edit"));
    });
  }

  async function addItem(e) {
    e.preventDefault();
    const msg = $("ptAddMsg");
    const name = $("ptAddName").value.trim();
    if (!name) {
      msg.textContent = "Type the name.";
      msg.className = "pt-msg pt-msg-err";
      $("ptAddName").focus();
      return;
    }
    const body = {
      name, finish: $("ptAddFinish").value.trim(), manufacturer: $("ptAddMaker").value.trim(),
      kind: $("ptAddKind").value, unit: $("ptAddUnit").value,
    };
    $("ptAddBtn").disabled = true;
    try {
      await api("/api/paint/items", { method: "POST", body: JSON.stringify(body) });
      msg.textContent = "Added: " + name + ".";
      msg.className = "pt-msg pt-msg-ok";
      $("ptAddName").value = "";
      $("ptAddFinish").value = "";
      $("ptAddMaker").value = "";
      await loadItemList();
      $("ptAddName").focus();
    } catch (err) {
      msg.textContent = failText(err);
      msg.className = "pt-msg pt-msg-err";
    } finally {
      $("ptAddBtn").disabled = false;
    }
  }

  // ------------------------------------------------------------- settings tab ---

  async function loadSettings() {
    try {
      const s = await api("/api/paint/settings");
      $("ptFactor").value = String(s.litresPerKg);
      loaded.settings = true;
    } catch (e) {
      setStatus(failText(e), "err");
    }
  }

  async function saveSettings(e) {
    e.preventDefault();
    const msg = $("ptFactorMsg");
    const v = Number($("ptFactor").value);
    if (!$("ptFactor").value.trim() || !Number.isFinite(v) || v < 0.1 || v > 5) {
      msg.textContent = "Type a number from 0.1 to 5.";
      msg.className = "pt-msg pt-msg-err";
      $("ptFactor").focus();
      return;
    }
    $("ptFactorSave").disabled = true;
    try {
      const s = await api("/api/paint/settings", { method: "PUT", body: JSON.stringify({ litresPerKg: v }) });
      $("ptFactor").value = String(s.litresPerKg);
      msg.textContent = "Saved: " + s.litresPerKg + " litres per kg.";
      msg.className = "pt-msg pt-msg-ok";
    } catch (err) {
      msg.textContent = failText(err);
      msg.className = "pt-msg pt-msg-err";
    } finally {
      $("ptFactorSave").disabled = false;
    }
  }

  // ================================================================== one order ===

  let order = null; // the saved order (lib/paint.js present() with lines), null while new
  let form = null; // the draft being edited: {supplier, expectedDate, notes, lines}
  let dirty = false;
  let busy = false;
  let items = []; // the active paint list, for the item select
  let factor = 0.85;
  let jobs = null; // live (not archived) jobs [{id, name, label}], or null when not loaded
  let lineSeq = 0;

  function editable() {
    return can("stock.order") && (!order || order.status === "draft");
  }

  function itemById(id) {
    return items.find((i) => i.id === id) || null;
  }

  // ---- loading ----

  async function loadItems() {
    try {
      const r = await api("/api/paint/items");
      items = (r && r.items) || [];
    } catch (e) {
      items = [];
    }
  }

  // Live jobs for the job box: the name, made unique with the job number when two share it.
  async function loadJobs() {
    if (!can("jobs.view")) return;
    try {
      const list = await api("/api/job-records?archived=0");
      const count = {};
      for (const j of list) count[j.name.toLowerCase()] = (count[j.name.toLowerCase()] || 0) + 1;
      jobs = list.map((j) => ({ id: j.id, name: j.name, label: count[j.name.toLowerCase()] > 1 ? `${j.name} (job ${j.id})` : j.name }));
    } catch (e) {
      jobs = null;
    }
  }

  async function loadSuppliers() {
    try {
      const r = await api("/api/paint/orders?status=all");
      const seen = new Map();
      for (const o of (r && r.orders) || []) {
        const k = (o.supplier || "").trim().toLowerCase();
        if (k && !seen.has(k)) seen.set(k, o.supplier.trim());
      }
      return [...seen.values()].sort((a, b) => a.localeCompare(b));
    } catch (e) {
      return [];
    }
  }

  // ---- the editable draft ----

  function blankLine() {
    return { key: ++lineSeq, paintItemId: null, other: false, name: "", finish: "", manufacturer: "", unit: "kg", qty: "", jobText: "", jobId: null, jobName: "" };
  }

  function formFrom(o) {
    return {
      supplier: o ? o.supplier : "",
      expectedDate: o ? o.expectedDate || "" : "",
      notes: o ? o.notes || "" : "",
      lines: o && o.lines && o.lines.length
        ? o.lines.map((l) => ({
          key: ++lineSeq,
          paintItemId: l.paintItemId,
          other: l.paintItemId == null,
          name: l.name, finish: l.finish, manufacturer: l.manufacturer, unit: l.unit,
          qty: fmtQty(l.qty),
          jobText: l.jobId == null ? "" : jobLabelFor(l.jobId, l.jobName),
          jobId: l.jobId, jobName: l.jobName || "",
        }))
        : [blankLine()],
    };
  }

  function jobLabelFor(id, name) {
    const j = jobs && jobs.find((x) => x.id === id);
    return j ? j.label : name || "";
  }

  // The job a line's box names: a live job by its label, or the line's saved job (which may since
  // have been archived: the server then refuses the save, and the line says why).
  function resolveJob(l) {
    const t = l.jobText.trim().toLowerCase();
    if (!t) return null;
    if (jobs) {
      const j = jobs.find((x) => x.label.toLowerCase() === t) || jobs.find((x) => x.name.toLowerCase() === t);
      if (j) return j.id;
    }
    if (l.jobId != null && (l.jobName || "").toLowerCase() === t) return l.jobId;
    return null;
  }

  function isLiveJob(id) {
    return !jobs || jobs.some((x) => x.id === id);
  }

  function lineUnit(l) {
    if (l.other) return l.unit;
    const it = l.paintItemId != null ? itemById(l.paintItemId) : null;
    return it ? it.unit : l.unit;
  }

  function markDirty() {
    dirty = true;
    const s = $("ptSave");
    if (s) s.classList.add("pt-unsaved");
    const n = $("ptDirty");
    if (n) n.hidden = false;
  }

  // Mark ordered (and Undo) come and go with whether any line has a job; draw the action box again
  // when that changes, so the button is right before the click rather than refused after it.
  function refreshActions() {
    const box = document.querySelector("#ptOrder .pt-actionbox");
    if (!box) return;
    const had = !!box.querySelector("#ptMark");
    const next = actionsBlock();
    if (!!next.querySelector("#ptMark") === had) return;
    box.replaceWith(next);
  }

  // ---- rendering ----

  function setHead(title, status) {
    $("ptTitle").textContent = title;
    document.title = title + " - Crosscuts";
    $("ptBadge").replaceChildren(status ? badge(status) : document.createTextNode(""));
  }

  function renderOrder() {
    const host = $("ptOrder");
    host.hidden = false;
    setHead(order ? "Paint order " + order.id : "New paint order", order ? order.status : "draft");
    const back = can("stock.order")
      ? el("a", { class: "hs-btn hs-btn-quiet", href: "/paint.html", text: "All paint orders" })
      : el("a", { class: "hs-btn hs-btn-quiet", href: "/deliveries.html", text: "Deliveries" });
    $("ptHeadActions").replaceChildren(back);
    const out = [];
    if (order) out.push(metaBlock());
    out.push(editable() ? editorBlock() : readBlock());
    if (order) out.push(jobsBlock());
    out.push(actionsBlock());
    host.replaceChildren(...out);
  }

  function metaBlock() {
    const bits = [];
    if (order.createdBy && order.createdBy.name) bits.push(`Started by ${order.createdBy.name}, ${fmtStamp(order.createdAt)}`);
    else bits.push(`Started ${fmtStamp(order.createdAt)}`);
    if (order.orderedDate) bits.push(`Ordered ${fmtDate(order.orderedDate)}${order.orderedBy && order.orderedBy.name ? " by " + order.orderedBy.name : ""}`);
    if (order.receivedDate) bits.push(`Received ${fmtDate(order.receivedDate)}${order.receivedBy && order.receivedBy.name ? " by " + order.receivedBy.name : ""}`);
    const box = el("div", { class: "pt-meta" }, el("p", { class: "pt-meta-line", text: bits.join(" · ") }));
    const note = window.OrderUI.noteBlock({ deliveryNote: order.deliveryNote || "", status: order.status });
    if (note) box.append(note);
    return box;
  }

  function fieldWrap(label, input, cls) {
    const id = input.id || "pt-f-" + Math.random().toString(36).slice(2, 8);
    input.id = id;
    return el("div", { class: "pt-field" + (cls ? " " + cls : "") }, el("label", { class: "hs-label", for: id, text: label }), input);
  }

  // The draft's form: supplier, expected date, notes, and the lines.
  function editorBlock() {
    const sup = el("input", { class: "hs-input", type: "text", maxlength: String(TEXT_MAX), autocomplete: "off", list: "ptSuppliers", id: "ptSupplier" });
    sup.value = form.supplier;
    sup.addEventListener("input", () => { form.supplier = sup.value; markDirty(); });
    const list = el("datalist", { id: "ptSuppliers" });
    loadSuppliers().then((names) => list.replaceChildren(...names.map((n) => el("option", { value: n }))));
    const exp = el("input", { class: "hs-input pt-date", type: "date", id: "ptExpected" });
    exp.value = form.expectedDate;
    exp.addEventListener("input", () => { form.expectedDate = exp.value; markDirty(); });
    const notes = el("textarea", { class: "hs-input pt-notes", maxlength: String(NOTES_MAX), rows: "2", id: "ptNotes" });
    notes.value = form.notes;
    notes.addEventListener("input", () => { form.notes = notes.value; markDirty(); });

    const fields = el("div", { class: "pt-fields pt-fields-order" },
      fieldWrap("Supplier", sup, "pt-f-sup"), fieldWrap("Expected", exp, "pt-f-exp"), fieldWrap("Notes", notes, "pt-f-notes"), list);

    const add = el("button", { type: "button", class: "hs-btn", id: "ptAddLine", text: "Add line" });
    add.addEventListener("click", () => {
      const l = blankLine();
      form.lines.push(l);
      markDirty();
      renderLines();
      focusNode(lineControl(l.key, "item"));
    });

    return el("div", { class: "pt-editor" },
      el("div", { class: "pt-card" }, fields),
      el("div", { class: "hs-sectionbar pt-bar" }, el("h2", { id: "ptLinesTitle", text: "Lines" }), add),
      el("div", { class: "pt-wrap pt-wrap-lines" },
        el("table", { class: "pt-table pt-table-edit", "aria-labelledby": "ptLinesTitle" },
          el("thead", null, el("tr", null,
            el("th", { scope: "col", class: "pt-c-n", text: "#" }),
            el("th", { scope: "col", class: "pt-c-item", text: "Item" }),
            el("th", { scope: "col", class: "pt-c-qty", text: "Qty" }),
            el("th", { scope: "col", class: "pt-c-litres", text: "Litres" }),
            el("th", { scope: "col", class: "pt-c-job", text: "Job (optional)" }),
            el("th", { scope: "col", class: "pt-c-rm" }, el("span", { class: "pt-sr", text: "Remove" })))),
          el("tbody", { id: "ptLineRows" }, ...form.lines.map(lineRow)))),
      el("p", { class: "pt-totals", id: "ptTotals", text: totalsText(form.lines.map((l) => ({ unit: lineUnit(l), qty: Number(l.qty) }))) }),
      el("datalist", { id: "ptJobs" }, ...(jobs || []).map((j) => el("option", { value: j.label }))));
  }

  function renderLines() {
    const body = $("ptLineRows");
    if (!body) return;
    body.replaceChildren(...form.lines.map(lineRow));
    updateTotals();
  }

  function lineControl(key, what) {
    return document.querySelector(`[data-line="${key}"][data-ctl="${what}"]`);
  }

  // The item select: the paint list grouped by kind, then "Other…" for a typed line. A saved line
  // whose item has since left the list keeps it as an option.
  function itemSelect(l, n) {
    const s = el("select", { class: "hs-input pt-item", "data-line": String(l.key), "data-ctl": "item", "aria-label": "Item, line " + n });
    s.append(el("option", { value: "", text: "Choose an item" }));
    for (const [kind, label] of KINDS) {
      const of = items.filter((i) => i.kind === kind);
      if (!of.length) continue;
      s.append(el("optgroup", { label }, ...of.map((i) => el("option", { value: String(i.id), text: itemText(i) }))));
    }
    if (l.paintItemId != null && !itemById(l.paintItemId)) {
      s.append(el("optgroup", { label: "No longer on the list" }, el("option", { value: String(l.paintItemId), text: itemText(l) })));
    }
    s.append(el("option", { value: "other", text: "Other… (type it)" }));
    s.value = l.other ? "other" : l.paintItemId != null ? String(l.paintItemId) : "";
    return s;
  }

  function itemText(i) {
    const extra = [i.finish, i.manufacturer].filter(Boolean).join(", ");
    return i.name + (extra ? ` (${extra})` : "") + (i.unit === "each" ? ", each" : "");
  }

  function lineRow(l) {
    const n = form.lines.indexOf(l) + 1;
    const key = String(l.key);
    const sel = itemSelect(l, n);
    sel.addEventListener("change", () => {
      const v = sel.value;
      if (v === "other") {
        l.other = true;
        l.paintItemId = null;
      } else if (v === "") {
        l.other = false;
        l.paintItemId = null;
      } else {
        l.other = false;
        l.paintItemId = Number(v);
        const it = itemById(l.paintItemId);
        if (it) l.unit = it.unit;
      }
      markDirty();
      const tr = sel.closest("tr");
      const fresh = lineRow(l);
      tr.replaceWith(fresh);
      updateTotals();
      focusNode(lineControl(l.key, "item"));
    });
    // One child per cell, so the narrow card layout keeps it beside its label.
    const itemBox = el("div", { class: "pt-cellbox" }, sel);
    const itemCell = el("td", { class: "pt-c-item", "data-label": "Item" }, itemBox);
    if (l.other) {
      const name = el("input", { class: "hs-input", type: "text", maxlength: String(TEXT_MAX), autocomplete: "off", "data-line": key, "data-ctl": "name", "aria-label": "Name, line " + n, placeholder: "Name" });
      name.value = l.name;
      name.addEventListener("input", () => { l.name = name.value; markDirty(); });
      const finish = el("input", { class: "hs-input", type: "text", maxlength: String(TEXT_MAX), autocomplete: "off", "aria-label": "Finish, line " + n, placeholder: "Finish" });
      finish.value = l.finish;
      finish.addEventListener("input", () => { l.finish = finish.value; markDirty(); });
      const maker = el("input", { class: "hs-input", type: "text", maxlength: String(TEXT_MAX), autocomplete: "off", "aria-label": "Manufacturer, line " + n, placeholder: "Manufacturer" });
      maker.value = l.manufacturer;
      maker.addEventListener("input", () => { l.manufacturer = maker.value; markDirty(); });
      const unit = el("select", { class: "hs-input", "aria-label": "Unit, line " + n, "data-line": key, "data-ctl": "unit" },
        el("option", { value: "kg", text: "kg" }), el("option", { value: "each", text: "each" }));
      unit.value = l.unit;
      unit.addEventListener("change", () => {
        l.unit = unit.value;
        markDirty();
        const u = document.querySelector(`[data-line="${key}"][data-ctl="unitlabel"]`);
        if (u) u.textContent = l.unit;
        updateLitres(l);
        updateTotals();
      });
      itemBox.append(el("div", { class: "pt-other" }, name, finish, maker, unit));
    }
    const qty = el("input", { class: "hs-input pt-qty", type: "number", min: "0.01", max: String(QTY_MAX), step: "0.01", inputmode: "decimal",
      "data-line": key, "data-ctl": "qty", "aria-label": "Quantity, line " + n });
    qty.value = l.qty;
    qty.addEventListener("input", () => {
      l.qty = qty.value;
      markDirty();
      updateLitres(l);
      updateTotals();
    });
    const qtyCell = el("td", { class: "pt-c-qty", "data-label": "Qty" },
      el("span", { class: "pt-qtybox" }, qty, el("span", { class: "pt-unit", "data-line": key, "data-ctl": "unitlabel", text: lineUnit(l) })));
    const litres = el("td", { class: "pt-c-litres" + (litresText(l) ? "" : " pt-blank"), "data-label": "Litres" }, el("span", { "data-line": key, "data-ctl": "litres", text: litresText(l) }));
    const jobCell = el("td", { class: "pt-c-job", "data-label": "Job" });
    if (can("jobs.view")) {
      const job = el("input", { class: "hs-input", type: "text", list: "ptJobs", autocomplete: "off", "data-line": key, "data-ctl": "job",
        "aria-label": "Job, line " + n, placeholder: "No job: workshop stock" });
      job.value = l.jobText;
      const hint = el("span", { class: "pt-jobhint", "data-line": key, "data-ctl": "jobhint" });
      const check = () => {
        const id = resolveJob(l);
        if (l.jobText.trim() && id == null) hint.textContent = "Choose a job from the list";
        else if (id != null && !isLiveJob(id)) hint.textContent = "This job is archived: remove it from the line";
        else hint.textContent = "";
        hint.hidden = !hint.textContent;
      };
      job.addEventListener("input", () => { l.jobText = job.value; markDirty(); check(); refreshActions(); });
      check();
      jobCell.append(el("div", { class: "pt-cellbox" }, job, hint));
    } else {
      jobCell.append(el("span", { text: l.jobName || "" }));
    }
    const rm = el("button", { type: "button", class: "hs-btn hs-btn-quiet", "data-line": key, "data-ctl": "remove", text: "Remove", "aria-label": "Remove line " + n });
    rm.addEventListener("click", () => {
      const at = form.lines.indexOf(l);
      form.lines.splice(at, 1);
      markDirty();
      renderLines();
      refreshActions();
      const next = form.lines[at] || form.lines[at - 1];
      if (!next || !focusNode(lineControl(next.key, "remove"))) focusNode($("ptAddLine"));
    });
    return el("tr", { "data-row": key },
      el("td", { class: "pt-c-n", "data-label": "Line", text: String(n) }),
      itemCell, qtyCell, litres, jobCell,
      el("td", { class: "pt-c-rm" }, rm));
  }

  function litresText(l) {
    const q = Number(l.qty);
    if (lineUnit(l) !== "kg" || !(q > 0)) return "";
    return fmtLitres(litresOf(q, factor));
  }

  function updateLitres(l) {
    const n = document.querySelector(`[data-line="${l.key}"][data-ctl="litres"]`);
    if (!n) return;
    n.textContent = litresText(l);
    n.closest("td").classList.toggle("pt-blank", !n.textContent);
  }

  function updateTotals() {
    const t = $("ptTotals");
    if (t) t.textContent = totalsText(form.lines.map((l) => ({ unit: lineUnit(l), qty: Number(l.qty) })));
  }

  // "Total 12 kg (10.20 L) · 3 each"
  function totalsText(lines) {
    let kg = 0;
    let each = 0;
    for (const l of lines) {
      if (!(l.qty > 0)) continue;
      if (l.unit === "kg") kg += l.qty;
      else each += l.qty;
    }
    const bits = [];
    if (kg) bits.push(`${fmtQty(kg)} kg (${fmtLitres(litresOf(kg, factor))})`);
    if (each) bits.push(`${fmtQty(each)} each`);
    return bits.length ? "Total " + bits.join(" · ") + `. Litres are kg × ${factor}.` : "";
  }

  // Read-only: an order that isn't a draft, or a user without stock.order.
  function readBlock() {
    const kv = el("div", { class: "hs-kvt pt-kvt" },
      el("div", { class: "k", text: "Supplier" }), el("div", { class: "v", text: order.supplier }),
      el("div", { class: "k", text: "Expected" }), el("div", { class: "v", text: order.expectedDate ? fmtDate(order.expectedDate) : "No date" }));
    if (order.notes) kv.append(el("div", { class: "k", text: "Notes" }), el("div", { class: "v pt-pre", text: order.notes }));
    const rows = (order.lines || []).map((l) => el("tr", null,
      el("td", { class: "pt-c-qty", "data-label": "Qty", text: fmtQty(l.qty) + " " + l.unit }),
      el("td", { class: "pt-c-litres" + (l.litres == null ? " pt-blank" : ""), "data-label": "Litres", text: l.litres == null ? "" : fmtLitres(l.litres) }),
      el("td", { class: "pt-c-name", "data-label": "Name" }, el("span", { class: "pt-strong", text: l.name })),
      el("td", { class: "pt-c-text" + (l.finish ? "" : " pt-blank"), "data-label": "Finish", text: l.finish }),
      el("td", { class: "pt-c-text" + (l.manufacturer ? "" : " pt-blank"), "data-label": "Manufacturer", text: l.manufacturer }),
      el("td", { class: "pt-c-job", "data-label": "Job" }, l.jobId == null ? el("span", { class: "pt-muted", text: "Workshop stock" }) : jobLink(l.jobId, l.jobName))));
    return el("div", { class: "pt-read" },
      kv,
      el("div", { class: "hs-sectionbar pt-bar" }, el("h2", { id: "ptLinesTitle", text: "Lines" })),
      rows.length
        ? el("div", { class: "pt-wrap" }, el("table", { class: "pt-table pt-table-read", "aria-labelledby": "ptLinesTitle" },
          el("thead", null, el("tr", null, ...["Qty", "Litres", "Name", "Finish", "Manufacturer", "Job"].map((t, i) =>
            el("th", { scope: "col", class: ["pt-c-qty", "pt-c-litres", "pt-c-name", "pt-c-text", "pt-c-text", "pt-c-job"][i], text: t })))),
          el("tbody", null, ...rows)))
        : el("p", { class: "pt-empty", text: "No lines." }),
      el("p", { class: "pt-totals", text: totalsText((order.lines || []).map((l) => ({ unit: l.unit, qty: l.qty }))) }));
  }

  // The order lines this paint order keeps on its jobs (Decision 6).
  function jobsBlock() {
    const box = el("div", { class: "pt-jobs" }, el("div", { class: "hs-sectionbar pt-bar" }, el("h2", { text: "Order lines on jobs" })));
    if (!order.jobs || !order.jobs.length) {
      box.append(el("p", { class: "pt-note", text: "None: every line is workshop stock." }));
      return box;
    }
    box.append(el("ul", { class: "pt-joblist" }, ...order.jobs.map((j) => {
      const st = { to_order: ["To order", "hs-badge-check"], ordered: ["Ordered", "hs-badge-teal"], received: ["Received", "hs-badge-go"], cancelled: ["Cancelled", "hs-badge-na"] }[j.orderStatus] || [j.orderStatus, "hs-badge-na"];
      return el("li", null, jobLink(j.jobId, j.jobName), el("span", { class: "hs-badge " + st[1], text: st[0] }));
    })));
    box.append(el("p", { class: "pt-note", text: "Each is a line on the job's Orders, changed only from here: Mark ordered and Received move them too." }));
    return box;
  }

  function jobLineCount() {
    return order && order.jobs ? order.jobs.filter((j) => j.orderStatus !== "cancelled").length : 0;
  }

  function actionsBlock() {
    const bar = el("div", { class: "pt-actions" });
    const add = (id, label, cls, fn) => {
      const b = el("button", { type: "button", class: "hs-btn" + (cls ? " " + cls : ""), id, text: label });
      b.addEventListener("click", () => run(fn, b));
      bar.append(b);
      return b;
    };
    const st = order ? order.status : "draft";
    const order_ = can("stock.order");
    // Job lines (saved, or typed into the form and about to be saved by Mark ordered) need
    // orders.mark_ordered as well.
    const needsMark = (order && jobLineCount() > 0) || (editable() && form.lines.some((l) => l.jobText.trim()));
    const mayMark = !needsMark || can("orders.mark_ordered");
    if (editable()) add("ptSave", order ? "Save" : "Save draft", "hs-btn-primary" + (dirty ? " pt-unsaved" : ""), save);
    if (order_ && st === "draft" && mayMark) add("ptMark", "Mark ordered", order ? "hs-btn-primary" : "", markOrdered);
    if (order_ && st === "ordered" && mayMark) add("ptUndoOrdered", "Undo ordered", "", undoOrdered);
    if (can("orders.receive") && st === "ordered") add("ptReceive", "Received", "hs-btn-primary", receive);
    if (can("orders.receive") && st === "received") add("ptUndoReceived", "Undo received", "", undoReceived);
    if (order) {
      const p = el("button", { type: "button", class: "hs-btn", id: "ptPrintBtn", text: "Print" });
      p.addEventListener("click", printOrder);
      bar.append(p);
    }
    if (order_ && order && st === "draft") add("ptCancel", "Cancel order", "hs-btn-stop", cancelOrder);
    const notes = [];
    if (order_ && (st === "draft" || st === "ordered") && !mayMark) {
      notes.push("It has job lines, so marking it ordered (or undoing that) also needs the Mark ordered permission.");
    }
    if (editable()) notes.push("Mark ordered saves your changes first.");
    const box = el("div", { class: "pt-actionbox" }, bar);
    const dirtyNote = el("p", { class: "pt-dirty", id: "ptDirty", text: "Not saved yet." });
    dirtyNote.hidden = !dirty;
    if (editable()) box.append(dirtyNote);
    for (const n of notes) box.append(el("p", { class: "pt-note", text: n }));
    return box;
  }

  // ---- actions ----

  async function run(fn, btn) {
    if (busy) return;
    busy = true;
    try {
      await fn(btn);
    } finally {
      busy = false;
    }
  }

  // After the server answers with the order: it becomes the page's order.
  function adopt(o) {
    order = o;
    factor = o.litresPerKg || factor;
    form = formFrom(o);
    dirty = false;
    if (!/[?&]id=\d+/.test(location.search)) history.replaceState(null, "", "/paint.html?id=" + encodeURIComponent(o.id));
    renderOrder();
  }

  async function reloadOrder() {
    if (!order) return;
    try {
      adopt(await api("/api/paint/orders/" + encodeURIComponent(order.id)));
    } catch (e) {
      setStatus(failText(e), "err");
    }
  }

  // A sentence for the line it is about: "lines[2].jobId must be ..." -> "Line 3: ...". `sent` maps
  // the lines sent to the lines on screen (blank lines aren't sent).
  function explain(msg, sent) {
    const m = /^lines\[(\d+)\]\.?(\w*)\s*(.*)$/.exec(msg || "");
    if (!m) return { text: msg };
    const at = sent[Number(m[1])];
    const n = at == null ? Number(m[1]) + 1 : at + 1;
    const line = at == null ? null : form.lines[at];
    if (m[2] === "jobId" && /archived/.test(m[3])) {
      return { text: `Line ${n}: its job is archived. Take the job off the line (or remove the line), then save again.`, line, ctl: "job" };
    }
    if (m[2] === "paintItemId") return { text: `Line ${n}: that item isn't on the paint list any more. Choose another.`, line, ctl: "item" };
    if (m[2] === "qty") return { text: `Line ${n}: the quantity ${m[3]}.`, line, ctl: "qty" };
    return { text: `Line ${n}: ${m[2] ? m[2] + " " : ""}${m[3]}`, line, ctl: m[2] === "name" ? "name" : "item" };
  }

  function bad(text, line, ctl) {
    const e = new Error(text);
    e.line = line;
    e.ctl = ctl;
    return e;
  }

  // The request body from the form; throws a sentence (with the line to focus) when it can't be sent.
  function bodyFrom() {
    const supplier = form.supplier.trim();
    if (!supplier) throw bad("Type the supplier.", null, "supplier");
    const lines = [];
    const sent = [];
    form.lines.forEach((l, i) => {
      const n = i + 1;
      const blank = !l.other && l.paintItemId == null && !String(l.qty).trim() && !l.jobText.trim();
      if (blank) return;
      const q = Number(l.qty);
      if (!String(l.qty).trim() || !Number.isFinite(q) || q <= 0 || q > QTY_MAX) throw bad(`Line ${n}: type a quantity above 0 and at most ${QTY_MAX}.`, l, "qty");
      if (Math.abs(q * 100 - Math.round(q * 100)) > 1e-6) throw bad(`Line ${n}: the quantity takes at most two decimal places.`, l, "qty");
      let jobId = null;
      if (l.jobText.trim()) {
        jobId = resolveJob(l);
        if (jobId == null) throw bad(`Line ${n}: choose a job from the list, or empty the job box for workshop stock.`, l, "job");
      }
      if (l.other) {
        const name = l.name.trim();
        if (!name) throw bad(`Line ${n}: type what it is, or choose an item from the list.`, l, "name");
        lines.push({ name, finish: l.finish.trim(), manufacturer: l.manufacturer.trim(), unit: l.unit, qty: Math.round(q * 100) / 100, jobId });
      } else {
        if (l.paintItemId == null) throw bad(`Line ${n}: choose an item, or Other… to type one.`, l, "item");
        lines.push({ paintItemId: l.paintItemId, qty: Math.round(q * 100) / 100, jobId });
      }
      sent.push(i);
    });
    return { body: { supplier, expectedDate: form.expectedDate || null, notes: form.notes.trim(), lines }, sent };
  }

  function showFormError(e) {
    setStatus(e.message, "err");
    if (e.ctl === "supplier") focusNode($("ptSupplier"));
    else if (e.line) focusNode(lineControl(e.line.key, e.ctl) || lineControl(e.line.key, "item"));
  }

  // Resolves true when saved (or nothing needed saving).
  async function save() {
    let req;
    try {
      req = bodyFrom();
    } catch (e) {
      showFormError(e);
      return false;
    }
    setStatus("Saving...", "");
    const btn = $("ptSave");
    if (btn) btn.disabled = true;
    try {
      const r = order
        ? await api("/api/paint/orders/" + encodeURIComponent(order.id), { method: "PUT", body: JSON.stringify(req.body) })
        : await api("/api/paint/orders", { method: "POST", body: JSON.stringify(req.body) });
      const fresh = !order;
      adopt(r);
      setStatus(fresh ? `Saved as paint order ${r.id}.` : "Saved.", "ok");
      focusNode($("ptSave"));
      return true;
    } catch (e) {
      if (btn) btn.disabled = false;
      if (e instanceof TypeError) {
        setStatus(failText(e), "err");
        return false;
      }
      const x = explain(e.message, req.sent);
      setStatus(x.text, "err");
      if (x.line) focusNode(lineControl(x.line.key, x.ctl) || lineControl(x.line.key, "item"));
      return false;
    }
  }

  async function markOrdered() {
    if (editable() && (dirty || !order)) {
      if (!(await save())) return;
    }
    if (!order || order.status !== "draft") return;
    if (!order.lines || !order.lines.length) {
      setStatus("Add at least one line before marking it ordered.", "err");
      return;
    }
    const U = ui();
    const today = todayISO();
    const od = U.dateInput(today, null, today);
    const exp = U.dateInput(order.expectedDate || "", null, null);
    const onJobs = order.jobs.filter((j) => j.orderStatus !== "cancelled");
    const list = onJobs.length
      ? el("div", { class: "ou-wide pt-dlg-jobs" },
        el("p", { class: "cc-dialog-note", text: "These jobs' paint lines will be marked ordered. A job's progress invoice falls due when it is the last of its lines to be ordered." }),
        el("ul", { class: "pt-dlg-list" }, ...onJobs.map((j) => el("li", { text: j.jobName }))))
      : el("p", { class: "cc-dialog-note ou-wide", text: "No job lines: it is all workshop stock." });
    const r = await U.dialog({
      title: "Mark ordered",
      note: `Paint order ${order.id}: ${order.supplier}, ${order.lines.length} ${order.lines.length === 1 ? "line" : "lines"}.`,
      fields: [U.field("Ordered", od), U.field("Expected", exp, { hint: "Empty for no date yet." }), list],
      wide: true,
      submit: "Mark ordered",
      focus: od,
      run: () => {
        if (!U.validDate(od.value)) throw new Error("Choose the date it was ordered");
        if (od.value > today) throw new Error("The ordered date can't be in the future");
        if (exp.value && !U.validDate(exp.value)) throw new Error("That isn't a whole date");
        return U.sendVia((b) => api("/api/paint/orders/" + encodeURIComponent(order.id) + "/ordered", { method: "POST", body: JSON.stringify(b) }),
          { orderedDate: od.value, expectedDate: exp.value || null });
      },
    });
    await after(r, "Marked ordered.", ["ptReceive", "ptUndoOrdered", "ptPrintBtn"]);
  }

  async function undoOrdered() {
    const onJobs = jobLineCount();
    const r = await ui().dialog({
      title: "Undo ordered?",
      note: `Paint order ${order.id}: ${order.supplier}.`,
      hint: "It goes back to a draft" + (onJobs ? ", and its job lines go back to To order." : ".") + " A progress invoice that already fell due stays due.",
      submit: "Undo ordered",
      cancel: "Keep ordered",
      focus: "cancel",
      run: () => ui().sendVia(() => api("/api/paint/orders/" + encodeURIComponent(order.id) + "/undo-ordered", { method: "POST", body: "{}" }), {}),
    });
    await after(r, "Back to a draft.", ["ptMark", "ptSave"]);
  }

  async function receive() {
    const item = { name: `Paint order ${order.id}: ${order.supplier}`, orderedDate: order.orderedDate, deliveryNote: order.deliveryNote };
    const r = await window.OrderUI.receiveItem(item, (b) => api("/api/paint/orders/" + encodeURIComponent(order.id) + "/received", { method: "POST", body: JSON.stringify(b) }));
    await after(r, "Received.", ["ptUndoReceived", "ptPrintBtn"]);
  }

  async function undoReceived() {
    const item = { name: `Paint order ${order.id}: ${order.supplier}`, receivedDate: order.receivedDate };
    const r = await window.OrderUI.undoReceivedItem(item, (b) => api("/api/paint/orders/" + encodeURIComponent(order.id) + "/received", { method: "POST", body: JSON.stringify(b) }));
    await after(r, "Back to ordered.", ["ptReceive", "ptUndoOrdered"]);
  }

  async function cancelOrder() {
    const onJobs = jobLineCount();
    const ok = await confirmBox("Cancel this paint order?",
      `Paint order ${order.id}: ${order.supplier}.` + (onJobs ? " Its job lines are cancelled too; they stay on the jobs, marked cancelled." : "") + " A cancelled order can't be reopened.",
      "Cancel order", "Keep order", true);
    if (!ok) return;
    try {
      const r = await api("/api/paint/orders/" + encodeURIComponent(order.id) + "/cancel", { method: "POST", body: "{}" });
      adopt(r);
      setStatus("Paint order cancelled.", "ok");
      focusNode($("ptTitle"));
    } catch (e) {
      setStatus(failText(e), "err");
      await reloadOrder();
    }
  }

  // After a dialog: null is a cancel (focus is already back), {refused} reloads the order as it is
  // now, and an order is adopted with focus on the next sensible button.
  async function after(r, said, next) {
    if (!r) return;
    if (r.refused) {
      await reloadOrder();
      return;
    }
    adopt(r);
    setStatus(said, "ok");
    for (const id of next) if (focusNode($(id))) return;
    focusNode($("ptTitle"));
  }

  // ---- print ----

  function buildPrint() {
    const sheet = $("ptPrint");
    if (!order) {
      sheet.replaceChildren(el("p", { class: "pt-p-empty", text: "Open a paint order to print it." }));
      return;
    }
    const out = [el("img", { class: "pt-p-letterhead", src: "/assets/invoice-letterhead.png", alt: "TH Cabinets" })];
    const biz = order.business || null; // business details, when the order carries them
    const head = el("div", { class: "pt-p-head" });
    const left = el("div", { class: "pt-p-biz" });
    if (biz) {
      const name = (biz.tradingName || biz.legalName || "").trim();
      if (name) left.append(el("p", { class: "pt-p-bizname", text: name }));
      for (const v of [biz.address, biz.phone, biz.email]) if (v && String(v).trim()) left.append(el("p", { class: "pt-p-bizline", text: String(v).trim() }));
    }
    const date = order.orderedDate || todayISO();
    const meta = el("dl", { class: "pt-p-meta" });
    const kv = (k, v) => meta.append(el("dt", { text: k }), el("dd", { text: v }));
    kv("Date", fmtDate(date));
    kv("Supplier", order.supplier);
    if (order.expectedDate) kv("Expected", fmtDate(order.expectedDate));
    if (order.orderedBy && order.orderedBy.name) kv("Ordered by", order.orderedBy.name);
    head.append(left, el("div", { class: "pt-p-title" }, el("h1", { class: "pt-p-h1", text: "Paint order " + order.id }), meta));
    out.push(head);
    const cols = el("colgroup", null, ...["pt-pc-kg", "pt-pc-l", "pt-pc-name", "pt-pc-fin", "pt-pc-man", "pt-pc-job"].map((c) => el("col", { class: c })));
    const hr = el("tr", null, ...["Kg", "Litres", "Name", "Finish", "Manufacturer", "Job"].map((t, i) => el("th", { scope: "col", class: i < 2 ? "pt-p-num" : null, text: t })));
    const lines = order.lines || [];
    const tb = el("tbody", null, ...lines.map((l) => el("tr", null,
      el("td", { class: "pt-p-num", text: l.unit === "kg" ? fmtQty(l.qty) : fmtQty(l.qty) + " each" }),
      el("td", { class: "pt-p-num", text: l.litres == null ? "" : l.litres.toFixed(2) }),
      el("td", { class: "pt-p-strong", text: l.name }),
      el("td", { text: l.finish }),
      el("td", { text: l.manufacturer }),
      el("td", { text: l.jobName || "" }))));
    out.push(el("table", { class: "pt-p-table" }, cols, el("thead", null, hr), tb));
    const total = totalsText(lines.map((l) => ({ unit: l.unit, qty: l.qty })));
    if (total) out.push(el("p", { class: "pt-p-total", text: total }));
    if (order.notes) out.push(el("div", { class: "pt-p-notes" }, el("p", { class: "pt-p-label", text: "Notes" }), el("p", { class: "pt-p-pre", text: order.notes })));
    sheet.replaceChildren(...out);
  }

  let titleBefore = null;
  function beforePrint() {
    buildPrint();
    if (titleBefore == null) titleBefore = document.title;
    if (order) document.title = "Paint order " + order.id + " " + fmtDate(order.orderedDate || todayISO());
  }
  function afterPrint() {
    if (titleBefore != null) document.title = titleBefore;
    titleBefore = null;
  }
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);
  function printOrder() {
    if (dirty) setStatus("Printing the saved order: your unsaved changes aren't on it.", "");
    beforePrint();
    window.print();
  }

  // Leaving with unsaved changes asks first.
  window.addEventListener("beforeunload", (e) => {
    if (dirty && editable()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ---- opening an order ----

  async function startOrder(idParam) {
    $("ptIntro").hidden = true;
    const editor = can("stock.order");
    if (idParam === "new") {
      if (!editor) return noAccess();
      setHead("New paint order", "draft");
      await Promise.all([loadItems(), loadJobs(), api("/api/paint/settings").then((s) => { factor = s.litresPerKg; }, () => {})]);
      order = null;
      form = formFrom(null);
      setStatus("", "");
      renderOrder();
      focusNode($("ptSupplier"));
      return;
    }
    if (!/^[1-9]\d*$/.test(idParam)) {
      setStatus("That isn't a paint order. Open one from the list.", "err");
      return;
    }
    setHead("Paint order " + idParam, null);
    try {
      const [o] = await Promise.all([
        api("/api/paint/orders/" + encodeURIComponent(idParam)),
        editor ? loadItems() : null,
        editor ? loadJobs() : null,
      ]);
      order = o;
      factor = o.litresPerKg || factor;
      form = formFrom(o);
    } catch (e) {
      setStatus(/not found/i.test(e.message || "") ? "There is no paint order " + idParam + "." : failText(e), "err");
      $("ptHeadActions").replaceChildren(editor
        ? el("a", { class: "hs-btn hs-btn-quiet", href: "/paint.html", text: "All paint orders" })
        : el("a", { class: "hs-btn hs-btn-quiet", href: "/deliveries.html", text: "Deliveries" }));
      return;
    }
    setStatus("", "");
    renderOrder();
  }

  function noAccess() {
    $("ptIntro").hidden = true;
    setStatus("", "");
    const p = el("p", { class: "pt-empty" }, "Paint orders are run by Ordering. Open one from ",
      el("a", { href: "/deliveries.html", text: "Deliveries" }), " to mark it received.");
    $("ptOrder").hidden = false;
    $("ptOrder").replaceChildren(p);
  }

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    const id = new URLSearchParams(location.search).get("id");
    if (id) startOrder(id);
    else if (can("stock.order")) startTabs();
    else noAccess();
  })();
})();
