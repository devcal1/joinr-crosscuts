// The job page's Materials section (docs/plans/materials-contracts.md): the job's materials list
// from GET /api/job-records/:id/materials. Lines prefilled from Joinr are marked JOINR; a Joinr
// line a person changes becomes EDITED and a sync leaves it alone; a line typed here is TYPED.
// "Fill from Joinr" is offered to jobs tied to Joinr before the list existed; the callout in
// "From Joinr" calls updateFromJoinr(). "Create order lines" (orders.edit) turns the ticked
// lines into to_order order lines, never automatically. Loaded by job.html after job.js; job.js
// calls JobMaterials.start() from its start-up (with jobs.view). Every rule lives in
// lib/materials.js; this only hides what the user can't use. All text goes in through textContent.
// Page classes here are jm-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  let jobId = null;
  let can = () => false;
  let onOrdersChanged = () => {};
  let started = false;
  let data = null; // {lines, sections, joinr}
  let editing = null; // the line id being edited in place
  let picked = new Set(); // ticked line ids
  let busy = false;
  let seq = 0;

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

  function setLine(msg, kind) {
    const n = $("jmStatus");
    n.textContent = msg || "";
    n.className = "jo-status " + (kind || "muted");
  }

  const errText = (e) => (e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message);

  function fmtQty(q) {
    return q == null ? "" : String(Math.round(q * 1000) / 1000);
  }

  function sectionLabel(id) {
    const s = data && data.sections.find((x) => x.id === id);
    if (s) return s.label;
    const t = String(id || "").replace(/_/g, " ");
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  const MARKS = {
    joinr: ["Joinr", "hs-badge-na"],
    edited: ["Edited", "hs-badge-check"],
    typed: ["Typed", "hs-badge-na"],
  };

  // A modal on the shell's cc-dialog frame; resolves true only when the confirm button is pressed.
  function confirmDialog(title, note, confirmLabel) {
    return new Promise((resolve) => {
      let answer = false;
      const dlg = el("dialog", { class: "cc-dialog jo-dialog", "aria-label": title });
      document.body.append(dlg);
      dlg.addEventListener("close", () => {
        dlg.remove();
        resolve(answer);
      });
      dlg.addEventListener("mousedown", (e) => {
        if (e.target === dlg) dlg.close();
      });
      const keep = el("button", { type: "button", class: "hs-btn", text: "Keep it" });
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
      dlg.showModal();
    });
  }

  function sectionSelect(value) {
    const sel = el("select", { class: "hs-input jm-section", "aria-label": "Section" });
    const ids = data.sections.map((s) => s.id);
    // A Joinr line may carry a section the typed list does not offer; keep it selectable.
    if (value && !ids.includes(value)) sel.append(el("option", { value, text: sectionLabel(value) }));
    for (const s of data.sections) sel.append(el("option", { value: s.id, text: s.label }));
    sel.value = value || "other";
    return sel;
  }

  // The marker words, one small badge each, under the item.
  function marks(l) {
    const [text, cls] = MARKS[l.origin] || [l.origin, "hs-badge-na"];
    const box = el("div", { class: "jm-marks" }, el("span", { class: "hs-badge " + cls, text }));
    if (l.ordered) box.append(el("span", { class: "hs-badge hs-badge-go", text: "Ordered" }));
    if (l.goneFromJoinr) box.append(el("span", { class: "hs-badge hs-badge-check", text: "No longer in Joinr" }));
    return box;
  }

  function readRow(l, first, showPick, showActs) {
    const tr = el("tr", { "data-id": String(l.id), class: l.goneFromJoinr ? "jm-gone" : "" });
    if (showPick) {
      const box = el("input", { type: "checkbox", class: "jm-pick", "aria-label": "Select " + l.name, "data-id": String(l.id) });
      if (l.ordered) box.disabled = true;
      box.checked = !l.ordered && picked.has(l.id);
      tr.append(el("td", { class: "jm-tick" }, box));
    }
    tr.append(
      el("td", { class: "jm-sec", text: first ? sectionLabel(l.section) : "" }),
      el("td", { class: "jo-text jm-name" }, el("span", { text: l.name }), marks(l)),
      el("td", { class: "jm-num", text: fmtQty(l.qty) }),
      el("td", { text: l.unit || "" }),
      el("td", { class: "jo-text jm-notes", text: l.notes || "" })
    );
    if (showActs) {
      const edit = el("button", { type: "button", class: "hs-btn", "data-act": "edit", "data-id": String(l.id), "aria-label": "Edit " + l.name, text: "Edit" });
      const rm = el("button", { type: "button", class: "hs-btn hs-btn-quiet", "data-act": "remove", "data-id": String(l.id), "aria-label": "Remove " + l.name, text: "Remove" });
      tr.append(el("td", { class: "jm-acts" }, edit, rm));
    }
    return tr;
  }

  function editRow(l, showPick, cols) {
    const tr = el("tr", { "data-id": String(l.id), class: "jm-editing" });
    if (showPick) tr.append(el("td"));
    const sec = sectionSelect(l.section);
    const name = el("input", { class: "hs-input", type: "text", maxlength: "300", value: l.name, "aria-label": "Item", autocomplete: "off" });
    const qty = el("input", { class: "hs-input jm-qty", type: "number", min: "0", step: "any", value: fmtQty(l.qty), "aria-label": "Quantity" });
    const unit = el("input", { class: "hs-input jm-unit", type: "text", maxlength: "30", value: l.unit || "", "aria-label": "Unit", autocomplete: "off" });
    const notes = el("input", { class: "hs-input", type: "text", maxlength: "1000", value: l.notes || "", "aria-label": "Notes", autocomplete: "off" });
    tr.append(el("td", {}, sec), el("td", {}, name, marks(l)), el("td", {}, qty), el("td", {}, unit), el("td", {}, notes));
    const save = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Save" });
    const cancel = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Cancel" });
    save.addEventListener("click", () =>
      saveEdit(l, { section: sec.value, name: name.value, qty: qty.value === "" ? null : Number(qty.value), unit: unit.value, notes: notes.value }, save)
    );
    cancel.addEventListener("click", () => {
      editing = null;
      render();
      focusRow(l.id);
    });
    for (const inp of [name, qty, unit, notes]) {
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          save.click();
        } else if (ev.key === "Escape") cancel.click();
      });
    }
    tr.append(el("td", { class: "jm-acts" }, save, cancel));
    setTimeout(() => name.focus(), 0);
    return tr;
  }

  function focusRow(id) {
    const b = $("jmBody").querySelector(`button[data-act="edit"][data-id="${id}"]`);
    if (b) b.focus();
  }

  function render() {
    const body = $("jmBody");
    const addForm = $("jmForm");
    const orderBar = $("jmOrderBar");
    if (!data) {
      body.replaceChildren();
      return;
    }
    const canEdit = can("jobs.edit");
    const canOrder = can("orders.edit");
    addForm.hidden = !canEdit;

    // The head buttons.
    const j = data.joinr;
    $("jmFill").hidden = !(canEdit && j.linked && !j.hasJoinrLines);

    const lines = data.lines;
    const unordered = lines.filter((l) => !l.ordered);
    const showPick = canOrder && lines.length > 0;
    if (!lines.length) {
      body.replaceChildren(
        el("p", { class: "muted jo-empty", text: j.linked ? "No materials yet. Fill from Joinr, or add a line." : "No materials yet." })
      );
      orderBar.hidden = true;
      return;
    }
    const heads = [];
    if (showPick) heads.push("");
    heads.push("Section", "Item", "Qty", "Unit", "Notes");
    if (canEdit) heads.push("");
    const table = el("table", { class: "hs-table jo-table jm-table" });
    const headRow = el("tr");
    heads.forEach((h, i) => {
      if (showPick && i === 0) {
        const all = el("input", { type: "checkbox", id: "jmAll", "aria-label": "Select all lines not yet ordered" });
        all.disabled = !unordered.length;
        all.checked = unordered.length > 0 && unordered.every((l) => picked.has(l.id));
        all.addEventListener("change", () => {
          picked = all.checked ? new Set(unordered.map((l) => l.id)) : new Set();
          render();
        });
        headRow.append(el("th", { class: "jm-tick" }, all));
      } else {
        headRow.append(el("th", { text: h, class: h === "Qty" ? "jm-num" : "" }));
      }
    });
    table.append(el("thead", {}, headRow));
    const tb = el("tbody");
    let prev = null;
    for (const l of lines) {
      const first = l.section !== prev;
      prev = l.section;
      tb.append(editing === l.id ? editRow(l, showPick, heads.length) : readRow(l, first, showPick, canEdit));
    }
    table.append(tb);
    body.replaceChildren(el("div", { class: "jo-wrap" }, table));

    // Create order lines.
    orderBar.hidden = !canOrder;
    if (canOrder) {
      const n = unordered.filter((l) => picked.has(l.id)).length;
      const btn = $("jmToOrders");
      btn.disabled = busy || n === 0;
      btn.textContent = n ? "Create order lines (" + n + ")" : "Create order lines";
    }
  }

  async function load(keepMsg) {
    const mine = ++seq;
    let r;
    try {
      r = await api("/api/job-records/" + jobId + "/materials");
    } catch (e) {
      if (mine === seq) setLine(errText(e), "err");
      return false;
    }
    if (mine !== seq) return true;
    data = r;
    picked = new Set([...picked].filter((id) => r.lines.some((l) => l.id === id && !l.ordered)));
    if (editing != null && !r.lines.some((l) => l.id === editing)) editing = null;
    if (!keepMsg) setLine("", "muted");
    render();
    return true;
  }

  function take(r) {
    if (r && r.lines) {
      data = r;
      picked = new Set([...picked].filter((id) => r.lines.some((l) => l.id === id && !l.ordered)));
      render();
    }
  }

  async function saveEdit(l, patch, btn) {
    btn.disabled = true;
    setLine("Saving...", "muted");
    try {
      await api("/api/job-records/" + jobId + "/materials/" + l.id, { method: "PATCH", body: JSON.stringify(patch) });
    } catch (e) {
      setLine(errText(e), "err");
      btn.disabled = false;
      return;
    }
    editing = null;
    await load(true);
    setLine("Saved: " + (patch.name.trim() || l.name) + ".", "ok");
    focusRow(l.id);
  }

  async function removeLine(l, opener) {
    const note = l.source === "joinr"
      ? "It will not come back when the quote is updated from Joinr."
      : "It is taken off the list.";
    const yes = await confirmDialog("Remove " + l.name + "?", note, "Remove");
    if (!yes) {
      opener.focus();
      return;
    }
    setLine("Removing...", "muted");
    try {
      await api("/api/job-records/" + jobId + "/materials/" + l.id, { method: "DELETE" });
    } catch (e) {
      setLine(errText(e), "err");
      return;
    }
    await load(true);
    setLine("Removed: " + l.name + ".", "ok");
    $("materials-h").focus();
  }

  async function onAdd(ev) {
    ev.preventDefault();
    const name = $("jmName");
    const btn = $("jmAdd");
    if (!name.value.trim()) {
      setLine("Type the item.", "err");
      name.focus();
      return;
    }
    btn.disabled = true;
    setLine("Adding...", "muted");
    try {
      await api("/api/job-records/" + jobId + "/materials", {
        method: "POST",
        body: JSON.stringify({
          section: $("jmSection").value,
          name: name.value,
          qty: $("jmQty").value === "" ? null : Number($("jmQty").value),
          unit: $("jmUnit").value,
          notes: $("jmNotes").value,
        }),
      });
    } catch (e) {
      setLine(errText(e), "err");
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    const said = "Added: " + name.value.trim() + ".";
    for (const id of ["jmName", "jmQty", "jmUnit", "jmNotes"]) $(id).value = "";
    await load(true);
    setLine(said, "ok");
    name.focus();
  }

  function sentence(s) {
    const bits = [];
    if (s.added) bits.push(s.added + " added");
    if (s.updated) bits.push(s.updated + " updated");
    if (s.gone) bits.push(s.gone + " no longer in Joinr");
    const kept = (s.kept || 0) + (s.removedKept || 0);
    const tail = kept ? " " + kept + (kept === 1 ? " line you changed or removed was left alone." : " lines you changed or removed were left alone.") : "";
    return (bits.length ? bits.join(", ") + "." : "Nothing to change.") + tail;
  }

  async function sync(path, working) {
    setLine(working, "muted");
    const r = await api("/api/job-records/" + jobId + "/materials/" + path, { method: "POST", body: "{}" });
    take(r);
    return sentence(r.summary || {});
  }

  async function onFill(ev) {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      setLine("Materials from Joinr: " + (await sync("fill-from-joinr", "Filling from Joinr...")), "ok");
    } catch (e) {
      setLine(errText(e), "err");
    }
    btn.disabled = false;
  }

  // Called from the "Changed in Joinr" callout. Resolves the sentence to show there.
  async function updateFromJoinr() {
    try {
      const said = "Materials: " + (await sync("update-from-joinr", "Updating materials from Joinr..."));
      setLine(said, "ok");
      return { ok: true, text: said };
    } catch (e) {
      setLine(errText(e), "err");
      return { ok: false, text: errText(e) };
    }
  }

  async function onToOrders(ev) {
    const ids = (data ? data.lines : []).filter((l) => !l.ordered && picked.has(l.id)).map((l) => l.id);
    if (!ids.length || busy) return;
    busy = true;
    ev.currentTarget.disabled = true;
    setLine("Creating order lines...", "muted");
    try {
      const r = await api("/api/job-records/" + jobId + "/materials/to-orders", {
        method: "POST",
        body: JSON.stringify({ ids, supplier: $("jmSupplier").value }),
      });
      picked = new Set();
      busy = false;
      take(r);
      const n = r.created.length;
      setLine(
        n
          ? n + (n === 1 ? " order line" : " order lines") + " created in Orders, to order" +
              ($("jmSupplier").value.trim() ? "" : ". Choose each supplier there.")
          : "Nothing to order: those lines already have order lines.",
        "ok"
      );
      onOrdersChanged();
    } catch (e) {
      busy = false;
      setLine(errText(e), "err");
      render();
    }
  }

  async function loadSuppliers() {
    try {
      const list = await api("/api/orders/suppliers");
      $("jmSuppliers").replaceChildren(...list.map((s) => el("option", { value: s })));
    } catch (e) {
      /* the datalist is a convenience */
    }
  }

  function fillSectionSelect() {
    const sel = $("jmSection");
    sel.replaceChildren(...data.sections.map((s) => el("option", { value: s.id, text: s.label })));
    sel.value = "other";
  }

  async function start(opts) {
    jobId = opts.jobId;
    can = opts.can;
    if (opts.onOrdersChanged) onOrdersChanged = opts.onOrdersChanged;
    $("materials").hidden = false;
    $("jmFill").addEventListener("click", onFill);
    $("jmForm").addEventListener("submit", onAdd);
    $("jmToOrders").addEventListener("click", onToOrders);
    $("jmBody").addEventListener("click", (ev) => {
      const b = ev.target.closest && ev.target.closest("button[data-act]");
      if (!b || b.disabled) return;
      const l = data && data.lines.find((x) => x.id === Number(b.getAttribute("data-id")));
      if (!l) return;
      if (b.getAttribute("data-act") === "edit") {
        editing = l.id;
        render();
      } else removeLine(l, b);
    });
    $("jmBody").addEventListener("change", (ev) => {
      const t = ev.target;
      if (!t || !t.classList || !t.classList.contains("jm-pick")) return;
      const id = Number(t.getAttribute("data-id"));
      if (t.checked) picked.add(id);
      else picked.delete(id);
      render();
    });
    const ok = await load();
    if (data) fillSectionSelect();
    if (can("orders.edit")) loadSuppliers();
    started = true;
    return ok;
  }

  // Redraws from the server (the order lines may have changed their status).
  function refresh() {
    if (started) return load(true);
    return Promise.resolve(false);
  }

  window.JobMaterials = { start, refresh, updateFromJoinr };
})();
