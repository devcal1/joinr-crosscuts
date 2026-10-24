// The benchtop designer (/benchtop.html; docs/plans/m21-benchtop-designer.md). One plan per job,
// several pieces (Straight, L shape left or right, U), each with its own material, drawn to scale
// (benchtopdraw.js). The "All" view (the default) draws every piece together: drag a piece to
// arrange it, click an edge for its finish, click a size to type it, Place join, Add cut-out.
// Choosing a waterfall finish asks for the drop. Save writes the working copy (PUT); Print plan
// set freezes a new revision letter when something changed and opens the print. ?plan=N&rev=B
// shows a printed revision, read-only. Every rule lives in lib/benchtop.js. Text goes in through
// textContent.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const D = window.BtDraw;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const st = {
    jobId: null,
    plan: null,
    job: null,
    design: { pieces: [] },
    notes: "",
    lists: { materials: [], finishes: [] },
    finishes: {},
    materials: {},
    view: "all", // "all" or "one"
    sel: -1, // the selected piece (-1: none)
    selEdge: null,
    selCut: null,
    mode: "select",
    dirty: false,
    readOnly: true,
    rev: null,
    drawn: null, // the last drawing: {svg, set (bool)}
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
    return isNaN(d) ? "" : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
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

  const newId = () => "p" + Math.random().toString(36).slice(2, 9);
  const piece = () => st.design.pieces[st.sel] || null;

  function markDirty() {
    if (st.readOnly) return;
    st.dirty = true;
    renderHead();
  }

  function changed() {
    markDirty();
    renderAll();
  }

  // ---- the head ------------------------------------------------------------------------------

  function renderHead() {
    const j = st.job || {};
    $("btJob").textContent = [j.name ? "Job " + j.name : "", j.clientName, j.siteAddress].filter(Boolean).join(" · ");
    let rev;
    if (st.rev) rev = "Revision " + st.rev + " · read-only";
    else if (!st.plan || !st.plan.revision) rev = "Not printed yet";
    else if (st.plan.changedSinceRevision || st.dirty) rev = "Rev " + st.plan.revision + " · changed since";
    else rev = "Rev " + st.plan.revision;
    $("btRev").textContent = rev;
    $("btDirty").hidden = !st.dirty;
    $("btSave").disabled = st.readOnly || !st.dirty;
    $("btSave").hidden = !!st.rev;
    $("btPrint").disabled = st.rev ? false : st.readOnly || !st.design.pieces.length;
    $("btPrint").textContent = st.rev ? "Print revision " + st.rev : "Print plan set";
  }

  // ---- the left column -----------------------------------------------------------------------

  function matText(id) {
    const m = st.materials[id];
    return m ? m.colour + " " + m.thickness + " mm" : "No material yet";
  }

  function renderPieces() {
    const ps = st.design.pieces;
    $("btPieceCount").textContent = "Pieces · " + ps.length;
    const cards = [el("button", { type: "button", class: "bt-pc bt-all" + (st.view === "all" ? " on" : ""), onclick: () => { st.view = "all"; renderAll(); } },
      el("h3", {}, el("span", { text: "All" })),
      el("p", { text: ps.length ? "Every piece, to scale. Drag to arrange." : "No pieces yet." }))];
    ps.forEach((p, i) => {
      const extra = [];
      if (p.joins && p.joins.length) extra.push(p.joins.length === 1 ? "1 join" : p.joins.length + " joins");
      if (p.cutouts && p.cutouts.length) extra.push(p.cutouts.length === 1 ? "1 cut-out" : p.cutouts.length + " cut-outs");
      const on = i === st.sel;
      const card = el("div", { class: "bt-pcwrap" },
        el("button", { type: "button", class: "bt-pc" + (on ? " on" : "") + (on && st.view === "one" ? " solo" : ""), onclick: () => selectPiece(i, true) },
          el("h3", {}, el("span", { class: "bt-disc", text: String(i + 1) }), el("span", { text: p.name || D.SHAPE_NAMES[p.shape] })),
          el("p", { text: [D.describe(p)].concat(extra).join(" · ") }),
          el("p", { text: matText(p.materialId) })),
        on && !st.readOnly ? el("button", { type: "button", class: "bt-x", "aria-label": "Delete piece " + (i + 1), title: "Delete piece", text: "×", onclick: deletePiece }) : null);
      cards.push(card);
    });
    $("btPieces").replaceChildren(...cards);
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
    const ps = st.design.pieces;
    if (!ps.length) {
      box.replaceChildren(el("div", { class: "bt-empty", text: st.readOnly ? "No pieces." : "Add a piece to start drawing." }));
      return;
    }
    const all = st.view === "all" || !piece();
    const b = all ? D.bounds(ps) : (() => { const o = D.outline(piece()); return { w: o.w, h: o.h }; })();
    const cw = Math.max(200, box.clientWidth);
    const ch = Math.max(200, box.clientHeight);
    let u = 1;
    for (let k = 0; k < 3; k++) u = 1 / Math.min(cw / (b.w + 140 * u), ch / (b.h + 140 * u));
    const opts = { finishes: st.finishes, u, pad: 70 * u, selEdge: st.selEdge, selCut: st.selCut };
    let svg;
    if (all) {
      svg = D.renderSet(ps, Object.assign(opts, { sel: st.sel })).svg;
    } else {
      svg = D.render(piece(), Object.assign(opts, { index: st.sel })).svg;
    }
    st.drawn = { svg, set: all, u };
    svg.addEventListener("click", onCanvasClick);
    svg.addEventListener("pointerdown", onPointerDown);
    box.replaceChildren(svg);
  }

  function toMm(svg, ev) {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : null;
  }

  // The piece-local point of a click: in the All view each piece is offset by its position.
  function localPoint(ev, i) {
    const q = toMm(st.drawn.svg, ev);
    if (!q) return null;
    const p = st.design.pieces[i];
    return st.drawn.set ? { x: q.x - (p.x || 0), y: q.y - (p.y || 0) } : { x: q.x, y: q.y };
  }

  function pieceAt(ev) {
    const t = ev.target.closest("[data-piece]");
    return t ? Number(t.dataset.piece) : -1;
  }

  let dragMoved = false;

  function onCanvasClick(ev) {
    if (dragMoved) { dragMoved = false; return; }
    const t = ev.target;
    const i = pieceAt(ev);
    if (st.mode === "join") {
      if (st.readOnly || i < 0) return;
      const p = st.design.pieces[i];
      const q = localPoint(ev, i);
      const hit = q && D.runAt(D.outline(p), q.x, q.y);
      if (!hit) return;
      const len = p.runs[hit.run].len;
      p.joins = (p.joins || []).concat([{ run: hit.run, at: Math.max(1, Math.min(len - 1, Math.round(hit.at / 10) * 10)) }]);
      st.sel = i;
      st.mode = "select";
      changed();
      return;
    }
    if (t.dataset && t.dataset.len && !st.readOnly) {
      editLength(t, Number(t.dataset.piece), t.dataset.len);
      return;
    }
    if (t.dataset && t.dataset.edge) {
      st.sel = Number(t.dataset.piece);
      st.selEdge = t.dataset.edge;
      st.selCut = null;
    } else if (t.dataset && t.dataset.cut != null) {
      st.sel = Number(t.dataset.piece);
      st.selCut = Number(t.dataset.cut);
      st.selEdge = null;
    } else if (i >= 0) {
      st.sel = i;
      st.selEdge = null;
      st.selCut = null;
    } else {
      st.selEdge = null;
      st.selCut = null;
    }
    renderAll();
  }

  // Drag a piece (All view, Select): moves in 10 mm steps; saved with the plan.
  function onPointerDown(ev) {
    if (st.readOnly || st.mode !== "select" || !st.drawn.set) return;
    const t = ev.target;
    if (!t.classList.contains("bt-shape")) return;
    const i = Number(t.dataset.piece);
    const p = st.design.pieces[i];
    const g = st.drawn.svg.querySelector(`[data-group="${i}"]`);
    const start = toMm(st.drawn.svg, ev);
    if (!start || !g) return;
    const x0 = p.x || 0;
    const y0 = p.y || 0;
    dragMoved = false;
    if (t.setPointerCapture) t.setPointerCapture(ev.pointerId);
    const move = (e) => {
      const q = toMm(st.drawn.svg, e);
      if (!q) return;
      const nx = Math.round((x0 + q.x - start.x) / 10) * 10;
      const ny = Math.round((y0 + q.y - start.y) / 10) * 10;
      if (nx !== p.x || ny !== p.y) {
        if (Math.abs(nx - x0) + Math.abs(ny - y0) >= 10) dragMoved = true;
        p.x = nx;
        p.y = ny;
        g.setAttribute("transform", `translate(${nx} ${ny})`);
      }
    };
    const up = () => {
      t.removeEventListener("pointermove", move);
      t.removeEventListener("pointerup", up);
      if (dragMoved) {
        st.sel = i;
        markDirty();
        renderAll();
      }
    };
    t.addEventListener("pointermove", move);
    t.addEventListener("pointerup", up);
  }

  // Type a length in place: Enter saves, Esc (or leaving the box) cancels.
  function editLength(textNode, i, key) {
    const box = $("btCanvas");
    const r = textNode.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const p = st.design.pieces[i];
    const cur = D.outline(p).edges.find((e) => e.key === key);
    const inp = el("input", { class: "hs-input bt-inline", type: "number", min: 1, step: 1, value: String(cur.len), "aria-label": cur.name + " length (mm)" });
    inp.style.left = Math.max(0, r.left - b.left + r.width / 2 - 45) + "px";
    inp.style.top = Math.max(0, r.top - b.top + r.height / 2 - 16) + "px";
    let done = false;
    const close = () => { if (!done) { done = true; inp.remove(); } };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key === "Enter") {
        e.preventDefault();
        const v = Math.round(Number(inp.value));
        if (!Number.isFinite(v) || v < 1) { setStatus("Type a length in mm.", true); return; }
        const before = JSON.stringify(p.runs);
        D.setEdgeLen(p, key, v);
        if (p.runs.some((x) => x.len < 50 || x.depth < 50)) {
          p.runs = JSON.parse(before);
          setStatus("That length leaves a run too short.", true);
          close();
          return;
        }
        st.sel = i;
        st.selEdge = key;
        done = true;
        setStatus("");
        changed();
      }
    });
    inp.addEventListener("blur", close);
    box.append(inp);
    inp.focus();
    inp.select();
  }

  // ---- the right panel: finish, material, joins and cut-outs ---------------------------------

  function numInput(value, onset, opts) {
    const o = opts || {};
    return el("input", {
      class: "hs-input", type: "number", inputmode: "numeric", min: o.min || 0, step: 1, value: String(value),
      disabled: st.readOnly, "aria-label": o.label || null,
      onchange: (ev) => {
        const v = Math.round(Number(ev.target.value));
        if (!Number.isFinite(v)) return;
        onset(v);
        changed();
      },
    });
  }

  function field(label, input) {
    return el("label", { class: "bt-f" }, el("span", { class: "hs-label", text: label }), input);
  }

  function section(title, ...kids) {
    return el("div", { class: "bt-sect" }, el("h2", { text: title }), ...kids);
  }

  function askDrop(p, key) {
    const cur = (p.drops && p.drops[key]) || 870;
    const v = window.prompt("Waterfall drop height (mm)", String(cur));
    if (v === null) return false;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 50 || n > 1500) {
      setStatus("The drop must be 50 to 1500 mm.", true);
      return false;
    }
    p.drops = p.drops || {};
    p.drops[key] = n;
    return true;
  }



  function joinsSection(p) {
    const rows = (p.joins || []).map((j, i) => el("div", { class: "bt-item" },
      el("div", { class: "bt-item-head" },
        el("b", { text: `J${i + 1} · ${D.RUN_NAMES[p.shape][j.run] || "Run"}` }),
        st.readOnly ? null : el("button", { type: "button", class: "bt-linkbtn bt-del", text: "Remove", onclick: () => { p.joins.splice(i, 1); changed(); } })),
      field("Position (mm from the run's start)", numInput(j.at, (v) => { j.at = v; }, { min: 1 }))));
    return section("Joins", ...(rows.length ? rows : [el("p", { class: "bt-note", text: "None. Use Place join, then click along a run." })]));
  }


  function materialSection(p) {
    const mats = st.rev ? Object.values(st.materials) : st.lists.materials.filter((m) => m.active || m.id === p.materialId);
    const cur = st.materials[p.materialId] || null;
    const key = (m) => m.supplier + " · " + (m.range || "");
    const sups = [...new Set(mats.map(key))];
    const supKey = cur ? key(cur) : "";
    const colours = [...new Set(mats.filter((m) => key(m) === supKey).map((m) => m.colour))];
    const thick = mats.filter((m) => key(m) === supKey && cur && m.colour === cur.colour);
    const pick = (list) => { p.materialId = list.length ? list[0].id : null; changed(); };
    const s1 = el("select", { class: "hs-input", disabled: st.readOnly, onchange: (ev) => pick(mats.filter((m) => key(m) === ev.target.value)) },
      el("option", { value: "", text: "Choose..." }), ...sups.map((s) => el("option", { value: s, text: s.replace(/ · $/, ""), selected: s === supKey })));
    const s2 = el("select", { class: "hs-input", disabled: st.readOnly || !cur, onchange: (ev) => pick(mats.filter((m) => key(m) === supKey && m.colour === ev.target.value)) },
      ...colours.map((c) => el("option", { value: c, text: c, selected: cur && c === cur.colour })));
    const s3 = el("select", { class: "hs-input", disabled: st.readOnly || !cur, onchange: (ev) => { p.materialId = Number(ev.target.value); changed(); } },
      ...thick.map((m) => el("option", { value: String(m.id), text: m.thickness + " mm", selected: m.id === p.materialId })));
    return section("Material",
      field("Supplier · range", s1),
      el("div", { class: "bt-row" }, field("Colour", s2), field("Thickness", s3)),
      el("div", { class: "bt-note", text: mats.length ? "From the list in Admin › Benchtop lists." : "No materials yet: an admin adds them in Admin › Benchtop lists." }));
  }



  function edgeSection(p, o) {
    const e = o.edges.find((x) => x.key === st.selEdge);
    if (!e) return null;
    const cur = p.edges[e.key] != null ? p.edges[e.key] : null;
    const opts = st.rev ? Object.values(st.finishes) : st.lists.finishes.filter((f) => f.active || f.id === cur);
    const choose = (f) => {
      if (f.waterfall && !askDrop(p, e.key)) return;
      if (!f.waterfall && p.drops) delete p.drops[e.key];
      p.edges[e.key] = f.id;
      changed();
    };
    const seg = el("div", { class: "bt-seg" },
      ...opts.filter((f) => !f.waterfall || e.end).map((f) => el("button", {
        type: "button", class: "hs-btn" + (cur === f.id ? " on" : ""), disabled: st.readOnly,
        "aria-pressed": cur === f.id ? "true" : "false", text: f.mark + "  " + f.name, onclick: () => choose(f),
      })),
      el("button", {
        type: "button", class: "hs-btn" + (cur == null ? " on" : ""), disabled: st.readOnly, text: "None",
        onclick: () => { delete p.edges[e.key]; if (p.drops) delete p.drops[e.key]; changed(); },
      }));
    const kids = [el("div", { class: "bt-note", text: `Piece ${st.sel + 1} · ${e.name} · ${e.len} mm (click the size on the drawing to change it)` }),
      el("div", { class: "bt-f" }, el("span", { class: "hs-label", text: "Edge finish" }), seg)];
    const f = cur != null ? st.finishes[cur] : null;
    if (f && f.waterfall) kids.push(field("Waterfall drop (mm)", numInput((p.drops && p.drops[e.key]) || 870, (v) => { p.drops = p.drops || {}; p.drops[e.key] = v; }, { min: 50 })));
    const mat = st.materials[p.materialId];
    p.thick = p.thick || {};
    kids.push(field("Edge thickness (mm, blank = the material's" + (mat ? " " + mat.thickness : "") + ")", el("input", {
      class: "hs-input", type: "number", min: 5, max: 200, step: 1, value: p.thick[e.key] ? String(p.thick[e.key]) : "", placeholder: mat ? String(mat.thickness) : "",
      disabled: st.readOnly,
      onchange: (ev) => {
        const v = Math.round(Number(ev.target.value));
        if (!ev.target.value || !Number.isFinite(v) || (mat && v === mat.thickness)) delete p.thick[e.key];
        else p.thick[e.key] = v;
        changed();
      },
    })));
    if (!st.readOnly) {
      kids.push(el("button", {
        type: "button", class: "hs-btn" + (p.datum === e.key ? " on" : ""), disabled: p.datum === e.key,
        text: p.datum === e.key ? "Reference edge for cut-outs" : "Make this the reference edge",
        onclick: () => { p.datum = e.key; changed(); },
      }));
    }
    return section("Selected edge", ...kids);
  }

  function pieceSection(p, o) {
    const datum = el("select", { class: "hs-input", disabled: st.readOnly, onchange: (ev) => { p.datum = ev.target.value; changed(); } },
      ...o.edges.map((x) => el("option", { value: x.key, text: x.name, selected: x.key === (p.datum || "e0") })));
    return section(`Piece ${st.sel + 1} · ${D.SHAPE_NAMES[p.shape]}`,
      field("Name", el("input", {
        class: "hs-input", value: p.name, maxlength: 80, disabled: st.readOnly, placeholder: "e.g. Island",
        onchange: (ev) => { p.name = ev.target.value.trim(); changed(); },
      })),
      field("Reference edge (located cut-outs are measured from it)", datum));
  }

  function cutSection(p, o) {
    const e = o.edges.find((x) => x.key === (p.datum || "e0")) || o.edges[0];
    const rows = (p.cutouts || []).map((c, i) => {
      const kind = el("select", { class: "hs-input", disabled: st.readOnly, onchange: (ev) => { c.kind = ev.target.value; if (c.kind === "tap") c.h = c.w = 35; changed(); } },
        ...Object.entries(D.KIND_NAMES).map(([k, n]) => el("option", { value: k, text: n, selected: c.kind === k })));
      const loc = el("input", { type: "checkbox", disabled: st.readOnly, onchange: (ev) => { c.located = ev.target.checked; changed(); } });
      loc.checked = !!c.located;
      const kids = [
        el("div", { class: "bt-item-head" },
          el("b", { text: c.label ? D.KIND_NAMES[c.kind] + " · " + c.label : D.KIND_NAMES[c.kind] }),
          st.readOnly ? null : el("button", { type: "button", class: "bt-linkbtn bt-del", text: "Remove", onclick: () => { p.cutouts.splice(i, 1); st.selCut = null; changed(); } })),
        el("div", { class: "bt-row" }, field("Kind", kind), field("Label", el("input", {
          class: "hs-input", value: c.label || "", maxlength: 40, disabled: st.readOnly, placeholder: "e.g. undermount",
          onchange: (ev) => { c.label = ev.target.value.trim(); changed(); },
        }))),
        el("label", { class: "bt-check" }, loc, el("span", { text: "Show location (from the " + e.name.toLowerCase() + ")" })),
        el("div", { class: "bt-row" },
          field("Along, " + e.from, numInput(c.along, (v) => { c.along = v; })),
          field("In from it", numInput(c.in, (v) => { c.in = v; }))),
        c.kind === "tap"
          ? el("div", { class: "bt-row" }, field("Outline Ø (drawing only)", numInput(c.w, (v) => { c.w = v; c.h = v; }, { min: 10 })))
          : el("div", { class: "bt-row" }, field("Outline along (drawing only)", numInput(c.w, (v) => { c.w = v; }, { min: 10 })), field("Across", numInput(c.h, (v) => { c.h = v; }, { min: 10 }))),
      ];
      return el("div", { class: "bt-item" + (st.selCut === i ? " on" : ""), onclick: (ev) => {
        if (ev.target.closest("input,select,button,label")) return;
        st.selCut = i; st.selEdge = null; renderCanvas(); renderRight();
      } }, ...kids);
    });
    return section("Cut-outs", ...(rows.length ? rows : [el("p", { class: "bt-note", text: "None. Add cut-out adds one to this piece. Sizes are not shown on the plan; tick Show location to dimension one from the reference edge." })]));
  }

  function legendSection() {
    const fs = st.rev ? Object.values(st.finishes) : st.lists.finishes.filter((f) => f.active);
    const rows = [];
    for (const m of ["X", "//", "[]"]) {
      const names = fs.filter((f) => f.mark === m).map((f) => f.name);
      if (names.length) rows.push(D.sample(m), el("span", { text: m + " " + names.join(", ") }));
    }
    const thick = new Set();
    for (const p of st.design.pieces) for (const v of Object.values(p.thick || {})) thick.add(v);
    if (thick.size) rows.push(D.sample("bold"), el("span", { text: "Bold: " + [...thick].sort((a, b) => a - b).map((t) => t + " mm").join(", ") + " edge" }));
    rows.push(D.sample("plain"), el("span", { text: "No mark: finish not set" }));
    rows.push(D.sample("join"), el("span", { text: "Join" }));
    rows.push(D.sample("cut"), el("span", { text: "Cut-out" }));
    return section("Edge legend", el("div", { class: "bt-leg" }, ...rows));
  }

  function totalsSection() {
    if (!st.design.pieces.length) return null;
    const t = D.totals(st.design.pieces, st.finishes, st.materials);
    const lines = [el("div", {}, el("b", { text: "Area " + t.m2 + " m²" }))];
    if (t.mats.length > 1) for (const m of t.mats) lines.push(el("div", { text: m.name + ": " + m.m2 + " m²" }));
    lines.push(el("div", { text: t.fins.map((f) => f.name + (f.mark ? " " + f.mark : "") + " " + f.m + " m").join(" · ") }));
    if (t.thick.length) lines.push(el("div", { text: t.thick.map((x) => x.name + " " + x.m + " m").join(" · ") }));
    return section("Totals", el("div", { class: "bt-totals" }, ...lines));
  }

  function renderRight() {
    const box = $("btRight");
    const p = piece();
    if (!p) {
      box.replaceChildren(...[section("Selection", el("p", { class: "bt-note", text: st.design.pieces.length ? "Click a piece or an edge on the drawing." : "Add a piece on the left." })), totalsSection(), legendSection()].filter(Boolean));
      return;
    }
    const o = D.outline(p);
    if (st.selEdge && !o.edges.some((e) => e.key === st.selEdge)) st.selEdge = null;
    box.replaceChildren(...[edgeSection(p, o), pieceSection(p, o), materialSection(p), cutSection(p, o), joinsSection(p), totalsSection(), legendSection()].filter(Boolean));
  }

  function renderAll() {
    renderHead();
    renderPieces();
    renderRevs();
    renderCanvas();
    renderRight();
  }

  // ---- actions -------------------------------------------------------------------------------

  // From the list: the first click selects (staying in All); clicking the selected one shows it alone.
  function selectPiece(i, fromList) {
    if (fromList && st.sel === i) st.view = st.view === "one" ? "all" : "one";
    st.sel = i;
    st.selEdge = null;
    st.selCut = null;
    renderAll();
  }

  function addPiece(shape) {
    const ps = st.design.pieces;
    const p = { id: newId(), name: "", shape, materialId: null, edges: {}, drops: {}, thick: {}, datum: "e0", joins: [], cutouts: [], x: 0, y: 0 };
    const last = ps.length ? ps[ps.length - 1] : null;
    if (last && last.materialId != null) p.materialId = last.materialId;
    if (shape === "straight") p.runs = [{ len: 2400, depth: 600 }];
    else if (shape === "l" || shape === "lr") p.runs = [{ len: 3600, depth: 600 }, { len: 2400, depth: 600 }];
    else p.runs = [{ len: 3000, depth: 600 }, { len: 2400, depth: 600 }, { len: 2400, depth: 600 }];
    if (ps.length) {
      const b = D.bounds(ps);
      p.x = Math.round(b.x0 / 10) * 10;
      p.y = Math.round((b.y0 + b.h + 600) / 10) * 10;
    }
    ps.push(p);
    st.view = "all";
    st.sel = ps.length - 1;
    st.selEdge = null;
    st.selCut = null;
    changed();
  }

  function deletePiece() {
    const p = piece();
    if (!p || !confirm(`Delete piece ${st.sel + 1}${p.name ? " (" + p.name + ")" : ""}?`)) return;
    st.design.pieces.splice(st.sel, 1);
    st.sel = -1;
    st.view = "all";
    st.selEdge = null;
    st.selCut = null;
    changed();
  }

  function addCut() {
    const p = piece();
    if (!p || st.readOnly) {
      setStatus("Click a piece first, then Add cut-out.", true);
      return;
    }
    p.cutouts = p.cutouts || [];
    p.cutouts.push({ kind: "sink", label: "", w: 800, h: 450, edge: p.datum || "e0", located: false, along: 200, in: 75 });
    st.selCut = p.cutouts.length - 1;
    st.selEdge = null;
    setStatus("");
    changed();
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
        st.design = { pieces: (snap.design.pieces || []).filter((p) => p.shape !== "leg") };
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
