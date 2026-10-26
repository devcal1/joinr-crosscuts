// A job's project page (project.html?id=N; docs/plans/m22-project-jobs.md section 5). Everything
// comes from GET /api/job-records/:id/project, which also says what this user may do (can.edit,
// can.setOwner, can.send); the server checks every write again. Lines are the job's materials list
// (lib/materials.js): the hardware and handles sections are the Hardware list, the rest Materials.
// A field saves when it changes. All text goes in through textContent. Page classes are pj-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const jobId = Number(new URLSearchParams(location.search).get("id"));
  const HARDWARE = new Set(["hardware", "handles"]);
  const HOURS_PER_DAY = 8;

  let data = null;
  let owners = [];
  let joinr = null; // {linked, hasJoinrLines} from the materials list
  let busy = false;

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

  function say(id, msg, kind) {
    const n = $(id);
    n.textContent = msg || "";
    n.className = "jo-status " + (kind || "muted");
  }
  const errText = (e) => (e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message);

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney", day: "numeric", month: "numeric", year: "numeric",
    }).formatToParts(d);
    const get = (t) => (p.find((x) => x.type === t) || {}).value;
    return `${get("day")} ${MONTHS[Number(get("month")) - 1]} ${get("year")}`;
  }
  const fmtQty = (q) => (q == null ? "" : String(Math.round(q * 1000) / 1000));
  const fmtHours = (min) => (min == null ? null : Math.round((min / 60) * 10) / 10);
  const STAGE_LABEL = {
    quoted: "Quoted", lead: "Quoted", won: "Won", projects: "Projects", ordering: "Ordering",
    ready_to_cut: "Ready to cut", on_board: "On board", complete: "Complete", invoiced: "Invoiced",
    lost: "Lost", archived: "Archived",
  };

  function sectionLabel(id) {
    const s = data && data.sections.find((x) => x.id === id);
    if (s) return s.label;
    const t = String(id || "").replace(/_/g, " ");
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // ---- loading ---------------------------------------------------------------------------

  async function load() {
    if (!Number.isInteger(jobId) || jobId <= 0) {
      say("pjStatus", "No job given.", "err");
      return;
    }
    try {
      data = await api(`/api/job-records/${jobId}/project`);
    } catch (e) {
      say("pjStatus", "Could not load the project: " + errText(e), "err");
      return;
    }
    say("pjStatus", "");
    render();
    loadSide();
  }

  // The owner list, the supplier suggestions and the Joinr state: conveniences, loaded after.
  async function loadSide() {
    if (data.can.setOwner && !owners.length) {
      try {
        owners = (await api("/api/project-owners")).owners;
        renderHead();
      } catch (e) { /* the owner shows as text */ }
    }
    try {
      const list = await api("/api/orders/suppliers");
      $("pjSuppliers").replaceChildren(...list.map((s) => el("option", { value: s })));
    } catch (e) { /* the datalist is a convenience */ }
    try {
      const m = await api(`/api/job-records/${jobId}/materials`);
      joinr = m.joinr;
      $("pjJoinr").hidden = !(data.can.edit && joinr && joinr.linked);
      $("pjJoinr").textContent = joinr && joinr.hasJoinrLines ? "Update from Joinr" : "Fill from Joinr";
    } catch (e) { /* no Joinr button */ }
  }

  function take(next) {
    const can = data.can;
    data = next;
    data.can = can;
    render();
  }

  function render() {
    const j = data.job;
    $("pjTitle").textContent = j.name;
    document.title = j.name + " - Project - Crosscuts";
    $("pjJob").href = "/job.html?id=" + j.id;
    renderHead();
    renderSteps();
    renderHours();
    renderLines("materials");
    renderLines("hardware");
    renderNotes();
    renderOrder();
    for (const id of ["pjHead", "steps", "pjHours", "pjMaterials", "pjHardware", "pjNotes", "pjOrder"]) $(id).hidden = false;
  }

  // ---- head: client, stage, owner ------------------------------------------------------------

  function item(label, ...value) {
    return el("div", { class: "jo-sumitem" }, el("span", { class: "jo-sumlabel", text: label }), ...value);
  }

  function renderHead() {
    const j = data.job;
    const box = $("pjHead");
    box.replaceChildren();
    if (j.clientName) box.append(item("Client", el("span", { class: "jo-sumval", text: j.clientName })));
    if (j.quoteNumber) box.append(item("Quote", el("span", { class: "jo-sumval", text: j.quoteNumber })));
    box.append(item("Stage", el("span", { class: "hs-badge hs-badge-teal", text: STAGE_LABEL[j.pipelineStage] || j.pipelineStage || "No stage" })));
    if (data.can.setOwner && owners.length) {
      const sel = el("select", { class: "hs-input", id: "pjOwnerSel", "aria-label": "Project owner" });
      sel.append(el("option", { value: "", text: "No owner" }));
      const ids = new Set(owners.map((o) => o.id));
      for (const o of owners) sel.append(el("option", { value: String(o.id), text: o.name }));
      // An owner who has since lost Projects access still shows, so the page doesn't drop them.
      if (j.owner && !ids.has(j.owner.id)) sel.append(el("option", { value: String(j.owner.id), text: j.owner.name }));
      sel.value = j.owner ? String(j.owner.id) : "";
      sel.addEventListener("change", () => saveOwner(sel));
      box.append(item("Owner", sel, ownerSwatch(j.owner)));
    } else {
      box.append(item("Owner", el("span", { class: "jo-sumval", text: j.owner ? j.owner.name : "No owner" }), ownerSwatch(j.owner)));
    }
  }

  // A small chip in the owner's worker colour (the worker-colours exception), as on the tiles.
  function ownerSwatch(o) {
    if (!o || o.hue == null || typeof hueColors !== "function") return null;
    const c = hueColors(o.hue);
    const chip = el("span", { class: "pj-ownerchip", text: o.name });
    chip.style.background = c.bg;
    chip.style.color = c.fg;
    chip.setAttribute("aria-hidden", "true");
    return chip;
  }

  async function saveOwner(sel) {
    const v = sel.value === "" ? null : Number(sel.value);
    sel.disabled = true;
    try {
      take(await api(`/api/job-records/${jobId}/owner`, { method: "PUT", body: JSON.stringify({ ownerId: v }) }));
      say("pjStatus", v == null ? "Owner cleared." : "Owner saved.", "ok");
    } catch (e) {
      say("pjStatus", errText(e), "err");
      renderHead();
    }
  }

  // ---- steps (0.2.2, m23-contracts section 2) -------------------------------------------------

  const STEP_ROWS = [
    ["drawn", "Drawn"],
    ["check_measured", "Check measured"],
    ["nested", "Nested"],
  ];
  const fmtDay = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  };

  function renderSteps() {
    const can = !!data.can.steps;
    const body = el("tbody");
    for (const [key, label] of STEP_ROWS) {
      const s = data.steps[key];
      const facts = s ? `Done ${fmtWhen(s.doneAt)}` + (s.doneBy && s.doneBy.name ? ` by ${s.doneBy.name}` : "") : "Not yet";
      const btn = can
        ? el("button", { class: "hs-btn" + (s ? " hs-btn-quiet" : ""), type: "button", "data-step": key, text: s ? "Untick" : "Tick" })
        : null;
      if (btn) btn.addEventListener("click", () => saveStep(key, !s, btn));
      body.append(
        el("tr", {}, el("th", { scope: "row", text: label }), el("td", { class: s ? "pj-done" : "muted", text: facts }), el("td", { class: "pj-stepbtn" }, btn))
      );
    }
    // Order list ready is not a tick: it is a finalised current revision (the Order list below).
    const ol = data.marks.find((m) => m.mark === "OL");
    const cur = data.orderList.current;
    const olText =
      ol && ol.done
        ? `Revision ${cur.revision} finalised` + (cur.sentAt ? ", sent to Ordering" : "")
        : cur
          ? `Changed since revision ${cur.revision}`
          : "Not finalised yet (see Order list below)";
    body.append(
      el("tr", {}, el("th", { scope: "row", text: "Order list ready" }), el("td", { class: ol && ol.done ? "pj-done" : "muted", text: olText }), el("td", {}))
    );
    $("pjStepsBody").replaceChildren(el("div", { class: "jo-wrap" }, el("table", { class: "hs-table pj-steps" }, body)));

    const req = $("pjRequested");
    if (document.activeElement !== req) req.value = data.job.requestedInstallDate || "";
    req.disabled = !data.can.edit;
    $("pjPromised").textContent = data.job.promisedInstallDate
      ? "Promised install (confirmed by scheduling): " + fmtDay(data.job.promisedInstallDate)
      : "No promised install date yet: scheduling confirms it.";

    const cms = data.checkMeasures.filter((c) => c.status !== "cancelled");
    if (!cms.length) {
      $("pjCmBody").replaceChildren(el("p", { class: "jo-empty muted", text: "No check measure booked." }));
    } else {
      const ul = el("ul", { class: "pj-cms" });
      for (const c of cms) {
        const text = `${fmtDay(c.date)}${c.time ? " " + c.time : ""}${c.host ? ", " + c.host : ""}${c.notes ? ": " + c.notes : ""}`;
        const li = el(
          "li",
          {},
          el("span", { text }),
          el("span", { class: "hs-badge" + (c.status === "done" ? " hs-badge-teal" : ""), text: c.status === "done" ? "Done" : "Booked" })
        );
        if (can && c.status === "booked") {
          const done = el("button", { class: "hs-btn", type: "button", text: "Mark done" });
          done.addEventListener("click", () => saveCm(c.id, { status: "done" }, done, "Check measure done, and Check measured ticked."));
          const cancel = el("button", { class: "hs-btn hs-btn-quiet", type: "button", text: "Cancel booking" });
          cancel.addEventListener("click", () => saveCm(c.id, { status: "cancelled" }, cancel, "Booking cancelled."));
          li.append(done, cancel);
        }
        ul.append(li);
      }
      $("pjCmBody").replaceChildren(ul);
    }
    $("pjCmForm").hidden = !can;
  }

  async function saveStep(step, done, btn) {
    btn.disabled = true;
    try {
      take(await api(`/api/job-records/${jobId}/steps/${step}`, { method: "PUT", body: JSON.stringify({ done }) }));
      say("pjStepsStatus", done ? "Step ticked." : "Step unticked.", "ok");
    } catch (e) {
      say("pjStepsStatus", errText(e), "err");
      btn.disabled = false;
    }
  }

  async function saveCm(id, patch, btn, ok) {
    btn.disabled = true;
    try {
      take(await api(`/api/check-measures/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
      say("pjStepsStatus", ok, "ok");
    } catch (e) {
      say("pjStepsStatus", errText(e), "err");
      btn.disabled = false;
    }
  }

  $("pjRequested").addEventListener("change", async () => {
    const v = $("pjRequested").value || null;
    try {
      await api(`/api/job-records/${jobId}`, { method: "PATCH", body: JSON.stringify({ requestedInstallDate: v }) });
      take(await api(`/api/job-records/${jobId}/project`));
      say("pjStepsStatus", v ? "Requested install date saved." : "Requested install date cleared.", "ok");
    } catch (e) {
      say("pjStepsStatus", errText(e), "err");
    }
  });

  $("pjCmForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const date = $("pjCmDate").value;
    if (!date) {
      say("pjStepsStatus", "Choose a date for the check measure.", "err");
      return;
    }
    try {
      const r = await api(`/api/job-records/${jobId}/check-measures`, {
        method: "POST",
        body: JSON.stringify({ date, time: $("pjCmTime").value || null, notes: $("pjCmNotes").value }),
      });
      take(r);
      $("pjCmForm").reset();
      say("pjStepsStatus", "Check measure booked. It shows on the Planner (Projects).", "ok");
    } catch (e) {
      say("pjStepsStatus", errText(e), "err");
    }
  });

  // ---- hours ---------------------------------------------------------------------------------

  function renderHours() {
    const h = data.hours;
    const row = (label, quotedMin, booked) => {
      const qh = fmtHours(quotedMin);
      const qd = qh == null ? null : Math.round((qh / HOURS_PER_DAY) * 10) / 10;
      return el(
        "tr",
        {},
        el("th", { scope: "row", text: label }),
        el("td", { text: qh == null ? "Not from Joinr" : `${qh} h` }),
        el("td", { class: "muted", text: qd == null ? "" : `about ${qd} days` }),
        el("td", { text: `${booked.toDate} ${booked.toDate === 1 ? "day" : "days"}` }),
        el("td", { class: "muted", text: booked.ahead ? `${booked.ahead} more booked ahead` : "" })
      );
    };
    const table = el(
      "table",
      { class: "hs-table pj-hours" },
      el(
        "thead",
        {},
        el("tr", {}, el("th", { text: "" }), el("th", { text: "Quoted" }), el("th", { text: "" }), el("th", { text: "Booked to date" }), el("th", { text: "" }))
      ),
      el("tbody", {}, row("Factory", h.quotedFactoryMin, h.booked.manufacturing), row("Install", h.quotedInstallMin, h.booked.installing))
    );
    $("pjHoursBody").replaceChildren(
      el("div", { class: "jo-wrap" }, table),
      el("p", {
        class: "pj-small muted",
        text: `Quoted hours come from the Joinr quote. The board books people by the day, so actual time is person-days on the board (manufacturing and installing rows); days are at ${HOURS_PER_DAY} hours.`,
      })
    );
  }

  // ---- materials and hardware --------------------------------------------------------------

  const COLS = {
    materials: [
      ["name", "Item", 300],
      ["qty", "Qty"],
      ["unit", "Unit", 30],
      ["colour", "Colour", 100],
      ["finish", "Finish", 100],
      ["supplier", "Supplier", 200],
      ["notes", "Notes", 1000],
    ],
    hardware: [
      ["name", "Item", 300],
      ["brand", "Brand", 100],
      ["code", "Code", 100],
      ["qty", "Qty"],
      ["unit", "Unit", 30],
      ["supplier", "Supplier", 200],
      ["notes", "Notes", 1000],
    ],
  };
  const BODY = { materials: "pjMatBody", hardware: "pjHwBody" };
  const STATUS = { materials: "pjMatStatus", hardware: "pjHwStatus" };
  const FORM = { materials: "pjMatForm", hardware: "pjHwForm" };

  function problemOf(id) {
    return data.problems.find((p) => p.id === id) || null;
  }

  function cellInput(kind, line, key, max) {
    const value = key === "qty" ? fmtQty(line.qty) : line[key] || "";
    const props = {
      class: "hs-input pj-cell" + (key === "qty" ? " pj-qty" : ""),
      type: key === "qty" ? "number" : "text",
      "aria-label": key.charAt(0).toUpperCase() + key.slice(1) + " for " + line.name,
      autocomplete: "off",
    };
    if (key === "qty") Object.assign(props, { min: "0", step: "any" });
    else props.maxlength = String(max);
    if (key === "supplier") props.list = "pjSuppliers";
    const input = el("input", props);
    input.value = value;
    const p = problemOf(line.id);
    if (p && ((key === "supplier" && p.missing.includes("supplier")) || (key === "qty" && p.missing.includes("quantity")))) {
      input.classList.add("pj-missing");
    }
    if (!data.can.edit || line.ordered) input.disabled = true;
    input.addEventListener("change", () => saveField(kind, line, key, input));
    return input;
  }

  async function saveField(kind, line, key, input) {
    let v = input.value;
    if (key === "qty") v = v.trim() === "" ? null : Number(v);
    if (key === "name" && !String(v).trim()) {
      say(STATUS[kind], "The item needs a name.", "err");
      input.value = line.name;
      return;
    }
    try {
      await api(`/api/job-records/${jobId}/materials/${line.id}`, { method: "PATCH", body: JSON.stringify({ [key]: v }) });
      take(await api(`/api/job-records/${jobId}/project`));
      say(STATUS[kind], "Saved.", "ok");
    } catch (e) {
      say(STATUS[kind], errText(e), "err");
    }
  }

  function renderLines(kind) {
    const lines = data[kind];
    const cols = COLS[kind];
    const body = $(BODY[kind]);
    if (!lines.length) {
      body.replaceChildren(el("p", { class: "jo-empty muted", text: kind === "materials" ? "No materials yet." : "No hardware yet." }));
    } else {
      const head = el("tr", {}, el("th", { text: "Section" }), ...cols.map(([, label]) => el("th", { text: label })), el("th", { text: "" }));
      const rows = lines.map((l) => {
        const tr = el("tr", { "data-id": String(l.id) });
        tr.append(el("td", { class: "pj-sec", text: sectionLabel(l.section) }));
        for (const [key, , max] of cols) tr.append(el("td", {}, cellInput(kind, l, key, max)));
        const marks = el("td", { class: "pj-marks" });
        if (l.ordered) marks.append(el("span", { class: "hs-badge hs-badge-go", text: "Ordered" }));
        if (l.goneFromJoinr) marks.append(el("span", { class: "hs-badge hs-badge-check", text: "No longer in Joinr" }));
        if (data.can.edit && !l.ordered) {
          const rm = el("button", { type: "button", class: "hs-btn hs-btn-quiet hs-btn-stop", text: "Remove" });
          rm.addEventListener("click", () => removeLine(kind, l));
          marks.append(rm);
        }
        tr.append(marks);
        return tr;
      });
      body.replaceChildren(el("div", { class: "jo-wrap" }, el("table", { class: "hs-table pj-lines" }, el("thead", {}, head), el("tbody", {}, ...rows))));
    }
    renderAddForm(kind);
  }

  async function removeLine(kind, l) {
    try {
      await api(`/api/job-records/${jobId}/materials/${l.id}`, { method: "DELETE" });
      take(await api(`/api/job-records/${jobId}/project`));
      say(STATUS[kind], `Removed ${l.name}.`, "ok");
    } catch (e) {
      say(STATUS[kind], errText(e), "err");
    }
  }

  function renderAddForm(kind) {
    const form = $(FORM[kind]);
    form.hidden = !data.can.edit;
    if (!data.can.edit || form.childNodes.length) return;
    const sections = data.sections.filter((s) => (kind === "hardware" ? HARDWARE.has(s.id) : !HARDWARE.has(s.id)));
    const sel = el("select", { class: "hs-input", "aria-label": "Section" }, ...sections.map((s) => el("option", { value: s.id, text: s.label })));
    const fields = {};
    const add = el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: kind === "hardware" ? "Add hardware" : "Add material" });
    form.append(el("label", { class: "pj-f" }, el("span", { class: "hs-label", text: "Section" }), sel));
    for (const [key, label, max] of COLS[kind]) {
      if (key === "notes") continue;
      const props = { class: "hs-input", type: key === "qty" ? "number" : "text", autocomplete: "off" };
      if (key === "qty") Object.assign(props, { min: "0", step: "any" });
      else props.maxlength = String(max);
      if (key === "supplier") props.list = "pjSuppliers";
      fields[key] = el("input", props);
      form.append(el("label", { class: "pj-f" + (key === "name" ? " pj-f-wide" : "") }, el("span", { class: "hs-label", text: label }), fields[key]));
    }
    form.append(el("div", { class: "pj-f pj-f-go" }, add));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (busy) return;
      const body = { section: sel.value };
      for (const [k, input] of Object.entries(fields)) {
        const v = input.value.trim();
        if (v === "") continue;
        body[k] = k === "qty" ? Number(v) : v;
      }
      if (!body.name) {
        say(STATUS[kind], "The item needs a name.", "err");
        fields.name.focus();
        return;
      }
      busy = true;
      try {
        await api(`/api/job-records/${jobId}/materials`, { method: "POST", body: JSON.stringify(body) });
        for (const input of Object.values(fields)) input.value = "";
        take(await api(`/api/job-records/${jobId}/project`));
        say(STATUS[kind], `Added ${body.name}.`, "ok");
        fields.name.focus();
      } catch (e) {
        say(STATUS[kind], errText(e), "err");
      } finally {
        busy = false;
      }
    });
  }

  $("pjJoinr").addEventListener("click", async () => {
    const path = joinr && joinr.hasJoinrLines ? "update-from-joinr" : "fill-from-joinr";
    $("pjJoinr").disabled = true;
    try {
      const r = await api(`/api/job-records/${jobId}/materials/${path}`, { method: "POST", body: "{}" });
      joinr = r.joinr;
      take(await api(`/api/job-records/${jobId}/project`));
      const s = r.summary || {};
      say("pjMatStatus", `From Joinr: ${s.added || 0} added, ${s.updated || 0} updated, ${s.gone || 0} no longer in Joinr.`, "ok");
      $("pjJoinr").textContent = "Update from Joinr";
    } catch (e) {
      say("pjMatStatus", errText(e), "err");
    } finally {
      $("pjJoinr").disabled = false;
    }
  });

  // ---- job notes -----------------------------------------------------------------------------

  function renderNotes() {
    const t = $("pjNotesText");
    if (document.activeElement !== t) t.value = data.job.projectNotes || "";
    t.disabled = !data.can.edit;
    $("pjNotesSave").hidden = !data.can.edit;
  }

  $("pjNotesSave").addEventListener("click", async () => {
    $("pjNotesSave").disabled = true;
    try {
      take(await api(`/api/job-records/${jobId}/project/notes`, { method: "PUT", body: JSON.stringify({ notes: $("pjNotesText").value }) }));
      say("pjNotesStatus", "Notes saved.", "ok");
    } catch (e) {
      say("pjNotesStatus", errText(e), "err");
    } finally {
      $("pjNotesSave").disabled = false;
    }
  });

  // ---- the order list ------------------------------------------------------------------------

  function renderOrder() {
    const o = data.orderList;
    const cur = o.current;
    const box = $("pjOrderBody");
    box.replaceChildren();
    const lines = data.materials.length + data.hardware.length;
    if (!cur) {
      box.append(el("p", { class: "jo-empty muted", text: "Not finalised yet. Finalising freezes the list as revision A, ready to print and send to Ordering." }));
    } else {
      const facts = [`Revision ${cur.revision}`, `${cur.lineCount} ${cur.lineCount === 1 ? "line" : "lines"}`, `finalised ${fmtWhen(cur.finalisedAt)}` + (cur.finalisedBy ? ` by ${cur.finalisedBy}` : "")];
      if (cur.sentAt) facts.push(`sent to Ordering ${fmtWhen(cur.sentAt)}` + (cur.sentBy ? ` by ${cur.sentBy}` : ""));
      box.append(el("p", { class: "pj-rev", text: facts.join(" · ") }));
      if (o.changed) {
        box.append(
          el(
            "div",
            { class: "hs-callout hs-callout-orange pj-callout" },
            el("h3", { text: "Changed since revision " + cur.revision }),
            el("p", { text: `Finalise again to make revision ${o.nextRevision}.` })
          )
        );
      }
      if (o.revisions.length > 1) {
        const older = el("p", { class: "pj-small muted" }, "Earlier revisions: ");
        o.revisions.slice(0, -1).forEach((r, i) => {
          if (i) older.append(", ");
          older.append(el("a", { href: `/projectorder.html?id=${jobId}&rev=${encodeURIComponent(r.revision)}`, text: r.revision }));
        });
        box.append(older);
      }
    }
    if (data.problems.length && lines) {
      const ul = el("ul", { class: "pj-problems" });
      for (const p of data.problems) ul.append(el("li", { text: `${p.name}: needs ${p.missing.join(" and ")}` }));
      box.append(el("p", { class: "pj-small", text: "Before finalising, every line needs a supplier and a quantity:" }), ul);
    }

    const fin = $("pjFinalise");
    fin.hidden = !data.can.edit || (cur && !o.changed);
    fin.textContent = `Finalise order list (revision ${o.nextRevision})`;
    fin.disabled = !lines || data.problems.length > 0;
    const print = $("pjPrint");
    print.hidden = !cur;
    if (cur) {
      print.href = `/projectorder.html?id=${jobId}&rev=${encodeURIComponent(cur.revision)}`;
      print.textContent = `Print revision ${cur.revision}`;
    }
    const send = $("pjSend");
    send.hidden = !data.can.send || !cur || !!cur.sentAt;
    send.disabled = !!o.changed || !data.job.requestedInstallDate;
    send.title = o.changed ? "Finalise the changes first" : !data.job.requestedInstallDate ? "Enter a requested install date (Steps) first" : "";
  }

  $("pjFinalise").addEventListener("click", async () => {
    $("pjFinalise").disabled = true;
    try {
      take(await api(`/api/job-records/${jobId}/project/finalise`, { method: "POST", body: "{}" }));
      say("pjOrderStatus", `Revision ${data.orderList.current.revision} finalised.`, "ok");
    } catch (e) {
      say("pjOrderStatus", errText(e), "err");
      renderOrder();
    }
  });

  $("pjSend").addEventListener("click", async () => {
    $("pjSend").disabled = true;
    try {
      const r = await api(`/api/job-records/${jobId}/project/send`, { method: "POST", body: "{}" });
      const { revision, created, skipped, suppliers } = r;
      take(r);
      let msg = `Revision ${revision} sent to Ordering: ${created} order ${created === 1 ? "line" : "lines"}`;
      if (suppliers.length) msg += ` from ${suppliers.join(", ")}`;
      if (skipped) msg += `; ${skipped} already ordered`;
      say("pjOrderStatus", msg + ".", "ok");
    } catch (e) {
      say("pjOrderStatus", errText(e), "err");
      renderOrder();
    }
  });

  load();
})();
