// The loan statement print (/loanprint.html; docs/plans/m13-contracts.md sections 8.2 and 10.6).
// Gated by loans.manage (lib/pages.js).
//
//   ?id=N&from=YYYY-MM-DD&to=YYYY-MM-DD    GET /api/loans/:id/statement?from=&to=
//
// Whole months from the month of from to the month of to (default: the opening date, today). The sheet: "Loan
// statement", the loan's name, its direction in words and the other party, the period; the balance
// at the start, the month table (Month, Paid, Reference, Principal, Interest, Total, New balance; a
// month with no payment shows its interest only), the totals paid, the interest charged, the
// balance at the end, and the rates in force ("6.00% from 1 Jan 2025"). A4 portrait, black on
// white, no letterhead (loanprint.css); a long statement runs on to further pages with the table
// header repeated. On screen the sheet sits on a white paper box with Print and Back; no access or
// no such loan gives a sentence instead. document.title names the sheet, so a saved PDF is named
// after it. Every value goes in through textContent. Classes are lp-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DIRECTION_LABEL = {
    lent_to_business: "Lent to the business",
    lent_by_business: "Lent by the business",
  };
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

  function money(cents) {
    if (cents == null || !Number.isFinite(cents)) return "";
    const neg = cents < 0;
    const c = Math.abs(Math.round(cents));
    const whole = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-$" : "$") + whole + "." + String(c % 100).padStart(2, "0");
  }

  function periodWords(p) {
    const m = /^(\d{4})-(\d{2})$/.exec(p || "");
    return m ? MONTHS[Number(m[2]) - 1] + " " + m[1] : "";
  }

  function pct(bp) {
    return bp == null ? "" : (bp / 100).toFixed(2) + "%";
  }

  function refuse(msg) {
    const sheet = $("lpSheet");
    sheet.classList.add("lp-sheet-error");
    sheet.replaceChildren(el("p", { class: "lp-error", text: msg }));
    $("lpPrint").disabled = true;
    document.title = "Loan statement - Crosscuts";
  }

  function failText(e) {
    if (e instanceof TypeError) return "Couldn't reach the server. Reload to try again.";
    const m = (e && e.message) || "";
    if (/not found/i.test(m)) return "There is no such loan.";
    if (/forbidden|permission|access|not allowed/i.test(m)) return "You don't have access to loan statements.";
    return m || "That didn't load. Reload to try again.";
  }

  function balanceLine(label, cents, cls) {
    return el("p", { class: "lp-balline" + (cls ? " " + cls : "") },
      el("span", { class: "lp-label", text: label }),
      el("span", { class: "lp-balval", text: money(cents) }));
  }

  function sheet(s) {
    const loan = s.loan || {};
    const out = [];
    out.push(el("div", { class: "lp-titlerow" },
      el("div", { class: "lp-titlebox" },
        el("h1", { class: "lp-h1", text: "Loan statement" }),
        el("p", { class: "lp-name", text: loan.name || "" })),
      el("dl", { class: "lp-meta" },
        el("dt", { text: "Period" }), el("dd", { text: periodWords(s.fromPeriod) + " to " + periodWords(s.toPeriod) }),
        el("dt", { text: "Direction" }), el("dd", { text: DIRECTION_LABEL[loan.direction] || loan.direction || "" }),
        el("dt", { text: "Other party" }), el("dd", { text: loan.otherParty || "Not given" }),
        el("dt", { text: "Opened" }), el("dd", { text: fmtDate(loan.openingDate) }))));

    out.push(balanceLine("Balance at the start of " + periodWords(s.fromPeriod), s.balanceAtStartCents, "lp-start"));

    const rows = s.rows || [];
    const dash = "—";
    const t = s.totals || {};
    const table = el("table", { class: "lp-table" },
      el("thead", null, el("tr", null,
        el("th", { scope: "col", class: "lp-c-date", text: "Month" }),
        el("th", { scope: "col", class: "lp-c-date", text: "Paid" }),
        el("th", { scope: "col", class: "lp-c-ref", text: "Reference" }),
        el("th", { scope: "col", class: "lp-c-num", text: "Principal" }),
        el("th", { scope: "col", class: "lp-c-num", text: "Interest" }),
        el("th", { scope: "col", class: "lp-c-num", text: "Total" }),
        el("th", { scope: "col", class: "lp-c-num", text: "New balance" }))),
      el("tbody", null,
        ...(rows.length ? rows.map((r) => el("tr", { class: r.first ? "lp-first" : null },
          el("td", { class: "lp-c-date", text: r.first ? r.label : "" }),
          el("td", { class: "lp-c-date", text: r.paidDate ? fmtDate(r.paidDate) : dash }),
          el("td", { class: "lp-c-ref", text: r.reference || "" }),
          el("td", { class: "lp-c-num", text: r.principalCents == null ? dash : money(r.principalCents) }),
          el("td", { class: "lp-c-num", text: money(r.interestCents) }),
          el("td", { class: "lp-c-num", text: r.totalCents == null ? dash : money(r.totalCents) }),
          el("td", { class: "lp-c-num", text: money(r.balanceAfterCents) })))
          : [el("tr", null, el("td", { class: "lp-none", colspan: "7", text: "No months in this period." }))]),
        el("tr", { class: "lp-total" },
          el("th", { scope: "row", class: "lp-c-date", colspan: "3", text: "Totals paid" }),
          el("td", { class: "lp-c-num", text: money(t.principalCents || 0) }),
          el("td", { class: "lp-c-num", text: money(t.interestCents || 0) }),
          el("td", { class: "lp-c-num", text: money(t.totalCents || 0) }),
          el("td", { class: "lp-c-num" }))));
    out.push(table);

    out.push(balanceLine("Interest charged in the period", t.interestChargedCents || 0, "lp-end"));
    out.push(balanceLine("Balance at the end of " + periodWords(s.toPeriod), s.balanceAtEndCents, "lp-end"));

    const rates = s.rates || [];
    out.push(el("section", { class: "lp-rates" },
      el("h2", { class: "lp-blockh", text: "Rates in force" }),
      rates.length
        ? el("ul", { class: "lp-ratelist" }, ...rates.map((r) => el("li", { text: pct(r.rateBp) + " from " + fmtDate(r.fromDate) })))
        : el("p", { text: "No rate was in force in this period." })));
    out.push(el("p", { class: "lp-foot", text: "Interest is charged once a month on the balance at the start of the month (the rate in force on the 1st, a twelfth of the annual rate) and added to the balance. Each payment comes off the balance in full: interest first, the rest principal." }));
    return out;
  }

  $("lpPrint").addEventListener("click", () => window.print());

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    const q = new URLSearchParams(location.search);
    const id = q.get("id") || "";
    if (!/^[1-9]\d*$/.test(id)) {
      refuse("Nothing to print. Open a loan and print its statement from there.");
      return;
    }
    const back = $("lpBack");
    back.href = "/loans.html?id=" + encodeURIComponent(id);
    back.textContent = "Back to the loan";
    const params = new URLSearchParams();
    for (const k of ["from", "to"]) {
      const v = q.get(k);
      if (v && DATE_RE.test(v)) params.set(k, v);
      else if (v) {
        refuse("from and to must be dates");
        return;
      }
    }
    let s;
    try {
      s = await api("/api/loans/" + encodeURIComponent(id) + "/statement" + (params.toString() ? "?" + params.toString() : ""));
    } catch (e) {
      refuse(failText(e));
      return;
    }
    if (!s) return;
    const title = "Loan statement " + ((s.loan && s.loan.name) || "") + " " + periodWords(s.fromPeriod) + " to " + periodWords(s.toPeriod);
    const box = $("lpSheet");
    box.classList.remove("lp-sheet-error");
    box.setAttribute("aria-label", title);
    box.replaceChildren(...sheet(s));
    document.title = title;
    $("lpPrint").disabled = false;
  })();
})();
