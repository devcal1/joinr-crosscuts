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
      const status = inv.overdue
        ? "Overdue"
        : inv.status === "pending" && inv.kind !== "extra"
          ? "Needs value"
          : inv.status.charAt(0).toUpperCase() + inv.status.slice(1);
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
  let ordersBusy = false;

  // The buttons a line may get, in the order they show (docs/plans/m10-contracts.md section 9.3).
  // Which ones a line gets comes from OrderUI.actions(); the server decides (lib/orders.js).
  // `dialog` ones open OrderUI (orderui.js); the rest are built here. `next` is where focus goes
  // on the same line after the action (the first that is there after the reload), else the row.
  const ORDER_ACTS = [
    { id: "markOrdered", label: "Mark ordered", primary: true, next: ["receive", "undoOrdered", "note", "edit"] },
    { id: "receive", label: "Received", primary: true, dialog: true, next: ["undoReceived", "note", "edit"] },
    { id: "note", label: "Delivery note", dialog: true, next: ["note"] },
    { id: "edit", label: "Edit", dialog: true, next: ["edit"] },
    { id: "undoOrdered", label: "Undo ordered", next: ["markOrdered", "edit"] },
    { id: "undoReceived", label: "Undo received", dialog: true, next: ["receive", "note", "edit"] },
    { id: "cancel", label: "Cancel", aria: "Cancel line", next: [] },
  ];
  const ORDER_ACT = Object.fromEntries(ORDER_ACTS.map((a) => [a.id, a]));

  function orderLineName(o) {
    return o.supplier + (o.description ? ", " + o.description : "");
  }

  // The Actions column shows for anyone who may change a line in some way.
  function orderActionsShown() {
    return can("orders.edit") || can("orders.mark_ordered") || can("orders.receive");
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
    // A line's buttons sit in a row of their own under it, across the whole table: the job page
    // is narrow, and an Actions column there left five buttons stacked in a cramped cell
    // (review 4.2). The line and its buttons row read as one (no rule between them).
    const showActs = orderActionsShown();
    const table = el("table", { class: "hs-table jo-table jo-orders" });
    const heads = ["Supplier", "Description", "Status", "Expected", "Ordered", "Received"];
    table.append(headRow(heads));
    const tb = el("tbody");
    for (const o of orders) {
      const [label, badge] = ORDER_STATUS[o.status] || [o.status, "hs-badge-na"];
      // The dates sit in jo-dates cells (one line each, the same size).
      const expected = el("td", { class: "jo-dates" + (o.overdue ? " jo-overdue" : "") });
      if (o.expectedDate) expected.append(el("span", { text: fmtDate(o.expectedDate) }));
      if (o.overdue) expected.append(el("span", { class: "jo-overdue-tag", text: "Overdue" }));
      // The received date, and under it who marked it received (when known).
      const received = el("td", { class: "jo-dates" });
      if (o.receivedDate) {
        received.append(el("span", { text: fmtDate(o.receivedDate) }));
        if (o.receivedBy && o.receivedBy.name) received.append(el("span", { class: "jo-note", text: o.receivedBy.name }));
      }
      // The description, the line's notes and its delivery note (OrderUI's block).
      const note = window.OrderUI ? window.OrderUI.noteBlock(o) : null;
      const desc = el(
        "td",
        { class: "jo-text" },
        document.createTextNode(o.description || ""),
        o.notes ? el("span", { class: "jo-note", text: o.notes }) : null,
        note ? el("div", { class: "jo-note" }, note) : null
      );
      const tr = el(
        "tr",
        { class: o.status === "cancelled" ? "jo-cancelled" : "", "data-id": String(o.id), tabindex: "-1" },
        el("td", { class: "jo-strong", text: o.supplier }),
        desc,
        el("td", {}, el("span", { class: "hs-badge " + badge, text: label })),
        expected,
        el("td", { class: "jo-dates" }, o.orderedDate ? el("span", { text: fmtDate(o.orderedDate) }) : null),
        received
      );
      tb.append(tr);
      if (showActs) {
        const may = window.OrderUI ? window.OrderUI.actions(o) : {};
        const box = el("div", { class: "jo-oacts" });
        for (const a of ORDER_ACTS) {
          if (!may[a.id]) continue;
          box.append(el("button", {
            type: "button",
            class: "hs-btn" + (a.primary ? " hs-btn-primary" : ""),
            "data-act": a.id,
            "data-id": String(o.id),
            "aria-label": (a.aria || a.label) + ": " + orderLineName(o),
            text: a.label,
          }));
        }
        if (box.childElementCount) {
          tr.classList.add("jo-hasacts");
          tb.append(el("tr", { class: "jo-actrow", "data-for": String(o.id) }, el("td", { colspan: String(heads.length) }, box)));
        }
      }
    }
    table.append(tb);
    body.replaceChildren(tableWrap(table));
  }

  // ---- focus after an order action: the same line's next action, or its row; when the line
  // has left the list (cancelled, with cancelled lines hidden), the next line's first action or
  // row, then the one before; else the section heading.
  function orderButton(id, act) {
    return $("ordersBody").querySelector(`button[data-act="${act}"][data-id="${id}"]`);
  }
  function orderRow(id) {
    return $("ordersBody").querySelector(`tr[data-id="${id}"]`);
  }
  function focusNode(n) {
    if (!n) return false;
    n.focus();
    return document.activeElement === n;
  }
  function focusOrderAfter(id, act, before) {
    for (const next of ORDER_ACT[act].next) if (focusNode(orderButton(id, next))) return;
    if (focusNode(orderRow(id))) return;
    const at = before.indexOf(id);
    for (const other of before.slice(at + 1).concat(before.slice(0, Math.max(at, 0)).reverse())) {
      // A line's first button (in its buttons row), or the line itself.
      if (focusNode($("ordersBody").querySelector(`button[data-act][data-id="${other}"]`)) || focusNode(orderRow(other))) return;
    }
    const h = $("orders-h");
    if (h) {
      h.setAttribute("tabindex", "-1");
      focusNode(h);
    }
  }

  // Resolves true when the list was replaced (and rendered); false when it failed (its sentence
  // shown in the status line).
  async function loadOrders() {
    try {
      orders = await api("/api/job-records/" + jobId + "/orders?all=" + (showCancelled ? "1" : "0"));
    } catch (e) {
      setLine($("ordersStatus"), e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message, "err");
      return false;
    }
    renderOrders();
    return true;
  }

  // Reloads after an order action. When the reload fails, the lines on screen are drawn again
  // (with the changed line from the response, `r`, and with the buttons a one-click action
  // disabled working again) and the reload's sentence follows `said`.
  async function reloadOrdersAfter(said, kind, r) {
    setLine($("ordersStatus"), said, kind);
    if (await loadOrders()) return;
    const why = $("ordersStatus").textContent;
    const after = r && r.order;
    if (after) orders = orders.map((l) => (l.id === after.id ? Object.assign({}, l, after) : l));
    renderOrders();
    setLine($("ordersStatus"), said ? said + " " + why : why, "err");
  }

  async function loadSuppliers() {
    try {
      const list = await api("/api/orders/suppliers");
      $("oSuppliers").replaceChildren(...list.map((s) => el("option", { value: s })));
    } catch (e) {
      /* the datalist is a convenience */
    }
  }

  function orderSaid(act, o, r) {
    const name = orderLineName(o);
    const after = (r && r.order) || {};
    switch (act) {
      case "markOrdered": return "Marked ordered: " + name + ".";
      case "undoOrdered": return "Back to To order: " + name + ".";
      case "receive": return "Received: " + name + ".";
      case "note": return (after.deliveryNote ? "Delivery note saved: " : "Delivery note cleared: ") + name + ".";
      case "undoReceived": return "Back to ordered: " + name + ".";
      case "edit": return "Saved: " + name + ".";
      case "cancel": return "Line cancelled: " + name + ".";
      default: return "Saved.";
    }
  }

  // One order action. Received, Delivery note, Undo received and Edit open OrderUI's dialogs
  // (which show a refusal inside the dialog); Mark ordered, its Undo and Cancel are built here.
  async function runOrderAction(act, id, opener) {
    if (ordersBusy || !ORDER_ACT[act]) return;
    const o = orders.find((l) => l.id === id);
    if (!o) return;
    const status = $("ordersStatus");
    ordersBusy = true;
    try {
      const before = orders.map((l) => l.id);
      let r;
      if (ORDER_ACT[act].dialog) {
        r = await window.OrderUI[act](o);
        if (!r) return; // cancelled: OrderUI puts focus back on the button
        if (r.refused) {
          // Refused (its sentence was in the dialog): the line may have changed elsewhere, so show
          // it as it is now, with focus back on the same button if the line still has it.
          // The job's Materials ordered / in dates may have moved with it.
          api("/api/job-records/" + jobId).then(applyJobState, () => {});
          await reloadOrdersAfter("", "muted");
          if (!focusNode(orderButton(id, act))) focusOrderAfter(id, act, before);
          return;
        }
      } else {
        if (act === "cancel") {
          const ok = await confirmDialog("Cancel this order line?", orderLineName(o) + ". The line stays on the job, marked cancelled.", "Cancel line", "Keep line");
          if (!ok) {
            if (opener && opener.isConnected) opener.focus();
            return;
          }
        }
        for (const b of $("ordersBody").querySelectorAll("button")) b.disabled = true;
        setLine(status, "Saving...", "muted");
        try {
          r = act === "cancel"
            ? await api("/api/orders/" + encodeURIComponent(o.id) + "/cancel", { method: "POST", body: "{}" })
            : await api("/api/orders/" + encodeURIComponent(o.id), {
              method: "PATCH",
              body: JSON.stringify({ status: act === "markOrdered" ? "ordered" : "to_order" }),
            });
        } catch (e) {
          await reloadOrdersAfter(e instanceof TypeError ? "Couldn't reach the server. Try again." : e.message, "err");
          if (!focusNode(orderButton(id, act))) focusOrderAfter(id, act, before);
          return;
        }
      }
      applyJobState(r && r.job);
      await reloadOrdersAfter(orderSaid(act, o, r), "ok", r);
      focusOrderAfter(id, act, before);
    } finally {
      ordersBusy = false;
    }
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

  // ---- Planner (docs/plans/m7-contracts.md section 14.3) ------------------------------------
  // The job's hand-made planner events in the next 90 days (at most 20) that this viewer may see:
  // the server applies the planner's layer rules, so no one sees another person's Personal events
  // or another department's. The layer is named in words; the markers belong to the Planner page.
  const plannerEl = $("planner");

  // "09:00" -> "9:00"
  function fmtTime(t) {
    const m = /^(\d{2}):(\d{2})$/.exec(t || "");
    return m ? Number(m[1]) + ":" + m[2] : t || "";
  }

  function renderPlanner(rows, more, labels) {
    const body = $("plannerBody");
    if (!rows.length) {
      body.replaceChildren(el("p", { class: "muted jo-empty", text: "Nothing on the planner for this job." }));
      return;
    }
    const table = el("table", { class: "hs-table jo-table jo-planner" });
    table.append(headRow(["Date", "Event", "Layer", ""]));
    const tb = el("tbody");
    for (const it of rows) {
      const date = el("td", { class: "jo-strong jo-dates" });
      date.append(el("span", { text: fmtDate(it.start) + (it.end && it.end !== it.start ? " – " + fmtDate(it.end) : "") }));
      const time = it.allDay || !it.startTime ? "All day" : fmtTime(it.startTime) + (it.endTime ? "–" + fmtTime(it.endTime) : "");
      date.append(el("span", { class: "jo-note", text: time }));
      const open = el("a", {
        class: "hs-btn",
        href: "/planner.html?date=" + encodeURIComponent(it.start) + "&event=" + encodeURIComponent(it.id),
        text: "Open",
      });
      open.setAttribute("aria-label", "Open " + it.title + " in the planner");
      tb.append(
        el(
          "tr",
          {},
          date,
          el("td", { class: "jo-text", text: it.title }),
          el("td", { text: labels[it.layer] || it.layer }),
          el("td", { class: "jo-open" }, open)
        )
      );
    }
    table.append(tb);
    const parts = [tableWrap(table)];
    if (more) parts.push(el("p", { class: "muted jo-more", text: "And more on the planner" }));
    body.replaceChildren(...parts);
  }

  async function loadPlanner() {
    let data, meta;
    try {
      [data, meta] = await Promise.all([api("/api/planner/job/" + jobId), api("/api/planner/layers")]);
    } catch (e) {
      setLine($("plannerStatus"), "The planner could not be loaded.", "err");
      return;
    }
    setLine($("plannerStatus"), "", "muted");
    const labels = {};
    for (const l of (meta && meta.layers) || []) labels[l.id] = l.label;
    renderPlanner((data && data.rows) || [], !!(data && data.more), labels);
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
        window.ccComments.mount($("commentsBody"), "job", jobId, { canWrite: can("messages.use"), heading: false });
      }
    }
  }

  // ---- From Joinr (docs/plans/m6-contracts.md section 6) ---------------------------------
  // Shown only when GET /api/joinr/job/:id returns the intake record linked to this job.
  // All Joinr text goes in through textContent; the link is only http(s).
  const joinrEl = $("joinr");
  let joinrSeq = 0;

  function fmtInstant(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return "";
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    return fmtDate(p);
  }
  function agoText(iso) {
    const t = Date.parse(iso || "");
    if (Number.isNaN(t)) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
    const h = Math.round(m / 60);
    if (h < 48) return h + (h === 1 ? " hour ago" : " hours ago");
    return Math.round(h / 24) + " days ago";
  }
  function joinrEventText(it) {
    switch (it.lastEvent) {
      case "unwon": return "Joinr says this quote is no longer won (now " + it.joinrStatus + ").";
      case "deleted": return "This quote was deleted in Joinr.";
      case "won": return "Joinr marked a quote won again (a new revision, or won once more).";
      default: return "This quote was edited in Joinr.";
    }
  }
  function sumItem(label, ...kids) {
    return el("div", { class: "jo-sumitem" }, el("span", { class: "jo-sumlabel", text: label }), ...kids);
  }

  function renderJoinr(it) {
    joinrEl.hidden = false;
    const url = typeof (it.quote && it.quote.url) === "string" && /^https?:\/\/\S+$/i.test(it.quote.url) ? it.quote.url : null;
    const status = String(it.joinrStatus || "");
    const items = [sumItem("Quote number", el("span", { class: "jo-sumval", text: it.quoteNumber || "None" }))];
    if (url) {
      items.push(sumItem("Quote", el("a", { class: "jo-sumval", href: url, target: "_blank", rel: "noopener noreferrer", text: "Open in Joinr" })));
    }
    items.push(
      sumItem("Status in Joinr", el("span", { class: "jo-sumval", text: status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown" })),
      sumItem("Last seen", el("span", { class: "jo-sumval", text: [fmtInstant(it.lastSeenAt), agoText(it.lastSeenAt)].filter(Boolean).join(", ") || "Unknown" }))
    );
    if (it.state === "accepted" || it.state === "linked") {
      const who = it.decidedBy && it.decidedBy.name ? " by " + it.decidedBy.name : "";
      const on = it.decidedAt ? " on " + fmtInstant(it.decidedAt) : "";
      items.push(sumItem("Decision", el("span", { class: "jo-sumval", text: (it.state === "linked" ? "Linked" : "Accepted") + who + on })));
    }
    const nodes = [el("div", { class: "jo-summary jo-joinr" }, ...items)];

    if (it.changed) {
      const note = el(
        "div",
        { class: "hs-callout hs-callout-orange jo-joinr-changed" },
        el("h3", { text: "Changed in Joinr" }),
        el("p", { class: "jo-joinr-p", text: joinrEventText(it) }),
        el("p", { class: "jo-joinr-p muted", text: "This job has not been changed." })
      );
      if (it.differences && it.differences.length) {
        const ul = el("ul", { class: "jo-joinr-diff" });
        for (const d of it.differences) {
          ul.append(el("li", {}, el("b", { text: d.label + ": " }), document.createTextNode("job " + d.job + ", Joinr " + d.joinr)));
        }
        note.append(el("p", { class: "jo-joinr-p muted", text: "Where this job and Joinr now differ:" }), ul);
      }
      if (can("jobs.edit")) {
        const btn = el("button", { type: "button", class: "hs-btn hs-btn-check", text: "Acknowledge" });
        btn.addEventListener("click", () => ackJoinr(it, btn));
        note.append(el("div", { class: "jo-joinr-acts" }, btn));
      }
      nodes.push(note);
    }
    $("joinrBody").replaceChildren(...nodes);
  }

  async function loadJoinr(keepMsg) {
    const mine = ++joinrSeq;
    let res;
    try {
      res = await authFetch("/api/joinr/job/" + jobId, { headers: { Accept: "application/json" } });
    } catch (e) {
      if (mine === joinrSeq) joinrEl.hidden = true;
      return;
    }
    if (mine !== joinrSeq) return;
    if (!res.ok) {
      // 404: not from Joinr. 403 and anything else: nothing to show.
      joinrEl.hidden = true;
      return;
    }
    let it;
    try {
      it = await res.json();
    } catch (e) {
      joinrEl.hidden = true;
      return;
    }
    if (mine !== joinrSeq) return;
    if (!it || typeof it !== "object" || !it.id) {
      joinrEl.hidden = true;
      return;
    }
    if (!keepMsg) setLine($("joinrStatus"), "", "muted");
    renderJoinr(it);
  }

  async function ackJoinr(it, btn) {
    const status = $("joinrStatus");
    btn.disabled = true;
    setLine(status, "Saving...", "muted");
    try {
      await api("/api/joinr/intake/" + it.id + "/acknowledge", { method: "POST", body: "{}" });
      setLine(status, "Acknowledged.", "ok");
    } catch (e) {
      setLine(status, e.message, "err");
      btn.disabled = false;
      return;
    }
    await loadJoinr(true);
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
    if (can("jobs.view")) tasks.push(loadJoinr());
    if (can("jobs.view")) {
      ordersEl.hidden = false;
      renderOrdersSummary();
      $("orderForm").hidden = !can("orders.edit");
      $("orderForm").addEventListener("submit", onAddLine);
      $("ordersBody").addEventListener("click", (ev) => {
        const b = ev.target.closest && ev.target.closest("button[data-act]");
        if (!b || b.disabled) return;
        runOrderAction(b.getAttribute("data-act"), Number(b.getAttribute("data-id")), b);
      });
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
    if (can("planner.view")) {
      plannerEl.hidden = false;
      tasks.push(loadPlanner());
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
