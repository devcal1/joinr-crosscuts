// Personal dashboard: greeting, the this-week board, accounts and deliveries lines, notifications and the
// signed-in user's own work (planner, tasks, messages). Getting to a department is the menu bar's job. Everything is gated on window.cc (shell/shell.js).
(function () {
  "use strict";

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

  // Accounts: "N due · N overdue" as a line beside the board summary, for people who can see
  // Accounts. Overdue turns red only when there is some. The line is the way in to the page.
  function renderAccounts(cc) {
    if (!cc.can("accounts.view")) return;
    var line = document.getElementById("accounts-line");
    api("/api/invoices/summary")
      .then(function (s) {
        if (!s) return;
        line.textContent = "";
        line.appendChild(el("strong", null, "Accounts: "));
        line.appendChild(document.createTextNode(s.dueCount + " due · "));
        line.appendChild(el("span", s.overdueCount > 0 ? "stat-overdue" : null, s.overdueCount + " overdue"));
        line.appendChild(el("span", "week-go", "Open accounts"));
        line.hidden = false;
      })
      .catch(function () { /* optional; leave it hidden */ });
  }

  // Deliveries: "N due today · N overdue" beside the board summary, for people who receive
  // deliveries (orders.receive; docs/plans/m10-contracts.md section 9.4). Overdue turns red only
  // when there is some; the line is hidden when both are 0. It leads to the Deliveries page.
  function renderDeliveries(cc) {
    if (!cc.can("orders.receive")) return;
    var line = document.getElementById("deliveries-line");
    api("/api/orders/deliveries")
      .then(function (d) {
        var c = d && d.counts;
        if (!c) return;
        var today = Number(c.today) || 0;
        var overdue = Number(c.overdue) || 0;
        if (!today && !overdue) return;
        line.textContent = "";
        line.appendChild(el("strong", null, "Deliveries: "));
        line.appendChild(document.createTextNode(today + " due today · "));
        line.appendChild(el("span", overdue > 0 ? "stat-overdue" : null, overdue + " overdue"));
        line.appendChild(el("span", "week-go", "Open deliveries"));
        line.hidden = false;
      })
      .catch(function () { /* optional; leave it hidden */ });
  }

  // Someone whose role has no working tiles (the showroom) still gets a line pointing at the menu.
  function renderHint(cc) {
    var working = ["board.view", "accounts.view", "planner.view", "tasks.use", "messages.use"].some(function (k) { return cc.can(k); });
    if (working) return;
    var hint = document.getElementById("menu-hint");
    hint.textContent = cc.can("photos.search")
      ? "Open Photos from the menu above to search finished-job photos."
      : "Use the menu above to open the pages you can use.";
    hint.hidden = false;
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

  // Planner (M7, docs/plans/m7-contracts.md section 14.2): the first six items on today and
  // tomorrow, each a deep link into the planner. "Today" comes from the server, never the
  // browser's clock; the layer is named in words (the markers belong to the Planner page only).
  function nextDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return "";
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
    return d.toISOString().slice(0, 10);
  }
  // "09:00" -> "9:00"
  function fmtTime(t) {
    var m = /^(\d{2}):(\d{2})$/.exec(t || "");
    return m ? Number(m[1]) + ":" + m[2] : t || "";
  }
  function plannerWhen(item, today) {
    var day = item.start <= today ? "Today" : "Tomorrow";
    if (item.allDay || !item.startTime) return day + " · All day";
    return day + " · " + fmtTime(item.startTime) + (item.endTime ? "–" + fmtTime(item.endTime) : "");
  }
  function renderPlanner(cc) {
    if (!cc.can("planner.view")) return;
    var tile = document.getElementById("ix-planner");
    var list = document.getElementById("ix-planner-list");
    var empty = document.getElementById("ix-planner-empty");
    document.getElementById("work-section").hidden = false;
    tile.hidden = false;
    api("/api/planner/layers")
      .then(function (meta) {
        if (!meta) return null;
        var labels = {};
        (meta.layers || []).forEach(function (l) { labels[l.id] = l.label; });
        var today = meta.today;
        var url = "/api/planner/events?from=" + encodeURIComponent(today) + "&to=" + encodeURIComponent(nextDay(today));
        return api(url).then(function (data) {
          if (!data) return;
          var rows = (data.events || []).slice(0, 6);
          empty.hidden = rows.length > 0;
          rows.forEach(function (it) {
            var a = el("a", "ix-item");
            a.href = "/planner.html?date=" + encodeURIComponent(it.start) + "&event=" + encodeURIComponent(it.id);
            a.appendChild(el("span", "ix-main", it.title));
            var sub = [labels[it.layer] || it.layer];
            if (it.sourceLabel && it.sourceLabel !== sub[0]) sub.push(it.sourceLabel);
            a.appendChild(el("span", "ix-sub", sub.join(" · ")));
            a.appendChild(el("span", "ix-side" + (it.overdue ? " ix-overdue" : ""), it.overdue ? "Overdue" : plannerWhen(it, data.today || today)));
            var li = el("li", "ix-li");
            li.appendChild(a);
            list.appendChild(li);
          });
        });
      })
      .catch(function () {
        list.textContent = "";
        empty.textContent = "The planner could not be loaded.";
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
    renderWeek(cc);
    renderAccounts(cc);
    renderDeliveries(cc);
    renderHint(cc);
    renderAlerts(cc);
    renderPlanner(cc);
    renderMyTasks(cc);
    renderMessages(cc);
  }

  if (window.cc && window.cc.loaded) init(window.cc);
  else document.addEventListener("cc:ready", function () { init(window.cc); });
})();
