// Stone orders (/stone.html; docs/plans/m12-contracts.md section 9.2). Talks to /api/stone and
// /api/job-records/:id/stone (routes/stone.js); every rule lives in lib/stone.js, and the page only
// hides what a user can't use (cc.can()). The page is gated by design.view (lib/pages.js).
//
//   /stone.html            the list: open, cancelled or all (kept in the hash)
//   /stone.html?job=N      a new stone order for job N, prefilled from the job (jobs.edit)
//   /stone.html?id=N       one stone order: edited, sent and cancelled here with jobs.edit;
//                          read-only without it, when cancelled, or when its job is archived
//
// A stone order is not an order line (Decision 1): nothing here touches Orders. The dialogs are
// built on OrderUI's frame (orderui.js). Every value goes in as text. Page classes are so-.
//
// After a 409 (Save, the send dialog's save or send, Cancel, Restore) the order is reloaded as the
// server has it, the sentence shows by the buttons (plus "Your unsaved changes weren't kept." when
// there were any) and focus moves to it. A write that fails on the network may still have gone
// through, so the page never says "Not saved yet." over it: it says the request couldn't be
// checked and offers Reload (section 9.2, review B-m1 to B-m3). Send carries expectUpdatedAt, the
// updatedAt the page holds, so a copy someone else changed is refused (section 12.17).
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const OTHER = "__other";

  // Section 3 of the contracts, in its key order (the order a new order is posted in).
  const FIELDS = [
    { key: "supplier", label: "Supplier", kind: "text", max: 200, needed: true, list: "soSuppliers" },
    { key: "jobReference", label: "Job reference", kind: "text", max: 200 },
    { key: "quoteNumber", label: "Quote number", kind: "text", max: 100 },
    { key: "siteAddress", label: "Site address", kind: "text", max: 300, wide: true },
    { key: "siteAccess", label: "Site access", kind: "area", max: 1000, wide: true, rows: 3, hint: "Occupied home, lockbox, parking, stairs and so on." },
    { key: "clientName", label: "Client", kind: "text", max: 200 },
    { key: "clientPhone", label: "Client phone", kind: "text", max: 100, type: "tel" },
    { key: "ourContact", label: "Our contact", kind: "text", max: 200 },
    { key: "ourPhone", label: "Our phone", kind: "text", max: 100, type: "tel" },
    { key: "brand", label: "Stone brand", kind: "text", max: 200, needed: true, list: "soBrands" },
    { key: "colour", label: "Colour", kind: "text", max: 200, needed: true },
    { key: "edgeHeight", label: "Edge height", kind: "edge", max: 50, needed: true, options: ["20 mm", "36 mm", "40 mm", "50 mm", "60 mm"] },
    { key: "edgeProfile", label: "Edge profile", kind: "edge", max: 100, needed: true, options: ["Aris", "6x6 round", "10x10 round", "Square"] },
    { key: "cabinetryInstallDate", label: "Cabinetry install", kind: "date" },
    { key: "measureDate", label: "Measure / template", kind: "date" },
    { key: "requestedInstallDate", label: "Requested benchtop install", kind: "date", needed: true },
    { key: "notes", label: "Notes", kind: "area", max: 4000, wide: true, rows: 6, hint: "The sink (drop-off), meeting on site, cut-outs and anything else the supplier should know." },
  ];
  const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
  // Grouped as the print (section 7).
  const GROUPS = [
    { title: "Supplier", keys: ["supplier"], cls: "so-grid-1" },
    { title: "Job", keys: ["jobReference", "quoteNumber", "siteAddress", "siteAccess"] },
    { title: "Contacts", keys: ["ourContact", "ourPhone", "clientName", "clientPhone"] },
    { title: "Stone", keys: ["brand", "colour", "edgeHeight", "edgeProfile"] },
    { title: "Dates", keys: ["cabinetryInstallDate", "measureDate", "requestedInstallDate"], cls: "so-grid-3" },
    { title: "Notes", keys: ["notes"], cls: "so-grid-1" },
  ];
  // Longest label first, so "Client phone" is found before "Client".
  const BY_LABEL = FIELDS.slice().sort((a, b) => b.label.length - a.label.length);

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

  function addDays(iso, n) {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function daysBetween(a, b) {
    return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  }

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  function fmtDayMon(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : "";
  }

  // A UTC timestamp as its Sydney date (YYYY-MM-DD), or null.
  function sydneyDate(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return null;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(t));
  }

  function setStatus(text, kind) {
    const s = $("soStatus");
    s.textContent = text || "";
    s.className = "so-status" + (kind ? " so-status-" + kind : "");
  }

  // shared.js api(), keeping the refusal's status and the form keys it names (`fields`, section
  // 9.2: "a 400 naming fields marks those fields"). A 401 goes to the login page as api() does.
  async function call(path, options) {
    const res = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options && options.headers) },
    });
    if (res.status === 401) return api(path, options);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const e = new Error(body.error || `Request failed (${res.status})`);
      e.status = res.status;
      if (Array.isArray(body.fields)) e.fields = body.fields.filter((k) => typeof k === "string");
      throw e;
    }
    if (res.status === 204) return null;
    return res.json();
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
    if (!can("jobs.view") || jobId == null) return el("span", { class: "so-jobname", text: name || "" });
    return el("a", { class: "so-joblink", href: "/job.html?id=" + encodeURIComponent(jobId) + "#benchtops", text: name || "" });
  }

  // The state as the job page words it (section 9.1): [text, badge class, note].
  function stateOf(o) {
    if (o.status === "cancelled") return ["Cancelled", "hs-badge-na", null];
    if (o.status === "draft" || !o.revision) return ["Draft", "hs-badge-na", null];
    if (o.changedSinceSent) return ["Changed since rev " + o.revision, "hs-badge-check", null];
    return ["Sent rev " + o.revision + (o.sentDate ? ", " + fmtDayMon(o.sentDate) : ""), "hs-badge-teal",
      o.sentBy && o.sentBy.name ? "by " + o.sentBy.name : null];
  }

  function stateBadge(o) {
    const [label, cls, note] = stateOf(o);
    return [el("span", { class: "hs-badge " + cls, text: label }), note ? el("span", { class: "so-note", text: note }) : null];
  }

  // ========================================================================= the list ===

  const FILTERS = ["open", "cancelled", "all"];
  const EMPTY = { open: "No open stone orders.", cancelled: "No cancelled stone orders.", all: "No stone orders." };
  let listSeq = 0;

  function filterFromHash() {
    const h = location.hash.replace(/^#/, "");
    return FILTERS.includes(h) ? h : "open";
  }

  // Requested install: orange when the order still needs sending (a draft, or changes not sent)
  // and the date is within the next 14 days (or already past).
  function attendInstall(o, today) {
    const d = o.form && o.form.requestedInstallDate;
    if (!d || o.status === "cancelled") return null;
    if (!(o.status === "draft" || o.changedSinceSent)) return null;
    if (d > addDays(today, 13)) return null;
    const n = daysBetween(today, d);
    return n < 0 ? "Passed, not sent" : n === 0 ? "Today, not sent" : n === 1 ? "Tomorrow, not sent" : "In " + n + " days, not sent";
  }

  function renderList(orders, filter) {
    const today = todayISO();
    const rows = $("soRows");
    $("soEmpty").hidden = orders.length > 0;
    $("soEmpty").textContent = orders.length ? "" : EMPTY[filter];
    $("soListWrap").hidden = !orders.length;
    rows.replaceChildren(...orders.map((o) => {
      const f = o.form || {};
      const job = el("td", { class: "so-c-job", "data-label": "Job" }, jobLink(o.jobId, o.jobName));
      if (o.jobArchived) job.append(el("span", { class: "so-note", text: "Job archived" }));
      const attend = attendInstall(o, today);
      const req = el("td", { class: "so-c-date" + (attend ? " so-attend" : ""), "data-label": "Requested install" },
        f.requestedInstallDate ? el("span", { text: fmtDate(f.requestedInstallDate) }) : null,
        attend ? el("span", { class: "so-attend-tag", text: attend }) : null);
      const stone = [f.brand, f.colour].filter(Boolean).join(", ");
      return el("tr", { class: o.status === "cancelled" ? "so-row-off" : null },
        job,
        el("td", { class: "so-c-sup so-strong" + (f.supplier ? "" : " so-blank"), "data-label": "Supplier", text: f.supplier || "" }),
        el("td", { class: "so-c-stone" + (stone ? "" : " so-blank"), "data-label": "Stone", text: stone }),
        el("td", { class: "so-c-state", "data-label": "State" }, ...stateBadge(o)),
        el("td", { class: "so-c-date" + (f.measureDate ? "" : " so-blank"), "data-label": "Measure", text: fmtDate(f.measureDate) }),
        req,
        el("td", { class: "so-c-open" }, el("a", {
          class: "hs-btn", href: "/stone.html?id=" + encodeURIComponent(o.id),
          "aria-label": "Open the stone order for " + (o.jobName || "the job") + (f.supplier ? ", " + f.supplier : ""), text: "Open",
        })));
    }));
  }

  async function loadList() {
    const filter = filterFromHash();
    $("soFilter").value = filter;
    const mine = ++listSeq;
    setStatus("Loading...", "");
    try {
      const r = await call("/api/stone?status=" + encodeURIComponent(filter));
      if (mine !== listSeq) return;
      setStatus("", "");
      renderList(Array.isArray(r.orders) ? r.orders : [], filter);
    } catch (e) {
      if (mine !== listSeq) return;
      setStatus(failText(e), "err");
    }
  }

  function startList() {
    document.title = "Benchtops - Crosscuts";
    $("soList").hidden = false;
    $("soHeadActions").replaceChildren(el("a", { class: "hs-btn", href: "/stoneprint.html?sheet=blank", text: "Print blank benchtop sheet" }));
    $("soFilter").addEventListener("change", () => {
      const v = $("soFilter").value;
      history.replaceState(null, "", "/stone.html" + (v === "open" ? "" : "#" + v));
      loadList();
    });
    window.addEventListener("hashchange", loadList);
    loadList();
  }

  // ======================================================================= one order ===

  let mode = null;   // "new" | "order"
  let order = null;  // the server's order (with revisions), or null for a new one
  let job = null;    // {id, name, archived}: the job a new order is for
  let base = null;   // the form as saved (or the prefill for a new order)
  let others = 0;    // a new order's job: how many stone orders it has already (not cancelled)
  let ctl = {};      // key -> {box, input, select, other}
  let dirty = false;
  let busy = false;
  let msg = { text: "", kind: "" };   // the sentence by the buttons
  let marked = new Set();              // the fields the last refusal named
  let suggestions = null;
  let unsure = false;                  // a write failed on the network: it may have gone through

  function editable() {
    if (mode === "new") return can("jobs.edit");
    return !!order && can("jobs.edit") && order.status !== "cancelled" && !order.jobArchived;
  }

  function normText(v) {
    return v == null ? "" : String(v).trim();
  }

  function norm(f, v) {
    if (f.kind === "date") return v ? String(v) : null;
    return normText(v);
  }

  function valueOf(key) {
    const c = ctl[key];
    if (!c) return base ? base[key] : null;
    if (c.select) return c.select.value === OTHER ? c.other.value : c.select.value;
    return c.input.value;
  }

  function formNow() {
    const out = {};
    for (const f of FIELDS) out[f.key] = norm(f, valueOf(f.key));
    return out;
  }

  function changedKeys() {
    const now = formNow();
    return FIELDS.filter((f) => now[f.key] !== norm(f, base ? base[f.key] : null)).map((f) => f.key);
  }

  // The fields a refusal names: "Fill in before sending: Stone brand, Colour", or "<Label> must be ...".
  function fieldsIn(text) {
    const s = String(text || "");
    const m = /^Fill in before sending:\s*(.*)$/.exec(s);
    if (m) {
      const names = m[1].split(/\s*,\s*/).map((x) => x.replace(/\.$/, "").trim());
      return FIELDS.filter((f) => names.includes(f.label)).map((f) => f.key);
    }
    const hit = BY_LABEL.find((f) => s.startsWith(f.label + " must ") || s.startsWith(f.label + " can"));
    return hit ? [hit.key] : [];
  }

  function applyMarks() {
    for (const f of FIELDS) {
      const c = ctl[f.key];
      if (!c) continue;
      const on = marked.has(f.key);
      c.box.classList.toggle("so-bad", on);
      for (const n of [c.input, c.select, c.other]) if (n) {
        if (on) n.setAttribute("aria-invalid", "true");
        else n.removeAttribute("aria-invalid");
      }
    }
  }

  function focusField(key) {
    const c = ctl[key];
    if (!c) return false;
    if (c.select) return focusNode(c.select.value === OTHER ? c.other : c.select);
    return focusNode(c.input);
  }

  // The form keys a refusal names: its `fields` when the server sent them, else read from the
  // sentence. Keys that aren't on the form (sentDate) are left to the dialog.
  function namedIn(e) {
    if (e && Array.isArray(e.fields)) return e.fields.filter((k) => FIELD[k]);
    return fieldsIn(e && e.message);
  }

  // A refused request: its sentence by the buttons, and the fields it names marked.
  function refused(text, keys) {
    marked = new Set(keys || fieldsIn(text));
    applyMarks();
    setMsg(text, "err");
  }

  function setMsg(text, kind) {
    msg = { text: text || "", kind: kind || "" };
    const n = $("soMsg");
    if (!n) return;
    n.textContent = msg.text;
    n.className = "so-msg" + (msg.kind ? " so-msg-" + msg.kind : "");
  }

  // The sentence by the buttons takes focus (after a 409 or a network failure), so it is read out
  // and the keyboard carries on from there.
  function focusMsg() {
    return focusNode($("soMsg"));
  }

  function onEdit(key) {
    if (marked.delete(key)) applyMarks();
    const was = dirty;
    dirty = changedKeys().length > 0;
    if (was !== dirty || (order && order.status === "sent")) renderActions();
  }

  // ---- the form ----

  function control(f, value, on) {
    const id = "so-f-" + f.key;
    const label = f.label + (f.needed && on ? " *" : ""); // the * goes with the "Needed to send" note (editable only)
    const box = el("div", { class: "so-field" + (f.wide ? " so-wide" : "") });
    const c = { box };
    if (f.kind === "edge") {
      const sel = el("select", { class: "hs-input", id, disabled: !on });
      sel.append(el("option", { value: "", text: "Choose..." }));
      for (const o of f.options) sel.append(el("option", { value: o, text: o }));
      sel.append(el("option", { value: OTHER, text: "Other…" }));
      const other = el("input", {
        class: "hs-input so-other", type: "text", id: id + "-other", maxlength: String(f.max), autocomplete: "off",
        "aria-label": f.label + ", other", placeholder: f.key === "edgeHeight" ? "e.g. 30 mm" : "e.g. Pencil round", disabled: !on,
      });
      const v = normText(value);
      if (v && !f.options.includes(v)) {
        sel.value = OTHER;
        other.value = v;
      } else {
        sel.value = v;
      }
      other.hidden = sel.value !== OTHER;
      sel.addEventListener("change", () => {
        other.hidden = sel.value !== OTHER;
        if (!other.hidden) other.focus();
        onEdit(f.key);
      });
      other.addEventListener("input", () => onEdit(f.key));
      box.append(el("label", { class: "hs-label so-flabel", for: id, text: label }), sel, other);
      c.select = sel;
      c.other = other;
    } else {
      let input;
      if (f.kind === "area") {
        input = el("textarea", { class: "hs-input so-area", id, maxlength: String(f.max), rows: String(f.rows || 3), disabled: !on });
      } else if (f.kind === "date") {
        input = el("input", { class: "hs-input so-date", type: "date", id, disabled: !on });
      } else {
        input = el("input", {
          class: "hs-input", type: f.type || "text", id, maxlength: String(f.max), autocomplete: "off",
          list: on && f.list ? f.list : null, disabled: !on,
        });
      }
      input.value = f.kind === "date" ? value || "" : value == null ? "" : String(value);
      input.addEventListener("input", () => onEdit(f.key));
      if (f.kind === "date") input.addEventListener("change", () => onEdit(f.key));
      box.append(el("label", { class: "hs-label so-flabel", for: id, text: label }), input);
      c.input = input;
    }
    if (f.hint && on) {
      const hid = id + "-h";
      box.append(el("span", { class: "so-hint", id: hid, text: f.hint }));
      (c.input || c.select).setAttribute("aria-describedby", hid);
    }
    ctl[f.key] = c;
    return box;
  }

  function formBlock() {
    const on = editable();
    ctl = {};
    const form = el("form", { class: "so-form", novalidate: true, "aria-label": "Stone order" });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (editable()) run(save);
    });
    for (const g of GROUPS) {
      const grid = el("div", { class: "so-grid" + (g.cls ? " " + g.cls : "") }, ...g.keys.map((k) => control(FIELD[k], base ? base[k] : null, on)));
      form.append(el("fieldset", { class: "so-card" }, el("legend", { class: "so-h2", text: g.title }), grid));
    }
    if (on) {
      form.append(el("datalist", { id: "soSuppliers" }), el("datalist", { id: "soBrands" }));
      form.append(el("p", { class: "so-note so-needed", text: "* Needed to send. A draft can be saved with anything missing." }));
      // Enter in a text box saves (a hidden submit keeps the form's implicit submission).
      form.append(el("button", { type: "submit", class: "so-sr", tabindex: "-1", "aria-hidden": "true", text: "Save" }));
    }
    return form;
  }

  function fillSuggestions() {
    if (!suggestions) return;
    const put = (id, list) => {
      const dl = $(id);
      if (dl) dl.replaceChildren(...(Array.isArray(list) ? list : []).map((v) => el("option", { value: String(v) })));
    };
    put("soSuppliers", suggestions.suppliers);
    put("soBrands", suggestions.brands);
  }

  async function loadSuggestions() {
    if (!can("jobs.edit")) return;
    try {
      suggestions = await call("/api/stone/suggestions");
      fillSuggestions();
    } catch (e) { /* no suggestions; the boxes still take typing */ }
  }

  // ---- the head, state and notes ----

  function metaBlock() {
    const box = el("div", { class: "so-meta" });
    const jobId = order ? order.jobId : job && job.id;
    const jobName = order ? order.jobName : job && job.name;
    box.append(el("p", { class: "so-meta-line" }, el("span", { class: "hs-label", text: "Job" }), jobLink(jobId, jobName)));
    if (order) {
      const st = el("p", { class: "so-meta-line" }, el("span", { class: "hs-label", text: "State" }), ...stateBadge(order));
      box.append(st);
      const lines = [];
      if (order.status === "cancelled") {
        lines.push("Cancelled" + (order.cancelledBy && order.cancelledBy.name ? " by " + order.cancelledBy.name : "") + ". It stays on the job for the record" + (can("jobs.edit") && !order.jobArchived ? ", and Restore brings it back." : "."));
      } else if (order.changedSinceSent) {
        lines.push("Changed since revision " + order.revision + " was sent" + (order.sentDate ? " on " + fmtDate(order.sentDate) : "") + ". Send revision " + (order.revision + 1) + " so the supplier has the changes.");
      }
      if (order.jobArchived) {
        const mayCancel = can("jobs.edit") && order.status !== "cancelled";
        lines.push("The job is archived: this stone order can be printed" + (mayCancel ? " or cancelled" : "") + ", but not changed.");
      }
      else if (!can("jobs.edit")) lines.push("You can see and print this stone order. Projects makes and changes stone orders.");
      for (const t of lines) box.append(el("p", { class: "so-meta-note" + (order.changedSinceSent && order.status !== "cancelled" && t.startsWith("Changed") ? " so-attend-text" : ""), text: t }));
    } else {
      box.append(el("p", { class: "so-meta-note", text: "Filled in from the job where it can be. Change anything here: the job itself isn't changed." }));
      if (others) {
        box.append(el("p", { class: "so-meta-note so-attend-text", text: others === 1 ? "This job already has a stone order." : "This job already has " + others + " stone orders." }));
      }
    }
    return box;
  }

  function sendLabel() {
    return order && order.revision > 0 ? "Send revision " + (order.revision + 1) : "Mark sent";
  }

  function actionsBlock() {
    const bar = el("div", { class: "so-actions" });
    const add = (id, label, cls, fn) => {
      const b = el("button", { type: "button", class: "hs-btn" + (cls ? " " + cls : ""), id, text: label });
      b.addEventListener("click", () => run(fn));
      bar.append(b);
      return b;
    };
    const on = editable();
    const st = order ? order.status : "draft";
    if (on) add("soSave", order ? "Save" : "Save draft", order ? (dirty ? "hs-btn-primary" : "") : "hs-btn-primary", save);
    if (on && order && (st === "draft" || order.changedSinceSent || dirty)) add("soSend", sendLabel(), "hs-btn-primary", sendOrder);
    if (order) {
      bar.append(el("a", { class: "hs-btn", id: "soPrint", href: "/stoneprint.html?id=" + encodeURIComponent(order.id), text: "Print" }));
    }
    if (order && can("jobs.edit") && st !== "cancelled") add("soCancel", "Cancel order", "hs-btn-stop so-push", cancelOrder);
    if (order && can("jobs.edit") && st === "cancelled" && !order.jobArchived) add("soRestore", "Restore", "hs-btn-primary", restoreOrder);
    const box = el("div", { class: "so-actionbox", id: "soActions" }, bar);
    box.append(el("p", { class: "so-msg" + (msg.kind ? " so-msg-" + msg.kind : ""), id: "soMsg", role: "status", "aria-live": "polite", tabindex: "-1", text: msg.text }));
    if (unsure) {
      // A write failed on the network and may have gone through: no "Not saved yet." over it.
      const fix = el("div", { class: "so-unsure" });
      if (order) {
        const b = el("button", { type: "button", class: "hs-btn hs-btn-primary", id: "soReload", text: "Reload" });
        b.addEventListener("click", () => run(reloadNow));
        fix.append(b);
      } else if (job && can("jobs.view")) {
        fix.append(el("a", { class: "hs-btn", id: "soReload", href: "/job.html?id=" + encodeURIComponent(job.id) + "#benchtops", text: "Open the job's Benchtops" }));
      }
      box.append(fix);
      return box;
    }
    if (on && order && dirty) box.append(el("p", { class: "so-dirty", text: "Not saved yet." + (st === "sent" ? " Saving keeps it sent; it then shows as changed until you send the next revision." : "") }));
    if (on && order && dirty && bar.querySelector("#soSend")) box.append(el("p", { class: "so-note", text: sendLabel() + " saves your changes first." }));
    if (on && order && dirty && bar.querySelector("#soPrint")) box.append(el("p", { class: "so-note", text: "Print shows the order as saved." }));
    return box;
  }

  function renderActions() {
    const old = $("soActions");
    if (old) old.replaceWith(actionsBlock());
  }

  function revisionsBlock() {
    const revs = order && Array.isArray(order.revisions) ? order.revisions : [];
    if (!revs.length) return null;
    const list = el("ul", { class: "so-revs" }, ...revs.map((r) => el("li", {},
      el("span", { class: "so-rev-text", text: "Revision " + r.revision + ", sent " + fmtDate(r.sentDate) + (r.sentBy && r.sentBy.name ? " by " + r.sentBy.name : "") }),
      el("a", {
        class: "hs-btn", href: "/stoneprint.html?id=" + encodeURIComponent(order.id) + "&rev=" + encodeURIComponent(r.revision),
        "aria-label": "Print revision " + r.revision, text: "Print",
      }))));
    return el("section", { class: "so-card so-revcard", "aria-labelledby": "soRevH" }, el("h2", { class: "so-h2", id: "soRevH", text: "Revisions" }), list);
  }

  function setHead(title) {
    $("soTitle").textContent = title;
    const ref = order ? normText(order.form && order.form.jobReference) || order.jobName : job && job.name;
    document.title = (mode === "new" ? "New benchtop order" : "Benchtop order") + (ref ? " " + ref : "") + " - Crosscuts";
  }

  function renderOrder() {
    setHead(mode === "new" ? "New benchtop order" : "Benchtop order");
    const sec = $("soOrder");
    sec.hidden = false;
    sec.replaceChildren(metaBlock(), formBlock(), actionsBlock(), revisionsBlock() || "");
    fillSuggestions();
    applyMarks();
  }

  // ---- actions ----

  async function run(fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  }

  // The server's order becomes the page's order.
  function adopt(o) {
    order = o;
    mode = "order";
    base = o.form || {};
    dirty = false;
    unsure = false;
    if (!/[?&]id=\d+/.test(location.search)) history.replaceState(null, "", "/stone.html?id=" + encodeURIComponent(o.id));
    renderOrder();
  }

  // Resolves true when the order on screen is the server's again.
  async function reloadOrder() {
    if (!order) return false;
    try {
      adopt(await call("/api/stone/" + encodeURIComponent(order.id)));
      return true;
    } catch (e) {
      // The page may be out of date: offer Reload rather than an editable stale copy's notes.
      unsure = true;
      renderActions();
      setMsg(failText(e), "err");
      return false;
    }
  }

  const UNSURE_NEW = "Couldn't reach the server, so it isn't known whether the draft was saved. Check the job's Benchtops section before saving again, so it isn't saved twice.";

  // A write failed on the network: it may have gone through, so the form stays as typed, nothing
  // claims it isn't saved, and Reload shows the order as the server has it.
  // `quiet`: a dialog is open (it keeps focus); the page behind is put right all the same.
  function markUnsure(quiet) {
    unsure = true;
    const typed = changedKeys().length > 0;
    const text = !order ? UNSURE_NEW
      : "Couldn't reach the server, so it isn't known whether that went through. Reload to see the order as it is now" + (typed ? "; it drops what's typed here that isn't saved." : ".");
    setMsg(text, "err");
    renderActions();
    if (!quiet) focusMsg();
  }

  async function reloadNow() {
    setMsg("Reloading...", "");
    if (await reloadOrder()) {
      setMsg("Reloaded: this is the order as it is saved now.", "ok");
      focusMsg();
    } else {
      setMsg("Still couldn't reach the server. Try Reload again.", "err");
      focusNode($("soReload")) || focusMsg();
    }
  }

  // After a 409: the order as the server has it now, the sentence by the buttons, focus on it.
  // `typed`: there were changes on screen that weren't saved (now dropped).
  async function afterConflict(text, typed) {
    marked = new Set();
    const ok = await reloadOrder();
    const sentence = String(text || "That didn't go through").trim().replace(/([^.!?])$/, "$1.");
    const said = sentence + (typed ? " Your unsaved changes weren't kept." : "");
    setMsg(ok ? said : said + " The order couldn't be reloaded: Reload to see it as it is now.", "err");
    focusMsg();
  }

  function patchBody() {
    const now = formNow();
    const body = {};
    for (const k of changedKeys()) body[k] = now[k];
    return body;
  }

  // Resolves true when saved (or there was nothing to save).
  async function save() {
    marked = new Set();
    applyMarks();
    const btn = $("soSave");
    if (btn) btn.disabled = true;
    setMsg("Saving...", "");
    try {
      if (!order) {
        const r = await call("/api/job-records/" + encodeURIComponent(job.id) + "/stone", { method: "POST", body: JSON.stringify(formNow()) });
        adopt(r);
        setMsg("Saved as a draft.", "ok");
        focusNode($("soSend")) || focusNode($("soSave"));
        return true;
      }
      const body = patchBody();
      if (!Object.keys(body).length) {
        if (btn) btn.disabled = false;
        setMsg("No changes to save.", "");
        return true;
      }
      const r = await call("/api/stone/" + encodeURIComponent(order.id), { method: "PATCH", body: JSON.stringify(body) });
      adopt(r);
      setMsg(r.changedSinceSent ? "Saved. Send revision " + (r.revision + 1) + " so the supplier has the changes." : "Saved.", "ok");
      focusNode($("soSend")) || focusNode($("soSave"));
      return true;
    } catch (e) {
      if (btn && btn.isConnected) btn.disabled = false;
      // No answer: the save may have gone through (B-m3).
      if (e instanceof TypeError) {
        markUnsure();
        return false;
      }
      // Cancelled, archived or changed since the page loaded (409): show the order as it is now
      // (B-m2); the changes typed here weren't saved.
      if (order && (e.status === 409 || /cancelled|archived/i.test(e.message || ""))) {
        await afterConflict(e.message, changedKeys().length > 0);
        return false;
      }
      refused(e.message, namedIn(e));
      for (const k of marked) if (focusField(k)) break;
      return false;
    }
  }

  // An answer the dialog can't fix (409): the dialog closes and the page reloads (B-m1). A network
  // failure is said inside the dialog (Try again is safe: the send carries expectUpdatedAt, so it
  // can't go twice) and, if the dialog is closed after it, the page offers Reload (B-m3).
  const NET_IN_DIALOG = "Couldn't reach the server, so it isn't known whether that went through. Try again, or close this and Reload.";

  async function sendOrder() {
    if (!order) return;
    const U = ui();
    const today = todayISO();
    const revs = Array.isArray(order.revisions) ? order.revisions : [];
    const last = revs.length ? revs[revs.length - 1] : null;
    const next = order.revision + 1;
    // Not before the last revision's sent date, or on a first send the day the order was started
    // (section 9.2, 12.16); never after today.
    const started = last ? null : sydneyDate(order.createdAt);
    const min = last ? last.sentDate : started && started <= today ? started : null;
    const minText = last ? "revision " + last.revision + " (" + fmtDate(last.sentDate) + ")"
      : min ? "the order was started (" + fmtDate(min) + ")" : "";
    const date = U.dateInput(today, min, today);
    const supplier = normText(valueOf("supplier"));
    const willSave = changedKeys().length > 0;
    let named = null;      // a refusal sentence from inside the dialog
    let netFail = false;   // the last try failed on the network
    let everNet = false;   // any try did
    const r = await U.dialog({
      title: sendLabel(),
      note: (supplier || "No supplier yet") + ": revision " + next + " of the stone order for " + (order.jobName || "this job") + ".",
      fields: [U.field("Date sent", date, {
        hint: "The date printed on the order. Not in the future" + (minText ? ", and not before " + minText + "." : "."),
      })],
      hint: willSave ? "Your changes are saved first, then revision " + next + " is frozen as sent." : "Revision " + next + " is frozen as sent, so it can be printed again exactly.",
      submit: sendLabel(),
      focus: date,
      run: async () => {
        if (!U.validDate(date.value)) throw new Error("Choose the date it was sent");
        if (date.value > today) throw new Error("The sent date can't be in the future");
        if (min && date.value < min) throw new Error("The sent date can't be before " + minText);
        netFail = false;
        let typed = changedKeys().length > 0;
        try {
          if (typed) {
            const saved = await call("/api/stone/" + encodeURIComponent(order.id), { method: "PATCH", body: JSON.stringify(patchBody()) });
            order = saved;
            base = saved.form || {};
            dirty = false;
            typed = false;
          }
          return await call("/api/stone/" + encodeURIComponent(order.id) + "/send", {
            method: "POST",
            body: JSON.stringify({ sentDate: date.value, expectUpdatedAt: order.updatedAt }),
          });
        } catch (e) {
          if (e instanceof TypeError) {
            netFail = true;
            markUnsure(true);
            everNet = true;
            throw new Error(NET_IN_DIALOG);
          }
          // Cancelled, archived, changed by someone else, or nothing to send: reload (B-m1).
          if (e && e.status === 409) return { conflict: e, typed };
          if (e && typeof e === "object") e.refused = true;
          named = e;
          marked = new Set(namedIn(e));
          applyMarks();
          throw e;
        }
      },
    });
    if (r && r.conflict) {
      await afterConflict(r.conflict.message, r.typed);
      // After a lost answer the 409 may be our own send having gone through: say what's there.
      if (everNet && order && order.revision >= next && order.status !== "cancelled") {
        const rv = (order.revisions || []).find((x) => x.revision === next);
        setMsg("Revision " + next + " is sent" + (rv ? ", " + fmtDate(rv.sentDate) + (rv.sentBy && rv.sentBy.name ? " by " + rv.sentBy.name : "") : "") + ".", "ok");
        focusMsg();
      }
      return;
    }
    if (!r) {
      if (netFail) markUnsure();
      return;
    }
    if (r.refused) {
      if (netFail) {
        markUnsure();
        return;
      }
      // Keep anything still unsaved on screen; otherwise show the order as the server has it now.
      if (changedKeys().length) {
        renderActions();
      } else {
        await reloadOrder();
      }
      if (named) refused(named.message, namedIn(named));
      else refused("That didn't send.", []);
      for (const k of marked) if (focusField(k)) return;
      focusNode($("soSend")) || focusMsg();
      return;
    }
    marked = new Set();
    adopt(r);
    setMsg((r.revision > 1 ? "Revision " + r.revision + " sent, " : "Marked sent: revision 1, ") + fmtDate(r.sentDate) + ".", "ok");
    focusNode($("soPrint")) || focusNode($("soTitle"));
  }

  async function cancelOrder() {
    if (!order) return;
    const U = ui();
    const supplier = normText(order.form && order.form.supplier);
    let netFail = false;
    const r = await U.dialog({
      title: "Cancel this stone order?",
      note: (supplier || "No supplier yet") + ", for " + (order.jobName || "this job") + ".",
      hint: "It stays on the job, marked cancelled, with its sent revisions. Restore brings it back." + (dirty ? " Your unsaved changes are dropped." : ""),
      submit: "Cancel order",
      cancel: "Keep order",
      submitClass: "hs-btn-stop",
      focus: "cancel",
      run: async () => {
        netFail = false;
        try {
          return await call("/api/stone/" + encodeURIComponent(order.id) + "/cancel", { method: "POST", body: "{}" });
        } catch (e) {
          if (e instanceof TypeError) {
            netFail = true;
            markUnsure(true);
            throw new Error(NET_IN_DIALOG);
          }
          if (e && e.status === 409) return { conflict: e };
          if (e && typeof e === "object") e.refused = true;
          throw e;
        }
      },
    });
    if (r && r.conflict) {
      await afterConflict(r.conflict.message, changedKeys().length > 0);
      return;
    }
    if (!r || r.refused) {
      if (netFail) markUnsure();
      else if (r) await reloadOrder();
      return;
    }
    marked = new Set();
    adopt(r);
    setMsg("Stone order cancelled.", "ok");
    focusNode($("soRestore")) || focusNode($("soTitle"));
  }

  async function restoreOrder() {
    if (!order) return;
    const btn = $("soRestore");
    if (btn) btn.disabled = true;
    setMsg("Restoring...", "");
    try {
      const r = await call("/api/stone/" + encodeURIComponent(order.id) + "/restore", { method: "POST", body: "{}" });
      adopt(r);
      setMsg(r.status === "sent" ? "Restored: sent, revision " + r.revision + "." : "Restored as a draft.", "ok");
      focusNode($("soSave")) || focusNode($("soTitle"));
    } catch (e) {
      if (btn && btn.isConnected) btn.disabled = false;
      if (e instanceof TypeError) markUnsure();
      else await afterConflict(e.message, false);
    }
  }

  // Leaving with unsaved changes asks first.
  window.addEventListener("beforeunload", (e) => {
    if (mode && editable() && changedKeys().length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  function headBack() {
    $("soHeadActions").replaceChildren(el("a", { class: "hs-btn hs-btn-quiet", href: "/stone.html", text: "All benchtop orders" }));
  }

  // ---- opening ----

  async function startNew(jobParam) {
    mode = "new";
    headBack();
    setHead("New benchtop order");
    if (!/^[1-9]\d*$/.test(jobParam || "")) {
      setStatus("That isn't a job. Start a stone order from its job's Benchtops section.", "err");
      return;
    }
    if (!can("jobs.edit")) {
      setStatus("Starting a stone order needs the Projects role. Open the job to see its stone orders.", "err");
      $("soHeadActions").prepend(el("a", { class: "hs-btn", href: "/job.html?id=" + encodeURIComponent(jobParam) + "#benchtops", text: "Open the job" }));
      return;
    }
    let d;
    try {
      d = await call("/api/job-records/" + encodeURIComponent(jobParam) + "/stone");
    } catch (e) {
      setStatus(/not found/i.test(e.message || "") ? "There is no job " + jobParam + "." : failText(e), "err");
      return;
    }
    job = d.job || { id: Number(jobParam), name: "" };
    if (job.archived) {
      setStatus("", "");
      setHead("New benchtop order");
      const sec = $("soOrder");
      sec.hidden = false;
      sec.replaceChildren(el("p", { class: "so-empty" }, "The job ", jobLink(job.id, job.name), " is archived, so it takes no new stone orders."));
      return;
    }
    others = (Array.isArray(d.orders) ? d.orders : []).filter((o) => o.status !== "cancelled").length;
    base = d.prefill || {};
    order = null;
    dirty = false;
    setStatus("", "");
    renderOrder();
    loadSuggestions();
    focusField("supplier");
  }

  async function startOrder(idParam) {
    mode = "order";
    headBack();
    setHead("Benchtop order");
    if (!/^[1-9]\d*$/.test(idParam || "")) {
      setStatus("That isn't a stone order. Open one from the list.", "err");
      return;
    }
    try {
      order = await call("/api/stone/" + encodeURIComponent(idParam));
    } catch (e) {
      setStatus(/not found/i.test(e.message || "") ? "There is no stone order " + idParam + "." : failText(e), "err");
      return;
    }
    base = order.form || {};
    dirty = false;
    setStatus("", "");
    renderOrder();
    if (editable()) loadSuggestions();
  }

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    const q = new URLSearchParams(location.search);
    if (q.has("id")) startOrder(q.get("id"));
    else if (q.has("job")) startNew(q.get("job"));
    else startList();
  })();
})();
