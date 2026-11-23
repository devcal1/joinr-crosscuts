// The job page's Orders & materials list (docs/plans/jobpage-contracts.md section C; the earlier
// Materials section is docs/plans/materials-contracts.md). One list, grouped by section, filled from
// Joinr when the job arrives. Teal text is a suggestion (prefill: the last supplier and details used for
// that item, else the section default); orange is what still needs a person. Typing into a line saves as
// you leave the field. "Send to orders" (jobs.edit and orders.edit) finalises and sends in one step from
// POST .../project/send-now, after a confirm. Lines left out of the order (Joinr drawers are on the
// drawer order) sit under "Not in this order" with Include. Once a revision is sent, the progress by
// supplier shows above the list. Loaded by job.html after job.js; job.js calls JobMaterials.start()
// (with jobs.view). Every rule lives on the server (lib/materials.js, lib/projectjobs.js); this only
// hides what the user can't use. All text goes in through textContent. Page classes here are jm-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  let jobId = null;
  let can = () => false;
  let onOrdersChanged = () => {};
  let onSent = () => location.reload();
  let started = false;
  let data = null; // GET .../materials: {lines, sections, joinr}
  let prev = null; // GET .../project/send-preview
  let editing = null; // the line id in the Edit row
  let openDetails = new Set(); // line ids whose four detail fields are open
  let suppliers = []; // datalist
  let sending = false;
  let seq = 0;
  let prevSeq = 0;

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

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // 2027-01-18 -> "18 Jan 2027" (or "18 Jan" with short); an ISO time uses its Sydney-agnostic date part.
  function fmtDay(v, short) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ""));
    if (!m) return "";
    return Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] + (short ? "" : " " + m[1]);
  }

  function sectionLabel(id) {
    const s = data && data.sections.find((x) => x.id === id);
    if (s) return s.label;
    const t = String(id || "").replace(/_/g, " ");
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  const ORDER_STATE = {
    to_order: ["To order", "hs-badge-na"],
    ordered: ["Ordered", "hs-badge-teal"],
    received: ["Received", "hs-badge-go"],
  };

  // A modal on the shell's cc-dialog frame; resolves true only when the confirm button is pressed.
  function confirmDialog(title, paras, confirmLabel, opts) {
    const o = opts || {};
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
      const keep = el("button", { type: "button", class: "hs-btn", text: o.keepLabel || "Keep it" });
      const yes = el("button", { type: "button", class: "hs-btn " + (o.primary ? "hs-btn-primary" : "hs-btn-stop"), text: confirmLabel });
      keep.addEventListener("click", () => dlg.close());
      yes.addEventListener("click", () => {
        answer = true;
        dlg.close();
      });
      const list = Array.isArray(paras) ? paras : [paras];
      dlg.append(
        el(
          "div",
          { class: "cc-dialog-form" },
          el("h2", { class: "cc-dialog-title", text: title }),
          ...list.map((t) => el("p", { class: "cc-dialog-note", text: t })),
          el("div", { class: "cc-dialog-actions" }, keep, yes)
        )
      );
      dlg.showModal();
    });
  }

  // ---- what a line needs ------------------------------------------------------------------------

  const orderable = () => (data ? data.lines.filter((l) => !l.skipOrder) : []);
  const skipped = () => (data ? data.lines.filter((l) => l.skipOrder) : []);

  // The same test as lib/projectjobs.js problemsOf: no supplier, or no quantity above 0.
  function missingOf(l) {
    const m = [];
    if (!l.supplier) m.push("supplier");
    if (l.qty == null || !(l.qty > 0)) m.push("quantity");
    return m;
  }

  function stateBadge(l) {
    if (l.ordered) {
      const [text, cls] = ORDER_STATE[l.orderStatus] || [l.orderStatus || "Ordered", "hs-badge-teal"];
      return el("span", { class: "hs-badge " + cls, text });
    }
    const m = missingOf(l);
    if (m.length) return el("span", { class: "hs-badge hs-badge-check", text: "Needs " + m.join(" and ") });
    return el("span", { class: "hs-badge hs-badge-teal", text: "Ready" });
  }

  function marks(l) {
    const box = el("div", { class: "jm-marks" });
    if (l.origin === "typed") box.append(el("span", { class: "hs-badge hs-badge-na", text: "Typed" }));
    else if (l.origin === "edited") box.append(el("span", { class: "hs-badge hs-badge-na", text: "Edited" }));
    if (l.goneFromJoinr) box.append(el("span", { class: "hs-badge hs-badge-check", text: "No longer in Joinr" }));
    return box;
  }

  const detailText = (l) => [l.brand, l.code, l.colour, l.finish].filter(Boolean).join(", ");
  const DETAIL_FIELDS = [
    ["brand", "Brand"],
    ["code", "Code"],
    ["colour", "Colour"],
    ["finish", "Finish"],
  ];

  // ---- saving a field as you leave it -------------------------------------------------------------

  function replaceLine(fresh) {
    const i = data.lines.findIndex((l) => l.id === fresh.id);
    if (i >= 0) data.lines[i] = fresh;
  }

  // One field: saves, then updates just that row's marks and the summary (the table is not rebuilt, so
  // tabbing from one field to the next keeps its focus).
  async function saveField(l, patch, input) {
    const tr = input.closest("tr[data-id]");
    input.disabled = false;
    try {
      const fresh = await api("/api/job-records/" + jobId + "/materials/" + l.id, { method: "PATCH", body: JSON.stringify(patch) });
      replaceLine(fresh);
      Object.assign(l, fresh);
      setLine("", "muted");
    } catch (e) {
      setLine(errText(e), "err");
      return;
    }
    if (tr) refreshRow(tr, l);
    renderSummary();
    loadPreview();
  }

  // Marks, borders and the state badge of one row after a save.
  function refreshRow(tr, l) {
    const m = missingOf(l);
    for (const [cls, field] of [["jm-in-supplier", "supplier"], ["jm-in-qty", "qty"]]) {
      const inp = tr.querySelector("." + cls);
      if (!inp) continue;
      const empty = field === "qty" ? l.qty == null || !(l.qty > 0) : !l.supplier;
      inp.classList.toggle("jm-att", empty && !l.ordered);
      if (field === "supplier") inp.classList.toggle("jm-sug", !l.ordered && l.suggested.includes("supplier"));
    }
    const det = tr.querySelector(".jm-detbtn");
    if (det) {
      det.textContent = detailText(l) || "Brand, code, colour, finish";
      det.classList.toggle("jm-empty", !detailText(l));
      det.classList.toggle("jm-sug", DETAIL_FIELDS.some(([k]) => !l.ordered && l.suggested.includes(k)));
    }
    const cell = tr.querySelector("td.jm-state");
    if (cell) cell.replaceChildren(stateBadge(l));
    void m;
  }

  // ---- rows -----------------------------------------------------------------------------------------

  function supplierInput(l, canEdit) {
    const att = !l.supplier && !l.ordered;
    const inp = el("input", {
      class: "hs-input jm-in jm-in-supplier" + (att ? " jm-att" : "") + (!l.ordered && l.suggested.includes("supplier") ? " jm-sug" : ""),
      type: "text",
      maxlength: "200",
      list: "jmSuppliers",
      value: l.supplier || "",
      placeholder: "Choose supplier",
      "aria-label": "Supplier for " + l.name,
      autocomplete: "off",
    });
    inp.disabled = !canEdit;
    inp.addEventListener("change", () => saveField(l, { supplier: inp.value }, inp));
    return inp;
  }

  function qtyInput(l, canEdit) {
    const att = (l.qty == null || !(l.qty > 0)) && !l.ordered;
    const inp = el("input", {
      class: "hs-input jm-in jm-in-qty" + (att ? " jm-att" : ""),
      type: "number",
      min: "0",
      step: "any",
      value: fmtQty(l.qty),
      placeholder: att ? "Qty" : "",
      "aria-label": "Quantity for " + l.name,
    });
    inp.disabled = !canEdit;
    inp.addEventListener("change", () => saveField(l, { qty: inp.value === "" ? null : Number(inp.value) }, inp));
    return inp;
  }

  function unitInput(l, canEdit) {
    const inp = el("input", {
      class: "hs-input jm-in jm-in-unit",
      type: "text",
      maxlength: "30",
      value: l.unit || "",
      "aria-label": "Unit for " + l.name,
      autocomplete: "off",
    });
    inp.disabled = !canEdit;
    inp.addEventListener("change", () => saveField(l, { unit: inp.value }, inp));
    return inp;
  }

  function lineRows(l, canEdit) {
    const rows = [];
    if (editing === l.id) {
      rows.push(editRow(l));
      return rows;
    }
    const sug = DETAIL_FIELDS.some(([k]) => !l.ordered && l.suggested.includes(k));
    const detBtn = el("button", {
      type: "button",
      class: "hs-input jm-detbtn" + (detailText(l) ? "" : " jm-empty") + (sug ? " jm-sug" : ""),
      "aria-expanded": openDetails.has(l.id) ? "true" : "false",
      "aria-label": "Details for " + l.name,
      text: detailText(l) || "Brand, code, colour, finish",
    });
    detBtn.addEventListener("click", () => {
      if (openDetails.has(l.id)) openDetails.delete(l.id);
      else openDetails.add(l.id);
      renderTable();
      const b = $("jmBody").querySelector(`tr[data-id="${l.id}"] .jm-detbtn`);
      if (b) b.focus();
    });
    // Leave out sits on the row; Edit and Remove come with the opened details, so a row stays one line.
    const acts = el("td", { class: "jm-acts" });
    const more = el("div", { class: "jm-more" });
    if (canEdit) {
      more.append(el("button", { type: "button", class: "hs-btn", "data-act": "edit", "data-id": String(l.id), "aria-label": "Edit " + l.name, text: "Edit item" }));
      if (!l.ordered) {
        acts.append(el("button", { type: "button", class: "hs-btn hs-btn-quiet", "data-act": "skip", "data-id": String(l.id), "aria-label": "Leave out " + l.name, text: "Leave out" }));
        more.append(el("button", { type: "button", class: "hs-btn", "data-act": "remove", "data-id": String(l.id), "aria-label": "Remove " + l.name, text: "Remove" }));
      }
    }
    rows.push(
      el(
        "tr",
        { "data-id": String(l.id), class: l.goneFromJoinr ? "jm-gone" : "" },
        el("td", { class: "jm-item" }, el("span", { class: "jm-name", text: l.name }), l.notes ? el("div", { class: "jm-sub", text: l.notes }) : null, marks(l)),
        el("td", { class: "jm-c-qty" }, qtyInput(l, canEdit)),
        el("td", { class: "jm-c-unit" }, unitInput(l, canEdit)),
        el("td", { class: "jm-c-sup" }, supplierInput(l, canEdit)),
        el("td", { class: "jm-c-det" }, detBtn),
        el("td", { class: "jm-state" }, stateBadge(l)),
        acts
      )
    );
    if (openDetails.has(l.id)) {
      const grid = el("div", { class: "jm-detgrid" });
      for (const [key, label] of DETAIL_FIELDS) {
        const inp = el("input", {
          class: "hs-input jm-in" + (!l.ordered && l.suggested.includes(key) ? " jm-sug" : ""),
          type: "text",
          maxlength: "100",
          value: l[key] || "",
          "aria-label": label + " for " + l.name,
          autocomplete: "off",
        });
        inp.disabled = !canEdit;
        inp.addEventListener("change", () => saveField(l, { [key]: inp.value }, inp));
        grid.append(el("label", { class: "jm-detfield" }, el("span", { class: "jm-detlabel", text: label }), inp));
      }
      rows.push(el("tr", { class: "jm-detrow", "data-for": String(l.id) }, el("td", { colspan: "7" }, grid, canEdit ? more : null)));
    }
    return rows;
  }

  function sectionSelect(value) {
    const sel = el("select", { class: "hs-input", "aria-label": "Section" });
    const ids = data.sections.map((s) => s.id);
    // A Joinr line may carry a section the typed list does not offer; keep it selectable.
    if (value && !ids.includes(value)) sel.append(el("option", { value, text: sectionLabel(value) }));
    for (const s of data.sections) sel.append(el("option", { value: s.id, text: s.label }));
    sel.value = value || "other";
    return sel;
  }

  // The rarely used edit: section, item, quantity, unit and notes (the details save in the row itself).
  function editRow(l) {
    const sec = sectionSelect(l.section);
    const name = el("input", { class: "hs-input", type: "text", maxlength: "300", value: l.name, "aria-label": "Item", autocomplete: "off" });
    const qty = el("input", { class: "hs-input", type: "number", min: "0", step: "any", value: fmtQty(l.qty), "aria-label": "Quantity" });
    const unit = el("input", { class: "hs-input", type: "text", maxlength: "30", value: l.unit || "", "aria-label": "Unit", autocomplete: "off" });
    const notes = el("input", { class: "hs-input", type: "text", maxlength: "1000", value: l.notes || "", "aria-label": "Notes", autocomplete: "off" });
    const save = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Save" });
    const cancel = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Cancel" });
    const field = (label, node, cls) => el("label", { class: "jm-detfield " + (cls || "") }, el("span", { class: "jm-detlabel", text: label }), node);
    const grid = el(
      "div",
      { class: "jm-editgrid" },
      field("Section", sec),
      field("Item", name, "jm-wide"),
      field("Qty", qty),
      field("Unit", unit),
      field("Notes", notes, "jm-wide"),
      el("div", { class: "jm-editacts" }, save, cancel)
    );
    save.addEventListener("click", async () => {
      save.disabled = true;
      setLine("Saving...", "muted");
      try {
        await api("/api/job-records/" + jobId + "/materials/" + l.id, {
          method: "PATCH",
          body: JSON.stringify({ section: sec.value, name: name.value, qty: qty.value === "" ? null : Number(qty.value), unit: unit.value, notes: notes.value }),
        });
      } catch (e) {
        setLine(errText(e), "err");
        save.disabled = false;
        return;
      }
      editing = null;
      await load(true);
      setLine("Saved: " + (name.value.trim() || l.name) + ".", "ok");
      focusAct("edit", l.id);
    });
    cancel.addEventListener("click", () => {
      editing = null;
      renderTable();
      focusAct("edit", l.id);
    });
    for (const inp of [name, qty, unit, notes]) {
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          save.click();
        } else if (ev.key === "Escape") cancel.click();
      });
    }
    setTimeout(() => name.focus(), 0);
    return el("tr", { "data-id": String(l.id), class: "jm-editing" }, el("td", { colspan: "7" }, grid));
  }

  function focusAct(act, id) {
    const b = $("jmBody").querySelector(`button[data-act="${act}"][data-id="${id}"]`);
    if (b) b.focus();
  }

  // ---- drawing --------------------------------------------------------------------------------------

  // Once a revision is sent and nothing has changed, the list folds away under its progress.
  let showList = false;
  function renderTable() {
    const body = $("jmBody");
    if (!data) {
      body.replaceChildren();
      return;
    }
    const canEdit = can("jobs.edit");
    $("jmAddBtn").hidden = !canEdit;
    if (!canEdit) $("jmForm").hidden = true;
    $("jmFill").hidden = !(canEdit && data.joinr.linked && !data.joinr.hasJoinrLines);
    const lines = orderable();
    if (!lines.length) {
      const j = data.joinr;
      body.replaceChildren(el("p", { class: "muted jo-empty", text: j.linked && !j.hasJoinrLines ? "No materials yet. Fill from Joinr, or add a line." : "No materials in the order yet." }));
      return;
    }
    if (prev && prev.latest && prev.latest.sentAt && !prev.latest.changed && !showList) {
      const show = el("button", { type: "button", class: "hs-btn", text: "Show the list to change it" });
      show.addEventListener("click", () => {
        showList = true;
        renderTable();
      });
      body.replaceChildren(show);
      return;
    }
    const table = el("table", { class: "hs-table jo-table jm-table" });
    table.append(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ...["Item", "Qty", "Unit", "Supplier", "Details", "State", ""].map((h) => el("th", { text: h, scope: "col" }))
        )
      )
    );
    const tb = el("tbody");
    let prevSec = null;
    for (const l of lines) {
      if (l.section !== prevSec) {
        prevSec = l.section;
        const n = lines.filter((x) => x.section === l.section).length;
        tb.append(el("tr", { class: "jm-sechead" }, el("th", { colspan: "7", scope: "colgroup" }, el("span", { text: sectionLabel(l.section) }), el("span", { class: "jm-seccount", text: String(n) }))));
      }
      for (const tr of lineRows(l, canEdit)) tb.append(tr);
    }
    table.append(tb);
    body.replaceChildren(el("div", { class: "jo-wrap" }, table));
  }

  function renderFoot() {
    const box = $("jmFoot");
    const left = skipped();
    if (!data || !left.length) {
      box.replaceChildren();
      return;
    }
    const canEdit = can("jobs.edit");
    const table = el("table", { class: "hs-table jo-table jm-table jm-leftout" });
    const tb = el("tbody");
    for (const l of left) {
      const acts = el("td", { class: "jm-acts" });
      if (canEdit) acts.append(el("button", { type: "button", class: "hs-btn", "data-act": "include", "data-id": String(l.id), "aria-label": "Include " + l.name, text: "Include" }));
      tb.append(
        el(
          "tr",
          { "data-id": String(l.id) },
          el("td", { class: "jm-item" }, el("span", { class: "jm-name", text: l.name }), l.notes ? el("div", { class: "jm-sub", text: l.notes }) : null),
          el("td", { class: "jm-num", text: (fmtQty(l.qty) + (l.unit ? " " + l.unit : "")).trim() }),
          el("td", { class: "jm-sub", text: l.section === "drawers" ? "On the drawer order" : "Left out of the order" }),
          acts
        )
      );
    }
    table.append(tb);
    box.replaceChildren(el("h3", { class: "jm-foothead", text: "Not in this order" }), el("div", { class: "jo-wrap" }, table));
  }

  function renderProgress() {
    const box = $("jmProgress");
    const latest = prev && prev.latest;
    if (!data || !latest || !latest.sentAt) {
      box.replaceChildren();
      return;
    }
    const inOrder = data.lines.filter((l) => l.ordered && l.orderStatus !== "cancelled");
    const count = (s) => inOrder.filter((l) => l.orderStatus === s).length;
    const bits = [];
    if (count("ordered")) bits.push(count("ordered") + " ordered");
    if (count("received")) bits.push(count("received") + " received");
    if (count("to_order")) bits.push(count("to_order") + " to order");
    const bar = el(
      "div",
      { class: "jm-bar" },
      el("h3", { class: "jm-barh", text: "Revision " + latest.revision + ", sent " + fmtDay(latest.sentAt, true) }),
      el("span", { class: "jm-sub", text: bits.join(", ") })
    );
    const bySupplier = new Map();
    for (const l of inOrder) {
      const k = l.supplier || "No supplier";
      if (!bySupplier.has(k)) bySupplier.set(k, []);
      bySupplier.get(k).push(l);
    }
    const names = [...bySupplier.keys()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    const tb = el("tbody");
    for (const n of names) {
      bySupplier.get(n).forEach((l, i) => {
        const [text, cls] = ORDER_STATE[l.orderStatus] || [l.orderStatus || "", "hs-badge-na"];
        tb.append(
          el(
            "tr",
            {},
            el("td", { class: "jm-strong", text: i === 0 ? n : "" }),
            el("td", { text: l.name }),
            el("td", { class: "jm-num", text: (fmtQty(l.qty) + (l.unit ? " " + l.unit : "")).trim() }),
            el("td", { text: l.orderExpected ? fmtDay(l.orderExpected, true) : "" }),
            el("td", {}, el("span", { class: "hs-badge " + cls, text }))
          )
        );
      });
    }
    const table = el(
      "table",
      { class: "hs-table jo-table jm-table" },
      el("thead", {}, el("tr", {}, ...["Supplier", "Item", "Qty", "Expected", "State"].map((h) => el("th", { text: h, scope: "col" })))),
      tb
    );
    box.replaceChildren(bar, inOrder.length ? el("div", { class: "jo-wrap" }, table) : el("p", { class: "muted", text: "Nothing on order from this revision yet." }));
  }

  // The summary card: the counts, the requested install date, Update from Joinr and Send to orders.
  function renderSummary() {
    const box = $("jmSummary");
    if (!data) {
      box.replaceChildren();
      return;
    }
    const lines = orderable();
    const fix = lines.filter((l) => !l.ordered && missingOf(l).length).length;
    const ready = lines.length - fix;
    const sup = new Set(lines.map((l) => l.supplier).filter(Boolean));
    const canEdit = can("jobs.edit");
    const canSend = canEdit && can("orders.edit");

    const head = el("div", { class: "jm-sumhead" }, el("b", { class: "jm-sumtitle", text: lines.length + (lines.length === 1 ? " line, " : " lines, ") + ready + " ready" }));
    if (fix) head.append(el("span", { class: "hs-badge hs-badge-check", text: fix + " to fix" }));
    const sub = [];
    if (sup.size) sub.push(sup.size + (sup.size === 1 ? " supplier" : " suppliers") + " so far.");
    if (skipped().some((l) => l.section === "drawers")) sub.push("Drawers are on the drawer order below, not in this list.");
    const left = el("div", { class: "jm-sumleft" }, head, sub.length ? el("div", { class: "jm-sub", text: sub.join(" ") }) : null);

    const date = el("input", { class: "hs-input", id: "jmInstall", type: "date", value: (prev && prev.requestedInstallDate) || "", "aria-label": "Requested install date" });
    date.disabled = !canEdit || !prev;
    date.addEventListener("change", () => saveInstall(date));
    const dateBox = el("label", { class: "jm-install" }, el("span", { class: "jm-orderlabel", text: "Requested install" }), date);

    const acts = el("div", { class: "jm-sumacts" });
    if (canEdit && data.joinr.linked && data.joinr.hasJoinrLines) {
      const upd = el("button", { type: "button", class: "hs-btn", id: "jmUpdate", text: "Update from Joinr" });
      upd.addEventListener("click", async () => {
        upd.disabled = true;
        await updateFromJoinr();
        upd.disabled = false;
      });
      acts.append(upd);
    }
    let why = null;
    if (canSend) {
      const send = el("button", { type: "button", class: "hs-btn hs-btn-primary", id: "jmSend", text: "Send to orders" });
      send.disabled = sending || !prev || !prev.ready;
      send.addEventListener("click", onSend);
      acts.append(send);
      if (prev && !prev.ready && prev.reasons.length) why = el("p", { class: "jm-why", id: "jmWhy", text: "Send to orders is off until: " + prev.reasons.join(" ") });
      send.setAttribute("aria-describedby", why ? "jmWhy" : "");
      if (!why) send.removeAttribute("aria-describedby");
    }
    box.replaceChildren(el("div", { class: "jm-sumrow" }, left, dateBox, acts));
    if (why) box.append(why);
  }

  function renderSuppliers() {
    $("jmSuppliers").replaceChildren(...suppliers.map((s) => el("option", { value: s })));
  }

  function render() {
    renderSummary();
    renderProgress();
    renderTable();
    renderFoot();
  }

  // ---- loading ----------------------------------------------------------------------------------------

  async function loadPreview() {
    const mine = ++prevSeq;
    try {
      const p = await api("/api/job-records/" + jobId + "/project/send-preview");
      if (mine !== prevSeq) return;
      prev = p;
    } catch (e) {
      return; // the list still works without the preview; Send stays off
    }
    renderSummary();
    renderProgress();
  }

  async function load(keepMsg) {
    const mine = ++seq;
    let r;
    try {
      [r] = await Promise.all([api("/api/job-records/" + jobId + "/materials"), loadPreviewData()]);
    } catch (e) {
      if (mine === seq) setLine(errText(e), "err");
      return false;
    }
    if (mine !== seq) return true;
    data = r;
    if (editing != null && !r.lines.some((l) => l.id === editing)) editing = null;
    if (!keepMsg) setLine("", "muted");
    render();
    return true;
  }

  async function loadPreviewData() {
    const mine = ++prevSeq;
    try {
      const p = await api("/api/job-records/" + jobId + "/project/send-preview");
      if (mine === prevSeq) prev = p;
    } catch (e) {
      /* see loadPreview */
    }
  }

  function take(r) {
    if (r && r.lines) {
      data = r;
      render();
      loadPreview();
    }
  }

  // ---- actions --------------------------------------------------------------------------------------

  async function saveInstall(input) {
    input.disabled = true;
    setLine("Saving...", "muted");
    try {
      await api("/api/job-records/" + jobId, { method: "PATCH", body: JSON.stringify({ requestedInstallDate: input.value || null }) });
      setLine("Requested install date saved.", "ok");
      document.dispatchEvent(new CustomEvent("cc:job-changed", { detail: { requestedInstallDate: input.value || null } }));
    } catch (e) {
      setLine(errText(e), "err");
    }
    input.disabled = false;
    await loadPreview();
  }

  async function removeLine(l, opener) {
    const note = l.source === "joinr" ? "It will not come back when the quote is updated from Joinr." : "It is taken off the list.";
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

  async function setSkip(l, skip) {
    setLine(skip ? "Leaving out..." : "Including...", "muted");
    try {
      await api("/api/job-records/" + jobId + "/materials/" + l.id, { method: "PATCH", body: JSON.stringify({ skipOrder: skip }) });
    } catch (e) {
      setLine(errText(e), "err");
      return;
    }
    await load(true);
    setLine((skip ? "Left out of the order: " : "Included in the order: ") + l.name + ".", "ok");
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

  // Send to orders: the confirm says what will happen (from the preview), then one POST.
  async function onSend() {
    if (sending || !prev || !prev.ready) return;
    const p = prev;
    const paras = [];
    const n = p.lineCount;
    const sup = p.suppliers.length;
    paras.push(
      n + (n === 1 ? " line" : " lines") + " to " + sup + (sup === 1 ? " supplier" : " suppliers") + " as revision " + p.revision + ". Requested install " + fmtDay(p.requestedInstallDate) + "."
    );
    const will = [];
    if (p.stage === "won" || p.stage === "projects") will.push("the job moves to Ordering");
    if (p.depositWillBeRaised) will.push(p.depositWaitsForValue ? "the deposit waits for a job value" : "the 10% deposit becomes due");
    if (p.boardWeek) will.push("it goes on the board in the week of " + fmtDay(p.boardWeek));
    will.push("the order managers are told");
    paras.push(will.map((t, i) => (i === 0 ? t.charAt(0).toUpperCase() + t.slice(1) : t)).join(", ").replace(/, ([^,]*)$/, " and $1") + ".");
    const yes = await confirmDialog("Send to orders?", paras, "Send to orders", { primary: true, keepLabel: "Not yet" });
    if (!yes) {
      const b = $("jmSend");
      if (b) b.focus();
      return;
    }
    if (sending) return;
    sending = true;
    renderSummary();
    setLine("Sending to orders...", "muted");
    try {
      const r = await api("/api/job-records/" + jobId + "/project/send-now", { method: "POST", body: JSON.stringify({ fingerprint: p.fingerprint }) });
      const k = r.created || 0;
      setLine("Sent as revision " + r.revision + ": " + k + (k === 1 ? " order line" : " order lines") + " created, to order.", "ok");
      onOrdersChanged();
      setTimeout(() => {
        try {
          onSent(r);
        } catch (e) {
          /* the page is already showing the result */
        }
      }, 1200);
    } catch (e) {
      sending = false;
      setLine(errText(e), "err");
      await load(true);
      setLine(errText(e), "err");
    }
  }

  async function loadSuppliers() {
    const set = new Set();
    try {
      for (const s of await api("/api/orders/suppliers")) set.add(s);
    } catch (e) {
      /* a convenience */
    }
    try {
      const d = await api("/api/material-section-suppliers");
      for (const s of d.sections) if (s.supplier) set.add(s.supplier);
    } catch (e) {
      /* a convenience */
    }
    suppliers = [...set].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    renderSuppliers();
  }

  function fillSectionSelect() {
    const sel = $("jmSection");
    sel.replaceChildren(...data.sections.map((s) => el("option", { value: s.id, text: s.label })));
    sel.value = "other";
  }

  // Lines prefill has not looked at get their suggestions once, when the page opens.
  async function prefillOnOpen() {
    if (!data || !can("jobs.edit")) return;
    if (!data.lines.some((l) => !l.prefilledAt && !l.ordered)) return;
    try {
      const r = await api("/api/job-records/" + jobId + "/materials/prefill", { method: "POST", body: "{}" });
      if (r && r.lines && r.filled) take(r);
      else if (r && r.lines) {
        data = { ...data, lines: r.lines };
        render();
      }
    } catch (e) {
      /* the list is usable without suggestions */
    }
  }

  async function start(opts) {
    jobId = opts.jobId;
    can = opts.can;
    if (opts.onOrdersChanged) onOrdersChanged = opts.onOrdersChanged;
    if (opts.onSent) onSent = opts.onSent;
    $("materials").hidden = false;
    $("jmFill").addEventListener("click", onFill);
    $("jmForm").addEventListener("submit", onAdd);
    $("jmAddBtn").addEventListener("click", () => {
      const f = $("jmForm");
      f.hidden = !f.hidden;
      $("jmAddBtn").setAttribute("aria-expanded", f.hidden ? "false" : "true");
      if (!f.hidden) $("jmName").focus();
    });
    const click = (ev) => {
      const b = ev.target.closest && ev.target.closest("button[data-act]");
      if (!b || b.disabled) return;
      const l = data && data.lines.find((x) => x.id === Number(b.getAttribute("data-id")));
      if (!l) return;
      const act = b.getAttribute("data-act");
      if (act === "edit") {
        editing = l.id;
        renderTable();
      } else if (act === "remove") removeLine(l, b);
      else if (act === "skip") setSkip(l, true);
      else if (act === "include") setSkip(l, false);
    };
    $("jmBody").addEventListener("click", click);
    $("jmFoot").addEventListener("click", click);
    const ok = await load();
    if (data) fillSectionSelect();
    loadSuppliers();
    await prefillOnOpen();
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
