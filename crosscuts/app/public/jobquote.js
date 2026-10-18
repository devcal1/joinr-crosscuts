// The job page's "From Joinr quote" section (task J4; contract version 4): the whole quote as Joinr
// priced it, from GET /api/job-records/:id/joinr-quote. Rooms (each folds away) with their lines,
// additional items, hours and, for jobs.value holders only, the money; then the labour and (money holders) the options,
// notes, warnings and totals. The server leaves money out of the answer for
// everyone else, so this page only draws what it is given: `data.money` says whether it has any.
// Loaded by job.html after job.js; job.js calls JobQuote.start() with jobs.view. All text goes in
// through textContent. Page classes here are fq-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

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

  // $12,345.67 from integer cents; a figure Joinr could not compute shows as a dash.
  function money(c) {
    if (typeof c !== "number" || !Number.isFinite(c)) return "-";
    const a = Math.abs(Math.round(c));
    return (c < 0 ? "-" : "") + "$" + String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + String(a % 100).padStart(2, "0");
  }
  const qty = (q) => (typeof q === "number" && Number.isFinite(q) ? String(Math.round(q * 1000) / 1000) : "");
  const hours = (h) => (typeof h === "number" && Number.isFinite(h) ? String(Math.round(h * 100) / 100) : "-");
  const pct = (f) => (typeof f === "number" && Number.isFinite(f) ? String(Math.round(f * 10000) / 100) + "%" : "-");
  const times = (m) => (typeof m === "number" && Number.isFinite(m) ? String(Math.round(m * 10000) / 10000) : "-");

  function fmtInstant(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric" }).format(d);
  }

  function sumItem(label, value) {
    return el("div", { class: "jo-sumitem" }, el("span", { class: "jo-sumlabel", text: label }), el("span", { class: "jo-sumval", text: value }));
  }

  function table(heads, rows, numCols) {
    const t = el("table", { class: "hs-table fq-table" });
    const hr = el("tr");
    heads.forEach((h, i) => hr.append(el("th", { text: h, class: numCols.includes(i) ? "fq-num" : "" })));
    t.append(el("thead", {}, hr));
    const tb = el("tbody");
    for (const cells of rows) {
      const tr = el("tr");
      cells.forEach((c, i) => tr.append(el("td", { text: c, class: (numCols.includes(i) ? "fq-num " : "") + (i === 0 ? "fq-name" : "") })));
      tb.append(tr);
    }
    t.append(tb);
    return el("div", { class: "jo-wrap fq-wrap" }, t);
  }

  function roomBlock(room, withMoney, open) {
    const bodyId = "fq-room-" + Math.random().toString(36).slice(2, 8);
    const head = el("button", { type: "button", class: "fq-roomhead", "aria-expanded": open ? "true" : "false", "aria-controls": bodyId });
    head.append(el("span", { class: "fq-roomname", text: room.name || "Room" }));
    if (withMoney && room.totals) head.append(el("span", { class: "fq-roomtotal", text: money(room.totals.incGstCents) }));
    const toggle = el("span", { class: "fq-toggle", text: open ? "Hide" : "Show" });
    head.append(toggle);

    const body = el("div", { class: "fq-roombody", id: bodyId });
    body.hidden = !open;
    head.addEventListener("click", () => {
      const nowOpen = body.hidden;
      body.hidden = !nowOpen;
      head.setAttribute("aria-expanded", nowOpen ? "true" : "false");
      toggle.textContent = nowOpen ? "Hide" : "Show";
    });

    const spec = [];
    if (room.spec && room.spec.doorsPanels) spec.push(["Doors and panels", room.spec.doorsPanels]);
    if (room.spec && room.spec.benchtop) spec.push(["Benchtop", room.spec.benchtop]);
    if (room.spec && room.spec.jobType) spec.push(["Job type", room.spec.jobType]);
    if (spec.length) body.append(el("div", { class: "jo-summary fq-spec" }, ...spec.map(([l, v]) => sumItem(l, v))));

    for (const g of room.sections) {
      const heads = ["Item", "Qty", "Unit"];
      const nums = [1];
      if (withMoney) {
        heads.push("Rate", "Line total");
        nums.push(3, 4);
      }
      const rows = g.lines.map((l) => {
        const cells = [l.name, qty(l.qty), l.unit || ""];
        if (withMoney) cells.push(money(l.unitRateCents), money(l.lineTotalCents));
        return cells;
      });
      const title = el("h4", { class: "fq-sectitle" }, el("span", { text: g.title }));
      if (g.labour) title.append(el("span", { class: "fq-tag", text: "Labour" }));
      if (withMoney && g.totalCents !== undefined) title.append(el("span", { class: "fq-sectotal", text: money(g.totalCents) }));
      body.append(title, table(heads, rows, nums));
    }

    if (room.customItems.length) {
      const heads = ["Additional item", "Qty"];
      const nums = [1];
      if (withMoney) {
        heads.push("Price", "Line total", "Markup", "Marked up");
        nums.push(2, 3, 4, 5);
      }
      const rows = room.customItems.map((c) => {
        const cells = [c.description || "Additional item", qty(c.qty)];
        if (withMoney) cells.push(money(c.unitPriceCents), money(c.lineTotalCents), times(c.markup), money(c.lineTotalWithMarkupCents));
        return cells;
      });
      body.append(el("h4", { class: "fq-sectitle" }, el("span", { text: "Additional items" })), table(heads, rows, nums));
    }

    const h = room.hours || {};
    body.append(
      el("p", { class: "fq-hours muted", text: "Hours in this room (Joinr's figures): office " + hours(h.office) + ", factory " + hours(h.factory) + ", site " + hours(h.site) + ", travel " + hours(h.travel) + "." })
    );

    if (withMoney && room.totals) {
      const t = room.totals;
      const rows = [
        ["Labour (office)", money(t.labourOfficeCents)],
        ["Labour (workshop)", money(t.labourWorkshopCents)],
        ["Materials", money(t.materialsCents)],
        ["Overheads (with travel)", money(t.overheadsCents)],
        ["Markup (x" + times(t.markupFactor) + ")", money(t.markupCents)],
        ["Adjust and global markup", money(t.adjustCents)],
        ["Ex GST", money(t.exGstCents)],
        ["GST", money(t.gstCents)],
        ["Inc GST", money(t.incGstCents)],
        ["Cost of goods", money(t.costOfGoodsCents) + (t.cogsWarning ? " (profit too low)" : "")],
        ["Margin", money(t.marginCents)],
      ];
      body.append(el("h4", { class: "fq-sectitle" }, el("span", { text: "Room totals" })), table(["", "Amount"], rows, [1]));
    }
    return el("div", { class: "fq-room" }, head, body);
  }

  function render(data) {
    const q = data.quote;
    const m = data.money === true;
    const nodes = [];

    const items = [];
    if (data.quoteNumber) items.push(sumItem("Quote number", data.quoteNumber));
    items.push(sumItem("Rate card", q.pricedAt === "snapshot" ? "Frozen with the quote" : q.pricedAt === "live" ? "Joinr's current card" : "Unknown"));
    if (typeof q.kmFromFactory === "number") items.push(sumItem("From the factory", qty(q.kmFromFactory) + " km"));
    if (m && q.tier) items.push(sumItem("Tier", (q.tier.label || q.tier.code || "None") + (q.tier.fallback ? " (the quote's tier is gone from the card)" : "")));
    if (m && q.globalMarkup != null) items.push(sumItem("Global markup", pct(q.globalMarkup)));
    if (m && q.gst) items.push(sumItem("GST", q.gst.registered ? pct(q.gst.rate) : "Not registered"));
    nodes.push(el("div", { class: "jo-summary" }, ...items));

    // The rooms. One open room reads best; a single-room quote opens it.
    const roomsWrap = el("div", { class: "fq-rooms" });
    q.rooms.forEach((r, i) => roomsWrap.append(roomBlock(r, m, q.rooms.length === 1 && i === 0)));
    if (!q.rooms.length) roomsWrap.append(el("p", { class: "muted jo-empty", text: "The quote has no rooms." }));
    nodes.push(roomsWrap);

    // Labour, whole quote.
    const kinds = [["office", "Office", "hrs"], ["factory", "Factory", "hrs"], ["site", "Site", "hrs"], ["travel", "Travel", "trips"]];
    const lHeads = ["Labour", "On the quote", "Joinr hours"];
    const lNums = [1, 2];
    if (m) {
      lHeads.push("Cost");
      lNums.push(3);
    }
    const lRows = kinds.map(([k, label, unit]) => {
      const v = q.labour[k] || {};
      const row = [label, qty(v.typed) + " " + unit, hours(v.hours)];
      if (m) row.push(money(v.costCents));
      return row;
    });
    nodes.push(
      el("h3", { class: "fq-h", text: "Labour" }),
      table(lHeads, lRows, lNums),
      el("p", { class: "fq-hours muted", text: "Factory and site hours are typed on the quote and halved in Joinr's hours; travel is trips." })
    );

    if (q.options && q.options.length) {
      const heads = ["Option", "Room"];
      const nums = [];
      if (m) {
        heads.push("Inc GST", "Ex GST");
        nums.push(2, 3);
      }
      const rows = q.options.map((o) => {
        const row = [o.label + (o.computed ? " (worked out from an item swap)" : ""), o.roomName || "Whole job"];
        if (m) row.push(money(o.priceIncGstCents), money(o.priceExGstCents));
        return row;
      });
      nodes.push(el("h3", { class: "fq-h", text: "Options" }), table(heads, rows, nums), el("p", { class: "fq-hours muted", text: "Options are priced beside the total, never in it." }));
    }

    if (q.notes) nodes.push(el("h3", { class: "fq-h", text: "Notes on the quote" }), el("p", { class: "fq-notes", text: q.notes }));

    if (m && q.warnings && q.warnings.length) {
      const ul = el("ul", { class: "fq-warnings" });
      for (const w of q.warnings) {
        ul.append(el("li", { class: w.severity === "red" ? "fq-warn-red" : "fq-warn-amber", text: (w.roomName ? w.roomName + ": " : "") + w.message }));
      }
      nodes.push(el("h3", { class: "fq-h", text: "Joinr's warnings" }), ul);
    }

    if (m && q.totals) {
      const t = q.totals;
      const rows = [
        ["Labour (office)", money(t.labourOfficeCents)],
        ["Labour (workshop)", money(t.labourWorkshopCents)],
        ["Materials", money(t.materialsCents)],
        ["Markup", money(t.markupCents)],
        ["Overheads", money(t.overheadsCents)],
        ["Adjust and global markup", money(t.adjustCents)],
        ["Ex GST", money(t.exGstCents)],
        ["GST", money(t.gstCents)],
        ["Total inc GST", money(t.incGstCents)],
        ["Cost of goods", money(t.costOfGoodsCents) + " (" + pct(t.cogsRatio) + (t.cogsWarning ? ", over Joinr's threshold" : "") + ")"],
        ["Margin (Joinr's profit)", money(t.marginCents)],
      ];
      nodes.push(el("h3", { class: "fq-h", text: "Totals" }), table(["", "Amount"], rows, [1]));
    }

    const when = fmtInstant(data.quote.receivedAt);
    nodes.push(
      el("p", {
        class: "fq-foot muted",
        text:
          "Priced in Joinr" +
          (when ? " (received " + when + ")" : "") +
          (data.money
            ? ". Totals may differ by a cent from rounding. The figures are Joinr's: they do not change this job."
            : ". This is Joinr's quote: it does not change this job."),
      })
    );
    $("fqBody").replaceChildren(...nodes);
  }

  function linkTo(url, text) {
    return url ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer", text }) : null;
  }

  async function start(opts) {
    const section = $("fullquote");
    if (!section) return false;
    let data;
    try {
      data = await api("/api/job-records/" + opts.jobId + "/joinr-quote");
    } catch (e) {
      section.hidden = true;
      return false;
    }
    if (!data || data.status === "not-linked" || data.status === "none") {
      section.hidden = true;
      return true;
    }
    section.hidden = false;
    if (data.status === "too-large") {
      const link = linkTo(data.joinrUrl, "Open it in Joinr");
      const p = el("p", { class: "muted jo-empty" }, document.createTextNode("The full quote was too large to send (or Joinr could not price it). "));
      if (link) p.append(link, document.createTextNode("."));
      $("fqBody").replaceChildren(p);
      return true;
    }
    render(data);
    return true;
  }

  // Printing shows every room, whatever is folded away: jobquote.css's print rules.
  window.JobQuote = { start };
})();
