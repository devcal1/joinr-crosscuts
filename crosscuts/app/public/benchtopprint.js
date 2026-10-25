// The benchtop plan set (/benchtopprint.html?plan=N&rev=B; docs/plans/m21-benchtop-designer.md).
// Prints one frozen revision from GET /api/benchtop-plans/:id/revisions/:letter on A4 landscape
// sheets, black on white, the stone-order letterhead on the first.
//
// Each sheet (Todd, 2026-10-25): the main column on the left holds the drawing (the All
// arrangement in a frame with a one-line boxed key at its foot, or, when it doesn't fit, pieces in
// rows) and the material schedule; the side column on the right starts, on every sheet, with the
// same bold totals block (area, per material with its swatch, edge metres), then on the first sheet
// the cut-outs by piece and the notes. Pieces are lettered A, B, C... and filled with a pale tint
// per material (light grey for one material). Every sheet ends "Check all sizes on site before
// cutting" and "Page X of Y". Blocks are measured off-screen and packed whole. Text goes in by
// textContent.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const D = window.BtDraw;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const PX_PER_MM = 96 / 25.4;
  // A4 landscape: 297 x 210 mm, 12 mm margins.
  const CONTENT_W = 273;
  const CONTENT_H = 210 - 24 - 12; // less room for the footer
  const SIDE_W = 74; // the side column
  const MAIN_W = CONTENT_W - SIDE_W - 6;
  const KEY_H = 26; // the frame around the drawing: its scale line, padding and key
  const SCALES = [10, 20, 25, 40, 50, 75, 100, 150, 200];
  const PAD = 15; // paper mm around the shapes for labels

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
    return node;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  const text = (v) => (v == null ? "" : String(v).trim());

  function refuse(msg) {
    $("bpStatus").textContent = msg;
    $("bpPrint").disabled = true;
  }

  function letterhead(biz) {
    const b = biz || {};
    const address = text(b.address).split(/\s*\n\s*/).filter(Boolean).join(", ");
    const line = [address, text(b.phone), text(b.email)].filter(Boolean).join("  ·  ");
    return [
      el("img", { class: "bp-banner", src: "/assets/invoice-letterhead.png", alt: text(b.tradingName) || text(b.legalName) || "Letterhead" }),
      line ? el("p", { class: "bp-bizline", text: line }) : null,
    ].filter(Boolean);
  }

  const swatch = (cls) => el("span", { class: "bp-sw " + cls, "aria-hidden": "true" });

  function material(snap, p) {
    const m = p.materialId != null ? snap.materials[p.materialId] : null;
    return m ? `${m.colour} ${m.thickness} mm` : "No material";
  }

  // ---- the drawing -----------------------------------------------------------------------------

  function svgFor(pieces, S, snap, fill) {
    const u = (2.5 * S) / 11; // 11 base px of text = 2.5 mm on paper
    return D.renderSet(pieces, { finishes: snap.finishes, u, print: true, pad: PAD * S, fill });
  }

  // The one-line key, boxed, at the foot of the drawing frame: only what the plan uses.
  function keyBox(snap) {
    const ps = snap.design.pieces;
    const used = new Set();
    const codes = new Map();
    const thick = new Set();
    let joins = false;
    let cuts = false;
    let ref = false;
    for (const p of ps) {
      for (const fid of Object.values(p.edges || {})) {
        const f = snap.finishes[fid];
        if (!f) continue;
        used.add(f.mark || "//");
        codes.set(f.code, f.name + (f.waterfall ? " (drop mm)" : ""));
      }
      for (const v of Object.values(p.thick || {})) thick.add(v);
      if ((p.joins || []).length) joins = true;
      if ((p.cutouts || []).length) cuts = true;
      if ((p.cutouts || []).some((c) => c.located)) ref = true;
    }
    const sample = (k) => { const s = D.sample(k); s.classList.add("bt-print"); return s; };
    const items = [];
    const words = { X: "unfinished", "//": "finished", "[]": "square" };
    for (const m of ["X", "//", "[]"]) if (used.has(m)) items.push(el("span", { class: "bp-ki" }, sample(m), words[m]));
    if (thick.size) items.push(el("span", { class: "bp-ki" }, sample("bold"), [...thick].sort((a, b) => a - b).join(" / ") + " mm edge"));
    if (joins || cuts) items.push(el("span", { class: "bp-ki" }, sample("join"), joins && cuts ? "join / cut-out" : joins ? "join" : "cut-out"));
    if (ref) items.push(el("span", { class: "bp-ki" }, "REF = cut-out datum"));
    const codeLine = [...codes.entries()].map(([c, n]) => c + " " + n).join(" · ");
    return el("div", { class: "bp-key" }, el("div", { class: "bp-keyrow" }, ...items), codeLine ? el("div", { class: "bp-keycodes", text: codeLine }) : null);
  }

  // The All arrangement in one frame at the largest standard scale (to 1:100) that fits; null if not.
  function arrangement(snap, room, fill) {
    const ps = snap.design.pieces;
    const b = D.bounds(ps);
    for (const S of SCALES) {
      if (S > 100) break;
      const w = b.w / S + 2 * PAD;
      const h = b.h / S + 2 * PAD;
      if (w <= MAIN_W && h <= room - KEY_H) {
        const r = svgFor(ps, S, snap, fill);
        r.svg.setAttribute("width", w + "mm");
        r.svg.setAttribute("height", h + "mm");
        return el("div", { class: "bp-frame" },
          el("p", { class: "bp-scale", text: `Plan as arranged · 1:${S} · mm` }), r.svg, keyBox(snap));
      }
    }
    return null;
  }

  // Fallback: each piece on its own, in rows, at one scale; the key after the last row.
  function rows(snap, fill) {
    const ps = snap.design.pieces;
    const size = (p, S) => { const o = D.outline(p); return { w: o.w / S + 2 * PAD, h: o.h / S + 2 * PAD }; };
    let S = SCALES[SCALES.length - 1];
    for (const s of SCALES) if (ps.every((p) => { const z = size(p, s); return z.w <= MAIN_W && z.h <= 110; })) { S = s; break; }
    const out = [];
    let row = [];
    let used = 0;
    const flush = () => { if (row.length) out.push(el("div", { class: "bp-row" }, ...row)); row = []; used = 0; };
    ps.forEach((p, i) => {
      const z = size(p, S);
      if (row.length && used + 4 + z.w > MAIN_W) flush();
      const one = Object.assign({}, p, { x: 0, y: 0 });
      const r = D.renderSet([one], { finishes: snap.finishes, u: (2.5 * S) / 11, print: true, pad: PAD * S, fill });
      // renderSet letters from A; put this piece's own letter back
      const num = r.svg.querySelector(".bt-num");
      if (num) num.textContent = D.letter(i);
      r.svg.setAttribute("width", z.w + "mm");
      r.svg.setAttribute("height", z.h + "mm");
      row.push(el("div", { class: "bp-piece" }, r.svg));
      used += (row.length > 1 ? 4 : 0) + z.w;
    });
    flush();
    out[0].prepend(el("p", { class: "bp-scale", text: `Pieces · 1:${S} · mm` }));
    out.push(keyBox(snap));
    return out;
  }

  // ---- the side column -------------------------------------------------------------------------

  // The same bold totals block at the top of every sheet's side column.
  function totalsBlock(snap, F) {
    const t = D.totals(snap.design.pieces, snap.finishes, snap.materials);
    const kids = [el("p", { class: "bp-total", text: "Total " + t.m2 + " m²" })];
    for (const m of t.mats) kids.push(el("p", { class: "bp-mat" }, swatch(F.byMaterial(m.key === "none" ? null : m.key)), m.name + "  " + m.m2 + " m²"));
    const edges = t.fins.map((f) => (f.mark ? f.mark + " " : "") + f.name + " " + f.m + " m").concat(t.thick.map((x) => x.name + " " + x.m + " m"));
    kids.push(el("p", { class: "bp-sh", text: "Edges" }), ...edges.map((e) => el("p", { class: "bp-edge", text: e })));
    return el("div", { class: "bp-tots" }, ...kids);
  }

  function firstSide(snap) {
    const ps = snap.design.pieces;
    const cuts = [];
    ps.forEach((p, i) => {
      const list = (p.cutouts || []).map((c) => (c.kind === "tap" ? "Tap" : D.KIND_NAMES[c.kind]) + (c.label ? " (" + c.label + ")" : ""));
      if (list.length) cuts.push(el("p", { class: "bp-line" }, el("b", { text: D.letter(i) + "  " }), list.join(", ")));
    });
    return [
      el("p", { class: "bp-sh", text: "Cut-outs" }), ...(cuts.length ? cuts : [el("p", { class: "bp-line", text: "None" })]),
      el("p", { class: "bp-sh", text: "Notes" }), el("p", { class: "bp-line bp-pre", text: snap.notes || "None" }),
      el("p", { class: "bp-check", text: "Check all sizes on site before cutting" }),
    ];
  }

  // ---- the schedule ----------------------------------------------------------------------------

  function schedule(snap, F) {
    const rowsEl = snap.design.pieces.map((p, i) => {
      const m = p.materialId != null ? snap.materials[p.materialId] : null;
      const jn = (p.joins || []).map((j, k) => `J${k + 1} ${j.at}`).join(", ");
      return el("tr", {},
        el("td", {}, el("b", { text: D.letter(i) }), p.name ? " " + p.name : ""),
        el("td", { text: D.describe(p) }),
        el("td", {}, swatch(F.of(p)), material(snap, p)),
        el("td", { text: m ? [m.supplier, m.range].filter(Boolean).join(" · ") : "" }),
        el("td", { text: jn || "–" }));
    });
    return el("div", {}, el("p", { class: "bp-sh", text: "Schedule" }),
      el("table", { class: "bp-t" }, el("thead", {}, el("tr", {}, ...["Piece", "Shape · size", "Material", "Supplier", "Joins"].map((h) => el("th", { text: h })))), el("tbody", {}, ...rowsEl)));
  }

  // ---- the sheets ------------------------------------------------------------------------------

  function header(snap) {
    const j = snap.job || {};
    return el("div", { class: "bp-head" },
      el("div", { class: "bp-headl" }, ...letterhead(snap.business)),
      el("div", { class: "bp-headr" },
        el("h1", { class: "bp-h1", text: "Benchtop plan" }),
        el("div", { class: "bp-meta" },
          el("div", {}, el("span", { class: "bp-lab", text: "Job" }), text(j.name)),
          el("div", {}, el("span", { class: "bp-lab", text: "Client" }), text(j.clientName)),
          el("div", {}, el("span", { class: "bp-lab", text: "Site" }), text(j.siteAddress)),
          el("div", {}, el("span", { class: "bp-lab", text: "Revision · date" }), `${snap.letter} · ${fmtDate(snap.date)}`))));
  }

  function runningHead(snap) {
    return el("p", { class: "bp-runhead", text: `Benchtop plan · ${text(snap.job && snap.job.name)} · rev ${snap.letter}` });
  }

  function heightMm(node, width) {
    const m = $("bpMeasure");
    m.style.width = (width || CONTENT_W) + "mm";
    m.replaceChildren(node);
    const h = node.getBoundingClientRect().height / PX_PER_MM;
    m.replaceChildren();
    return h;
  }

  function waitImages(node) {
    const imgs = [...node.querySelectorAll("img")];
    return Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
  }

  async function build(snap) {
    const F = D.fills(snap.design.pieces);
    const fill = (p) => F.of(p);
    const head = header(snap);
    $("bpMeasure").replaceChildren(head);
    await waitImages(head);
    const headH = heightMm(head);
    const runH = heightMm(runningHead(snap));
    const room = CONTENT_H - headH - 4;
    // Keep the schedule on the first sheet when a smaller scale allows it.
    const sched = schedule(snap, F);
    const schedH = heightMm(sched, MAIN_W);
    const arranged = arrangement(snap, room - schedH - 3, fill) || arrangement(snap, room, fill);
    const mainBlocks = (arranged ? [arranged] : rows(snap, fill)).concat([sched]);
    const parts = mainBlocks.map((b) => ({ node: b, h: heightMm(b, MAIN_W) }));
    const pages = [{ head, main: [] }];
    let left = room;
    for (const b of parts) {
      const pg = pages[pages.length - 1];
      if (b.h > left && pg.main.length) {
        pages.push({ head: runningHead(snap), main: [] });
        left = CONTENT_H - runH - 4;
      }
      pages[pages.length - 1].main.push(b.node);
      left -= b.h + 3;
    }
    const total = pages.length;
    const ref = `Job ${text(snap.job && snap.job.name)} · Benchtop plan rev ${snap.letter}`;
    $("bpSheets").replaceChildren(...pages.map((pg, i) => el("section", { class: "bp-sheet", "aria-label": `Page ${i + 1} of ${total}` },
      pg.head,
      el("div", { class: "bp-grid" },
        el("div", { class: "bp-main" }, ...pg.main),
        el("div", { class: "bp-side" }, totalsBlock(snap, F), ...(i === 0 ? firstSide(snap) : []))),
      el("div", { class: "bp-foot" }, el("span", { text: ref }), el("span", { text: "Check all sizes on site before cutting" }), el("span", { text: `Page ${i + 1} of ${total}` })))));
  }

  async function start() {
    await (window.cc && window.cc.ready);
    const q = new URLSearchParams(location.search);
    const plan = q.get("plan");
    const rev = q.get("rev");
    if (!/^[1-9]\d*$/.test(plan || "") || !/^[A-Z]{1,3}$/.test(rev || "")) {
      refuse("Nothing to print. Print the plan set from its benchtop plan.");
      return;
    }
    $("bpBack").href = "/benchtop.html?plan=" + plan;
    $("bpBack").textContent = "Back to the plan";
    let snap;
    try {
      snap = await api("/api/benchtop-plans/" + plan + "/revisions/" + rev);
    } catch (e) {
      refuse(e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : /not found/i.test(e.message) ? "There is no revision " + rev + " of that plan." : e.message);
      return;
    }
    snap.design = { pieces: (snap.design.pieces || []).filter((p) => p.shape !== "leg") };
    await build(snap);
    document.title = `Benchtop plan ${text(snap.job && snap.job.name)} rev ${snap.letter}`;
    $("bpStatus").textContent = `Revision ${snap.letter}, printed ${fmtDate(snap.date)}${snap.printedBy ? " by " + snap.printedBy : ""}.` +
      (snap.latest ? "" : " A later revision exists.");
    $("bpPrint").disabled = false;
  }

  $("bpPrint").addEventListener("click", () => window.print());
  start();
})();
