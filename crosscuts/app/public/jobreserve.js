// Stock reservations on the job page (0.2.6, docs/plans/m27-contracts.md section 5). Lists the job's
// boards and edging order lines with their reservations; the order manager (orders.mark_ordered)
// may Reserve from stock (an item, a quantity no more than free, and whether anything is left to
// order on the line); a live reservation can be released before it is cut. Shows when the job was
// recorded as cut 100%. Fills <section id="reservations">; ?id=N is the job. Text only.
(function () {
  "use strict";

  const sec = document.getElementById("reservations");
  const jobId = Number(new URLSearchParams(location.search).get("id"));
  if (!sec || !Number.isInteger(jobId) || jobId <= 0) return;
  const body = document.getElementById("rsBody");
  const statusEl = document.getElementById("rsStatus");
  const cutEl = document.getElementById("rsCut");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const STATUS = { reserved: "Reserved, to label", confirmed: "Reserved and labelled", cut: "Cut", released: "Released" };

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
  function day(s) {
    const p = String(s || "").slice(0, 10).split("-");
    return p.length === 3 ? `${Number(p[2])} ${MONTHS[Number(p[1]) - 1]} ${p[0]}` : "";
  }
  const num = (q) => String(Math.round(q * 2) / 2);

  let data = null;

  function resLine(r) {
    const li = el("li", { class: "jr-res" },
      el("span", { text: `${num(r.qty)} ${r.unit} of ${r.board}` }),
      el("span", { class: r.status === "released" ? "hs-badge hs-badge-na" : "hs-badge hs-badge-teal", text: STATUS[r.status] || r.status }),
      r.covers ? el("span", { class: "jr-sub", text: "Nothing left to order" }) : null);
    if ((r.status === "reserved" || r.status === "confirmed") && (data.canReserve || data.canConfirm)) {
      const b = el("button", { type: "button", class: "hs-btn", text: "Release", "aria-label": `Release ${num(r.qty)} ${r.unit} of ${r.board}` });
      b.addEventListener("click", () => act(() => api(`/api/reservations/${r.id}/release`, { method: "POST", body: "{}" }), "Released back to free stock."));
      li.append(b);
    }
    return li;
  }

  function reserveForm(line, host) {
    const kind = line.section === "edging" ? "edge" : "board";
    const items = data.stock.filter((s) => s.kind === kind && s.free > 0);
    if (!items.length) {
      host.replaceChildren(el("span", { class: "jr-sub", text: kind === "edge" ? "No edge tape free in stock." : "No boards free in stock." }));
      return;
    }
    const sel = el("select", { class: "hs-input", "aria-label": "Stock item" },
      ...items.map((s) => el("option", { value: String(s.id), text: `${s.name} (${num(s.free)} free)` })));
    const qty = el("input", { class: "hs-input jr-qty", type: "number", min: kind === "edge" ? "1" : "0.5", step: kind === "edge" ? "1" : "0.5", "aria-label": "Quantity" });
    const covers = el("input", { type: "checkbox" });
    const save = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Reserve" });
    const cancel = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Cancel" });
    cancel.addEventListener("click", render);
    save.addEventListener("click", () => {
      const q = Number(qty.value);
      if (!(q > 0)) {
        statusEl.textContent = "Give the quantity to reserve.";
        return;
      }
      act(() => api(`/api/job-records/${jobId}/reservations`, {
        method: "POST",
        body: JSON.stringify({ orderId: line.orderId, boardId: Number(sel.value), qty: q, covers: covers.checked }),
      }), "Reserved. The workshop manager labels it for the job.");
    });
    host.replaceChildren(el("div", { class: "jr-form" }, sel, qty,
      el("label", { class: "jr-check" }, covers, " Nothing left to order on this line"), save, cancel));
    sel.focus();
  }

  function render() {
    if (!data) return;
    const any = data.lines.length || data.reservations.length || data.cut;
    sec.hidden = !any;
    if (!any) return;
    cutEl.hidden = !data.cut;
    if (data.cut) cutEl.textContent = `Cut 100% on ${day(data.cut.date)}, recorded by ${data.cut.by.name}.`;
    if (!data.lines.length) {
      body.replaceChildren(el("p", { class: "jr-sub", text: "No boards or edging lines on the order list." }));
      return;
    }
    const rows = data.lines.map((l) => {
      const act = el("td", { class: "jr-c-act" });
      if (data.canReserve && l.orderStatus === "to_order" && !l.covered) {
        const b = el("button", { type: "button", class: "hs-btn", text: "Reserve from stock", "aria-label": `Reserve ${l.name} from stock` });
        b.addEventListener("click", () => reserveForm(l, act));
        act.append(b);
      }
      return el("tr", null,
        el("td", null, el("span", { class: "jr-name", text: l.name }),
          el("span", { class: "jr-sub", text: [l.section === "edging" ? "Edging" : "Boards", l.qty != null ? `${num(l.qty)}${l.unit ? " " + l.unit : ""}` : ""].filter(Boolean).join(" · ") })),
        el("td", { text: l.covered ? "From stock" : l.orderStatus === "to_order" ? "To order" : l.orderStatus === "ordered" ? "Ordered" : "Received" }),
        el("td", null, l.reservations.length ? el("ul", { class: "jr-list" }, ...l.reservations.map(resLine)) : el("span", { class: "jr-sub", text: "None" })),
        act);
    });
    body.replaceChildren(el("div", { class: "jr-wrap" },
      el("table", { class: "hs-table jr-table" },
        el("thead", null, el("tr", null,
          el("th", { scope: "col", text: "Line" }),
          el("th", { scope: "col", text: "Order" }),
          el("th", { scope: "col", text: "Reserved from stock" }),
          el("th", { scope: "col" }, el("span", { class: "jr-sr", text: "Actions" })))),
        el("tbody", null, ...rows))));
  }

  async function load() {
    try {
      data = await api(`/api/job-records/${jobId}/reservations`);
    } catch (e) {
      return;
    }
    render();
  }

  async function act(fn, msg) {
    try {
      await fn();
      statusEl.textContent = msg;
    } catch (e) {
      statusEl.textContent = e.message;
    }
    await load();
  }

  load();
})();
