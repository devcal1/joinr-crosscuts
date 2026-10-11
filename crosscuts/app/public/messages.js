// Messages page: the company chat. Talks to /api/messages (see routes/messages.js and
// docs/plans/m4-contracts.md sections 4 and 6). Every piece of user text is built with
// textContent / text nodes; only http(s) links become anchors.
(function () {
  "use strict";

  var POLL_MS = 5000; // the open channel, only while the tab is visible
  var COUNTS_MS = 30000; // the channel list's unread counts
  var PAGE = 50;
  var URL_RE = /https?:\/\/[^\s]+/g;

  function el(tag, props) {
    var node = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) node.append(arguments[i]);
    return node;
  }

  var channelsEl = document.getElementById("channels");
  var selectEl = document.getElementById("channelSelect");
  var nameEl = document.getElementById("threadName");
  var scrollEl = document.getElementById("scroller");
  var olderBtn = document.getElementById("older");
  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");
  var newerBtn = document.getElementById("newer");
  var errorEl = document.getElementById("error");
  var formEl = document.getElementById("composer");
  var bodyEl = document.getElementById("body");
  var sendBtn = document.getElementById("send");

  var channels = []; // [{id, slug, name, unread, lastMessageAt}]
  var current = null; // the open channel
  var msgs = []; // the loaded messages of the open channel, oldest first
  var hasOlder = false;
  var openSeq = 0; // the newest channel switch wins
  var pollBusy = false;
  var sending = false;
  var myId = null;

  function setError(msg) {
    errorEl.textContent = msg || "";
  }

  function visible() {
    return document.visibilityState === "visible";
  }

  // ---------- text with links ----------

  // Appends text to `parent`: http(s) links become anchors, line breaks become <br>.
  function appendRich(parent, text) {
    String(text).split("\n").forEach(function (line, i) {
      if (i > 0) parent.append(document.createElement("br"));
      var last = 0;
      var m;
      URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(line)) !== null) {
        var raw = m[0];
        var trail = "";
        var t;
        while ((t = /[.,;:!?)\]'"]$/.exec(raw)) !== null) {
          trail = t[0] + trail;
          raw = raw.slice(0, -1);
        }
        var ok = false;
        try {
          var u = new URL(raw);
          ok = (u.protocol === "http:" || u.protocol === "https:") && raw.length > 8;
        } catch (e) {
          ok = false;
        }
        if (!ok) continue;
        if (m.index > last) parent.append(document.createTextNode(line.slice(last, m.index)));
        var a = el("a", { href: raw, target: "_blank", rel: "noopener noreferrer", text: raw });
        parent.append(a);
        last = m.index + raw.length;
        URL_RE.lastIndex = last;
      }
      if (last < line.length) parent.append(document.createTextNode(line.slice(last)));
    });
  }

  // ---------- times ----------

  var DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" });
  function sydneyDay(iso) {
    return DAY_FMT.format(new Date(iso)); // YYYY-MM-DD
  }
  function dayLabel(iso) {
    var key = sydneyDay(iso);
    var now = Date.now();
    if (key === sydneyDay(new Date(now).toISOString())) return "Today";
    if (key === sydneyDay(new Date(now - 86400000).toISOString())) return "Yesterday";
    return new Date(iso).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  function fullTime(iso) {
    return new Date(iso).toLocaleString("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }
  function ago(iso) {
    return window.cc && typeof window.cc.timeAgo === "function" ? window.cc.timeAgo(iso) : "";
  }

  // ---------- the channel list ----------

  function renderChannels() {
    channelsEl.replaceChildren();
    selectEl.replaceChildren();
    channels.forEach(function (c) {
      var isOpen = current && current.id === c.id;
      // The open channel is being read, so its badge stays hidden while the tab is up.
      var unread = isOpen && visible() ? 0 : c.unread;
      var btn = el("button", { type: "button", class: "ms-channel" }, el("span", { class: "ms-channel-name", text: c.name }));
      if (unread > 0) btn.append(el("span", { class: "ms-count", text: String(unread) }));
      if (isOpen) btn.setAttribute("aria-current", "true");
      btn.addEventListener("click", function () {
        openChannel(c);
      });
      channelsEl.append(el("li", {}, btn));
      var opt = el("option", { value: String(c.id), text: c.name + (unread > 0 ? " (" + unread + ")" : "") });
      if (isOpen) opt.selected = true;
      selectEl.append(opt);
    });
  }

  async function loadChannels() {
    var data = await api("/api/messages/channels");
    channels = data.rows || [];
    if (current) {
      var fresh = channels.find(function (c) {
        return c.id === current.id;
      });
      if (fresh) current = fresh;
    }
    renderChannels();
  }

  // ---------- the thread ----------

  function messageNode(m) {
    var mine = m.author && m.author.id === myId;
    var li = el("li", { class: "ms-msg" + (mine ? " ms-mine" : ""), "data-id": String(m.id) });
    var head = el(
      "div",
      { class: "ms-msg-head" },
      el("span", { class: "ms-author", text: m.author ? m.author.name : "Unknown" }),
      el("span", { class: "ms-time", text: ago(m.createdAt), title: fullTime(m.createdAt), "data-at": m.createdAt })
    );
    if (m.canRemove) {
      var rm = el("button", { type: "button", class: "ms-remove", text: "Remove" });
      rm.addEventListener("click", function () {
        confirmRemove(m);
      });
      head.append(rm);
    }
    li.append(head);
    var body = el("p", { class: "ms-msg-body" + (m.removed ? " ms-removed" : "") });
    if (m.removed) body.textContent = "Removed";
    else appendRich(body, m.body);
    li.append(body);
    return li;
  }

  function renderList() {
    var frag = document.createDocumentFragment();
    var lastDay = "";
    msgs.forEach(function (m) {
      var day = sydneyDay(m.createdAt);
      if (day !== lastDay) {
        frag.append(el("li", { class: "ms-day", text: dayLabel(m.createdAt), "aria-hidden": "true" }));
        lastDay = day;
      }
      frag.append(messageNode(m));
    });
    listEl.replaceChildren(frag);
    emptyEl.hidden = msgs.length > 0;
    olderBtn.hidden = !hasOlder;
  }

  function atBottom() {
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
  }
  function toBottom() {
    scrollEl.scrollTop = scrollEl.scrollHeight;
    newerBtn.hidden = true;
  }

  function newestId() {
    return msgs.length ? msgs[msgs.length - 1].id : 0;
  }

  // Merges rows into msgs by id (an existing row is replaced), keeping id order.
  function merge(rows) {
    var byId = new Map(
      msgs.map(function (m) {
        return [m.id, m];
      })
    );
    var added = 0;
    rows.forEach(function (m) {
      if (!byId.has(m.id)) added++;
      byId.set(m.id, m);
    });
    msgs = Array.from(byId.values()).sort(function (a, b) {
      return a.id - b.id;
    });
    return added;
  }

  async function markRead() {
    if (!current || !msgs.length || !visible()) return;
    var ch = current;
    try {
      await api("/api/messages/channels/" + ch.id + "/read", { method: "POST", body: JSON.stringify({ lastId: newestId() }) });
      var c = channels.find(function (x) {
        return x.id === ch.id;
      });
      if (c) c.unread = 0;
      renderChannels();
      if (window.cc && window.cc.refreshCounts) window.cc.refreshCounts();
    } catch (e) {
      /* the next poll tries again */
    }
  }

  async function openChannel(c) {
    if (current && current.id === c.id) return;
    var seq = ++openSeq;
    current = c;
    msgs = [];
    hasOlder = false;
    setError("");
    nameEl.textContent = c.name;
    renderChannels();
    renderList();
    emptyEl.hidden = true;
    newerBtn.hidden = true;
    bodyEl.disabled = false;
    sendBtn.disabled = false;
    try {
      history.replaceState(null, "", "?channel=" + encodeURIComponent(c.slug));
    } catch (e) {
      /* not essential */
    }
    try {
      var data = await api("/api/messages/channels/" + c.id + "?limit=" + PAGE);
      if (seq !== openSeq) return;
      msgs = data.rows || [];
      hasOlder = !!data.more;
      renderList();
      toBottom();
      await markRead();
    } catch (e) {
      if (seq === openSeq) setError(e.message || "Could not load messages");
    }
  }

  async function loadOlder() {
    if (!current || !msgs.length) return;
    var seq = openSeq;
    olderBtn.disabled = true;
    try {
      var data = await api("/api/messages/channels/" + current.id + "?before=" + msgs[0].id + "&limit=" + PAGE);
      if (seq !== openSeq) return;
      var before = scrollEl.scrollHeight;
      merge(data.rows || []);
      hasOlder = !!data.more;
      renderList();
      scrollEl.scrollTop += scrollEl.scrollHeight - before; // keep what was on screen where it was
    } catch (e) {
      setError(e.message || "Could not load older messages");
    } finally {
      olderBtn.disabled = false;
    }
  }

  // Fetches messages newer than the last one shown. Serialised, so a poll and a send never overlap.
  async function poll() {
    if (!current || pollBusy) return;
    pollBusy = true;
    var seq = openSeq;
    var ch = current;
    try {
      for (var guard = 0; guard < 10; guard++) {
        var data = await api("/api/messages/channels/" + ch.id + "?after=" + newestId() + "&limit=200");
        if (seq !== openSeq) return;
        var rows = data.rows || [];
        if (rows.length) {
          var stick = atBottom();
          var mineLast = rows.some(function (m) {
            return m.author && m.author.id === myId;
          });
          var added = merge(rows);
          renderList();
          if (stick || mineLast) toBottom();
          else if (added) newerBtn.hidden = false;
          if (added) await markRead();
        }
        if (!data.more) break;
      }
      setError("");
    } catch (e) {
      /* a missed poll is retried in 5 seconds; keep any error already showing */
    } finally {
      pollBusy = false;
    }
  }

  // ---------- sending and removing ----------

  async function send() {
    if (sending || !current) return;
    var text = bodyEl.value.trim();
    if (!text) return;
    sending = true;
    sendBtn.disabled = true;
    setError("");
    try {
      var m = await api("/api/messages/channels/" + current.id, { method: "POST", body: JSON.stringify({ body: text }) });
      bodyEl.value = "";
      // The poll picks up anything sent by others before this message, as well as this one.
      var wait = 0;
      while (pollBusy && wait++ < 50) await new Promise(function (r) { setTimeout(r, 100); });
      await poll();
      if (!msgs.some(function (x) { return x.id === m.id; })) {
        merge([m]);
        renderList();
      }
      toBottom();
      loadChannels().catch(function () {});
      if (window.cc && window.cc.refreshCounts) window.cc.refreshCounts();
    } catch (e) {
      setError(e.message || "Could not send that message");
    } finally {
      sending = false;
      sendBtn.disabled = false;
      bodyEl.focus();
    }
  }

  // A modal on the shell's cc-dialog frame. Red is for this destructive confirm.
  function confirmRemove(m) {
    var dlg = el("dialog", { class: "cc-dialog ms-dialog", "aria-label": "Remove message" });
    var keep = el("button", { type: "button", class: "hs-btn", text: "Keep it" });
    var yes = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Remove" });
    var err = el("p", { class: "cc-dialog-error", role: "status" });
    keep.addEventListener("click", function () {
      dlg.close();
    });
    yes.addEventListener("click", async function () {
      yes.disabled = true;
      try {
        await api("/api/messages/" + m.id, { method: "DELETE" });
        var i = msgs.findIndex(function (x) {
          return x.id === m.id;
        });
        if (i >= 0) msgs[i] = Object.assign({}, msgs[i], { removed: true, body: null, canRemove: false });
        renderList();
        dlg.close();
      } catch (e) {
        err.textContent = e.message || "Could not remove that message";
        yes.disabled = false;
      }
    });
    dlg.append(
      el(
        "div",
        { class: "cc-dialog-form" },
        el("h2", { class: "cc-dialog-title", text: "Remove this message?" }),
        el("p", { class: "cc-dialog-note", text: "It will show as Removed for everyone in the channel." }),
        err,
        el("div", { class: "cc-dialog-actions" }, keep, yes)
      )
    );
    document.body.append(dlg);
    dlg.addEventListener("mousedown", function (e) {
      if (e.target === dlg) dlg.close();
    });
    dlg.addEventListener("close", function () {
      dlg.remove();
      bodyEl.focus();
    });
    dlg.showModal();
  }

  // ---------- wiring ----------

  function refreshTimes() {
    listEl.querySelectorAll(".ms-time").forEach(function (t) {
      var at = t.getAttribute("data-at");
      if (at) t.textContent = ago(at);
    });
  }

  function start() {
    myId = window.cc && window.cc.me ? window.cc.me.id : null;

    formEl.addEventListener("submit", function (e) {
      e.preventDefault();
      send();
    });
    bodyEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    olderBtn.addEventListener("click", loadOlder);
    newerBtn.addEventListener("click", function () {
      toBottom();
    });
    scrollEl.addEventListener("scroll", function () {
      if (atBottom()) newerBtn.hidden = true;
    });
    selectEl.addEventListener("change", function () {
      var c = channels.find(function (x) {
        return String(x.id) === selectEl.value;
      });
      if (c) openChannel(c);
    });

    // The 5 s poll runs only while the tab is visible.
    setInterval(function () {
      if (visible()) poll();
    }, POLL_MS);
    setInterval(function () {
      if (visible()) {
        loadChannels().catch(function () {});
        refreshTimes();
      }
    }, COUNTS_MS);
    document.addEventListener("visibilitychange", function () {
      if (!visible()) return;
      poll().then(function () {
        markRead();
      });
      loadChannels().catch(function () {});
      refreshTimes();
    });

    loadChannels()
      .then(function () {
        if (!channels.length) {
          nameEl.textContent = "No channels";
          emptyEl.textContent = "You have no channels.";
          emptyEl.hidden = false;
          return;
        }
        var slug = new URLSearchParams(location.search).get("channel");
        var pick =
          channels.find(function (c) {
            return c.slug === slug;
          }) || channels[0];
        return openChannel(pick);
      })
      .catch(function (e) {
        setError(e.message || "Could not load channels");
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var go = function () {
      start();
    };
    if (window.cc && window.cc.ready && typeof window.cc.ready.then === "function") window.cc.ready.then(go);
    else go();
  });
})();
