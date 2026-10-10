// Reports page: the monthly report library. Talks to /api/reports (routes/reports.js,
// docs/plans/m4-contracts.md section 4). Files open through /api/files/:id. All text from the
// server is put in the page with textContent, never as HTML.
(function () {
  "use strict";

  const CATEGORIES = [
    ["bank_reconciliation", "Bank reconciliation"],
    ["bas", "BAS"],
    ["payroll", "Payroll"],
    ["aged_debtors", "Aged debtors"],
    ["other", "Other"],
  ];
  const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // The server is the real check; this just saves a wasted upload.
  const ALLOWED_EXT = ["pdf", "xlsx", "xls", "csv", "docx", "png", "jpg", "jpeg"];
  const MAX_BYTES = 25 * 1024 * 1024;

  // Permissions come from the shell. The server enforces everything regardless.
  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

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

  // --- dates and sizes ----------------------------------------------------------------
  function sydneyToday() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
  // The Sydney month before today's, as YYYY-MM.
  function previousMonth() {
    const [y, m] = sydneyToday().split("-").map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  }
  function currentMonth() {
    return sydneyToday().slice(0, 7);
  }
  function monthLabel(period) {
    const m = /^(\d{4})-(\d{2})$/.exec(period || "");
    return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : String(period || "");
  }
  function fmtStamp(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const parts = {};
    for (const p of new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      day: "numeric",
      month: "numeric",
      year: "numeric",
    }).formatToParts(d)) parts[p.type] = p.value;
    return `${parts.day} ${MONTH_SHORT[Number(parts.month) - 1]} ${parts.year}`;
  }
  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  // --- talking to the server -------------------------------------------------------------
  function toLogin() {
    location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
    return new Promise(() => {}); // navigating away
  }
  async function readError(res) {
    const body = await res.json().catch(() => ({}));
    return new Error(body.error || `Request failed (${res.status})`);
  }
  // JSON through the shared api() helper (it handles 401).
  const call = (path, options) => api(path, options);
  // Multipart upload: no JSON content type, the browser sets the boundary.
  async function postForm(path, form) {
    const res = await fetch(path, { method: "POST", body: form, credentials: "same-origin" });
    if (res.status === 401) return toLogin();
    if (!res.ok) throw await readError(res);
    return res.json();
  }

  // --- state ---------------------------------------------------------------------------------
  let seq = 0; // the newest list request wins
  let years = [];
  let lastRows = [];
  let loaded = false;
  const dlg = $("dlg");

  function setMessage(msg, kind) {
    const m = $("message");
    m.textContent = msg || "";
    m.className = "rp-message " + (kind || "");
  }

  // --- the list -------------------------------------------------------------------------------
  function buildFilters() {
    const cat = $("category");
    for (const [key, label] of CATEGORIES) cat.append(el("option", { value: key, text: label }));
    $("year").addEventListener("change", load);
    cat.addEventListener("change", load);
  }

  function syncYears(list) {
    const sel = $("year");
    const keep = sel.value;
    years = list;
    sel.replaceChildren(el("option", { value: "", text: "All years" }));
    for (const y of list) sel.append(el("option", { value: y, text: y }));
    sel.value = list.includes(keep) ? keep : "";
  }

  function reportRow(r) {
    const title = el("td", { class: "rp-title" });
    // Opens in a new tab: a PDF inline, anything else downloads with its own name.
    title.append(el("a", { href: r.file.url, target: "_blank", rel: "noopener", text: r.title }));
    if (r.notes) title.append(el("span", { class: "rp-notes", text: r.notes }));
    title.append(el("span", { class: "rp-fname", text: r.file.name }));
    const acts = el("td", { class: "rp-acts" });
    if (r.canEdit && can("reports.upload")) {
      const edit = el("button", { type: "button", class: "hs-btn", text: "Edit" });
      edit.addEventListener("click", () => openEdit(r));
      const rm = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Remove" });
      rm.addEventListener("click", () => openRemove(r));
      acts.append(edit, rm);
    }
    return el(
      "tr",
      null,
      el("td", { class: "rp-cat", text: CATEGORY_LABEL[r.category] || r.category }),
      title,
      el("td", { text: r.uploadedBy ? r.uploadedBy.name : "" }),
      el("td", { class: "rp-when", text: fmtStamp(r.createdAt) }),
      el("td", { class: "rp-size num", text: fmtSize(r.file.size) }),
      acts
    );
  }

  function monthBlock(period, rows) {
    const head = el(
      "div",
      { class: "hs-sectionbar" },
      el("h2", { text: monthLabel(period) }),
      el("span", { class: "rp-month-n", text: rows.length + (rows.length === 1 ? " report" : " reports") })
    );
    const tbody = el("tbody");
    for (const r of rows) tbody.append(reportRow(r));
    const table = el(
      "table",
      { class: "hs-table rp-table" },
      el(
        "thead",
        null,
        el(
          "tr",
          null,
          el("th", { text: "Category" }),
          el("th", { text: "Report" }),
          el("th", { text: "Uploaded by" }),
          el("th", { text: "Uploaded" }),
          el("th", { class: "num", text: "Size" }),
          el("th", { text: "" })
        )
      ),
      tbody
    );
    return el("section", { class: "rp-month" }, head, el("div", { class: "rp-wrap" }, table));
  }

  function render(rows) {
    const box = $("months");
    box.replaceChildren();
    // Server order is newest period first; group while keeping it.
    const groups = [];
    for (const r of rows) {
      const g = groups[groups.length - 1];
      if (g && g.period === r.period) g.rows.push(r);
      else groups.push({ period: r.period, rows: [r] });
    }
    for (const g of groups) box.append(monthBlock(g.period, g.rows));
    const filtered = $("year").value || $("category").value;
    $("empty").hidden = rows.length > 0;
    if (!rows.length) {
      $("empty").textContent = filtered ? "No reports match." : "No reports have been uploaded yet.";
    }
    $("count").textContent = rows.length + (rows.length === 1 ? " report" : " reports");
  }

  async function load() {
    const mine = ++seq;
    const qs = new URLSearchParams();
    if ($("year").value) qs.set("year", $("year").value);
    if ($("category").value) qs.set("category", $("category").value);
    try {
      const data = await call("/api/reports" + (qs.toString() ? "?" + qs : ""));
      if (mine !== seq) return;
      syncYears(data.years || []);
      setMessage("");
      lastRows = data.rows || [];
      loaded = true;
      render(lastRows);
    } catch (e) {
      if (mine !== seq) return;
      $("count").textContent = "";
      setMessage("Could not load the reports: " + e.message, "err");
    }
  }

  // --- dialogs ----------------------------------------------------------------------------------
  dlg.addEventListener("mousedown", (e) => {
    if (e.target === dlg) dlg.close();
  });

  function errorLine() {
    return el("p", { class: "cc-dialog-error", role: "alert" });
  }
  function field(label, node, id) {
    return el("div", { class: "cc-field" }, el("label", { class: "cc-field-label", for: id, text: label }), node);
  }
  function categorySelect(id, value) {
    const sel = el("select", { id, class: "hs-input" });
    for (const [key, label] of CATEGORIES) sel.append(el("option", { value: key, text: label }));
    sel.value = value;
    return sel;
  }
  function monthInput(id, value) {
    // The server refuses a month after the current Sydney month; the picker stops short of it too.
    return el("input", { id, class: "hs-input", type: "month", value, max: currentMonth(), required: true });
  }
  function closeBtn(label) {
    const b = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: label || "Cancel" });
    b.addEventListener("click", () => dlg.close());
    return b;
  }
  function show(root) {
    dlg.replaceChildren(root);
    if (!dlg.open) dlg.showModal();
  }
  // Runs fn with the dialog's buttons disabled; a failure goes in the error line.
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

  function defaultTitle(category, period) {
    return `${CATEGORY_LABEL[category] || ""} ${monthLabel(period)}`.trim();
  }

  function openUpload() {
    const err = errorLine();
    const month = monthInput("upMonth", previousMonth());
    const cat = categorySelect("upCategory", "bank_reconciliation");
    const title = el("input", { id: "upTitle", class: "hs-input", type: "text", maxlength: "200", autocomplete: "off", required: true });
    const notes = el("textarea", { id: "upNotes", class: "hs-input", maxlength: "2000", rows: "3" });
    const file = el("input", { id: "upFile", class: "hs-input", type: "file", accept: ALLOWED_EXT.map((x) => "." + x).join(",") });
    // The title follows the category and month until the person types their own.
    let touched = false;
    const fill = () => {
      if (!touched) title.value = defaultTitle(cat.value, month.value);
    };
    title.addEventListener("input", () => {
      touched = true;
    });
    month.addEventListener("input", fill);
    cat.addEventListener("change", fill);
    fill();

    const save = el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: "Upload" });
    const root = el(
      "form",
      { class: "cc-dialog-form", novalidate: true },
      el("h2", { class: "cc-dialog-title", id: "dlgTitle", text: "Upload report" }),
      el("div", { class: "rp-two" }, field("Month", month, "upMonth"), field("Category", cat, "upCategory")),
      field("Title", title, "upTitle"),
      field("Notes", notes, "upNotes"),
      field("File", file, "upFile"),
      el("p", { class: "rp-hint", text: "PDF, Excel (xlsx, xls), CSV, Word (docx), PNG or JPEG, up to 25 MB." }),
      err,
      el("div", { class: "cc-dialog-actions" }, closeBtn(), save)
    );
    root.addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy(root, err, async () => {
        const f = file.files && file.files[0];
        if (!f) throw new Error("Choose a file");
        const ext = (f.name.split(".").pop() || "").toLowerCase();
        if (f.name.indexOf(".") < 0 || !ALLOWED_EXT.includes(ext)) {
          throw new Error("That file type isn't allowed. Use PDF, xlsx, xls, CSV, docx, PNG or JPEG.");
        }
        if (f.size === 0) throw new Error("That file is empty");
        if (f.size > MAX_BYTES) throw new Error("That file is too big (25 MB at most)");
        if (!/^\d{4}-\d{2}$/.test(month.value)) throw new Error("Choose a month");
        if (month.value > currentMonth()) throw new Error("Month can't be in the future");
        if (!title.value.trim()) throw new Error("Title is required");
        const form = new FormData();
        form.append("period", month.value);
        form.append("category", cat.value);
        form.append("title", title.value.trim());
        form.append("notes", notes.value);
        form.append("file", f, f.name);
        await postForm("/api/reports", form);
        dlg.close();
        await load();
        setMessage("Report uploaded", "ok");
      });
    });
    show(root);
    month.focus();
  }

  function openEdit(r) {
    const err = errorLine();
    const month = monthInput("edMonth", r.period);
    const cat = categorySelect("edCategory", r.category);
    const title = el("input", { id: "edTitle", class: "hs-input", type: "text", maxlength: "200", autocomplete: "off", required: true });
    title.value = r.title;
    const notes = el("textarea", { id: "edNotes", class: "hs-input", maxlength: "2000", rows: "3" });
    notes.value = r.notes || "";
    const save = el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: "Save" });
    const root = el(
      "form",
      { class: "cc-dialog-form", novalidate: true },
      el("h2", { class: "cc-dialog-title", id: "dlgTitle", text: "Edit report" }),
      el("p", { class: "cc-dialog-note", text: "File: " + r.file.name }),
      el("div", { class: "rp-two" }, field("Month", month, "edMonth"), field("Category", cat, "edCategory")),
      field("Title", title, "edTitle"),
      field("Notes", notes, "edNotes"),
      err,
      el("div", { class: "cc-dialog-actions" }, closeBtn(), save)
    );
    root.addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy(root, err, async () => {
        const patch = {};
        if (month.value !== r.period) {
          if (!/^\d{4}-\d{2}$/.test(month.value)) throw new Error("Choose a month");
          patch.period = month.value;
        }
        if (cat.value !== r.category) patch.category = cat.value;
        if (title.value.trim() !== r.title) {
          if (!title.value.trim()) throw new Error("Title is required");
          patch.title = title.value.trim();
        }
        if (notes.value.trim() !== (r.notes || "")) patch.notes = notes.value;
        if (!Object.keys(patch).length) {
          dlg.close();
          return;
        }
        await call("/api/reports/" + r.id, { method: "PATCH", body: JSON.stringify(patch) });
        dlg.close();
        await load();
        setMessage("Report saved", "ok");
      });
    });
    show(root);
    title.focus();
  }

  function openRemove(r) {
    const err = errorLine();
    const yes = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Remove report" });
    const root = el(
      "div",
      { class: "cc-dialog-form" },
      el("h2", { class: "cc-dialog-title", id: "dlgTitle", text: "Remove this report?" }),
      el("p", { class: "cc-dialog-note", text: `${r.title} (${monthLabel(r.period)}) will be hidden and its file can no longer be opened.` }),
      err,
      el("div", { class: "cc-dialog-actions" }, closeBtn("Keep it"), yes)
    );
    yes.addEventListener("click", () => {
      busy(root, err, async () => {
        await call("/api/reports/" + r.id, { method: "DELETE" });
        dlg.close();
        await load();
        setMessage("Report removed", "ok");
      });
    });
    show(root);
  }

  // --- start -------------------------------------------------------------------------------------
  buildFilters();
  load();
  // The shell finishes loading permissions after first paint: show the upload button, and
  // redraw so Edit and Remove follow reports.upload.
  function onReady() {
    $("upload").hidden = !can("reports.upload");
    if (loaded) render(lastRows);
  }
  $("upload").addEventListener("click", openUpload);
  if (window.cc && window.cc.loaded) onReady();
  document.addEventListener("cc:ready", onReady);
})();
