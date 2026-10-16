// Crosscuts shared shell: the top bar used by every page except login, setup
// and photo search (Todd, 2026-10-13: the board and Workers use it too).
//
//   <div id="cc-shell"></div>
//   <script src="/shell/shell.js"></script>
//
// Self-contained, no framework. Reads GET /api/auth/me, shows only the
// departments the user may use, and exposes window.cc = { me, can(key), ... }.
// Fires `cc:ready` on document once the user is known (also: cc.ready promise).
(function () {
  "use strict";
  if (window.cc && window.cc.__shell) return;

  // Menu 3.1 (docs/plans/menu-plan.md): the bar is the wordmark, a Dashboard link, one button per
  // department (each opens a short list of its pages), then a fixed right-hand cluster for
  // everyone: Planner, Tasks, Messages, Alerts and the user's name. A department shows only the
  // pages the user can see, and only when there is at least one. dept = the layer colour its
  // thin rule takes (the fourth named exception in CLAUDE.md); Photos and Admin stay plain.
  var DEPARTMENTS = [
    {
      id: "scheduling",
      label: "Scheduling",
      dept: "scheduling",
      items: [
        { label: "Notes", href: "/notes.html?dept=scheduling", key: "scheduling.view" },
        { label: "Board", href: "/schedule.html", key: "board.view" },
        { label: "Scheduling", href: "/scheduling.html", key: "scheduling.view" },
        { label: "Lookahead", href: "/lookahead.html", key: "scheduling.view" },
        { label: "Availability", href: "/availability.html", key: "scheduling.view" },
        { label: "Workers", href: "/workers.html", key: "workers.edit" },
      ],
    },
    {
      id: "design",
      label: "Design/PM",
      dept: "design",
      items: [
        { label: "Notes", href: "/notes.html?dept=design", key: "design.view" },
        { label: "Design/PM", href: "/design.html", key: "design.view" },
        { label: "Jobs", href: "/jobs.html", key: "jobs.view" },
        { label: "Pipeline", href: "/pipeline.html", key: "jobs.view" },
        { label: "Intake", href: "/intake.html", key: "design.view" },
        // M12 (docs/plans/m12-contracts.md section 8).
        { label: "Stone orders", href: "/stone.html", key: "design.view" },
        { label: "Batten calculator", href: "/battens.html", key: "design.view" },
      ],
    },
    {
      // Ordering (Todd, 2026-10-12): its own department. M10: Orders by orders.view (no job pages
      // needed); Deliveries for whoever receives them. M11 (docs/plans/m11-contracts.md section 10):
      // the drawer, stock and paint orders and the board stocktake.
      id: "ordering",
      label: "Ordering",
      dept: "ordering",
      items: [
        { label: "Notes", href: "/notes.html?dept=ordering", key: "orders.view" },
        { label: "Orders", href: "/orders.html", key: "orders.view" },
        { label: "Deliveries", href: "/deliveries.html", key: "orders.receive" },
        { label: "Drawer order", href: "/drawers.html", key: "stock.order" },
        { label: "Stock order", href: "/stock.html", key: "stock.count" },
        { label: "Paint order", href: "/paint.html", key: "stock.order" },
        { label: "Board stocktake", href: "/boards.html", key: "stock.count" },
      ],
    },
    {
      id: "accounts",
      label: "Accounts",
      dept: "accounts",
      items: [
        { label: "Notes", href: "/notes.html?dept=accounts", key: "accounts.view" },
        { label: "Accounts", href: "/accounts.html", key: "accounts.view" },
        { label: "Pay runs", href: "/payruns.html", key: "accounts.view" },
        { label: "BAS sales", href: "/bas.html", key: "accounts.view" },
        { label: "Supplier accounts", href: "/suppliers.html", key: "accounts.view" },
        { label: "Admin accounts", href: "/adminaccounts.html", key: "accounts.view" },
        // M13 (docs/plans/m13-contracts.md section 9): owner-only key, grantable to an Accounts login.
        { label: "Loans", href: "/loans.html", key: "loans.manage" },
        { label: "Reports", href: "/reports.html", key: "accounts.view" },
      ],
    },
    {
      id: "photos",
      label: "Photos",
      items: [
        { label: "Photos", href: "/search.html", key: "photos.search" },
        { label: "Photo admin", href: "/admin.html", key: "photos.admin" },
      ],
    },
    {
      id: "admin",
      label: "Admin",
      items: [
        { label: "Notes", href: "/notes.html?dept=admin", key: "users.admin" },
        { label: "Users", href: "/users.html", key: "users.admin" },
        { label: "Audit", href: "/audit.html", key: "audit.view" },
        // M13 (docs/plans/m13-contracts.md section 9): owner-only keys.
        { label: "Bonuses", href: "/bonuses.html", key: "bonuses.manage" },
        { label: "Alarms", href: "/alarms.html", key: "alarms.manage" },
      ],
    },
  ];

  // Pages that belong to a nav link but have a different path.
  var PAGE_ALIASES = {
    "/job.html": "/jobs.html",
    "/invoice.html": "/accounts.html",
    "/payrun.html": "/payruns.html",
    "/payprint.html": "/payruns.html",
    // M13 (docs/plans/m13-contracts.md section 9).
    "/bonusprint.html": "/bonuses.html",
    "/loanprint.html": "/loans.html",
    "/index.html": "/",
  };

  var path = location.pathname;
  var onAuthPage = /^\/(login|setup)\.html$/.test(path);

  var perms = new Set();
  var devMode = false;
  var resolveReady;
  var cc = (window.cc = {
    __shell: true,
    me: null,
    session: null,
    dev: false,
    loaded: false,
    can: function (key) {
      return devMode || perms.has(key);
    },
    ready: new Promise(function (resolve) {
      resolveReady = resolve;
    }),
    // Alerts, for pages that show them too (the dashboard).
    // Deferred, so the click that asked for it finishes bubbling (and reaches the outside-click
    // handler) before the panel opens.
    openAlerts: function () { setTimeout(openAlerts, 0); },
    openAlert: function (n) { openAlert(n); },
    refreshAlerts: function () { return pollCount(); },
    // M4: re-poll the Tasks, Messages and Alerts counts now (after reading messages, closing a task).
    refreshCounts: function () { return pollCount(); },
    timeAgo: function (iso) { return timeAgo(iso); },
  });

  // ---------- small DOM helpers ----------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === false || v === null || v === undefined) return;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  function ensureStyles() {
    var wanted = ["/shell/shell.css", "/tokens.css"];
    wanted.forEach(function (href) {
      var present = Array.prototype.some.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) {
        var a = l.getAttribute("href") || "";
        return a === href || a === href.slice(1) || a.endsWith(href);
      });
      if (!present) document.head.appendChild(h("link", { rel: "stylesheet", href: href }));
    });
  }

  // ---------- auth redirect + requests ----------
  function loginUrl(locked) {
    var next = encodeURIComponent(location.pathname + location.search);
    return (locked ? "/login.html?locked=1&next=" : "/login.html?next=") + next;
  }
  function goLogin(locked) {
    if (onAuthPage) return;
    location.href = loginUrl(locked);
  }
  function post(url, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, body: data || {} };
      });
    });
  }
  // A 401 from a dialog can also mean "wrong current password", so only treat it as
  // a lost session when the body says so.
  function sessionLost(r) {
    return r.status === 401 && (r.body.locked || /not logged in|locked/i.test(r.body.error || ""));
  }

  // ---------- dialogs ----------
  function openDialog(opts) {
    // opts: { title, note, fields:[{name,label,type,autocomplete,inputmode,pattern,maxlength}], submit,
    //         extra: {label, run}, onSubmit(values) -> Promise<{ok,status,body}>, success }
    var errorEl = h("p", { class: "cc-dialog-error", role: "alert" });
    var inputs = {};
    var fieldEls = opts.fields.map(function (f) {
      var input = h("input", {
        class: "hs-input",
        id: "cc-f-" + opts.id + "-" + f.name,
        name: f.name,
        type: f.type || "text",
        autocomplete: f.autocomplete,
        inputmode: f.inputmode,
        pattern: f.pattern,
        maxlength: f.maxlength,
        minlength: f.minlength,
        required: f.optional ? false : true,
      });
      inputs[f.name] = input;
      return h("div", { class: "cc-field" }, [
        h("label", { class: "cc-field-label", for: input.id, text: f.label }),
        input,
      ]);
    });
    var submitBtn = h("button", { class: "hs-btn hs-btn-primary", type: "submit", text: opts.submit });
    var cancelBtn = h("button", { class: "hs-btn", type: "button", text: "Cancel" });
    var actions = [];
    var extraBtn = null;
    if (opts.extra) {
      extraBtn = h("button", { class: "hs-btn hs-btn-quiet", type: "button", text: opts.extra.label });
      actions.push(extraBtn);
    }
    actions.push(cancelBtn, submitBtn);

    var form = h("form", { class: "cc-dialog-form", novalidate: false }, [
      h("h2", { class: "cc-dialog-title", text: opts.title }),
      opts.note ? h("p", { class: "cc-dialog-note", text: opts.note }) : null,
    ].concat(fieldEls, [errorEl, h("div", { class: "cc-dialog-actions" }, actions)]));
    var dlg = h("dialog", { class: "cc-dialog", "aria-label": opts.title }, [form]);
    document.body.appendChild(dlg);

    function close() {
      dlg.close();
    }
    dlg.addEventListener("close", function () {
      dlg.remove();
    });
    // Click on the backdrop closes the dialog.
    dlg.addEventListener("mousedown", function (e) {
      if (e.target === dlg) close();
    });
    cancelBtn.addEventListener("click", close);

    function busy(on) {
      submitBtn.disabled = on;
      if (extraBtn) extraBtn.disabled = on;
    }
    function run(fn) {
      errorEl.textContent = "";
      errorEl.classList.remove("cc-dialog-ok");
      busy(true);
      fn()
        .then(function (r) {
          busy(false);
          if (sessionLost(r)) return goLogin(!!r.body.locked);
          if (r.ok) {
            errorEl.classList.add("cc-dialog-ok");
            errorEl.textContent = opts.success;
            setTimeout(close, 900);
          } else {
            errorEl.textContent = r.body.error || "Something went wrong (" + r.status + ").";
          }
        })
        .catch(function () {
          busy(false);
          errorEl.textContent = "Couldn't reach the server. Try again.";
        });
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var values = {};
      Object.keys(inputs).forEach(function (k) { values[k] = inputs[k].value; });
      var problem = opts.validate && opts.validate(values);
      if (problem) {
        errorEl.classList.remove("cc-dialog-ok");
        errorEl.textContent = problem;
        return;
      }
      run(function () { return opts.onSubmit(values); });
    });
    if (extraBtn) {
      extraBtn.addEventListener("click", function () {
        var values = {};
        Object.keys(inputs).forEach(function (k) { values[k] = inputs[k].value; });
        var problem = opts.extra.validate && opts.extra.validate(values);
        if (problem) {
          errorEl.classList.remove("cc-dialog-ok");
          errorEl.textContent = problem;
          return;
        }
        run(function () { return opts.extra.run(values); });
      });
    }
    dlg.showModal();
    var first = fieldEls.length ? inputs[opts.fields[0].name] : submitBtn;
    first.focus();
    return dlg;
  }

  function openPasswordDialog(note) {
    openDialog({
      id: "pw",
      title: "Change password",
      note: note || "Use at least 8 characters.",
      submit: "Change password",
      success: "Password changed.",
      fields: [
        { name: "currentPassword", label: "Current password", type: "password", autocomplete: "current-password" },
        { name: "newPassword", label: "New password", type: "password", autocomplete: "new-password", minlength: 8 },
        { name: "confirm", label: "Confirm new password", type: "password", autocomplete: "new-password", minlength: 8 },
      ],
      validate: function (v) {
        if (v.newPassword.length < 8) return "The new password must be at least 8 characters.";
        if (v.newPassword !== v.confirm) return "The new passwords don't match.";
        return "";
      },
      onSubmit: function (v) {
        return post("/api/auth/password", { currentPassword: v.currentPassword, newPassword: v.newPassword });
      },
    });
  }

  function openPinDialog() {
    var pinOk = function (v) {
      return /^\d{4,6}$/.test(v.pin) ? "" : "A PIN is 4 to 6 digits.";
    };
    openDialog({
      id: "pin",
      title: "Set PIN",
      note: "A PIN unlocks this device quickly after it has been locked. It only works on a device you chose to remember.",
      submit: "Set PIN",
      success: "PIN saved.",
      fields: [
        { name: "currentPassword", label: "Current password", type: "password", autocomplete: "current-password" },
        { name: "pin", label: "New PIN (4 to 6 digits)", type: "password", inputmode: "numeric", pattern: "[0-9]*", maxlength: 6, autocomplete: "off" },
      ],
      validate: pinOk,
      onSubmit: function (v) {
        return post("/api/auth/pin", { currentPassword: v.currentPassword, pin: v.pin });
      },
      extra: {
        label: "Remove PIN",
        validate: function (v) { return v.currentPassword ? "" : "Enter your current password to remove the PIN."; },
        run: function (v) { return post("/api/auth/pin", { currentPassword: v.currentPassword, pin: null }); },
      },
    });
    // PIN field is required for Set but not for Remove: the browser's own validation
    // would block Remove, and the extra button doesn't submit the form, so this is fine.
  }

  // ---------- actions ----------
  function doLock() {
    post("/api/auth/lock").then(function (r) {
      if (r.ok || r.status === 401 || r.status === 404) location.href = loginUrl(true);
      else window.alert("Couldn't lock this session. Try again.");
    }).catch(function () { window.alert("Couldn't reach the server."); });
  }
  function doSignOut() {
    post("/api/auth/logout").then(function (r) {
      if (r.ok || r.status === 401 || r.status === 404) location.href = "/login.html";
      else window.alert("Couldn't sign out. Try again.");
    }).catch(function () { window.alert("Couldn't reach the server."); });
  }

  // ---------- menus ----------
  // A real mouse (not touch): department menus open on hover.
  var canHover = window.matchMedia("(hover: hover) and (pointer: fine)");
  function closeAllPopups(except) {
    Array.prototype.forEach.call(document.querySelectorAll("#cc-shell [data-cc-toggle]"), function (btn) {
      if (btn === except) return;
      setOpen(btn, false);
    });
  }
  function setOpen(btn, open) {
    var target = document.getElementById(btn.getAttribute("aria-controls"));
    if (!target) return;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (target.classList.contains("cc-menu")) target.hidden = !open;
    else target.classList.toggle("cc-open", open);
  }
  function menuItems(menu) {
    return Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
  }

  // User menu: role=menu with arrow-key navigation.
  function buildUserMenu(displayName) {
    var menu = h("div", { class: "cc-menu", id: "cc-user-menu", role: "menu", "aria-label": "Account", hidden: true }, [
      h("div", { class: "cc-menu-head" }, [h("strong", { text: displayName }), "Signed in"]),
      h("hr", { class: "cc-menu-sep" }),
      menuItem("Change password", function () { openPasswordDialog(); }), // not the click event as its note
      menuItem("Set PIN", openPinDialog),
      menuItem("Lock", doLock),
      h("hr", { class: "cc-menu-sep" }),
      menuItem("Sign out", doSignOut),
    ]);
    var btn = h(
      "button",
      {
        class: "cc-btn",
        type: "button",
        id: "cc-user-btn",
        "data-cc-toggle": "",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-controls": "cc-user-menu",
      },
      [h("span", { class: "cc-user-name", text: displayName })]
    );
    btn.setAttribute("aria-label", "Account menu for " + displayName);
    // The name can be cut with an ellipsis on a narrow bar; the tooltip shows it in full.
    btn.setAttribute("title", displayName);

    function open(focusIndex) {
      closeAllPopups(btn);
      setOpen(btn, true);
      var items = menuItems(menu);
      if (items.length) items[focusIndex === "last" ? items.length - 1 : 0].focus();
    }
    function close(returnFocus) {
      setOpen(btn, false);
      if (returnFocus) btn.focus();
    }
    btn.addEventListener("click", function () {
      if (btn.getAttribute("aria-expanded") === "true") close(false);
      else open();
    });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); open(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); open("last"); }
    });
    menu.addEventListener("keydown", function (e) {
      var items = menuItems(menu);
      var i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === "Escape") { e.preventDefault(); close(true); }
      else if (e.key === "Tab") { close(false); }
    });
    menu.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest('[role="menuitem"]')) close(false);
    });
    return { btn: btn, menu: menu };
  }
  function menuItem(label, onClick) {
    return h("button", { class: "cc-menu-item", type: "button", role: "menuitem", tabindex: "-1", onclick: onClick }, [
      label,
    ]);
  }

  // ---------- alerts (the bell) ----------
  // A text button with an unread badge. The count is polled every 60 s and on window focus;
  // a 401 (signed out or locked elsewhere) simply stops the polling, it never redirects.
  var ALERT_POLL_MS = 60000;
  var alerts = { btn: null, badge: null, panel: null, list: null, readAll: null, older: null, unread: 0, timer: null, running: false, stopped: false };
  // M4: the Tasks and Messages buttons beside Alerts share the same poll.
  // On phones the bar buttons hide and the same counts show in the Menu panel (tasksNav, messagesNav).
  var counts = { tasks: null, messages: null, tasksNav: null, messagesNav: null };

  function getJson(url) {
    return fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { ok: res.ok, status: res.status, body: body || {} };
      });
    });
  }
  function timeAgo(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var m = Math.floor(Math.max(0, Date.now() - t) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var hr = Math.floor(m / 60);
    if (hr < 24) return hr + (hr === 1 ? " hour ago" : " hours ago");
    var d = Math.floor(hr / 24);
    if (d < 7) return d + (d === 1 ? " day ago" : " days ago");
    return new Date(t).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short" });
  }
  // Links are site-relative; anything else is ignored.
  function safeLink(link) {
    return typeof link === "string" && /^\/(?![\/\\])/.test(link) ? link : "";
  }
  function alertsOpen() {
    return !!alerts.btn && alerts.btn.getAttribute("aria-expanded") === "true";
  }
  function setUnread(n) {
    alerts.unread = n;
    if (!alerts.btn) return;
    alerts.badge.hidden = n < 1;
    alerts.badge.textContent = n > 99 ? "99+" : String(n);
    alerts.btn.setAttribute("aria-label", n > 0 ? "Alerts, " + n + " unread" : "Alerts");
    alerts.readAll.disabled = n < 1;
  }
  function stopAlerts() {
    alerts.stopped = true;
    if (alerts.timer) clearInterval(alerts.timer);
    alerts.timer = null;
    window.removeEventListener("focus", pollCount);
  }
  function pollCount() {
    if (alerts.stopped || !alerts.btn) return Promise.resolve();
    return getJson("/api/notifications/unread-count")
      .then(function (r) {
        if (r.status === 401) return stopAlerts();
        if (!r.ok) return;
        var n = Number(r.body.unread) || 0;
        var changed = n !== alerts.unread;
        setUnread(n);
        var nt = Number(r.body.tasks) || 0, late = Number(r.body.tasksOverdue) > 0, nm = Number(r.body.messages) || 0;
        setCount(counts.tasks, nt, late);
        setCount(counts.tasksNav, nt, late);
        setCount(counts.messages, nm, false);
        setCount(counts.messagesNav, nm, false);
        if (changed && alertsOpen()) loadAlerts();
      })
      .catch(function () { /* offline: try again next time */ });
  }
  // A count button: a link with a badge. attend = orange (an overdue task).
  function buildCount(label, href, noun, cls) {
    var badge = h("span", { class: "cc-bell-badge", hidden: true, "aria-hidden": "true", text: "0" });
    var link = h("a", { class: cls || "cc-btn cc-count", href: href, "aria-label": label, "aria-current": path === href ? "page" : false }, [label, badge]);
    return { link: link, badge: badge, label: label, noun: noun };
  }
  function setCount(c, n, attend) {
    if (!c) return;
    c.badge.hidden = n < 1;
    c.badge.textContent = n > 99 ? "99+" : String(n);
    c.badge.classList.toggle("cc-badge-attend", !!attend && n > 0);
    c.link.setAttribute("aria-label", n > 0 ? c.label + ", " + n + " " + c.noun + (attend ? ", some overdue" : "") : c.label);
  }
  function startAlerts() {
    if (alerts.running || devMode || onAuthPage) return;
    alerts.running = true;
    alerts.timer = setInterval(pollCount, ALERT_POLL_MS);
    window.addEventListener("focus", pollCount);
    pollCount();
  }

  function markRead(id) {
    return post("/api/notifications/" + id + "/read").catch(function () {});
  }
  // Mark one alert read, then follow its link (or just refresh when it has none).
  function openAlert(n) {
    var href = safeLink(n.link);
    var go = function () {
      if (href) location.assign(href);
      else { pollCount(); if (alertsOpen()) loadAlerts(); }
    };
    if (n.readAt) return go();
    markRead(n.id).then(go);
  }
  function alertItem(n) {
    var unread = !n.readAt;
    var href = safeLink(n.link);
    var item = h(href ? "a" : "button", {
      class: "cc-bell-item" + (unread ? " cc-unread" : ""),
      href: href || false,
      type: href ? false : "button",
    }, [
      unread ? h("span", { class: "cc-sr", text: "Unread: " }) : null,
      h("span", { class: "cc-bell-title", text: n.title }),
      n.body ? h("span", { class: "cc-bell-body", text: n.body }) : null,
      h("span", { class: "cc-bell-time", text: timeAgo(n.createdAt) }),
    ]);
    item.addEventListener("click", function (e) {
      if (href && (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey)) {
        if (unread) markRead(n.id); // opened in a new tab: let the browser do that
        return;
      }
      e.preventDefault();
      openAlert(n);
    });
    return item;
  }
  function alertNote(text) {
    alerts.list.textContent = "";
    alerts.list.appendChild(h("li", { class: "cc-bell-empty", text: text }));
  }
  function appendAlerts(rows) {
    rows.forEach(function (n) {
      var li = h("li", { class: "cc-bell-li" }, [alertItem(n)]);
      li.setAttribute("data-id", String(n.id));
      alerts.list.appendChild(li);
    });
  }
  function setOlder(more) {
    alerts.older.hidden = !more;
    alerts.older.disabled = false;
  }
  // M4: "Show older" pages back by id.
  function loadOlder() {
    var last = alerts.list.querySelector(".cc-bell-li:last-child");
    var before = last ? last.getAttribute("data-id") : "";
    if (!before) return;
    alerts.older.disabled = true;
    getJson("/api/notifications?limit=30&before=" + encodeURIComponent(before))
      .then(function (r) {
        if (!r.ok) { alerts.older.disabled = false; return; }
        appendAlerts(r.body.rows || []);
        setOlder(!!r.body.more);
      })
      .catch(function () { alerts.older.disabled = false; });
  }
  function loadAlerts() {
    return getJson("/api/notifications?limit=30")
      .then(function (r) {
        setOlder(false);
        if (r.status === 401) { stopAlerts(); return alertNote("Your session has ended. Sign in again."); }
        if (!r.ok) return alertNote("Couldn't load alerts.");
        var rows = r.body.rows || [];
        setUnread(Number(r.body.unread) || 0);
        if (!rows.length) return alertNote("No alerts");
        alerts.list.textContent = "";
        appendAlerts(rows);
        setOlder(!!r.body.more);
        // Keyboard users who opened an empty panel land on the first alert once it arrives.
        if (document.activeElement === alerts.panel) {
          var first = alerts.list.querySelector(".cc-bell-item");
          if (first) first.focus();
        }
      })
      .catch(function () { alertNote("Couldn't reach the server."); });
  }
  function openAlerts() {
    if (!alerts.btn || alertsOpen()) return;
    closeAllPopups(alerts.btn);
    setOpen(alerts.btn, true);
    alerts.panel.focus();
    loadAlerts();
  }
  function closeAlerts(returnFocus) {
    if (!alerts.btn) return;
    setOpen(alerts.btn, false);
    if (returnFocus) alerts.btn.focus();
  }

  function buildBell() {
    var badge = h("span", { class: "cc-bell-badge", hidden: true, "aria-hidden": "true", text: "0" });
    var btn = h(
      "button",
      {
        class: "cc-btn cc-bell",
        type: "button",
        id: "cc-bell-btn",
        "data-cc-toggle": "",
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
        "aria-controls": "cc-bell-menu",
        "aria-label": "Alerts",
      },
      ["Alerts", badge]
    );
    var readAll = h("button", { class: "cc-btn cc-btn-quiet cc-btn-sm", type: "button", disabled: true, text: "Mark all read" });
    var list = h("ul", { class: "cc-bell-list" });
    var older = h("button", { class: "cc-btn cc-btn-quiet cc-btn-sm cc-bell-older", type: "button", hidden: true, text: "Show older" });
    var panel = h("div", { class: "cc-bell-menu", id: "cc-bell-menu", role: "dialog", "aria-label": "Alerts", tabindex: "-1" }, [
      h("div", { class: "cc-bell-head" }, [h("span", { class: "cc-bell-heading", text: "Alerts" }), readAll]),
      list,
      older,
    ]);
    alerts.btn = btn; alerts.badge = badge; alerts.panel = panel; alerts.list = list; alerts.readAll = readAll; alerts.older = older;
    older.addEventListener("click", loadOlder);

    btn.addEventListener("click", function () {
      if (alertsOpen()) closeAlerts(false);
      else openAlerts();
    });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" && !alertsOpen()) { e.preventDefault(); openAlerts(); }
    });
    readAll.addEventListener("click", function () {
      post("/api/notifications/read-all").then(function () { setUnread(0); loadAlerts(); }).catch(function () {});
    });
    panel.addEventListener("keydown", function (e) {
      var stops = Array.prototype.slice.call(panel.querySelectorAll("button:not(:disabled), a[href]"));
      var i = stops.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); if (stops.length) stops[(i + 1) % stops.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (stops.length) stops[(i - 1 + stops.length) % stops.length].focus(); }
    });
    // Tabbing out of the panel closes it; clicking inside it never does.
    panel.addEventListener("focusout", function (e) {
      var to = e.relatedTarget;
      if (to && !panel.contains(to) && to !== btn) closeAlerts(false);
    });
    setUnread(alerts.unread);
    return { btn: btn, panel: panel };
  }

  // ---------- render ----------
  function isCurrent(href) {
    var here = PAGE_ALIASES[path] || path;
    var q = href.indexOf("?");
    if (q < 0) return here === href;
    // A link with a query (the department Notes pages) is current for its own ?dept= only.
    return here === href.slice(0, q) &&
      new URLSearchParams(location.search).get("dept") === new URLSearchParams(href.slice(q)).get("dept");
  }

  // A department menu: a button (the department's name) that opens a small list of its pages.
  // Disclosure pattern: aria-expanded/aria-controls, Escape closes and refocuses the button, only
  // one popup is open at a time (closeAllPopups). In the collapsed Menu panel the button is hidden
  // and the department shows as a heading over a flat list (shell.css), so there is no nesting.
  function buildDepartment(d, allowed) {
    var panelId = "cc-dept-" + d.id;
    var current = allowed.some(function (it) { return isCurrent(it.href); });
    var btn = h("button", {
      class: "cc-dept-btn" + (d.dept ? " cc-dept-ruled" : ""),
      type: "button",
      "data-cc-toggle": "",
      "aria-expanded": "false",
      "aria-controls": panelId,
      "aria-current": current ? "true" : false,
      text: d.label,
    });
    var head = h("span", { class: "cc-dept-head", id: "cc-dh-" + d.id, text: d.label });
    var list = h("ul", { class: "cc-dept-list" });
    allowed.forEach(function (it) {
      list.appendChild(
        h("li", null, [
          h("a", { class: "cc-dept-link", href: it.href, "aria-current": isCurrent(it.href) ? "page" : false, text: it.label }),
        ])
      );
    });
    var panel = h("div", { class: "cc-dept-panel", id: panelId, role: "group", "aria-labelledby": "cc-dh-" + d.id }, [list]);
    var li = h("li", { class: "cc-dept" + (d.dept ? " cc-dept-" + d.dept : "") }, [btn, head, panel]);

    function links() { return Array.prototype.slice.call(panel.querySelectorAll("a[href]")); }
    function open(focusFirst) {
      closeAllPopups(btn);
      setOpen(btn, true);
      if (focusFirst) { var l = links(); if (l.length) l[0].focus(); }
    }
    btn.addEventListener("click", function () {
      // A click on a menu the mouse has just opened keeps it open rather than shutting it.
      if (hoverOpened) { hoverOpened = false; return; }
      if (btn.getAttribute("aria-expanded") === "true") setOpen(btn, false);
      else open(false);
    });
    // With a mouse (Todd, 2026-10-13), pointing at a department opens it and moving away closes it,
    // after a short pause so the pointer can cross the gap to the list. Touch and the keyboard keep
    // the click/Enter behaviour, and the collapsed Menu panel (button hidden) is left alone.
    var hoverCloseTimer = null;
    var hoverOpened = false;
    li.addEventListener("mouseenter", function () {
      if (!canHover.matches || !btn.offsetParent) return;
      clearTimeout(hoverCloseTimer);
      if (btn.getAttribute("aria-expanded") !== "true") { open(false); hoverOpened = true; }
    });
    li.addEventListener("mouseleave", function () {
      if (!canHover.matches || !btn.offsetParent) return;
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = setTimeout(function () {
        hoverOpened = false;
        if (!li.contains(document.activeElement) || document.activeElement === btn) setOpen(btn, false);
      }, 250);
    });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); open(true); }
    });
    panel.addEventListener("keydown", function (e) {
      var l = links();
      var i = l.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); l[(i + 1) % l.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); l[(i - 1 + l.length) % l.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); l[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); l[l.length - 1].focus(); }
    });
    // Tabbing out of the department closes its panel; clicking inside it never does.
    li.addEventListener("focusout", function (e) {
      var to = e.relatedTarget;
      if (to && !li.contains(to)) setOpen(btn, false);
    });
    return li;
  }

  function render(root, user) {
    root.textContent = "";
    // The spectrum rule sits above the bar, so it sticks with it.
    root.appendChild(h("div", { class: "hs-rule", "aria-hidden": "true" }));
    var bar = h("header", { class: "cc-bar" });
    var lockup = h("span", { class: "hs-lockup" }, ["TH ", h("b", { text: "CABINETS" })]);
    bar.appendChild(
      h(
        "a",
        { class: "cc-brand", href: "/", "aria-label": "Crosscuts home", "aria-current": path === "/" || path === "/index.html" ? "page" : false },
        [lockup, h("span", { class: "cc-brand-app", text: "Crosscuts" })]
      )
    );
    if (!user) {
      root.appendChild(bar);
      return;
    }

    var nav = h("nav", { class: "cc-nav", id: "cc-nav", "aria-label": "Main" });
    // Phones only (shell.css): the common features come first in the Menu panel, together.
    var withCounts = !devMode && !onAuthPage;
    var wantEveryday = cc.can("planner.view") || (withCounts && (cc.can("tasks.use") || cc.can("messages.use")));
    if (wantEveryday) {
      var cg = h("ul", { class: "cc-group cc-group-counts", "aria-labelledby": "cc-gl-counts" });
      var cl = h("li", { class: "cc-group-label", id: "cc-gl-counts", text: "Everyday" });
      cl.setAttribute("role", "presentation");
      cg.appendChild(cl);
      if (cc.can("planner.view")) {
        cg.appendChild(h("li", null, [
          h("a", { class: "cc-link cc-count-link", href: "/planner.html", "aria-current": path === "/planner.html" ? "page" : false, text: "Planner" }),
        ]));
      }
      if (withCounts && cc.can("tasks.use")) {
        counts.tasksNav = buildCount("Tasks", "/tasks.html", "open", "cc-link cc-count-link");
        cg.appendChild(h("li", null, [counts.tasksNav.link]));
      }
      if (withCounts && cc.can("messages.use")) {
        counts.messagesNav = buildCount("Messages", "/messages.html", "unread", "cc-link cc-count-link");
        cg.appendChild(h("li", null, [counts.messagesNav.link]));
      }
      nav.appendChild(cg);
    }

    // Dashboard, then the department menus (fixed order, only those with a visible page).
    var depts = h("ul", { class: "cc-depts" });
    depts.appendChild(
      h("li", { class: "cc-dashboard" }, [
        h("a", { class: "cc-link", href: "/", "aria-current": path === "/" || path === "/index.html" ? "page" : false, text: "Dashboard" }),
      ])
    );
    DEPARTMENTS.forEach(function (d) {
      var allowed = d.items.filter(function (it) { return cc.can(it.key); });
      if (allowed.length) depts.appendChild(buildDepartment(d, allowed));
    });
    nav.appendChild(depts);

    var menuBtn = h(
      "button",
      { class: "cc-btn cc-menu-btn", type: "button", "data-cc-toggle": "", "aria-expanded": "false", "aria-controls": "cc-nav" },
      ["Menu"]
    );
    menuBtn.addEventListener("click", function () {
      var open = menuBtn.getAttribute("aria-expanded") !== "true";
      closeAllPopups(menuBtn);
      setOpen(menuBtn, open);
    });

    var um = buildUserMenu(user.displayName || user.username || "dev");

    // The bell needs a real session, so it is left out of dev mode and the auth pages.
    var right = h("div", { class: "cc-right" });
    // The common features, the same order for everyone: Planner, Tasks, Messages, Alerts, name.
    if (cc.can("planner.view")) {
      right.appendChild(
        h("a", { class: "cc-btn cc-count", href: "/planner.html", "aria-current": path === "/planner.html" ? "page" : false, text: "Planner" })
      );
    }
    if (!devMode && !onAuthPage) {
      // M4: Tasks and Messages (each only with its key), then Alerts.
      if (cc.can("tasks.use")) {
        counts.tasks = buildCount("Tasks", "/tasks.html", "open");
        right.appendChild(counts.tasks.link);
      }
      if (cc.can("messages.use")) {
        counts.messages = buildCount("Messages", "/messages.html", "unread");
        right.appendChild(counts.messages.link);
      }
      var bell = buildBell();
      right.appendChild(bell.btn);
      right.appendChild(bell.panel);
    }
    right.appendChild(um.btn);
    right.appendChild(um.menu);
    bar.appendChild(menuBtn);
    bar.appendChild(nav);
    bar.appendChild(right);
    root.appendChild(bar);
  }

  // Global dismissal for popups.
  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest("#cc-shell")) closeAllPopups(null);
    else if (!e.target.closest(".cc-right") && !e.target.closest(".cc-menu-btn") && !e.target.closest(".cc-dept")) closeAllPopups(null);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var open = document.querySelector('#cc-shell [data-cc-toggle][aria-expanded="true"]');
    if (open && open.id !== "cc-user-btn") {
      closeAllPopups(null);
      open.focus();
    }
  });

  // ---------- boot ----------
  function boot() {
    var root = document.getElementById("cc-shell");
    if (!root) {
      root = h("div", { id: "cc-shell" });
      document.body.insertBefore(root, document.body.firstChild);
    }
    ensureStyles();
    // Bottom spectrum rule: a plain block after the page content.
    if (!document.getElementById("cc-foot-rule")) {
      document.body.appendChild(h("div", { class: "hs-rule cc-foot-rule", id: "cc-foot-rule", "aria-hidden": "true" }));
    }
    render(root, null); // brand only, so the bar doesn't jump while /me loads

    var finish = function (user, session) {
      cc.me = user;
      cc.session = session || null;
      perms = new Set((user && user.perms) || []);
      cc.dev = devMode;
      cc.loaded = true;
      if (!onAuthPage || user) render(root, user);
      if (user) startAlerts();
      resolveReady(cc);
      document.dispatchEvent(new Event("cc:ready"));
      if (user && user.mustChangePassword && !devMode) {
        openPasswordDialog(
          user.passwordReason === "expired"
            ? "Your password is six months old. Please choose a new one before carrying on."
            : "An administrator set this password for you. Please choose your own before carrying on."
        );
      }
    };
    var fallback = function () {
      devMode = true;
      finish({ id: 0, username: "dev", displayName: "dev", roles: [], perms: [], mustChangePassword: false }, null);
    };

    fetch("/api/auth/me", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) {
        if (res.status === 401) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (onAuthPage) return finish(null, null);
            goLogin(!!body.locked); // navigating away; leave the page as it is
          });
        }
        if (!res.ok) return fallback(); // 404 (auth not merged yet), 5xx, ...
        return res.json().then(function (data) {
          if (!data || !data.user) return fallback();
          finish(data.user, data.session);
        });
      })
      .catch(fallback);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
