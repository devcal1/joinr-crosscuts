// Batten calculator (/battens.html, design.view; docs/plans/m12-contracts.md section 9.5). The
// page only reads the inputs and draws what Battens.solve (battens.js, section 6) answers: the
// result line, the strip and the set-out. Results update as you type. Nothing is saved: no
// server call and no storage.
(function () {
  "use strict";

  const B = window.Battens;
  const $ = (id) => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";
  const CHUNK = 25; // set-out rows per table; the tables sit in columns

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
  function svg(tag, attrs) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }

  // Millimetres as typed on a tape: 58, 58.5, 1768.
  const mm = (n) => String(n) + " mm";
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

  function radio(name) {
    const r = document.querySelector(`input[name="${name}"]:checked`);
    return r ? r.value : "";
  }

  function inputs() {
    const from = radio("bnFrom");
    const q = {
      space: $("bnSpace").value.trim(),
      width: $("bnWidth").value.trim(),
      ends: radio("bnEnds"),
    };
    if (from === "gap") q.gap = $("bnGap").value.trim();
    else q.count = $("bnCount").value.trim();
    // A number input holding text it can't read reports "" with badInput; pass that on as
    // something bad rather than as missing, so the refusal names the field.
    for (const [key, id] of [["space", "bnSpace"], ["width", "bnWidth"], ["gap", "bnGap"], ["count", "bnCount"]]) {
      if (key in q && q[key] === "" && $(id).validity && $(id).validity.badInput) q[key] = "?";
    }
    return { from, q };
  }

  // ---------------------------------------------------------------- result

  function kv(k, v) {
    return [el("div", { class: "k", text: k }), el("div", { class: "v", text: v })];
  }

  function showResult(r, from, asked) {
    $("bnLine").textContent =
      `${plural(r.count, "batten", "battens")} of ${mm(r.width)}, ${plural(r.gaps, "gap", "gaps")} of ${mm(r.gap)}`;
    const rows = [];
    if (from === "gap") rows.push(...kv("Gap asked for", mm(asked)));
    rows.push(...kv("Exact gap", r.exactGap.toFixed(2) + " mm"));
    rows.push(...kv("Total", mm(r.total)));
    rows.push(...kv("Left over", r.leftOver > 0 ? `${mm(r.leftOver)}, at the far end` : "None"));
    $("bnKvt").replaceChildren(...rows);
  }

  // ---------------------------------------------------------------- the strip

  // The run scaled to the width of the page: one SVG in millimetres, stretched across, the
  // battens one filled path, the gaps empty, any left-over shaded at the far end.
  function drawStrip(r) {
    const s = svg("svg", {
      class: "bn-svg",
      viewBox: `0 0 ${r.space} 100`,
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": `The run: ${plural(r.count, "batten", "battens")} and ${plural(r.gaps, "gap", "gaps")} across ${mm(r.space)}` +
        (r.leftOver > 0 ? `, ${mm(r.leftOver)} left over at the far end` : ""),
    });
    if (r.leftOver > 0) {
      s.append(svg("rect", { class: "bn-left", x: r.space - r.leftOver, y: 0, width: r.leftOver, height: 100 }));
    }
    let d = "";
    for (const b of r.setOut) d += `M${b.start} 0H${b.end}V100H${b.start}Z`;
    s.append(svg("path", { class: "bn-batten", d }));
    // A batten too thin to show at this scale (1 mm in 20 m is a twentieth of a pixel) is still
    // drawn: a 1 px line down the middle of each, which keeps its width however the run is scaled.
    let mid = "";
    for (const b of r.setOut) mid += `M${(b.start + b.end) / 2} 0V100`;
    s.append(svg("path", { class: "bn-batten-min", d: mid, "vector-effect": "non-scaling-stroke" }));
    s.append(svg("rect", { class: "bn-frame", x: 0, y: 0, width: r.space, height: 100, "vector-effect": "non-scaling-stroke" }));
    $("bnStrip").replaceChildren(s);
    $("bnScaleEnd").textContent = mm(r.space);
  }

  // ---------------------------------------------------------------- set-out

  function setOutTable(rows) {
    const body = el("tbody");
    for (const b of rows) {
      body.append(el("tr", null,
        el("th", { scope: "row", class: "bn-c-n", text: String(b.n) }),
        el("td", { class: "bn-n", text: String(b.start) }),
        el("td", { class: "bn-n", text: String(b.end) })));
    }
    return el("table", { class: "bn-table" },
      el("thead", null, el("tr", null,
        el("th", { scope: "col", class: "bn-c-n", text: "Batten" }),
        el("th", { scope: "col", class: "bn-n", text: "Starts at" }),
        el("th", { scope: "col", class: "bn-n", text: "Ends at" }))),
      body);
  }

  function drawSetOut(r) {
    const box = $("bnSetOut");
    const tables = [];
    for (let i = 0; i < r.setOut.length; i += CHUNK) tables.push(setOutTable(r.setOut.slice(i, i + CHUNK)));
    box.classList.toggle("bn-setout-long", tables.length > 1);
    box.replaceChildren(...tables);
  }

  // ---------------------------------------------------------------- the print head

  function printInputs(r, from, asked, widthEmpty) {
    const parts = [
      `Space to fill ${mm(r.space)}`,
      `batten width ${mm(r.width)}${widthEmpty ? " (the default)" : ""}`,
      r.ends === "gap" ? "gap at each end" : "batten at each end",
      from === "gap" ? `worked out from a gap of ${mm(asked)}` : `worked out from ${plural(r.count, "batten", "battens")}`,
    ];
    $("bnPrintInputs").textContent = parts.join("; ");
  }

  // ---------------------------------------------------------------- update

  function update() {
    const { from, q } = inputs();
    $("bnCountField").hidden = from === "gap";
    $("bnGapField").hidden = from !== "gap";
    // An empty width isn't a mistake: the sums use the default, and the page says so.
    const widthEmpty = q.width === "";
    $("bnWidthNote").hidden = !widthEmpty;

    const r = B.solve(q);
    const msg = $("bnMsg");
    if (!r.ok) {
      msg.textContent = r.error;
      // An empty field is a prompt, not a mistake: only a typed value that's refused is orange.
      const empty = q.space === "" || (from === "gap" ? q.gap === "" : q.count === "");
      msg.className = "bn-msg" + (empty ? "" : " bn-msg-err");
      $("bnOut").hidden = true;
      $("bnRunSec").hidden = true;
      $("bnSetSec").hidden = true;
      $("bnPrint").disabled = true;
      return;
    }
    msg.textContent = "";
    msg.className = "bn-msg";
    const asked = from === "gap" ? Number(q.gap) : null;
    showResult(r, from, asked);
    drawStrip(r);
    drawSetOut(r);
    printInputs(r, from, asked, widthEmpty);
    $("bnOut").hidden = false;
    $("bnRunSec").hidden = false;
    $("bnSetSec").hidden = false;
    $("bnPrint").disabled = false;
  }

  // ---------------------------------------------------------------- print

  let titleBefore = null;
  function beforePrint() {
    if (titleBefore == null) titleBefore = document.title;
    document.title = "Batten set-out";
  }
  function afterPrint() {
    if (titleBefore != null) document.title = titleBefore;
    titleBefore = null;
  }
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);

  $("bnPrint").addEventListener("click", () => {
    beforePrint();
    window.print();
  });

  $("bnWidthNote").textContent = `Empty, so using ${B.DEFAULT_WIDTH} mm`;
  $("bnWidth").placeholder = String(B.DEFAULT_WIDTH);

  $("bnForm").addEventListener("input", update);
  $("bnForm").addEventListener("change", update);
  $("bnForm").addEventListener("submit", (e) => e.preventDefault());

  update();
})();
