// Benchtop designer drawing (0.2.0, docs/plans/m21-benchtop-designer.md): the shape of each piece
// in mm and its SVG, shared by the designer (benchtop.js) and the plan-set print
// (benchtopprint.js). Drawn to scale: the SVG's user units are millimetres. Colours and line
// weights come from classes (benchtop.css on screen, benchtopprint.css on paper); edge finishes
// differ by line style, never by colour. All text goes in through textContent. Classes are bt-.
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  const EDGE_NAMES = {
    straight: ["Back", "Right end", "Front", "Left end"],
    l: ["Back", "Right end", "Back run front", "Return front", "Return end", "Left side"],
    u: ["Back", "Right outer side", "Right end", "Right inner side", "Back run front", "Left inner side", "Left end", "Left outer side"],
    leg: ["Top (mitre)", "Right side", "Bottom", "Left side"],
  };
  const RUN_NAMES = { straight: ["Run"], l: ["Back run", "Return"], u: ["Back run", "Left return", "Right return"], leg: [] };
  const SHAPE_NAMES = { straight: "Straight", l: "L", u: "U", leg: "Waterfall leg" };
  const KIND_NAMES = { sink: "Sink", cooktop: "Cooktop", tap: "Tap hole", other: "Cut-out" };

  // The outline in mm, clockwise from the top-left corner (y down), its edges, and the run
  // rectangles joins are placed in.
  function outline(p) {
    let pts;
    let runs;
    if (p.shape === "leg") {
      const W = p.leg.width;
      const H = p.leg.height;
      pts = [[0, 0], [W, 0], [W, H], [0, H]];
      runs = [];
    } else if (p.shape === "straight") {
      const L = p.runs[0].len;
      const D = p.runs[0].depth;
      pts = [[0, 0], [L, 0], [L, D], [0, D]];
      runs = [{ rect: [0, 0, L, D], axis: "x" }];
    } else if (p.shape === "l") {
      const A = p.runs[0].len;
      const D1 = p.runs[0].depth;
      const B = p.runs[1].len;
      const D2 = p.runs[1].depth;
      pts = [[0, 0], [A, 0], [A, D1], [D2, D1], [D2, B], [0, B]];
      runs = [{ rect: [0, 0, A, D1], axis: "x" }, { rect: [0, 0, D2, B], axis: "y" }];
    } else {
      const A = p.runs[0].len;
      const D2 = p.runs[0].depth;
      const B1 = p.runs[1].len;
      const D1 = p.runs[1].depth;
      const B2 = p.runs[2].len;
      const D3 = p.runs[2].depth;
      pts = [[0, 0], [A, 0], [A, B2], [A - D3, B2], [A - D3, D2], [D1, D2], [D1, B1], [0, B1]];
      runs = [{ rect: [0, 0, A, D2], axis: "x" }, { rect: [0, 0, D1, B1], axis: "y" }, { rect: [A - D3, 0, A, B2], axis: "y" }];
    }
    const names = EDGE_NAMES[p.shape];
    const edges = pts.map((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.round(Math.hypot(dx, dy));
      const ux = dx / (len || 1);
      const uy = dy / (len || 1);
      let from = "";
      if (ux > 0.5) from = "from the left";
      else if (ux < -0.5) from = "from the right";
      else if (uy > 0.5) from = "from the top";
      else from = "from the bottom";
      return { key: "e" + i, a, b, len, u: [ux, uy], n: [-uy, ux], name: names[i], from };
    });
    let w = 0;
    let h = 0;
    for (const [x, y] of pts) {
      w = Math.max(w, x);
      h = Math.max(h, y);
    }
    runs.forEach((r, i) => { r.name = RUN_NAMES[p.shape][i]; });
    return { pts, edges, runs, w, h };
  }

  function cutGeom(o, c) {
    const e = o.edges.find((x) => x.key === c.edge) || o.edges[0];
    const [ux, uy] = e.u;
    const [nx, ny] = e.n;
    const x0 = e.a[0] + ux * c.along + nx * c.in;
    const y0 = e.a[1] + uy * c.along + ny * c.in;
    const x1 = x0 + ux * c.w + nx * c.h;
    const y1 = y0 + uy * c.w + ny * c.h;
    return {
      x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
      // the guide from the edge's start to the cut-out's near side, along the edge
      guide: [e.a[0] + nx * (c.in + c.h / 2), e.a[1] + ny * (c.in + c.h / 2), e.a[0] + ux * c.along + nx * (c.in + c.h / 2), e.a[1] + uy * c.along + ny * (c.in + c.h / 2)],
      edge: e,
    };
  }

  function joinLine(o, j) {
    const r = o.runs[j.run];
    if (!r) return null;
    const [x0, y0, x1, y1] = r.rect;
    return r.axis === "x" ? [x0 + j.at, y0, x0 + j.at, y1] : [x0, y0 + j.at, x1, y0 + j.at];
  }

  // Which run a point (mm) falls in, and where along it: for placing a join.
  function runAt(o, x, y) {
    for (let i = 0; i < o.runs.length; i++) {
      const [x0, y0, x1, y1] = o.runs[i].rect;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        const at = Math.round(o.runs[i].axis === "x" ? x - x0 : y - y0);
        return { run: i, at };
      }
    }
    return null;
  }

  function node(tag, attrs, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    return n;
  }

  function line(g, x1, y1, x2, y2, cls, extra) {
    const l = node("line", Object.assign({ x1, y1, x2, y2, class: cls, "vector-effect": "non-scaling-stroke" }, extra || {}));
    g.append(l);
    return l;
  }

  function label(g, x, y, text, cls, u, vertical, anchor) {
    const t = node("text", { x, y, class: cls, "font-size": 11 * u, "text-anchor": anchor || "middle", "dominant-baseline": "middle" }, text);
    if (vertical) t.setAttribute("transform", `rotate(-90 ${x} ${y})`);
    g.append(t);
    return t;
  }

  // Draws one piece into a new <svg>. opts: {finishes (id -> finish), u (mm per base px, for
  // text and offsets), print (bool), selEdge, selCut, number, pad (mm)}.
  function render(p, opts) {
    const o = outline(p);
    const u = opts.u || 1;
    const pad = opts.pad != null ? opts.pad : 60 * u;
    const svg = node("svg", {
      class: "bt-svg" + (opts.print ? " bt-print" : ""),
      viewBox: `${-pad} ${-pad} ${o.w + 2 * pad} ${o.h + 2 * pad}`,
      "font-family": "Arial, Helvetica, sans-serif",
    });
    const g = node("g");
    svg.append(g);
    g.append(node("polygon", { points: o.pts.map((q) => q.join(",")).join(" "), class: "bt-shape", "data-shape": "1" }));

    // cut-outs
    (p.cutouts || []).forEach((c, i) => {
      const cg = cutGeom(o, c);
      const sel = opts.selCut === i;
      const cls = "bt-cut" + (sel ? " bt-sel" : "");
      if (c.kind === "tap") {
        g.append(node("circle", { cx: cg.x + cg.w / 2, cy: cg.y + cg.h / 2, r: c.w / 2, class: cls, "data-cut": i, "vector-effect": "non-scaling-stroke" }));
        label(g, cg.x + cg.w / 2, cg.y - 9 * u, "TAP Ø" + c.w, "bt-cutlbl", u * 0.85);
      } else {
        g.append(node("rect", { x: cg.x, y: cg.y, width: cg.w, height: cg.h, rx: c.kind === "sink" ? Math.min(40, cg.w / 6) : 0, class: cls, "data-cut": i, "vector-effect": "non-scaling-stroke" }));
        const name = (KIND_NAMES[c.kind] + (c.label ? " · " + c.label : "")).toUpperCase();
        const vert = cg.h > cg.w * 1.4 && cg.w < 140 * u;
        label(g, cg.x + cg.w / 2, cg.y + cg.h / 2 - (vert ? 0 : 7 * u), name, "bt-cutlbl", u * 0.85, vert);
        if (!vert) label(g, cg.x + cg.w / 2, cg.y + cg.h / 2 + 7 * u, `${c.w} × ${c.h}`, "bt-cutsize", u * 0.85);
      }
      if (sel && !opts.print) line(g, ...cg.guide, "bt-guide");
    });

    // joins
    (p.joins || []).forEach((j, i) => {
      const L = joinLine(o, j);
      if (!L) return;
      const r = o.runs[j.run];
      const ext = 8 * u;
      if (r.axis === "x") line(g, L[0], L[1] - ext, L[2], L[3] + ext, "bt-join");
      else line(g, L[0] - ext, L[1], L[2] + ext, L[3], "bt-join");
      const tx = r.axis === "x" ? L[0] + 4 * u : L[2] + 4 * u;
      const ty = r.axis === "x" ? L[3] - 9 * u : L[3] - 7 * u;
      label(g, tx, ty, "J" + (i + 1) + " · " + j.at, "bt-joinlbl", u * 0.85, false, "start");
    });

    // edges: line style by finish, then the length and code outside the edge
    for (const e of o.edges) {
      const fid = p.edges ? p.edges[e.key] : null;
      const f = fid != null && opts.finishes ? opts.finishes[fid] : null;
      const style = f ? f.lineStyle : "none";
      const sel = opts.selEdge === e.key;
      const [ax, ay] = e.a;
      const [bx, by] = e.b;
      line(g, ax, ay, bx, by, "bt-edge bt-ls-" + style);
      if (style === "double") {
        const off = 5 * u;
        line(g, ax + e.n[0] * off, ay + e.n[1] * off, bx + e.n[0] * off, by + e.n[1] * off, "bt-edge bt-ls-double");
      }
      if (sel) line(g, ax, ay, bx, by, "bt-edge-sel");
      if (!opts.print) line(g, ax, ay, bx, by, "bt-hit", { "data-edge": e.key });
      const mx = (ax + bx) / 2 - e.n[0] * 16 * u;
      const my = (ay + by) / 2 - e.n[1] * 16 * u;
      const vertical = Math.abs(e.u[1]) > 0.5;
      const code = f ? f.code : "";
      if (opts.print) {
        label(g, mx, my, code ? `${e.len} · ${code}` : String(e.len), "bt-elbl", u, vertical);
      } else {
        const off2 = 13 * u;
        const lx = mx - e.n[0] * (code ? off2 / 2 : 0);
        const ly = my - e.n[1] * (code ? off2 / 2 : 0);
        label(g, lx, ly, String(e.len), "bt-elbl" + (sel ? " bt-sel-txt" : ""), u, vertical);
        if (code) label(g, lx + e.n[0] * off2, ly + e.n[1] * off2, f.name.toUpperCase(), "bt-ecode" + (sel ? " bt-sel-txt" : ""), u * 0.8, vertical);
      }
      if (sel && !opts.print) {
        g.append(node("circle", { cx: ax, cy: ay, r: 5 * u, class: "bt-node" }));
        g.append(node("circle", { cx: bx, cy: by, r: 5 * u, class: "bt-node" }));
      }
    }

    if (opts.number != null) {
      const r = o.runs[0] ? o.runs[0].rect : [0, 0, o.w, o.h];
      const big = node("text", { x: r[0] + 14 * u, y: r[1] + 30 * u, class: "bt-num", "font-size": 22 * u }, String(opts.number));
      g.append(big);
    }
    return { svg, outline: o, pad };
  }

  function describe(p) {
    if (p.shape === "leg") return `Waterfall leg · ${p.leg.width} × ${p.leg.height}`;
    if (p.shape === "straight") return `Straight · ${p.runs[0].len} × ${p.runs[0].depth}`;
    if (p.shape === "l") return `L · ${p.runs[0].len} × ${p.runs[1].len}, depths ${p.runs[0].depth} / ${p.runs[1].depth}`;
    return `U · ${p.runs[1].len} × ${p.runs[0].len} × ${p.runs[2].len}, depths ${p.runs[1].depth} / ${p.runs[0].depth} / ${p.runs[2].depth}`;
  }

  window.BtDraw = { outline, cutGeom, joinLine, runAt, render, describe, EDGE_NAMES, RUN_NAMES, SHAPE_NAMES, KIND_NAMES };
})();
