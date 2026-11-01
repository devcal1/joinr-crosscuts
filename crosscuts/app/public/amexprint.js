// The AMEX statement print (/amexprint.html). Gated by loans.manage or loans.maintain (lib/pages.js).
//
//   ?range=year|12m|all     GET /api/amex?range=
//
// The sheet: "AMEX statement", the period, the opening balance when the list is filtered, every
// charge and repayment in date order with the running balance, and the amount owing now. A4
// portrait, black on white (amexprint.css). On screen the sheet sits on a white paper box with
// Print and Back; no access gives a sentence instead. document.title names the sheet, so a saved
// PDF is named after it. Every value goes in through textContent. Classes are xp-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const RANGE_WORDS = { year: "This year", "12m": "Last 12 months", all: "Everything" };

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

  function money(cents) {
    if (cents == null || !Number.isFinite(cents)) return "";
    const neg = cents < 0;
    const c = Math.abs(Math.round(cents));
    const whole = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-$" : "$") + whole + "." + String(c % 100).padStart(2, "0");
  }

  function refuse(msg) {
    const sheet = $("xpSheet");
    sheet.classList.add("xp-sheet-error");
    sheet.replaceChildren(el("p", { class: "xp-error", text: msg }));
    $("xpPrint").disabled = true;
    document.title = "AMEX statement - Crosscuts";
  }

  function failText(e) {
    if (e instanceof TypeError) return "Couldn't reach the server. Reload to try again.";
    const m = (e && e.message) || "";
    if (/forbidden|permission|access|not allowed/i.test(m)) return "You don't have access to the AMEX statement.";
    return m || "That didn't load. Reload to try again.";
  }

  function covers(r) {
    if (!r.coversCount) return "Covers no transactions";
    const n = r.coversCount === 1 ? "1 transaction" : r.coversCount + " transactions";
    return "Covers " + n + ", " + (r.coversFrom === r.coversTo ? fmtDayMon(r.coversFrom) : fmtDayMon(r.coversFrom) + " – " + fmtDayMon(r.coversTo));
  }

  function row(date, sup, note, chg, rep, bal, cls) {
    return el("tr", { class: cls || null },
      el("td", { class: "xp-c-date", text: date }),
      el("td", { class: "xp-c-sup", text: sup }),
      el("td", { text: note }),
      el("td", { class: "xp-c-num xp-c-chg", text: chg }),
      el("td", { class: "xp-c-num", text: rep }),
      el("td", { class: "xp-c-num", text: bal }));
  }

  function sheet(d) {
    const out = [];
    out.push(el("div", { class: "xp-titlerow" },
      el("div", null,
        el("h1", { class: "xp-h1", text: "AMEX statement" }),
        el("p", { class: "xp-sub", text: RANGE_WORDS[d.range] || d.range })),
      el("dl", { class: "xp-meta" },
        el("dt", { text: "From" }), el("dd", { text: d.from ? fmtDate(d.from) : "The first charge" }),
        el("dt", { text: "To" }), el("dd", { text: fmtDate(d.today) }),
        el("dt", { text: "Owing now" }), el("dd", { text: money(d.owingCents) }))));

    const body = [];
    if (d.openingCents != null) body.push(row(fmtDate(d.from), "Opening balance", "", "", "", money(d.openingCents), null));
    for (const e of d.statement) {
      if (e.kind === "charge") body.push(row(fmtDate(e.date), e.supplier, e.note, money(e.amountCents), "", money(e.balanceCents), e.paid ? "xp-paidrow" : null));
      else body.push(row(fmtDate(e.date), "REPAYMENT", covers(e) + (e.note ? ". " + e.note : ""), "", money(e.amountCents), money(e.balanceCents), "xp-reprow"));
    }
    if (!d.statement.length) body.push(el("tr", null, el("td", { colspan: "6", text: "Nothing in this period." })));
    body.push(el("tr", { class: "xp-total" },
      el("th", { scope: "row", colspan: "5", text: "Owing now" }),
      el("td", { class: "xp-c-num", text: money(d.owingCents) })));

    out.push(el("table", { class: "xp-table" },
      el("thead", null, el("tr", null,
        el("th", { scope: "col", class: "xp-c-date", text: "Date" }),
        el("th", { scope: "col", class: "xp-c-sup", text: "Supplier" }),
        el("th", { scope: "col", text: "Note" }),
        el("th", { scope: "col", class: "xp-c-num", text: "Charge" }),
        el("th", { scope: "col", class: "xp-c-num", text: "Repaid" }),
        el("th", { scope: "col", class: "xp-c-num", text: "Balance" }))),
      el("tbody", null, ...body)));
    out.push(el("p", { class: "xp-foot", text: "A charge with its amount struck through has been paid back by a repayment. The balance is the charges so far less the repayments so far." }));
    return out;
  }

  $("xpPrint").addEventListener("click", () => window.print());

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    const q = new URLSearchParams(location.search);
    const range = RANGE_WORDS[q.get("range")] ? q.get("range") : "year";
    let d;
    try {
      d = await api("/api/amex?range=" + encodeURIComponent(range));
    } catch (e) {
      refuse(failText(e));
      return;
    }
    if (!d) return;
    const title = "AMEX statement " + (RANGE_WORDS[d.range] || "") + " to " + fmtDate(d.today);
    const box = $("xpSheet");
    box.classList.remove("xp-sheet-error");
    box.setAttribute("aria-label", title);
    box.replaceChildren(...sheet(d));
    document.title = title;
    $("xpPrint").disabled = false;
  })();
})();
