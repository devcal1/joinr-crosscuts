// The "Next reminder" line and the pause dialog on an invoice (0.2.19).
// docs/plans/invoice-reminders-plan.md sections 6.1 and 12.
//
// Normally used through invoicesend.js, which owns the Email history panel, the Send reminder button
// and the dialog. The one call a page makes (the invoice page, and the Accounts invoice dialog) is:
//
//   ccInvoiceSend.mount(inv, { button, panel, reminderButton, onChange, clientName })
//     button          the hidden "Send invoice" / "Re-send" button
//     panel           the empty element that gets the alert, the email history and the Next reminder line
//     reminderButton  a hidden button that becomes "Send reminder" when a reminder may be sent by hand
//     onChange        optional, called after a send or a pause so the page can refresh
//     clientName      optional, the job's client name for "Pause every invoice for <client>" (falls back
//                     to inv.billToName, inv.clientName)
//   load invoicesend.css, invoicereminders.css, invoicesend.js and invoicereminders.js on the page.
//
// This file exports window.ccInvoiceReminders.line(inv, rem, {clientName, reload}) -> element or null.
// Text content only, never innerHTML.
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

  // "2026-11-17" -> "Tue 17 Nov"
  function day(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || "");
    if (!m) return "";
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var p = {};
    new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
      .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return p.weekday + " " + p.day + " " + p.month;
  }

  function badge(cls, text) {
    return el("span", "hs-badge " + cls, text);
  }
  function space() {
    return document.createTextNode(" ");
  }
  function putJson(path, body) {
    return api(path, { method: "PUT", body: JSON.stringify(body) });
  }

  function pauseDialog(inv, o) {
    var dlg = el("dialog", "cc-dialog irm-dialog");
    dlg.setAttribute("aria-labelledby", "irmTitle");
    var form = el("div", "cc-dialog-form");
    add(form, el("p", "ise-eyebrow", "Invoice " + (inv.number || "")));
    var title = el("h2", "cc-dialog-title", "Pause reminders");
    title.id = "irmTitle";
    form.appendChild(title);

    var until = el("input", "hs-input");
    until.id = "irm-until"; until.type = "date";
    var note = el("input", "hs-input");
    note.id = "irm-note"; note.type = "text"; note.maxLength = 500; note.autocomplete = "off";
    function field(label, node, id, hint) {
      var f = el("div", "cc-field");
      var l = el("label", "cc-field-label", label);
      l.setAttribute("for", id);
      add(f, l, node);
      if (hint) f.appendChild(el("div", "ise-hint", hint));
      return f;
    }
    var two = el("div", "ise-two");
    add(two, field("Until (optional)", until, "irm-until", "Empty: until you resume them"), field("Reason (optional)", note, "irm-note"));
    form.appendChild(two);

    var chk = null;
    if (o.clientName) {
      var lab = el("label", "irm-check");
      chk = el("input");
      chk.type = "checkbox";
      add(lab, chk, el("span", null, "Pause every invoice for " + o.clientName + " instead"));
      form.appendChild(lab);
    }

    var err = el("p", "cc-dialog-error");
    err.setAttribute("role", "alert");
    var cancel = el("button", "hs-btn", "Cancel");
    cancel.type = "button";
    var go = el("button", "hs-btn hs-btn-primary", "Pause");
    go.type = "button";
    add(form, err, add(el("div", "cc-dialog-actions"), cancel, go));
    cancel.addEventListener("click", function () { dlg.close(); });
    go.addEventListener("click", function () {
      err.textContent = "";
      go.disabled = true;
      var body = { paused: true };
      if (until.value) body.until = until.value;
      if (note.value.trim()) body.note = note.value.trim();
      var asClient = !!(chk && chk.checked);
      var req;
      if (asClient) {
        body.clientName = o.clientName;
        req = putJson("/api/invoice-reminders/clients", body);
      } else {
        req = putJson("/api/invoices/" + encodeURIComponent(inv.id) + "/reminders/pause", body);
      }
      req
        .then(function () {
          dlg.close();
          toast(asClient ? "Reminders paused for " + o.clientName : "Reminders paused");
          if (o.reload) o.reload();
        })
        .catch(function (e) {
          err.textContent = e.message;
          go.disabled = false;
        });
    });
    dlg.appendChild(form);
    dlg.addEventListener("close", function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
    until.focus();
  }

  // The line at the foot of the Email history panel. Returns null when there is nothing to say.
  function line(inv, rem, o) {
    o = o || {};
    if (!rem || rem.why === "notIssued" || rem.why === "notOverdue") return null;
    if (rem.why === "bounced") return null; // the orange alert above already says so
    var box = el("div", "irm-next");
    var text = el("span", "irm-text");
    var edit = can("invoices.edit");
    var buttons = [];
    function pauseBtn() {
      var b = el("button", "hs-btn ise-small", "Pause reminders");
      b.type = "button";
      b.addEventListener("click", function () { pauseDialog(inv, { clientName: o.clientName, reload: o.reload }); });
      return b;
    }
    function resumeBtn(label, run) {
      var b = el("button", "hs-btn ise-small", label);
      b.type = "button";
      b.addEventListener("click", function () {
        b.disabled = true;
        run()
          .then(function () {
            toast("Reminders resumed");
            if (o.reload) o.reload();
          })
          .catch(function (e) {
            toast("Error: " + e.message);
            b.disabled = false;
          });
      });
      return b;
    }

    if (rem.pausedNow || rem.why === "paused") {
      add(text, badge("hs-badge-na", rem.pausedUntil ? "Paused until " + day(rem.pausedUntil) : "Paused"));
      if (rem.pauseNote) add(text, space(), el("span", "irm-sub", rem.pauseNote));
      if (edit) buttons.push(resumeBtn("Resume", function () {
        return putJson("/api/invoices/" + encodeURIComponent(inv.id) + "/reminders/pause", { paused: false });
      }));
    } else if (rem.clientPaused) {
      add(text, badge("hs-badge-na", rem.clientPausedUntil ? "Client paused until " + day(rem.clientPausedUntil) : "Client paused"));
      add(text, space(), el("span", "irm-sub", "Reminders are paused for every invoice for this client."));
      if (edit && o.clientName) buttons.push(resumeBtn("Resume client", function () {
        return putJson("/api/invoice-reminders/clients", { clientName: o.clientName, paused: false });
      }));
    } else if (rem.why === "notSent") {
      add(text, badge("hs-badge-na", "Not sent yet"), space(), el("span", "irm-sub", "Reminders start once the invoice has been sent."));
    } else if (rem.why === "allSent") {
      var n = (rem.steps || []).length || 3;
      add(text, badge("hs-badge-na", "All " + n + " reminders sent"), space(), el("span", "irm-sub", "No more go automatically. Send reminder still works."));
    } else if (rem.mode === "off") {
      add(text, badge("hs-badge-na", "Reminders are off"), space(), el("span", "irm-sub", "Send reminder still works."));
    } else if (rem.beforeSwitchOn) {
      add(text, badge("hs-badge-na", "Before reminders"), space(),
        el("span", "irm-sub", "This invoice was overdue before reminders were switched on" + (rem.onSince ? " (" + day(rem.onSince) + ")" : "") + ", so none go automatically. Send reminder still works."));
    } else if (rem.why === "noEmail") {
      add(text, badge("hs-badge-check", "No email on file"), space(), el("span", "irm-sub", "Add the client's email to the job so reminders can go."));
      if (edit) buttons.push(pauseBtn());
    } else if ((rem.steps || []).some(function (s) { return s.state === "queued"; })) {
      // A reminder is prepared and waiting: say so, rather than pointing at the step after it.
      var q = (rem.steps || []).filter(function (s) { return s.state === "queued"; })[0];
      add(text, badge("hs-badge-check", "Reminder " + q.step + " ready"), space(),
        el("span", "irm-sub", rem.mode === "auto" ? "It goes out shortly." : "Waiting for approval on the overdue list."));
      if (edit) buttons.push(pauseBtn());
    } else if (rem.nextStep) {
      var st = (rem.steps || [])[rem.nextStep - 1] || {};
      add(text, document.createTextNode("Next reminder: "), el("b", "irm-strong", "Reminder " + rem.nextStep));
      var bits = "";
      if (rem.nextDate) bits += " on " + day(rem.nextDate);
      if (st.days) bits += " (" + st.days + " days overdue)";
      bits += rem.mode === "auto" ? ", goes automatically." : ", waits for approval.";
      text.appendChild(document.createTextNode(bits));
      if (edit) buttons.push(pauseBtn());
    } else {
      return null;
    }
    box.appendChild(text);
    buttons.forEach(function (b) { box.appendChild(b); });
    return box;
  }

  window.ccInvoiceReminders = { line: line, pauseDialog: pauseDialog };
})();
