// The job page's Benchtops section (docs/plans/m12-contracts.md section 9.1): the job's stone
// orders from GET /api/job-records/:id/stone, each with its state, Open (design.view) and Print,
// plus New stone order (jobs.edit and design.view, not on an archived job) and Print benchtop sheet.
// Loaded by job.html after job.js; job.js calls JobStone.start() from its start-up (with jobs.view)
// so the #benchtops hash jump waits for it, and JobStone.refresh() after the job is saved (its
// benchtop or archived flag may have changed). Every rule lives in lib/stone.js; this only hides
// what the user can't use. All text goes in through textContent. Page classes here are jt-.
(function () {
  "use strict";

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const $ = (id) => document.getElementById(id);

  let jobId = null;
  let can = () => false;
  let data = null; // {job, orders, prefill, benchtopText}
  let showCancelled = false;
  let seq = 0;

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

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }
  function fmtDayMon(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : "";
  }

  function setLine(msg, kind) {
    const n = $("jtStatus");
    n.textContent = msg || "";
    n.className = "jo-status " + (kind || "muted");
  }

  // The state as section 9.1 words it: [text, badge class, note under it].
  function stateOf(o) {
    if (o.status === "cancelled") return ["Cancelled", "hs-badge-na", null];
    if (o.status === "draft" || !o.revision) return ["Draft", "hs-badge-na", null];
    if (o.changedSinceSent) return ["Changed since rev " + o.revision, "hs-badge-check", null];
    const who = o.sentBy && o.sentBy.name ? "by " + o.sentBy.name : null;
    return ["Sent rev " + o.revision + (o.sentDate ? ", " + fmtDayMon(o.sentDate) : ""), "hs-badge-teal", who];
  }

  // A sent order with no unsent change prints its frozen revision; anything else prints the
  // current form (marked as a draft on the paper).
  function printHref(o) {
    const frozen = o.revision > 0 && !o.changedSinceSent;
    return "/stoneprint.html?id=" + encodeURIComponent(o.id) + (frozen ? "&rev=" + encodeURIComponent(o.revision) : "");
  }

  function orderName(o) {
    const f = o.form || {};
    return [f.supplier || "No supplier yet", [f.brand, f.colour].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  }

  function render() {
    const body = $("jtBody");
    const tools = $("jtTools");
    if (!data) {
      body.replaceChildren();
      tools.replaceChildren();
      return;
    }
    const all = Array.isArray(data.orders) ? data.orders : [];
    const live = all.filter((o) => o.status !== "cancelled");
    const cancelled = all.length - live.length;
    const shown = showCancelled ? all : live;
    const nodes = [];

    if (data.job && data.job.benchtop === "stone" && !live.length) {
      nodes.push(el("p", { class: "jt-attend", text: "Stone benchtop: no stone order yet" }));
    }
    if (!shown.length) {
      if (!nodes.length) nodes.push(el("p", { class: "muted jo-empty", text: "No stone orders." }));
      if (!showCancelled && cancelled) {
        nodes.push(el("p", { class: "muted jo-empty", text: cancelled === 1 ? "1 cancelled stone order (Show cancelled)." : cancelled + " cancelled stone orders (Show cancelled)." }));
      }
    } else {
      // The state second, so it shows without scrolling the table on a phone.
      const heads = ["Supplier", "State", "Stone", "Edge", "Measure", "Requested install"];
      const tb = el("tbody");
      const mayOpen = can("design.view");
      for (const o of shown) {
        const f = o.form || {};
        const [label, badge, note] = stateOf(o);
        const tr = el("tr", { class: o.status === "cancelled" ? "jo-cancelled jo-hasacts" : "jo-hasacts", "data-id": String(o.id) },
          f.supplier ? el("td", { class: "jo-strong", text: f.supplier }) : el("td", {}, el("span", { class: "jo-note", text: "No supplier yet" })),
          el("td", { class: "jt-state" }, el("span", { class: "hs-badge " + badge, text: label }), note ? el("span", { class: "jo-note", text: note }) : null),
          el("td", { class: "jo-text", text: [f.brand, f.colour].filter(Boolean).join(", ") }),
          el("td", { class: "jo-text", text: [f.edgeHeight, f.edgeProfile].filter(Boolean).join(", ") }),
          el("td", { class: "jo-dates" }, f.measureDate ? el("span", { text: fmtDate(f.measureDate) }) : null),
          el("td", { class: "jo-dates" }, f.requestedInstallDate ? el("span", { text: fmtDate(f.requestedInstallDate) }) : null));
        tb.append(tr);
        const acts = el("div", { class: "jo-oacts" });
        if (mayOpen) acts.append(el("a", { class: "hs-btn hs-btn-primary", href: "/stone.html?id=" + encodeURIComponent(o.id), "aria-label": "Open stone order: " + orderName(o), text: "Open" }));
        acts.append(el("a", { class: "hs-btn", href: printHref(o), "aria-label": "Print stone order: " + orderName(o), text: "Print" }));
        tb.append(el("tr", { class: "jo-actrow" }, el("td", { colspan: String(heads.length) }, acts)));
      }
      const table = el("table", { class: "hs-table jo-table jo-orders jt-table" },
        el("thead", {}, el("tr", {}, ...heads.map((h) => el("th", { text: h })))), tb);
      nodes.push(el("div", { class: "jo-wrap" }, table));
    }
    body.replaceChildren(...nodes);

    const btns = [];
    if (can("jobs.edit") && can("design.view") && data.job && !data.job.archived) {
      btns.push(el("a", { class: "hs-btn hs-btn-primary", href: "/stone.html?job=" + encodeURIComponent(jobId), text: "New stone order" }));
    }
    btns.push(el("a", { class: "hs-btn", href: "/stoneprint.html?sheet=" + encodeURIComponent(jobId), text: "Print benchtop sheet" }));
    tools.replaceChildren(...btns);
  }

  async function load() {
    const mine = ++seq;
    try {
      const d = await api("/api/job-records/" + encodeURIComponent(jobId) + "/stone");
      if (mine !== seq) return;
      data = d;
      setLine("", "muted");
    } catch (e) {
      if (mine !== seq) return;
      setLine(e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message, "err");
    }
    render();
  }

  // ctx: {jobId, can}. Resolves once the section is drawn (or its sentence shown).
  function start(ctx) {
    jobId = ctx.jobId;
    can = ctx.can;
    const sec = $("benchtops");
    if (!sec || jobId == null) return Promise.resolve();
    sec.hidden = false;
    $("jtShowCancelled").addEventListener("click", (ev) => {
      showCancelled = !showCancelled;
      const b = ev.currentTarget;
      b.setAttribute("aria-pressed", showCancelled ? "true" : "false");
      b.classList.toggle("hs-btn-quiet", !showCancelled);
      b.classList.toggle("hs-btn-primary", showCancelled);
      render();
    });
    return load();
  }

  function refresh() {
    if (jobId == null || $("benchtops").hidden) return Promise.resolve();
    return load();
  }

  window.JobStone = { start, refresh };
})();
