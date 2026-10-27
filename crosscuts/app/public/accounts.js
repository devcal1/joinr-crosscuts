// Accounts page: the invoice table, the overdue list and the invoice dialog.
// Talks to /api/invoices (routes/invoices.js, docs/plans/m2-contracts.md section 4).
// Money is integer cents on the wire; dollars are parsed from strings, never through floats.
(function () {
  "use strict";

  const KIND = { deposit: "Deposit", progress: "Progress", final: "Final", extra: "Extra" };
  const STATUS = { pending: "Pending", due: "Due", issued: "Issued", paid: "Paid", waived: "Waived", void: "Void" };
  const STATUS_BADGE = {
    pending: "hs-badge-na",
    due: "hs-badge-check",
    issued: "hs-badge-na",
    paid: "hs-badge-teal",
    waived: "hs-badge-na",
    void: "hs-badge-na",
  };
  const FILTERS = [
    ["all", "All"],
    ["due", "Due"],
    ["unpaid", "Unpaid"],
    ["overdue", "Overdue"],
    ["notmyob", "Not in MYOB"],
    ["month", "This month"],
  ];

  // Permissions come from the shell. Without it, act as view-only: the server enforces
  // everything regardless.
  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }
  const canEdit = () => can("invoices.edit");

  // --- helpers ---------------------------------------------------------------------
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
  const $ = (id) => document.getElementById(id);

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }
  // Today's date in Sydney, YYYY-MM-DD (en-CA formats as ISO).
  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  // $12,345.67 from integer cents.
  function fmtMoney(cents) {
    if (cents == null) return "-";
    const a = Math.abs(cents);
    const whole = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (cents < 0 ? "-" : "") + "$" + whole + "." + String(a % 100).padStart(2, "0");
  }
  // 12345.67 (plain, for inputs) from integer cents.
  function centsToInput(cents) {
    if (cents == null) return "";
    const a = Math.abs(cents);
    return (cents < 0 ? "-" : "") + Math.floor(a / 100) + "." + String(a % 100).padStart(2, "0");
  }
  // Integer cents from a typed dollar string. Parsed as text: no float arithmetic.
  function parseDollars(str, what) {
    const s = String(str == null ? "" : str).trim().replace(/[$,\s]/g, "");
    const m = /^(-)?(\d{1,10})(?:\.(\d{1,2}))?$/.exec(s);
    if (!m) throw new Error(`${what} must be a dollar amount like 1250.50`);
    const cents = Number(m[2]) * 100 + Number((m[3] || "").padEnd(2, "0"));
    return m[1] && cents !== 0 ? -cents : cents;
  }

  // --- state and elements ------------------------------------------------------------
  let filter = "all";
  let view = "table";
  let tableSeq = 0;
  let overdueSeq = 0;
  let cur = null; // the invoice detail shown in the dialog: { d, ui }
  const dlg = $("dlg");

  // --- the table -----------------------------------------------------------------------
  function buildFilters() {
    const box = $("filters");
    box.replaceChildren();
    for (const [key, label] of FILTERS) {
      const b = el("button", { type: "button", class: "hs-btn", "data-filter": key, text: label });
      b.addEventListener("click", () => {
        filter = key;
        syncFilters();
        loadTable();
      });
      box.append(b);
    }
    syncFilters();
  }
  function syncFilters() {
    for (const b of $("filters").children) {
      const on = b.dataset.filter === filter;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.classList.toggle("hs-btn-primary", on);
    }
    // "Show all jobs" only widens the unfiltered view.
    $("allJobs").disabled = filter !== "all";
  }

  // A pending deposit, progress or final is waiting for the job value (an
  // invoice always has one); a pending extra waits for the job to be complete.
  function waitingForValue(inv) {
    return inv.status === "pending" && inv.kind !== "extra";
  }

  function statusLabel(c) {
    if (c.overdue) return "Overdue";
    return waitingForValue(c) ? "Needs value" : STATUS[c.status] || c.status;
  }

  function cellButton(c, kindLabel) {
    const cls = "ac-cell st-" + (c.overdue ? "overdue" : c.status);
    const b = el("button", { type: "button", class: cls, "data-id": c.id });
    b.append(el("span", { class: "ac-cell-st", text: statusLabel(c) }));
    b.append(el("span", { class: "ac-cell-amt", text: fmtMoney(c.totalCents) }));
    let sub = "";
    if (c.status === "issued") sub = `${c.number || ""}, due ${fmtDate(c.dueDate)}`;
    else if (c.status === "paid") sub = `${c.number || ""}, paid ${fmtDate(c.paidDate)}`;
    if (sub) b.append(el("span", { class: "ac-cell-sub", text: sub }));
    if (c.kind === "extra" && c.description) b.append(el("span", { class: "ac-cell-desc", text: c.description }));
    const live = c.status === "issued" || c.status === "paid";
    if (live && !c.myobEntered) b.append(el("span", { class: "ac-cell-myob", text: "Not in MYOB" }));
    b.setAttribute(
      "aria-label",
      `${kindLabel}: ${statusLabel(c)}, ${fmtMoney(c.totalCents)}${c.number ? ", " + c.number : ""}${
        live && !c.myobEntered ? ", not in MYOB" : ""
      }`
    );
    b.addEventListener("click", () => openInvoice(c.id));
    return b;
  }

  function renderTable(data) {
    const rowsEl = $("rows");
    rowsEl.replaceChildren();
    for (const r of data.rows) {
      const tr = el("tr");
      tr.append(el("td", { class: "ac-job" }, el("a", { href: "/job.html?id=" + r.job.id, text: r.job.name })));
      tr.append(el("td", { class: "ac-client", text: r.job.clientName || "" }));
      tr.append(el("td", { class: "num", text: r.job.valueCents == null ? "-" : fmtMoney(r.job.valueCents) }));
      for (const k of ["deposit", "progress", "final"]) {
        const td = el("td");
        if (r[k]) td.append(cellButton(r[k], `${KIND[k]} for ${r.job.name}`));
        else td.append(el("span", { class: "ac-none", text: "-" }));
        tr.append(td);
      }
      const ex = el("td");
      if (r.extras.length) for (const c of r.extras) ex.append(cellButton(c, `Extra for ${r.job.name}`));
      else ex.append(el("span", { class: "ac-none", text: "-" }));
      tr.append(ex);
      rowsEl.append(tr);
    }

    const empty = $("empty");
    empty.hidden = data.rows.length > 0;
    if (!data.rows.length) {
      empty.textContent =
        filter === "all" && !$("q").value.trim()
          ? "No invoices yet. Tick Show all jobs to see every job."
          : "No invoices match.";
    }

    const t = data.totals;
    const totals = $("totals");
    totals.replaceChildren();
    const part = (label, value, cls) => {
      if (totals.childNodes.length) totals.append(el("span", { class: "ac-sep", text: "|" }));
      totals.append(document.createTextNode(label + " "), el("b", { class: cls || "", text: value }));
    };
    part("Outstanding", fmtMoney(t.outstandingCents));
    part("Overdue", `${fmtMoney(t.overdueCents)} (${t.overdueCount})`, t.overdueCount ? "ac-over" : "");
    part("Due to issue", String(t.dueCount));
    part("Not in MYOB", String(t.notInMyobCount));
    part("Jobs shown", String(data.rows.length));
  }

  async function loadTable() {
    const mine = ++tableSeq;
    const p = new URLSearchParams({ filter });
    const q = $("q").value.trim();
    if (q) p.set("q", q);
    if ($("allJobs").checked && filter === "all") p.set("allJobs", "1");
    try {
      const data = await api("/api/invoices/table?" + p);
      if (mine !== tableSeq) return;
      renderTable(data);
    } catch (e) {
      if (mine !== tableSeq) return;
      $("totals").textContent = e.message;
    }
  }

  // --- the overdue list ------------------------------------------------------------------
  async function loadOverdue() {
    const mine = ++overdueSeq;
    let list;
    try {
      list = await api("/api/invoices/overdue");
    } catch (e) {
      if (mine === overdueSeq) $("overdueSummary").textContent = e.message;
      return;
    }
    if (mine !== overdueSeq) return;
    const body = $("overdueRows");
    body.replaceChildren();
    let sum = 0;
    for (const { invoice: inv, daysOverdue } of list) {
      sum += inv.totalCents;
      const tr = el("tr");
      const numBtn = el("button", { type: "button", class: "ac-linkbtn", text: inv.number || "Open" });
      numBtn.addEventListener("click", () => openInvoice(inv.id));
      tr.append(el("td", {}, numBtn));
      tr.append(el("td", {}, el("a", { href: "/job.html?id=" + inv.job.id, text: inv.job.name })));
      tr.append(el("td", { text: inv.job.clientName || "" }));
      const phoneTd = el("td");
      if (inv.job.clientPhone) phoneTd.append(el("a", { href: "tel:" + inv.job.clientPhone.replace(/[^\d+]/g, ""), text: inv.job.clientPhone }));
      tr.append(phoneTd);
      tr.append(el("td", { class: "num", text: fmtMoney(inv.totalCents) }));
      tr.append(el("td", { text: fmtDate(inv.dueDate) }));
      tr.append(el("td", { class: "num ac-days", text: String(daysOverdue) }));
      const lastTd = el("td", {}, inv.lastContactedDate ? document.createTextNode(fmtDate(inv.lastContactedDate)) : el("span", { class: "ac-none", text: "Never" }));
      // 0.2.7 (m28-contracts.md section 3): no contact within the invoice's own interval.
      if (inv.needsFollowUp) lastTd.append(el("span", { class: "ac-followup", text: "Needs follow-up (every " + inv.followUpDaysEffective + " days)" }));
      tr.append(lastTd);
      tr.append(el("td", { class: "ac-notes", text: inv.followUpNotes || "" }));
      const act = el("td");
      if (canEdit()) {
        const b = el("button", { type: "button", class: "hs-btn", text: "Contacted today" });
        b.addEventListener("click", async () => {
          b.disabled = true;
          try {
            await api("/api/invoices/" + inv.id + "/contacts", { method: "POST", body: JSON.stringify({ date: todayISO() }) });
            toast("Marked contacted today");
            await loadOverdue();
          } catch (e) {
            toast("Error: " + e.message);
            b.disabled = false;
          }
        });
        act.append(b);
      }
      tr.append(act);
      body.append(tr);
    }
    $("overdueEmpty").hidden = list.length > 0;
    const s = $("overdueSummary");
    s.replaceChildren();
    if (list.length) {
      s.append(el("b", { class: "ac-over", text: String(list.length) }), document.createTextNode(` overdue, totalling `), el("b", { text: fmtMoney(sum) }), document.createTextNode(". Oldest first."));
    } else {
      s.textContent = "No overdue invoices.";
    }
  }

  // 0.2.7 (m28-contracts.md section 3): the default interval and the client terms list.
  async function loadFollowup() {
    const box = $("followupBox");
    const body = $("followupBody");
    let d;
    try {
      d = await api("/api/followup");
    } catch (e) {
      return;
    }
    box.hidden = false;
    body.replaceChildren();
    const err = el("p", { class: "cc-dialog-error", role: "alert" });
    const def = el("input", { id: "fu-default", class: "hs-input ac-days-in", type: "number", min: "1", max: "365", step: "1" });
    def.value = String(d.defaultDays);
    const row = el("div", { class: "ac-row" }, el("label", { class: "cc-field-label", for: "fu-default", text: "Default (days)" }), def);
    if (canEdit()) {
      const save = el("button", { type: "button", class: "hs-btn", text: "Save default" });
      save.addEventListener("click", () =>
        busy(body, err, async () => {
          await api("/api/followup/default", { method: "PUT", body: JSON.stringify({ days: Number(def.value) }) });
          toast("Saved");
          await loadFollowup();
          await loadOverdue();
        })
      );
      row.append(save);
    } else {
      def.disabled = true;
    }
    body.append(row);
    const list = el("ul", { class: "ac-contacts" });
    if (!d.clients.length) list.append(el("li", { class: "ac-hint", text: "No client terms yet. Set them from an invoice (Use for this client)." }));
    for (const c of d.clients) {
      const li = el("li", { text: c.clientName + ": " + c.followUpDays + " days " });
      if (canEdit()) {
        const rm = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Remove" });
        rm.addEventListener("click", () =>
          busy(body, err, async () => {
            await api("/api/followup/clients", { method: "PUT", body: JSON.stringify({ clientName: c.clientName, followUpDays: null }) });
            await loadFollowup();
            await loadOverdue();
          })
        );
        li.append(rm);
      }
      list.append(li);
    }
    body.append(el("span", { class: "ac-group-title", text: "Client terms" }), list, err);
  }

  function setView(v) {
    view = v;
    $("tableView").hidden = v !== "table";
    $("overdueView").hidden = v !== "overdue";
    for (const [id, name] of [["viewTable", "table"], ["viewOverdue", "overdue"]]) {
      const b = $(id);
      b.setAttribute("aria-pressed", name === v ? "true" : "false");
      b.classList.toggle("hs-btn-primary", name === v);
    }
    if (v === "overdue") loadOverdue();
    else loadTable();
  }
  function refreshLists() {
    return Promise.all([loadTable(), view === "overdue" ? loadOverdue() : null]);
  }

  // --- the dialog: shared parts ----------------------------------------------------------
  function setParam(id) {
    try {
      const u = new URL(location.href);
      if (id) u.searchParams.set("invoice", id);
      else u.searchParams.delete("invoice");
      history.replaceState(null, "", u);
    } catch (e) { /* the address bar is a convenience */ }
  }
  dlg.addEventListener("close", () => {
    cur = null;
    setParam(null);
  });

  function errorLine() {
    return el("p", { class: "cc-dialog-error", role: "alert" });
  }
  function head(title, inv) {
    const h = el("div", { class: "ac-dhead" });
    h.append(el("h2", { class: "cc-dialog-title", id: "dlgTitle", text: title }));
    if (inv) {
      const od = inv.overdue;
      h.append(
        el("span", {
          class: "hs-badge " + (od ? "hs-badge-stop" : STATUS_BADGE[inv.status] || "hs-badge-na"),
          text: statusLabel(inv),
        })
      );
    }
    return h;
  }
  function field(label, node, id, wide) {
    return el("div", { class: "cc-field" + (wide ? " ac-wide" : "") }, el("label", { class: "cc-field-label", for: id, text: label }), node);
  }
  function input(id, value, extra) {
    const n = el("input", { id, class: "hs-input", type: "text", autocomplete: "off", ...(extra || {}) });
    n.value = value == null ? "" : value;
    return n;
  }
  function closeBtn() {
    const b = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Close" });
    b.addEventListener("click", () => dlg.close());
    return b;
  }

  // Runs `fn` with the dialog's buttons disabled; shows a failure in the error line.
  async function busy(root, errEl, fn) {
    const btns = [...root.querySelectorAll("button")];
    const was = btns.map((b) => b.disabled);
    btns.forEach((b) => (b.disabled = true));
    errEl.textContent = "";
    try {
      await fn();
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      btns.forEach((b, i) => (b.disabled = was[i]));
    }
  }

  // Re-read the invoice and redraw the dialog and the lists.
  async function refreshOpen(id) {
    const d = await api("/api/invoices/" + id);
    showDetail(d);
    refreshLists();
    return d;
  }

  async function openInvoice(id) {
    try {
      const d = await api("/api/invoices/" + id);
      showDetail(d);
    } catch (e) {
      toast("Error: " + e.message);
    }
  }
  function showDetail(d) {
    cur = { d };
    const inv = d.invoice;
    const draft = inv.status === "due" || inv.status === "pending";
    if (draft && canEdit()) renderEditor(d);
    else renderViewer(d);
    setParam(inv.id);
    if (!dlg.open) dlg.showModal();
  }

  // --- the dialog: editor for a due (or pending) invoice -----------------------------------
  function renderEditor(d) {
    const inv = d.invoice;
    const job = inv.job;
    const root = el("div", { class: "cc-dialog-form" });
    const err = errorLine();
    let linesDirty = false;

    root.append(head(`${KIND[inv.kind]} invoice: ${job.name}`, inv));
    root.append(
      el("p", { class: "ac-dsub", text: [job.clientName, job.valueCents != null ? "Job value " + fmtMoney(job.valueCents) : ""].filter(Boolean).join(" | ") })
    );
    if (waitingForValue(inv)) {
      root.append(el("p", { class: "ac-hint", text: "Waiting for the job value: set it on the job and this falls due straight away." }));
    } else if (inv.status === "pending") {
      root.append(el("p", { class: "ac-hint", text: "Pending: this becomes due when the job is complete. You can edit the lines now." }));
    } else if (!inv.linesCustom) {
      root.append(el("p", { class: "ac-hint", text: "The amount follows the job's value until you change a line." }));
    }

    // lines
    const linesBox = el("div", { class: "ac-lines" });
    const sumEl = el("span", { text: "" });
    const gstEl = el("span", { text: "" });
    let shownTotalCents = null; // the total on screen, sent with Issue as expectedTotalCents
    function updateSum() {
      let total = 0;
      let ok = true;
      for (const row of linesBox.children) {
        const a = row.querySelector(".ac-amt-in").value.trim();
        if (a === "") continue;
        try {
          total += parseDollars(a, "Amount");
        } catch (e) {
          ok = false;
        }
      }
      shownTotalCents = ok ? total : null;
      sumEl.textContent = ok ? fmtMoney(total) : "check amounts";
      gstEl.textContent = ok ? fmtMoney(Math.round(total / 11)) : "-";
    }
    function addLine(desc, amount) {
      const row = el("div", { class: "ac-line" });
      const dIn = el("input", { class: "hs-input ac-desc-in", type: "text", "aria-label": "Line description", autocomplete: "off" });
      const aIn = el("input", { class: "hs-input ac-amt-in", type: "text", inputmode: "decimal", "aria-label": "Line amount in dollars", placeholder: "0.00", autocomplete: "off" });
      dIn.value = desc || "";
      aIn.value = amount || "";
      const rm = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Remove" });
      rm.addEventListener("click", () => {
        row.remove();
        linesDirty = true;
        updateSum();
      });
      for (const n of [dIn, aIn]) {
        n.addEventListener("input", () => {
          linesDirty = true;
          updateSum();
        });
      }
      row.append(dIn, aIn, rm);
      linesBox.append(row);
      return dIn;
    }
    for (const l of inv.lines) addLine(l.description, centsToInput(l.amountCents));
    linesDirty = false;
    updateSum();

    const addBtn = el("button", { type: "button", class: "hs-btn", text: "Add line" });
    addBtn.addEventListener("click", () => {
      linesDirty = true;
      addLine("", "").focus();
    });
    root.append(
      el("div", { class: "cc-field" }, el("span", { class: "ac-group-title", text: "Lines (dollars, GST included; negative for a discount)" }), linesBox),
      el("div", { class: "ac-row" }, addBtn),
      el("div", { class: "ac-linesum" }, el("span", { text: "Total" }), sumEl),
      el("div", { class: "ac-gstnote" }, el("span", { text: "includes GST of" }), gstEl)
    );

    // bill-to and due date
    const billName = input("bill-name", inv.billToName, { placeholder: job.clientName || "" });
    const billAbn = input("bill-abn", inv.billToAbn, { placeholder: job.clientAbn || "" });
    const billAddr = input("bill-addr", inv.billToAddress, { placeholder: job.siteAddress || "" });
    const siteAddr = input("site-addr", inv.siteAddress, { placeholder: job.siteAddress || "" });
    const dueDate = el("input", { id: "due-date", class: "hs-input", type: "date" });
    dueDate.value = inv.dueDate || "";
    const notes = el("textarea", { id: "inv-notes", class: "hs-input" });
    notes.value = inv.notes || "";
    root.append(
      el("p", { class: "ac-group-title", text: "Bill to (blank uses the job's details)" }),
      el(
        "div",
        { class: "ac-two" },
        field("Name", billName, "bill-name"),
        field("ABN", billAbn, "bill-abn"),
        field("Address", billAddr, "bill-addr", true),
        field("Site address", siteAddr, "site-addr", true),
        field("Payment due date", dueDate, "due-date"),
        el("p", { class: "ac-hint" }, document.createTextNode("Blank = issue date + standard terms.")),
        field("Notes", notes, "inv-notes", true)
      )
    );

    // Build the PATCH body from the form. Lines are sent only when they were edited, so
    // an untouched standard line keeps following the job's value.
    function patchBody() {
      const body = {
        billToName: billName.value.trim() || null,
        billToAbn: billAbn.value.trim() || null,
        billToAddress: billAddr.value.trim() || null,
        siteAddress: siteAddr.value.trim() || null,
        dueDate: dueDate.value || null,
        notes: notes.value,
      };
      if (linesDirty) {
        const lines = [];
        let n = 0;
        for (const row of linesBox.children) {
          n += 1;
          const desc = row.querySelector(".ac-desc-in").value.trim();
          const amt = row.querySelector(".ac-amt-in").value.trim();
          if (!desc && !amt) continue;
          if (!desc) throw new Error(`Line ${n} needs a description`);
          if (!amt) throw new Error(`Line ${n} needs an amount`);
          lines.push({ description: desc, amountCents: parseDollars(amt, `Line ${n} amount`) });
        }
        body.lines = lines;
      }
      return body;
    }
    async function save() {
      const body = patchBody();
      const out = await api("/api/invoices/" + inv.id, { method: "PATCH", body: JSON.stringify(body) });
      linesDirty = false;
      return out;
    }

    // confirm panels
    const issuePanel = el("div", { class: "ac-panel warn", hidden: true });
    const issueGo = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Issue invoice" });
    const issueNo = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Cancel" });
    issuePanel.append(
      el("p", { text: "This gives it the next number and locks it. Lines, bill-to and amounts can't be changed after this." }),
      el("div", { class: "ac-row" }, issueGo, issueNo)
    );
    const waivePanel = el("div", { class: "ac-panel stop", hidden: true });
    const waiveReason = el("textarea", { id: "waive-reason", class: "hs-input", "aria-label": "Reason for waiving", placeholder: "Reason (required)" });
    const waiveGo = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Waive invoice" });
    const waiveNo = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Cancel" });
    waivePanel.append(
      el("p", { text: "Waiving closes this invoice without billing it. Say why." }),
      waiveReason,
      el("div", { class: "ac-row" }, waiveGo, waiveNo)
    );
    root.append(issuePanel, waivePanel, err);

    // actions
    const previewBtn = el("button", { type: "button", class: "hs-btn", text: "Preview" });
    const saveBtn = el("button", { type: "button", class: "hs-btn", text: "Save" });
    const waiveBtn = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Waive" });
    const issueBtn = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Issue" });
    const actions = el("div", { class: "cc-dialog-actions" }, closeBtn(), waiveBtn, previewBtn, saveBtn);
    if (inv.status === "due") actions.append(issueBtn);
    root.append(actions);

    const show = (panel) => {
      issuePanel.hidden = panel !== "issue";
      waivePanel.hidden = panel !== "waive";
      actions.hidden = panel != null;
      if (panel === "waive") waiveReason.focus();
      if (panel === "issue") issueGo.focus();
    };
    issueBtn.addEventListener("click", () => {
      err.textContent = "";
      try {
        patchBody(); // catch a bad line before asking for confirmation
      } catch (e) {
        err.textContent = e.message;
        return;
      }
      show("issue");
    });
    issueNo.addEventListener("click", () => show(null));
    waiveBtn.addEventListener("click", () => show("waive"));
    waiveNo.addEventListener("click", () => show(null));

    saveBtn.addEventListener("click", () =>
      busy(root, err, async () => {
        await save();
        toast("Saved");
        await refreshOpen(inv.id);
      })
    );
    previewBtn.addEventListener("click", () => {
      // Open the tab now (a click is the only moment a popup is allowed), then point it
      // at the preview once the edits are saved.
      const w = window.open("about:blank", "_blank");
      busy(root, err, async () => {
        try {
          await save();
        } catch (e) {
          if (w) w.close();
          throw e;
        }
        const url = "/invoice.html?id=" + inv.id;
        if (w) w.location.href = url;
        else window.open(url, "_blank");
      });
    });
    issueGo.addEventListener("click", () =>
      busy(root, err, async () => {
        await save();
        const issueBody = shownTotalCents == null ? {} : { expectedTotalCents: shownTotalCents };
        let out;
        try {
          out = await api("/api/invoices/" + inv.id + "/issue", { method: "POST", body: JSON.stringify(issueBody) });
        } catch (e) {
          if (/amount changed/i.test(e.message)) {
            // Show the new amount, and say why nothing was issued.
            toast(e.message);
            await refreshOpen(inv.id);
            return;
          }
          throw e;
        }
        toast("Issued " + (out.number || ""));
        await refreshOpen(inv.id);
      })
    );
    waiveGo.addEventListener("click", () =>
      busy(root, err, async () => {
        const reason = waiveReason.value.trim();
        if (!reason) throw new Error("A reason is required to waive an invoice");
        await api("/api/invoices/" + inv.id + "/waive", { method: "POST", body: JSON.stringify({ reason }) });
        toast("Waived");
        await refreshOpen(inv.id);
      })
    );

    dlg.replaceChildren(root);
  }

  // --- the dialog: viewer / actions for everything else ------------------------------------
  function kvt(pairs) {
    const g = el("div", { class: "hs-kvt" });
    for (const [k, v] of pairs) g.append(el("div", { class: "k", text: k }), el("div", { class: "v" }, typeof v === "string" ? document.createTextNode(v) : v));
    return g;
  }
  function linkBtn(text, id) {
    const b = el("button", { type: "button", class: "ac-linkbtn", text });
    b.addEventListener("click", () => openInvoice(id));
    return b;
  }

  // 0.2.7 (m28-contracts.md section 3): Mark sent, the follow-up interval and the client's terms.
  function sentPanel(inv, root, err) {
    const panel = el("div", { class: "ac-panel" });
    const sentOn = el("input", { id: "sent-on", class: "hs-input", type: "date", "aria-label": "Date sent" });
    sentOn.value = inv.sentDate || todayISO();
    sentOn.max = todayISO();
    if (inv.issueDate) sentOn.min = inv.issueDate;
    const sentBtn = el("button", { type: "button", class: "hs-btn" + (inv.sentDate ? "" : " hs-btn-primary"), text: inv.sentDate ? "Change sent date" : "Mark sent" });
    sentBtn.addEventListener("click", () =>
      busy(root, err, async () => {
        await api("/api/invoices/" + inv.id + "/sent", { method: "POST", body: JSON.stringify({ date: sentOn.value || undefined }) });
        toast("Marked sent");
        await refreshOpen(inv.id);
      })
    );
    panel.append(el("div", { class: "ac-row" }, el("label", { class: "cc-field-label", for: "sent-on", text: "Sent on" }), sentOn, sentBtn));
    const days = el("input", { id: "fu-days", class: "hs-input ac-days-in", type: "number", min: "1", max: "365", step: "1" });
    days.value = inv.followUpDays != null ? String(inv.followUpDays) : "";
    days.placeholder = String(inv.followUpDaysEffective);
    const daysBtn = el("button", { type: "button", class: "hs-btn", text: "Save interval" });
    daysBtn.addEventListener("click", () =>
      busy(root, err, async () => {
        const v = days.value.trim();
        if (v && !/^\d+$/.test(v)) throw new Error("The interval is a whole number of days");
        await api("/api/invoices/" + inv.id, { method: "PATCH", body: JSON.stringify({ followUpDays: v ? Number(v) : null }) });
        toast("Saved");
        await refreshOpen(inv.id);
      })
    );
    const row = el("div", { class: "ac-row" }, el("label", { class: "cc-field-label", for: "fu-days", text: "Follow up every (days)" }), days, daysBtn);
    const client = inv.job && inv.job.clientName;
    if (client) {
      const termsBtn = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Use for this client" });
      termsBtn.addEventListener("click", () =>
        busy(root, err, async () => {
          const v = Number(days.value.trim() || inv.followUpDaysEffective);
          await api("/api/followup/clients", { method: "PUT", body: JSON.stringify({ clientName: client, followUpDays: v }) });
          toast("Saved as the terms for " + client + ": " + v + " days");
          await refreshOpen(inv.id);
        })
      );
      row.append(termsBtn);
    }
    panel.append(row);
    panel.append(el("p", { class: "ac-hint", text: client && inv.clientFollowUpDays != null ? "Terms for " + client + ": " + inv.clientFollowUpDays + " days." : "Mark sent fills the interval from the client's terms, else the default." }));
    return panel;
  }

  function contactLog(inv) {
    const box = el("div", { class: "cc-field" }, el("span", { class: "ac-group-title", text: "Contact log" }));
    const list = el("ul", { class: "ac-contacts" });
    box.append(list);
    api("/api/invoices/" + inv.id + "/contacts")
      .then((d) => {
        if (!d.contacts.length) list.append(el("li", { class: "ac-hint", text: "No contacts logged." }));
        for (const c of d.contacts) {
          list.append(el("li", { text: fmtDate(c.date) + (c.by && c.by.name ? " (" + c.by.name + ")" : "") + (c.note ? ": " + c.note : "") }));
        }
      })
      .catch(() => list.append(el("li", { class: "ac-hint", text: "Couldn't load the contact log." })));
    return box;
  }

  function renderViewer(d) {
    const inv = d.invoice;
    const job = inv.job;
    const edit = canEdit();
    const live = inv.status === "issued" || inv.status === "paid";
    const root = el("div", { class: "cc-dialog-form" });
    const err = errorLine();

    root.append(head(`${KIND[inv.kind]} invoice: ${job.name}`, inv));
    root.append(
      el("p", { class: "ac-dsub", text: [inv.number, job.clientName, job.valueCents != null ? "Job value " + fmtMoney(job.valueCents) : ""].filter(Boolean).join(" | ") })
    );

    const rows = [];
    if (inv.number) rows.push(["Number", inv.number]);
    rows.push(["Total", `${fmtMoney(inv.totalCents)} (includes GST ${fmtMoney(inv.gstCents)})`]);
    if (inv.issueDate) rows.push(["Issued", fmtDate(inv.issueDate)]);
    if (inv.dueDate) {
      rows.push(["Payment due", fmtDate(inv.dueDate) + (inv.overdue ? " (overdue)" : "")]);
    }
    if (inv.paidDate) rows.push(["Paid", fmtDate(inv.paidDate)]);
    // 0.2.7 (m28-contracts.md section 3): sent and the follow-up interval.
    if (live) rows.push(["Sent", inv.sentDate ? fmtDate(inv.sentDate) : "Not marked sent"]);
    if (live) {
      const from = { invoice: "set on this invoice", client: "the client's terms", default: "the default" }[inv.followUpDaysFrom] || "";
      rows.push(["Follow up every", inv.followUpDaysEffective + " days (" + from + ")" + (inv.needsFollowUp ? ", needs follow-up now" : "")]);
    }
    if (live) rows.push(["Entered in MYOB", inv.myobEnteredDate ? fmtDate(inv.myobEnteredDate) : "Not yet"]);
    const billBits = [inv.billToName, inv.billToAbn ? "ABN " + inv.billToAbn : "", inv.billToAddress].filter(Boolean).join(", ");
    if (billBits) rows.push(["Bill to", billBits]);
    if (inv.status === "waived" && inv.waiveReason) rows.push(["Waived because", inv.waiveReason]);
    if (inv.status === "void" && inv.voidReason) rows.push(["Voided because", inv.voidReason]);
    if (inv.replacedById) rows.push(["Replaced by", linkBtn("Open the replacement", inv.replacedById)]);
    if (inv.replacesId) rows.push(["Replaces", linkBtn("Open the voided invoice", inv.replacesId)]);
    root.append(kvt(rows));

    // lines
    const linesBox = el("div", { class: "cc-field" }, el("span", { class: "ac-group-title", text: "Lines" }));
    if (inv.lines.length) {
      for (const l of inv.lines) {
        linesBox.append(el("div", { class: "ac-line-ro" }, el("span", { text: l.description }), el("span", { text: fmtMoney(l.amountCents) })));
      }
    } else {
      linesBox.append(el("p", { class: "ac-hint", text: "No lines." }));
    }
    root.append(linesBox);

    // notes and follow-up
    let notes;
    let follow;
    let contacted;
    let saveDetails = null;
    if (live && edit) {
      notes = el("textarea", { id: "inv-notes", class: "hs-input" });
      notes.value = inv.notes || "";
      follow = el("textarea", { id: "inv-follow", class: "hs-input" });
      follow.value = inv.followUpNotes || "";
      contacted = el("input", { id: "inv-contacted", class: "hs-input", type: "date" });
      contacted.value = inv.lastContactedDate || "";
      const todayBtn = el("button", { type: "button", class: "hs-btn", text: "Contacted today" });
      const contactNote = el("input", { id: "inv-contact-note", class: "hs-input", type: "text", maxlength: "1000", placeholder: "What was said (optional)" });
      saveDetails = el("button", { type: "button", class: "hs-btn", text: "Save notes" });
      const detailBody = () => ({
        notes: notes.value,
        followUpNotes: follow.value,
        lastContactedDate: contacted.value || null,
      });
      saveDetails.addEventListener("click", () =>
        busy(root, err, async () => {
          await api("/api/invoices/" + inv.id, { method: "PATCH", body: JSON.stringify(detailBody()) });
          toast("Saved");
          await refreshOpen(inv.id);
        })
      );
      todayBtn.addEventListener("click", () =>
        busy(root, err, async () => {
          await api("/api/invoices/" + inv.id, { method: "PATCH", body: JSON.stringify({ notes: notes.value, followUpNotes: follow.value }) });
          await api("/api/invoices/" + inv.id + "/contacts", { method: "POST", body: JSON.stringify({ date: todayISO(), note: contactNote.value }) });
          toast("Marked contacted today");
          await refreshOpen(inv.id);
        })
      );
      root.append(
        el(
          "div",
          { class: "ac-two" },
          field("Notes", notes, "inv-notes", true),
          field("Follow-up notes", follow, "inv-follow", true),
          field("Last contacted", el("div", { class: "ac-row" }, contacted, todayBtn), "inv-contacted", true),
          field("Contact note", contactNote, "inv-contact-note", true)
        ),
        el("div", { class: "ac-row" }, saveDetails)
      );
      root.append(sentPanel(inv, root, err), contactLog(inv));
    } else if (inv.notes || inv.followUpNotes || inv.lastContactedDate) {
      const more = [];
      if (inv.notes) more.push(["Notes", inv.notes]);
      if (inv.followUpNotes) more.push(["Follow-up notes", inv.followUpNotes]);
      if (inv.lastContactedDate) more.push(["Last contacted", fmtDate(inv.lastContactedDate)]);
      root.append(kvt(more));
    }

    // payment and MYOB
    if (live && edit) {
      const panel = el("div", { class: "ac-panel" });
      if (inv.status === "issued") {
        const paidOn = el("input", { id: "paid-on", class: "hs-input", type: "date", "aria-label": "Date paid" });
        paidOn.value = todayISO();
        // Not before issue, not in the future (m9-contracts.md section 3); the server says so too.
        if (inv.issueDate) paidOn.min = inv.issueDate;
        paidOn.max = todayISO();
        const paidBtn = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Mark paid" });
        paidBtn.addEventListener("click", () =>
          busy(root, err, async () => {
            await api("/api/invoices/" + inv.id + "/paid", { method: "POST", body: JSON.stringify({ paidDate: paidOn.value || undefined }) });
            toast("Marked paid");
            await refreshOpen(inv.id);
          })
        );
        panel.append(el("div", { class: "ac-row" }, el("label", { class: "cc-field-label", for: "paid-on", text: "Paid on" }), paidOn, paidBtn));
      } else {
        const unpaid = el("button", { type: "button", class: "hs-btn", text: "Mark unpaid" });
        unpaid.addEventListener("click", () =>
          busy(root, err, async () => {
            await api("/api/invoices/" + inv.id + "/unpaid", { method: "POST", body: "{}" });
            toast("Marked unpaid");
            await refreshOpen(inv.id);
          })
        );
        panel.append(el("div", { class: "ac-row" }, el("span", { text: "Paid on " + fmtDate(inv.paidDate) }), unpaid));
      }
      const myob = el("input", { id: "myob", type: "checkbox" });
      myob.checked = !!inv.myobEnteredDate;
      myob.addEventListener("change", () =>
        busy(root, err, async () => {
          try {
            await api("/api/invoices/" + inv.id + "/myob", { method: "POST", body: JSON.stringify({ entered: myob.checked }) });
          } catch (e) {
            myob.checked = !myob.checked;
            throw e;
          }
          await refreshOpen(inv.id);
        })
      );
      panel.append(el("label", { class: "ac-check", for: "myob" }, myob, document.createTextNode("Entered in MYOB")));
      root.append(panel);
    }

    // void
    let voidPanel = null;
    const actions = el("div", { class: "cc-dialog-actions" }, closeBtn());
    if (live && edit) {
      if (inv.status === "issued") {
        voidPanel = el("div", { class: "ac-panel stop", hidden: true });
        const reason = el("textarea", { id: "void-reason", class: "hs-input", "aria-label": "Reason for voiding", placeholder: "Reason (required)" });
        const go = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Void invoice" });
        const no = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Cancel" });
        voidPanel.append(
          el("p", { text: "Voiding cancels this invoice. Its number is never reused. A replacement draft with the same lines is made for you to correct and issue." }),
          el("p", { text: "Void it in MYOB too." }),
          reason,
          el("div", { class: "ac-row" }, go, no)
        );
        const voidBtn = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Void" });
        voidBtn.addEventListener("click", () => {
          voidPanel.hidden = false;
          actions.hidden = true;
          reason.focus();
        });
        no.addEventListener("click", () => {
          voidPanel.hidden = true;
          actions.hidden = false;
        });
        go.addEventListener("click", () =>
          busy(root, err, async () => {
            const why = reason.value.trim();
            if (!why) throw new Error("A reason is required to void an invoice");
            const out = await api("/api/invoices/" + inv.id + "/void", { method: "POST", body: JSON.stringify({ reason: why }) });
            toast(`Voided ${inv.number || ""}. Void it in MYOB too.`);
            refreshLists();
            await openInvoice(out.replacement.id);
          })
        );
        actions.append(voidBtn);
      } else {
        root.append(el("p", { class: "ac-hint", text: "A paid invoice can't be voided. Mark it unpaid first." }));
      }
    }
    if (inv.status === "waived" && edit) {
      const unwaive = el("button", { type: "button", class: "hs-btn", text: "Un-waive" });
      unwaive.addEventListener("click", () =>
        busy(root, err, async () => {
          await api("/api/invoices/" + inv.id + "/unwaive", { method: "POST", body: "{}" });
          toast("Back to due");
          await refreshOpen(inv.id);
        })
      );
      actions.append(unwaive);
    }
    if (live || inv.status === "void") {
      actions.append(el("a", { class: "hs-btn hs-btn-primary", href: "/invoice.html?id=" + inv.id, target: "_blank", rel: "noopener", text: "View / Save as PDF" }));
    } else if (inv.status === "due" || inv.status === "pending") {
      actions.append(el("a", { class: "hs-btn", href: "/invoice.html?id=" + inv.id, target: "_blank", rel: "noopener", text: "Preview" }));
    }
    if (voidPanel) root.append(voidPanel);
    root.append(err, actions);
    dlg.replaceChildren(root);
  }

  // --- new invoice / add extra ----------------------------------------------------------------
  async function renderNew(isExtra) {
    let data;
    try {
      data = await api("/api/invoices/table?allJobs=1");
    } catch (e) {
      toast("Error: " + e.message);
      return;
    }
    const rows = data.rows;
    const root = el("div", { class: "cc-dialog-form" });
    const err = errorLine();
    root.append(head(isExtra ? "Add extra" : "New invoice", null));
    root.append(
      el("p", {
        class: "ac-dsub",
        text: isExtra
          ? "A separate charge for extra work. It is due straight away if the job is complete, otherwise it waits as pending."
          : "Raise a deposit, progress or final invoice by hand.",
      })
    );

    const jobSel = el("select", { id: "new-job", class: "hs-input" });
    for (const r of rows) jobSel.append(el("option", { value: String(r.job.id), text: r.job.name + (r.job.clientName ? " (" + r.job.clientName + ")" : "") }));
    const kindSel = el("select", { id: "new-kind", class: "hs-input" });
    for (const k of ["deposit", "progress", "final"]) kindSel.append(el("option", { value: k, text: KIND[k] }));
    const desc = input("new-desc", "", { placeholder: isExtra ? "What the extra is for" : "Blank uses the standard line" });
    const amount = input("new-amt", "", { inputmode: "decimal", placeholder: isExtra ? "0.00" : "Blank uses the standard amount" });

    function syncKinds() {
      const r = rows.find((x) => String(x.job.id) === jobSel.value);
      let first = null;
      for (const opt of kindSel.options) {
        const taken = r && r[opt.value];
        opt.disabled = !!taken;
        opt.textContent = KIND[opt.value] + (taken ? " (already raised)" : "");
        if (!taken && !first) first = opt.value;
      }
      if (kindSel.selectedOptions[0] && kindSel.selectedOptions[0].disabled && first) kindSel.value = first;
    }
    jobSel.addEventListener("change", syncKinds);

    const fields = [field("Job", jobSel, "new-job", true)];
    if (!isExtra) fields.push(field("Kind", kindSel, "new-kind", true));
    fields.push(
      field(isExtra ? "Description" : "Description (optional)", desc, "new-desc", true),
      field(isExtra ? "Amount (dollars, GST included)" : "Amount (optional, dollars, GST included)", amount, "new-amt", true)
    );
    root.append(el("div", { class: "ac-two" }, ...fields), err);
    syncKinds();

    const go = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: isExtra ? "Add extra" : "Create invoice" });
    root.append(el("div", { class: "cc-dialog-actions" }, closeBtn(), go));
    if (!rows.length) {
      err.textContent = "There are no jobs yet.";
      go.disabled = true;
    }
    go.addEventListener("click", () =>
      busy(root, err, async () => {
        const body = { jobId: Number(jobSel.value), kind: isExtra ? "extra" : kindSel.value };
        const dText = desc.value.trim();
        const aText = amount.value.trim();
        if (isExtra && !dText) throw new Error("Describe the extra");
        if (isExtra && !aText) throw new Error("Enter an amount");
        if (dText) body.description = dText;
        if (aText) body.amountCents = parseDollars(aText, "Amount");
        const created = await api("/api/invoices", { method: "POST", body: JSON.stringify(body) });
        toast("Invoice created");
        refreshLists();
        await openInvoice(created.id);
      })
    );
    dlg.replaceChildren(root);
    cur = null;
    if (!dlg.open) dlg.showModal();
    jobSel.focus();
  }

  // --- start-up -----------------------------------------------------------------------------------
  function applyAccess() {
    const edit = canEdit();
    $("newInvoice").hidden = !edit;
    $("addExtra").hidden = !edit;
  }

  async function boot() {
    if (window.cc && window.cc.ready) await window.cc.ready;
    applyAccess();
    buildFilters();

    $("newInvoice").addEventListener("click", () => renderNew(false));
    $("addExtra").addEventListener("click", () => renderNew(true));
    $("viewTable").addEventListener("click", () => setView("table"));
    $("viewOverdue").addEventListener("click", () => setView("overdue"));
    $("allJobs").addEventListener("change", loadTable);
    let t = null;
    $("q").addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(loadTable, 250);
    });

    const params = new URLSearchParams(location.search);
    // 0.2.7: Waiting on you links here with ?filter=due or ?filter=unpaid.
    const f = params.get("filter");
    if (f && FILTERS.some(([k]) => k === f)) {
      filter = f;
      syncFilters();
      loadTable();
    }
    setView(params.get("view") === "overdue" ? "overdue" : "table");
    loadFollowup();
    const id = params.get("invoice");
    if (id && /^\d+$/.test(id)) openInvoice(Number(id));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
