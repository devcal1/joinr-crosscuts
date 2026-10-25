// The benchtop plan set (/benchtopprint.html?plan=N&rev=B; docs/plans/m21-benchtop-designer.md).
// Prints one frozen revision from GET /api/benchtop-plans/:id/revisions/:letter on A4 landscape
// sheets, black on white: layout D, approved by Todd 2026-10-25.
//
// Every sheet: a 14 mm header (small letterhead, job and revision on the left; the bold totals,
// material swatches and edge metres on the right, in the same spot on every sheet), then the
// drawing full width (the All arrangement at the largest standard scale that fits, or pieces in
// rows), then a short footer band (one-line key, pieces, cut-outs, notes and the check-on-site
// line), and the page line (Page X of Y). Long notes or many pieces wrap; what doesn't fit goes on
// to the next sheet under the same header. Pieces are lettered A, B, C... and filled with a pale
// tint per material. Blocks are measured off-screen and packed whole. Text goes in by textContent.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const D = window.BtDraw;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const PX_PER_MM = 96 / 25.4;
  // A4 landscape: 297 x 210 mm, 10 mm margins, 6 mm kept for the page line.
  const CONTENT_W = 277;
  const CONTENT_H = 210 - 20 - 6;
  const SCALES = [10, 20, 25, 30, 40, 50, 75, 100, 150, 200];
  const PAD = 12; // paper mm around the shapes for labels
  const GAP = 2;

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
  const swatch = (cls) => el("span", { class: "bp-sw " + cls, "aria-hidden": "true" });

  function refuse(msg) {
    $("bpStatus").textContent = msg;
    $("bpPrint").disabled = true;
  }

  // ---- the header (the same on every sheet) ----------------------------------------------------

  function header(snap, F) {
    const b = snap.business || {};
    const j = snap.job || {};
    const address = text(b.address).split(/\s*\n\s*/).filter(Boolean).join(", ");
    const biz = [address, text(b.phone), text(b.email)].filter(Boolean).join(" · ");
    const t = D.totals(snap.design.pieces, snap.finishes, snap.materials);
    const mats = t.mats.map((m) => el("span", { class: "bp-mat" }, swatch(F.byMaterial(m.key === "none" ? null : m.key)), m.name + " " + m.m2 + " m²"));
    const edges = t.fins.map((f) => (f.mark ? f.mark + " " : "") + f.name.replace(/, against wall$/, "") + " " + f.m)
      .concat(t.thick.map((x) => x.name.replace(/ edge$/, "") + " " + x.m)).join(" · ") + " m";
    return el("div", { class: "bp-top" },
      el("div", { class: "bp-brand" },
        el("img", { class: "bp-banner", src: "/assets/invoice-letterhead.png", alt: text(b.tradingName) || text(b.legalName) || "Letterhead" }),
        biz ? el("p", { class: "bp-bizline", text: biz }) : null),
      el("div", { class: "bp-title" },
        el("h1", { class: "bp-h1" }, "Benchtop plan ", el("span", { class: "bp-rev", text: `Rev ${snap.letter} · ${fmtDate(snap.date)}` })),
        el("p", { class: "bp-job", text: ["Job " + text(j.name), text(j.clientName), text(j.siteAddress)].filter(Boolean).join(" · ") })),
      el("div", { class: "bp-tots" },
        el("p", { class: "bp-totline" }, el("span", { class: "bp-total", text: "Total " + t.m2 + " m²" }), ...mats),
        el("p", { class: "bp-edges", text: edges })));
  }

  // ---- the drawing -----------------------------------------------------------------------------

  function setSize(svg, w, h) {
    svg.setAttribute("width", w + "mm");
    svg.setAttribute("height", h + "mm");
  }

  // The All arrangement at the largest standard scale (to 1:100) that fits w x h; null if none.
  function arrangement(snap, w, h, fill) {
    const ps = snap.design.pieces;
    const b = D.bounds(ps);
    for (const S of SCALES) {
      if (S > 100) break;
      const dw = b.w / S + 2 * PAD;
      const dh = b.h / S + 2 * PAD;
      if (dw <= w && dh <= h - 5) {
        const r = D.renderSet(ps, { finishes: snap.finishes, u: (2.4 * S) / 11, print: true, pad: PAD * S, fill });
        setSize(r.svg, dw, dh);
        return el("div", { class: "bp-draw" }, el("p", { class: "bp-scale", text: `Plan · 1:${S} · mm` }), r.svg);
      }
    }
    return null;
  }

  // Fallback: each piece on its own, in rows across the page, at one scale.
  function rows(snap, fill) {
    const ps = snap.design.pieces;
    const size = (p, S) => { const o = D.outline(p); return { w: o.w / S + 2 * PAD, h: o.h / S + 2 * PAD }; };
    let S = SCALES[SCALES.length - 1];
    for (const s of SCALES) if (ps.every((p) => { const z = size(p, s); return z.w <= CONTENT_W && z.h <= 110; })) { S = s; break; }
    const out = [];
    let row = [];
    let used = 0;
    const flush = () => { if (row.length) out.push(el("div", { class: "bp-row" }, ...row)); row = []; used = 0; };
    ps.forEach((p, i) => {
      const z = size(p, S);
      if (row.length && used + 4 + z.w > CONTENT_W) flush();
      const r = D.renderSet([Object.assign({}, p, { x: 0, y: 0 })], { finishes: snap.finishes, u: (2.4 * S) / 11, print: true, pad: PAD * S, fill });
      const num = r.svg.querySelector(".bt-num");
      if (num) num.textContent = D.letter(i); // renderSet letters from A
      setSize(r.svg, z.w, z.h);
      row.push(el("div", { class: "bp-piece" }, r.svg));
      used += (row.length > 1 ? 4 : 0) + z.w;
    });
    flush();
    out[0].prepend(el("p", { class: "bp-scale", text: `Pieces · 1:${S} · mm` }));
    return out;
  }

  // ---- the footer band: key, pieces, cut-outs, notes --------------------------------------------

  function keyLine(snap) {
    const used = new Set();
    const codes = new Map();
    const thick = new Set();
    let joins = false;
    let cuts = false;
    let ref = false;
    for (const p of snap.design.pieces) {
      for (const fid of Object.values(p.edges || {})) {
        const f = snap.finishes[fid];
        if (!f) continue;
        used.add(f.mark || "//");
        codes.set(f.code, f.name.replace(/, against wall$/, "") + (f.waterfall ? " (drop mm)" : ""));
      }
      for (const v of Object.values(p.thick || {})) thick.add(v);
      if ((p.joins || []).length) joins = true;
      if ((p.cutouts || []).length) cuts = true;
      if ((p.cutouts || []).some((c) => c.located)) ref = true;
    }
    const sample = (k) => { const s = D.sample(k); s.classList.add("bt-print"); return s; };
    const words = { X: "unfinished", "//": "finished", "[]": "square" };
    const items = [];
    for (const m of ["X", "//", "[]"]) if (used.has(m)) items.push(el("span", { class: "bp-ki" }, sample(m), words[m]));
    if (thick.size) items.push(el("span", { class: "bp-ki" }, sample("bold"), [...thick].sort((a, b) => a - b).join(" / ") + " mm"));
    if (joins || cuts) items.push(el("span", { class: "bp-ki" }, sample("join"), joins && cuts ? "join / cut-out" : joins ? "join" : "cut-out"));
    if (ref) items.push(el("span", { class: "bp-ki", text: "REF datum" }));
    const codeText = [...codes.entries()].map(([c, n]) => c + " " + n).join(" · ");
    if (codeText) items.push(el("span", { class: "bp-ki bp-codes", text: codeText }));
    return el("div", { class: "bp-key" }, ...items);
  }

  function piecesLine(snap, F) {
    return el("div", { class: "bp-pieces" }, ...snap.design.pieces.map((p, i) => {
      const m = p.materialId != null ? snap.materials[p.materialId] : null;
      const jn = (p.joins || []).map((j, k) => `J${k + 1} ${j.at}`).join(", ");
      const rc = {};
      for (const r of Object.values(p.radii || {})) rc[r] = (rc[r] || 0) + 1;
      const rad = Object.keys(rc).sort((x, y) => x - y).map((r) => rc[r] + " × R" + r).join(", ");
      const bits = [p.name, D.describe(p).replace(/, depths .*$/, ""), m ? `${m.colour} ${m.thickness}` + (m.supplier ? ` (${[m.supplier, m.range].filter(Boolean).join(" ")})` : "") : "No material", rad, jn].filter(Boolean);
      return el("span", { class: "bp-pc" }, el("b", { text: D.letter(i) }), swatch(F.of(p)), bits.join(" · "));
    }));
  }

  function cutsNotes(snap) {
    const cuts = snap.design.pieces.map((p, i) => (p.cutouts || []).length
      ? D.letter(i) + ": " + p.cutouts.map((c) => (c.kind === "tap" ? "Tap" : D.KIND_NAMES[c.kind]) + (c.label ? " (" + c.label + ")" : "")).join(", ")
      : "").filter(Boolean).join(" · ");
    return [
      el("p", { class: "bp-fl" }, el("span", { class: "bp-lab", text: "Cut-outs " }), cuts || "None"),
      el("p", { class: "bp-fl bp-pre" }, el("span", { class: "bp-lab", text: "Notes " }), snap.notes || "None"),
    ];
  }

  // ---- the sheets ------------------------------------------------------------------------------

  function heightMm(node) {
    const m = $("bpMeasure");
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
    const head0 = header(snap, F);
    $("bpMeasure").replaceChildren(head0);
    await waitImages(head0);
    const headH = heightMm(head0);
    const avail = CONTENT_H - headH - GAP;

    // the footer band, as separate blocks so a long one can go on to the next sheet
    const band = [keyLine(snap), piecesLine(snap, F), ...cutsNotes(snap)];
    band[0].classList.add("bp-bandtop");
    const bandH = band.reduce((a, n) => a + heightMm(n) + 0.8, 0);

    // the drawing: full width, keeping the band on the first sheet when a standard scale allows
    const drawn = arrangement(snap, CONTENT_W, avail - bandH - GAP, fill) || arrangement(snap, CONTENT_W, avail, fill);
    const blocks = (drawn ? [drawn] : rows(snap, fill)).concat(band).map((n) => ({ node: n, h: heightMm(n) + (n.classList.contains("bp-fl") || n.classList.contains("bp-pieces") || n.classList.contains("bp-key") ? 0.8 : GAP) }));

    const pages = [[]];
    let left = avail;
    for (const b of blocks) {
      if (b.h > left && pages[pages.length - 1].length) {
        pages.push([]);
        left = avail;
      }
      pages[pages.length - 1].push(b.node);
      left -= b.h;
    }
    const total = pages.length;
    const ref = `Job ${text(snap.job && snap.job.name)} · Benchtop plan rev ${snap.letter}`;
    $("bpSheets").replaceChildren(...pages.map((kids, i) => el("section", { class: "bp-sheet", "aria-label": `Page ${i + 1} of ${total}` },
      i === 0 ? head0 : header(snap, F),
      el("div", { class: "bp-main" }, ...kids),
      el("div", { class: "bp-foot" }, el("span", { text: ref }), el("span", { class: "bp-checkline", text: "Check all sizes on site before cutting" }), el("span", { text: `Page ${i + 1} of ${total}` })))));
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
