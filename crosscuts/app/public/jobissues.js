// A job's Issues section (0.2.4, docs/plans/m25-contracts.md section 4), on the job page and the
// project page: open issues first, each with who raised it, when, its photos and, for the project
// owner, a board.edit holder or an admin, Resolve (with an optional note). Resolved ones below.
// Fills <section id="issues"> (with #issuesList inside); ?id=N is the job. Text only, no icons.
(function () {
  "use strict";

  const sec = document.getElementById("issues");
  const list = document.getElementById("issuesList");
  const jobId = Number(new URLSearchParams(location.search).get("id"));
  if (!sec || !list || !Number.isInteger(jobId) || jobId <= 0) return;

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

  function when(iso) {
    const d = new Date(iso);
    return d.toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }

  function item(i) {
    const li = el("li", { class: "ji-item" + (i.status === "open" ? " ji-open" : "") });
    li.append(
      el("div", { class: "ji-head" },
        el("span", { class: i.status === "open" ? "hs-badge hs-badge-check" : "hs-badge hs-badge-na", text: i.status === "open" ? "Open" : "Resolved" }),
        el("span", { class: "muted", text: `${i.raisedBy ? i.raisedBy.name : "Someone"}, ${when(i.raisedAt)}` })),
      el("p", { class: "ji-body", text: i.body })
    );
    if (i.photos.length) {
      const ph = el("div", { class: "ji-photos" });
      for (const p of i.photos) ph.append(el("a", { href: p.url, target: "_blank", rel: "noopener" }, el("img", { src: p.thumbUrl, alt: "Issue photo", loading: "lazy" })));
      li.append(ph);
    }
    if (i.status === "resolved") {
      li.append(el("p", { class: "muted ji-res", text: `Resolved by ${i.resolvedBy ? i.resolvedBy.name : "someone"}, ${when(i.resolvedAt)}${i.resolution ? ": " + i.resolution : ""}` }));
    } else if (i.canResolve) {
      const note = el("input", { class: "hs-input", type: "text", maxlength: "2000", placeholder: "What was done (optional)", "aria-label": "Resolution note" });
      const btn = el("button", { class: "hs-btn", type: "button", text: "Resolve" });
      const msg = el("span", { class: "muted", role: "status" });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api(`/api/issues/${i.id}/resolve`, { method: "POST", body: JSON.stringify({ resolution: note.value }) });
          await render();
        } catch (e) {
          msg.textContent = e.message;
          btn.disabled = false;
        }
      });
      li.append(el("div", { class: "ji-resolve" }, note, btn, msg));
    }
    return li;
  }

  async function render() {
    let d;
    try {
      d = await api(`/api/job-records/${jobId}/issues`);
    } catch (e) {
      return; // the page shows its own errors
    }
    const open = d.issues.filter((i) => i.status === "open").length;
    const h = document.getElementById("issues-h");
    if (h) h.textContent = open ? `Issues (${open} open)` : "Issues";
    list.replaceChildren(...d.issues.map(item));
    if (!d.issues.length) list.append(el("li", { class: "muted", text: "No issues raised." }));
    sec.hidden = false;
  }

  render();
})();
