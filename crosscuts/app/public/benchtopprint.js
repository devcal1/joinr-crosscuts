// The benchtop plan set (/benchtopprint.html?plan=N&rev=B; docs/plans/m21-benchtop-designer.md).
// Prints one frozen revision from GET /api/benchtop-plans/:id/revisions/:letter: A4 landscape
// sheets, black on white, the stone-order letterhead on the first, several pieces per sheet at one
// common scale, then the edge legend (line style and short code), the cut-out table, the material
// schedule and the notes. Every sheet ends "Check all sizes on site before cutting" and "Page X of
// Y". Blocks are measured off-screen and packed onto sheets whole. Text goes in by textContent.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const D = window.BtDraw;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const NS = "http://www.w3.org/2000/svg";
  const PX_PER_MM = 96 / 25.4;
  // A4 landscape (Todd, 2026-10-25): 297 x 210 mm, 12 mm margins.
  const CONTENT_W = 273; // mm inside the margins
  const CONTENT_H = 210 - 24 - 12; // mm, less room for the footer
  const SIDE_W = 82; // the right column beside the arrangement: legend, totals, cut-outs
  const DRAW_W = CONTENT_W - SIDE_W - 6; // the arrangement's width when the column sits beside it
  const SCALES = [10, 20, 25, 40, 50, 75, 100, 150, 200];

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

  function text(v) {
    return v == null ? "" : String(v).trim();
  }

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

  function pieceTitle(p, i) {
    return `${i + 1}${p.name ? " " + p.name : ""}`;
  }

  // Paper size of a piece's drawing at 1:S, in mm.
  function paperSize(p, S) {
    const o = D.outline(p);
    const pad = 15; // paper mm around the shape for the labels
    return { w: o.w / S + 2 * pad, h: o.h / S + 2 * pad, pad };
  }

  function pickScale(pieces) {
    for (const S of SCALES) {
      if (pieces.every((p) => { const z = paperSize(p, S); return z.w <= CONTENT_W && z.h <= 120; })) return S;
    }
    return SCALES[SCALES.length - 1];
  }

  function drawing(p, i, S, snap) {
    const z = paperSize(p, S);
    const u = (2.5 * S) / 11; // 11 base px of text = 2.5 mm on paper
    const r = D.render(p, { finishes: snap.finishes, u, print: true, pad: z.pad * S, number: i + 1 });
    r.svg.setAttribute("width", z.w + "mm");
    r.svg.setAttribute("height", z.h + "mm");
    const sub = D.describe(p);
    return el("div", { class: "bp-piece", style: `width:${z.w}mm` },
      el("p", { class: "bp-cap" }, pieceTitle(p, i) + " ", el("span", { text: sub })), r.svg);
  }

  function legendLine(kind) {
    const s = D.sample(kind);
    s.classList.add("bt-print");
    return s;
  }

  // The All arrangement on one sheet, at the largest standard scale that fits the room left on
  // the first page (1:100 at the most); null when it doesn't fit, so the pieces go in rows.
  function arrangement(snap, room) {
    const ps = snap.design.pieces;
    const b = D.bounds(ps);
    const pad = 15;
    for (const S of SCALES) {
      if (S > 100) break;
      const w = b.w / S + 2 * pad;
      const h = b.h / S + 2 * pad;
      if (w <= DRAW_W && h <= room) {
        const u = (2.5 * S) / 11;
        const r = D.renderSet(ps, { finishes: snap.finishes, u, print: true, pad: pad * S });
        r.svg.setAttribute("width", w + "mm");
        r.svg.setAttribute("height", h + "mm");
        return el("div", {}, el("h2", { class: "bp-h2" }, "Plan view ", el("span", { text: `(as arranged, to scale, 1:${S}, all sizes in mm)` })),
          el("div", { class: "bp-piece" }, r.svg));
      }
    }
    return null;
  }

  function blocks(snap, S, room) {
    const ps = snap.design.pieces;
    const out = [];
    const arranged = arrangement(snap, room);

    // plan views, packed into rows across the page
    const rows = [];
    let row = [];
    let used = 0;
    ps.forEach((p, i) => {
      const w = paperSize(p, S).w;
      if (row.length && used + 4 + w > CONTENT_W) {
        rows.push(row);
        row = [];
        used = 0;
      }
      row.push([p, i]);
      used += (row.length > 1 ? 4 : 0) + w;
    });
    if (row.length) rows.push(row);
    if (!arranged) rows.forEach((r, k) => {
      const kids = [];
      if (k === 0) kids.push(el("h2", { class: "bp-h2" }, "Plan view ", el("span", { text: `(to scale, 1:${S}, all sizes in mm)` })));
      kids.push(el("div", { class: "bp-row" }, ...r.map(([p, i]) => drawing(p, i, S, snap))));
      out.push(el("div", {}, ...kids));
    });

    // legend, cut-outs (what they are, never their sizes) and totals
    const usedFin = new Set();
    const thick = new Set();
    let unset = false;
    let joins = false;
    let located = false;
    for (const p of ps) {
      const n = D.outline(p).edges.length;
      for (let k = 0; k < n; k++) {
        const f = p.edges["e" + k];
        if (f != null && snap.finishes[f]) usedFin.add(String(f));
        else unset = true;
      }
      for (const v of Object.values(p.thick || {})) thick.add(v);
      if (p.joins && p.joins.length) joins = true;
      if ((p.cutouts || []).some((c) => c.located)) located = true;
    }
    const leg = [];
    for (const m of ["X", "//", "[]"]) {
      const fs2 = [...usedFin].map((id) => snap.finishes[id]).filter((f) => (f.mark || "//") === m);
      if (!fs2.length) continue;
      const words = { X: "unfinished (to a wall or panel)", "//": "finished, seen", "[]": "seen, finished square" }[m];
      leg.push(legendLine(m), el("span", {}, el("b", { text: m }), " " + words + ": " + fs2.map((f) => f.code + " " + f.name + (f.waterfall ? " (drop in mm)" : "")).join(", ")));
    }
    if (thick.size) leg.push(legendLine("bold"), el("span", {}, el("b", { text: "Bold" }), " " + [...thick].sort((a, b) => a - b).map((t) => t + " mm").join(", ") + " edge"));
    if (unset) leg.push(legendLine("plain"), el("span", { text: "No mark: finish not set" }));
    if (joins) leg.push(legendLine("join"), el("span", {}, el("b", { text: "J" }), " Join (dashed), at mm from the run's start"));
    leg.push(legendLine("cut"), el("span", { text: "Cut-out (dashed)" + (located ? "; located ones dimensioned from the piece's REF edge" : "") }));
    const cuts = [];
    ps.forEach((p, i) => {
      const list = (p.cutouts || []).map((c) => (D.KIND_NAMES[c.kind] || "Cut-out") + (c.label ? " (" + c.label + ")" : ""));
      if (list.length) cuts.push(el("li", {}, el("b", { text: pieceTitle(p, i) + ": " }), list.join(", ")));
    });
    const t = D.totals(ps, snap.finishes, snap.materials);
    const tot = [el("div", {}, el("b", { text: "Area " + t.m2 + " m²" }))];
    if (t.mats.length > 1) tot.push(el("div", { text: t.mats.map((m) => m.name + " " + m.m2 + " m²").join(" · ") }));
    tot.push(el("div", { text: t.fins.map((f) => f.name + (f.mark ? " " + f.mark : "") + " " + f.m + " m").join(" · ") }));
    if (t.thick.length) tot.push(el("div", { text: t.thick.map((x) => x.name + " " + x.m + " m").join(" · ") }));
    const legend = el("div", {}, el("h2", { class: "bp-h2", text: "Edge legend" }), el("div", { class: "bp-leg" }, ...leg));
    const side = el("div", {},
      el("h2", { class: "bp-h2", text: "Totals" }), el("div", { class: "bp-tot" }, ...tot),
      el("h2", { class: "bp-h2", text: "Cut-outs" }), cuts.length ? el("ul", { class: "bp-cuts" }, ...cuts) : el("p", { text: "None." }));
    // Landscape: the arrangement on the left, legend, totals and cut-outs in a column on the right;
    // without an arrangement (pieces in rows) they sit side by side under the drawings.
    if (arranged) out.unshift(el("div", { class: "bp-split" }, arranged, el("div", { class: "bp-side" }, legend, side)));
    else out.push(el("div", { class: "bp-two" }, legend, side));

    // material schedule
    const mrows = ps.map((p, i) => {
      const m = p.materialId != null ? snap.materials[p.materialId] : null;
      const jn = (p.joins || []).map((j, k) => `J${k + 1} at ${j.at} (${(D.RUN_NAMES[p.shape][j.run] || "run").toLowerCase()})`).join(", ");
      return el("tr", {},
        el("td", { text: pieceTitle(p, i) }),
        el("td", { text: D.describe(p) }),
        el("td", { text: m ? [m.supplier, m.range].filter(Boolean).join(" · ") : "Not chosen" }),
        el("td", { text: m ? m.colour : "" }),
        el("td", { text: m ? String(m.thickness) : "" }),
        el("td", { text: jn || "None" }));
    });
    const sched = (el("div", {}, el("h2", { class: "bp-h2", text: "Material schedule" }),
      el("table", { class: "bp-t" }, el("thead", {}, el("tr", {}, ...["Piece", "Shape · size", "Supplier · range", "Colour", "Thick", "Joins"].map((h) => el("th", { text: h })))), el("tbody", {}, ...mrows))));

    const notes = el("div", { class: "bp-side" }, el("h2", { class: "bp-h2", text: "Notes for supplier" }), el("p", { class: "bp-pre", text: snap.notes || "None." }),
      el("p", { class: "bp-check", text: "Check all sizes on site before cutting" }));
    // the schedule on the left, the notes in the right column
    out.push(el("div", { class: "bp-split" }, sched, notes));
    return out;
  }

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
    const S = pickScale(snap.design.pieces);
    const head = header(snap);
    $("bpMeasure").replaceChildren(head);
    await waitImages(head);
    const headH = heightMm(head);
    const runH = heightMm(runningHead(snap));
    const parts = blocks(snap, S, CONTENT_H - headH - 10).map((b) => ({ node: b, h: heightMm(b) }));
    const pages = [[head]];
    let left = CONTENT_H - headH;
    for (const b of parts) {
      if (b.h > left && pages[pages.length - 1].length > 1) {
        pages.push([runningHead(snap)]);
        left = CONTENT_H - runH;
      }
      pages[pages.length - 1].push(b.node);
      left -= b.h;
    }
    const total = pages.length;
    const ref = `Job ${text(snap.job && snap.job.name)} · Benchtop plan rev ${snap.letter}`;
    $("bpSheets").replaceChildren(...pages.map((kids, i) => el("section", { class: "bp-sheet", "aria-label": `Page ${i + 1} of ${total}` },
      ...kids,
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
