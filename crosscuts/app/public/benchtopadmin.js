// Admin > Benchtop lists (/benchtopadmin.html; docs/plans/m21-benchtop-designer.md): the materials
// and edge finishes for the benchtop designer. Each row edits in place and saves with its own
// button (PATCH); the last row adds one (POST). Nothing is deleted: Shown off hides it from new
// choices. Admins only (users.admin). Text goes in through textContent and input values.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let marks = [];

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "checked") node.checked = !!v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  function status(msg, err) {
    $("baStatus").textContent = msg || "";
    $("baStatus").className = "ba-status" + (err ? " err" : "");
  }

  const input = (value, attrs) => el("input", Object.assign({ class: "hs-input", value: value == null ? "" : String(value) }, attrs || {}));

  async function send(kind, id, body) {
    try {
      if (id) await api(`/api/benchtop-lists/${kind}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api(`/api/benchtop-lists/${kind}`, { method: "POST", body: JSON.stringify(body) });
      await load();
      status(id ? "Saved." : "Added.");
    } catch (e) {
      status(e instanceof TypeError ? "Couldn't reach the server. Try again." : e.message, true);
    }
  }

  function matRow(m) {
    const sup = input(m && m.supplier, { maxlength: 120, "aria-label": "Supplier" });
    const rng = input(m && m.range, { maxlength: 120, "aria-label": "Range" });
    const col = input(m && m.colour, { maxlength: 120, "aria-label": "Colour" });
    const th = input(m ? m.thickness : 20, { type: "number", min: 5, max: 200, "aria-label": "Thickness" });
    const act = el("input", { type: "checkbox", checked: m ? m.active : true, "aria-label": "Shown" });
    const body = () => ({ supplier: sup.value, range: rng.value, colour: col.value, thickness: Math.round(Number(th.value)), active: act.checked });
    return el("tr", { class: m ? (m.active ? "" : "ba-hidden") : "ba-new" },
      el("td", {}, sup), el("td", {}, rng), el("td", {}, col), el("td", {}, th), el("td", {}, act),
      el("td", {}, el("button", { type: "button", class: "hs-btn" + (m ? "" : " hs-btn-primary"), text: m ? "Save" : "Add", onclick: () => send("materials", m && m.id, body()) })));
  }

  function finRow(f) {
    const code = input(f && f.code, { maxlength: 12, "aria-label": "Code" });
    const name = input(f && f.name, { maxlength: 80, "aria-label": "Name" });
    const ls = el("select", { class: "hs-input", "aria-label": "Mark" },
      ...marks.map((s) => {
        const o = el("option", { value: s, text: s });
        if ((f ? f.mark : "//") === s) o.selected = true;
        return o;
      }));
    const wf = el("input", { type: "checkbox", checked: f ? f.waterfall : false, "aria-label": "Waterfall" });
    const sort = input(f ? f.sort : 0, { type: "number", min: 0, max: 999, "aria-label": "Order" });
    const act = el("input", { type: "checkbox", checked: f ? f.active : true, "aria-label": "Shown" });
    const body = () => ({ code: code.value, name: name.value, mark: ls.value, waterfall: wf.checked, sort: Math.round(Number(sort.value)) || 0, active: act.checked });
    return el("tr", { class: f ? (f.active ? "" : "ba-hidden") : "ba-new" },
      el("td", {}, code), el("td", {}, name), el("td", {}, ls), el("td", {}, wf), el("td", {}, sort), el("td", {}, act),
      el("td", {}, el("button", { type: "button", class: "hs-btn" + (f ? "" : " hs-btn-primary"), text: f ? "Save" : "Add", onclick: () => send("finishes", f && f.id, body()) })));
  }

  async function load() {
    const l = await api("/api/benchtop-lists");
    marks = l.marks;
    $("baMat").replaceChildren(...l.materials.map(matRow), matRow(null));
    $("baFin").replaceChildren(...l.finishes.map(finRow), finRow(null));
  }

  (async () => {
    await (window.cc && window.cc.ready);
    try {
      await load();
      status("");
    } catch (e) {
      status(e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message, true);
    }
  })();
})();
