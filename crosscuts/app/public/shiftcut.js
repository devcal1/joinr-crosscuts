// Jobs cut 100% on the end-of-shift page (0.2.6, docs/plans/m27-contracts.md section 5). For
// stock.count holders (the workshop manager): tick the jobs cut 100% this shift and record them;
// their confirmed reservations come off stock. Hidden for anyone else (the list answers 403).
(function () {
  "use strict";

  const sec = document.getElementById("shCut");
  const host = document.getElementById("shCutList");
  const msg = document.getElementById("shCutMsg");
  if (!sec || !host) return;

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (v === true) n.setAttribute(k, "");
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of kids) if (c != null) n.append(c);
    return n;
  }

  async function load(note) {
    let data;
    try {
      const me = await api("/api/auth/me");
      const perms = (me && me.user && me.user.perms) || [];
      if (!perms.includes("stock.count")) return;
      data = await api("/api/reservations");
    } catch (e) {
      return;
    }
    sec.hidden = false;
    msg.textContent = note || "";
    if (!data.toCut.length) {
      host.replaceChildren(el("p", { class: "muted", text: "No jobs to mark cut." }));
      return;
    }
    const boxes = [];
    const rows = data.toCut.map((j) => {
      const cb = el("input", { type: "checkbox", value: String(j.jobId), id: `shc-${j.jobId}` });
      boxes.push(cb);
      return el("div", null, cb, " ", el("label", { for: `shc-${j.jobId}`, text: j.name }));
    });
    const btn = el("button", { type: "button", class: "hs-btn hs-btn-primary sh-wide", text: "Record cut 100%" });
    btn.addEventListener("click", async () => {
      const ids = boxes.filter((b) => b.checked).map((b) => Number(b.value));
      if (!ids.length) {
        msg.textContent = "Tick the jobs cut 100% first.";
        return;
      }
      btn.disabled = true;
      try {
        await api("/api/workshop/cut", { method: "POST", body: JSON.stringify({ jobIds: ids }) });
        await load(`Recorded ${ids.length} ${ids.length === 1 ? "job" : "jobs"} as cut 100%.`);
      } catch (e) {
        msg.textContent = e.message;
        btn.disabled = false;
      }
    });
    host.replaceChildren(...rows, btn);
  }

  load();
})();
