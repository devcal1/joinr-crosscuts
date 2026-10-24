// Loans (/loans.html; docs/plans/m13-contracts.md sections 6 and 10.5, changed 2026-10-24 by Todd).
// Talks to /api/loans (routes/loans.js); every rule lives in lib/loans.js, and the page only hides
// what a user can't use (cc.can()). The page is gated by loans.manage (lib/pages.js), an owner-only
// key the owner can grant to an Accounts login.
//
//   /loans.html             every loan side by side (archived ones with #archived): balance, rate,
//                           plan, Add payment / Rate / Plan / Details / Statement, the month table
//   /loans.html?id=N        one loan: its details, rate history, months (edit and delete payments,
//                           a month's interest), archive/restore and the statement
//
// The balance is never typed: it is the server's (opening balance + each month's interest - every
// payment). A payment is typed as its total; the split (interest first, the rest principal) is
// shown live from GET /api/loans/:id/interest and may be typed to match a lender statement.
// Money is shown as $1,234.56 and typed as dollars; rates are percents to two places (basis points
// on the wire). Every value goes in as text. The dialogs are built on OrderUI's frame
// (orderui.js). Page classes are ln-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DIRECTIONS = [
    ["lent_to_business", "Lent to the business"],
    ["lent_by_business", "Lent by the business"],
  ];
  const DIRECTION_LABEL = Object.fromEntries(DIRECTIONS);
  const MONEY_RE = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{0,2}))?$/;
  const PCT_RE = /^(\d{1,3})(?:\.(\d{0,2}))?\s*%?$/;

  let loan = null; // the loan on screen (?id=), or the column a dialog was opened from
  let listMode = false; // the side-by-side list (no ?id=)

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

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

  function ui() {
    return window.OrderUI.ui;
  }

  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  function fmtDayMon(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : "";
  }

  // 123456 -> "$1,234.56"; negative with a leading minus.
  function money(cents) {
    if (cents == null || !Number.isFinite(cents)) return "";
    const neg = cents < 0;
    const c = Math.abs(Math.round(cents));
    const whole = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-$" : "$") + whole + "." + String(c % 100).padStart(2, "0");
  }

  // 123456 -> "1234.56", for an input.
  function plainMoney(cents) {
    if (cents == null) return "";
    return Math.floor(cents / 100) + "." + String(cents % 100).padStart(2, "0");
  }

  // "$1,234.5" -> 123450; "" -> null; anything else -> NaN. String maths, so no float rounding.
  function parseMoney(s) {
    const t = String(s == null ? "" : s).trim();
    if (!t) return null;
    const m = MONEY_RE.exec(t);
    if (!m || (m[1] === undefined && (m[2] === undefined || m[2] === ""))) return NaN;
    const whole = m[1] ? Number(m[1].replace(/,/g, "")) : 0;
    const frac = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
    const v = whole * 100 + frac;
    return Number.isSafeInteger(v) ? v : NaN;
  }

  // 650 -> "6.50%"
  function pct(bp) {
    if (bp == null) return "";
    return (bp / 100).toFixed(2) + "%";
  }

  // "6.5" or "6.50%" -> 650; "" -> null; anything else -> NaN.
  function parsePct(s) {
    const t = String(s == null ? "" : s).trim();
    if (!t) return null;
    const m = PCT_RE.exec(t);
    if (!m) return NaN;
    return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
  }

  function setStatus(text, kind) {
    const s = $("lnStatus");
    s.textContent = text || "";
    s.className = "ln-status" + (kind ? " ln-status-" + kind : "");
  }

  function failText(e) {
    return e instanceof TypeError ? "Couldn't reach the server. Try again." : (e && e.message) || "That didn't work. Try again.";
  }

  function refusal(e) {
    const err = new Error(failText(e));
    if (!(e instanceof TypeError)) err.refused = true;
    return err;
  }

  function send(path, method, body) {
    return api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  function noAccessText(e) {
    const m = (e && e.message) || "";
    if (/forbidden|access|permission/i.test(m)) return "You don't have access to Loans.";
    if (/not found/i.test(m)) return "There is no such loan.";
    return failText(e);
  }

  // An input a refusal is about, on the page's own form: marked invalid until changed, and focused.
  function markInput(n) {
    n.setAttribute("aria-invalid", "true");
    const off = () => {
      n.removeAttribute("aria-invalid");
      n.removeEventListener("input", off);
      n.removeEventListener("change", off);
    };
    n.addEventListener("input", off);
    n.addEventListener("change", off);
    n.focus();
  }

  function moneyInput(cents) {
    const n = el("input", { class: "hs-input ln-money-in", type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false" });
    n.value = cents == null ? "" : plainMoney(cents);
    return n;
  }

  // "2026-10" -> "Oct 2026"
  function periodWords(p) {
    const m = /^(\d{4})-(\d{2})$/.exec(p || "");
    return m ? MONTHS[Number(m[2]) - 1] + " " + m[1] : "";
  }

  // "2026-10-14" -> "14/10" (the spreadsheet's Paid column)
  function fmtPaid(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? m[3] + "/" + m[2] : "";
  }

  // The plan in a line, and whether it needs an orange warning.
  function planLine(l) {
    const p = l.plan;
    if (l.balanceCents <= 0) return { text: "Paid off", warn: "" };
    if (!p) return { text: "No plan", warn: "" };
    const off = p.paidOffPeriod ? "paid off about " + periodWords(p.paidOffPeriod) : "not paid off within 10 years";
    const text = p.kind === "payoff"
      ? "Plan: paid off by " + periodWords(p.payoffPeriod) + " · " + money(p.paymentCents) + " a month"
      : "Plan: " + money(p.amountCents) + " a month · " + off;
    return { text, warn: p.coversInterest ? "" : "This doesn't cover the interest; the balance grows." };
  }

  // ========================================================================= the list ===

  function showArchived() {
    return location.hash === "#archived";
  }

  let loansById = new Map();

  // The loans side by side: each a column with its balance, plan and month table.
  async function loadList(opts) {
    const archived = showArchived();
    $("lnArchived").checked = archived;
    let r;
    try {
      r = await api("/api/loans" + (archived ? "?archived=1" : ""));
    } catch (e) {
      setStatus(noAccessText(e), "err");
      return;
    }
    if (!r) return;
    const loans = r.loans || [];
    loansById = new Map(loans.map((l) => [l.id, l]));
    $("lnEmpty").hidden = loans.length > 0;
    $("lnEmpty").textContent = loans.length ? "" : archived ? "No archived loans." : "No loans yet. Add one with New loan.";
    $("lnCols").replaceChildren(...loans.map(loanColumn));
    if (!opts || !opts.keepStatus) setStatus("");
    $("lnList").hidden = false;
  }

  function loanColumn(l) {
    const ro = l.archived;
    const hid = "lnColH" + l.id;
    const pl = planLine(l);
    const acts = el("div", { class: "ln-colacts" });
    const open = (fn) => () => { loan = l; fn(); };
    if (!ro) {
      acts.append(
        headButton("Add payment", "hs-btn-primary", open(() => paymentDialog(null))),
        headButton("Rate", null, open(() => rateDialog(null))),
        headButton("Plan", null, open(planDialog)));
    }
    acts.append(
      el("a", { class: "hs-btn", href: "/loans.html?id=" + encodeURIComponent(l.id), text: "Details" }),
      el("a", { class: "hs-btn", href: "/loanprint.html?id=" + encodeURIComponent(l.id), text: "Statement" }));
    for (const b of acts.children) b.setAttribute("aria-describedby", hid);
    return el("section", { class: "ln-col" + (ro ? " ln-col-off" : ""), "aria-labelledby": hid },
      el("div", { class: "ln-colhead" },
        el("h2", { class: "ln-colname", id: hid },
          el("a", { class: "ln-link", href: "/loans.html?id=" + encodeURIComponent(l.id), text: l.name })),
        el("div", { class: "ln-fig" }, el("span", { class: "hs-label", text: "Balance" }), el("span", { class: "ln-figv ln-figbig", text: money(l.balanceCents) })),
        el("div", { class: "ln-fig" }, el("span", { class: "hs-label", text: "Rate" }), el("span", { class: "ln-figv", text: l.rateBp == null ? "None" : pct(l.rateBp) }))),
      el("p", { class: "ln-plan" }, pl.text),
      pl.warn ? el("p", { class: "ln-warn", text: pl.warn }) : null,
      ro ? el("p", { class: "ln-sub", text: "Archived. Open Details to restore it." }) : null,
      acts,
      monthTable(l, { planLimit: 12 }));
  }

  // The input of a loan's details a server sentence is about (section 12.3, B-m6), or null.
  function detailsField(m, f) {
    if (/^Name/i.test(m)) return f.name;
    if (/^Direction/i.test(m)) return f.dir;
    if (/^Other party/i.test(m)) return f.party;
    if (/opening balance/i.test(m)) return f.opening;
    if (/opening date|A repayment is dated before/i.test(m)) return f.openingDate;
    if (/^Note/i.test(m)) return f.note;
    return null;
  }

  function newLoanDialog() {
    const U = ui();
    const today = todayISO();
    const name = U.textInput("", 100);
    const dir = el("select", { class: "hs-input" }, ...DIRECTIONS.map(([v, l]) => el("option", { value: v, text: l })));
    const party = U.textInput("", 200);
    const opening = moneyInput(null);
    const openingDate = U.dateInput(today, null, today);
    const note = U.textArea("", 1000, 3);
    return U.dialog({
      title: "New loan",
      wide: true,
      fields: [
        U.field("Name", name, { wide: true }),
        U.field("Direction", dir),
        U.field("Other party", party),
        U.field("Opening balance", opening, { hint: "The balance on the opening date, in dollars." }),
        U.field("Opening date", openingDate),
        U.field("Note", note, { wide: true }),
      ],
      submit: "Add loan",
      focus: name,
      run: async () => {
        if (!name.value.trim()) throw U.fail("Name is required", name);
        const cents = parseMoney(opening.value);
        if (cents === null || Number.isNaN(cents)) throw U.fail("Type the opening balance in dollars, like 1,234.56", opening);
        if (!openingDate.value) throw U.fail("The opening date must be a date", openingDate);
        try {
          return await send("/api/loans", "POST", {
            name: name.value, direction: dir.value, otherParty: party.value,
            openingBalanceCents: cents, openingDate: openingDate.value, note: note.value,
          });
        } catch (e) {
          const err = refusal(e);
          err.field = detailsField(err.message, { name, dir, party, opening, openingDate, note });
          throw err;
        }
      },
    }).then((r) => {
      if (r && r.id) location.href = "/loans.html?id=" + encodeURIComponent(r.id);
    });
  }

  // ========================================================================= one loan ===

  function card(title, id, ...kids) {
    return el("section", { class: "ln-card", "aria-labelledby": id },
      el("div", { class: "ln-cardhead" }, el("h2", { class: "ln-h2", id, text: title })), ...kids);
  }

  function headButton(text, cls, onClick) {
    const b = el("button", { class: "hs-btn" + (cls ? " " + cls : ""), type: "button", text });
    b.addEventListener("click", onClick);
    return b;
  }

  function renderLoan(l, opts) {
    loan = l;
    const ro = l.archived;
    document.title = "Loan " + l.name + " - Crosscuts";
    $("lnTitle").textContent = l.name;

    const acts = $("lnHeadActions");
    acts.replaceChildren(
      el("a", { class: "hs-btn hs-btn-quiet", href: "/loans.html", text: "All loans" }),
      ro ? headButton("Restore", "hs-btn-primary", restoreLoan) : headButton("Archive", null, archiveDialog));

    const sec = $("lnLoan");
    const keep = sec.querySelector("#lnStmtFrom") ? { from: $("lnStmtFrom").value, to: $("lnStmtTo").value } : null;

    // --- the summary: the balance in large type ---
    const summary = el("div", { class: "ln-summary" },
      el("div", { class: "ln-balance" },
        el("span", { class: "hs-label", text: "Balance" }),
        el("span", { class: "ln-big", text: money(l.balanceCents) })),
      el("dl", { class: "ln-facts" },
        el("dt", { text: "Direction" }), el("dd", { text: DIRECTION_LABEL[l.direction] || l.direction }),
        el("dt", { text: "Other party" }), el("dd", { text: l.otherParty || "Not given" }),
        el("dt", { text: "Rate now" }), el("dd", { text: l.rateBp == null ? "No rate" : pct(l.rateBp) }),
        el("dt", { text: "Opened" }), el("dd", { text: fmtDate(l.openingDate) + " at " + money(l.openingBalanceCents) }),
        el("dt", { text: "FY " + (l.fy ? l.fy.label : "") }),
        el("dd", { text: money(l.fy ? l.fy.principalCents : 0) + " principal, " + money(l.fy ? l.fy.interestCents : 0) + " interest charged" })));

    const parts = [];
    if (ro) parts.push(el("p", { class: "ln-archived", text: "This loan is archived, so it can't be changed. Restore it to change it; its statement still prints." }));
    parts.push(summary);
    parts.push(detailsCard(l, ro));
    parts.push(ratesCard(l, ro));
    parts.push(monthsCard(l, ro));
    parts.push(statementCard(l, keep));
    sec.replaceChildren(...parts);
    sec.hidden = false;
    if (!opts || !opts.keepStatus) setStatus("");
  }

  // --- the details form ---
  function detailsCard(l, ro) {
    const U = ui();
    const today = todayISO();
    const name = U.textInput(l.name, 100);
    const dir = el("select", { class: "hs-input" }, ...DIRECTIONS.map(([v, t]) => el("option", { value: v, text: t })));
    dir.value = l.direction;
    const party = U.textInput(l.otherParty, 200);
    const opening = moneyInput(l.openingBalanceCents);
    const openingDate = U.dateInput(l.openingDate, null, today);
    const note = U.textArea(l.note, 1000, 3);
    const msg = el("p", { class: "ln-msg", role: "status", "aria-live": "polite" });
    const save = el("button", { class: "hs-btn hs-btn-primary", type: "submit", text: "Save" });
    const fields = [
      U.field("Name", name),
      U.field("Direction", dir),
      U.field("Other party", party),
      U.field("Opening balance", opening),
      U.field("Opening date", openingDate),
      U.field("Note", note, { wide: true }),
    ];
    for (const n of [name, dir, party, opening, openingDate, note]) n.disabled = ro;
    const form = el("form", { class: "ln-form", novalidate: true },
      el("div", { class: "ln-grid" }, ...fields),
      ro ? null : el("div", { class: "ln-actions" }, save),
      msg);
    const inputs = { name, dir, party, opening, openingDate, note };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg.className = "ln-msg";
      msg.textContent = "";
      for (const n of Object.values(inputs)) n.removeAttribute("aria-invalid");
      const body = {};
      if (name.value.trim() !== l.name) body.name = name.value;
      if (dir.value !== l.direction) body.direction = dir.value;
      if (party.value.trim() !== (l.otherParty || "")) body.otherParty = party.value;
      const cents = parseMoney(opening.value);
      if (cents === null || Number.isNaN(cents)) {
        msg.className = "ln-msg ln-msg-err";
        msg.textContent = "Type the opening balance in dollars, like 1,234.56";
        markInput(opening);
        return;
      }
      if (cents !== l.openingBalanceCents) body.openingBalanceCents = cents;
      if (openingDate.value !== l.openingDate) body.openingDate = openingDate.value;
      if (note.value.trim() !== (l.note || "")) body.note = note.value;
      if (!Object.keys(body).length) {
        msg.textContent = "Nothing to save.";
        return;
      }
      save.disabled = true;
      try {
        const r = await send("/api/loans/" + l.id, "PATCH", body);
        renderLoan(r);
        setStatus("Details saved.", "ok");
        $("lnTitle").focus(); // the form was drawn again, so focus goes to the heading, by the status
      } catch (ex) {
        save.disabled = false;
        msg.className = "ln-msg ln-msg-err";
        msg.textContent = failText(ex);
        const n = ex instanceof TypeError ? null : detailsField(msg.textContent, inputs);
        if (n) markInput(n);
      }
    });
    return card("Details", "lnDetailsH", form);
  }

  // --- the rate history ---
  function ratesCard(l, ro) {
    const rates = l.rates || [];
    const head = el("div", { class: "ln-cardtools" });
    if (!ro) {
      const add = headButton("Add rate", "hs-btn-primary", () => rateDialog(null));
      head.append(add);
    }
    let body;
    if (!rates.length) {
      body = el("p", { class: "ln-empty-in", text: "No rates yet. Interest can't be worked out without one." });
    } else {
      body = el("div", { class: "ln-wrap" },
        el("table", { class: "ln-table ln-table-rates" },
          el("thead", null, el("tr", null,
            el("th", { scope: "col", class: "ln-c-date", text: "From" }),
            el("th", { scope: "col", class: "ln-c-rate", text: "Rate" }),
            el("th", { scope: "col", class: "ln-c-note", text: "Note" }),
            el("th", { scope: "col", class: "ln-c-act" }, el("span", { class: "ln-sr", text: "Actions" })))),
          el("tbody", null, ...rates.map((r) => {
            const acts = el("div", { class: "ln-rowacts" });
            if (!ro) {
              const e = headButton("Edit", null, () => rateDialog(r));
              e.setAttribute("aria-label", "Edit the rate from " + fmtDate(r.fromDate));
              const d = headButton("Delete", "hs-btn-stop", () => deleteRateDialog(r));
              d.setAttribute("aria-label", "Delete the rate from " + fmtDate(r.fromDate));
              acts.append(e, d);
            }
            return el("tr", null,
              el("td", { class: "ln-c-date", "data-label": "From", text: fmtDate(r.fromDate) }),
              el("td", { class: "ln-c-rate ln-strong", "data-label": "Rate", text: pct(r.rateBp) }),
              el("td", { class: r.note ? "ln-c-note" : "ln-c-note ln-blank", "data-label": "Note", text: r.note || "" }),
              el("td", { class: ro ? "ln-c-act ln-blank" : "ln-c-act" }, acts));
          }))));
    }
    const c = card("Rates", "lnRatesH", body);
    c.querySelector(".ln-cardhead").append(head);
    return c;
  }

  // --- the month table (Todd's spreadsheet): Month | Principal | Interest | Total | Paid | New
  // balance; a line per payment, the month on its first line; a month with no payment shows its
  // interest only; this month in teal; the plan after it in grey, PLANNED. opts.edit adds the
  // Edit/Delete and month Interest buttons (the loan page); opts.planLimit shows only the first N
  // planned months with a button for the rest.
  function monthTable(l, opts) {
    const o = opts || {};
    const edit = !!o.edit && !l.archived;
    const head = ["Month", "Principal", "Interest", "Total", "Paid", "New balance"];
    const cls = ["ln-c-month", "ln-c-num", "ln-c-num", "ln-c-num", "ln-c-paid", "ln-c-num"];
    const ths = head.map((h, i) => el("th", { scope: "col", class: cls[i], text: h }));
    if (edit) ths.push(el("th", { scope: "col", class: "ln-c-act" }, el("span", { class: "ln-sr", text: "Actions" })));
    const body = el("tbody");
    const dash = "—";
    const months = l.months || [];

    function monthCell(m, first) {
      const td = el("td", { class: "ln-c-month" });
      if (!first) return td;
      td.append(el("span", { class: "ln-mlabel", text: m.label }));
      if (m.current) td.append(el("span", { class: "ln-tag ln-tag-now", text: "This month" }));
      if (o.edit) {
        const what = !m.charged ? "No interest (opened this month)" : (m.interestOverridden ? "Charged " + money(m.interestCents) + ", typed" : "Charged " + money(m.interestCents));
        td.append(el("span", { class: "ln-msub", text: what }));
      }
      return td;
    }
    function actCell(m, r, first) {
      if (!edit) return null;
      const box = el("div", { class: "ln-rowacts" });
      if (first && m.charged) {
        const b = headButton("Interest", null, () => monthInterestDialog(m));
        b.setAttribute("aria-label", "The interest charged in " + periodWords(m.period));
        box.append(b);
      }
      if (r) {
        const e = headButton("Edit", null, () => paymentDialog(r));
        e.setAttribute("aria-label", "Edit the payment of " + fmtDate(r.paidDate));
        const d = headButton("Delete", "hs-btn-stop", () => deletePaymentDialog(r));
        d.setAttribute("aria-label", "Delete the payment of " + fmtDate(r.paidDate));
        box.append(e, d);
      }
      return el("td", { class: "ln-c-act" }, box);
    }

    for (const m of months) {
      const rowCls = m.current ? "ln-now" : null;
      if (!m.payments.length) {
        body.append(el("tr", { class: rowCls },
          monthCell(m, true),
          el("td", { class: "ln-c-num ln-dim", text: dash }),
          el("td", { class: "ln-c-num", text: m.charged ? money(m.interestCents) : dash }),
          el("td", { class: "ln-c-num ln-dim", text: dash }),
          el("td", { class: "ln-c-paid ln-dim", text: dash }),
          el("td", { class: "ln-c-num ln-strong", text: money(m.endBalanceCents) }),
          actCell(m, null, true)));
        continue;
      }
      m.payments.forEach((r, i) => {
        const int = el("td", { class: "ln-c-num" }, money(r.interestCents));
        if (r.interestOverride) int.append(el("span", { class: "ln-msub", text: "typed" }));
        const paid = el("td", { class: "ln-c-paid", title: fmtDate(r.paidDate) + (r.reference ? ", " + r.reference : "") }, fmtPaid(r.paidDate));
        body.append(el("tr", { class: rowCls },
          monthCell(m, i === 0),
          el("td", { class: "ln-c-num", text: money(r.principalCents) }),
          int,
          el("td", { class: "ln-c-num", text: money(r.totalCents) }),
          paid,
          el("td", { class: "ln-c-num ln-strong", text: money(r.balanceAfterCents) }),
          actCell(m, r, i === 0)));
      });
    }

    const plan = l.plan && !l.archived ? l.plan.rows || [] : [];
    const planRows = plan.map((r, i) => {
      const curMonth = months.length && months[months.length - 1].period === r.period;
      const mc = el("td", { class: "ln-c-month" });
      if (!curMonth) mc.append(el("span", { class: "ln-mlabel", text: r.label }));
      mc.append(el("span", { class: "ln-tag ln-tag-plan", text: "Planned" }));
      const tr = el("tr", { class: "ln-plan-row" + (o.planLimit && i >= o.planLimit ? " ln-plan-more" : "") },
        mc,
        el("td", { class: "ln-c-num", text: money(r.principalCents) }),
        el("td", { class: "ln-c-num", text: money(r.interestCents) }),
        el("td", { class: "ln-c-num", text: money(r.totalCents) }),
        el("td", { class: "ln-c-paid", text: dash }),
        el("td", { class: "ln-c-num", text: money(r.balanceAfterCents) }),
        edit ? el("td", { class: "ln-c-act" }) : null);
      if (o.planLimit && i >= o.planLimit) tr.hidden = true;
      return tr;
    });
    body.append(...planRows);

    const wrap = el("div", { class: "ln-mwrap" },
      el("table", { class: "ln-mtable" + (edit ? " ln-mtable-edit" : "") },
        el("thead", null, el("tr", null, ...ths)), body));
    if (!months.length) return el("p", { class: "ln-empty-in", text: "No months yet." });
    const extra = o.planLimit ? plan.length - o.planLimit : 0;
    if (extra <= 0) return wrap;
    const more = el("button", { class: "hs-btn hs-btn-quiet ln-more", type: "button", "aria-expanded": "false", text: "Show " + extra + " more planned months" });
    more.addEventListener("click", () => {
      const open = more.getAttribute("aria-expanded") !== "true";
      for (const tr of body.querySelectorAll(".ln-plan-more")) tr.hidden = !open;
      more.setAttribute("aria-expanded", open ? "true" : "false");
      more.textContent = open ? "Show fewer planned months" : "Show " + extra + " more planned months";
    });
    return el("div", null, wrap, more);
  }

  // --- the loan page's months card ---
  function monthsCard(l, ro) {
    const head = el("div", { class: "ln-cardtools" });
    if (!ro) {
      head.append(
        headButton("Add payment", "hs-btn-primary", () => paymentDialog(null)),
        headButton("Plan", null, planDialog));
    }
    const pl = planLine(l);
    const c = card("Months", "lnMonthsH",
      el("p", { class: "ln-plan" }, pl.text),
      pl.warn ? el("p", { class: "ln-warn", text: pl.warn }) : null,
      monthTable(l, { edit: true }));
    c.querySelector(".ln-cardhead").append(head);
    return c;
  }

  // --- the statement ---
  function statementCard(l, keep) {
    const U = ui();
    const today = todayISO();
    const from = U.dateInput(keep ? keep.from : l.openingDate, null, null);
    from.id = "lnStmtFrom";
    const to = U.dateInput(keep ? keep.to : today, null, null);
    to.id = "lnStmtTo";
    const link = el("a", { class: "hs-btn hs-btn-primary", text: "Print statement" });
    const msg = el("p", { class: "ln-msg ln-msg-err", role: "status", "aria-live": "polite" });
    const sync = () => {
      const f = from.value;
      const t = to.value;
      let problem = "";
      if (!f || !t) problem = "Give both dates.";
      else if (t < f) problem = "The statement can't end before it starts.";
      msg.textContent = problem;
      link.href = "/loanprint.html?id=" + encodeURIComponent(l.id) + "&from=" + encodeURIComponent(f) + "&to=" + encodeURIComponent(t);
      if (problem) link.setAttribute("aria-disabled", "true");
      else link.removeAttribute("aria-disabled");
    };
    link.addEventListener("click", (e) => {
      if (link.getAttribute("aria-disabled") === "true") e.preventDefault();
    });
    from.addEventListener("input", sync);
    to.addEventListener("input", sync);
    sync();
    const fl = el("label", { class: "ln-field" }, el("span", { class: "hs-label", text: "From" }), from);
    const tl = el("label", { class: "ln-field" }, el("span", { class: "hs-label", text: "To" }), to);
    return card("Statement", "lnStmtH",
      el("div", { class: "ln-stmt" }, fl, tl, el("div", { class: "ln-stmt-go" }, link)), msg);
  }

  // ========================================================================= dialogs ===

  function rateDialog(rate) {
    const U = ui();
    const from = U.dateInput(rate ? rate.fromDate : todayISO(), null, null);
    const value = el("input", { class: "hs-input ln-pct-in", type: "text", inputmode: "decimal", autocomplete: "off" });
    value.value = rate ? (rate.rateBp / 100).toFixed(2) : "";
    const note = U.textArea(rate ? rate.note : "", 500, 2);
    return U.dialog({
      title: rate ? "Edit the rate from " + fmtDate(rate.fromDate) : "Add a rate",
      note: "The annual rate in force from this date, until a later rate starts.",
      fields: [
        U.field("From", from),
        U.field("Annual rate (%)", value, { hint: "For example 6.50 for 6.50%." }),
        U.field("Note", note),
      ],
      submit: rate ? "Save" : "Add rate",
      focus: rate ? value : from,
      run: async () => {
        if (!from.value) throw U.fail("The from date must be a date", from);
        const bp = parsePct(value.value);
        if (bp === null || Number.isNaN(bp)) throw U.fail("Type the rate as a percent, like 6.50", value);
        const body = {};
        if (!rate) Object.assign(body, { fromDate: from.value, rateBp: bp, note: note.value });
        else {
          if (from.value !== rate.fromDate) body.fromDate = from.value;
          if (bp !== rate.rateBp) body.rateBp = bp;
          if (note.value.trim() !== (rate.note || "")) body.note = note.value;
          if (!Object.keys(body).length) return undefined;
        }
        try {
          return rate
            ? await send("/api/loans/" + loan.id + "/rates/" + rate.id, "PATCH", body)
            : await send("/api/loans/" + loan.id + "/rates", "POST", body);
        } catch (e) {
          const err = refusal(e);
          if (/from date|already a rate from/i.test(err.message)) err.field = from;
          else if (/^The rate/i.test(err.message)) err.field = value;
          else if (/^Note/i.test(err.message)) err.field = note;
          throw err;
        }
      },
    }).then((r) => after(r, rate ? "Rate saved." : "Rate added."));
  }

  function deleteRateDialog(rate) {
    return ui().dialog({
      title: "Delete the rate from " + fmtDate(rate.fromDate) + "?",
      note: `${pct(rate.rateBp)} from ${fmtDate(rate.fromDate)}. Repayments already recorded keep their interest; only the worked-out figures change.`,
      submit: "Delete rate",
      submitClass: "hs-btn-stop",
      focus: "cancel",
      run: async () => {
        try {
          return await send("/api/loans/" + loan.id + "/rates/" + rate.id, "DELETE");
        } catch (e) {
          throw refusal(e);
        }
      },
    }).then((r) => after(r, "Rate deleted."));
  }

  // Add or edit a payment: the date and the TOTAL paid. The split is shown as it will be worked
  // out (interest part = the month's interest still unpaid, the rest principal); the interest part
  // may be typed to match a lender statement (left empty, it is worked out).
  function paymentDialog(rep) {
    const U = ui();
    const today = todayISO();
    const editing = !!rep;
    const date = U.dateInput(editing ? rep.paidDate : today, loan.openingDate, today);
    const total = moneyInput(editing ? rep.totalCents : null);
    const interest = moneyInput(editing && rep.interestOverride ? rep.interestCents : null);
    interest.setAttribute("placeholder", "Worked out");
    const ref = U.textInput(editing ? rep.reference : "", 100);
    const note = U.textArea(editing ? rep.note : "", 500, 2);
    const split = el("p", { class: "ln-split ou-wide", "aria-live": "polite" });
    const hint = el("span", { class: "ou-field-hint ln-int-hint", "aria-live": "polite" });
    const interestBox = U.field("Interest part (optional)", interest);
    interestBox.append(hint);
    hint.id = "ln-int-hint-" + Math.random().toString(36).slice(2, 8);
    interest.setAttribute("aria-describedby", hint.id);

    let info = null; // the answer of GET /interest for the date
    let seq = 0;
    let timer = null;

    function draw() {
      const t = parseMoney(total.value);
      const typed = parseMoney(interest.value);
      if (!info) {
        split.textContent = "";
        return;
      }
      if (!info.charged) hint.textContent = "No interest is charged in the opening month.";
      else if (info.rateBp == null && !info.monthInterestCents) hint.textContent = "No rate covers the 1st of this month, so no interest is worked out.";
      else hint.textContent = "This month's interest " + money(info.monthInterestCents)
        + (info.paidBeforeCents ? ", " + money(info.paidBeforeCents) + " already paid" : "")
        + ": " + money(info.outstandingCents) + " still to pay. Type a figure only to match a lender statement.";
      if (t === null || Number.isNaN(t) || t <= 0) {
        split.textContent = "Type the total paid to see the split.";
        split.className = "ln-split ou-wide";
        return;
      }
      let i = Math.min(t, info.outstandingCents);
      let how = "worked out";
      if (typed !== null && !Number.isNaN(typed)) {
        i = typed;
        how = "typed";
      }
      if (i > t) {
        split.textContent = "The interest part can't be more than the total paid.";
        split.className = "ln-split ou-wide ln-warn";
        return;
      }
      split.className = "ln-split ou-wide";
      split.textContent = "Interest " + money(i) + " (" + how + ") · Principal " + money(t - i)
        + " · Balance after about " + money(info.balanceCents - t);
    }

    async function fetchInfo() {
      const d = date.value;
      const mine = ++seq;
      if (!d) {
        info = null;
        draw();
        return;
      }
      let s;
      try {
        s = await api("/api/loans/" + loan.id + "/interest?date=" + encodeURIComponent(d) + (editing ? "&repaymentId=" + encodeURIComponent(rep.id) : ""));
      } catch (e) {
        if (mine !== seq) return;
        info = null;
        split.textContent = failText(e);
        return;
      }
      if (mine !== seq || !s) return;
      info = s;
      draw();
    }
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(fetchInfo, 250);
    };
    date.addEventListener("input", later);
    date.addEventListener("change", later);
    total.addEventListener("input", draw);
    interest.addEventListener("input", draw);
    fetchInfo();

    return U.dialog({
      title: editing ? "Edit the payment of " + fmtDate(rep.paidDate) : "Add a payment",
      note: "The balance goes down by the total paid. Crosscuts splits it: interest first (this month's, once), the rest principal.",
      wide: true,
      fields: [
        U.field("Date paid", date),
        U.field("Total paid", total, { hint: "In dollars, like 1,500.00." }),
        split,
        interestBox,
        U.field("Reference", ref, { hint: "A MYOB or bank reference." }),
        U.field("Note", note, { wide: true }),
      ],
      submit: editing ? "Save" : "Add payment",
      focus: editing ? total : date,
      run: async () => {
        clearTimeout(timer);
        if (!date.value) throw U.fail("The paid date must be a date", date);
        const t = parseMoney(total.value);
        if (t === null || Number.isNaN(t) || t <= 0) throw U.fail("Type the total paid in dollars, like 1,500.00", total);
        const i = parseMoney(interest.value);
        if (Number.isNaN(i)) throw U.fail("Type the interest part in dollars, like 595.13, or leave it empty", interest);
        if (i !== null && i > t) throw U.fail("The interest part can't be more than the total paid", interest);
        const body = {};
        if (!editing) {
          body.paidDate = date.value;
          body.totalCents = t;
          if (i !== null) body.interestCents = i;
          if (ref.value.trim()) body.reference = ref.value;
          if (note.value.trim()) body.note = note.value;
        } else {
          if (date.value !== rep.paidDate) body.paidDate = date.value;
          if (t !== rep.totalCents) body.totalCents = t;
          const was = rep.interestOverride ? rep.interestCents : null;
          if (i !== was) body.interestCents = i;
          if (ref.value.trim() !== (rep.reference || "")) body.reference = ref.value;
          if (note.value.trim() !== (rep.note || "")) body.note = note.value;
          if (!Object.keys(body).length) return undefined;
        }
        try {
          return editing
            ? await send("/api/loans/" + loan.id + "/repayments/" + rep.id, "PATCH", body)
            : await send("/api/loans/" + loan.id + "/repayments", "POST", body);
        } catch (e) {
          const err = refusal(e);
          const m = err.message;
          if (/paid date|before the opening date/i.test(m)) err.field = date;
          else if (/interest part/i.test(m)) err.field = interest;
          else if (/total paid|balance below zero/i.test(m)) err.field = total;
          else if (/^Reference/i.test(m)) err.field = ref;
          else if (/^Note/i.test(m)) err.field = note;
          throw err;
        }
      },
    }).then((r) => after(r, editing ? "Payment saved." : "Payment added."));
  }

  function deletePaymentDialog(rep) {
    return ui().dialog({
      title: "Delete the payment of " + fmtDate(rep.paidDate) + "?",
      note: `Total ${money(rep.totalCents)} (principal ${money(rep.principalCents)}, interest ${money(rep.interestCents)})${rep.reference ? ", reference " + rep.reference : ""}. Later balances go up by the total.`,
      submit: "Delete payment",
      submitClass: "hs-btn-stop",
      focus: "cancel",
      run: async () => {
        try {
          return await send("/api/loans/" + loan.id + "/repayments/" + rep.id, "DELETE");
        } catch (e) {
          throw refusal(e);
        }
      },
    }).then((r) => after(r, "Payment deleted."));
  }

  // A month's charged interest, typed to match a lender statement; empty goes back to worked out.
  function monthInterestDialog(m) {
    const U = ui();
    const value = moneyInput(m.interestOverridden ? m.interestCents : null);
    value.setAttribute("placeholder", m.workedOutInterestCents == null ? "" : plainMoney(m.workedOutInterestCents));
    const note = U.textInput(m.overrideNote || "", 500);
    const worked = m.workedOutInterestCents == null
      ? "No rate covers the 1st of the month, so nothing is worked out."
      : "Worked out: balance " + money(m.startBalanceCents) + " × " + pct(m.rateBp) + " ÷ 12 = " + money(m.workedOutInterestCents) + ".";
    return U.dialog({
      title: "Interest for " + periodWords(m.period),
      note: "Charged once for the month and added to the balance. " + worked,
      fields: [
        U.field("Interest charged", value, { hint: "Leave empty to use the worked-out figure. Type one only to match a lender statement." }),
        U.field("Note", note),
      ],
      submit: "Save",
      focus: value,
      run: async () => {
        const v = parseMoney(value.value);
        if (Number.isNaN(v)) throw U.fail("Type the interest in dollars, like 595.13, or leave it empty", value);
        if (v === null && !m.interestOverridden) return undefined;
        try {
          return await send("/api/loans/" + loan.id + "/months/" + m.period, "PUT", { interestCents: v, note: note.value });
        } catch (e) {
          const err = refusal(e);
          if (/^Note/i.test(err.message)) err.field = note;
          else err.field = value;
          throw err;
        }
      },
    }).then((r) => after(r, "Interest for " + periodWords(m.period) + " saved."));
  }

  // The plan: a fixed amount a month, or paid off by a month; the result previewed as typed.
  function planDialog() {
    const U = ui();
    const p = loan.plan;
    const name = "lnPlanKind" + Math.random().toString(36).slice(2, 8);
    const kinds = [["", "No plan"], ["amount", "A fixed amount a month"], ["payoff", "Paid off by a month"]];
    const radios = kinds.map(([v, t]) => {
      const r = el("input", { type: "radio", name, value: v });
      r.checked = (p ? p.kind : "") === v;
      return { r, label: el("label", { class: "ln-check" }, r, el("span", { text: t })) };
    });
    const group = el("div", { class: "ln-radios ou-wide", role: "radiogroup", "aria-label": "Plan" }, ...radios.map((x) => x.label));
    const amount = moneyInput(p && p.kind === "amount" ? p.amountCents : null);
    const cur = todayISO().slice(0, 7);
    const [cy, cm] = cur.split("-").map(Number);
    const next = cm === 12 ? `${cy + 1}-01` : `${cy}-${String(cm + 1).padStart(2, "0")}`;
    const payoff = el("input", { class: "hs-input", type: "month", min: next, placeholder: "YYYY-MM" });
    payoff.value = p && p.kind === "payoff" ? p.payoffPeriod : "";
    const amountBox = U.field("Amount a month", amount, { hint: "In dollars, like 1,500.00." });
    const payoffBox = U.field("Paid off by", payoff, { hint: "The month of the last payment." });
    const preview = el("p", { class: "ln-split ou-wide", "aria-live": "polite" });
    const kind = () => (radios.find((x) => x.r.checked) || radios[0]).r.value;
    let seq = 0;
    let timer = null;

    async function show() {
      const k = kind();
      amountBox.hidden = k !== "amount";
      payoffBox.hidden = k !== "payoff";
      preview.className = "ln-split ou-wide";
      if (!k) {
        preview.textContent = "No future months are shown.";
        return;
      }
      const q = new URLSearchParams({ kind: k });
      if (k === "amount") {
        const a = parseMoney(amount.value);
        if (a === null || Number.isNaN(a) || a <= 0) {
          preview.textContent = "Type the amount to see when it's paid off.";
          return;
        }
        q.set("amountCents", String(a));
      } else {
        if (!/^\d{4}-\d{2}$/.test(payoff.value)) {
          preview.textContent = "Pick the month to see the payment.";
          return;
        }
        q.set("payoffPeriod", payoff.value);
      }
      const mine = ++seq;
      let r;
      try {
        r = await api("/api/loans/" + loan.id + "/plan?" + q.toString());
      } catch (e) {
        if (mine === seq) preview.textContent = failText(e);
        return;
      }
      if (mine !== seq || !r || !r.plan) return;
      const pl = planLine({ balanceCents: loan.balanceCents, plan: r.plan });
      preview.textContent = (k === "payoff" ? money(r.plan.paymentCents) + " a month, starting " + periodWords(r.plan.startPeriod) + ". " : "Starting " + periodWords(r.plan.startPeriod) + ". ") + pl.text.replace(/^Plan: /, "") + ".";
      if (pl.warn) {
        preview.textContent += " " + pl.warn;
        preview.className = "ln-split ou-wide ln-warn";
      }
    }
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(show, 250);
    };
    for (const x of radios) x.r.addEventListener("change", show);
    amount.addEventListener("input", later);
    payoff.addEventListener("input", later);
    payoff.addEventListener("change", later);
    show();

    return U.dialog({
      title: "Plan for " + loan.name,
      note: "Lays out the months ahead, from this month when nothing has been paid yet this month, otherwise from next month (up to 10 years).",
      wide: true,
      fields: [group, amountBox, payoffBox, preview],
      submit: "Save plan",
      focus: radios.find((x) => x.r.checked) ? radios.find((x) => x.r.checked).r : radios[0].r,
      run: async () => {
        clearTimeout(timer);
        const k = kind();
        const body = { kind: k || null };
        if (k === "amount") {
          const a = parseMoney(amount.value);
          if (a === null || Number.isNaN(a) || a <= 0) throw U.fail("Type the amount a month in dollars, like 1,500.00", amount);
          body.amountCents = a;
        } else if (k === "payoff") {
          if (!/^\d{4}-\d{2}$/.test(payoff.value)) throw U.fail("Pick the month it is paid off by", payoff);
          body.payoffPeriod = payoff.value;
        }
        try {
          return await send("/api/loans/" + loan.id + "/plan", "PUT", body);
        } catch (e) {
          const err = refusal(e);
          if (/amount/i.test(err.message)) err.field = amount;
          else if (/payoff month/i.test(err.message)) err.field = payoff;
          throw err;
        }
      },
    }).then((r) => after(r, "Plan saved."));
  }

  function archiveDialog() {
    return ui().dialog({
      title: "Archive " + loan.name + "?",
      note: "An archived loan takes no new rates or repayments and leaves the list. Its statement still prints, and Restore brings it back.",
      submit: "Archive",
      focus: "cancel",
      run: async () => {
        try {
          return await send("/api/loans/" + loan.id, "PATCH", { archived: true });
        } catch (e) {
          throw refusal(e);
        }
      },
    }).then((r) => after(r, "Loan archived."));
  }

  async function restoreLoan(e) {
    const btn = e && e.currentTarget;
    if (btn) btn.disabled = true;
    try {
      const r = await send("/api/loans/" + loan.id, "PATCH", { archived: false });
      renderLoan(r, { keepStatus: true });
      setStatus("Loan restored.", "ok");
      $("lnTitle").focus();
    } catch (ex) {
      if (btn) btn.disabled = false;
      setStatus(failText(ex), "err");
    }
  }

  // After a dialog: the answer is the loan as saved; a refusal the user closed reloads the loan
  // (someone else may have changed it); a cancel does nothing.
  async function after(r, okText) {
    if (r === null) return;
    if (listMode) {
      if (r && (r.refused || r.id)) {
        await loadList({ keepStatus: true });
        setStatus(r.refused ? "The loans were reloaded as they are now." : loan.name + ": " + okText, r.refused ? null : "ok");
      }
      $("lnTitle").focus();
      return;
    }
    if (r && r.refused) {
      await loadLoan(loan.id, { keepStatus: true });
      setStatus("The loan was reloaded as it is now.");
    } else if (r && r.id) {
      renderLoan(r, { keepStatus: true });
      setStatus(okText, "ok");
    }
    $("lnTitle").focus();
  }

  async function loadLoan(id, opts) {
    let l;
    try {
      l = await api("/api/loans/" + encodeURIComponent(id));
    } catch (e) {
      setStatus(noAccessText(e), "err");
      return;
    }
    if (l) renderLoan(l, opts);
  }

  // ========================================================================= start ===

  $("lnArchived").addEventListener("change", () => {
    history.replaceState(null, "", location.pathname + location.search + ($("lnArchived").checked ? "#archived" : ""));
    loadList();
  });

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    if (!can("loans.manage")) {
      setStatus("You don't have access to Loans.", "err");
      return;
    }
    const q = new URLSearchParams(location.search);
    if (q.has("id")) {
      const id = q.get("id");
      if (!/^[1-9]\d*$/.test(id || "")) {
        setStatus("There is no such loan.", "err");
        return;
      }
      loadLoan(id);
    } else {
      listMode = true;
      $("lnHeadActions").replaceChildren(headButton("New loan", "hs-btn-primary", newLoanDialog));
      window.addEventListener("hashchange", () => loadList());
      loadList();
    }
  })();
})();
