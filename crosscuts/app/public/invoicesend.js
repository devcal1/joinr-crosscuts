// Send an invoice by email (0.2.13). Shared by the invoice page and the Accounts invoice dialog.
//
//   ccInvoiceSend.mount(inv, { button, panel, reminderButton, onChange, clientName })
//     inv             the invoice object (needs id, number, status)
//     button          an existing, hidden button: shown and wired when the person may send this invoice
//     panel           an empty element: filled with the alert, the email history and (0.2.19) the
//                     "Next reminder" line when there is anything to show
//     reminderButton  (0.2.19) an existing, hidden button: becomes "Send reminder" for invoices.edit
//                     holders when the invoice is overdue and a reminder may be sent by hand
//     onChange        called after a send or a pause, so the page can refresh what it shows
//     clientName      the job's client name, for "Pause every invoice for <client>" (optional)
//   Load invoicesend.css, invoicereminders.css, invoicesend.js and invoicereminders.js on the page.
//
// The send dialog is built here. Everything is text content, never innerHTML. The API key never
// reaches the browser: the server only says whether email is set up.
(function () {
  "use strict";

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  function can(key) {
    return !!(window.cc && typeof window.cc.can === "function" && window.cc.can(key));
  }

  // "Fri 6 Nov, 2:41 pm" in Sydney time; "Sent just now" inside the first minute.
  function when(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    if (Date.now() - t < 60000) return "Sent just now";
    var p = {};
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
    }).formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
    return p.weekday + " " + p.day + " " + p.month + ", " + p.hour + ":" + p.minute + " " + String(p.dayPeriod || "").toLowerCase();
  }

  function tag(row) {
    var map = {
      delivered: ["hs-badge hs-badge-teal", "Delivered"],
      bounced: ["hs-badge hs-badge-check", "Bounced"],
      failed: ["hs-badge hs-badge-check", "Not delivered"],
      sent: row.stale ? ["hs-badge hs-badge-na", "Sent"] : ["hs-badge hs-badge-na", "Sent, checking"],
    };
    var m = map[row.status] || map.sent;
    return el("span", m[0], m[1]);
  }

  // ---- the history panel -------------------------------------------------------------------

  function renderPanel(inv, ov, rem, o, reload) {
    var panel = o.panel;
    if (!panel) return;
    panel.textContent = "";
    var rows = ov.history || [];
    var nextLine = null;
    if (rem && window.ccInvoiceReminders) {
      nextLine = window.ccInvoiceReminders.line(inv, rem, {
        clientName: (rem && rem.clientName) || o.clientName || inv.billToName || inv.clientName || "",
        reload: function () { reload(); if (o.onChange) o.onChange(); },
      });
    }
    if (!rows.length && !nextLine) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    panel.className = "ise-panel";
    if (ov.alert) {
      add(panel, add(el("div", "ise-alert"), el("span", null, ov.alert.message)));
    }
    var head = el("div", "ise-head");
    add(head, el("span", "ise-eyebrow", "Email history"));
    if (rows.some(function (r) { return r.status === "sent" && !r.stale; }) && can("invoices.edit")) {
      var chk = el("button", "hs-btn hs-btn-quiet ise-small", "Check now");
      chk.type = "button";
      chk.addEventListener("click", function () {
        chk.disabled = true;
        api("/api/invoices/" + encodeURIComponent(inv.id) + "/email/check", { method: "POST", body: "{}" })
          .then(function (next) { reload(next); })
          .catch(function (e) { toast("Error: " + e.message); chk.disabled = false; });
      });
      head.appendChild(chk);
    }
    panel.appendChild(head);
    if (rows.length) {
      var table = el("table", "hs-table ise-table");
      var hr = el("tr");
      ["Sent", "What", "To", "By", "Status"].forEach(function (h) { hr.appendChild(el("th", null, h)); });
      add(table, add(el("thead"), hr));
      var tb = el("tbody");
      rows.forEach(function (r) {
        var tr = el("tr");
        var isRem = r.kind === "reminder";
        var to = el("td", "ise-to", r.to);
        var tip = [];
        if (r.cc) tip.push("CC: " + r.cc);
        if (r.bcc) tip.push("BCC: " + r.bcc);
        if (tip.length) to.title = tip.join("\n");
        var by = r.sentBy ? r.sentBy.name : isRem ? "Automatic" : "";
        var what = isRem ? "Reminder" + (r.reminderStep ? " " + r.reminderStep : "") : "Invoice";
        add(tr, el("td", "ise-when", when(r.sentAt)), el("td", null, what), to, el("td", null, by), add(el("td"), tag(r)));
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      panel.appendChild(add(el("div", "ise-table-wrap"), table));
    }
    if (nextLine) panel.appendChild(nextLine);
  }

  // ---- the send dialog ---------------------------------------------------------------------

  function field(label, node, id) {
    var f = el("div", "cc-field");
    var l = el("label", "cc-field-label", label);
    l.setAttribute("for", id);
    return add(f, l, node);
  }

  function show(dlg) {
    dlg.addEventListener("close", function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  // cfg.reminder (the /reminders overview) turns this into the Send reminder dialog.
  function openDialog(inv, ov, cfg, onSent) {
    cfg = cfg || {};
    var rem = cfg.reminder || null;
    var isRem = !!rem;
    var dr = rem && rem.draft ? rem.draft : {};
    var dlg = el("dialog", "cc-dialog ise-dialog");
    dlg.setAttribute("aria-labelledby", "iseTitle");
    var form = el("div", "cc-dialog-form");
    var d = isRem ? { to: dr.to, cc: dr.cc, subject: dr.subject, body: dr.body, filename: (ov.defaults || {}).filename } : ov.defaults || {};
    var eyebrow = "Invoice " + (inv.number || "");
    if (isRem && rem.daysOverdue) eyebrow += " \u00b7 " + rem.daysOverdue + " days overdue";
    add(form, el("p", "ise-eyebrow", eyebrow));
    var title = el("h2", "cc-dialog-title", isRem ? "Send reminder" + (dr.step ? " " + dr.step : "") : "Send invoice");
    title.id = "iseTitle";
    form.appendChild(title);

    if (isRem && rem.dry) add(form, el("p", "ise-note", "Dry run: nothing will be emailed, the reminder is only recorded."));
    // A dry run (local dev) needs no Resend key: the server records the reminder and sends nothing.
    if (!ov.configured && !(isRem && rem.dry)) {
      add(form, el("p", "ise-note", "Email isn't set up yet. An administrator needs to add the Resend API key first (Admin, Users, Invoice email). Nothing can be sent until then."));
      var closeOnly = el("button", "hs-btn hs-btn-quiet", "Close");
      closeOnly.type = "button";
      closeOnly.addEventListener("click", function () { dlg.close(); });
      add(form, add(el("div", "cc-dialog-actions"), closeOnly));
      dlg.appendChild(form);
      show(dlg);
      return;
    }

    var to = el("input", "hs-input");
    to.id = "ise-to"; to.type = "text"; to.autocomplete = "off"; to.value = d.to || "";
    to.setAttribute("inputmode", "email");
    var cc = el("input", "hs-input");
    cc.id = "ise-cc"; cc.type = "text"; cc.autocomplete = "off"; cc.value = d.cc || "";
    var toHint = el("div", "ise-hint", !d.to ? "No email is on file for this client: type one" : isRem && dr.toFrom === "lastEmail" ? "From the last delivered email" : "From the job's client");
    var ccHint = el("div", "ise-hint", "Optional, separate with commas");
    var two = el("div", "ise-two");
    add(two, add(field("To", to, "ise-to"), toHint), add(field("CC", cc, "ise-cc"), ccHint));
    form.appendChild(two);

    var from = el("input", "hs-input ise-ro");
    from.id = "ise-from"; from.type = "text"; from.readOnly = true; from.value = ov.from || "";
    if (isRem && dr.bcc) {
      var bcc = el("input", "hs-input ise-ro");
      bcc.id = "ise-bcc"; bcc.type = "text"; bcc.readOnly = true; bcc.value = dr.bcc;
      add(form, add(el("div", "ise-two"), field("From", from, "ise-from"), add(field("BCC", bcc, "ise-bcc"), el("div", "ise-hint", "From the reminder settings"))));
    } else {
      form.appendChild(field("From", from, "ise-from"));
    }
    var subject = el("input", "hs-input");
    subject.id = "ise-subject"; subject.type = "text"; subject.maxLength = 200; subject.value = d.subject || "";
    form.appendChild(field("Subject", subject, "ise-subject"));
    var msg = el("textarea", "hs-input ise-msg");
    msg.id = "ise-msg"; msg.maxLength = 10000; msg.value = d.body || "";
    form.appendChild(field("Message", msg, "ise-msg"));

    var attach = el("div", "ise-attach");
    var name = el("span");
    add(name, el("b", null, d.filename || "Invoice.pdf"), document.createTextNode(" "), el("span", "ise-muted", "attached"));
    var prev = el("a", "hs-btn ise-small", "Preview PDF");
    prev.href = "/api/invoices/" + encodeURIComponent(inv.id) + "/pdf";
    prev.target = "_blank";
    prev.rel = "noopener";
    add(attach, name, prev);
    form.appendChild(attach);

    var err = el("p", "cc-dialog-error");
    err.setAttribute("role", "alert");
    var cancel = el("button", "hs-btn", "Cancel");
    cancel.type = "button";
    var go = el("button", "hs-btn hs-btn-primary", isRem ? "Send reminder" : "Send invoice");
    go.type = "button";
    add(form, err, add(el("div", "cc-dialog-actions"), cancel, go));

    // A plain check that there is something address-shaped in To; the server validates for real.
    function hasTo() {
      return /[^\s,;]+@[^\s,;]+\.[^\s,;]+/.test(to.value);
    }
    function sync() {
      go.disabled = !hasTo();
    }
    to.addEventListener("input", sync);
    sync();
    cancel.addEventListener("click", function () { dlg.close(); });

    go.addEventListener("click", function () {
      if (!hasTo()) return;
      err.textContent = "";
      var all = form.querySelectorAll("button, input, textarea");
      for (var i = 0; i < all.length; i++) all[i].disabled = true;
      go.textContent = "Sending...";
      api("/api/invoices/" + encodeURIComponent(inv.id) + (isRem ? "/reminders" : "/email"), {
        method: "POST",
        body: JSON.stringify({ to: to.value, cc: cc.value, subject: subject.value, body: msg.value }),
      })
        .then(function (out) {
          dlg.close();
          toast(isRem ? (out && out.dry ? "Dry run: reminder recorded, nothing emailed" : "Reminder sent") : out && out.markedSent === false ? "Email sent (mark it sent by hand)" : "Invoice sent");
          if (onSent) onSent(out);
        })
        .catch(function (e) {
          for (var j = 0; j < all.length; j++) all[j].disabled = false;
          go.textContent = isRem ? "Send reminder" : "Send invoice";
          err.textContent = e.message;
          sync();
        });
    });

    dlg.appendChild(form);
    show(dlg);
    to.focus();
  }

  // ---- mount -------------------------------------------------------------------------------

  function mount(inv, o) {
    o = o || {};
    var live = inv && (inv.status === "issued" || inv.status === "paid");
    if (!inv || !(live || o.panel)) return Promise.resolve();
    var base = "/api/invoices/" + encodeURIComponent(inv.id);
    var ready = window.cc && window.cc.ready ? window.cc.ready : Promise.resolve();
    // The reminders overview is a bonus: no access, or an error, just means no reminder line.
    function getRem() {
      if (inv.status !== "issued") return Promise.resolve(null);
      return api(base + "/reminders").catch(function () { return null; });
    }
    function both() {
      return Promise.all([api(base + "/email"), getRem()]);
    }
    function reload(next) {
      if (next && next.history) return draw(next, next.reminders || null);
      return both().then(function (p) { return draw(p[0], p[1]); });
    }
    function after() {
      reload();
      if (o.onChange) o.onChange();
    }
    function draw(ov, rem) {
      renderPanel(inv, ov, rem, o, reload);
      var btn = o.button;
      if (btn) {
        var visible = can("invoices.edit") && ov.sendable;
        btn.hidden = !visible;
        if (visible) {
          btn.textContent = (ov.history || []).length ? "Re-send" : "Send invoice";
          btn.onclick = function () {
            // Re-read first: the To, the template and whether email is set up may have changed.
            api(base + "/email")
              .then(function (fresh) { openDialog(inv, fresh, null, after); })
              .catch(function (e) { toast("Error: " + e.message); });
          };
        }
      }
      var rb = o.reminderButton;
      if (rb) {
        var rshow = can("invoices.edit") && !!rem && rem.manualAllowed && !!rem.draft;
        rb.hidden = !rshow;
        if (rshow) {
          rb.textContent = "Send reminder";
          rb.onclick = function () {
            both()
              .then(function (p) {
                if (!p[1] || !p[1].manualAllowed) {
                  toast("A reminder can't be sent for this invoice right now");
                  return reload();
                }
                openDialog(inv, p[0], { reminder: p[1] }, after);
              })
              .catch(function (e) { toast("Error: " + e.message); });
          };
        }
      }
    }
    return ready
      .then(both)
      .then(function (p) { draw(p[0], p[1]); })
      .catch(function () {
        // No email panel is better than a broken page.
      });
  }

  window.ccInvoiceSend = { mount: mount };
})();
