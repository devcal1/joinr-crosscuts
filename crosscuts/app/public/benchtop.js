// The benchtop designer (/benchtop.html; docs/plans/m21-benchtop-designer.md). One plan per job,
// several pieces (Straight, L, U, Waterfall leg), each with its own material, side lengths and
// depths in mm, edge finishes, joins and cut-outs, drawn to scale (benchtopdraw.js). Save writes
// the working copy (PUT); Print plan set freezes a new revision letter when something changed and
// opens the print. ?plan=N&rev=B shows a printed revision, read-only. Every rule lives in
// lib/benchtop.js; this only hides what the user can't use. Text goes in through textContent.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const D = window.BtDraw;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const st = {
    jobId: null,
    plan: null, // the plan as saved (null: none yet)
    job: null,
    design: { pieces: [] },
    notes: "",
    lists: { materials: [], finishes: [] },
    finishes: {}, // id -> finish (for drawing)
    materials: {}, // id -> material
    sel: 0,
    selEdge: null,
    selCut: null,
    mode: "select",
    dirty: false,
    readOnly: true,
    rev: null, // the revision letter when showing one
    revData: null,
  };

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  function setStatus(msg, err) {
    const n = $("btStatus");
    n.textContent = msg || "";
    n.className = "bt-status" + (err ? " err" : "");
  }

  function failText(e) {
    if (e instanceof TypeError) return "Couldn't reach the server. Try again.";
    return (e && e.message) || "That didn't work.";
  }

  function newId() {
    return "p" + Math.random().toString(36).slice(2, 9);
  }

  function piece() {
    return st.design.pieces[st.sel] || null;
  }

  function markDirty() {
    if (st.readOnly) return;
    st.dirty = true;
    renderHead();
  }

  // ---- the head ------------------------------------------------------------------------------

  function renderHead() {
    const j = st.job || {};
    $("btJob").textContent = [j.name ? "Job " + j.name : "", j.clientName, j.siteAddress].filter(Boolean).join(" · ");
    let rev = "";
    if (st.rev) rev = "Revision " + st.rev + " · read-only";
    else if (!st.plan || !st.plan.revision) rev = "Not printed yet";
    else if (st.plan.changedSinceRevision || st.dirty) rev = "Rev " + st.plan.revision + " · changed since";
    else rev = "Rev " + st.plan.revision;
    $("btRev").textContent = rev;
    $("btDirty").hidden = !st.dirty;
    $("btSave").disabled = st.readOnly || !st.dirty;
    $("btSave").hidden = !!st.rev;
    const mayPrint = st.rev ? true : !st.readOnly && st.design.pieces.length > 0;
    $("btPrint").disabled = !mayPrint;
    $("btPrint").textContent = st.rev ? "Print revision " + st.rev : "Print plan set";
  }

  // ---- the left column -----------------------------------------------------------------------

  function matText(id) {
    const m = st.materials[id];
    return m ? [m.colour, m.thickness + " mm"].join(" ") : "No material yet";
  }

  function renderPieces() {
    const list = $("btPieces");
    const ps = st.design.pieces;
    $("btPieceCount").textContent = "Pieces · " + ps.length;
    list.replaceChildren(...ps.map((p, i) => {
      const extra = [];
      if (p.joins && p.joins.length) extra.push(p.joins.length === 1 ? "1 join" : p.joins.length + " joins");
      if (p.cutouts && p.cutouts.length) extra.push(p.cutouts.length === 1 ? "1 cut-out" : p.cutouts.length + " cut-outs");
      return el("button", { type: "button", class: "bt-pc" + (i === st.sel ? " on" : ""), onclick: () => selectPiece(i) },
        el("h3", {}, el("span", { class: "bt-disc", text: String(i + 1) }), el("span", { text: p.name || D.SHAPE_NAMES[p.shape] })),
        el("p", { text: [D.describe(p)].concat(extra).join(" · ") }),
        el("p", { text: matText(p.materialId) }));
    }));
    if (!ps.length) list.append(el("p", { class: "bt-muted", text: st.readOnly ? "No pieces." : "No pieces yet. Add one below." }));
    $("btAddWrap").hidden = st.readOnly;
    $("btNotes").value = st.notes;
    $("btNotes").readOnly = st.readOnly;
  }

  function renderRevs() {
    const wrap = $("btRevs");
    const revs = (st.plan && st.plan.revisions) || [];
    if (!revs.length) {
      wrap.replaceChildren(el("p", { class: "bt-muted", text: "None yet. Printing the plan set makes revision A." }));
      return;
    }
    wrap.replaceChildren(...revs.map((r) => el("div", { class: "bt-revrow" },
      el("b", { text: r.letter }),
      el("span", { text: [fmtDate(r.printedAt), r.printedBy].filter(Boolean).join(" · ") }),
      el("a", { href: "/benchtop.html?plan=" + st.plan.id + "&rev=" + r.letter, text: "Open" }),
      el("a", { href: "/benchtopprint.html?plan=" + st.plan.id + "&rev=" + r.letter, text: "Print" }))));
  }

  // ---- the drawing ---------------------------------------------------------------------------

  function renderCanvas() {
    const box = $("btCanvas");
    box.classList.toggle("join", st.mode === "join");
    document.querySelectorAll(".bt-mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === st.mode));
    const p = piece();
    if (!p) {
      box.replaceChildren(el("div", { class: "bt-empty", text: "Add a piece to start drawing." }));
      return;
    }
    const o = D.outline(p);
    const cw = Math.max(200, box.clientWidth);
    const ch = Math.max(200, box.clientHeight);
    let u = 1;
    for (let k = 0; k < 3; k++) {
      const pad = 70 * u;
      const s = Math.min(cw / (o.w + 2 * pad), ch / (o.h + 2 * pad));
      u = 1 / s;
    }
    const r = D.render(p, { finishes: st.finishes, u, selEdge: st.selEdge, selCut: st.selCut, pad: 70 * u });
    r.svg.addEventListener("click", (ev) => onCanvasClick(ev, r));
    box.replaceChildren(r.svg);
  }

  function toMm(svg, ev) {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : null;
  }

  function onCanvasClick(ev, r) {
    const p = piece();
    if (!p) return;
    const t = ev.target;
    if (st.mode === "join") {
      if (st.readOnly || p.shape === "leg") return;
      const q = toMm(r.svg, ev);
      if (!q) return;
      const hit = D.runAt(r.outline, q.x, q.y);
      if (!hit) return;
      const len = p.runs[hit.run].len;
      const at = Math.max(1, Math.min(len - 1, Math.round(hit.at / 10) * 10));
      p.joins = (p.joins || []).concat([{ run: hit.run, at }]);
      st.mode = "select";
      markDirty();
      renderAll();
      return;
    }
    if (t.dataset && t.dataset.edge) {
      st.selEdge = t.dataset.edge;
      st.selCut = null;
    } else if (t.dataset && t.dataset.cut != null) {
      st.selCut = Number(t.dataset.cut);
      st.selEdge = null;
    } else {
      st.selEdge = null;
      st.selCut = null;
    }
    renderCanvas();
    renderRight();
  }

  // ---- the right panel -----------------------------------------------------------------------

  function numInput(value, onset, opts) {
    const o = opts || {};
    return el("input", {
      class: "hs-input", type: "number", inputmode: "numeric", min: o.min || 0, step: 1, value: String(value),
      disabled: st.readOnly, "aria-label": o.label || null,
      onchange: (ev) => {
        const v = Math.round(Number(ev.target.value));
        if (!Number.isFinite(v)) return;
        onset(v);
        markDirty();
        renderAll();
      },
    });
  }

  function field(label, input) {
    return el("label", { class: "bt-f" }, el("span", { class: "hs-label", text: label }), input);
  }

  function section(title, ...kids) {
    return el("div", { class: "bt-sect" }, el("h2", { text: title }), ...kids);
  }

  function edgeSection(p, o) {
    const e = o.edges.find((x) => x.key === st.selEdge);
    if (!e) return null;
    const cur = p.edges[e.key] != null ? p.edges[e.key] : null;
    const active = st.lists.finishes.filter((f) => f.active || f.id === cur);
    const opts = st.rev ? Object.values(st.finishes) : active;
    const seg = el("div", { class: "bt-seg" },
      ...opts.map((f) => el("button", {
        type: "button", class: "hs-btn" + (cur === f.id ? " on" : ""), disabled: st.readOnly,
        "aria-pressed": cur === f.id ? "true" : "false", text: f.name,
        onclick: () => { p.edges[e.key] = f.id; markDirty(); renderAll(); },
      })),
      el("button", {
        type: "button", class: "hs-btn" + (cur == null ? " on" : ""), disabled: st.readOnly, text: "None",
        onclick: () => { delete p.edges[e.key]; markDirty(); renderAll(); },
      }));
    return section("Selected edge",
      el("div", { class: "bt-note", text: `Piece ${st.sel + 1} · ${e.name} · ${e.len} mm` }),
      el("div", { class: "bt-f" }, el("span", { class: "hs-label", text: "Edge finish" }), seg));
  }

  function pieceSection(p, o) {
    const kids = [field("Name", el("input", {
      class: "hs-input", value: p.name, maxlength: 80, disabled: st.readOnly,
      onchange: (ev) => { p.name = ev.target.value.trim(); markDirty(); renderAll(); },
    }))];
    if (p.shape === "leg") {
      kids.push(el("div", { class: "bt-row" },
        field("Width", numInput(p.leg.width, (v) => { p.leg.width = v; })),
        field("Height", numInput(p.leg.height, (v) => { p.leg.height = v; }))));
      const others = st.design.pieces.map((q, i) => [q, i]).filter(([q]) => q.shape !== "leg");
      const sel = el("select", { class: "hs-input", disabled: st.readOnly, onchange: (ev) => { p.leg.attachTo = ev.target.value || null; markDirty(); renderAll(); } },
        el("option", { value: "", text: "Not joined yet" }),
        ...others.map(([q, i]) => el("option", { value: q.id, text: `Piece ${i + 1} · ${q.name || D.SHAPE_NAMES[q.shape]}`, selected: p.leg.attachTo === q.id })));
      const end = el("select", { class: "hs-input", disabled: st.readOnly, onchange: (ev) => { p.leg.end = ev.target.value; markDirty(); renderAll(); } },
        el("option", { value: "start", text: "Left / start end", selected: p.leg.end !== "end" }),
        el("option", { value: "end", text: "Right / far end", selected: p.leg.end === "end" }));
      kids.push(el("div", { class: "bt-row" }, field("Mitred to", sel), field("End", end)));
    } else {
      p.runs.forEach((r, i) => {
        kids.push(el("div", { class: "bt-row" },
          field(D.RUN_NAMES[p.shape][i] + " length", numInput(r.len, (v) => { r.len = v; })),
          field("Depth", numInput(r.depth, (v) => { r.depth = v; }))));
      });
    }
    if (!st.readOnly) {
      kids.push(el("div", { class: "bt-row" },
        el("button", { type: "button", class: "bt-linkbtn bt-del", text: "Delete piece", onclick: deletePiece })));
    }
    return section(`Piece ${st.sel + 1} · ${p.name || D.SHAPE_NAMES[p.shape]}`, ...kids);
  }

  function joinsSection(p, o) {
    if (p.shape === "leg") return null;
    const rows = (p.joins || []).map((j, i) => el("div", { class: "bt-item" },
      el("div", { class: "bt-item-head" },
        el("b", { text: `J${i + 1} · ${D.RUN_NAMES[p.shape][j.run] || "Run"}` }),
        st.readOnly ? null : el("button", { type: "button", class: "bt-linkbtn bt-del", text: "Remove", onclick: () => { p.joins.splice(i, 1); markDirty(); renderAll(); } })),
      field("Position (mm from the run's start)", numInput(j.at, (v) => { j.at = v; }, { min: 1 }))));
    return section("Joins", ...(rows.length ? rows : [el("p", { class: "bt-note", text: "None. Use Place join, then click along a run." })]));
  }

  function cutSection(p, o) {
    const rows = (p.cutouts || []).map((c, i) => {
      const e = o.edges.find((x) => x.key === c.edge) || o.edges[0];
      const kind = el("select", { class: "hs-input", disabled: st.readOnly, onchange: (ev) => { c.kind = ev.target.value; if (c.kind === "tap") c.h = c.w = 35; markDirty(); renderAll(); } },
        ...Object.entries(D.KIND_NAMES).map(([k, n]) => el("option", { value: k, text: n, selected: c.kind === k })));
      const edge = el("select", { class: "hs-input", disabled: st.readOnly, onchange: (ev) => { c.edge = ev.target.value; markDirty(); renderAll(); } },
        ...o.edges.map((x) => el("option", { value: x.key, text: x.name, selected: x.key === c.edge })));
      const size = c.kind === "tap"
        ? el("div", { class: "bt-row" }, field("Diameter", numInput(c.w, (v) => { c.w = v; c.h = v; }, { min: 10 })))
        : el("div", { class: "bt-row" }, field("Along edge", numInput(c.w, (v) => { c.w = v; }, { min: 10 })), field("Across", numInput(c.h, (v) => { c.h = v; }, { min: 10 })));
      return el("div", { class: "bt-item" + (st.selCut === i ? " on" : ""), onclick: (ev) => {
        if (ev.target.closest("input,select,button")) return;
        st.selCut = i; st.selEdge = null; renderCanvas(); renderRight();
      } },
        el("div", { class: "bt-item-head" },
          el("b", { text: `${c.label || D.KIND_NAMES[c.kind]} · ${c.kind === "tap" ? "Ø" + c.w : c.w + " × " + c.h}` }),
          st.readOnly ? null : el("button", { type: "button", class: "bt-linkbtn bt-del", text: "Remove", onclick: () => { p.cutouts.splice(i, 1); st.selCut = null; markDirty(); renderAll(); } })),
        el("div", { class: "bt-row" }, field("Kind", kind), field("Label", el("input", {
          class: "hs-input", value: c.label || "", maxlength: 40, disabled: st.readOnly, placeholder: "e.g. undermount",
          onchange: (ev) => { c.label = ev.target.value.trim(); markDirty(); renderAll(); },
        }))),
        size,
        field("Measured from edge", edge),
        el("div", { class: "bt-row" },
          field("Along, " + e.from, numInput(c.along, (v) => { c.along = v; })),
          field("In from edge", numInput(c.in, (v) => { c.in = v; }))));
    });
    return section("Cut-outs", ...(rows.length ? rows : [el("p", { class: "bt-note", text: "None. Sizes and positions are to the cut-out's near sides." })]));
  }

  function materialSection(p) {
    const mats = st.rev ? Object.values(st.materials) : st.lists.materials.filter((m) => m.active || m.id === p.materialId);
    const cur = st.materials[p.materialId] || null;
    const key = (m) => m.supplier + " · " + (m.range || "");
    const sups = [...new Set(mats.map(key))];
    const supKey = cur ? key(cur) : "";
    const colours = [...new Set(mats.filter((m) => key(m) === supKey).map((m) => m.colour))];
    const thick = mats.filter((m) => key(m) === supKey && cur && m.colour === cur.colour);
    const pick = (list) => { p.materialId = list.length ? list[0].id : null; markDirty(); renderAll(); };
    const s1 = el("select", { class: "hs-input", disabled: st.readOnly, onchange: (ev) => pick(mats.filter((m) => key(m) === ev.target.value)) },
      el("option", { value: "", text: "Choose..." }), ...sups.map((s) => el("option", { value: s, text: s.replace(/ · $/, ""), selected: s === supKey })));
    const s2 = el("select", { class: "hs-input", disabled: st.readOnly || !cur, onchange: (ev) => pick(mats.filter((m) => key(m) === supKey && m.colour === ev.target.value)) },
      ...colours.map((c) => el("option", { value: c, text: c, selected: cur && c === cur.colour })));
    const s3 = el("select", { class: "hs-input", disabled: st.readOnly || !cur, onchange: (ev) => { p.materialId = Number(ev.target.value); markDirty(); renderAll(); } },
      ...thick.map((m) => el("option", { value: String(m.id), text: m.thickness + " mm", selected: m.id === p.materialId })));
    return section("Material",
      field("Supplier · range", s1),
      el("div", { class: "bt-row" }, field("Colour", s2), field("Thickness", s3)),
      el("div", { class: "bt-note", text: mats.length ? "From the list in Admin › Benchtop lists." : "No materials yet: an admin adds them in Admin › Benchtop lists." }));
  }

  function legendSvg(style) {
    const NS = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 48 10");
    const mk = (y, cls) => {
      const l = document.createElementNS(NS, "line");
      l.setAttribute("x1", "0"); l.setAttribute("x2", "48"); l.setAttribute("y1", String(y)); l.setAttribute("y2", String(y));
      l.setAttribute("class", cls);
      s.append(l);
    };
    if (style === "double") { mk(3, "bt-edge bt-ls-double"); mk(7, "bt-edge bt-ls-double"); }
    else if (style === "join") mk(5, "bt-join");
    else mk(5, "bt-edge bt-ls-" + style);
    return s;
  }

  function legendSection() {
    const fs = st.rev ? Object.values(st.finishes) : st.lists.finishes.filter((f) => f.active);
    const rows = [];
    for (const f of fs) rows.push(legendSvg(f.lineStyle), el("span", { text: `${f.code} · ${f.name}` }));
    rows.push(legendSvg("none"), el("span", { text: "No finish set" }));
    rows.push(legendSvg("join"), el("span", { text: "Join" }));
    return section("Edge legend", el("div", { class: "bt-leg" }, ...rows));
  }

  function renderRight() {
    const box = $("btRight");
    const p = piece();
    if (!p) {
      box.replaceChildren(legendSection());
      return;
    }
    const o = D.outline(p);
    if (st.selEdge && !o.edges.some((e) => e.key === st.selEdge)) st.selEdge = null;
    box.replaceChildren(...[edgeSection(p, o), pieceSection(p, o), joinsSection(p, o), cutSection(p, o), materialSection(p), legendSection()].filter(Boolean));
  }

  function renderAll() {
    renderHead();
    renderPieces();
    renderRevs();
    renderCanvas();
    renderRight();
  }

  // ---- actions -------------------------------------------------------------------------------

  function selectPiece(i) {
    st.sel = i;
    st.selEdge = null;
    st.selCut = null;
    renderAll();
  }

  function addPiece(shape) {
    const ps = st.design.pieces;
    const p = { id: newId(), name: "", shape, materialId: null, edges: {}, joins: [], cutouts: [] };
    const last = ps.length ? ps[ps.length - 1] : null;
    if (last && last.materialId != null) p.materialId = last.materialId;
    if (shape === "straight") p.runs = [{ len: 2400, depth: 600 }];
    else if (shape === "l") p.runs = [{ len: 3600, depth: 600 }, { len: 2400, depth: 600 }];
    else if (shape === "u") p.runs = [{ len: 3000, depth: 600 }, { len: 2400, depth: 600 }, { len: 2400, depth: 600 }];
    else {
      const host = ps.slice().reverse().find((q) => q.shape !== "leg");
      p.runs = [];
      p.leg = { width: host ? host.runs[0].depth : 600, height: 870, attachTo: host ? host.id : null, end: "end" };
      const mitre = st.lists.finishes.find((f) => f.active && f.lineStyle === "double");
      if (mitre) p.edges.e0 = mitre.id;
    }
    ps.push(p);
    selectPiece(ps.length - 1);
    markDirty();
  }

  function deletePiece() {
    const p = piece();
    if (!p || !confirm(`Delete piece ${st.sel + 1}?`)) return;
    st.design.pieces.splice(st.sel, 1);
    for (const q of st.design.pieces) if (q.shape === "leg" && q.leg.attachTo === p.id) q.leg.attachTo = null;
    st.sel = Math.max(0, st.sel - 1);
    markDirty();
    selectPiece(st.sel);
  }

  function addCut() {
    const p = piece();
    if (!p || st.readOnly) return;
    p.cutouts = p.cutouts || [];
    p.cutouts.push({ kind: "sink", label: "", w: 800, h: 450, edge: p.shape === "leg" ? "e0" : "e0", along: 200, in: 75 });
    st.selCut = p.cutouts.length - 1;
    st.selEdge = null;
    markDirty();
    renderAll();
  }

  async function save() {
    if (st.readOnly || !st.dirty) return true;
    const payload = { design: st.design, notes: st.notes };
    $("btSave").disabled = true;
    try {
      let plan;
      if (!st.plan) {
        plan = await api("/api/job-records/" + encodeURIComponent(st.jobId) + "/benchtop-plan", { method: "POST", body: JSON.stringify(payload) });
        history.replaceState(null, "", "/benchtop.html?plan=" + plan.id);
      } else {
        plan = await api("/api/benchtop-plans/" + st.plan.id, { method: "PUT", body: JSON.stringify(Object.assign(payload, { expectUpdatedAt: st.plan.updatedAt })) });
      }
      st.plan = plan;
      st.dirty = false;
      setStatus("Saved.");
      renderAll();
      return true;
    } catch (e) {
      setStatus(failText(e), true);
      renderHead();
      return false;
    }
  }

  async function print() {
    if (st.rev) {
      location.href = "/benchtopprint.html?plan=" + st.plan.id + "&rev=" + st.rev;
      return;
    }
    if (!(await save())) return;
    try {
      const r = await api("/api/benchtop-plans/" + st.plan.id + "/print", { method: "POST", body: "{}" });
      location.href = "/benchtopprint.html?plan=" + st.plan.id + "&rev=" + encodeURIComponent(r.letter);
    } catch (e) {
      setStatus(failText(e), true);
    }
  }

  // ---- start-up ------------------------------------------------------------------------------

  function useLists(l) {
    st.lists = l;
    st.finishes = {};
    for (const f of l.finishes) st.finishes[f.id] = f;
    st.materials = {};
    for (const m of l.materials) st.materials[m.id] = m;
  }

  function usePlan(plan, job) {
    st.plan = plan;
    st.job = plan ? plan.job : job;
    st.jobId = st.job ? st.job.id : st.jobId;
    st.design = plan ? JSON.parse(JSON.stringify(plan.design)) : { pieces: [] };
    st.notes = plan ? plan.notes : "";
  }

  async function start() {
    await (window.cc && window.cc.ready);
    const q = new URLSearchParams(location.search);
    const planId = q.get("plan");
    const jobId = q.get("job");
    const rev = q.get("rev");
    try {
      useLists(await api("/api/benchtop-lists"));
      if (planId) {
        usePlan(await api("/api/benchtop-plans/" + encodeURIComponent(planId)));
      } else if (jobId) {
        st.jobId = jobId;
        const r = await api("/api/job-records/" + encodeURIComponent(jobId) + "/benchtop-plan");
        usePlan(r.plan, r.job);
        if (r.plan) history.replaceState(null, "", "/benchtop.html?plan=" + r.plan.id);
      } else {
        setStatus("Open a benchtop plan from its job, or from the list on the Benchtops page.", true);
        return;
      }
      if (rev && st.plan) {
        const snap = await api("/api/benchtop-plans/" + st.plan.id + "/revisions/" + encodeURIComponent(rev));
        st.rev = snap.letter;
        st.revData = snap;
        st.design = snap.design;
        st.notes = snap.notes;
        st.job = snap.job;
        st.finishes = {};
        for (const f of Object.values(snap.finishes)) st.finishes[f.id] = f;
        st.materials = {};
        for (const m of Object.values(snap.materials)) st.materials[m.id] = m;
        const bar = $("btRevBar");
        bar.hidden = false;
        bar.replaceChildren(
          el("span", {}, el("b", { text: "Revision " + snap.letter }), document.createTextNode(", printed " + fmtDate(snap.date) + (snap.printedBy ? " by " + snap.printedBy : "") + ". Read-only.")),
          el("a", { class: "hs-btn", href: "/benchtop.html?plan=" + st.plan.id, text: "Back to the plan" }));
      }
    } catch (e) {
      setStatus(failText(e), true);
      return;
    }
    st.readOnly = !!st.rev || !can("jobs.edit") || !!(st.job && st.job.archived);
    document.title = "Benchtop plan" + (st.job && st.job.name ? " · " + st.job.name : "") + " - Crosscuts";
    setStatus(st.job && st.job.archived && !st.rev ? "The job is archived, so the plan is read-only." : "");
    $("btMain").hidden = false;
    if (st.readOnly) {
      $("btAddCut").hidden = true;
      document.querySelector('.bt-mode[data-mode="join"]').hidden = true;
      $("btHint").textContent = st.rev ? "A printed revision. Open the plan to change it." : "Read-only.";
    }
    renderAll();
  }

  document.querySelectorAll(".bt-addbtn").forEach((b) => b.addEventListener("click", () => addPiece(b.dataset.shape)));
  document.querySelectorAll(".bt-mode").forEach((b) => b.addEventListener("click", () => {
    st.mode = b.dataset.mode;
    renderCanvas();
  }));
  $("btAddCut").addEventListener("click", addCut);
  $("btSave").addEventListener("click", save);
  $("btPrint").addEventListener("click", print);
  $("btNotes").addEventListener("input", (ev) => { st.notes = ev.target.value; markDirty(); });
  window.addEventListener("resize", () => { if (!$("btMain").hidden) renderCanvas(); });
  window.addEventListener("beforeunload", (ev) => {
    if (st.dirty) { ev.preventDefault(); ev.returnValue = ""; }
  });

  start();
})();
