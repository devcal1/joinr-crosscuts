// Crosscuts shared shell: the top bar used by every page except the schedule board.
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

  var LINK_GROUPS = [
    {
      label: "Production",
      items: [
        { label: "Scheduling", href: "/scheduling.html", key: "scheduling.view" },
        { label: "Board", href: "/schedule.html", key: "board.view" },
        { label: "Workers", href: "/workers.html", key: "workers.edit" },
      ],
    },
    {
      label: "Jobs and money",
      items: [
        { label: "Jobs", href: "/jobs.html", key: "jobs.view" },
        { label: "Design/PM", href: "/design.html", key: "design.view" },
        { label: "Accounts", href: "/accounts.html", key: "accounts.view" },
      ],
    },
    {
      label: "Photos",
      items: [
        { label: "Photos", href: "/search.html", key: "photos.search" },
        { label: "Photo admin", href: "/admin.html", key: "photos.admin" },
      ],
    },
    {
      label: "Admin",
      items: [
        { label: "Users", href: "/users.html", key: "users.admin" },
        { label: "Audit", href: "/audit.html", key: "audit.view" },
      ],
    },
  ];

  // Pages that belong to a nav link but have a different path.
  var PAGE_ALIASES = { "/job.html": "/jobs.html", "/index.html": "/" };

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
  function icon(name) {
    return h("i", { class: "ph ph-" + name, "aria-hidden": "true" });
  }

  function ensureStyles() {
    var wanted = ["/shell/shell.css", "/tokens.css", "/vendor/phosphor/style.css"];
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
        class: "cc-input",
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
    var submitBtn = h("button", { class: "cc-btn cc-btn-primary", type: "submit", text: opts.submit });
    var cancelBtn = h("button", { class: "cc-btn", type: "button", text: "Cancel" });
    var actions = [];
    var extraBtn = null;
    if (opts.extra) {
      extraBtn = h("button", { class: "cc-btn cc-btn-quiet", type: "button", text: opts.extra.label });
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
      menuItem("Change password", "password", openPasswordDialog),
      menuItem("Set PIN", "key", openPinDialog),
      menuItem("Lock", "lock", doLock),
      h("hr", { class: "cc-menu-sep" }),
      menuItem("Sign out", "sign-out", doSignOut),
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
      [icon("user-circle"), h("span", { class: "cc-user-name", text: displayName }), icon("caret-down")]
    );
    btn.setAttribute("aria-label", "Account menu for " + displayName);

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
  function menuItem(label, iconName, onClick) {
    return h("button", { class: "cc-menu-item", type: "button", role: "menuitem", tabindex: "-1", onclick: onClick }, [
      icon(iconName),
      label,
    ]);
  }

  // ---------- render ----------
  function isCurrent(href) {
    var here = PAGE_ALIASES[path] || path;
    return here === href;
  }

  function render(root, user) {
    root.textContent = "";
    var bar = h("header", { class: "cc-bar" });
    bar.appendChild(
      h("a", { class: "cc-brand", href: "/", "aria-current": path === "/" || path === "/index.html" ? "page" : false, text: "Crosscuts" })
    );
    if (!user) {
      root.appendChild(bar);
      return;
    }

    var nav = h("nav", { class: "cc-nav", id: "cc-nav", "aria-label": "Departments" });
    LINK_GROUPS.forEach(function (g, gi) {
      var allowed = g.items.filter(function (it) { return cc.can(it.key); });
      if (!allowed.length) return;
      var ul = h("ul", { class: "cc-group", "aria-labelledby": "cc-gl-" + gi });
      var li0 = h("li", { class: "cc-group-label", id: "cc-gl-" + gi, text: g.label });
      li0.setAttribute("role", "presentation");
      // The label is only visible in the collapsed menu; it names the list for screen readers.
      ul.appendChild(li0);
      allowed.forEach(function (it) {
        ul.appendChild(
          h("li", null, [h("a", { class: "cc-link", href: it.href, "aria-current": isCurrent(it.href) ? "page" : false, text: it.label })])
        );
      });
      nav.appendChild(ul);
    });

    var menuBtn = h(
      "button",
      { class: "cc-btn cc-menu-btn", type: "button", "data-cc-toggle": "", "aria-expanded": "false", "aria-controls": "cc-nav" },
      [icon("list"), "Menu"]
    );
    menuBtn.addEventListener("click", function () {
      var open = menuBtn.getAttribute("aria-expanded") !== "true";
      closeAllPopups(menuBtn);
      setOpen(menuBtn, open);
    });

    var bell = h("span", { title: "Notifications arrive in a later update" }, [
      h(
        "button",
        { class: "cc-icon-btn", type: "button", disabled: true, "aria-label": "Notifications (arrive in a later update)" },
        [icon("bell")]
      ),
    ]);
    var um = buildUserMenu(user.displayName || user.username || "dev");

    var right = h("div", { class: "cc-right" }, [bell, um.btn, um.menu]);
    bar.appendChild(menuBtn);
    bar.appendChild(nav);
    bar.appendChild(right);
    root.appendChild(bar);
  }

  // Global dismissal for popups.
  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest("#cc-shell")) closeAllPopups(null);
    else if (!e.target.closest(".cc-right") && !e.target.closest(".cc-menu-btn")) closeAllPopups(null);
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
    render(root, null); // brand only, so the bar doesn't jump while /me loads

    var finish = function (user, session) {
      cc.me = user;
      cc.session = session || null;
      perms = new Set((user && user.perms) || []);
      cc.dev = devMode;
      cc.loaded = true;
      if (!onAuthPage || user) render(root, user);
      resolveReady(cc);
      document.dispatchEvent(new Event("cc:ready"));
      if (user && user.mustChangePassword && !devMode) {
        openPasswordDialog("An administrator set this password for you. Please choose your own before carrying on.");
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
