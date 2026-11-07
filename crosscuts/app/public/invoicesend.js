// Send an invoice by email (0.2.13). Shared by the invoice page and the Accounts invoice dialog.
//
//   ccInvoiceSend.mount(inv, { button, panel, onChange })
//     inv      the invoice object (needs id, number, status)
//     button   an existing, hidden button: shown and wired when the person may send this invoice
//     panel    an empty element: filled with the alert and the email history when there is any
//     onChange called after a send, so the page can refresh what it shows
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

  function renderPanel(inv, ov, o, reload) {
    var panel = o.panel;
    if (!panel) return;
    panel.textContent = "";
    var rows = ov.history || [];
    if (!rows.length) {
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
    var table = el("table", "hs-table ise-table");
    var hr = el("tr");
    ["Sent", "To", "By", "Status"].forEach(function (h) { hr.appendChild(el("th", null, h)); });
    add(table, add(el("thead"), hr));
    var tb = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr");
      var to = el("td", "ise-to", r.to);
      if (r.cc) to.title = "CC: " + r.cc;
      add(tr, el("td", "ise-when", when(r.sentAt)), to, el("td", null, r.sentBy ? r.sentBy.name : ""), add(el("td"), tag(r)));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    panel.appendChild(table);
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

  function openDialog(inv, ov, onSent) {
    var dlg = el("dialog", "cc-dialog ise-dialog");
    dlg.setAttribute("aria-labelledby", "iseTitle");
    var form = el("div", "cc-dialog-form");
    var d = ov.defaults || {};
    add(form, el("p", "ise-eyebrow", "Invoice " + (inv.number || "")));
    var title = el("h2", "cc-dialog-title", "Send invoice");
    title.id = "iseTitle";
    form.appendChild(title);

    if (!ov.configured) {
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
    var toHint = el("div", "ise-hint", d.to ? "From the job's client" : "No email is on file for this client: type one");
    var ccHint = el("div", "ise-hint", "Optional, separate with commas");
    var two = el("div", "ise-two");
    add(two, add(field("To", to, "ise-to"), toHint), add(field("CC", cc, "ise-cc"), ccHint));
    form.appendChild(two);

    var from = el("input", "hs-input ise-ro");
    from.id = "ise-from"; from.type = "text"; from.readOnly = true; from.value = ov.from || "";
    form.appendChild(field("From", from, "ise-from"));
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
    var go = el("button", "hs-btn hs-btn-primary", "Send invoice");
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
      api("/api/invoices/" + encodeURIComponent(inv.id) + "/email", {
        method: "POST",
        body: JSON.stringify({ to: to.value, cc: cc.value, subject: subject.value, body: msg.value }),
      })
        .then(function (out) {
          dlg.close();
          toast(out && out.markedSent === false ? "Email sent (mark it sent by hand)" : "Invoice sent");
          if (onSent) onSent(out);
        })
        .catch(function (e) {
          for (var j = 0; j < all.length; j++) all[j].disabled = false;
          go.textContent = "Send invoice";
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
    var ready = window.cc && window.cc.ready ? window.cc.ready : Promise.resolve();
    return ready
      .then(function () {
        return api("/api/invoices/" + encodeURIComponent(inv.id) + "/email");
      })
      .then(function draw(ov) {
        function reload(next) {
          if (next && next.history) return draw(next);
          return api("/api/invoices/" + encodeURIComponent(inv.id) + "/email").then(draw);
        }
        renderPanel(inv, ov, o, reload);
        var btn = o.button;
        if (btn) {
          var visible = can("invoices.edit") && ov.sendable;
          btn.hidden = !visible;
          if (visible) {
            btn.textContent = (ov.history || []).length ? "Re-send" : "Send invoice";
            btn.onclick = function () {
              // Re-read first: the To, the template and whether email is set up may have changed.
              api("/api/invoices/" + encodeURIComponent(inv.id) + "/email")
                .then(function (fresh) {
                  openDialog(inv, fresh, function () {
                    reload();
                    if (o.onChange) o.onChange();
                  });
                })
                .catch(function (e) { toast("Error: " + e.message); });
            };
          }
        }
      })
      .catch(function () {
        // No email panel is better than a broken page.
      });
  }

  window.ccInvoiceSend = { mount: mount };
})();
