// Benchtop designer drawing (0.2.0, docs/plans/m21-benchtop-designer.md): the shape of each piece
// in mm and its SVG, shared by the designer (benchtop.js) and the plan-set print
// (benchtopprint.js). Drawn to scale: the SVG's user units are millimetres. The "All" view draws
// every piece at its saved position (x, y). Colours and line weights come from classes
// (benchtop.css on screen, benchtopprint.css on paper); edge finishes differ by line style and
// labels, never by colour. All text goes in through textContent. Classes are bt-.
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  const EDGE_NAMES = {
    straight: ["Back", "Right end", "Front", "Left end"],
    l: ["Back", "Right end", "Back run front", "Return front", "Return end", "Left side"],
    lr: ["Back", "Right side", "Return end", "Return front", "Back run front", "Left end"],
    u: ["Back", "Right outer side", "Right end", "Right inner side", "Back run front", "Left inner side", "Left end", "Left outer side"],
  };
  // The end edges: where a waterfall may go.
  const END_EDGES = { straight: ["e1", "e3"], l: ["e1", "e4"], lr: ["e2", "e5"], u: ["e2", "e6"] };
  const RUN_NAMES = { straight: ["Run"], l: ["Back run", "Return"], lr: ["Back run", "Return"], u: ["Back run", "Left return", "Right return"] };
  const SHAPE_NAMES = { straight: "Straight", l: "L shape (left)", lr: "L shape (right)", u: "U" };
  const KIND_NAMES = { sink: "Sink", cooktop: "Cooktop", tap: "Tap hole", other: "Cut-out" };

  // The outline in mm, clockwise from the top-left corner (y down), its edges, and the run
  // rectangles joins are placed in.
  function outline(p) {
    let pts;
    let runs;
    const R = p.runs;
    if (p.shape === "straight") {
      const L = R[0].len, D = R[0].depth;
      pts = [[0, 0], [L, 0], [L, D], [0, D]];
      runs = [{ rect: [0, 0, L, D], axis: "x" }];
    } else if (p.shape === "l") {
      const A = R[0].len, D1 = R[0].depth, B = R[1].len, D2 = R[1].depth;
      pts = [[0, 0], [A, 0], [A, D1], [D2, D1], [D2, B], [0, B]];
      runs = [{ rect: [0, 0, A, D1], axis: "x" }, { rect: [0, 0, D2, B], axis: "y" }];
    } else if (p.shape === "lr") {
      const A = R[0].len, D1 = R[0].depth, B = R[1].len, D2 = R[1].depth;
      pts = [[0, 0], [A, 0], [A, B], [A - D2, B], [A - D2, D1], [0, D1]];
      runs = [{ rect: [0, 0, A, D1], axis: "x" }, { rect: [A - D2, 0, A, B], axis: "y" }];
    } else {
      const A = R[0].len, D2 = R[0].depth, B1 = R[1].len, D1 = R[1].depth, B2 = R[2].len, D3 = R[2].depth;
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
      let from;
      if (ux > 0.5) from = "from the left";
      else if (ux < -0.5) from = "from the right";
      else if (uy > 0.5) from = "from the top";
      else from = "from the bottom";
      return { key: "e" + i, a, b, len, u: [ux, uy], n: [-uy, ux], name: names[i], from, end: END_EDGES[p.shape].includes("e" + i) };
    });
    let w = 0;
    let h = 0;
    for (const [x, y] of pts) {
      w = Math.max(w, x);
      h = Math.max(h, y);
    }
    runs.forEach((r, i) => { r.name = RUN_NAMES[p.shape][i]; });
    // vertex i joins edge i-1 to edge i; external (convex) when the turn is clockwise (y down)
    const convex = pts.map((_, i) => {
      const d1 = edges[(i - 1 + edges.length) % edges.length].u;
      const d2 = edges[i].u;
      return d1[0] * d2[1] - d1[1] * d2[0] > 0;
    });
    return { pts, edges, runs, w, h, convex };
  }

  // Typing an edge's length sets the run length or depth it comes from.
  function setEdgeLen(p, key, v) {
    const R = p.runs;
    const i = Number(String(key).slice(1));
    const map = {
      straight: [() => (R[0].len = v), () => (R[0].depth = v), () => (R[0].len = v), () => (R[0].depth = v)],
      l: [() => (R[0].len = v), () => (R[0].depth = v), () => (R[0].len = v + R[1].depth), () => (R[1].len = v + R[0].depth), () => (R[1].depth = v), () => (R[1].len = v)],
      lr: [() => (R[0].len = v), () => (R[1].len = v), () => (R[1].depth = v), () => (R[1].len = v + R[0].depth), () => (R[0].len = v + R[1].depth), () => (R[0].depth = v)],
      u: [() => (R[0].len = v), () => (R[2].len = v), () => (R[2].depth = v), () => (R[2].len = v + R[0].depth), () => (R[0].len = v + R[1].depth + R[2].depth), () => (R[1].len = v + R[0].depth), () => (R[1].depth = v), () => (R[1].len = v)],
    }[p.shape];
    if (map && map[i]) map[i]();
  }

  function cutGeom(o, c) {
    const e = o.edges.find((x) => x.key === c.edge) || o.edges[0];
    const [ux, uy] = e.u;
    const [nx, ny] = e.n;
    const x0 = e.a[0] + ux * c.along + nx * c.in;
    const y0 = e.a[1] + uy * c.along + ny * c.in;
    const x1 = x0 + ux * c.w + nx * c.h;
    const y1 = y0 + uy * c.w + ny * c.h;
    const mid = c.in + c.h / 2;
    return {
      x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
      guide: [e.a[0] + nx * mid, e.a[1] + ny * mid, e.a[0] + ux * c.along + nx * mid, e.a[1] + uy * c.along + ny * mid],
      edge: e,
    };
  }

  function joinLine(o, j) {
    const r = o.runs[j.run];
    if (!r) return null;
    const [x0, y0, x1, y1] = r.rect;
    return r.axis === "x" ? [x0 + j.at, y0, x0 + j.at, y1] : [x0, y0 + j.at, x1, y0 + j.at];
  }

  // Which run a point (mm, in the piece's own frame) falls in, and where along it.
  function runAt(o, x, y) {
    for (let i = 0; i < o.runs.length; i++) {
      const [x0, y0, x1, y1] = o.runs[i].rect;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return { run: i, at: Math.round(o.runs[i].axis === "x" ? x - x0 : y - y0) };
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

  function label(g, x, y, text, cls, u, vertical, anchor, extra) {
    const t = node("text", Object.assign({ x, y, class: cls, "font-size": 11 * u, "text-anchor": anchor || "middle", "dominant-baseline": "middle" }, extra || {}), text);
    if (vertical) t.setAttribute("transform", `rotate(-90 ${x} ${y})`);
    g.append(t);
    return t;
  }

  function finishText(f, p, key) {
    if (!f) return "";
    if (f.waterfall) {
      const d = p.drops && p.drops[key];
      return f.code + (d ? " " + d : "");
    }
    return f.code;
  }

  function radius(p, i) {
    const r = p.radii && p.radii["c" + i];
    return r > 0 ? r : 0;
  }

  // A corner's arc: from a (on edge i-1) to b (on edge i), its middle and outward bisector.
  function cornerGeom(o, i, r) {
    const P = o.pts[i];
    const d1 = o.edges[(i - 1 + o.edges.length) % o.edges.length].u;
    const d2 = o.edges[i].u;
    let bx = d1[0] - d2[0];
    let by = d1[1] - d2[1];
    const bl = Math.hypot(bx, by) || 1;
    bx /= bl;
    by /= bl;
    if (!r) return { r: 0, a: P, b: P, mid: P, bis: [bx, by] };
    const a = [P[0] - d1[0] * r, P[1] - d1[1] * r];
    const b = [P[0] + d2[0] * r, P[1] + d2[1] * r];
    const C = [a[0] + d2[0] * r, a[1] + d2[1] * r];
    return { r, a, b, mid: [C[0] + bx * r, C[1] + by * r], bis: [bx, by] };
  }

  // The outline as a path, external corners rounded where a radius is set.
  function shapePath(p, o) {
    const n = o.pts.length;
    let d = "";
    for (let i = 0; i < n; i++) {
      const c = cornerGeom(o, i, o.convex[i] ? radius(p, i) : 0);
      d += (i === 0 ? "M" : "L") + c.a[0] + " " + c.a[1];
      if (c.r) d += ` A${c.r} ${c.r} 0 0 1 ${c.b[0]} ${c.b[1]}`;
    }
    return d + " Z";
  }

  // The finish mark repeated across an edge, about every 70 base px: X, // or [].
  function marks(g, e, mark, u) {
    const [ux, uy] = e.u;
    const [nx, ny] = e.n;
    const n = Math.max(1, Math.floor(e.len / (70 * u)));
    const s = 4 * u;
    for (let k = 0; k < n; k++) {
      const t = ((k + 0.5) * e.len) / n;
      const px = e.a[0] + ux * t;
      const py = e.a[1] + uy * t;
      markAt(g, px, py, ux, uy, nx, ny, s, mark);
    }
  }

  function markAt(g, px, py, ux, uy, nx, ny, s, mark) {
    const P = (a, b) => [px + ux * a + nx * b, py + uy * a + ny * b];
    const seg = (p, q) => line(g, p[0], p[1], q[0], q[1], "bt-mark");
    if (mark === "X") {
      seg(P(-s, -s), P(s, s));
      seg(P(-s, s), P(s, -s));
    } else if (mark === "[]") {
      const c = [P(-s, -s), P(s, -s), P(s, s), P(-s, s)];
      g.append(node("polygon", { points: c.map((q) => q.join(",")).join(" "), class: "bt-mark bt-markbox", "vector-effect": "non-scaling-stroke" }));
    } else {
      seg(P(-s * 1.1, -s * 1.2), P(-s * 0.1, s * 1.2));
      seg(P(s * 0.1, -s * 1.2), P(s * 1.1, s * 1.2));
    }
  }

  // A short sample line with a mark, for legends: an <svg> 48 x 12.
  function sample(kind) {
    const svg = node("svg", { viewBox: "0 0 48 12", class: "bt-sample" });
    if (kind === "join") line(svg, 0, 6, 48, 6, "bt-join");
    else if (kind === "cut") svg.append(node("rect", { x: 10, y: 1, width: 28, height: 10, class: "bt-cut", "vector-effect": "non-scaling-stroke" }));
    else {
      line(svg, 0, 6, 48, 6, "bt-edge" + (kind === "bold" ? " bt-bold" : ""));
      if (kind === "X" || kind === "//" || kind === "[]") for (const x of [12, 36]) markAt(svg, x, 6, 1, 0, 0, 1, 3.2, kind);
    }
    return svg;
  }

  // Draws one piece into group g in its own frame. opts: {finishes, u, print, selEdge, selCut,
  // index (data-piece), number}.
  function drawPiece(g, p, opts) {
    const o = outline(p);
    const u = opts.u || 1;
    const pi = opts.index != null ? opts.index : 0;
    g.append(node("path", { d: shapePath(p, o), class: "bt-shape" + (opts.fill ? " " + opts.fill(p) : ""), "data-piece": pi }));

    // Cut-outs: a dashed outline labelled by what it is, never its size (Todd, 2026-10-25). A
    // located one is dimensioned from the piece's one reference edge: along it, and in from it.
    (p.cutouts || []).forEach((c, i) => {
      const cg = cutGeom(o, c);
      const sel = opts.selCut === i;
      const cls = "bt-cut" + (sel ? " bt-sel" : "");
      const name = (c.kind === "tap" ? "TAP" : KIND_NAMES[c.kind] + (c.label ? " · " + c.label : "")).toUpperCase();
      if (c.kind === "tap") {
        g.append(node("circle", { cx: cg.x + cg.w / 2, cy: cg.y + cg.h / 2, r: c.w / 2, class: cls, "data-cut": i, "data-piece": pi, "vector-effect": "non-scaling-stroke" }));
        label(g, cg.x + cg.w / 2, cg.y - 9 * u, name, "bt-cutlbl", u * 0.85);
      } else {
        g.append(node("rect", { x: cg.x, y: cg.y, width: cg.w, height: cg.h, rx: c.kind === "sink" ? Math.min(40, cg.w / 6) : 0, class: cls, "data-cut": i, "data-piece": pi, "vector-effect": "non-scaling-stroke" }));
        const vert = cg.h > cg.w * 1.4 && cg.w < 140 * u;
        label(g, cg.x + cg.w / 2, cg.y + cg.h / 2, name, "bt-cutlbl", u * 0.85, vert);
      }
      if (c.located) {
        const e = cg.edge;
        const [ux, uy] = e.u;
        const [nx, ny] = e.n;
        // along: from the reference edge's start to the cut-out's near side, just off the edge
        const off = Math.min(c.in / 2, 25 * u) || 12 * u;
        const a0 = [e.a[0] + nx * off, e.a[1] + ny * off];
        const a1 = [a0[0] + ux * c.along, a0[1] + uy * c.along];
        line(g, a0[0], a0[1], a1[0], a1[1], "bt-dim");
        label(g, (a0[0] + a1[0]) / 2 + nx * 8 * u, (a0[1] + a1[1]) / 2 + ny * 8 * u, String(c.along), "bt-dimlbl", u * 0.85, Math.abs(uy) > 0.5);
        // in: from the reference edge to the cut-out's near side, at the cut-out's middle
        const m = c.along - 6 * u; // just before the cut-out's near side, so the figure sits outside it
        const b0 = [e.a[0] + ux * m, e.a[1] + uy * m];
        const b1 = [b0[0] + nx * c.in, b0[1] + ny * c.in];
        if (c.in > 0) {
          line(g, b0[0], b0[1], b1[0], b1[1], "bt-dim");
          label(g, (b0[0] + b1[0]) / 2 - ux * 9 * u, (b0[1] + b1[1]) / 2 - uy * 9 * u, String(c.in), "bt-dimlbl", u * 0.85, Math.abs(ny) > 0.5);
        }
      }
    });

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

    // Edges: one thin unbroken line each, bold when built up to another thickness, with the
    // finish's mark repeated across it (X unfinished, // finished seen, [] square).
    for (const e of o.edges) {
      const fid = p.edges ? p.edges[e.key] : null;
      const f = fid != null && opts.finishes ? opts.finishes[fid] : null;
      const tk = p.thick && p.thick[e.key];
      const sel = opts.selEdge === e.key;
      const [ax, ay] = e.a;
      const [bx, by] = e.b;
      const ra = radius(p, Number(e.key.slice(1)));
      const rb = radius(p, (Number(e.key.slice(1)) + 1) % o.pts.length);
      line(g, ax + e.u[0] * ra, ay + e.u[1] * ra, bx - e.u[0] * rb, by - e.u[1] * rb, "bt-edge" + (tk ? " bt-bold" : ""));
      if (f) marks(g, e, f.mark, u);
      if (sel) line(g, ax, ay, bx, by, "bt-edge-sel");
      if (!opts.print) line(g, ax, ay, bx, by, "bt-hit", { "data-edge": e.key, "data-piece": pi });
      const mx = (ax + bx) / 2 - e.n[0] * 18 * u;
      const my = (ay + by) / 2 - e.n[1] * 18 * u;
      const vertical = Math.abs(e.u[1]) > 0.5;
      const bits = [];
      if (f) bits.push(opts.print ? finishText(f, p, e.key) : f.waterfall ? finishText(f, p, e.key) : f.name.toUpperCase());
      if (tk) bits.push(tk + " MM");
      if (p.datum === e.key && (p.cutouts || []).some((c) => c.located)) bits.push("REF");
      const code = bits.join(" · ");
      if (opts.print) {
        label(g, mx, my, code ? `${e.len} · ${code}` : String(e.len), "bt-elbl", u, vertical);
      } else {
        const off2 = 13 * u;
        const lx = mx - e.n[0] * (code ? off2 / 2 : 0);
        const ly = my - e.n[1] * (code ? off2 / 2 : 0);
        // the length is clickable: benchtop.js opens an input on it
        label(g, lx, ly, String(e.len), "bt-elbl bt-edit" + (sel ? " bt-sel-txt" : ""), u, vertical, null, { "data-len": e.key, "data-piece": pi });
        if (code) label(g, lx + e.n[0] * off2, ly + e.n[1] * off2, code, "bt-ecode" + (sel ? " bt-sel-txt" : ""), u * 0.8, vertical);
      }
      if (sel && !opts.print) {
        g.append(node("circle", { cx: ax, cy: ay, r: 5 * u, class: "bt-node" }));
        g.append(node("circle", { cx: bx, cy: by, r: 5 * u, class: "bt-node" }));
      }
    }

    // Corners (Todd, 2026-10-25): a rounded external corner is drawn as an arc with a leader to it
    // labelled "R100"; every external corner is clickable on screen.
    o.pts.forEach((P, i) => {
      if (!o.convex[i]) return;
      const c = cornerGeom(o, i, radius(p, i));
      const sel = opts.selCorner === i;
      if (c.r) {
        const ein = o.edges[(i - 1 + o.pts.length) % o.pts.length];
        const tk = p.thick && (p.thick[ein.key] || p.thick[o.edges[i].key]);
        g.append(node("path", { d: `M${c.a[0]} ${c.a[1]} A${c.r} ${c.r} 0 0 1 ${c.b[0]} ${c.b[1]}`, class: "bt-edge" + (tk ? " bt-bold" : ""), "vector-effect": "non-scaling-stroke" }));
        const L = 22 * u;
        const end = [c.mid[0] + c.bis[0] * L, c.mid[1] + c.bis[1] * L];
        line(g, c.mid[0], c.mid[1], end[0], end[1], "bt-leader");
        label(g, end[0] + c.bis[0] * 4 * u, end[1] + c.bis[1] * 6 * u, "R" + c.r, "bt-rlbl" + (sel ? " bt-sel-txt" : ""), u * 0.9, false, c.bis[0] >= 0 ? "start" : "end");
      }
      if (!opts.print) {
        if (sel) g.append(node("circle", { cx: c.mid[0], cy: c.mid[1], r: 5 * u, class: "bt-node" }));
        g.append(node("circle", { cx: c.mid[0], cy: c.mid[1], r: 9 * u, class: "bt-chit", "data-corner": i, "data-piece": pi }));
      }
    });

    if (opts.number != null) {
      const r = o.runs[0].rect;
      g.append(node("text", { x: r[0] + 14 * u, y: r[1] + 30 * u, class: "bt-num", "font-size": 22 * u }, String(opts.number)));
    }
    return o;
  }

  // One piece on its own. Returns {svg, outline, pad}.
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
    drawPiece(g, p, opts);
    return { svg, outline: o, pad };
  }

  // The bounding box of every piece at its position.
  function bounds(pieces) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pieces) {
      const o = outline(p);
      const x = p.x || 0, y = p.y || 0;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + o.w); y1 = Math.max(y1, y + o.h);
    }
    if (!pieces.length) return { x0: 0, y0: 0, w: 1000, h: 1000 };
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }

  // Every piece together. opts as drawPiece, plus sel (the selected piece index) and numbers.
  // Returns {svg, groups}.
  function renderSet(pieces, opts) {
    const b = bounds(pieces);
    const u = opts.u || 1;
    const pad = opts.pad != null ? opts.pad : 60 * u;
    const svg = node("svg", {
      class: "bt-svg" + (opts.print ? " bt-print" : ""),
      viewBox: `${b.x0 - pad} ${b.y0 - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`,
      "font-family": "Arial, Helvetica, sans-serif",
    });
    const groups = pieces.map((p, i) => {
      const g = node("g", { transform: `translate(${p.x || 0} ${p.y || 0})`, class: "bt-pg" + (opts.sel === i ? " on" : ""), "data-group": i });
      const mine = opts.sel === i;
      drawPiece(g, p, Object.assign({}, opts, { index: i, number: letter(i), selEdge: mine ? opts.selEdge : null, selCut: mine ? opts.selCut : null, selCorner: mine ? opts.selCorner : null }));
      svg.append(g);
      return g;
    });
    return { svg, groups, bounds: b, pad };
  }

  function area(p) {
    const pts = outline(p).pts;
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2; // mm²
  }

  // Totals (Todd, 2026-10-25): area in m² (2 dp) overall and per material, metres of each edge
  // finish (1 dp) and of built-up edges. Joins and cut-outs don't reduce the area. Rounded once,
  // from the exact sums.
  function totals(pieces, finishes, materials) {
    let all = 0;
    const byMat = new Map();
    const byFin = new Map();
    const byThick = new Map();
    for (const p of pieces) {
      const a = area(p);
      all += a;
      const mk = p.materialId == null ? "none" : String(p.materialId);
      byMat.set(mk, (byMat.get(mk) || 0) + a);
      for (const e of outline(p).edges) {
        const fid = p.edges ? p.edges[e.key] : null;
        const f = fid != null && finishes ? finishes[fid] : null;
        const k = f ? String(f.id) : "none";
        byFin.set(k, (byFin.get(k) || 0) + e.len);
        const tk = p.thick && p.thick[e.key];
        if (tk) byThick.set(tk, (byThick.get(tk) || 0) + e.len);
      }
    }
    const m2 = (v) => (v / 1e6).toFixed(2);
    const m = (v) => (v / 1000).toFixed(1);
    const mats = [...byMat.entries()].map(([k, v]) => {
      const mt = k !== "none" && materials ? materials[k] : null;
      return { key: k, name: mt ? [mt.colour, mt.thickness + " mm"].join(" ") : "No material", m2: m2(v) };
    });
    const fins = [...byFin.entries()].map(([k, v]) => {
      const f = k !== "none" ? finishes[k] : null;
      return { name: f ? f.name : "Not set", mark: f ? f.mark : null, m: m(v) };
    });
    const thick = [...byThick.entries()].map(([t, v]) => ({ name: t + " mm edge", m: m(v) }));
    return { m2: m2(all), mats, fins, thick };
  }

  // Pieces are lettered A, B, C... in list order (Todd, 2026-10-25); after Z: AA, AB...
  function letter(i) {
    let s = "";
    let n = i + 1;
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // The fill class of each piece: one material → light grey (bt-fill-g); several → a pale tint per
  // material in order of first use (bt-fill-0..5, then round again). Returns {of(p), list}.
  function fills(pieces) {
    const ids = [];
    for (const p of pieces) {
      const k = p.materialId == null ? "none" : String(p.materialId);
      if (!ids.includes(k)) ids.push(k);
    }
    const one = ids.length <= 1;
    const cls = (k) => (one ? "bt-fill-g" : "bt-fill-" + (ids.indexOf(k) % 6));
    return {
      of: (p) => cls(p.materialId == null ? "none" : String(p.materialId)),
      byMaterial: (k) => cls(k == null ? "none" : String(k)),
      list: ids,
    };
  }

  function describe(p) {
    if (p.shape === "straight") return `Straight · ${p.runs[0].len} × ${p.runs[0].depth}`;
    if (p.shape === "l" || p.shape === "lr") {
      return `L ${p.shape === "l" ? "left" : "right"} · ${p.runs[0].len} × ${p.runs[1].len}, depths ${p.runs[0].depth} / ${p.runs[1].depth}`;
    }
    return `U · ${p.runs[1].len} × ${p.runs[0].len} × ${p.runs[2].len}, depths ${p.runs[1].depth} / ${p.runs[0].depth} / ${p.runs[2].depth}`;
  }

  window.BtDraw = { letter, fills, totals, sample, outline, setEdgeLen, cutGeom, joinLine, runAt, render, renderSet, bounds, describe, EDGE_NAMES, END_EDGES, RUN_NAMES, SHAPE_NAMES, KIND_NAMES };
})();
