// Job cards on the Orders page (/orders.html, orders.view), 0.2.22 (docs/plans/jobcards-plan.md).
// A job card is a job's existing order lines (the `orders` table). This file builds the Job cards
// tab (GET /api/orders/cards), the open card below it (GET /api/orders?status=all&jobId=N), the
// New job card picker and the Add items dialog (POST /api/job-records/:id/orders/batch). The
// Edit dialog is OrderUI's (orderui.js), so every line rule stays where it was. Who may do what
// is decided by the server; the page only hides what a user can't use. Everything is set as text.
(function () {
  "use strict";
  const P = window.OrdersPage;
  if (!P) return;
  const { el, can, fmtDate, ORDER_STATUS, confirmDialog } = P;
  const $ = (id) => document.getElementById(id);
  const QTY_SENTENCE = "Quantity must be a number above 0 and up to 99999, with at most 2 decimals";

  const findEl = $("jcFind");
  const supEl = $("jcSupplier");
  const finEl = $("jcFinished");
  const gridEl = $("jcGrid");
  const panelEl = $("jcPanel");
  const countEl = $("jcCount");
  const msgEl = $("jcMessage");

  let cards = [];
  let seq = 0;
  let lineSeq = 0;
  let open = null; // the open card: {jobId, jobNumber, name, client, archived}
  let panelLines = null; // null while loading
  let panelError = "";
  let editing = false;

  function setMessage(text, kind) {
    msgEl.textContent = text || "";
    msgEl.className = "or-message " + (kind || "");
  }

  function fail(e) {
    return e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message;
  }

  function qtyText(q) {
    return window.OrderUI.fmtQty(q);
  }

  // ---------------------------------------------------------------- type-ahead ---

  // A suggestion list under a text input. o: {load(text) -> Promise<items>, render(li, item),
  // pick(item), minChars, openOnFocus, firstActive, flow}. Arrow keys and Enter pick; Escape
  // closes the list (and only the list). The input's parent must already hold the input.
  let taId = 0;
  function typeahead(input, o) {
    const id = "jc-ta-" + ++taId;
    const list = el("ul", { class: "jc-sugg" + (o.flow ? " jc-sugg-flow" : ""), role: "listbox", id, hidden: true });
    input.after(list);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", id);
    let items = [];
    let active = -1;
    let mine = 0;
    let timer = null;

    function close() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    }
    function mark() {
      [...list.children].forEach((li, i) => li.setAttribute("aria-selected", i === active ? "true" : "false"));
      if (active >= 0 && list.children[active]) {
        input.setAttribute("aria-activedescendant", list.children[active].id);
        list.children[active].scrollIntoView({ block: "nearest" });
      } else input.removeAttribute("aria-activedescendant");
    }
    function pick(item) {
      close();
      o.pick(item);
    }
    async function refresh() {
      const text = input.value.trim();
      const run = ++mine;
      if (text.length < (o.minChars || 0)) {
        close();
        return;
      }
      let res;
      try {
        res = await o.load(text);
      } catch (e) {
        res = { error: fail(e) };
      }
      if (run !== mine || document.activeElement !== input) return;
      if (res && res.error) {
        const li = el("li", { class: "jc-sugg-none", role: "option", "aria-disabled": "true", text: res.error });
        list.replaceChildren(li);
        items = [];
      } else {
        items = Array.isArray(res) ? res : [];
        if (!items.length) {
          if (o.noneText) list.replaceChildren(el("li", { class: "jc-sugg-none", role: "option", "aria-disabled": "true", text: o.noneText }));
          else {
            close();
            return;
          }
        } else {
          list.replaceChildren(...items.map((item, i) => {
            const li = el("li", { role: "option", id: id + "-" + i, "aria-selected": "false" });
            o.render(li, item);
            li.addEventListener("mousedown", (ev) => {
              ev.preventDefault();
              pick(item);
            });
            return li;
          }));
        }
      }
      active = items.length && o.firstActive ? 0 : -1;
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      mark();
    }

    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    });
    if (o.openOnFocus) input.addEventListener("focus", refresh);
    input.addEventListener("blur", () => {
      clearTimeout(timer);
      mine++;
      setTimeout(close, 120);
    });
    input.addEventListener("keydown", (ev) => {
      const isOpen = !list.hidden;
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        if (!isOpen) {
          refresh();
          return;
        }
        if (!items.length) return;
        ev.preventDefault();
        const step = ev.key === "ArrowDown" ? 1 : -1;
        active = active < 0 ? (step > 0 ? 0 : items.length - 1) : (active + step + items.length) % items.length;
        mark();
      } else if (ev.key === "Enter") {
        if (isOpen && active >= 0 && items[active]) {
          ev.preventDefault();
          pick(items[active]);
        }
      } else if (ev.key === "Escape") {
        if (isOpen) {
          ev.preventDefault();
          ev.stopPropagation();
          close();
        }
      }
    });
    return { close };
  }

  // ------------------------------------------------------------------- dialogs ---

  // A modal on the shell's cc-dialog frame. build(dlg, form, api) fills the form and returns
  // nothing; api.finish(result) closes the dialog with a result. Resolves with that result, or null.
  function modal(title, wide, build) {
    const opener = document.activeElement;
    return new Promise((resolve) => {
      let result = null;
      let sending = false;
      const dlg = el("dialog", { class: "cc-dialog jc-dialog" + (wide ? " jc-dialog-wide" : ""), "aria-label": title });
      const form = el("form", { class: "cc-dialog-form", novalidate: true, method: "dialog" }, el("h2", { class: "cc-dialog-title", text: title }));
      dlg.append(form);
      document.body.append(dlg);
      dlg.addEventListener("cancel", (e) => {
        if (sending) e.preventDefault();
      });
      dlg.addEventListener("close", () => {
        dlg.remove();
        if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
        resolve(result);
      });
      build(dlg, form, {
        finish(r) {
          result = r === undefined ? null : r;
          dlg.close();
        },
        busy(on) {
          sending = on;
        },
      });
      dlg.showModal();
    });
  }

  function field(label, input, cls) {
    const id = "jc-f-" + Math.random().toString(36).slice(2, 8);
    input.id = id;
    return el("div", { class: "cc-field " + (cls || "") }, el("label", { class: "cc-field-label", for: id, text: label }), input);
  }

  // ------------------------------------------------------ Add items (rows) ---

  function addItems(job) {
    const title = "Add items" + (job.jobNumber ? " · " + job.jobNumber : "") + " " + job.name;
    return modal(title, true, (dlg, form, ctl) => {
      const rows = [];
      const tbody = el("tbody");
      const sum = el("span", { class: "jc-sum" });
      const err = el("p", { class: "cc-dialog-error", role: "alert" });
      const cancel = el("button", { type: "button", class: "hs-btn", text: "Cancel" });
      const go = el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: "Add items" });
      go.disabled = true;

      const isFilled = (r) => !!(r.sup.value.trim() || r.desc.value.trim() || r.qty.value.trim());
      const supplierLoad = (text) => api("/api/orders/suppliers?q=" + encodeURIComponent(text));

      function addRow() {
        const sup = el("input", { class: "hs-input", type: "text", maxlength: "200", autocomplete: "off", placeholder: "Supplier", "aria-label": "Supplier" });
        const desc = el("input", { class: "hs-input", type: "text", maxlength: "500", autocomplete: "off", placeholder: "Hardware name", "aria-label": "Hardware" });
        const qty = el("input", { class: "hs-input jc-qty", type: "text", inputmode: "decimal", maxlength: "9", autocomplete: "off", placeholder: "1", "aria-label": "Qty" });
        const x = el("button", { type: "button", class: "jc-x", text: "×", "aria-label": "Remove row" });
        const tdSup = el("td", { class: "jc-ta-cell", "data-label": "Supplier" }, sup);
        const tr = el("tr", {}, tdSup, el("td", { "data-label": "Hardware" }, desc), el("td", { "data-label": "Qty" }, qty), el("td", { class: "jc-xcell" }, x));
        const r = { tr, sup, desc, qty, x };
        rows.push(r);
        tbody.append(tr);
        typeahead(sup, {
          openOnFocus: true,
          load: supplierLoad,
          render: (li, name) => (li.textContent = name),
          pick: (name) => {
            sup.value = name;
            desc.focus();
            update();
          },
        });
        x.addEventListener("click", () => {
          const at = rows.indexOf(r);
          rows.splice(at, 1);
          tr.remove();
          update();
          const next = rows[Math.min(at, rows.length - 1)];
          if (next) next.sup.focus();
        });
        return r;
      }

      function update() {
        if (!rows.length || isFilled(rows[rows.length - 1])) addRow();
        const last = rows[rows.length - 1];
        for (const r of rows) r.x.hidden = r === last;
        const n = rows.filter(isFilled).length;
        go.disabled = n === 0;
        go.textContent = n === 1 ? "Add 1 item" : n ? "Add " + n + " items" : "Add items";
        sum.replaceChildren(el("b", { text: n + (n === 1 ? " item" : " items") }), document.createTextNode(" to add, all To order"));
      }

      tbody.addEventListener("input", () => {
        err.textContent = "";
        for (const r of rows) for (const i of [r.sup, r.desc, r.qty]) i.removeAttribute("aria-invalid");
        update();
      });
      // Enter moves along the row instead of sending the form.
      tbody.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.defaultPrevented || !(e.target instanceof HTMLInputElement)) return;
        e.preventDefault();
        const inputs = rows.flatMap((r) => [r.sup, r.desc, r.qty]);
        const next = inputs[inputs.indexOf(e.target) + 1];
        if (next) next.focus();
      });

      const table = el(
        "table",
        { class: "jc-items" },
        el("thead", {}, el("tr", {}, el("th", { class: "jc-c-sup", text: "Supplier" }), el("th", { text: "Hardware" }), el("th", { class: "jc-c-qty jc-num", text: "Qty" }), el("th", { class: "jc-c-x" }, el("span", { class: "jc-sr", text: "Remove" })))),
        tbody
      );
      form.append(
        el("div", { class: "jc-itemswrap" }, table),
        el("p", { class: "cc-dialog-note" }, "A fresh row appears as you fill the last one. Supplier suggests names already used on orders and in Supplier accounts; a new name is fine and is kept for next time. Quantity is a number, whole or decimal (2.4 for metres)."),
        err,
        el("div", { class: "jc-dfoot" }, sum, el("div", { class: "cc-dialog-actions" }, cancel, go))
      );
      cancel.addEventListener("click", () => dlg.close());

      function bad(msg, input, rowNo) {
        err.textContent = (rowNo ? "Row " + rowNo + ": " : "") + msg;
        if (input) {
          input.setAttribute("aria-invalid", "true");
          input.focus();
        }
      }

      let sending = false;
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (sending) return;
        err.textContent = "";
        const filled = rows.filter(isFilled);
        if (!filled.length) return bad("Add at least one item");
        const lines = [];
        for (let i = 0; i < filled.length; i++) {
          const r = filled[i];
          const supplier = r.sup.value.trim();
          const description = r.desc.value.trim();
          const q = r.qty.value.trim();
          if (!supplier) return bad("Type the supplier", r.sup, i + 1);
          if (!description) return bad("Type the hardware name", r.desc, i + 1);
          if (!q) return bad("Type the quantity", r.qty, i + 1);
          if (!(/^\d+(\.\d{1,2})?$/.test(q) && Number(q) > 0 && Number(q) <= 99999)) return bad(QTY_SENTENCE, r.qty, i + 1);
          lines.push({ supplier, description, quantity: Number(q) });
        }
        sending = true;
        ctl.busy(true);
        for (const n of form.querySelectorAll("button, input")) n.disabled = true;
        let res;
        try {
          res = await api("/api/job-records/" + encodeURIComponent(job.jobId) + "/orders/batch", { method: "POST", body: JSON.stringify({ lines }) });
        } catch (ex) {
          sending = false;
          ctl.busy(false);
          for (const n of form.querySelectorAll("button, input")) n.disabled = false;
          go.disabled = false;
          err.textContent = ex instanceof TypeError ? "Couldn't reach the server. Try again." : ex.message;
          const m = /^Row (\d+)/.exec(err.textContent);
          const hit = m && filled[Number(m[1]) - 1];
          (hit ? hit.sup : go).focus();
          return;
        }
        ctl.finish({ count: lines.length, res });
      });

      addRow();
      update();
      setTimeout(() => rows[0].sup.focus(), 0);
    });
  }

  // After the Add items dialog: reload the cards and open this job's card.
  async function addItemsFlow(job) {
    const r = await addItems(job);
    if (!r) return;
    setMessage(r.count === 1 ? "1 item added to " + job.name + "." : r.count + " items added to " + job.name + ".", "ok");
    await loadCards();
    openCard(cardFor(job.jobId) || job);
    P.reloadLines();
  }

  // ---------------------------------------------------------- New job card ---

  async function newJobCard() {
    let has = new Set();
    try {
      const r = await api("/api/orders/cards?finished=1");
      has = new Set((r.cards || []).map((c) => c.jobId));
    } catch (e) {
      /* "Has a card" is a convenience */
    }
    const picked = await modal("New job card", false, (dlg, form, ctl) => {
      const input = el("input", { class: "hs-input", type: "text", autocomplete: "off", placeholder: "Job number, name or client" });
      const cancel = el("button", { type: "button", class: "hs-btn", text: "Cancel" });
      const box = field("Job", input, "jc-pickfield");
      form.append(
        box,
        el("p", { class: "cc-dialog-note", text: 'Type the job number, name or client and pick from our jobs. A job that already has a card shows "Has a card": picking it adds to that card.' }),
        el("div", { class: "cc-dialog-actions" }, cancel)
      );
      cancel.addEventListener("click", () => dlg.close());
      typeahead(input, {
        flow: true,
        firstActive: true,
        minChars: 1,
        noneText: "No open jobs match.",
        load: async (text) => {
          const res = await api("/api/job-records?q=" + encodeURIComponent(text));
          return (Array.isArray(res) ? res : []).filter((j) => !j.archived).slice(0, 10);
        },
        render: (li, j) => {
          if (j.jobNumber) li.append(el("span", { class: "jc-jno", text: j.jobNumber }));
          li.append(el("span", { class: "jc-sname", text: j.name }));
          if (j.clientName) li.append(el("span", { class: "jc-sclient", text: j.clientName }));
          if (has.has(j.id)) li.append(el("span", { class: "jc-has", text: "Has a card" }));
        },
        pick: (j) => ctl.finish({ jobId: j.id, jobNumber: j.jobNumber || null, name: j.name, client: j.clientName || null }),
      });
      form.addEventListener("submit", (e) => e.preventDefault());
      setTimeout(() => input.focus(), 0);
    });
    if (picked) addItemsFlow(picked);
  }

  // ----------------------------------------------------------------- the cards ---

  function cardFor(jobId) {
    return cards.find((c) => c.jobId === jobId) || null;
  }

  function fillSuppliers() {
    const keep = supEl.value;
    const seen = new Map();
    for (const c of cards) for (const s of c.suppliers || []) if (!seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
    const names = [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    supEl.replaceChildren(el("option", { value: "", text: "All suppliers" }), ...names.map((s) => el("option", { value: s, text: s })));
    supEl.value = names.includes(keep) ? keep : "";
  }

  function visibleCards() {
    const words = findEl.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const sup = supEl.value.toLowerCase();
    return cards.filter((c) => {
      const hay = [c.jobNumber, c.name, c.client].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => hay.includes(w)) && (!sup || (c.suppliers || []).some((s) => s.toLowerCase() === sup));
    });
  }

  function cardNode(c) {
    const selected = !!open && open.jobId === c.jobId;
    const node = el(
      "div",
      { class: "jc-card" + (selected ? " jc-sel" : ""), role: "button", tabindex: "0", "data-job": String(c.jobId), "aria-pressed": selected ? "true" : "false",
        "aria-label": "Open the card for " + (c.jobNumber ? c.jobNumber + " " : "") + c.name },
      c.jobNumber ? el("div", { class: "jc-jno", text: c.jobNumber + (c.archived ? " (archived)" : "") }) : c.archived ? el("div", { class: "jc-jno", text: "Archived" }) : null,
      el("div", { class: "jc-jname", text: c.name }),
      c.client ? el("div", { class: "jc-client", text: c.client }) : null,
      el(
        "div",
        { class: "jc-counts" },
        el("span", { class: c.toOrder > 0 ? "jc-att" : "" }, el("b", { text: String(c.toOrder) }), "to order"),
        el("span", {}, el("b", { text: String(c.ordered) }), "ordered"),
        el("span", {}, el("b", { text: String(c.received) }), "received")
      ),
      (c.suppliers || []).length ? el("div", { class: "jc-sups", text: c.suppliers.join(", ") }) : null
    );
    return node;
  }

  function renderCards() {
    const shown = visibleCards();
    gridEl.replaceChildren(...shown.map(cardNode));
    if (!cards.length) countEl.textContent = finEl.checked ? "No job cards yet." : "Nothing is waiting to be ordered or delivered. Use New job card to start one.";
    else if (!shown.length) countEl.textContent = "No job cards match.";
    else countEl.textContent = shown.length + (shown.length === 1 ? " job card" : " job cards");
  }

  async function loadCards() {
    const mine = ++seq;
    let res;
    try {
      res = await api("/api/orders/cards?finished=" + (finEl.checked ? "1" : "0"));
    } catch (e) {
      if (mine !== seq) return null;
      countEl.textContent = "";
      setMessage(fail(e), "err");
      return false;
    }
    if (mine !== seq) return null;
    cards = Array.isArray(res && res.cards) ? res.cards : [];
    fillSuppliers();
    renderCards();
    if (open) {
      const c = cardFor(open.jobId);
      if (c) open = c;
      renderPanel();
    }
    return true;
  }

  gridEl.addEventListener("click", (e) => {
    const n = e.target.closest && e.target.closest(".jc-card");
    if (!n) return;
    const c = cardFor(Number(n.getAttribute("data-job")));
    if (c) openCard(c);
  });
  gridEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const n = e.target.closest && e.target.closest(".jc-card");
    if (!n || e.target !== n) return;
    e.preventDefault();
    n.click();
  });
  findEl.addEventListener("input", () => {
    renderCards();
  });
  supEl.addEventListener("change", () => {
    setMessage("", "");
    renderCards();
  });
  finEl.addEventListener("change", () => {
    setMessage("", "");
    loadCards();
  });

  // ---------------------------------------------------------------- open card ---

  function statusOf(o) {
    let [label, badge] = ORDER_STATUS[o.status] || [o.status, "hs-badge-na"];
    if (o.status === "to_order" && o.reservedFromStock) [label, badge] = ["Reserved from stock", "hs-badge-teal"];
    else if (o.status === "to_order" && o.reservedQty > 0) label = qtyText(o.reservedQty) + " reserved from stock, rest to order";
    return [label, badge];
  }

  function lineName(o) {
    return (o.jobName ? o.jobName + ": " : "") + (o.supplier || "No supplier yet") + (o.description ? ", " + o.description : "");
  }

  function dash() {
    return el("span", { class: "jc-dash", text: "–" });
  }

  function cell(label, cls, ...kids) {
    return el("td", { class: cls || null, "data-label": label }, ...kids);
  }

  function dateCell(label, iso, extra) {
    return cell(label, "jc-date" + (extra ? " " + extra : ""), iso ? document.createTextNode(fmtDate(iso)) : dash());
  }

  // 0.2.23: the saved order this line is on (its latest), as a link that opens it. None: blank.
  function poCell(o) {
    if (!o.poId || !o.poNumber) return cell("Order", "jc-blank", dash());
    const a = el("a", { class: "po-link", href: "/orders.html?po=" + encodeURIComponent(o.poId), text: o.poNumber });
    a.addEventListener("click", (e) => {
      if (!window.SupplierOrders || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      P.showView("pos");
      window.SupplierOrders.open(o.poId);
    });
    return cell("Order", "jc-date", a);
  }

  function renderPanel() {
    if (!open) {
      panelEl.hidden = true;
      panelEl.replaceChildren();
      return;
    }
    const mayEdit = can("orders.edit") && !open.archived;
    const heading = el("h2", { class: "jc-ptitle", id: "jcPTitle", tabindex: "-1", text: open.name });
    const sub = el("div", { class: "jc-client" });
    if (open.client) sub.append(document.createTextNode(open.client));
    if (can("jobs.view")) {
      if (open.client) sub.append(document.createTextNode(" · "));
      sub.append(el("a", { class: "jc-joblink", href: "/job.html?id=" + encodeURIComponent(open.jobId) + "#orders", text: "Open the job" }));
    }
    const buttons = el("div", { class: "jc-pbtns" });
    if (mayEdit) buttons.append(el("button", { type: "button", class: "hs-btn hs-btn-primary", "data-jc": "add", text: "Add items" }));
    if (mayEdit) buttons.append(el("button", { type: "button", class: "hs-btn hs-btn-stop", "data-jc": "delcard", text: "Delete card" }));
    buttons.append(
      el("button", { type: "button", class: "hs-btn", "data-jc": "print", text: "Print card" }),
      el("button", { type: "button", class: "hs-btn hs-btn-quiet", "data-jc": "close", text: "Close" })
    );
    const head = el("div", { class: "jc-phead" }, el("div", {}, open.jobNumber ? el("div", { class: "jc-jno", text: open.jobNumber }) : null, heading, sub), buttons);

    let body;
    if (panelError) body = el("p", { class: "or-message err", text: panelError });
    else if (panelLines === null) body = el("p", { class: "jc-pnote", text: "Loading..." });
    else if (!panelLines.length) body = el("p", { class: "jc-pnote", text: "No order lines on this card." });
    else {
      const tb = el("tbody");
      for (const o of panelLines) {
        const [label, badge] = statusOf(o);
        const hw = cell("Hardware", "jc-text", el("span", { text: o.description || "" }));
        const kind = window.OrderUI.kindLabel(o);
        if (kind) hw.append(kind);
        const overdue = o.overdue;
        const exp = dateCell("Expected", o.expectedDate, overdue ? "jc-overdue" : "");
        if (overdue) exp.append(el("span", { class: "jc-overdue-tag", text: "Overdue" }));
        const notes = cell("Notes", "jc-text jc-notes");
        if (o.notes) notes.append(el("span", { text: o.notes }));
        const dn = window.OrderUI.noteBlock(o);
        if (dn) notes.append(dn);
        if (!o.notes && !dn) notes.classList.add("jc-blank");
        const may = window.OrderUI.actions(o);
        const act = cell("", "jc-acts");
        if (may.edit) act.append(el("button", { type: "button", class: "hs-btn hs-btn-quiet", "data-act": "edit", "data-id": String(o.id), "aria-label": "Edit: " + lineName(o), text: "Edit" }));
        // 0.2.23: a To order line can be deleted (soft; the server refuses anything ordered or received).
        if (mayEdit && o.status === "to_order") act.append(el("button", { type: "button", class: "hs-btn hs-btn-stop", "data-act": "delete", "data-id": String(o.id), "aria-label": "Delete line: " + lineName(o), text: "Delete" }));
        if (!act.childElementCount) act.classList.add("jc-blank");
        tb.append(el(
          "tr",
          { "data-id": String(o.id) },
          cell("Supplier", "jc-sup", el("span", { text: o.supplier || "No supplier yet" })),
          hw,
          cell("Qty", "jc-num" + (o.quantity == null ? " jc-blank" : ""), document.createTextNode(qtyText(o.quantity))),
          cell("Status", "", el("span", { class: "hs-badge " + badge, text: label })),
          dateCell("Ordered", o.orderedDate),
          poCell(o),
          exp,
          dateCell("Received", o.receivedDate),
          notes,
          act
        ));
      }
      body = el(
        "div",
        { class: "jc-pwrap" },
        el(
          "table",
          { class: "hs-table jc-table" },
          el("thead", {}, el("tr", {}, ...["Supplier", "Hardware", "Qty", "Status", "Ordered", "Order", "Expected", "Received", "Notes", ""].map((h) =>
            el("th", { scope: "col", class: h === "Qty" ? "jc-num" : null }, h ? h : el("span", { class: "jc-sr", text: "Actions" }))))),
          tb
        )
      );
    }
    panelEl.replaceChildren(head, body);
    panelEl.setAttribute("aria-labelledby", "jcPTitle");
    panelEl.hidden = false;
  }

  async function loadPanelLines() {
    if (!open) return;
    const mine = ++lineSeq;
    const jobId = open.jobId;
    let list;
    try {
      list = await api("/api/orders?status=all&jobId=" + encodeURIComponent(jobId));
    } catch (e) {
      if (mine !== lineSeq) return false;
      panelError = fail(e);
      renderPanel();
      return false;
    }
    if (mine !== lineSeq || !open || open.jobId !== jobId) return null;
    panelError = "";
    panelLines = (Array.isArray(list) ? list : []).filter((o) => o.status !== "cancelled");
    // A job opened without a card (a link, or just after adding) learns its names from its lines.
    if (panelLines.length && !open.name) open = { ...open, name: panelLines[0].jobName };
    renderPanel();
    return true;
  }

  async function openCard(job, opts) {
    open = { jobId: job.jobId, jobNumber: job.jobNumber || null, name: job.name || "", client: job.client || null, archived: !!job.archived };
    panelLines = null;
    panelError = "";
    for (const n of gridEl.children) {
      const on = Number(n.getAttribute("data-job")) === open.jobId;
      n.classList.toggle("jc-sel", on);
      n.setAttribute("aria-pressed", on ? "true" : "false");
    }
    renderPanel();
    if (!opts || !opts.quiet) {
      panelEl.scrollIntoView({ block: "start" });
      const h = $("jcPTitle");
      if (h) h.focus({ preventScroll: true });
    }
    await loadPanelLines();
  }

  function closeCard() {
    const was = open;
    open = null;
    panelLines = null;
    renderPanel();
    renderCards();
    const n = was && gridEl.querySelector('.jc-card[data-job="' + was.jobId + '"]');
    if (n) n.focus();
  }

  // 0.2.23: delete a To order line, or the whole card (every line still To order). Soft deletes on
  // the server (lib/orders.js), which decides; the confirm names what goes.
  function jobTitle(j) {
    return (j.jobNumber ? j.jobNumber + " " : "") + (j.name || "");
  }

  async function deleteLine(b) {
    if (editing) return;
    const id = Number(b.getAttribute("data-id"));
    const line = (panelLines || []).find((l) => l.id === id);
    if (!line) return;
    editing = true;
    try {
      const ok = await confirmDialog("Delete this order line?", lineName(line) + ". It is removed from the job card and the job. Only an administrator can restore it.", "Delete line", "Keep line");
      if (!ok) return;
      for (const n of panelEl.querySelectorAll("button")) n.disabled = true;
      try {
        await api("/api/orders/" + encodeURIComponent(id) + "/delete", { method: "POST", body: "{}" });
      } catch (e) {
        setMessage(fail(e), "err");
        await Promise.all([loadPanelLines(), loadCards()]);
        return;
      }
      setMessage("Deleted: " + lineName(line) + ".", "ok");
      await Promise.all([loadPanelLines(), loadCards()]);
      P.reloadLines();
      const first = panelEl.querySelector("button[data-act]");
      if (first) first.focus();
      else {
        const h = $("jcPTitle");
        if (h) h.focus({ preventScroll: true });
      }
    } finally {
      editing = false;
      renderPanel();
    }
  }

  async function deleteCard(b) {
    if (editing || !open || !panelLines) return;
    const job = open;
    const toOrder = panelLines.filter((l) => l.status === "to_order").length;
    editing = true;
    try {
      const title = jobTitle(job);
      const ok = await confirmDialog(
        "Delete this card?",
        (panelLines.length === 1
          ? "The 1 item on the card for " + title + " will be deleted. Only an administrator can restore it."
          : "All " + panelLines.length + " items on the card for " + title + " will be deleted. Only an administrator can restore them."),
        "Delete card",
        "Keep card"
      );
      if (!ok) return;
      let onlyToOrder = false;
      let r;
      for (;;) {
        try {
          r = await api("/api/job-records/" + encodeURIComponent(job.jobId) + "/orders/delete-card", { method: "POST", body: JSON.stringify(onlyToOrder ? { onlyToOrder: true } : {}) });
          break;
        } catch (e) {
          if (onlyToOrder || e instanceof TypeError || toOrder < 1) {
            setMessage(fail(e), "err");
            return;
          }
          const again = await confirmDialog(
            e.message,
            "Undo ordered first on those items to delete the whole card, or delete only the items still to order.",
            "Delete the " + toOrder + " To order " + (toOrder === 1 ? "item" : "items") + " instead",
            "Keep card"
          );
          if (!again) {
            setMessage(e.message, "err");
            return;
          }
          onlyToOrder = true;
        }
      }
      const count = r && Number.isFinite(r.count) ? r.count : onlyToOrder ? toOrder : panelLines.length;
      setMessage("Deleted " + count + (count === 1 ? " item" : " items") + " from " + title + ".", "ok");
      open = null;
      panelLines = null;
      renderPanel();
      await loadCards();
      P.reloadLines();
      const h = $("jcCount");
      if (h) h.scrollIntoView({ block: "start" });
    } finally {
      editing = false;
    }
  }

  // The card's buttons and its Edit.
  panelEl.addEventListener("click", async (e) => {
    const b = e.target.closest && e.target.closest("button");
    if (!b || b.disabled || !open) return;
    const jc = b.getAttribute("data-jc");
    if (jc === "close") return closeCard();
    if (jc === "print") {
      window.open("/orderprint.html?mode=card&job=" + encodeURIComponent(open.jobId), "_blank");
      return;
    }
    if (jc === "add") {
      addItemsFlow(open);
      return;
    }
    if (jc === "delcard") return deleteCard(b);
    if (b.getAttribute("data-act") === "delete") return deleteLine(b);
    if (b.getAttribute("data-act") === "edit") {
      if (editing) return;
      const id = Number(b.getAttribute("data-id"));
      const line = (panelLines || []).find((l) => l.id === id);
      if (!line) return;
      editing = true;
      try {
        const r = await window.OrderUI.edit(line);
        if (!r) return;
        if (!r.refused) setMessage("Saved: " + lineName(line) + ".", "ok");
        await Promise.all([loadPanelLines(), loadCards()]);
        P.reloadLines();
        const again = panelEl.querySelector('button[data-act="edit"][data-id="' + id + '"]');
        if (again) again.focus();
      } finally {
        editing = false;
      }
    }
  });

  // ------------------------------------------------------------------- start ---

  function reload() {
    return loadCards().then(() => loadPanelLines());
  }

  // ?job=N: that job's card on this tab when it has one, else today's filtered line list.
  async function startWithJob(jobId) {
    let found = null;
    try {
      const r = await api("/api/orders/cards?finished=1");
      found = (r.cards || []).find((c) => c.jobId === jobId) || null;
    } catch (e) {
      found = null;
    }
    if (found && found.finished) finEl.checked = true;
    await loadCards();
    if (found) openCard(cardFor(jobId) || found, { quiet: false });
    else P.showView("lines");
  }

  // typeahead, modal and field are shared with stockorders.js (the Stock section above the cards).
  window.JobCards = { reload, setMessage, openCard, cardFor, ui: { typeahead, modal, field } };
  P.onShow("cards", reload);

  $("jcNew").addEventListener("click", newJobCard);

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    $("jcNew").hidden = !(can("orders.edit") && can("jobs.view")); // the job picker needs jobs.view (GET /api/job-records?q=)
    if (P.jobFilter) await startWithJob(P.jobFilter);
    else await loadCards();
  })();
})();
