// Stock value (/stockvalue.html, accounts.view): the board stock value each month, newest first,
// read-only and printable (docs/plans/m11-contracts.md sections 8 and 11.5). A month appears once
// its board count is finished; its value shows once Ordering confirms it. Talks to
// GET /api/stockvalue (routes/boards.js). Money is integer cents, shown through Periods.
(function () {
  "use strict";

  const P = window.Periods;
  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

  function sydneyDate(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (isNaN(d)) return "";
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }
  const fmtStamp = (iso) => fmtDate(sydneyDate(iso));

  function setStatus(text, kind) {
    const s = $("svStatus");
    s.textContent = text || "";
    s.className = "sv-status" + (kind ? " sv-status-" + kind : "");
  }

  // "Wes Workshop, 3 Oct 2026"
  function who(x) {
    if (!x) return null;
    return el("span", null,
      el("span", { class: "sv-who", text: x.by && x.by.name ? x.by.name : "" }),
      el("span", { class: "sv-when", text: fmtStamp(x.at) }));
  }

  function td(label, cls, ...kids) {
    return el("td", { class: cls, "data-label": label }, ...kids);
  }

  function adjustmentCell(m) {
    const cell = td("Adjustment", "sv-c-adj");
    if (m.status !== "valued") return cell; // not final until the value is confirmed
    if (!m.adjustmentCents) {
      cell.append(el("span", { class: "sv-none", text: "None" }));
      return cell;
    }
    const amt = el("span", { class: "sv-num", text: P.dollars(m.adjustmentCents) });
    if (m.adjustmentNote) {
      amt.title = m.adjustmentNote;
      cell.append(amt,
        el("span", { class: "sv-sr", text: ". " + m.adjustmentNote }),
        el("span", { class: "sv-adj-note", "aria-hidden": "true", text: m.adjustmentNote }));
    } else {
      cell.append(amt);
    }
    return cell;
  }

  function render(months) {
    $("svPrintDate").textContent = `Printed ${fmtDate(sydneyDate())}`;
    $("svWrap").hidden = !months.length;
    $("svEmpty").hidden = months.length > 0;
    $("svRows").replaceChildren(...months.map((m) => {
      const valued = m.status === "valued";
      return el("tr", { class: valued ? null : "sv-waiting" },
        el("th", { scope: "row", class: "sv-c-month", text: P.longLabel(m.period) }),
        td("Value", "sv-c-value", valued
          ? el("span", { class: "sv-num sv-value", text: P.dollars(m.valueCents) })
          : el("span", { class: "sv-wait", text: "Waiting for the value" })),
        td("Counted", "sv-c-who", who(m.counted)),
        td("Confirmed", "sv-c-who", who(m.valued)),
        adjustmentCell(m));
    }));
  }

  async function load() {
    try {
      const r = await api("/api/stockvalue");
      setStatus("", "");
      render(r.months || []);
    } catch (e) {
      setStatus(e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message, "err");
    }
  }

  let titleBefore = null;
  window.addEventListener("beforeprint", () => {
    if (titleBefore == null) titleBefore = document.title;
    $("svPrintDate").textContent = `Printed ${fmtDate(sydneyDate())}`;
    document.title = `Board stock value ${fmtDate(sydneyDate())}`;
  });
  window.addEventListener("afterprint", () => {
    if (titleBefore != null) document.title = titleBefore;
    titleBefore = null;
  });
  $("svPrint").addEventListener("click", () => window.print());

  (async () => {
    const ready = window.cc && window.cc.ready ? window.cc.ready : Promise.resolve();
    await ready;
    await load();
  })();
})();
