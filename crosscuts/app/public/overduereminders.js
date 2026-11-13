// Overdue invoice reminders on the Accounts overdue list (0.2.19): the "Reminder emails" settings box,
// the "ready to send" strip, the Reminders column cell and the Send / Skip buttons.
// docs/plans/invoice-reminders-plan.md sections 9 and 12. Text content only, never innerHTML.
//
// accounts.js calls (after window.cc is ready):
//   ccOverdueReminders.init({ box, summary, body, strip, errLine, canEdit, reload })
//   await ccOverdueReminders.loadSettings()       settings box (once, and after Save)
//   await ccOverdueReminders.loadQueue()          the waiting reminders, before drawing rows
//   ccOverdueReminders.setList(list)              the overdue list, for the live preview
//   ccOverdueReminders.cell(item) -> <td>         the Reminders column
//   ccOverdueReminders.buttons(item) -> [button]  Send and Skip, for a row with a queued reminder
//   ccOverdueReminders.renderStrip()
(function () {
  "use strict";

  var R = { settings: null, queue: { mode: "off", queued: [] }, byId: {}, list: [], opts: null };
  var MODE_LABEL = { off: "Off", approval: "Ready for approval", auto: "Automatic" };
  var MODE_HELP = {
    off: "Nothing is emailed. The overdue list still shows which reminder is due, so you can phone instead.",
    approval: "Each weekday at the set time the reminders that are due wait for you on the overdue list. Nothing goes until you press Send.",
    auto: "Crosscuts sends them itself at the set time, Monday to Friday.",
  };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  function can() {
    return !!(R.opts && R.opts.canEdit && R.opts.canEdit());
  }
  function parts(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || "");
    if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return { y: +m[1], m: +m[2] - 1, d: +m[3], dow: d.getUTCDay() };
  }
  function short(ymd) {
    var p = parts(ymd);
    return p ? p.d + " " + MONTHS[p.m] : "";
  }
  function day(ymd) {
    var p = parts(ymd);
    return p ? DOW[p.dow] + " " + p.d + " " + MONTHS[p.m] : "";
  }
  function dayYear(ymd) {
    var p = parts(ymd);
    return p ? day(ymd) + " " + p.y : "";
  }
  function longDate(ymd) {
    var p = parts(ymd);
    return p ? p.d + " " + LONG_MONTHS[p.m] + " " + p.y : "";
  }
  function sydneyToday() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  function isoDay(iso) {
    if (!iso) return "";
    var t = new Date(iso);
    if (isNaN(t.getTime())) return "";
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  }
  function money(cents) {
    if (cents == null) return "";
    var a = Math.abs(cents);
    var whole = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (cents < 0 ? "-" : "") + "$" + whole + "." + String(a % 100).padStart(2, "0");
  }
  function hourLabel(h) {
    var n = h % 12 === 0 ? 12 : h % 12;
    return n + ":00 " + (h < 12 ? "am" : "pm");
  }
  function jsonBody(o) {
    return JSON.stringify(o);
  }
  function badge(cls, text) {
    return el("span", "hs-badge " + cls, text);
  }

  // The same filling rules as the server (lib/invoicereminders.js fill).
  function fill(text, vars) {
    var t = String(text);
    if (!vars.job) t = t.replace(/\s+for \{job\}/g, "");
    if (!vars.phone) t = t.replace(/\s+on \{phone\}/g, "");
    if (!vars.client) t = t.replace(/Hi \{client\},/g, "Hi,");
    if (String(vars.days) === "1") t = t.replace(/\{days\} days/g, "1 day");
    return t.replace(/\{([^{}]*)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
    });
  }

  // ---- loading ------------------------------------------------------------------------------------

  function init(opts) {
    R.opts = opts;
  }
  function setList(list) {
    R.list = list || [];
    if (R.redraw) R.redraw();
  }
  function loadQueue() {
    return api("/api/invoice-reminders/queue").then(
      function (q) {
        R.queue = { mode: q.mode || "off", queued: q.queued || [] };
        R.byId = {};
        R.queue.queued.forEach(function (r) { R.byId[r.id] = r; });
      },
      function () {
        R.queue = { mode: "off", queued: [] };
        R.byId = {};
      }
    );
  }
  function loadSettings() {
    var o = R.opts;
    return api("/api/invoice-reminders/settings").then(
      function (s) {
        R.settings = s;
        o.box.hidden = false;
        drawBox();
      },
      function () { /* no access to accounts: the box stays hidden */ }
    );
  }

  // ---- the settings box ---------------------------------------------------------------------------

  function summaryText(s) {
    var bits = ["Reminder emails"];
    if (s.mode === "off") {
      bits.push("Off");
    } else {
      bits.push(MODE_LABEL[s.mode] + (s.onSince ? " since " + short(s.onSince) : ""));
      bits.push((s.days || []).join(", ") + " days");
      bits.push(String(s.hour).padStart(2, "0") + ":00");
    }
    return bits.join(" · ");
  }

  function field(label, node, id, hint) {
    var f = el("div", "cc-field");
    if (id) {
      var l = el("label", "cc-field-label", label);
      l.setAttribute("for", id);
      f.appendChild(l);
    } else {
      f.appendChild(el("span", "cc-field-label", label));
    }
    f.appendChild(node);
    if (hint) f.appendChild(el("p", "ac-hint", hint));
    return f;
  }

  function drawBox() {
    var s = R.settings;
    var o = R.opts;
    var edit = can();
    o.summary.textContent = summaryText(s);
    var body = o.body;
    body.replaceChildren();

    if (s.dryRun) {
      var dry = el("div", "irm-strip");
      var dt = el("span");
      add(dt, el("b", null, "Dry run: "), document.createTextNode("this server is in dry-run mode. Reminders are recorded but nothing is emailed."));
      dry.appendChild(dt);
      body.appendChild(dry);
    }
    if (!s.configured && !s.dryRun) {
      body.appendChild(el("p", "ac-hint", "Email sending isn't set up yet, so no reminder can go out until it is."));
    }

    var grid = el("div", "irm-grid");
    var left = el("div", "irm-col");
    var right = el("div", "irm-col");
    grid.appendChild(left);
    grid.appendChild(right);

    // --- mode
    var radios = {};
    var modeBox = el("div", "irm-mode");
    modeBox.setAttribute("role", "radiogroup");
    ["off", "approval", "auto"].forEach(function (m) {
      var lab = el("label");
      var inp = el("input");
      inp.type = "radio";
      inp.name = "irm-mode";
      inp.value = m;
      inp.checked = s.mode === m;
      inp.disabled = !edit;
      radios[m] = inp;
      var txt = el("span");
      add(txt, el("b", null, MODE_LABEL[m]), el("small", null, MODE_HELP[m]));
      add(lab, inp, txt);
      inp.addEventListener("change", sync);
      modeBox.appendChild(lab);
    });
    function sync() {
      Object.keys(radios).forEach(function (m) { radios[m].parentNode.classList.toggle("on", radios[m].checked); });
    }
    sync();
    var modeField = el("div", "cc-field");
    modeField.appendChild(el("span", "cc-field-label", "Sending"));
    modeField.appendChild(modeBox);
    if (s.mode === "off") {
      modeField.appendChild(el("p", "irm-sub", "Switching on: reminders will only go for invoices that become overdue from today, " + day(sydneyToday()) + ". Invoices already overdue won't get any."));
      modeField.appendChild(el("p", "ac-hint", "Once on, this reads: \"On since " + dayYear(sydneyToday()) + ". Invoices overdue before then get no reminders.\" Turning it Off and on again moves this date to the new day."));
    } else {
      modeField.appendChild(el("p", "irm-sub", "On since " + dayYear(s.onSince) + ". Invoices overdue before then get no reminders. Turning it Off and on again moves this date to the new day."));
    }
    left.appendChild(modeField);

    // --- days and hour
    var dayInputs = [];
    var steps = el("div", "irm-steps");
    for (var i = 0; i < 3; i++) {
      var di = el("input", "hs-input");
      di.type = "number"; di.min = "1"; di.max = "120"; di.step = "1";
      di.id = "irm-day" + (i + 1);
      di.value = s.days[i] != null ? String(s.days[i]) : "";
      di.disabled = !edit;
      dayInputs.push(di);
      var dl = el("label", "irm-sub", "Reminder " + (i + 1));
      dl.setAttribute("for", di.id);
      add(steps, add(el("div", "cc-field"), dl, di));
    }
    var hourSel = el("select", "hs-input irm-hour");
    hourSel.id = "irm-hour";
    var hours = [];
    for (var h = 6; h <= 18; h++) hours.push(h);
    if (hours.indexOf(s.hour) < 0) hours.push(s.hour), hours.sort(function (a, b) { return a - b; });
    hours.forEach(function (hh) {
      var op = el("option", null, hourLabel(hh));
      op.value = String(hh);
      hourSel.appendChild(op);
    });
    hourSel.value = String(s.hour);
    hourSel.disabled = !edit;
    var hl = el("label", "irm-sub", "From (weekdays)");
    hl.setAttribute("for", "irm-hour");
    add(steps, add(el("div", "cc-field"), hl, hourSel));
    left.appendChild(field("Remind when overdue by (days)", steps, null,
      "Only invoices that were sent, are overdue and have a client email. If Crosscuts was off for a while, only the latest reminder due goes, never two at once."));

    // --- bcc
    var bcc = el("input", "hs-input");
    bcc.id = "irm-bcc"; bcc.type = "text"; bcc.autocomplete = "off"; bcc.spellcheck = false;
    bcc.value = s.bcc || "";
    bcc.disabled = !edit;
    left.appendChild(field("BCC every reminder to", bcc, "irm-bcc", "A copy of each reminder goes here, unseen by the client. Leave it empty for no copy."));

    // --- paused clients
    var paused = el("div", "cc-field");
    paused.appendChild(el("span", "ac-group-title", "Paused clients"));
    var plist = el("ul", "irm-list");
    var errLine = el("p", "cc-dialog-error");
    errLine.setAttribute("role", "alert");
    if (!s.clients.length) plist.appendChild(el("li", "irm-sub", "No clients are paused."));
    s.clients.forEach(function (c) {
      var li = el("li");
      var t = el("span", null, c.clientName);
      var extra = [];
      if (c.note) extra.push(c.note);
      if (c.until) extra.push("until " + short(c.until));
      if (extra.length) t.appendChild(el("span", "irm-sub", " · " + extra.join(", ")));
      li.appendChild(t);
      if (edit) {
        var rb = el("button", "hs-btn hs-btn-quiet", "Resume");
        rb.type = "button";
        rb.addEventListener("click", function () {
          rb.disabled = true;
          errLine.textContent = "";
          api("/api/invoice-reminders/clients", { method: "PUT", body: jsonBody({ clientName: c.clientName, paused: false }) })
            .then(function () { toast("Reminders resumed for " + c.clientName); return reloadAll(); })
            .catch(function (e) { errLine.textContent = e.message; rb.disabled = false; });
        });
        li.appendChild(rb);
      }
      plist.appendChild(li);
    });
    paused.appendChild(plist);
    if (edit) {
      var nm = el("input", "hs-input irm-grow");
      nm.type = "text"; nm.placeholder = "Client name"; nm.maxLength = 200; nm.autocomplete = "off";
      nm.setAttribute("aria-label", "Client name");
      var until = el("input", "hs-input irm-date");
      until.type = "date";
      until.setAttribute("aria-label", "Until (optional)");
      var pb = el("button", "hs-btn", "Pause client");
      pb.type = "button";
      pb.addEventListener("click", function () {
        errLine.textContent = "";
        var b = { clientName: nm.value, paused: true };
        if (until.value) b.until = until.value;
        pb.disabled = true;
        api("/api/invoice-reminders/clients", { method: "PUT", body: jsonBody(b) })
          .then(function () { toast("Reminders paused for " + nm.value.trim()); return reloadAll(); })
          .catch(function (e) { errLine.textContent = e.message; pb.disabled = false; });
      });
      paused.appendChild(add(el("div", "ac-row irm-addrow"), nm, until, pb));
    }
    paused.appendChild(errLine);
    left.appendChild(paused);

    // --- wording
    var work = { subject: [], body: [] };
    for (var k = 0; k < 3; k++) {
      var tpl = s.templates[k] || s.defaultTemplates[k];
      work.subject.push(tpl.subject);
      work.body.push(tpl.body);
    }
    var tab = 0;
    right.appendChild(el("span", "cc-field-label", "Wording"));
    var tabs = el("div", "irm-tabs");
    var tabBtns = [];
    for (var n = 0; n < 3; n++) {
      (function (idx) {
        var b = el("button", "hs-btn ise-small", "Reminder " + (idx + 1));
        b.type = "button";
        b.addEventListener("click", function () { store(); tab = idx; load(); });
        tabBtns.push(b);
        tabs.appendChild(b);
      })(n);
    }
    right.appendChild(tabs);
    var subj = el("input", "hs-input");
    subj.id = "irm-subject"; subj.type = "text"; subj.maxLength = 200; subj.autocomplete = "off";
    subj.disabled = !edit;
    var msg = el("textarea", "hs-input irm-msg");
    msg.id = "irm-message"; msg.rows = 10;
    msg.disabled = !edit;
    right.appendChild(field("Subject", subj, "irm-subject"));
    right.appendChild(field("Message", msg, "irm-message"));
    right.appendChild(el("p", "ac-hint", "You can use " + s.placeholders.map(function (p) { return "{" + p + "}"; }).join(" ") + ". The invoice PDF is attached to every reminder."));
    var prevLabel = el("span", "cc-field-label");
    var prev = el("div", "irm-preview");
    right.appendChild(prevLabel);
    right.appendChild(prev);

    function store() {
      work.subject[tab] = subj.value;
      work.body[tab] = msg.value;
    }
    function drawPreview() {
      var sample = R.list.length ? R.list[0] : null;
      var days = Number(dayInputs[tab].value) || s.days[tab] || 7;
      var vars;
      if (sample) {
        var inv = sample.invoice;
        vars = {
          client: (inv.job && inv.job.clientName) || "",
          number: inv.number || "",
          job: (inv.job && inv.job.name) || "",
          amount: money(inv.totalCents),
          due: longDate(inv.dueDate),
          days: days,
          phone: "(our phone number)",
          from: "TH Cabinets Accounts",
        };
        prevLabel.textContent = "Preview, with " + (inv.number || "an overdue invoice") + " as if " + days + " days overdue";
      } else {
        vars = { client: "Jane Smith", number: "INV-0142", job: "Smith kitchen", amount: "$4,180.00", due: "3 November 2026", days: days, phone: "(our phone number)", from: "TH Cabinets Accounts" };
        prevLabel.textContent = "Preview, with sample values";
      }
      prev.textContent = fill(subj.value, vars) + "\n\n" + fill(msg.value, vars);
    }
    function load() {
      subj.value = work.subject[tab];
      msg.value = work.body[tab];
      tabBtns.forEach(function (b, i) { b.classList.toggle("hs-btn-primary", i === tab); b.setAttribute("aria-pressed", i === tab ? "true" : "false"); });
      drawPreview();
    }
    subj.addEventListener("input", drawPreview);
    msg.addEventListener("input", drawPreview);
    dayInputs.forEach(function (d) { d.addEventListener("input", drawPreview); });
    load();
    R.redraw = drawPreview;

    // --- save and reset
    var saveErr = el("p", "cc-dialog-error");
    saveErr.setAttribute("role", "alert");
    if (edit) {
      var save = el("button", "hs-btn hs-btn-primary", "Save");
      save.type = "button";
      var reset = el("button", "hs-btn hs-btn-quiet", "Back to the standard wording");
      reset.type = "button";
      reset.addEventListener("click", function () {
        for (var q = 0; q < 3; q++) {
          work.subject[q] = s.defaultTemplates[q].subject;
          work.body[q] = s.defaultTemplates[q].body;
        }
        load();
      });
      save.addEventListener("click", function () {
        store();
        saveErr.textContent = "";
        var mode = s.mode;
        Object.keys(radios).forEach(function (m) { if (radios[m].checked) mode = m; });
        var isDefault = work.subject.every(function (t, q) { return t === s.defaultTemplates[q].subject && work.body[q] === s.defaultTemplates[q].body; });
        var days = dayInputs.map(function (d) { return d.value.trim() === "" ? NaN : Number(d.value); });
        if (days.some(function (d) { return !isFinite(d); })) {
          saveErr.textContent = "Give a number of days for each of the three reminders";
          return;
        }
        var payload = {
          mode: mode,
          days: days,
          hour: Number(hourSel.value),
          bcc: bcc.value.trim(),
          templates: isDefault ? null : work.subject.map(function (t, q) { return { subject: t, body: work.body[q] }; }),
        };
        save.disabled = true;
        api("/api/invoice-reminders/settings", { method: "PUT", body: jsonBody(payload) })
          .then(function () { toast("Saved"); return reloadAll(); })
          .catch(function (e) { saveErr.textContent = e.message; save.disabled = false; });
      });
      right.appendChild(add(el("div", "ac-row"), save, reset));
      right.appendChild(saveErr);
    } else {
      right.appendChild(el("p", "ac-hint", "You can look at the settings but not change them."));
    }
    body.appendChild(grid);
  }

  function reloadAll() {
    return loadSettings().then(function () { return R.opts.reload(); });
  }

  // ---- the Reminders column -----------------------------------------------------------------------

  function sentLine(rem) {
    if (!rem.lastStep) return "";
    var d = short(isoDay(rem.lastSentAt));
    var what = { delivered: "delivered", sent: "sent", dry: "recorded (dry run)", bounced: "bounced", failed: "failed", complained: "marked as spam", delayed: "delayed" }[rem.lastStatus] || rem.lastStatus || "sent";
    return "Reminder " + rem.lastStep + " " + what + (d ? " " + d : "");
  }

  function cell(item) {
    var rem = item.reminder || {};
    var td = el("td", "irm-cell");
    var q = rem.queuedId ? R.byId[rem.queuedId] : null;
    var mode = R.queue.mode;
    var main = null;
    var sub = "";
    if (rem.queued) {
      main = badge("hs-badge-check", (q ? "Reminder " + q.step : "Reminder") + " ready");
      sub = mode === "auto" ? "Goes automatically" : "Waiting for you to send it";
    } else if (rem.notSent) {
      main = badge("hs-badge-na", "Not sent yet");
      sub = "Reminders start once the invoice has been sent";
    } else if (rem.paused) {
      main = badge("hs-badge-na", "Paused");
      sub = "Reminders are paused for this invoice";
    } else if (rem.clientPaused) {
      main = badge("hs-badge-na", "Client paused");
      sub = "Reminders are paused for this client";
    } else if (rem.noEmail) {
      main = badge("hs-badge-check", "No email on file");
      sub = rem.nextStep && rem.nextDate ? "Reminder " + rem.nextStep + " due " + day(rem.nextDate) : "Add the client's email to the job";
    } else if (rem.bounced) {
      main = badge("hs-badge-check", "Bounced");
      sub = "The invoice email bounced. Fix the address, then re-send";
    } else if (rem.beforeSwitchOn) {
      main = badge("hs-badge-na", "Before reminders");
      sub = "Overdue before reminders were switched on. Send reminder works from the invoice";
    } else if (rem.reason === "allSent") {
      main = badge("hs-badge-na", "All sent");
      sub = "No more go automatically";
    } else if (mode === "off") {
      main = badge("hs-badge-na", "Reminders off");
      sub = rem.nextStep && rem.nextDate ? "Reminder " + rem.nextStep + " due " + day(rem.nextDate) : "";
    } else if (rem.nextStep && rem.nextDate) {
      var due = rem.nextDate <= sydneyToday();
      main = badge("hs-badge-na", due ? "Reminder " + rem.nextStep + " due" : "Reminder " + rem.nextStep + " on " + day(rem.nextDate));
      if (due) sub = "Prepared each weekday at " + (R.settings ? String(R.settings.hour).padStart(2, "0") + ":00" : "the set time");
    }
    if (main) td.appendChild(main);
    if (sub) td.appendChild(el("small", null, sub));
    var last = sentLine(rem);
    if (last) td.appendChild(el("small", null, last));
    return td;
  }

  // ---- Send and Skip on a row ---------------------------------------------------------------------

  function sendIds(ids) {
    return api("/api/invoice-reminders/queue/send", { method: "POST", body: jsonBody({ ids: ids }) });
  }

  function buttons(item) {
    var rem = item.reminder || {};
    var out = [];
    if (!rem.queued || !rem.queuedId || !can()) return out;
    var id = rem.queuedId;
    var view = el("button", "hs-btn ise-small", "View");
    view.type = "button";
    view.addEventListener("click", function () { previewDialog([id]); });
    var send = el("button", "hs-btn hs-btn-check ise-small", "Send");
    send.type = "button";
    var skip = el("button", "hs-btn hs-btn-quiet ise-small", "Skip");
    skip.type = "button";
    send.addEventListener("click", function () {
      send.disabled = true; skip.disabled = true;
      R.opts.errLine.textContent = "";
      sendIds([id]).then(
        function (res) {
          var r = (res.results || [])[0] || {};
          if (r.ok) toast(R.settings && R.settings.dryRun ? "Reminder recorded (dry run, nothing emailed)" : "Reminder sent");
          else R.opts.errLine.textContent = (item.invoice.number || "Invoice") + ": " + (r.error || "The reminder couldn't be sent");
          return R.opts.reload();
        },
        function (e) {
          toast("Error: " + e.message);
          send.disabled = false; skip.disabled = false;
        }
      );
    });
    skip.addEventListener("click", function () {
      send.disabled = true; skip.disabled = true;
      api("/api/invoice-reminders/queue/" + id + "/skip", { method: "POST", body: "{}" }).then(
        function () { toast("Reminder skipped"); return R.opts.reload(); },
        function (e) {
          toast("Error: " + e.message);
          send.disabled = false; skip.disabled = false;
        }
      );
    });
    out.push(view, send, skip);
    return out;
  }

  // ---- the strip and the preview dialog -----------------------------------------------------------

  function previewDialog(ids) {
    var dlg = el("dialog", "cc-dialog irm-dialog irm-qdialog");
    dlg.setAttribute("aria-labelledby", "irmQTitle");
    var form = el("div", "cc-dialog-form");
    var title = el("h2", "cc-dialog-title", ids.length === 1 ? "Reminder email" : "Reminder emails ready to send");
    title.id = "irmQTitle";
    form.appendChild(title);
    var rows = (ids || R.queue.queued.map(function (r) { return r.id; })).map(function (id) { return R.byId[id]; }).filter(Boolean);
    if (!rows.length) form.appendChild(el("p", "irm-sub", "Nothing is waiting."));
    rows.forEach(function (r) {
      var box = el("div", "irm-qitem");
      var head = [r.number, r.jobName, "Reminder " + r.step].filter(Boolean).join(" · ");
      box.appendChild(el("p", "ise-eyebrow", head));
      var em = r.email || {};
      function line(label, v) {
        var p = el("p", "irm-qline");
        add(p, el("span", "irm-sub", label + " "), document.createTextNode(v || "none"));
        return p;
      }
      add(box, line("To", em.to), line("BCC", em.bcc), line("Subject", em.subject));
      box.appendChild(el("div", "irm-preview", em.body || ""));
      form.appendChild(box);
    });
    var close = el("button", "hs-btn", "Close");
    close.type = "button";
    close.addEventListener("click", function () { dlg.close(); });
    form.appendChild(add(el("div", "cc-dialog-actions"), close));
    dlg.appendChild(form);
    dlg.addEventListener("close", function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  function renderStrip() {
    var strip = R.opts.strip;
    strip.replaceChildren();
    var rows = R.queue.queued.filter(function (r) { return r.state === "queued"; });
    if (R.queue.mode !== "approval" || !rows.length) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    var n = rows.length;
    var t = el("span");
    add(t, el("b", null, n === 1 ? "1 reminder email is ready to send." : n + " reminder emails are ready to send."),
      document.createTextNode(" Check " + (n === 1 ? "it" : "them") + " in the Reminders column, then send."));
    strip.appendChild(t);
    var pv = el("button", "hs-btn ise-small", "Preview");
    pv.type = "button";
    pv.addEventListener("click", function () { previewDialog(rows.map(function (r) { return r.id; })); });
    strip.appendChild(pv);
    if (can()) {
      var go = el("button", "hs-btn hs-btn-check ise-small", n === 1 ? "Send 1 reminder" : "Send " + n + " reminders");
      go.type = "button";
      go.addEventListener("click", function () {
        go.disabled = true; pv.disabled = true;
        R.opts.errLine.textContent = "";
        var ids = rows.map(function (r) { return r.id; });
        var names = {};
        rows.forEach(function (r) { names[r.id] = r.number || "Invoice"; });
        sendIds(ids).then(
          function (res) {
            var results = res.results || [];
            var ok = results.filter(function (r) { return r.ok; }).length;
            var failed = results.filter(function (r) { return !r.ok; });
            var dry = R.settings && R.settings.dryRun;
            toast((dry ? "Recorded " : "Sent ") + ok + " of " + results.length + (dry ? " (dry run, nothing emailed)" : ""));
            if (failed.length) {
              R.opts.errLine.textContent = failed.map(function (r) { return (names[r.id] || "Invoice") + ": " + r.error; }).join("\n");
            }
            return R.opts.reload();
          },
          function (e) {
            toast("Error: " + e.message);
            go.disabled = false; pv.disabled = false;
          }
        );
      });
      strip.appendChild(go);
    }
  }

  window.ccOverdueReminders = {
    init: init,
    loadSettings: loadSettings,
    loadQueue: loadQueue,
    setList: setList,
    cell: cell,
    buttons: buttons,
    renderStrip: renderStrip,
  };
})();
