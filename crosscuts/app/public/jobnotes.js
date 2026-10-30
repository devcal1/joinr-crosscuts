// Notes on a job (docs/plans/jobs-tradify-contracts.md sections 4.1 and 5.1): the pinned Job summary,
// a form to add a note with optional photos or files, and the notes newest first. Note bodies are free
// text and are only ever set with textContent. Photos on notes also show in the Photos tab (#jnPhotos);
// they are private files, never in the photo library.
(function () {
  const jobId = Number(new URLSearchParams(location.search).get("id"));
  if (!Number.isInteger(jobId) || jobId < 1) return;

  const $ = (id) => document.getElementById(id);
  const sec = $("jobNotes");
  const listEl = $("jnList");
  const form = $("jnForm");
  const bodyEl = $("jnBody");
  const fileEl = $("jnFile");
  const addBtn = $("jnAdd");
  const statusEl = $("jnStatus");
  const photosSec = $("jnPhotos");
  const photosBody = $("jnPhotosBody");
  const summaryEl = $("jnSummary");
  if (!sec || !listEl || !form) return;

  const MAX_FILES = 10;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  function when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const hh = d.getHours();
    const mm = String(d.getMinutes()).padStart(2, "0");
    const h12 = ((hh + 11) % 12) + 1;
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h12}:${mm} ${hh < 12 ? "am" : "pm"}`;
  }
  function setStatus(msg, kind) {
    statusEl.textContent = msg || "";
    statusEl.className = "jo-status " + (kind === "err" ? "jn-err" : "muted");
  }
  function sizeText(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }

  async function upload(noteId, file) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const r = await fetch(`/api/job-records/${jobId}/notes/${noteId}/files`, { method: "POST", body: fd });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(`${file.name}: ${b.error || "upload failed (" + r.status + ")"}`);
    }
    return r.json();
  }

  // ---- the pinned Job summary (the job's notes field and the Projects notes; API unchanged) ----
  async function renderSummary() {
    if (!summaryEl) return;
    let j;
    try { j = await api("/api/job-records/" + jobId); } catch (e) { return; }
    summaryEl.replaceChildren();
    const block = (title, text, action) => {
      const box = el("div", { class: "jn-pin" },
        el("div", { class: "jn-pinhead" }, el("h3", { class: "jn-pinh", text: title }), action),
        el("p", { class: "jn-pintext" + (text ? "" : " muted"), text: text || "Nothing yet." }));
      summaryEl.append(box);
    };
    let edit = null;
    if (can("jobs.edit")) {
      edit = el("button", { class: "hs-btn hs-btn-quiet", type: "button", text: "Edit on Overview" });
      edit.addEventListener("click", () => {
        if (window.JobTabs) window.JobTabs.open("overview");
        const f = $("f-notes");
        if (f) { f.scrollIntoView({ block: "center" }); f.focus(); }
      });
    }
    block("Job summary", j.notes, edit);
    if (j.projectNotes || can("design.view")) {
      const link = can("design.view") ? el("a", { class: "hs-btn hs-btn-quiet", href: "/project.html?id=" + jobId, text: "Project page" }) : null;
      block("Project notes", j.projectNotes, link);
    }
  }

  // ---- the notes ----
  let notes = [];

  function fileView(note, f) {
    const wrap = el("li", { class: "jn-file" });
    if (f.image) {
      wrap.append(el("a", { class: "jn-thumb", href: f.url, target: "_blank", rel: "noopener" },
        el("img", { src: f.url, alt: f.name, loading: "lazy" })));
    } else {
      wrap.append(el("a", { href: f.url, target: "_blank", rel: "noopener", text: f.name }), el("span", { class: "muted jn-size", text: " " + sizeText(f.size) }));
    }
    if (note.canDelete) {
      const rm = el("button", { class: "hs-btn hs-btn-quiet jn-rm", type: "button", text: "Remove", "aria-label": "Remove " + f.name });
      rm.addEventListener("click", async () => {
        if (!confirm(`Remove ${f.name} from this note?`)) return;
        rm.disabled = true;
        try {
          await api(`/api/job-records/${jobId}/notes/${note.id}/files/${f.id}`, { method: "DELETE" });
          await load();
        } catch (e) { rm.disabled = false; setStatus(e.message, "err"); }
      });
      wrap.append(rm);
    }
    return wrap;
  }

  function noteView(n) {
    const li = el("li", { class: "jn-note", id: "note-" + n.id });
    const meta = el("p", { class: "jn-meta" },
      el("span", { class: "jn-author", text: n.author ? n.author.name : "Unknown" }),
      el("span", { class: "muted", text: " · " + when(n.createdAt) + (n.editedAt ? " · edited" : "") }));
    if (n.editedAt) meta.lastChild.title = "Edited " + when(n.editedAt);
    const body = el("p", { class: "jn-body" });
    body.textContent = n.body; // plain text only
    li.append(meta, body);
    if (n.files.length) li.append(el("ul", { class: "jn-files" }, ...n.files.map((f) => fileView(n, f))));

    const acts = el("div", { class: "jn-acts" });
    if (n.canEdit) {
      const eb = el("button", { class: "hs-btn hs-btn-quiet", type: "button", text: "Edit" });
      eb.addEventListener("click", () => editNote(li, n));
      acts.append(eb);
      if (n.files.length < MAX_FILES) {
        const inp = el("input", { type: "file", class: "jn-hidden", multiple: "", accept: fileEl ? fileEl.getAttribute("accept") : "" , "aria-label": "Add a file to this note" });
        const ab = el("button", { class: "hs-btn hs-btn-quiet", type: "button", text: "Add file" });
        ab.addEventListener("click", () => inp.click());
        inp.addEventListener("change", async () => {
          const list = [...inp.files].slice(0, MAX_FILES - n.files.length);
          ab.disabled = true;
          try { for (const f of list) await upload(n.id, f); setStatus(""); } catch (e) { setStatus(e.message, "err"); }
          await load();
        });
        acts.append(ab, inp);
      }
    }
    if (n.canDelete) {
      const db = el("button", { class: "hs-btn hs-btn-quiet jn-del", type: "button", text: "Delete" });
      db.addEventListener("click", async () => {
        const other = !n.canEdit;
        if (!confirm(other ? `Delete ${n.author ? n.author.name : "this person"}'s note? This is recorded in the audit log.` : "Delete this note?")) return;
        db.disabled = true;
        try {
          await api(`/api/job-records/${jobId}/notes/${n.id}`, { method: "DELETE" });
          await load();
        } catch (e) { db.disabled = false; setStatus(e.message, "err"); }
      });
      acts.append(db);
    }
    if (acts.childNodes.length) li.append(acts);
    return li;
  }

  function editNote(li, n) {
    const ta = el("textarea", { class: "hs-input jn-edit", rows: "3", maxlength: "5000", "aria-label": "Edit note" });
    ta.value = n.body;
    const save = el("button", { class: "hs-btn hs-btn-primary", type: "button", text: "Save" });
    const cancel = el("button", { class: "hs-btn hs-btn-quiet", type: "button", text: "Cancel" });
    const box = el("div", { class: "jn-editbox" }, ta, el("div", { class: "jo-actions" }, cancel, save));
    const body = li.querySelector(".jn-body");
    const acts = li.querySelector(".jn-acts");
    body.replaceWith(box);
    if (acts) acts.hidden = true;
    ta.focus();
    cancel.addEventListener("click", () => render());
    save.addEventListener("click", async () => {
      const v = ta.value.trim();
      if (!v) { setStatus("A note can't be empty.", "err"); return; }
      save.disabled = true;
      try {
        await api(`/api/job-records/${jobId}/notes/${n.id}`, { method: "PATCH", body: JSON.stringify({ body: v }) });
        setStatus("");
        await load();
      } catch (e) { save.disabled = false; setStatus(e.message, "err"); }
    });
  }

  function render() {
    if (!notes.length) listEl.replaceChildren(el("li", { class: "jn-empty muted", text: "No notes yet." }));
    else listEl.replaceChildren(...notes.map(noteView));
    renderPhotos();
  }

  function renderPhotos() {
    if (!photosSec) return;
    const items = [];
    for (const n of notes) for (const f of n.files) if (f.image) items.push({ n, f });
    photosSec.hidden = items.length === 0;
    photosBody.replaceChildren(...items.map(({ n, f }) =>
      el("figure", { class: "jn-photo" },
        el("a", { class: "jn-thumb", href: f.url, target: "_blank", rel: "noopener" }, el("img", { src: f.url, alt: f.name, loading: "lazy" })),
        el("figcaption", { text: (n.author ? n.author.name : "") + " · " + when(n.createdAt) }))));
  }

  async function load() {
    try {
      notes = (await api(`/api/job-records/${jobId}/notes`)).notes || [];
    } catch (e) {
      listEl.replaceChildren(el("li", { class: "jn-empty muted", text: "Could not load notes: " + e.message }));
      return;
    }
    render();
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = bodyEl.value.trim();
    const files = fileEl ? [...fileEl.files] : [];
    if (!body) { setStatus("Write the note first.", "err"); bodyEl.focus(); return; }
    if (files.length > MAX_FILES) { setStatus(`At most ${MAX_FILES} files on a note.`, "err"); return; }
    addBtn.disabled = true;
    setStatus("Saving…");
    let note;
    try {
      note = await api(`/api/job-records/${jobId}/notes`, { method: "POST", body: JSON.stringify({ body }) });
    } catch (e) {
      addBtn.disabled = false;
      setStatus(e.message, "err");
      return;
    }
    let err = null;
    for (const f of files) {
      try { await upload(note.id, f); } catch (e) { err = e; }
    }
    bodyEl.value = "";
    if (fileEl) fileEl.value = "";
    addBtn.disabled = false;
    setStatus(err ? "Note saved, but " + err.message : "Note added.", err ? "err" : "ok");
    await load();
  });

  async function start() {
    if (document.readyState !== "complete") await new Promise((r) => window.addEventListener("load", r, { once: true }));
    if (window.cc && window.cc.ready) { try { await window.cc.ready; } catch (e) { /* shell failed */ } }
    if (!can("jobs.view")) return;
    sec.hidden = false;
    renderSummary();
    await load();
  }
  start();
  // The summary follows saves of the job form (job.js rewrites the title then).
  const title = $("title");
  if (title) new MutationObserver(() => renderSummary()).observe(title, { childList: true });
})();
