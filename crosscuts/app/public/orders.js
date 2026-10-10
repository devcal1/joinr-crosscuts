// Orders page: the supplier order lines across jobs. Talks to /api/orders
// (see routes/orders.js and docs/plans/m3-contracts.md section 4).
(function () {
  // Permissions come from the shell (window.cc.can). Without it, assume allowed:
  // the server enforces everything regardless.
  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : true;
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

  const statusEl = document.getElementById("status");
  const supplierEl = document.getElementById("supplier");
  const countEl = document.getElementById("count");
  const messageEl = document.getElementById("message");
  const rowsEl = document.getElementById("rows");
  const emptyEl = document.getElementById("empty");
  const actionsHead = document.getElementById("actionsHead");

  let lines = [];
  let loaded = false;
  let seq = 0; // the newest list request wins

  function setMessage(msg, kind) {
    messageEl.textContent = msg || "";
    messageEl.className = "or-message " + (kind || "");
  }

  // Which buttons a line gets: the permission table in m3-contracts.md section 2. The server checks too.
  function lineActions(o) {
    const acts = [];
    if (o.status === "to_order" && can("orders.mark_ordered")) {
      acts.push({ label: "Mark ordered", patch: { status: "ordered" }, done: "Marked ordered", primary: true });
    }
    if (o.status === "ordered") {
      if (can("orders.edit")) acts.push({ label: "Received", patch: { status: "received" }, done: "Marked received", primary: true });
      if (can("orders.mark_ordered")) acts.push({ label: "Undo", patch: { status: "to_order" }, done: "Moved back to To order" });
    }
    if (o.status === "received" && can("orders.edit")) {
      acts.push({ label: "Undo", patch: { status: "ordered" }, done: "Moved back to Ordered" });
    }
    if (o.status !== "cancelled" && can("orders.edit")) acts.push({ label: "Cancel", cancel: true, done: "Line cancelled" });
    return acts;
  }

  // A modal on the shell's cc-dialog frame. Resolves true only when the confirm button is pressed.
  // Red is for this destructive confirm.
  function confirmDialog(title, note, confirmLabel, keepLabel) {
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
        resolve(answer);
      });
      dlg.showModal();
    });
  }

  function render() {
    // Read-only without orders.edit or orders.mark_ordered: no Actions column at all.
    const showActions = can("orders.edit") || can("orders.mark_ordered");
    actionsHead.hidden = !showActions;
    rowsEl.replaceChildren();
    emptyEl.hidden = lines.length > 0;
    if (!lines.length) emptyEl.textContent = statusEl.value === "open" ? "Nothing to order or waiting on delivery." : "No order lines match.";
    countEl.textContent = lines.length + (lines.length === 1 ? " line" : " lines");
    for (const o of lines) {
      const [label, badge] = ORDER_STATUS[o.status] || [o.status, "hs-badge-na"];
      const expected = el("td", { class: o.overdue ? "or-overdue" : "" });
      if (o.expectedDate) expected.append(document.createTextNode(fmtDate(o.expectedDate)));
      if (o.overdue) expected.append(el("span", { class: "or-overdue-tag", text: "Overdue" }));
      const tr = el(
        "tr",
        { class: o.status === "cancelled" ? "or-cancelled" : "" },
        el("td", { class: "or-job" }, el("a", { href: "/job.html?id=" + o.jobId + "#orders", text: o.jobName })),
        el("td", { class: "or-supplier", text: o.supplier }),
        el("td", { class: "or-text", text: o.description }),
        el("td", {}, el("span", { class: "hs-badge " + badge, text: label })),
        expected,
        el("td", { text: fmtDate(o.orderedDate) }),
        el("td", { class: "or-text", text: o.notes })
      );
      if (showActions) {
        const cell = el("td", { class: "or-acts" });
        for (const a of lineActions(o)) {
          const btn = el("button", { type: "button", class: "hs-btn" + (a.primary ? " hs-btn-primary" : ""), text: a.label });
          btn.addEventListener("click", () => runAction(o, a));
          cell.append(btn);
        }
        tr.append(cell);
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

  async function load() {
    const mine = ++seq;
    const qs = new URLSearchParams({ status: statusEl.value });
    if (supplierEl.value) qs.set("supplier", supplierEl.value);
    let list;
    try {
      list = await api("/api/orders?" + qs);
    } catch (e) {
      if (mine === seq) {
        countEl.textContent = "";
        setMessage(e.message, "err");
      }
      return;
    }
    if (mine !== seq) return;
    lines = list;
    loaded = true;
    render();
  }

  async function runAction(o, a) {
    if (a.cancel) {
      const what = o.jobName + ": " + o.supplier + (o.description ? " - " + o.description : "");
      const ok = await confirmDialog("Cancel this order line?", what + ". The line stays on the job, marked cancelled.", "Cancel line", "Keep line");
      if (!ok) return;
    }
    for (const b of rowsEl.querySelectorAll("button")) b.disabled = true;
    setMessage("Saving...", "");
    try {
      if (a.cancel) await api("/api/orders/" + o.id + "/cancel", { method: "POST", body: "{}" });
      else await api("/api/orders/" + o.id, { method: "PATCH", body: JSON.stringify(a.patch) });
      setMessage(o.jobName + ": " + a.done + ".", "ok");
    } catch (e) {
      setMessage(e.message, "err");
    }
    await load();
  }

  statusEl.addEventListener("change", () => {
    setMessage("", "");
    load();
  });
  supplierEl.addEventListener("change", () => {
    setMessage("", "");
    load();
  });

  loadSuppliers();
  load();
  // The shell may finish loading permissions after first paint.
  document.addEventListener("cc:ready", () => {
    if (loaded) render();
  });
})();
