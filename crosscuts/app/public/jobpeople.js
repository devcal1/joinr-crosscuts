// Names on Pipeline job tiles and the job page (migration 033, Todd 2026-10-18).
//
// A job carries people: [{userId, name, hue|null}] (GET /api/job-records and /:id). A person is a
// small chip coloured with their linked board worker's colour (hueColors() in shared.js: the worker
// colours named exception in CLAUDE.md); a login with no worker gets a neutral grey chip.
// Anyone with jobs.edit adds or removes their own name (POST /api/job-records/:id/people, DELETE
// .../people/:userId); users.admin removes anyone's. Loaded by pipeline.html and job.html after
// shared.js. Chips and buttons are never inside the tiles' drag handle, so they never start a drag.
(function () {
  "use strict";

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

  const can = (key) => !!(window.cc && typeof window.cc.can === "function" && window.cc.can(key));
  const myId = () => (window.cc && window.cc.me && Number.isInteger(window.cc.me.id) ? window.cc.me.id : null);
  const isMine = (p) => myId() !== null && p.userId === myId();
  const peopleOf = (job) => (job && Array.isArray(job.people) ? job.people : []);

  // The compact label: the first word of the display name; the full name is the tooltip.
  const shortName = (name) => String(name || "").trim().split(/\s+/)[0] || "?";

  async function call(method, path) {
    return api(path, { method, body: method === "POST" ? "{}" : undefined });
  }

  // One chip. A worker's colour comes from hueColors(); grey otherwise. `removable` makes it a button
  // (an admin removing someone else's name).
  function chip(p, opts) {
    const removable = !!opts.removable;
    const node = el(removable ? "button" : "span", {
      class: "jp-chip" + (p.hue != null ? " jp-worker" : " jp-grey") + (removable ? " jp-removable" : ""),
      text: opts.full ? p.name : shortName(p.name),
      title: removable ? `Remove ${p.name} from this job` : p.name,
      type: removable ? "button" : null,
    });
    if (p.hue != null && typeof hueColors === "function") {
      const c = hueColors(p.hue);
      node.style.background = c.bg;
      node.style.color = c.fg;
    }
    if (removable) {
      node.addEventListener("click", async () => {
        if (!window.confirm(`Remove ${p.name} from this job?`)) return;
        node.disabled = true;
        try {
          const j = await call("DELETE", `/api/job-records/${opts.jobId}/people/${p.userId}`);
          if (opts.onChange) opts.onChange(j);
        } catch (e) {
          node.disabled = false;
          if (opts.onError) opts.onError(e.message);
        }
      });
    }
    return node;
  }

  // The chips for a job: at most `max` of them, then "+n" (its tooltip lists the rest). Null when the
  // job has nobody on it. Only a users.admin sees other people's chips as remove buttons.
  function chips(job, opts) {
    opts = opts || {};
    const list = peopleOf(job);
    if (!list.length) return null;
    const max = opts.max > 0 ? opts.max : list.length;
    const admin = can("users.admin");
    const box = el("span", { class: "jp-chips", "aria-label": "People on this job" });
    for (const p of list.slice(0, max)) {
      box.append(
        chip(p, {
          full: !!opts.full,
          jobId: job.id,
          removable: admin && !isMine(p),
          onChange: opts.onChange,
          onError: opts.onError,
        })
      );
    }
    if (list.length > max) {
      box.append(
        el("span", {
          class: "jp-more",
          text: "+" + (list.length - max),
          title: list.slice(max).map((p) => p.name).join(", "),
        })
      );
    }
    return box;
  }

  // The "add me / remove me" button, for jobs.edit holders only (null for anyone else). Compact gives
  // "+ ME" / "- ME" for the Pipeline tiles; the job page uses the words.
  function meButton(job, opts) {
    opts = opts || {};
    if (!can("jobs.edit") || myId() === null) return null;
    const mine = peopleOf(job).some(isMine);
    const label = mine ? "Remove my name from this job" : "Add my name to this job";
    const btn = el("button", {
      type: "button",
      class: "hs-btn hs-btn-quiet jp-me",
      text: opts.compact ? (mine ? "− Me" : "+ Me") : mine ? "Remove me" : "Add me",
      title: label,
      "aria-label": label,
    });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const j = mine
          ? await call("DELETE", `/api/job-records/${job.id}/people/${myId()}`)
          : await call("POST", `/api/job-records/${job.id}/people`);
        if (opts.onChange) opts.onChange(j);
      } catch (e) {
        btn.disabled = false;
        if (opts.onError) opts.onError(e.message);
      }
    });
    return btn;
  }

  // The job page's block: the label, every name in full, the button, and a hint for admins.
  function renderBlock(box, job, opts) {
    box.replaceChildren();
    const list = peopleOf(job);
    const btn = job ? meButton(job, opts) : null;
    box.hidden = !job || (!list.length && !btn);
    if (box.hidden) return;
    box.append(el("span", { class: "jp-label", text: "People" }));
    const cs = chips(job, { full: true, onChange: opts && opts.onChange, onError: opts && opts.onError });
    box.append(cs || el("span", { class: "jp-none", text: "Nobody yet" }));
    if (btn) box.append(btn);
    if (can("users.admin") && list.some((p) => !isMine(p))) {
      box.append(el("span", { class: "jp-hint", text: "Click a name to remove it." }));
    }
  }

  window.JobPeople = { chips, meButton, renderBlock };
})();
