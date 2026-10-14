// Orders page (/orders.html, orders.view): the supplier order lines across jobs. Talks to
// /api/orders (routes/orders.js; docs/plans/m3-contracts.md section 4 and m10-contracts.md
// sections 4 and 9.2). The Received, Delivery note, Undo received and Edit dialogs are OrderUI's
// (orderui.js); Mark ordered, its Undo and Cancel are built here. Who may do what is decided by
// the server (lib/orders.js); the page only hides what a user can't use.
(function () {
  "use strict";

  // Permissions come from the shell (window.cc.can); the page waits for cc.ready before it
  // builds any control. Without the shell nothing is offered.
  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

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

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  const ORDER_STATUS = {
    to_order: ["To order", "hs-badge-check"],
    ordered: ["Ordered", "hs-badge-teal"],
    received: ["Received", "hs-badge-go"],
    cancelled: ["Cancelled", "hs-badge-na"],
  };

  // The buttons a line may get, in the order they show. `dialog` ones open OrderUI; the rest are
  // built here. `next` is where focus goes on the same line after the action (the first that is
  // there after the reload), else the row.
  const ACTS = [
    { id: "markOrdered", label: "Mark ordered", primary: true, next: ["receive", "undoOrdered", "note", "edit"] },
    { id: "receive", label: "Received", primary: true, dialog: true, next: ["undoReceived", "note", "edit"] },
    { id: "note", label: "Delivery note", dialog: true, next: ["note"] },
    { id: "edit", label: "Edit", dialog: true, next: ["edit"] },
    { id: "undoOrdered", label: "Undo ordered", next: ["markOrdered", "edit"] },
    { id: "undoReceived", label: "Undo received", dialog: true, next: ["receive", "note", "edit"] },
    { id: "cancel", label: "Cancel", aria: "Cancel line", next: [] },
  ];
  const ACT = Object.fromEntries(ACTS.map((a) => [a.id, a]));

  const statusEl = document.getElementById("status");
  const supplierEl = document.getElementById("supplier");
  const countEl = document.getElementById("count");
  const messageEl = document.getElementById("message");
  const rowsEl = document.getElementById("rows");
  const emptyEl = document.getElementById("empty");
  const actionsHead = document.getElementById("actionsHead");

  let lines = [];
  let seq = 0; // the newest list request wins
  let busy = false;

  function setMessage(msg, kind) {
    messageEl.textContent = msg || "";
    messageEl.className = "or-message " + (kind || "");
  }

  function lineName(o) {
    return o.jobName + ": " + o.supplier + (o.description ? ", " + o.description : "");
  }

  function showActions() {
    return can("orders.edit") || can("orders.mark_ordered") || can("orders.receive");
  }

  // A modal on the shell's cc-dialog frame. Resolves true only when the confirm button is pressed.
  // Red is for this destructive confirm. Focus goes back to the opener when it is kept.
  function confirmDialog(title, note, confirmLabel, keepLabel) {
    const opener = document.activeElement;
    return new Promise((resolve) => {
      let answer = false;
      const dlg = el("dialog", { class: "cc-dialog or-dialog", "aria-label": title });
      const keep = el("button", { type: "button", class: "hs-btn", text: keepLabel });
      const yes = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: confirmLabel });
      keep.addEventListener("click", () => dlg.close());
      yes.addEventListener("click", () => {
        answer = true;
        dlg.close();
      });
      dlg.append(
        el(
          "div",
          { class: "cc-dialog-form" },
          el("h2", { class: "cc-dialog-title", text: title }),
          el("p", { class: "cc-dialog-note", text: note }),
          el("div", { class: "cc-dialog-actions" }, keep, yes)
        )
      );
      document.body.append(dlg);
      dlg.addEventListener("mousedown", (e) => {
        if (e.target === dlg) dlg.close();
      });
      dlg.addEventListener("close", () => {
        dlg.remove();
        if (!answer && opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
        resolve(answer);
      });
      dlg.showModal();
      keep.focus();
    });
  }

  function jobCell(o) {
    if (!can("jobs.view")) return el("td", { class: "or-job" }, el("span", { class: "or-jobname", text: o.jobName }));
    return el("td", { class: "or-job" }, el("a", { href: "/job.html?id=" + encodeURIComponent(o.jobId) + "#orders", text: o.jobName }));
  }

  function render() {
    const acts = showActions();
    actionsHead.hidden = !acts;
    rowsEl.replaceChildren();
    emptyEl.hidden = lines.length > 0;
    if (!lines.length) emptyEl.textContent = statusEl.value === "open" ? "Nothing to order or waiting on delivery." : "No order lines match.";
    countEl.textContent = lines.length + (lines.length === 1 ? " line" : " lines");
    for (const o of lines) {
      const [label, badge] = ORDER_STATUS[o.status] || [o.status, "hs-badge-na"];
      const expected = el("td", { class: "or-date" + (o.overdue ? " or-overdue" : "") });
      if (o.expectedDate) expected.append(document.createTextNode(fmtDate(o.expectedDate)));
      if (o.overdue) expected.append(el("span", { class: "or-overdue-tag", text: "Overdue" }));
      const received = el("td", { class: "or-date" });
      if (o.receivedDate) received.append(document.createTextNode(fmtDate(o.receivedDate)));
      if (o.receivedDate && o.receivedBy && o.receivedBy.name) received.append(el("span", { class: "or-by", text: o.receivedBy.name }));
      const desc = el("td", { class: "or-text" }, el("span", { text: o.description || "" }));
      const kind = window.OrderUI.kindLabel(o);
      if (kind) desc.append(kind);
      const note = window.OrderUI.noteBlock(o);
      if (note) desc.append(note);
      const tr = el(
        "tr",
        { class: o.status === "cancelled" ? "or-cancelled" : "", "data-id": String(o.id), tabindex: "-1" },
        jobCell(o),
        el("td", { class: "or-supplier", text: o.supplier }),
        desc,
        el("td", {}, el("span", { class: "hs-badge " + badge, text: label })),
        expected,
        el("td", { class: "or-date", text: fmtDate(o.orderedDate) }),
        received,
        el("td", { class: "or-text", text: o.notes })
      );
      if (acts) {
        const may = window.OrderUI.actions(o);
        const box = el("div", { class: "or-actbox" });
        for (const a of ACTS) {
          if (!may[a.id]) continue;
          box.append(el("button", {
            type: "button",
            class: "hs-btn" + (a.primary ? " hs-btn-primary" : ""),
            "data-act": a.id,
            "data-id": String(o.id),
            "aria-label": (a.aria || a.label) + ": " + lineName(o),
            text: a.label,
          }));
        }
        if (may.link) box.append(el("a", { class: "hs-btn", href: may.link.href, text: may.link.text }));
        tr.append(el("td", { class: "or-acts" }, box));
      }
      rowsEl.append(tr);
    }
  }

  async function loadSuppliers() {
    try {
      const list = await api("/api/orders/suppliers");
      const keep = supplierEl.value;
      supplierEl.replaceChildren(el("option", { value: "", text: "All suppliers" }), ...list.map((s) => el("option", { value: s, text: s })));
      supplierEl.value = list.includes(keep) ? keep : "";
    } catch (e) {
      /* the filter is a convenience */
    }
  }

  // Resolves true when the list was replaced (and rendered), false when it failed (its sentence
  // shown), null when a newer request took over.
  async function load() {
    const mine = ++seq;
    const qs = new URLSearchParams({ status: statusEl.value });
    if (supplierEl.value) qs.set("supplier", supplierEl.value);
    let list;
    try {
      list = await api("/api/orders?" + qs);
    } catch (e) {
      if (mine !== seq) return null;
      countEl.textContent = "";
      setMessage(e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message, "err");
      return false;
    }
    if (mine !== seq) return null;
    lines = list;
    render();
    return true;
  }

  // ------------------------------------------------------------------- focus ---

  function button(id, act) {
    return rowsEl.querySelector(`button[data-act="${act}"][data-id="${id}"]`);
  }
  function row(id) {
    return rowsEl.querySelector(`tr[data-id="${id}"]`);
  }
  function focusNode(n) {
    if (!n) return false;
    n.focus();
    return document.activeElement === n;
  }
  // A row's first button, or the row itself.
  function focusRow(id) {
    const tr = row(id);
    if (!tr) return false;
    return focusNode(tr.querySelector("button[data-act]")) || focusNode(tr);
  }

  // After a reload: the same line's next action, or its row; when the line has left the list
  // (the filter), the next line's first action or row, then the one before; else the heading.
  function focusAfter(id, act, before) {
    for (const next of ACT[act].next) if (focusNode(button(id, next))) return;
    if (focusNode(row(id))) return;
    const at = before.indexOf(id);
    for (const other of before.slice(at + 1).concat(before.slice(0, Math.max(at, 0)).reverse())) {
      if (focusRow(other)) return;
    }
    focusNode(document.getElementById("orTitle"));
  }

  // ----------------------------------------------------------------- actions ---

  function said(act, o, r) {
    const name = lineName(o);
    const after = (r && r.order) || {};
    switch (act) {
      case "markOrdered": return "Marked ordered: " + name + ".";
      case "undoOrdered": return "Back to To order: " + name + ".";
      case "receive": return "Received: " + name + ".";
      case "note": return (after.deliveryNote ? "Delivery note saved: " : "Delivery note cleared: ") + name + ".";
      case "undoReceived": return "Back to ordered: " + name + ".";
      case "edit": return "Saved: " + name + ".";
      case "cancel": return "Line cancelled: " + name + ".";
      default: return "Saved.";
    }
  }

  // Reloads after an action. When the reload fails, the list on screen is drawn again (with the
  // changed line from the response, `r`, and with the buttons a one-click action disabled
  // working again) and the reload's sentence follows `said`.
  async function reloadAfter(said, kind, r) {
    setMessage(said, kind);
    if ((await load()) !== false) return;
    const why = messageEl.textContent;
    const after = r && r.order;
    if (after) lines = lines.map((l) => (l.id === after.id ? Object.assign({}, l, after) : l));
    render();
    setMessage(said ? said + " " + why : why, "err");
  }

  async function run(act, id) {
    if (busy) return;
    const o = lines.find((l) => l.id === id);
    if (!o || !ACT[act]) return;
    busy = true;
    try {
      const before = lines.map((l) => l.id);
      let r;
      if (ACT[act].dialog) {
        r = await window.OrderUI[act](o);
        if (!r) return; // cancelled: OrderUI puts focus back on the button
        if (r.refused) {
          // Refused (its sentence was in the dialog): the line may have changed elsewhere, so show
          // it as it is now, with focus back on the same button if the line still has it.
          await reloadAfter("", "");
          if (!focusNode(button(id, act))) focusAfter(id, act, before);
          return;
        }
      } else {
        if (act === "cancel") {
          const ok = await confirmDialog("Cancel this order line?", lineName(o) + ". The line stays on the job, marked cancelled.", "Cancel line", "Keep line");
          if (!ok) return;
        }
        for (const b of rowsEl.querySelectorAll("button")) b.disabled = true;
        setMessage("Saving...", "");
        try {
          if (act === "cancel") r = await api("/api/orders/" + encodeURIComponent(o.id) + "/cancel", { method: "POST", body: "{}" });
          else {
            const body = act === "markOrdered" ? { status: "ordered" } : { status: "to_order" };
            r = await api("/api/orders/" + encodeURIComponent(o.id), { method: "PATCH", body: JSON.stringify(body) });
          }
        } catch (e) {
          await reloadAfter(e instanceof TypeError ? "Couldn't reach the server. Try again." : e.message, "err");
          if (!focusNode(button(id, act))) focusAfter(id, act, before);
          return;
        }
      }
      await reloadAfter(said(act, o, r), "ok", r);
      focusAfter(id, act, before);
    } finally {
      busy = false;
    }
  }

  rowsEl.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-act]");
    if (!b || b.disabled) return;
    run(b.getAttribute("data-act"), Number(b.getAttribute("data-id")));
  });

  statusEl.addEventListener("change", () => {
    setMessage("", "");
    load();
  });
  supplierEl.addEventListener("change", () => {
    setMessage("", "");
    load();
  });

  // --------------------------------------------------------------------- start ---
  // Job links and buttons depend on the user's keys, so the first render waits for the shell.
  (async () => {
    const ready = window.cc && window.cc.ready ? window.cc.ready : Promise.resolve();
    loadSuppliers();
    await ready;
    load();
  })();
})();
