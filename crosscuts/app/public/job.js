// Job create/edit page (job.html or job.html?id=N). Talks to /api/job-records.
(function () {
  const STAGES = [
    ["lead", "Lead"],
    ["quoted", "Quoted"],
    ["won", "Won"],
    ["design_ordering", "Design / ordering"],
    ["ready_to_cut", "Ready to cut"],
    ["on_board", "On board"],
    ["complete", "Complete"],
    ["invoiced", "Invoiced"],
    ["lost", "Lost"],
    ["archived", "Archived"],
  ];
  // Set automatically by the board (and later accounts); only users.admin may set them by hand.
  const DERIVED = new Set(["on_board", "complete", "invoiced"]);
  const MANUAL = ["lead", "quoted", "won", "design_ordering", "ready_to_cut", "lost", "archived"];
  // Mirror of jobstage.allowedTargets (docs/plans/m3-contracts.md section 2); the server stays authoritative.
  function allowedTargets(from) {
    if (from === "on_board") return [];
    if (from === "complete" || from === "invoiced") return ["archived"];
    return MANUAL.filter((s) => s !== from);
  }

  // This Sydney week's Monday (YYYY-MM-DD), to match lib/time.js sydneyMonday.
  function sydneyMondayStr() {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date()).split("-").map(Number);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  // The server refuses a non-admin hand move while the job has week rows this week or
  // later, whatever its stage. onBoardWeeks lists its week starts.
  function boardLocked(j) {
    if (!j) return false;
    if (j.stage === "on_board") return true;
    // Complete and invoiced are exempt (finished rows; archived is their only target).
    if (j.stage === "complete" || j.stage === "invoiced") return false;
    const mon = sydneyMondayStr();
    return Array.isArray(j.onBoardWeeks) && j.onBoardWeeks.some((w) => w >= mon);
  }

  // Permissions come from the shell (window.cc.can) when it is present. If it is
  // not, assume allowed: the server enforces everything regardless.
  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : true;
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : s || "";
  }

  // --- field definitions: key (API name), label, input type, group ----------
  // type: text | tel | email | textarea | int | bool3 | benchtop | date | url | money | stage | archived | materials
  // (materials is read-only here: the Materials ordered button sets it, never the form)
  const GROUPS = [
    {
      title: "Job",
      fields: [
        { key: "name", label: "Job name", type: "text", wide: true, required: true },
        { key: "stage", label: "Stage", type: "stage" },
        { key: "jobType", label: "Job type", type: "text", hint: "e.g. kitchen, vanity, wardrobe" },
        { key: "quoteNumber", label: "Quote number", type: "text", hint: "e.g. JRQ22961; printed on the invoices" },
      ],
    },
    {
      title: "Client",
      fields: [
        { key: "clientName", label: "Client name", type: "text" },
        { key: "clientPhone", label: "Phone", type: "tel" },
        { key: "clientEmail", label: "Email", type: "email" },
        { key: "clientAbn", label: "Client ABN", type: "text", hint: "Optional. Printed on invoices." },
        { key: "siteAddress", label: "Site address", type: "text", wide: true },
      ],
    },
    {
      title: "Spec",
      fields: [
        { key: "sheetCount", label: "Sheets", type: "int" },
        { key: "isTwoPac", label: "Two-pac", type: "bool3" },
        { key: "benchtop", label: "Benchtop", type: "benchtop" },
      ],
    },
    {
      title: "Value",
      valueOnly: true,
      fields: [{ key: "valueCents", label: "Value (AUD)", type: "money", hint: "Dollars. Stored as cents." }],
    },
    {
      title: "Dates",
      fields: [
        { key: "enquiryDate", label: "Enquiry", type: "date" },
        { key: "quotedDate", label: "Quoted", type: "date" },
        { key: "wonDate", label: "Won", type: "date" },
        { key: "designSignedOffDate", label: "Design signed off", type: "date" },
        { key: "materialsOrderedDate", label: "Materials ordered", type: "materials" },
        { key: "readyToCutDate", label: "Ready to cut", type: "date" },
        { key: "promisedInstallDate", label: "Promised install", type: "date" },
        { key: "completedDate", label: "Completed", type: "date" },
      ],
    },
    {
      title: "Links",
      fields: [
        { key: "designFolderUrl", label: "Design folder", type: "url", wide: true },
        { key: "joinrQuoteUrl", label: "Joinr quote", type: "url", wide: true },
        { key: "externalRef", label: "External reference", type: "text", hint: "Must be unique across jobs." },
      ],
    },
    {
      title: "Notes",
      fields: [
        { key: "notes", label: "Notes", type: "textarea", wide: true },
        { key: "archived", label: "Archived (hidden from default lists and the board job picker)", type: "archived", wide: true },
      ],
    },
  ];

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

  const params = new URLSearchParams(location.search);
  const idParam = params.get("id");
  const jobId = idParam && /^\d+$/.test(idParam) ? Number(idParam) : null;
  const isNew = jobId == null;

  const formEl = document.getElementById("form");
  const titleEl = document.getElementById("title");
  const metaEl = document.getElementById("meta");
  const bannerEl = document.getElementById("banner");
  const invoicesEl = document.getElementById("invoices");
  const invoicesBody = document.getElementById("invoicesBody");

  const INVOICE_KINDS = { deposit: "Deposit", progress: "Progress", final: "Final", extra: "Extra" };
  const INVOICE_BADGE = { pending: "hs-badge-na", due: "hs-badge-check", issued: "hs-badge-na", paid: "hs-badge-teal", waived: "hs-badge-na", void: "hs-badge-na" };
  // $12,345.67 from integer cents (no float arithmetic).
  function fmtMoneyCents(c) {
    if (c == null) return "";
    const a = Math.abs(c);
    return (c < 0 ? "-" : "") + "$" + String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + String(a % 100).padStart(2, "0");
  }

  let job = null; // last server copy (null while creating)
  let inputs = {}; // key -> element
  let statusEl = null;
  let saveBtn = null;

  // --- value <-> input conversion -------------------------------------------
  function toInput(f, v) {
    switch (f.type) {
      case "money":
        return v == null ? "" : (v / 100).toFixed(2);
      case "bool3":
        return v == null ? "" : v ? "1" : "0";
      case "archived":
        return !!v;
      default:
        return v == null ? "" : String(v);
    }
  }

  // Returns the API value for an input, or throws Error with a message.
  function fromInput(f, node) {
    if (f.type === "archived") return node.checked;
    const raw = node.value.trim();
    switch (f.type) {
      case "textarea":
        return node.value; // notes keep their whitespace; "" clears
      case "int": {
        if (raw === "") return null;
        if (!/^\d+$/.test(raw)) throw new Error(`${f.label} must be a whole number`);
        return Number(raw);
      }
      case "money": {
        if (raw === "") return null;
        const cleaned = raw.replace(/[$,\s]/g, "");
        if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error(`${f.label} must be a dollar amount like 1250.50`);
        return Math.round(Number(cleaned) * 100);
      }
      case "bool3":
        return raw === "" ? null : raw === "1";
      case "url":
        if (raw !== "" && !/^https?:\/\/\S+$/i.test(raw)) throw new Error(`${f.label} must start with http:// or https://`);
        return raw === "" ? null : raw;
      case "stage":
        return raw === "" ? null : raw;
      default:
        return raw === "" ? null : raw;
    }
  }

  // --- building the form -----------------------------------------------------
  function buildInput(f) {
    let node;
    const common = { id: "f-" + f.key, name: f.key };
    switch (f.type) {
      case "textarea":
        node = el("textarea", { ...common, class: "hs-input" });
        break;
      case "stage":
        node = el("select", { ...common, class: "hs-input" });
        for (const [v, label] of STAGES) {
          const opt = el("option", { value: v, text: label + (DERIVED.has(v) ? " (automatic)" : "") });
          node.append(opt);
        }
        break;
      case "bool3":
        node = el("select", { ...common, class: "hs-input" });
        node.append(el("option", { value: "", text: "Not set" }), el("option", { value: "1", text: "Yes" }), el("option", { value: "0", text: "No" }));
        break;
      case "benchtop":
        node = el("select", { ...common, class: "hs-input" });
        node.append(
          el("option", { value: "", text: "Not set" }),
          el("option", { value: "laminate", text: "Laminate" }),
          el("option", { value: "stone", text: "Stone" }),
          el("option", { value: "none", text: "None" })
        );
        break;
      case "archived":
        node = el("input", { ...common, type: "checkbox" });
        break;
      case "materials": {
        // Read-only: the date is set by the Materials ordered button in the Orders section,
        // which also starts the progress invoice.
        node = el("div", { id: common.id, class: "matordered" });
        const when = el("span", { class: "matordered-when" });
        node.append(when);
        node.__when = when;
        break;
      }
      case "date":
        node = el("input", { ...common, class: "hs-input", type: "date" });
        break;
      case "int":
        node = el("input", { ...common, class: "hs-input", type: "number", min: "0", step: "1", inputmode: "numeric" });
        break;
      case "money":
        node = el("input", { ...common, class: "hs-input", type: "text", inputmode: "decimal", placeholder: "0.00" });
        break;
      case "url":
        node = el("input", { ...common, class: "hs-input", type: "url", placeholder: "https://" });
        break;
      case "tel":
        node = el("input", { ...common, class: "hs-input", type: "tel" });
        break;
      case "email":
        node = el("input", { ...common, class: "hs-input", type: "email" });
        break;
      default:
        node = el("input", { ...common, class: "hs-input", type: "text" });
    }
    return node;
  }

  function showValueField() {
    if (isNew) return can("jobs.value");
    return job != null && "valueCents" in job; // server omits it without jobs.value
  }

  function buildForm() {
    formEl.replaceChildren();
    inputs = {};
    for (const g of GROUPS) {
      if (g.valueOnly && !showValueField()) continue;
      const grid = el("div", { class: "grid" });
      for (const f of g.fields) {
        const node = buildInput(f);
        inputs[f.key] = node;
        const field = el("div", { class: "field" + (f.wide ? " wide" : "") });
        if (f.type === "archived") {
          field.append(
            el("label", { for: node.id, class: "jobs-check" }, node, document.createTextNode(" " + f.label))
          );
        } else {
          field.append(el("label", { for: node.id, text: f.label + (f.required ? " *" : "") }), node);
        }
        if (f.hint) field.append(el("div", { class: "hint muted", text: f.hint }));
        if (f.type === "url") {
          const out = el("a", { class: "linkout", target: "_blank", rel: "noopener noreferrer", hidden: true, text: "Open link" });
          field.append(out);
          const sync = () => {
            const v = node.value.trim();
            out.hidden = !/^https?:\/\/\S+$/i.test(v);
            if (!out.hidden) out.href = v;
          };
          node.addEventListener("input", sync);
          node.__sync = sync;
        }
        grid.append(field);
      }
      formEl.append(el("fieldset", {}, el("legend", { class: "hs-sectionbar", text: g.title }), grid));
    }

    const actions = el("div", { class: "jobform-actions" });
    statusEl = el("div", { class: "status muted", role: "status" });
    saveBtn = el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: isNew ? "Create job" : "Save changes" });
    actions.append(statusEl, el("a", { class: "hs-btn hs-btn-quiet", href: "/jobs.html", text: "Cancel" }), saveBtn);
    formEl.append(actions);
  }

  function fill() {
    for (const g of GROUPS) {
      for (const f of g.fields) {
        const node = inputs[f.key];
        if (!node) continue;
        const v = job ? job[f.key] : f.key === "stage" ? "lead" : null;
        if (f.type === "materials") fillMaterials(node, v);
        else if (f.type === "archived") node.checked = !!v;
        else node.value = toInput(f, v);
        if (node.__sync) node.__sync();
      }
    }
    applyAccess();
  }

  // Read-only for users without jobs.edit; derived stages locked for non-admins.
  function applyAccess() {
    const editable = can("jobs.edit");
    for (const node of Object.values(inputs)) if (!node.__when) node.disabled = !editable;
    if (inputs.materialsOrderedDate) fillMaterials(inputs.materialsOrderedDate, job ? job.materialsOrderedDate : null);
    if (inputs.stage && editable) {
      const isAdmin = can("users.admin");
      if (isAdmin) {
        // Admins see every option; the server applies the override rules.
        for (const opt of inputs.stage.options) opt.disabled = false;
        inputs.stage.title = "";
      } else if (isNew) {
        // A new job starts in a manual stage.
        for (const opt of inputs.stage.options) opt.disabled = DERIVED.has(opt.value);
        inputs.stage.title = "On board, Complete and Invoiced are set automatically.";
      } else {
        // The pipeline rules: only the stages allowedTargets() gives, plus where the job is now.
        const cur = job ? job.stage : null;
        const locked = boardLocked(job);
        const ok = new Set(locked ? [] : allowedTargets(cur));
        for (const opt of inputs.stage.options) opt.disabled = opt.value !== cur && !ok.has(opt.value);
        if (locked) {
          inputs.stage.disabled = true;
          inputs.stage.title = "Moves from the board";
        } else if (cur === "complete" || cur === "invoiced") {
          inputs.stage.title = "Complete and invoiced jobs can only be archived.";
        } else {
          inputs.stage.title = "On board, Complete and Invoiced are set automatically.";
        }
      }
    }
    if (saveBtn) saveBtn.hidden = !editable;
    bannerEl.replaceChildren(
      ...(editable ? [] : [el("div", { class: "hs-callout ro-banner", text: "You can view this job but not edit it." })])
    );
  }

  // The materials-ordered date is read-only here. The Materials ordered button lives in the
  // Orders section (renderOrdersSummary).
  function fillMaterials(node, v) {
    node.__when.textContent = v ? fmtDate(v) : "Not yet";
  }

  // The job's invoices, for anyone who can see accounts.
  async function loadInvoices() {
    if (!invoicesEl) return;
    if (isNew || !can("accounts.view")) {
      invoicesEl.hidden = true;
      return;
    }
    let list;
    try {
      list = await api("/api/invoices/job/" + jobId);
    } catch (e) {
      invoicesEl.hidden = false;
      invoicesBody.replaceChildren(el("p", { class: "muted", text: e.message }));
      return;
    }
    invoicesEl.hidden = false;
    if (!list.length) {
      invoicesBody.replaceChildren(el("p", { class: "muted", text: "No invoices yet." }));
      return;
    }
    const table = el("table", { class: "hs-table jobinv-table" });
    table.append(
      el("thead", {}, el("tr", {}, ...["Invoice", "Number", "Status", "Amount", "Issued", "Due", "Paid"].map((h, i) => el("th", { class: i === 3 ? "num" : "", text: h }))))
    );
    const tb = el("tbody");
    for (const inv of list) {
      const status = inv.overdue ? "Overdue" : inv.status.charAt(0).toUpperCase() + inv.status.slice(1);
      tb.append(
        el(
          "tr",
          {},
          el("td", {}, el("a", { href: "/accounts.html?invoice=" + inv.id, text: INVOICE_KINDS[inv.kind] || inv.kind })),
          el("td", { text: inv.number || "" }),
          el("td", {}, el("span", { class: "hs-badge " + (inv.overdue ? "hs-badge-stop" : INVOICE_BADGE[inv.status] || "hs-badge-na"), text: status })),
          el("td", { class: "num", text: fmtMoneyCents(inv.totalCents) }),
          el("td", { text: fmtDate(inv.issueDate) }),
          el("td", { text: fmtDate(inv.dueDate) }),
          el("td", { text: fmtDate(inv.paidDate) })
        )
      );
    }
    table.append(tb);
    invoicesBody.replaceChildren(el("div", { class: "jobinv-wrap" }, table));
  }

  function renderMeta() {
    metaEl.replaceChildren();
    if (!job) return;
    const bits = [];
    bits.push(`Source: ${job.source === "board_quick_add" ? "board quick add" : job.source}`);
    if (job.createdAt) bits.push(`Created: ${String(job.createdAt).slice(0, 10)}`);
    if (job.stageChangedAt) bits.push(`Stage changed: ${job.stageChangedAt.slice(0, 10)}`);
    if (job.onBoardWeeks && job.onBoardWeeks.length) bits.push("On board weeks: " + job.onBoardWeeks.map(fmtDate).join(", "));
    if (job.inBacklog) bits.push("In the To start list");
    for (const b of bits) metaEl.append(el("span", { text: b }));
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg || "";
    statusEl.className = "status " + (kind || "muted");
  }

  // Build the request body: everything on create, only changed fields on edit.
  function collect() {
    const body = {};
    for (const g of GROUPS) {
      for (const f of g.fields) {
        const node = inputs[f.key];
        if (!node) continue;
        // Read-only: the server answers 400 if materialsOrderedDate is sent on create or edit.
        if (f.type === "materials") continue;
        const v = fromInput(f, node);
        if (isNew) {
          if (f.key === "name") {
            if (v == null) throw new Error("Job name is required");
            body.name = v;
          } else if (f.key === "stage") {
            if (v && v !== "lead") body.stage = v;
          } else if (f.key === "archived") {
            if (v) body.archived = true;
          } else if (v != null && v !== "") {
            body[f.key] = v;
          }
        } else {
          // The stage goes by its own request after the fields (see onSubmit).
          if (f.key === "stage") continue;
          if (f.key === "name" && v == null) throw new Error("Job name is required");
          const before = job[f.key];
          // Only send what changed (valueCents is absent from `job` without jobs.value, and is then not rendered).
          if ((v ?? null) !== (before ?? null)) body[f.key] = v;
        }
      }
    }
    return body;
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    if (!can("jobs.edit")) return;
    let body;
    try {
      body = collect();
    } catch (e) {
      setStatus(e.message, "err");
      return;
    }
    // The chosen stage, when it differs from the saved one (existing jobs only).
    const newStage = isNew || !inputs.stage ? null : fromInput({ type: "stage" }, inputs.stage);
    // The stage as this page last saw it, taken before the field PATCH (which returns the
    // current job): a concurrent move then shows up as a 409 instead of being overwritten.
    const seenStage = isNew ? null : job.stage;
    const stageChanged = !isNew && !!newStage && newStage !== seenStage;
    const hasFields = Object.keys(body).length > 0;
    if (!isNew && !hasFields && !stageChanged) {
      setStatus("No changes to save.", "muted");
      return;
    }
    saveBtn.disabled = true;
    setStatus("Saving...", "muted");
    try {
      if (isNew) {
        const created = await api("/api/job-records", { method: "POST", body: JSON.stringify(body) });
        location.replace("/job.html?id=" + created.id);
        return;
      }
      if (hasFields) job = await api("/api/job-records/" + jobId, { method: "PATCH", body: JSON.stringify(body) });
      let stageError = null;
      if (stageChanged) {
        try {
          const isAdmin = can("users.admin");
          const viaStage = MANUAL.includes(newStage) && allowedTargets(seenStage).includes(newStage);
          if (viaStage || !isAdmin) {
            // The pipeline path. A non-admin's other moves also go here, so the server gives the reason.
            job = await api("/api/job-records/" + jobId + "/stage", {
              method: "POST",
              body: JSON.stringify({ stage: newStage, from: seenStage }),
            });
          } else {
            // The admin's override: a derived stage, or a move out of a locked stage.
            job = await api("/api/job-records/" + jobId, { method: "PATCH", body: JSON.stringify({ stage: newStage }) });
          }
        } catch (e) {
          stageError = e.message;
          // Show where the job really is.
          try { job = await api("/api/job-records/" + jobId); } catch (e2) { /* keep the last copy */ }
        }
      }
      titleEl.textContent = job.name;
      document.title = job.name + " - Crosscuts";
      fill();
      renderMeta();
      renderInspection(); // two-pac may have changed
      if (stageError) {
        setStatus((hasFields ? "Saved, but the stage was not changed: " : "The stage was not changed: ") + stageError, "err");
      } else {
        setStatus("Saved.", "ok");
      }
    } catch (e) {
      setStatus(e.message, "err");
    } finally {
      saveBtn.disabled = false;
    }
  }

  // =====================================================================================
  // Orders, Inspection and Photos sections (docs/plans/m3-contracts.md section 6).
  // Each is a section.jo-sec with an hs-sectionbar heading; the ids are the bell-link targets.
  // =====================================================================================
  const $ = (id) => document.getElementById(id);
  const ordersEl = $("orders");
  const inspectionEl = $("inspection");
  const photosEl = $("photos");
  let sectionsReady = false;

  // A fetch that keeps api()'s 401 -> login redirect, for the multipart upload (api() forces a JSON
  // content type). The promise never resolves when the page is navigating away.
  async function authFetch(url, options) {
    const res = await fetch(url, options);
    if (res.status === 401 && !location.pathname.startsWith("/login.html")) {
      const body = await res.clone().json().catch(() => ({}));
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = (body.locked ? "/login.html?locked=1&next=" : "/login.html?next=") + next;
      return new Promise(() => {});
    }
    return res;
  }

  function setLine(node, msg, kind) {
    node.textContent = msg || "";
    node.className = "jo-status " + (kind || "muted");
  }

  // A modal on the shell's cc-dialog frame. `build(dlg)` fills it.
  function openDialog(label, build) {
    const dlg = el("dialog", { class: "cc-dialog jo-dialog", "aria-label": label });
    document.body.append(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.addEventListener("mousedown", (e) => {
      if (e.target === dlg) dlg.close();
    });
    build(dlg);
    dlg.showModal();
    return dlg;
  }

  // Resolves true only when the confirm button is pressed. Red is for this destructive confirm.
  function confirmDialog(title, note, confirmLabel, keepLabel) {
    return new Promise((resolve) => {
      let answer = false;
      const dlg = openDialog(title, (d) => {
        const keep = el("button", { type: "button", class: "hs-btn", text: keepLabel });
        const yes = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: confirmLabel });
        keep.addEventListener("click", () => d.close());
        yes.addEventListener("click", () => {
          answer = true;
          d.close();
        });
        d.append(
          el(
            "div",
            { class: "cc-dialog-form" },
            el("h2", { class: "cc-dialog-title", text: title }),
            el("p", { class: "cc-dialog-note", text: note }),
            el("div", { class: "cc-dialog-actions" }, keep, yes)
          )
        );
      });
      dlg.addEventListener("close", () => resolve(answer));
    });
  }

  function tableWrap(table) {
    return el("div", { class: "jo-wrap" }, table);
  }
  function headRow(labels) {
    return el("thead", {}, el("tr", {}, ...labels.map((h) => el("th", { text: h }))));
  }

  // Keeps the job copy and the form's Materials ordered field in step with a mutation's response,
  // without touching anything the user has typed in the form. A progress invoice may now be due.
  function applyJobState(s) {
    if (!s || !job) return;
    job.materialsOrderedDate = s.materialsOrderedDate;
    job.materialsInDate = s.materialsInDate;
    if (inputs.materialsOrderedDate) fillMaterials(inputs.materialsOrderedDate, job.materialsOrderedDate);
    renderOrdersSummary();
    loadInvoices();
  }

  // ---- Orders --------------------------------------------------------------------------
  const ORDER_STATUS = {
    to_order: ["To order", "hs-badge-check"],
    ordered: ["Ordered", "hs-badge-teal"],
    received: ["Received", "hs-badge-go"],
    cancelled: ["Cancelled", "hs-badge-na"],
  };
  let orders = [];
  let showCancelled = false;

  // Which buttons a line gets: the permission table in m3-contracts.md section 2. The server checks too.
  function lineActions(o) {
    const acts = [];
    if (o.status === "to_order" && can("orders.mark_ordered")) {
      acts.push({ label: "Mark ordered", patch: { status: "ordered" }, done: "Marked ordered", primary: true });
    }
    if (o.status === "ordered") {
      if (can("orders.edit")) acts.push({ label: "Received", patch: { status: "received" }, done: "Marked received", primary: true });
      if (can("orders.mark_ordered")) acts.push({ label: "Undo", patch: { status: "to_order" }, done: "Moved back to To order" });
    }
    if (o.status === "received" && can("orders.edit")) {
      acts.push({ label: "Undo", patch: { status: "ordered" }, done: "Moved back to Ordered" });
    }
    if (o.status !== "cancelled" && can("orders.edit")) acts.push({ label: "Cancel", cancel: true, done: "Line cancelled" });
    return acts;
  }

  function renderOrdersSummary() {
    const box = $("ordersSummary");
    if (!box || !job) return;
    const ordered = el(
      "div",
      { class: "jo-sumitem" },
      el("span", { class: "jo-sumlabel", text: "Materials ordered" }),
      el("span", { class: "jo-sumval", text: job.materialsOrderedDate ? fmtDate(job.materialsOrderedDate) : "Not yet" })
    );
    if (!job.materialsOrderedDate && can("orders.mark_ordered")) {
      const btn = el("button", { type: "button", class: "hs-btn", text: "Materials ordered" });
      btn.addEventListener("click", onMaterialsOrdered);
      ordered.append(btn);
    }
    const inn = el(
      "div",
      { class: "jo-sumitem" },
      el("span", { class: "jo-sumlabel", text: "Materials in" }),
      el("span", { class: "jo-sumval", text: job.materialsInDate ? fmtDate(job.materialsInDate) : "Not yet" })
    );
    box.replaceChildren(ordered, inn);
  }

  async function onMaterialsOrdered(ev) {
    const btn = ev.currentTarget;
    btn.disabled = true;
    const status = $("ordersStatus");
    setLine(status, "Marking materials ordered...", "muted");
    try {
      const j = await api("/api/job-records/" + jobId + "/materials-ordered", { method: "POST", body: "{}" });
      applyJobState(j);
      setLine(status, "Materials marked ordered.", "ok");
    } catch (e) {
      setLine(status, e.message, "err");
      btn.disabled = false;
    }
  }

  function renderOrders() {
    const body = $("ordersBody");
    if (!orders.length) {
      body.replaceChildren(el("p", { class: "muted jo-empty", text: showCancelled ? "No order lines." : "No order lines yet." }));
      return;
    }
    const table = el("table", { class: "hs-table jo-table jo-orders" });
    table.append(headRow(["Supplier", "Description", "Status", "Expected", "Dates", "Actions"]));
    const tb = el("tbody");
    for (const o of orders) {
      const [label, badge] = ORDER_STATUS[o.status] || [o.status, "hs-badge-na"];
      const expected = el("td", { class: o.overdue ? "jo-overdue" : "" });
      if (o.expectedDate) expected.append(document.createTextNode(fmtDate(o.expectedDate)));
      if (o.overdue) expected.append(el("span", { class: "jo-overdue-tag", text: "Overdue" }));
      const actions = el("td", { class: "jo-acts" });
      for (const a of lineActions(o)) {
        const btn = el("button", { type: "button", class: "hs-btn" + (a.primary ? " hs-btn-primary" : ""), text: a.label });
        btn.addEventListener("click", () => runLineAction(o, a));
        actions.append(btn);
      }
      tb.append(
        el(
          "tr",
          { class: o.status === "cancelled" ? "jo-cancelled" : "" },
          el("td", { class: "jo-strong", text: o.supplier }),
          el("td", { class: "jo-text" }, document.createTextNode(o.description), o.notes ? el("span", { class: "jo-note", text: o.notes }) : null),
          el("td", {}, el("span", { class: "hs-badge " + badge, text: label })),
          expected,
          el(
            "td",
            { class: "jo-dates" },
            o.orderedDate ? el("span", { text: "Ordered " + fmtDate(o.orderedDate) }) : null,
            o.receivedDate ? el("span", { text: "Received " + fmtDate(o.receivedDate) }) : null
          ),
          actions
        )
      );
    }
    table.append(tb);
    body.replaceChildren(tableWrap(table));
  }

  async function loadOrders() {
    try {
      orders = await api("/api/job-records/" + jobId + "/orders?all=" + (showCancelled ? "1" : "0"));
    } catch (e) {
      setLine($("ordersStatus"), e.message, "err");
      return;
    }
    renderOrders();
  }

  async function loadSuppliers() {
    try {
      const list = await api("/api/orders/suppliers");
      $("oSuppliers").replaceChildren(...list.map((s) => el("option", { value: s })));
    } catch (e) {
      /* the datalist is a convenience */
    }
  }

  async function runLineAction(o, a) {
    const status = $("ordersStatus");
    if (a.cancel) {
      const what = o.supplier + (o.description ? " - " + o.description : "");
      const ok = await confirmDialog("Cancel this order line?", what + ". The line stays on the job, marked cancelled.", "Cancel line", "Keep line");
      if (!ok) return;
    }
    for (const b of $("ordersBody").querySelectorAll("button")) b.disabled = true;
    setLine(status, "Saving...", "muted");
    try {
      const r = a.cancel
        ? await api("/api/orders/" + o.id + "/cancel", { method: "POST", body: "{}" })
        : await api("/api/orders/" + o.id, { method: "PATCH", body: JSON.stringify(a.patch) });
      applyJobState(r.job);
      setLine(status, a.done + ".", "ok");
    } catch (e) {
      setLine(status, e.message, "err");
    }
    await loadOrders();
  }

  async function onAddLine(ev) {
    ev.preventDefault();
    const status = $("ordersStatus");
    const supplier = $("oSupplier").value.trim();
    if (!supplier) {
      setLine(status, "Supplier is required.", "err");
      $("oSupplier").focus();
      return;
    }
    const btn = $("oAdd");
    btn.disabled = true;
    setLine(status, "Adding...", "muted");
    try {
      const r = await api("/api/job-records/" + jobId + "/orders", {
        method: "POST",
        body: JSON.stringify({
          supplier,
          description: $("oDesc").value.trim(),
          expectedDate: $("oExpected").value || null,
          notes: $("oNotes").value.trim(),
        }),
      });
      for (const id of ["oSupplier", "oDesc", "oExpected", "oNotes"]) $(id).value = "";
      applyJobState(r.job);
      setLine(status, "Line added.", "ok");
      loadSuppliers();
      await loadOrders();
    } catch (e) {
      setLine(status, e.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Inspection ------------------------------------------------------------------------
  const INSPECTION_STATUS = {
    booked: ["Booked", "hs-badge-teal"],
    done: ["Done", "hs-badge-go"],
    cancelled: ["Cancelled", "hs-badge-na"],
  };
  let inspections = [];
  let inspectionsAllowed = true;

  // Shown for two-pac jobs, or for any job that has an inspection.
  function renderInspection() {
    if (!sectionsReady || isNew || !job) return;
    const show = inspectionsAllowed && (job.isTwoPac === true || inspections.length > 0);
    inspectionEl.hidden = !show;
    if (!show) return;
    const canEdit = can("inspections.edit");
    $("inspectionForm").hidden = !canEdit;
    const body = $("inspectionBody");
    if (!inspections.length) {
      body.replaceChildren(el("p", { class: "muted jo-empty", text: "No inspection booked." }));
      return;
    }
    const table = el("table", { class: "hs-table jo-table jo-insp" });
    table.append(headRow(["Date", "Time", "Host", "Notes", "Status", "Actions"]));
    const tb = el("tbody");
    for (const i of inspections) {
      const [label, badge] = INSPECTION_STATUS[i.status] || [i.status, "hs-badge-na"];
      const actions = el("td", { class: "jo-acts" });
      if (canEdit && i.status !== "cancelled") {
        const edit = el("button", { type: "button", class: "hs-btn", text: "Edit" });
        edit.addEventListener("click", () => editInspection(i));
        actions.append(edit);
        if (i.status === "booked") {
          const done = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Done" });
          done.addEventListener("click", () => inspectionAction(i, "done"));
          const cancel = el("button", { type: "button", class: "hs-btn", text: "Cancel" });
          cancel.addEventListener("click", () => inspectionAction(i, "cancel"));
          actions.append(done, cancel);
        }
      }
      tb.append(
        el(
          "tr",
          { class: i.status === "cancelled" ? "jo-cancelled" : "" },
          el("td", { class: "jo-strong", text: fmtDate(i.date) }),
          el("td", { text: i.time || "" }),
          el("td", { text: i.host }),
          el("td", { class: "jo-text", text: i.notes }),
          el("td", {}, el("span", { class: "hs-badge " + badge, text: label })),
          actions
        )
      );
    }
    table.append(tb);
    body.replaceChildren(tableWrap(table));
  }

  async function loadInspections() {
    try {
      inspections = await api("/api/job-records/" + jobId + "/inspections");
      inspectionsAllowed = true;
    } catch (e) {
      inspections = [];
      inspectionsAllowed = false; // no access to inspections: the section stays out of the way
    }
    renderInspection();
  }

  async function inspectionAction(i, what) {
    const status = $("inspectionStatus");
    if (what === "cancel") {
      const ok = await confirmDialog(
        "Cancel this inspection?",
        fmtDate(i.date) + (i.time ? " at " + i.time : "") + (i.host ? ", host " + i.host : "") + ". Scheduling is told it was cancelled.",
        "Cancel inspection",
        "Keep inspection"
      );
      if (!ok) return;
    }
    for (const b of $("inspectionBody").querySelectorAll("button")) b.disabled = true;
    setLine(status, "Saving...", "muted");
    try {
      if (what === "done") await api("/api/inspections/" + i.id, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
      else await api("/api/inspections/" + i.id + "/cancel", { method: "POST", body: "{}" });
      setLine(status, what === "done" ? "Marked done." : "Inspection cancelled.", "ok");
    } catch (e) {
      setLine(status, e.message, "err");
    }
    await loadInspections();
  }

  function dlgField(id, label, input) {
    input.id = id;
    return el("div", { class: "cc-field" }, el("label", { class: "cc-field-label", for: id, text: label }), input);
  }

  function editInspection(i) {
    openDialog("Edit inspection", (d) => {
      const date = el("input", { class: "hs-input", type: "date", required: true });
      const time = el("input", { class: "hs-input", type: "time" });
      const host = el("input", { class: "hs-input", type: "text", maxlength: "200", autocomplete: "off" });
      const notes = el("textarea", { class: "hs-input", rows: "3" });
      date.value = i.date || "";
      time.value = i.time || "";
      host.value = i.host || "";
      notes.value = i.notes || "";
      const err = el("p", { class: "cc-dialog-error", role: "alert" });
      const cancel = el("button", { type: "button", class: "hs-btn", text: "Close" });
      const save = el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: "Save" });
      cancel.addEventListener("click", () => d.close());
      const form = el(
        "form",
        { class: "cc-dialog-form", novalidate: true },
        el("h2", { class: "cc-dialog-title", text: "Edit inspection" }),
        dlgField("ie-date", "Date", date),
        dlgField("ie-time", "Time", time),
        dlgField("ie-host", "Host", host),
        dlgField("ie-notes", "Notes", notes),
        err,
        el("div", { class: "cc-dialog-actions" }, cancel, save)
      );
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (!date.value) {
          err.textContent = "Date is required.";
          return;
        }
        save.disabled = true;
        err.textContent = "";
        try {
          await api("/api/inspections/" + i.id, {
            method: "PATCH",
            body: JSON.stringify({ date: date.value, time: time.value || null, host: host.value.trim(), notes: notes.value.trim() }),
          });
          d.close();
          setLine($("inspectionStatus"), "Inspection saved.", "ok");
          await loadInspections();
        } catch (e) {
          err.textContent = e.message;
          save.disabled = false;
        }
      });
      d.append(form);
    });
  }

  async function onBook(ev) {
    ev.preventDefault();
    const status = $("inspectionStatus");
    const date = $("iDate").value;
    if (!date) {
      setLine(status, "Date is required.", "err");
      $("iDate").focus();
      return;
    }
    const btn = $("iBook");
    btn.disabled = true;
    setLine(status, "Booking...", "muted");
    try {
      await api("/api/job-records/" + jobId + "/inspections", {
        method: "POST",
        body: JSON.stringify({ date, time: $("iTime").value || null, host: $("iHost").value.trim(), notes: $("iNotes").value.trim() }),
      });
      for (const id of ["iDate", "iTime", "iNotes"]) $(id).value = "";
      setLine(status, "Inspection booked.", "ok");
      await loadInspections();
    } catch (e) {
      setLine(status, e.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Photos ----------------------------------------------------------------------------
  let photos = [];

  function renderPhotos() {
    const body = $("photosBody");
    if (!photos.length) {
      body.replaceChildren(el("p", { class: "muted jo-empty", text: "No photos linked to this job yet." }));
      return;
    }
    const grid = el("div", { class: "jo-photos" });
    for (const p of photos) {
      const img = el("img", { src: p.thumbUrl, alt: p.tags ? p.tags : "Job photo", loading: "lazy" });
      if (p.width && p.height) {
        img.setAttribute("width", String(p.width));
        img.setAttribute("height", String(p.height));
      }
      const a = el("a", { class: "jo-thumb", href: p.url, target: "_blank", rel: "noopener", title: p.tags || "Open the full photo" }, img);
      grid.append(el("figure", { class: "jo-photo" }, a, p.tags ? el("figcaption", { text: p.tags }) : null));
    }
    body.replaceChildren(grid);
  }

  async function loadPhotos() {
    try {
      photos = await api("/api/photos?jobId=" + jobId);
    } catch (e) {
      setLine($("photosStatus"), e.message, "err");
      return;
    }
    renderPhotos();
  }

  async function onUpload(ev) {
    ev.preventDefault();
    const status = $("photosStatus");
    const files = $("pFiles").files;
    if (!files || !files.length) {
      setLine(status, "Choose at least one photo.", "err");
      return;
    }
    const btn = $("pUpload");
    btn.disabled = true;
    setLine(status, "Uploading " + files.length + (files.length === 1 ? " photo..." : " photos..."), "muted");
    try {
      const fd = new FormData();
      fd.append("jobId", String(jobId));
      fd.append("tags", $("pTags").value);
      for (const f of files) fd.append("photos", f);
      const res = await authFetch("/api/photos", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed (" + res.status + ")");
      const made = (data.created || []).length;
      const failed = (data.failed || []).length;
      setLine(status, "Uploaded " + made + (made === 1 ? " photo" : " photos") + (failed ? ", " + failed + " failed." : "."), failed ? "err" : "ok");
      $("pFiles").value = "";
      $("pTags").value = "";
      await loadPhotos();
    } catch (e) {
      setLine(status, e.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Tasks and Comments (docs/plans/m4-contracts.md section 6) -----------------------------
  // The widgets are shared: ccTasks (taskui.js) is the task dialog, ccComments (comments.js) the thread.
  const tasksEl = $("tasks");
  const commentsEl = $("comments");
  let tasksSeq = 0;

  function dueText(t) {
    return t.dueDate ? fmtDate(t.dueDate) : "No date";
  }

  function renderTasks(rows) {
    const body = $("tasksBody");
    if (!rows.length) {
      body.replaceChildren(el("p", { class: "muted jo-empty", text: "No tasks on this job yet." }));
      return;
    }
    const table = el("table", { class: "hs-table jo-table jo-tasks" });
    table.append(headRow(["Task", "For", "Due", "Status"]));
    const tb = el("tbody");
    for (const t of rows) {
      const open = t.status === "open";
      const openIt = () => openTaskDialog(t.id);
      const title = el("button", { type: "button", class: "jo-linkbtn", text: t.title });
      title.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openIt();
      });
      const due = el("td", { class: t.overdue ? "jo-overdue-red" : "" });
      due.append(document.createTextNode(dueText(t)));
      if (t.overdue) due.append(el("span", { class: "jo-overdue-tag jo-overdue-red", text: "Overdue" }));
      const [label, badge] = open ? ["Open", "hs-badge-teal"] : t.status === "done" ? ["Done", "hs-badge-go"] : ["Cancelled", "hs-badge-na"];
      const tr = el(
        "tr",
        { class: "jo-taskrow" + (open ? "" : " jo-cancelled") },
        el("td", { class: "jo-strong jo-text" }, title),
        el("td", { text: t.assignee ? t.assignee.name : "" }),
        due,
        el("td", {}, el("span", { class: "hs-badge " + badge, text: label }))
      );
      tr.addEventListener("click", openIt);
      tb.append(tr);
    }
    table.append(tb);
    $("tasksBody").replaceChildren(tableWrap(table));
  }

  async function loadTasks() {
    const mine = ++tasksSeq;
    let data;
    try {
      data = await api("/api/tasks?view=job&jobId=" + jobId);
    } catch (e) {
      if (mine === tasksSeq) setLine($("tasksStatus"), e.message, "err");
      return;
    }
    if (mine !== tasksSeq) return;
    setLine($("tasksStatus"), "", "muted");
    renderTasks(data.rows || []);
  }

  function openTaskDialog(id) {
    if (window.ccTasks) window.ccTasks.openTask(id, { onChange: loadTasks });
  }

  function onNewTask() {
    if (window.ccTasks) window.ccTasks.newTask({ jobId: jobId, jobName: job ? job.name : "", onChange: loadTasks });
  }

  function startTasksAndComments(list) {
    if (can("tasks.use")) {
      tasksEl.hidden = false;
      $("newTask").addEventListener("click", onNewTask);
      list.push(loadTasks());
    }
    if (can("jobs.view")) {
      commentsEl.hidden = false;
      if (window.ccComments) {
        window.ccComments.mount($("commentsBody"), "job", jobId, { canWrite: can("messages.use") });
      }
    }
  }

  // ---- start-up --------------------------------------------------------------------------
  // Permissions come from the shell, so wait for it before deciding what to show.
  async function pageReady() {
    if (document.readyState !== "complete") await new Promise((r) => window.addEventListener("load", r, { once: true }));
    if (window.cc && window.cc.ready) await window.cc.ready;
  }

  function jumpToHash() {
    if (location.hash.length < 2) return;
    let id = location.hash.slice(1);
    try { id = decodeURIComponent(id); } catch (e) { /* use as is */ }
    const target = document.getElementById(id);
    if (target && !target.hidden) target.scrollIntoView();
  }

  async function startSections() {
    await pageReady();
    sectionsReady = true;
    const tasks = [];
    if (can("jobs.view")) {
      ordersEl.hidden = false;
      renderOrdersSummary();
      $("orderForm").hidden = !can("orders.edit");
      $("orderForm").addEventListener("submit", onAddLine);
      $("showCancelled").addEventListener("click", (ev) => {
        showCancelled = !showCancelled;
        ev.currentTarget.setAttribute("aria-pressed", showCancelled ? "true" : "false");
        ev.currentTarget.classList.toggle("hs-btn-quiet", !showCancelled);
        ev.currentTarget.classList.toggle("hs-btn-primary", showCancelled);
        loadOrders();
      });
      tasks.push(loadOrders());
      if (can("orders.edit")) tasks.push(loadSuppliers());
    }
    if (can("jobs.view") || can("scheduling.view")) {
      $("inspectionForm").addEventListener("submit", onBook);
      const me = window.cc && window.cc.me;
      if (me && me.displayName && !$("iHost").value) $("iHost").value = me.displayName;
      tasks.push(loadInspections());
    }
    if (can("photos.search") || can("photos.admin")) {
      photosEl.hidden = false;
      $("photoForm").hidden = !can("photos.admin");
      $("photoForm").addEventListener("submit", onUpload);
      tasks.push(loadPhotos());
    }
    startTasksAndComments(tasks);
    tasks.push(loadInvoices()); // the Invoices section sits below Comments; settle its height before the jump
    await Promise.allSettled(tasks);
    jumpToHash();
  }

  async function init() {
    if (isNew) {
      titleEl.textContent = "New job";
      document.title = "New job - Crosscuts";
      buildForm();
      fill();
    } else {
      try {
        job = await api("/api/job-records/" + jobId);
      } catch (e) {
        titleEl.textContent = "Job not found";
        formEl.replaceChildren(el("p", { class: "muted", text: e.message }));
        return;
      }
      titleEl.textContent = job.name;
      document.title = job.name + " - Crosscuts";
      buildForm();
      fill();
      renderMeta();
      loadInvoices();
      startSections();
    }
    formEl.addEventListener("submit", onSubmit);
    // The shell may finish loading permissions after first paint.
    window.addEventListener("load", applyAccess);
    document.addEventListener("cc:ready", () => {
      applyAccess();
      loadInvoices();
    });
  }

  init();
})();
