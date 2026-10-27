// Workshop > To reserve (0.2.6, docs/plans/m27-contracts.md section 5): the reservations to label
// (tick Reserved), those waiting to be cut, the end-of-shift "cut 100%" list, and the board and edge
// tape stock with on hand, reserved and free. The server checks every action; the page hides what
// the user can't do. Text only.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
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
  const num = (q) => (q == null ? "–" : String(Math.round(q * 2) / 2));
  function stamp(iso) {
    try {
      return new Date(iso).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short" });
    } catch (e) {
      return String(iso).slice(0, 10);
    }
  }

  let data = null;
  const setStatus = (t) => { $("rvStatus").textContent = t || ""; };

  function resTable(list, withConfirm) {
    if (!list.length) return el("p", { class: "rv-empty", text: withConfirm ? "Nothing to label." : "Nothing waiting." });
    const rows = list.map((r) => {
      const acts = el("div", { class: "rv-acts" });
      if (withConfirm && data.canConfirm) {
        const b = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Reserved", "aria-label": `Tick Reserved: ${num(r.qty)} ${r.unit} of ${r.board} for ${r.jobName}` });
        b.addEventListener("click", () => act(() => api(`/api/reservations/${r.id}/confirm`, { method: "POST", body: "{}" }), `Reserved for ${r.jobName}.`));
        acts.append(b);
      }
      if (data.canRelease) {
        const b = el("button", { type: "button", class: "hs-btn", text: "Release", "aria-label": `Release ${num(r.qty)} ${r.unit} of ${r.board} for ${r.jobName}` });
        b.addEventListener("click", () => {
          if (!confirm(`Release ${num(r.qty)} ${r.unit} of ${r.board} back to free stock?`)) return;
          act(() => api(`/api/reservations/${r.id}/release`, { method: "POST", body: "{}" }), "Released back to free stock.");
        });
        acts.append(b);
      }
      return el("tr", null,
        el("td", null, el("a", { class: "rv-job", href: `/job.html?id=${r.jobId}#reservations`, text: r.jobName }),
          r.line ? el("span", { class: "rv-sub", text: r.line }) : null),
        el("td", null, el("span", { text: r.board })),
        el("td", { class: "rv-num", text: `${num(r.qty)} ${r.unit}` }),
        el("td", null, el("span", { class: "rv-sub", text: r.reserved ? `${r.reserved.by.name}, ${stamp(r.reserved.at)}` : "" })),
        el("td", null, acts));
    });
    return el("div", { class: "rv-wrap" }, el("table", { class: "hs-table rv-table" },
      el("thead", null, el("tr", null,
        ...["Job", "Stock", "Qty", "Reserved by"].map((t) => el("th", { scope: "col", text: t })),
        el("th", { scope: "col" }, el("span", { class: "rv-sub", text: "" })))),
      el("tbody", null, ...rows)));
  }

  function cutList() {
    if (!data.toCut.length) return el("p", { class: "rv-empty", text: "No jobs to mark cut." });
    const boxes = [];
    const picks = data.toCut.map((j) => {
      const cb = el("input", { type: "checkbox", value: String(j.jobId), id: `rvc-${j.jobId}` });
      boxes.push(cb);
      const held = j.reservations.filter((r) => r.status === "confirmed").length;
      const waiting = j.reservations.filter((r) => r.status === "reserved").length;
      const sub = [held ? `${held} reserved ${held === 1 ? "item" : "items"} come off stock` : "", waiting ? `${waiting} not yet labelled (stays reserved)` : ""].filter(Boolean).join(" · ");
      return el("div", { class: "rv-pick" }, cb,
        el("label", { for: `rvc-${j.jobId}` }, el("span", { class: "rv-job", text: j.name }),
          sub ? el("span", { class: "rv-sub", text: sub }) : null));
    });
    const host = el("div", null, ...picks);
    if (data.canConfirm) {
      const b = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Record cut 100%" });
      b.addEventListener("click", () => {
        const ids = boxes.filter((x) => x.checked).map((x) => Number(x.value));
        if (!ids.length) {
          setStatus("Tick the jobs cut 100% first.");
          return;
        }
        if (!confirm(`Record ${ids.length} ${ids.length === 1 ? "job" : "jobs"} as cut 100%? Their reserved stock comes off on hand.`)) return;
        act(async () => {
          const r = await api("/api/workshop/cut", { method: "POST", body: JSON.stringify({ jobIds: ids }) });
          return r;
        }, `Recorded ${ids.length} ${ids.length === 1 ? "job" : "jobs"} as cut 100%.`);
      });
      host.append(el("div", { class: "rv-cutbar" }, b));
    }
    return host;
  }

  function stockTable() {
    if (!data.stock.length) return el("p", { class: "rv-empty", text: "No boards or edge tape on the list yet." });
    const rows = data.stock.map((s) => el("tr", null,
      el("td", null, el("span", { text: s.name }), el("span", { class: "rv-sub", text: s.kind === "edge" ? "Edge tape (rolls)" : "Board (sheets)" })),
      el("td", { class: "rv-num", text: num(s.onHand) }),
      el("td", { class: "rv-num", text: num(s.reserved) }),
      el("td", { class: "rv-num", text: num(s.free) })));
    return el("div", { class: "rv-wrap" }, el("table", { class: "hs-table rv-table" },
      el("thead", null, el("tr", null, ...["Item", "On hand", "Reserved", "Free"].map((t) => el("th", { scope: "col", text: t })))),
      el("tbody", null, ...rows)));
  }

  function render() {
    $("rvLabel").replaceChildren(resTable(data.toLabel, true));
    $("rvHeld").replaceChildren(resTable(data.reservedNotCut, false));
    $("rvCut").replaceChildren(cutList());
    $("rvStock").replaceChildren(stockTable());
  }

  async function load(msg) {
    try {
      data = await api("/api/reservations");
      render();
      setStatus(msg || "");
    } catch (e) {
      setStatus(e.message);
    }
  }

  async function act(fn, msg) {
    try {
      await fn();
      await load(msg);
    } catch (e) {
      await load(e.message);
    }
  }

  load();
})();
