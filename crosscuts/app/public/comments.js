// Comment threads, shared by the task dialog (taskui.js) and the job page.
//
//   ccComments.mount(container, "task" | "job", entityId, { canWrite, onChange })
//     -> { reload() }
//   ccComments.renderText(parent, text)    // plain text with http(s) links, line breaks as <br>
//
// Talks to /api/comments (see routes/comments.js and docs/plans/m4-contracts.md sections 4 and 6).
// All user text goes in as text nodes. The only elements built from it are <a> and <br>, and an
// <a> is made only for an http(s) URL that parses.
// Styles (cm- classes) are in tasks.css, which this script links if the page has not.
(function () {
  "use strict";
  if (window.ccComments) return;

  function ensureStyles() {
    if (document.querySelector('link[rel="stylesheet"][href$="tasks.css"]')) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/tasks.css";
    document.head.appendChild(link);
  }

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

  // JSON call that throws Error(message) with .status, and sends a 401 to the login page.
  async function call(method, path, body) {
    var res = await fetch(path, {
      method: method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !location.pathname.startsWith("/login.html")) {
      location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
      return new Promise(function () {});
    }
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      var err = new Error((data && data.error) || "Request failed (" + res.status + ")");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function appendLines(parent, s) {
    var parts = s.split("\n");
    parts.forEach(function (part, i) {
      if (i > 0) parent.append(document.createElement("br"));
      if (part) parent.append(document.createTextNode(part));
    });
  }

  // Text with line breaks; each https?://... run that parses as an http(s) URL becomes a link
  // (new tab, noopener). Punctuation that ends a sentence stays outside the link.
  function renderText(parent, text) {
    var s = String(text == null ? "" : text);
    var re = /https?:\/\/\S+/g;
    var last = 0;
    var m;
    while ((m = re.exec(s))) {
      var raw = m[0];
      var trail = (/[.,;:!?)\]}'"]+$/.exec(raw) || [""])[0];
      var url = raw.slice(0, raw.length - trail.length);
      var href = null;
      try {
        var u = new URL(url);
        if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname) href = u.href;
      } catch (e) {
        href = null;
      }
      if (!href) continue; // leave it as text
      appendLines(parent, s.slice(last, m.index));
      var a = el("a", { href: href, target: "_blank", rel: "noopener noreferrer" });
      a.textContent = url;
      parent.append(a);
      if (trail) parent.append(document.createTextNode(trail));
      last = m.index + raw.length;
    }
    appendLines(parent, s.slice(last));
  }

  function ago(iso) {
    return window.cc && typeof window.cc.timeAgo === "function" ? window.cc.timeAgo(iso) : "";
  }

  function fullTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime())
      ? ""
      : d.toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function mount(container, entityType, entityId, opts) {
    ensureStyles();
    var o = opts || {};
    var canWrite = o.canWrite !== false;
    var seq = 0;
    var rows = [];
    var following = false;

    container.replaceChildren();
    container.classList.add("cm-box");

    var title = el("h3", { class: "cm-title", text: "Comments" });
    var followBtn = el("button", { type: "button", class: "hs-btn hs-btn-quiet cm-follow", text: "Follow" });
    var head = el("div", { class: "cm-head" }, title, followBtn);
    var msg = el("p", { class: "cm-msg", role: "status", "aria-live": "polite" });
    var listEl = el("div", { class: "cm-list" });
    container.append(head, listEl, msg);

    var input = null;
    var postBtn = null;
    if (canWrite) {
      input = el("textarea", { class: "hs-input cm-input", rows: "3", maxlength: "4000", placeholder: "Write a comment", "aria-label": "Write a comment" });
      postBtn = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Post" });
      container.append(el("div", { class: "cm-compose" }, input, el("div", { class: "cm-compose-row" }, el("span", { class: "cm-hint", text: "Ctrl+Enter posts" }), postBtn)));
    } else {
      container.append(el("p", { class: "cm-note", text: "You can read comments here, but not write them." }));
    }

    function say(text, bad) {
      msg.textContent = text || "";
      msg.className = "cm-msg" + (bad ? " cm-err" : "");
    }

    function render() {
      var live = rows.filter(function (r) { return !r.removed; }).length;
      title.textContent = "Comments" + (live ? " (" + live + ")" : "");
      followBtn.textContent = following ? "Stop following" : "Follow";
      followBtn.title = following ? "Stop getting alerts about new comments" : "Get an alert when someone comments";
      listEl.replaceChildren();
      if (!rows.length) listEl.append(el("p", { class: "cm-empty", text: "No comments yet." }));
      rows.forEach(function (c) {
        var item = el("div", { class: "cm-item" + (c.removed ? " cm-gone" : "") });
        var meta = el("div", { class: "cm-meta" }, el("span", { class: "cm-author", text: c.author.name }), el("span", { class: "cm-time", text: ago(c.createdAt), title: fullTime(c.createdAt) }));
        if (c.canRemove) {
          var rm = el("button", { type: "button", class: "hs-btn hs-btn-quiet cm-remove", text: "Remove" });
          var armed = null;
          rm.addEventListener("click", function () {
            if (!armed) {
              rm.textContent = "Confirm remove";
              rm.classList.add("hs-btn-stop");
              armed = setTimeout(function () {
                armed = null;
                rm.textContent = "Remove";
                rm.classList.remove("hs-btn-stop");
              }, 4000);
              return;
            }
            clearTimeout(armed);
            armed = null;
            removeComment(c, rm);
          });
          meta.append(rm);
        }
        var body = el("div", { class: "cm-body" });
        if (c.removed) body.textContent = "Removed";
        else renderText(body, c.body);
        item.append(meta, body);
        listEl.append(item);
      });
    }

    async function load() {
      var mine = ++seq;
      try {
        var data = await call("GET", "/api/comments?entityType=" + encodeURIComponent(entityType) + "&entityId=" + encodeURIComponent(entityId));
        if (mine !== seq) return;
        rows = data.rows;
        following = !!data.following;
        say("");
        render();
      } catch (e) {
        if (mine === seq) say(e.message, true);
      }
    }

    function changed() {
      if (typeof o.onChange === "function") o.onChange();
    }

    async function removeComment(c, btn) {
      btn.disabled = true;
      try {
        await call("DELETE", "/api/comments/" + c.id);
        say("");
      } catch (e) {
        say(e.message, true);
      }
      await load();
      changed();
    }

    async function toggleFollow() {
      followBtn.disabled = true;
      try {
        await call("POST", "/api/comments/" + (following ? "unfollow" : "follow"), { entityType: entityType, entityId: Number(entityId) });
        following = !following;
        say("");
        render();
      } catch (e) {
        say(e.message, true);
      }
      followBtn.disabled = false;
    }

    async function post() {
      var text = input.value.trim();
      if (!text) {
        say("Write something first.", true);
        return;
      }
      postBtn.disabled = true;
      try {
        await call("POST", "/api/comments", { entityType: entityType, entityId: Number(entityId), body: text });
        input.value = "";
        say("");
        await load();
        following = true;
        render();
        changed();
      } catch (e) {
        say(e.message, true);
      }
      postBtn.disabled = false;
    }

    followBtn.addEventListener("click", toggleFollow);
    if (canWrite) {
      postBtn.addEventListener("click", post);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          post();
        }
      });
    }
    render();
    load();
    return { reload: load };
  }

  window.ccComments = { mount: mount, renderText: renderText };
})();
