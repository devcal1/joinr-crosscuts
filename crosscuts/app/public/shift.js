// The end-of-shift page (shift.html; 0.2.4, docs/plans/m25-contracts.md section 3). Today's jobs
// from this week's board rows the signed-in person is on, plus any found by search; per job: add
// photos (camera or library, several at once), raise an issue; then Send report. The server checks
// everything again.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const PANEL = { installing: "Install", manufacturing: "Manufacturing" };
  let data = null;
  let added = [];

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

  // Jobs added by search stay for the day on this phone (a convenience only).
  function addedKey(date) {
    return "cc.shift.added." + date;
  }
  function loadAdded(date) {
    try {
      const a = JSON.parse(sessionStorage.getItem(addedKey(date)) || "[]");
      return Array.isArray(a) ? a.filter((n) => Number.isInteger(n)) : [];
    } catch (e) {
      return [];
    }
  }
  function saveAdded() {
    try {
      sessionStorage.setItem(addedKey(data.date), JSON.stringify(added));
    } catch (e) { /* not kept */ }
  }

  function time(iso) {
    return new Date(iso).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", minute: "2-digit" });
  }

  async function upload(jobId, files, msg) {
    const fd = new FormData();
    for (const f of files) fd.append("photos", f);
    msg.textContent = `Uploading ${files.length} ${files.length === 1 ? "photo" : "photos"}...`;
    const res = await fetch(`/api/shift/jobs/${jobId}/photos`, { method: "POST", body: fd });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !(body.created && body.created.length)) throw new Error(body.error || `Upload failed (${res.status})`);
    msg.textContent = body.failed && body.failed.length ? `${body.failed.length} could not be saved` : "";
  }

  function card(j) {
    const c = el("article", { class: "sh-card" });
    const sub = el("p", { class: "sh-sub" });
    for (const p of j.panels) sub.append(el("span", { class: p === "installing" ? "hs-badge hs-badge-teal sh-panel" : "hs-badge sh-panel", text: PANEL[p] || p }));
    if (!j.panels.length) sub.append(el("span", { class: "hs-badge hs-badge-na sh-panel", text: "Added" }));
    sub.append(document.createTextNode([j.clientName, j.siteAddress].filter(Boolean).join(" · ")));
    c.append(el("h2", { text: j.name }), sub);

    const photos = el("div", { class: "sh-photos" });
    for (const p of j.photosToday) photos.append(el("a", { href: p.url, target: "_blank", rel: "noopener" }, el("img", { src: p.thumbUrl, alt: "Photo", loading: "lazy" })));
    c.append(el("p", { class: "muted", text: j.photosToday.length ? `${j.photosToday.length} ${j.photosToday.length === 1 ? "photo" : "photos"} today` : "No photos today" }), photos);

    const msg = el("p", { class: "sh-msg", role: "status" });
    const file = el("input", { class: "sh-file", type: "file", accept: "image/jpeg,image/png,image/webp,image/*", multiple: true, "aria-label": "Photos for " + j.name });
    const addBtn = el("button", { class: "hs-btn", type: "button", text: "Add photos" });
    addBtn.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      if (!file.files.length) return;
      addBtn.disabled = true;
      try {
        await upload(j.id, [...file.files], msg);
        await load();
      } catch (e) {
        msg.textContent = e.message;
        addBtn.disabled = false;
      }
    });
    const issueBtn = el("button", { class: "hs-btn", type: "button", text: "Raise an issue" });
    c.append(el("div", { class: "sh-row" }, addBtn, issueBtn), file, msg);

    // The issue form, opened by Raise an issue.
    const text = el("textarea", { class: "hs-input", rows: "3", maxlength: "2000", "aria-label": "What is the issue?", placeholder: "What is the issue?" });
    const withPhotos = el("input", { type: "checkbox" });
    const send = el("button", { class: "hs-btn hs-btn-primary", type: "button", text: "Send issue" });
    const cancel = el("button", { class: "hs-btn hs-btn-quiet", type: "button", text: "Cancel" });
    const form = el("div", { class: "sh-issue", hidden: true }, text);
    if (j.photosToday.length) form.append(el("label", { class: "sh-check" }, withPhotos, document.createTextNode("Attach today's photos")));
    form.append(el("div", { class: "sh-row" }, send, cancel));
    issueBtn.addEventListener("click", () => {
      form.hidden = false;
      issueBtn.hidden = true;
      text.focus();
    });
    cancel.addEventListener("click", () => {
      form.hidden = true;
      issueBtn.hidden = false;
    });
    send.addEventListener("click", async () => {
      send.disabled = true;
      try {
        await api(`/api/job-records/${j.id}/issues`, {
          method: "POST",
          body: JSON.stringify({ body: text.value, photoIds: withPhotos.checked ? j.photosToday.map((p) => p.id) : [] }),
        });
        toast("Issue sent to the project manager and scheduling");
        await load();
      } catch (e) {
        msg.textContent = e.message;
        send.disabled = false;
      }
    });
    c.append(form);

    if (j.issues.length) {
      const ul = el("ul", { class: "ji-list" });
      for (const i of j.issues) {
        ul.append(el("li", { class: "ji-item ji-open" },
          el("div", { class: "ji-head" }, el("span", { class: "hs-badge hs-badge-check", text: "Open issue" }), el("span", { class: "muted", text: i.raisedBy ? i.raisedBy.name : "" })),
          el("p", { class: "ji-body", text: i.body })));
      }
      c.append(el("div", { class: "sh-issue" }, ul));
    }
    return c;
  }

  function render() {
    $("shDate").textContent = new Date(data.date + "T12:00:00").toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
    const status = [];
    if (!data.worker) status.push("Your login isn't linked to a worker on the board, so today's jobs can't be listed. Search for a job below, or ask an admin to link it on the Users page.");
    else if (!data.jobs.length) status.push("You're not on the board today. Search for a job below if you worked on one.");
    $("shStatus").textContent = status.join(" ");
    $("shJobs").replaceChildren(...data.jobs.map(card));
    const sent = $("shSent");
    if (data.report) {
      sent.textContent = `Report sent at ${time(data.report.sentAt)}. You can send it again to update it.`;
      sent.hidden = false;
      if (!$("shNote").value) $("shNote").value = data.report.note;
    } else {
      sent.hidden = true;
    }
  }

  async function load() {
    const first = !data;
    const q = added.length ? "?add=" + added.join(",") : "";
    data = await api("/api/shift/today" + q);
    if (first) {
      added = loadAdded(data.date);
      if (added.length) data = await api("/api/shift/today?add=" + added.join(","));
    }
    render();
  }

  let searchTimer = null;
  $("shSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $("shSearch").value.trim();
      const out = $("shResults");
      if (q.length < 2) {
        out.replaceChildren();
        return;
      }
      try {
        const d = await api("/api/shift/jobs?q=" + encodeURIComponent(q));
        const shown = new Set(data.jobs.map((j) => j.id));
        out.replaceChildren(
          ...d.jobs
            .filter((j) => !shown.has(j.id))
            .map((j) => {
              const b = el("button", { class: "hs-btn", type: "button", text: j.name + (j.clientName ? " · " + j.clientName : "") });
              b.addEventListener("click", async () => {
                added.push(j.id);
                saveAdded();
                $("shSearch").value = "";
                out.replaceChildren();
                await load();
              });
              return el("li", {}, b);
            })
        );
        if (!out.children.length) out.append(el("li", { class: "muted", text: "No other live jobs match." }));
      } catch (e) {
        out.replaceChildren(el("li", { class: "sh-msg", text: e.message }));
      }
    }, 250);
  });

  $("shSendBtn").addEventListener("click", async () => {
    const btn = $("shSendBtn");
    btn.disabled = true;
    $("shSendMsg").textContent = "";
    try {
      await api("/api/shift/report", { method: "POST", body: JSON.stringify({ note: $("shNote").value, jobIds: data.jobs.map((j) => j.id) }) });
      toast("Report sent");
      await load();
    } catch (e) {
      $("shSendMsg").textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  load().catch((e) => {
    $("shStatus").textContent = e.message;
  });
})();
