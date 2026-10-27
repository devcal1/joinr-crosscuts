// Individual invoices on the Supplier accounts page (0.2.7, docs/plans/m28-contracts.md section 2).
// window.Payables.block(period, opts) makes one month's "Individual invoices" block, shown below the
// supplier accounts in that month's column. Accounts (invoices.edit) adds and edits; Paid is ticked
// by users.admin holders only. Talks to /api/payables. User text is set with textContent.
(function () {
  "use strict";

  const P = window.Periods;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const CHECK = "✓"; // a check mark character, not an icon

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
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : "";
  }
  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  function centsToInput(c) {
    if (c == null) return "";
    const a = Math.abs(c);
    return (c < 0 ? "-" : "") + Math.floor(a / 100) + "." + String(a % 100).padStart(2, "0");
  }

  async function call(method, path, body) {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const opts = { method, headers: { Accept: "application/json" } };
    if (body !== undefined) {
      if (isForm) opts.body = body;
      else {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(path, opts);
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Something went wrong (${res.status})`);
    return data;
  }

  // ---------------------------------------------------------------- the dialog ---

  let dlg = null;
  function dialog() {
    if (dlg) return dlg;
    dlg = el("dialog", { class: "cc-dialog su-dialog", "aria-labelledby": "piTitle" });
    document.body.append(dlg);
    return dlg;
  }

  function field(label, node, id) {
    return el("div", { class: "cc-field" }, el("label", { class: "cc-field-label", for: id, text: label }), node);
  }

  // Add (line null) or edit an individual invoice of `period`.
  function openEditor(period, line, opts, done) {
    const d = dialog();
    const err = el("p", { class: "cc-dialog-error", role: "alert" });
    const payee = el("input", { id: "piPayee", class: "hs-input", type: "text", maxlength: "100", autocomplete: "off" });
    payee.value = line ? line.payee : "";
    const desc = el("input", { id: "piDesc", class: "hs-input", type: "text", maxlength: "500", autocomplete: "off" });
    desc.value = line ? line.description : "";
    const amount = el("input", { id: "piAmount", class: "hs-input", type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "Leave empty if not known yet" });
    amount.value = line ? centsToInput(line.amountCents) : "";
    const due = el("input", { id: "piDue", class: "hs-input", type: "date" });
    due.value = line && line.dueDate ? line.dueDate : "";
    const month = el("input", { id: "piMonth", class: "hs-input", type: "month" });
    month.value = line ? line.period : period;
    const myob = el("input", { id: "piMyob", type: "checkbox" });
    myob.checked = !!(line && line.myob);
    const save = el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: "Save" });
    const cancel = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Cancel" });
    cancel.addEventListener("click", () => d.close());
    const actions = el("div", { class: "cc-dialog-actions" }, cancel, save);
    const form = el("form", { class: "cc-dialog-form", method: "dialog", novalidate: true },
      el("h2", { class: "cc-dialog-title", id: "piTitle", text: line ? `Individual invoice: ${line.payee}` : "Add individual invoice" }),
      el("p", { class: "cc-dialog-note", text: "A one-off bill from someone who isn't a supplier account. It is listed in its month below the supplier accounts; admin ticks it paid." }),
      field("Payee", payee, "piPayee"),
      field("What it is for", desc, "piDesc"),
      el("div", { class: "su-pi-row" }, field("Amount", amount, "piAmount"), field("Due date", due, "piDue"), field("Month", month, "piMonth")),
      el("label", { class: "su-check", for: "piMyob" }, myob, document.createTextNode(" Entered in MYOB")));

    if (line) {
      // the file
      const fileRow = el("div", { class: "su-pi-row" });
      if (line.file) {
        fileRow.append(el("a", { href: `/api/files/${line.file.id}`, target: "_blank", rel: "noopener", text: line.file.name || "The invoice file" }));
        const rm = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Remove file" });
        rm.addEventListener("click", async () => {
          try {
            await call("DELETE", `/api/payables/${line.id}/file`);
            d.close();
            done();
          } catch (e) {
            err.textContent = e.message;
          }
        });
        fileRow.append(rm);
      }
      const pick = el("input", { type: "file", accept: ".pdf,.jpg,.jpeg,.png", "aria-label": "Attach the invoice file" });
      pick.addEventListener("change", async () => {
        if (!pick.files || !pick.files[0]) return;
        const fd = new FormData();
        fd.append("file", pick.files[0]);
        try {
          await call("POST", `/api/payables/${line.id}/file`, fd);
          d.close();
          done();
        } catch (e) {
          err.textContent = e.message;
        }
      });
      fileRow.append(pick);
      form.append(field(line.file ? "File" : "Attach the invoice", fileRow, ""));

      const more = el("div", { class: "su-pi-row" });
      if (!line.supplier) {
        const conv = el("button", { type: "button", class: "hs-btn", text: "Make a supplier account" });
        conv.addEventListener("click", async () => {
          if (!confirm(`Add ${line.payee} as a supplier account from ${P.longLabel(line.period)}? This invoice stays where it is.`)) return;
          try {
            await call("POST", `/api/payables/${line.id}/convert`, {});
            d.close();
            done({ suppliersChanged: true });
          } catch (e) {
            err.textContent = e.message;
          }
        });
        more.append(conv);
      } else {
        more.append(el("span", { class: "su-pi-sub", text: `Supplier account: ${line.supplier.name}` }));
      }
      if (!line.paid) {
        const del = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Remove" });
        del.addEventListener("click", async () => {
          if (!confirm(`Remove the invoice from ${line.payee}?`)) return;
          try {
            await call("DELETE", `/api/payables/${line.id}`);
            d.close();
            done();
          } catch (e) {
            err.textContent = e.message;
          }
        });
        more.append(del);
      }
      form.append(more);
    }
    form.append(err, actions);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const a = amount.value.trim();
      let cents = null;
      if (a) {
        cents = P.parseDollars(a);
        if (cents == null || Number.isNaN(cents)) {
          err.textContent = "Type the amount like 1,234.50, or leave it empty";
          return;
        }
      }
      const body = { payee: payee.value, description: desc.value, amountCents: cents, dueDate: due.value || null, myob: myob.checked };
      if (month.value) body.period = month.value;
      save.disabled = true;
      try {
        if (line) await call("PATCH", `/api/payables/${line.id}`, body);
        else await call("POST", "/api/payables", body);
        d.close();
        done();
      } catch (e2) {
        err.textContent = e2.message;
      } finally {
        save.disabled = false;
      }
    });
    d.replaceChildren(form);
    d.showModal();
    payee.focus();
  }

  // ---------------------------------------------------------------- the block ---

  // opts: {canEdit, canPay, onChange(info)}. Returns {root, load(), data, leftCents(), missing()}.
  function block(period, opts) {
    const o = opts || {};
    const b = { period, data: null };
    const status = el("p", { class: "su-status", role: "status" });
    const tbody = el("tbody");
    const table = el("table", { class: "su-ind-table" },
      el("thead", null, el("tr", null,
        el("th", { scope: "col", text: "Payee" }),
        el("th", { scope: "col", text: "Due" }),
        el("th", { scope: "col", class: "num", text: "Amount" }),
        el("th", { scope: "col", class: "su-ind-tick" }, el("abbr", { title: "Entered in MYOB", "aria-label": "Entered in MYOB", text: "M" })),
        el("th", { scope: "col", text: "Paid" }))),
      tbody);
    table.hidden = true;
    const empty = el("p", { class: "su-empty", text: "None." });
    empty.hidden = true;
    const head = el("div", { class: "su-ind-head" }, el("h3", { class: "su-ind-title", text: "Individual invoices" }));
    if (o.canEdit) {
      const add = el("button", { type: "button", class: "hs-btn", text: "Add" , "aria-label": `Add an individual invoice for ${P.longLabel(period)}` });
      add.addEventListener("click", () => openEditor(period, null, o, after));
      head.append(add);
    }
    b.root = el("div", { class: "su-ind" }, head, status, empty, table);

    function after(info) {
      b.load();
      if (o.onChange) o.onChange(info || {});
    }

    function render() {
      tbody.replaceChildren();
      const lines = b.data ? b.data.lines : [];
      for (const l of lines) {
        const tr = el("tr", { class: l.missing ? "su-row-missing" : null });
        const name = o.canEdit
          ? el("button", { type: "button", class: "su-ind-open", text: l.payee, title: l.description || null })
          : el("span", { text: l.payee });
        if (o.canEdit) name.addEventListener("click", () => openEditor(period, l, o, after));
        const nameTd = el("td", null, name);
        if (l.description) nameTd.append(el("span", { class: "su-pi-sub", text: l.description }));
        if (l.file) nameTd.append(el("a", { class: "su-pi-sub", href: `/api/files/${l.file.id}`, target: "_blank", rel: "noopener", text: "File" }));
        tr.append(nameTd);
        tr.append(el("td", { text: l.dueDate ? fmtDate(l.dueDate) : "No date" }));
        tr.append(el("td", { class: "num", text: l.amountCents == null ? "Missing" : P.dollars(l.amountCents) }));
        tr.append(el("td", { class: "su-ind-tick", text: l.myob ? CHECK : "" }));
        const paidTd = el("td");
        if (l.paid) paidTd.append(el("span", { text: `${CHECK} ${fmtDate(l.paidDate)}` }));
        if (o.canPay) {
          const pb = el("button", { type: "button", class: "hs-btn" + (l.paid ? " hs-btn-quiet" : ""), text: l.paid ? "Unmark" : "Paid", "aria-label": (l.paid ? "Unmark paid: " : "Mark paid: ") + l.payee });
          pb.addEventListener("click", async () => {
            pb.disabled = true;
            try {
              await call("POST", `/api/payables/${l.id}/paid`, { paid: !l.paid, paidDate: l.paid ? undefined : todayISO() });
              after();
            } catch (e) {
              status.textContent = e.message;
              pb.disabled = false;
            }
          });
          paidTd.append(pb);
        }
        tr.append(paidTd);
        tbody.append(tr);
      }
      table.hidden = !lines.length;
      empty.hidden = !!lines.length;
    }

    b.load = async () => {
      try {
        b.data = await call("GET", `/api/payables/months/${period}`);
        status.textContent = "";
      } catch (e) {
        b.data = null;
        status.textContent = `Couldn't load the individual invoices: ${e.message}`;
      }
      render();
      if (o.onLoad) o.onLoad();
    };
    b.leftCents = () => (b.data ? b.data.leftCents : 0);
    b.missing = () => (b.data ? b.data.counts.missing : 0);
    b.listed = () => (b.data ? b.data.counts.listed : 0);
    b.paid = () => (b.data ? b.data.counts.paid : 0);
    return b;
  }

  window.Payables = { block };
})();
