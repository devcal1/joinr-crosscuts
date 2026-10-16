// Loans (/loans.html; docs/plans/m13-contracts.md sections 6 and 10.5). Talks to /api/loans
// (routes/loans.js); every rule lives in lib/loans.js, and the page only hides what a user can't use
// (cc.can()). The page is gated by loans.manage (lib/pages.js), an owner-only key the owner can grant
// to an Accounts login.
//
//   /loans.html             the list: current loans, or the archived ones (#archived)
//   /loans.html?id=N        one loan: its details, rate history, repayments and statement
//
// The balance is never typed: it is the server's (opening balance less every principal). Interest
// on a new repayment is prefilled from GET /api/loans/:id/interest as the date changes, and can be
// changed to match a statement; only a typed figure is sent (left out, the server works it out for
// the date it saves). A typed figure that differs from the worked-out one shows the worked-out
// figure beside it. An archived loan is read-only here except Restore and the statement. A refusal
// marks the input it is about (aria-invalid) and focuses it; after a dialog, focus goes to the
// heading, by the status line.
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

  let loan = null; // the loan on screen (?id=)

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

  // ========================================================================= the list ===

  function showArchived() {
    return location.hash === "#archived";
  }

  async function loadList() {
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
    const fy = loans.length && loans[0].fy ? loans[0].fy.label : "";
    $("lnFyHead").textContent = fy ? "Interest FY " + fy : "This FY interest";
    $("lnEmpty").hidden = loans.length > 0;
    $("lnEmpty").textContent = loans.length ? "" : archived ? "No archived loans." : "No loans yet. Add one with New loan.";
    $("lnListWrap").hidden = !loans.length;
    $("lnRows").replaceChildren(...loans.map((l) => el("tr", { class: l.archived ? "ln-row-off" : null },
      el("td", { class: "ln-c-name", "data-label": "Name" },
        el("a", { class: "ln-link", href: "/loans.html?id=" + encodeURIComponent(l.id), text: l.name })),
      el("td", { class: "ln-c-dir", "data-label": "Direction", text: DIRECTION_LABEL[l.direction] || l.direction }),
      el("td", { class: l.otherParty ? "ln-c-party" : "ln-c-party ln-blank", "data-label": "Other party", text: l.otherParty || "" }),
      el("td", { class: "ln-c-money ln-strong", "data-label": "Balance", text: money(l.balanceCents) }),
      el("td", { class: "ln-c-rate", "data-label": "Rate now", text: l.rateBp == null ? "No rate" : pct(l.rateBp) }),
      el("td", { class: "ln-c-date", "data-label": "Last paid", text: l.lastPaidDate ? fmtDate(l.lastPaidDate) : "None yet" }),
      el("td", { class: "ln-c-money", "data-label": fy ? "Interest FY " + fy : "This FY interest", text: money(l.fy ? l.fy.interestCents : 0) }))));
    setStatus("");
    $("lnList").hidden = false;
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
        el("dd", { text: money(l.fy ? l.fy.principalCents : 0) + " principal, " + money(l.fy ? l.fy.interestCents : 0) + " interest" })));

    const parts = [];
    if (ro) parts.push(el("p", { class: "ln-archived", text: "This loan is archived, so it can't be changed. Restore it to change it; its statement still prints." }));
    parts.push(summary);
    parts.push(detailsCard(l, ro));
    parts.push(ratesCard(l, ro));
    parts.push(repaymentsCard(l, ro));
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

  // --- the repayments ---
  function repaymentsCard(l, ro) {
    const reps = l.repayments || [];
    const head = el("div", { class: "ln-cardtools" });
    if (!ro) head.append(headButton("Add repayment", "hs-btn-primary", () => repaymentDialog(null)));
    let body;
    if (!reps.length) {
      body = el("p", { class: "ln-empty-in", text: "No repayments yet." });
    } else {
      body = el("div", { class: "ln-wrap" },
        el("table", { class: "ln-table ln-table-reps" },
          el("thead", null, el("tr", null,
            el("th", { scope: "col", class: "ln-c-date", text: "Date" }),
            el("th", { scope: "col", class: "ln-c-ref", text: "Reference" }),
            el("th", { scope: "col", class: "ln-c-money", text: "Principal" }),
            el("th", { scope: "col", class: "ln-c-money ln-c-int", text: "Interest" }),
            el("th", { scope: "col", class: "ln-c-money", text: "Total" }),
            el("th", { scope: "col", class: "ln-c-money", text: "Balance after" }),
            el("th", { scope: "col", class: "ln-c-act" }, el("span", { class: "ln-sr", text: "Actions" })))),
          el("tbody", null, ...reps.map((r) => {
            const interest = el("td", { class: "ln-c-money ln-c-int", "data-label": "Interest" }, el("span", { text: money(r.interestCents) }));
            if (r.workedOutInterestCents != null && r.workedOutInterestCents !== r.interestCents) {
              interest.append(el("span", { class: "ln-worked", text: "worked out " + money(r.workedOutInterestCents) }));
            }
            const ref = el("td", { class: r.reference || r.note ? "ln-c-ref" : "ln-c-ref ln-blank", "data-label": "Reference" });
            if (r.reference) ref.append(el("span", { text: r.reference }));
            if (r.note) ref.append(el("span", { class: "ln-sub", text: r.note }));
            const acts = el("div", { class: "ln-rowacts" });
            if (!ro) {
              const e = headButton("Edit", null, () => repaymentDialog(r));
              e.setAttribute("aria-label", "Edit the repayment of " + fmtDate(r.paidDate));
              const d = headButton("Delete", "hs-btn-stop", () => deleteRepaymentDialog(r));
              d.setAttribute("aria-label", "Delete the repayment of " + fmtDate(r.paidDate));
              acts.append(e, d);
            }
            return el("tr", null,
              el("td", { class: "ln-c-date", "data-label": "Date", text: fmtDate(r.paidDate) }),
              ref,
              el("td", { class: "ln-c-money", "data-label": "Principal", text: money(r.principalCents) }),
              interest,
              el("td", { class: "ln-c-money", "data-label": "Total", text: money(r.totalCents) }),
              el("td", { class: "ln-c-money ln-strong", "data-label": "Balance after", text: money(r.balanceAfterCents) }),
              el("td", { class: ro ? "ln-c-act ln-blank" : "ln-c-act" }, acts));
          }))));
    }
    const c = card("Repayments", "lnRepsH", body);
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

  function repaymentDialog(rep) {
    const U = ui();
    const today = todayISO();
    const editing = !!rep;
    const date = U.dateInput(editing ? rep.paidDate : today, loan.openingDate, today);
    const principal = moneyInput(editing ? rep.principalCents : null);
    const interest = moneyInput(editing ? rep.interestCents : null);
    const ref = U.textInput(editing ? rep.reference : "", 100);
    const note = U.textArea(editing ? rep.note : "", 500, 2);
    const hint = el("span", { class: "ou-field-hint ln-int-hint", "aria-live": "polite" });
    const use = el("button", { class: "hs-btn hs-btn-quiet ln-use", type: "button", hidden: true });
    const interestBox = U.field("Interest", interest);
    interestBox.append(hint, use);
    hint.id = "ln-int-hint-" + Math.random().toString(36).slice(2, 8);
    interest.setAttribute("aria-describedby", hint.id);

    // Where the interest comes from (B-M2): "auto" follows the worked-out figure for the date (a new
    // repayment, or after Use); "typed" is what the user typed; "stored" is an edit's saved figure,
    // kept until the user types or picks the worked-out one. Only a typed figure is sent on a new
    // repayment: left out, the server works the interest out for the date it saves, so a figure
    // still showing an earlier date's suggestion (the suggestion waits 250 ms) can't be stored.
    let mode = editing ? "stored" : "auto";
    let suggested = null;
    let seq = 0;
    let timer = null;

    const syncUse = () => {
      const now = parseMoney(interest.value);
      const show = suggested != null && now !== suggested;
      use.hidden = !show;
      if (show) use.textContent = "Use " + money(suggested);
    };
    interest.addEventListener("input", () => { mode = "typed"; syncUse(); });
    use.addEventListener("click", () => {
      if (suggested == null) return;
      mode = "auto";
      interest.value = plainMoney(suggested);
      syncUse();
      interest.focus();
    });

    async function suggest() {
      const d = date.value;
      const mine = ++seq;
      if (!d) {
        hint.textContent = "";
        suggested = null;
        syncUse();
        return;
      }
      let s;
      try {
        s = await api("/api/loans/" + loan.id + "/interest?date=" + encodeURIComponent(d) + (editing ? "&repaymentId=" + encodeURIComponent(rep.id) : ""));
      } catch (e) {
        if (mine !== seq) return;
        hint.textContent = failText(e);
        suggested = null;
        syncUse();
        return;
      }
      if (mine !== seq || !s) return;
      if (s.rateBp == null) {
        suggested = null;
        hint.textContent = "No rate covers " + fmtDate(d) + ": type the interest or add a rate.";
      } else if (s.alreadyCharged) {
        suggested = 0;
        hint.textContent = "Interest already charged this month (" + fmtDayMon(s.alreadyCharged.date) + ").";
      } else {
        suggested = s.interestCents;
        hint.textContent = "Worked out: balance " + money(s.balanceCents) + " × " + pct(s.rateBp) + " ÷ 12 = " + money(s.interestCents) + ".";
      }
      if (mode === "auto") interest.value = suggested == null ? "" : plainMoney(suggested);
      syncUse();
    }
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(suggest, 250);
    };
    date.addEventListener("input", later);
    date.addEventListener("change", later);
    suggest();

    return U.dialog({
      title: editing ? "Edit the repayment of " + fmtDate(rep.paidDate) : "Add a repayment",
      note: editing ? null : "The balance goes down by the principal. Interest is paid as it falls due and doesn't change the balance.",
      wide: true,
      fields: [
        U.field("Date paid", date),
        U.field("Principal", principal, { hint: "In dollars, like 2,000.00." }),
        interestBox,
        U.field("Reference", ref, { hint: "A MYOB or bank reference." }),
        U.field("Note", note, { wide: true }),
      ],
      submit: editing ? "Save" : "Add repayment",
      focus: date,
      run: async () => {
        clearTimeout(timer);
        if (!date.value) throw U.fail("The paid date must be a date", date);
        const p = parseMoney(principal.value);
        if (Number.isNaN(p)) throw U.fail("Type the principal in dollars, like 2,000.00", principal);
        if (mode === "typed" && Number.isNaN(parseMoney(interest.value))) throw U.fail("Type the interest in dollars, like 600.00", interest);
        // An edit following the worked-out figure takes it for the date as it is now, not one
        // still waiting on the 250 ms suggestion.
        if (editing && mode === "auto") await suggest();
        const i = parseMoney(interest.value);
        const body = {};
        if (!editing) {
          body.paidDate = date.value;
          if (p !== null) body.principalCents = p;
          // Only a typed figure is sent; left out, the server works it out for this date.
          if (mode === "typed" && i !== null) body.interestCents = i;
          if (ref.value.trim()) body.reference = ref.value;
          if (note.value.trim()) body.note = note.value;
        } else {
          if (date.value !== rep.paidDate) body.paidDate = date.value;
          const pv = p === null ? 0 : p;
          if (pv !== rep.principalCents) body.principalCents = pv;
          // Left out, an edit keeps the stored interest (contracts section 12.1 D).
          const iv = mode === "typed" ? i : mode === "auto" ? suggested : null;
          if (iv != null && !Number.isNaN(iv) && iv !== rep.interestCents) body.interestCents = iv;
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
          else if (/^The interest|type the interest/i.test(m)) err.field = interest;
          else if (/^The principal|balance below zero|^Enter the principal/i.test(m)) err.field = principal;
          else if (/^Reference/i.test(m)) err.field = ref;
          else if (/^Note/i.test(m)) err.field = note;
          throw err;
        }
      },
    }).then((r) => after(r, editing ? "Repayment saved." : "Repayment added."));
  }

  function deleteRepaymentDialog(rep) {
    return ui().dialog({
      title: "Delete the repayment of " + fmtDate(rep.paidDate) + "?",
      note: `Principal ${money(rep.principalCents)}, interest ${money(rep.interestCents)}${rep.reference ? ", reference " + rep.reference : ""}. Later balances go up by the principal.`,
      submit: "Delete repayment",
      submitClass: "hs-btn-stop",
      focus: "cancel",
      run: async () => {
        try {
          return await send("/api/loans/" + loan.id + "/repayments/" + rep.id, "DELETE");
        } catch (e) {
          throw refusal(e);
        }
      },
    }).then((r) => after(r, "Repayment deleted."));
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
      $("lnHeadActions").replaceChildren(headButton("New loan", "hs-btn-primary", newLoanDialog));
      window.addEventListener("hashchange", loadList);
      loadList();
    }
  })();
})();
