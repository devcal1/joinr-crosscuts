// A job's printed order list (projectorder.html?id=N&rev=A; docs/plans/m22-project-jobs.md
// section 6), from GET /api/job-records/:id/project/order-lists/:rev. The frozen lines grouped by
// supplier (A to Z), materials before hardware within each, with a tick column for checking off.
// All text goes in through textContent. Page classes are po-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const jobId = Number(q.get("id"));
  const rev = q.get("rev") || "";

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "numeric", year: "numeric" }).formatToParts(d);
    const get = (t) => (p.find((x) => x.type === t) || {}).value;
    return `${get("day")} ${MONTHS[Number(get("month")) - 1]} ${get("year")}`;
  }
  const fmtQty = (n) => (n == null ? "" : String(Math.round(n * 1000) / 1000));

  function render(d) {
    const sectionLabel = (id) => {
      const s = d.sections.find((x) => x.id === id);
      return s ? s.label : String(id || "").replace(/_/g, " ");
    };
    const sheet = $("poSheet");
    const meta = el("dl", { class: "po-meta" });
    const kv = (k, v) => v && meta.append(el("dt", { text: k }), el("dd", { text: v }));
    kv("Revision", d.revision);
    kv("Finalised", fmtWhen(d.finalisedAt) + (d.finalisedBy ? " " + d.finalisedBy : ""));
    kv("Sent", d.sentAt ? fmtWhen(d.sentAt) : "Not yet");
    kv("Owner", d.job.owner);
    kv("Quote", d.job.quoteNumber);

    const title = el(
      "div",
      { class: "po-titlerow" },
      el(
        "div",
        {},
        el("p", { class: "po-brand", text: "TH Cabinets" }),
        el("h1", { class: "po-h1", text: "Order list" }),
        el("p", { class: "po-sub", text: d.job.name }),
        d.job.clientName ? el("p", { text: d.job.clientName }) : null,
        d.job.siteAddress && d.job.siteAddress !== d.job.name ? el("p", { text: d.job.siteAddress }) : null
      ),
      meta
    );
    sheet.replaceChildren(title);
    if (d.superseded) sheet.append(el("p", { class: "po-stamp", text: `Superseded: a later revision exists` }));

    const all = [...d.materials, ...d.hardware];
    const bySupplier = new Map();
    for (const l of all) {
      const k = l.supplier || "No supplier";
      if (!bySupplier.has(k)) bySupplier.set(k, []);
      bySupplier.get(k).push(l);
    }
    const names = [...bySupplier.keys()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    for (const name of names) {
      const lines = bySupplier.get(name);
      const rows = lines.map((l) => {
        const details = [l.brand, l.code, l.colour, l.finish].filter(Boolean).join(" · ");
        return el(
          "tr",
          {},
          el("td", { class: "po-c-tick", text: "[  ]" }),
          el("td", { class: "po-c-sec", text: sectionLabel(l.section) }),
          el("td", {}, l.name, details ? el("span", { class: "po-detail", text: details }) : null, l.notes ? el("span", { class: "po-detail", text: l.notes }) : null),
          el("td", { class: "po-c-qty po-num", text: fmtQty(l.qty) + (l.unit ? " " + l.unit : "") })
        );
      });
      sheet.append(
        el(
          "section",
          { class: "po-group" },
          el("h2", { class: "po-grouph", text: `${name} · ${lines.length} ${lines.length === 1 ? "line" : "lines"}` }),
          el(
            "table",
            { class: "po-table" },
            el("thead", {}, el("tr", {}, el("th", { text: "" }), el("th", { text: "Section" }), el("th", { text: "Item" }), el("th", { class: "po-num", text: "Qty" }))),
            el("tbody", {}, ...rows)
          )
        )
      );
    }
    sheet.append(el("p", { class: "po-foot", text: `${all.length} ${all.length === 1 ? "line" : "lines"} · Revision ${d.revision} · Printed ${fmtWhen(new Date().toISOString())}` }));
  }

  async function load() {
    $("poBack").href = Number.isInteger(jobId) && jobId > 0 ? `/project.html?id=${jobId}` : "/pipeline.html";
    try {
      const d = await api(`/api/job-records/${jobId}/project/order-lists/${encodeURIComponent(rev)}`);
      document.title = `${d.job.name} order list ${d.revision} - Crosscuts`;
      render(d);
      $("poStatus").textContent = "";
      $("poPrint").disabled = false;
    } catch (e) {
      $("poStatus").textContent = "Could not load the order list: " + e.message;
    }
  }

  $("poPrint").addEventListener("click", () => window.print());
  load();
})();
