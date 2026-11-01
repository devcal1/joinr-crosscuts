// AMEX (/amex.html; 0.2.12). The company card statement: charges and repayments in date order with
// a running balance (worked out by the server, GET /api/amex), the three figures, and the dialogs
// to add or change a charge and to record or delete a repayment. Every rule lives in lib/amex.js;
// the page only hides what a user can't use. Gated by loans.manage or loans.maintain.
// Money is shown as $1,234.56 and typed as dollars. Every value goes in as text. The dialogs are
// built on OrderUI's frame (orderui.js). Page classes are ax-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONEY_RE = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{0,2}))?$/;

  let data = null; // the last answer of GET /api/amex
  let range = "year";

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

  // "2026-10-28" -> "Wed 28 Oct" (and the year when it is not this year)
  function fmtRow(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return "";
    const dow = DAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
    const yr = m[1] === todayISO().slice(0, 4) ? "" : " " + m[1];
    return `${dow} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${yr}`;
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

  function setStatus(text, kind) {
    const s = $("axStatus");
    s.textContent = text || "";
    s.className = "ax-status" + (kind ? " ax-status-" + kind : "");
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

  function moneyInput(cents) {
    const n = el("input", { class: "hs-input", type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false" });
    n.value = cents == null ? "" : plainMoney(cents);
    return n;
  }

  function headButton(label, cls, onClick) {
    const b = el("button", { class: "hs-btn" + (cls ? " " + cls : ""), type: "button", text: label });
    b.addEventListener("click", onClick);
    return b;
  }

  // ========================================================================= the statement ===

  function cell(cls, text) {
    return el("td", { class: cls || null, text: text || "" });
  }

  function clickable(tr, label, fn) {
    tr.classList.add("ax-row-click");
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", label);
    tr.addEventListener("click", fn);
    tr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        fn();
      }
    });
  }

  function chargeRow(t, balance) {
    const tr = el("tr", { class: t.paid ? "ax-paid" : null },
      cell(null, fmtRow(t.date)),
      el("td", { class: "ax-sup", text: t.supplier }),
      el("td", { class: "ax-note", text: t.note }),
      cell("ax-c-num", money(t.amountCents)),
      cell("ax-c-num", ""),
      cell("ax-c-bal", money(balance)));
    clickable(tr, "Change the " + t.supplier + " charge of " + money(t.amountCents), () => transactionDialog(t));
    return tr;
  }

  function coversText(r) {
    if (!r.coversCount) return "Covers no transactions";
    const n = r.coversCount === 1 ? "1 transaction" : r.coversCount + " transactions";
    const span = r.coversFrom === r.coversTo ? fmtDayMon(r.coversFrom) : fmtDayMon(r.coversFrom) + " – " + fmtDayMon(r.coversTo);
    return "Covers " + n + ", " + span + (r.note ? ". " + r.note : "");
  }

  function repaymentRow(r, balance) {
    const tr = el("tr", { class: "ax-rep" },
      cell(null, fmtRow(r.date)),
      el("td", null, el("span", { class: "ax-tag", text: "Repayment" })),
      el("td", { class: "ax-note", text: coversText(r) }),
      cell("ax-c-num", ""),
      cell("ax-c-num ax-repaid", money(r.amountCents)),
      cell("ax-c-bal", money(balance)));
    clickable(tr, "See the repayment of " + money(r.amountCents), () => repaymentDialog(r));
    return tr;
  }

  function render(d) {
    data = d;
    $("axOwing").textContent = money(d.owingCents);
    $("axCharged").textContent = money(d.chargedYearCents);
    $("axRepaid").textContent = money(d.repaidYearCents);
    const rows = [];
    if (d.openingCents != null) {
      rows.push(el("tr", { class: "ax-open" },
        cell(null, d.from ? fmtDate(d.from) : ""),
        el("td", { class: "ax-sup", text: "Opening balance" }),
        cell("ax-note", "Owing before this list starts"),
        cell("ax-c-num", ""), cell("ax-c-num", ""),
        cell("ax-c-bal", money(d.openingCents))));
    }
    for (const e of d.statement) rows.push(e.kind === "charge" ? chargeRow(e, e.balanceCents) : repaymentRow(e, e.balanceCents));
    if (!d.statement.length) {
      rows.push(el("tr", { class: "ax-empty" }, el("td", { colspan: "6", text: "Nothing in this period. Add a transaction to start." })));
    }
    rows.push(el("tr", { class: "ax-total" },
      cell(null, ""), el("td", { class: "ax-label", text: "Owing now" }), cell(null, ""),
      cell("ax-c-num", ""), cell("ax-c-num", ""), cell("ax-c-bal", money(d.owingCents))));
    $("axRows").replaceChildren(...rows);
    $("axBody").hidden = false;
    $("axPrint").href = "/amexprint.html?range=" + encodeURIComponent(range);
  }

  async function load(opts) {
    let d;
    try {
      d = await api("/api/amex?range=" + encodeURIComponent(range));
    } catch (e) {
      const m = (e && e.message) || "";
      setStatus(/forbidden|access|permission/i.test(m) ? "You don't have access to AMEX." : failText(e), "err");
      return;
    }
    if (!d) return;
    render(d);
    if (!opts || !opts.keepStatus) setStatus("");
  }

  // After a dialog: the answer is the saved thing; a refusal the user closed reloads (someone else
  // may have changed it); a cancel does nothing.
  async function after(r, okText) {
    if (r === null) return;
    if (r && (r.refused || r.ok || r.id)) {
      await load({ keepStatus: true });
      setStatus(r.refused ? "The statement was reloaded as it is now." : okText, r.refused ? null : "ok");
    }
    $("axTitle").focus();
  }

  // ========================================================================= dialogs ===

  function transactionDialog(t) {
    const U = ui();
    const editing = !!t;
    const today = todayISO();
    const date = U.dateInput(editing ? t.date : today);
    const supplier = U.textInput(editing ? t.supplier : "", 100);
    const note = U.textInput(editing ? t.note : "", 200);
    const amt = moneyInput(editing ? t.amountCents : null);
    const fields = [
      U.field("Date", date),
      U.field("Amount", amt, { hint: editing && t.paid ? "Paid back, so the amount can't change." : "In dollars, like 1,485.29." }),
      U.field("Supplier", supplier, { wide: true }),
      U.field("Note", note, { wide: true }),
    ];
    if (editing && t.paid) amt.disabled = true;
    if (editing) {
      const del = el("button", { class: "hs-btn hs-btn-stop", type: "button", text: "Delete transaction" });
      del.addEventListener("click", () => deleteTransactionDialog(t));
      const box = el("div", { class: "ou-wide" }, del);
      if (t.paid) box.append(el("span", { class: "ou-field-hint", text: " Paid back, so it can't be deleted. Delete the repayment first." }));
      if (t.paid) del.disabled = true;
      fields.push(box);
    }
    return U.dialog({
      title: editing ? "Change the transaction" : "Add a transaction",
      wide: true,
      fields,
      submit: editing ? "Save" : "Add transaction",
      focus: editing ? supplier : date,
      run: async () => {
        if (!date.value) throw U.fail("Choose the date of the transaction", date);
        if (!supplier.value.trim()) throw U.fail("Type the supplier", supplier);
        const a = parseMoney(amt.value);
        if (a === null || Number.isNaN(a) || a <= 0) throw U.fail("Type the amount in dollars, like 1,485.29", amt);
        const body = { txnDate: date.value, supplier: supplier.value, note: note.value, amountCents: a };
        if (editing) {
          const same = date.value === t.date && supplier.value.trim() === t.supplier && note.value.trim() === t.note && a === t.amountCents;
          if (same) return undefined;
        }
        try {
          return editing
            ? await send("/api/amex/transactions/" + t.id, "PATCH", body)
            : await send("/api/amex/transactions", "POST", body);
        } catch (e) {
          const err = refusal(e);
          const m = err.message;
          if (/date/i.test(m)) err.field = date;
          else if (/^Supplier/i.test(m)) err.field = supplier;
          else if (/^Note/i.test(m)) err.field = note;
          else if (/amount/i.test(m)) err.field = amt;
          throw err;
        }
      },
    }).then((r) => after(r, editing ? "Transaction saved." : "Transaction added."));
  }

  function deleteTransactionDialog(t) {
    return ui().dialog({
      title: "Delete this transaction?",
      note: `${fmtDate(t.date)}, ${t.supplier}${t.note ? " (" + t.note + ")" : ""}, ${money(t.amountCents)}.`,
      submit: "Delete transaction",
      submitClass: "hs-btn-stop",
      focus: "cancel",
      run: async () => {
        try {
          return await send("/api/amex/transactions/" + t.id, "DELETE");
        } catch (e) {
          throw refusal(e);
        }
      },
    }).then((r) => after(r, "Transaction deleted."));
  }

  function repaymentDialog(r) {
    const U = ui();
    const byId = new Map(data.transactions.map((t) => [t.id, t]));
    const list = el("ul", { class: "ax-covers ou-wide" });
    for (const id of r.transactionIds) {
      const t = byId.get(id);
      if (t) list.append(el("li", null, el("span", { text: fmtDayMon(t.date) + "  " + t.supplier }), el("span", { text: money(t.amountCents) })));
    }
    if (!list.children.length && r.coversCount) list.append(el("li", null, el("span", { text: r.coversCount + " earlier transactions, not in this list" }), el("span", { text: money(r.coveredCents) })));
    return U.dialog({
      title: "Repayment of " + money(r.amountCents),
      note: `Paid ${fmtDate(r.date)}.${r.note ? " " + r.note : ""} ${coversText(r).replace(/\. .*$/, "")}. Deleting it puts those transactions back to owing.`,
      wide: true,
      fields: [list],
      submit: "Delete repayment",
      submitClass: "hs-btn-stop",
      cancel: "Close",
      focus: "cancel",
      run: async () => {
        try {
          return await send("/api/amex/repayments/" + r.id, "DELETE");
        } catch (e) {
          throw refusal(e);
        }
      },
    }).then((res) => after(res, "Repayment deleted. Its transactions are owing again."));
  }

  function recordRepaymentDialog() {
    const U = ui();
    const unpaid = data.unpaid || [];
    if (!unpaid.length) {
      setStatus("Nothing is owing, so there is nothing to repay.", null);
      return Promise.resolve();
    }
    const today = todayISO();
    const date = U.dateInput(today);
    const amt = moneyInput(null);
    const note = U.textInput("", 200);
    const total = el("p", { class: "ax-picktotal ou-wide", "aria-live": "polite" });
    const boxes = [];
    const pick = el("div", { class: "ax-pick ou-wide" });
    let typedAmount = false;
    let confirmed = ""; // "ticked|amount" the user has been warned about

    for (const t of unpaid) {
      const cb = el("input", { type: "checkbox" });
      cb.value = String(t.id);
      cb.dataset.cents = String(t.amountCents);
      boxes.push(cb);
      pick.append(el("label", { class: "ax-pick-row" }, cb,
        el("span", { class: "ax-pick-date", text: fmtDayMon(t.date) + (t.date.slice(0, 4) !== today.slice(0, 4) ? " " + t.date.slice(0, 4) : "") }),
        el("span", { class: "ax-pick-sup", text: t.supplier + (t.note ? " · " + t.note : "") }),
        el("span", { class: "ax-pick-amt", text: money(t.amountCents) })));
    }

    function ticked() {
      return boxes.filter((b) => b.checked).reduce((s, b) => s + Number(b.dataset.cents), 0);
    }
    function draw() {
      const n = boxes.filter((b) => b.checked).length;
      const tk = ticked();
      const a = parseMoney(amt.value);
      total.classList.remove("ax-warn");
      let t = `Ticked: ${n} ${n === 1 ? "transaction" : "transactions"}, ${money(tk)}`;
      if (n && a !== null && !Number.isNaN(a) && a !== tk) {
        t += `. That is ${money(Math.abs(a - tk))} ${a > tk ? "less" : "more"} than the amount.`;
        total.classList.add("ax-warn");
      }
      total.textContent = t;
    }
    for (const b of boxes) {
      b.addEventListener("change", () => {
        if (!typedAmount) amt.value = ticked() ? plainMoney(ticked()) : "";
        draw();
      });
    }
    amt.addEventListener("input", () => {
      typedAmount = amt.value.trim() !== "";
      draw();
    });
    draw();

    return U.dialog({
      title: "Record a repayment",
      note: "Tick the transactions this payment covers. They are crossed off the statement.",
      wide: true,
      fields: [
        U.field("Date paid", date),
        U.field("Amount paid", amt, { hint: "Fills in from the ticked total; type it to change." }),
        U.field("Note", note, { wide: true }),
        pick,
        total,
      ],
      submit: "Record repayment",
      focus: date,
      run: async () => {
        if (!date.value) throw U.fail("Choose the date it was paid", date);
        const ids = boxes.filter((b) => b.checked).map((b) => Number(b.value));
        if (!ids.length) throw U.fail("Tick at least one transaction this repayment covers", pick);
        const a = parseMoney(amt.value);
        if (a === null || Number.isNaN(a) || a <= 0) throw U.fail("Type the amount paid in dollars, like 5,994.53", amt);
        const tk = ticked();
        const key = tk + "|" + a;
        if (a !== tk && confirmed !== key) {
          confirmed = key;
          throw U.fail(`The ticked transactions add up to ${money(tk)} but the amount is ${money(a)}. Press Record repayment again to record it anyway.`, amt);
        }
        const body = { paidDate: date.value, amountCents: a, transactionIds: ids };
        if (note.value.trim()) body.note = note.value;
        try {
          return await send("/api/amex/repayments", "POST", body);
        } catch (e) {
          const err = refusal(e);
          if (/date/i.test(err.message)) err.field = date;
          throw err;
        }
      },
    }).then((r) => after(r, "Repayment recorded."));
  }

  // ========================================================================= start ===

  $("axRange").addEventListener("change", () => {
    range = $("axRange").value;
    load();
  });

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    if (!can("loans.manage") && !can("loans.maintain")) {
      setStatus("You don't have access to AMEX.", "err");
      return;
    }
    const print = el("a", { class: "hs-btn", id: "axPrint", href: "/amexprint.html", text: "Print" });
    $("axHeadActions").replaceChildren(
      headButton("Add transaction", "hs-btn-primary", () => transactionDialog(null)),
      headButton("Record repayment", null, () => recordRepaymentDialog()),
      print);
    load();
  })();
})();
