// Personal dashboard: greeting, this-week board summary and the departments
// the signed-in user may use. Everything is gated on window.cc (shell/shell.js).
(function () {
  "use strict";

  var DEPARTMENTS = [
    {
      title: "Scheduling",
      text: "Leave, availability and what is coming up on the board.",
      any: ["scheduling.view", "board.view", "workers.edit"],
      links: [
        { label: "Scheduling", href: "/scheduling.html", key: "scheduling.view" },
        { label: "Board", href: "/schedule.html", key: "board.view" },
        { label: "Workers", href: "/workers.html", key: "workers.edit" },
      ],
    },
    {
      title: "Jobs and design",
      text: "Job records, and the design and project management pipeline.",
      any: ["jobs.view", "design.view"],
      links: [
        { label: "Jobs", href: "/jobs.html", key: "jobs.view" },
        { label: "Design/PM", href: "/design.html", key: "design.view" },
      ],
    },
    {
      title: "Accounts",
      text: "Invoices, overdue accounts and reports.",
      any: ["accounts.view"],
      stat: "accounts",
      links: [{ label: "Accounts", href: "/accounts.html", key: "accounts.view" }],
    },
    {
      title: "Photos",
      text: "Find finished-job photos, or upload and tag new ones.",
      any: ["photos.search", "photos.admin"],
      links: [
        { label: "Search photos", href: "/search.html", key: "photos.search" },
        { label: "Photo admin", href: "/admin.html", key: "photos.admin" },
      ],
    },
    {
      title: "Admin",
      text: "Who can sign in, what they can do, and what has changed.",
      any: ["users.admin", "audit.view"],
      links: [
        { label: "Users", href: "/users.html", key: "users.admin" },
        { label: "Audit log", href: "/audit.html", key: "audit.view" },
      ],
    },
  ];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function sydneyParts() {
    var parts = {};
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .forEach(function (p) { parts[p.type] = p.value; });
    return parts;
  }

  function renderGreeting(cc) {
    var p = sydneyParts();
    var hour = parseInt(p.hour, 10);
    var word = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    var name = (cc.me && cc.me.displayName) || "";
    document.getElementById("greeting").textContent = name ? word + ", " + name : word;
    document.getElementById("today").textContent = p.weekday + " " + p.day + " " + p.month;
  }

  function renderTiles(cc) {
    var host = document.getElementById("tiles");
    var shown = 0;
    DEPARTMENTS.forEach(function (d) {
      if (!d.any.some(function (k) { return cc.can(k); })) return;
      var tile = el("article", "tile hs-card");
      tile.appendChild(el("h3", "tile-title", d.title));
      tile.appendChild(el("p", "tile-text", d.text));
      if (d.stat === "accounts") tile.appendChild(accountsStat());
      var links = el("div", "tile-links");
      d.links.forEach(function (l) {
        if (!cc.can(l.key)) return;
        var a = el("a", "hs-btn" + (links.children.length === 0 ? " hs-btn-primary" : ""), l.label);
        a.href = l.href;
        links.appendChild(a);
      });
      tile.appendChild(links);
      host.appendChild(tile);
      shown++;
    });
    if (!shown) document.getElementById("tiles-empty").hidden = false;
  }

  // "N due · N overdue" on the Accounts tile. Overdue turns red only when there is some.
  function accountsStat() {
    var line = el("p", "tile-stat");
    line.hidden = true;
    api("/api/invoices/summary")
      .then(function (s) {
        if (!s) return;
        line.textContent = "";
        line.appendChild(el("strong", null, s.dueCount + " due"));
        line.appendChild(document.createTextNode(" · "));
        line.appendChild(el("strong", s.overdueCount > 0 ? "stat-overdue" : null, s.overdueCount + " overdue"));
        line.hidden = false;
      })
      .catch(function () { /* optional; leave it hidden */ });
    return line;
  }

  // The latest five alerts. Each one marks itself read and follows its link, as in the bell.
  function renderAlerts(cc) {
    if (cc.dev) return;
    var section = document.getElementById("alerts-section");
    var list = document.getElementById("alerts-list");
    document.getElementById("alerts-all").addEventListener("click", function () { cc.openAlerts(); });
    api("/api/notifications?limit=5")
      .then(function (data) {
        if (!data) return;
        section.hidden = false;
        var rows = data.rows || [];
        document.getElementById("alerts-empty").hidden = rows.length > 0;
        rows.forEach(function (n) {
          var link = typeof n.link === "string" && /^\/(?!\/)/.test(n.link) ? n.link : "";
          var item = el(link ? "a" : "button", "alert-item" + (n.readAt ? "" : " alert-unread"));
          if (link) item.href = link;
          else item.type = "button";
          if (!n.readAt) item.appendChild(el("span", "alert-sr", "Unread: "));
          item.appendChild(el("span", "alert-title", n.title));
          if (n.body) item.appendChild(el("span", "alert-body", n.body));
          item.appendChild(el("span", "alert-time", cc.timeAgo(n.createdAt)));
          item.addEventListener("click", function (e) {
            if (link && (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey)) return;
            e.preventDefault();
            cc.openAlert(n);
          });
          var li = el("li", "alert-li");
          li.appendChild(item);
          list.appendChild(li);
        });
      })
      .catch(function () { /* optional; leave it hidden */ });
  }

  function renderWeek(cc) {
    if (!cc.can("board.view")) return;
    api("/api/dashboard/week")
      .then(function (w) {
        if (!w) return;
        var line = document.getElementById("week-line");
        line.textContent = "";
        line.appendChild(el("strong", null, "This week: "));
        var onBoard = w.manufacturing + w.installing;
        var text = onBoard
          ? w.manufacturing + " manufacturing · " + w.installing + " installing · " + w.backlog + " waiting to start"
          : "nothing on the board yet · " + w.backlog + " waiting to start";
        line.appendChild(document.createTextNode(text));
        line.appendChild(el("span", "week-go", "Open the board"));
        line.hidden = false;
      })
      .catch(function () { /* the summary is optional; leave it hidden */ });
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] : "";
  }

  // My tasks: up to 8 open tasks assigned to me, overdue first. Each opens in the task page.
  function renderMyTasks(cc) {
    if (!cc.can("tasks.use")) return;
    var tile = document.getElementById("ix-tasks");
    var list = document.getElementById("ix-tasks-list");
    var empty = document.getElementById("ix-tasks-empty");
    document.getElementById("work-section").hidden = false;
    tile.hidden = false;
    api("/api/tasks?view=mine&limit=8")
      .then(function (data) {
        if (!data) return;
        var rows = (data.rows || []).slice(0, 8);
        empty.hidden = rows.length > 0;
        rows.forEach(function (t) {
          var a = el("a", "ix-item");
          a.href = "/tasks.html?task=" + encodeURIComponent(t.id);
          a.appendChild(el("span", "ix-main", t.title));
          var meta = [];
          if (t.job && t.job.name) meta.push(t.job.name);
          if (meta.length) a.appendChild(el("span", "ix-sub", meta.join(" · ")));
          var due = el("span", "ix-side" + (t.overdue ? " ix-overdue" : ""), t.dueDate ? (t.overdue ? "Overdue " : "Due ") + fmtDate(t.dueDate) : "No date");
          a.appendChild(due);
          var li = el("li", "ix-li");
          li.appendChild(a);
          list.appendChild(li);
        });
      })
      .catch(function () {
        empty.textContent = "Tasks could not be loaded.";
        empty.hidden = false;
      });
  }

  // Messages: each channel I can see, with how many messages I have not read.
  function renderMessages(cc) {
    if (!cc.can("messages.use")) return;
    var tile = document.getElementById("ix-messages");
    var list = document.getElementById("ix-messages-list");
    var empty = document.getElementById("ix-messages-empty");
    document.getElementById("work-section").hidden = false;
    tile.hidden = false;
    api("/api/messages/channels")
      .then(function (data) {
        if (!data) return;
        var rows = data.rows || [];
        empty.hidden = rows.length > 0;
        rows.forEach(function (ch) {
          var a = el("a", "ix-item");
          a.href = "/messages.html?channel=" + encodeURIComponent(ch.slug);
          a.appendChild(el("span", "ix-main", ch.name));
          var n = Number(ch.unread) || 0;
          a.appendChild(el("span", "ix-side" + (n ? " ix-unread" : ""), n ? n + " new" : "Up to date"));
          var li = el("li", "ix-li");
          li.appendChild(a);
          list.appendChild(li);
        });
      })
      .catch(function () {
        empty.textContent = "Messages could not be loaded.";
        empty.hidden = false;
      });
  }

  function init(cc) {
    renderGreeting(cc);
    renderTiles(cc);
    renderWeek(cc);
    renderAlerts(cc);
    renderMyTasks(cc);
    renderMessages(cc);
  }

  if (window.cc && window.cc.loaded) init(window.cc);
  else document.addEventListener("cc:ready", function () { init(window.cc); });
})();
