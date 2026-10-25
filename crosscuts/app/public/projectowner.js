// The job page's project line (docs/plans/m22-project-jobs.md section 4): the project owner (a
// picker for whoever may set it: jobs.edit with design.view, or users.admin; text for everyone
// else) and a link to the job's project page. Loaded by job.html after job.js; works only on an
// existing job (job.html?id=N). The server checks every write again.
(function () {
  "use strict";

  const box = document.getElementById("pjOwner");
  const jobId = Number(new URLSearchParams(location.search).get("id"));
  if (!box || !Number.isInteger(jobId) || jobId <= 0) return;

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

  function chip(o) {
    if (!o || o.hue == null || typeof hueColors !== "function") return null;
    const c = hueColors(o.hue);
    const n = el("span", { class: "pj-ownerchip", text: o.name, "aria-hidden": "true" });
    n.style.background = c.bg;
    n.style.color = c.fg;
    return n;
  }

  async function render() {
    let p;
    try {
      p = await api(`/api/job-records/${jobId}/project`);
    } catch (e) {
      return; // the job page shows its own errors
    }
    const status = el("span", { class: "muted", role: "status" });
    const parts = [el("span", { class: "hs-label", text: "Project owner" })];
    if (p.can.setOwner) {
      let owners = [];
      try {
        owners = (await api("/api/project-owners")).owners;
      } catch (e) { /* falls back to text */ }
      const sel = el("select", { class: "hs-input", "aria-label": "Project owner" }, el("option", { value: "", text: "No owner" }));
      for (const o of owners) sel.append(el("option", { value: String(o.id), text: o.name }));
      if (p.job.owner && !owners.some((o) => o.id === p.job.owner.id)) {
        sel.append(el("option", { value: String(p.job.owner.id), text: p.job.owner.name }));
      }
      sel.value = p.job.owner ? String(p.job.owner.id) : "";
      sel.addEventListener("change", async () => {
        sel.disabled = true;
        try {
          await api(`/api/job-records/${jobId}/owner`, {
            method: "PUT",
            body: JSON.stringify({ ownerId: sel.value === "" ? null : Number(sel.value) }),
          });
          await render();
        } catch (e) {
          status.textContent = e.message;
          sel.disabled = false;
        }
      });
      parts.push(sel, chip(p.job.owner));
    } else {
      parts.push(el("span", { text: p.job.owner ? p.job.owner.name : "No owner" }), chip(p.job.owner));
    }
    parts.push(el("a", { class: "hs-btn hs-btn-quiet", href: "/project.html?id=" + jobId, text: "Project page" }), status);
    box.replaceChildren(...parts.filter(Boolean));
    box.hidden = false;
  }

  render();
})();
