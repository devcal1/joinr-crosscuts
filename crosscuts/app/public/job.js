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
  // type: text | tel | email | textarea | int | bool3 | benchtop | date | url | money | stage | archived
  const GROUPS = [
    {
      title: "Job",
      fields: [
        { key: "name", label: "Job name", type: "text", wide: true, required: true },
        { key: "stage", label: "Stage", type: "stage" },
        { key: "jobType", label: "Job type", type: "text", hint: "e.g. kitchen, vanity, wardrobe" },
      ],
    },
    {
      title: "Client",
      fields: [
        { key: "clientName", label: "Client name", type: "text" },
        { key: "clientPhone", label: "Phone", type: "tel" },
        { key: "clientEmail", label: "Email", type: "email" },
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
        { key: "materialsOrderedDate", label: "Materials ordered", type: "date" },
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
        node = el("textarea", { ...common, class: "jobs-textarea" });
        break;
      case "stage":
        node = el("select", { ...common, class: "jobs-select" });
        for (const [v, label] of STAGES) {
          const opt = el("option", { value: v, text: label + (DERIVED.has(v) ? " (automatic)" : "") });
          node.append(opt);
        }
        break;
      case "bool3":
        node = el("select", { ...common, class: "jobs-select" });
        node.append(el("option", { value: "", text: "Not set" }), el("option", { value: "1", text: "Yes" }), el("option", { value: "0", text: "No" }));
        break;
      case "benchtop":
        node = el("select", { ...common, class: "jobs-select" });
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
      case "date":
        node = el("input", { ...common, class: "jobs-input", type: "date" });
        break;
      case "int":
        node = el("input", { ...common, class: "jobs-input", type: "number", min: "0", step: "1", inputmode: "numeric" });
        break;
      case "money":
        node = el("input", { ...common, class: "jobs-input", type: "text", inputmode: "decimal", placeholder: "0.00" });
        break;
      case "url":
        node = el("input", { ...common, class: "jobs-input", type: "url", placeholder: "https://" });
        break;
      case "tel":
        node = el("input", { ...common, class: "jobs-input", type: "tel" });
        break;
      case "email":
        node = el("input", { ...common, class: "jobs-input", type: "email" });
        break;
      default:
        node = el("input", { ...common, class: "jobs-input", type: "text" });
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
            el("label", { for: node.id, class: "jobs-check", style: "color:var(--color-text);font-size:15px" }, node, document.createTextNode(" " + f.label))
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
      formEl.append(el("fieldset", {}, el("legend", { text: g.title }), grid));
    }

    const actions = el("div", { class: "jobform-actions" });
    statusEl = el("div", { class: "status muted", role: "status" });
    saveBtn = el("button", { type: "submit", class: "jobs-btn primary", text: isNew ? "Create job" : "Save changes" });
    actions.append(statusEl, el("a", { class: "jobs-btn", href: "/jobs.html", text: "Cancel" }), saveBtn);
    formEl.append(actions);
  }

  function fill() {
    for (const g of GROUPS) {
      for (const f of g.fields) {
        const node = inputs[f.key];
        if (!node) continue;
        const v = job ? job[f.key] : f.key === "stage" ? "lead" : null;
        if (f.type === "archived") node.checked = !!v;
        else node.value = toInput(f, v);
        if (node.__sync) node.__sync();
      }
    }
    applyAccess();
  }

  // Read-only for users without jobs.edit; derived stages locked for non-admins.
  function applyAccess() {
    const editable = can("jobs.edit");
    for (const node of Object.values(inputs)) node.disabled = !editable;
    if (inputs.stage && editable) {
      const isAdmin = can("users.admin");
      for (const opt of inputs.stage.options) opt.disabled = DERIVED.has(opt.value) && !isAdmin;
      // A job already in a derived stage keeps showing it, but a non-admin can only move away from it.
      inputs.stage.title = isAdmin ? "" : "On board, Complete and Invoiced are set automatically.";
    }
    if (saveBtn) saveBtn.hidden = !editable;
    bannerEl.replaceChildren(
      ...(editable ? [] : [el("div", { class: "ro-banner", text: "You can view this job but not edit it." })])
    );
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
    if (!isNew && Object.keys(body).length === 0) {
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
      job = await api("/api/job-records/" + jobId, { method: "PATCH", body: JSON.stringify(body) });
      titleEl.textContent = job.name;
      document.title = job.name + " - Crosscuts";
      fill();
      renderMeta();
      setStatus("Saved.", "ok");
    } catch (e) {
      setStatus(e.message, "err");
    } finally {
      saveBtn.disabled = false;
    }
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
    }
    formEl.addEventListener("submit", onSubmit);
    // The shell may finish loading permissions after first paint.
    window.addEventListener("load", applyAccess);
  }

  init();
})();
