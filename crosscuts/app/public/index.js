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

  function init(cc) {
    renderGreeting(cc);
    renderTiles(cc);
    renderWeek(cc);
  }

  if (window.cc && window.cc.loaded) init(window.cc);
  else document.addEventListener("cc:ready", function () { init(window.cc); });
})();
