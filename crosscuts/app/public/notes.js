// Department notes page: /notes.html?dept=<id>&from=<Monday>. Five week columns (this week centred
// by default) of sticky notes, each with an optional day tag. Talks to /api/notes (routes/notes.js,
// docs/plans/notes-contracts.md). Every piece of note text is set with textContent; line breaks are
// kept by the CSS (white-space: pre-wrap), never by markup.
(function () {
  "use strict";

  var BODY_MAX = 2000;
  var params = new URLSearchParams(location.search);
  var dept = params.get("dept") || "";

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
  function $(id) { return document.getElementById(id); }

  var titleEl = $("title");
  var messageEl = $("message");
  var boardEl = $("board");
  var wallEl = $("wall");
  var composer = $("composer");
  var bodyEl = $("body");
  var weekEl = $("week");
  var dayEl = $("day");
  var postBtn = $("post");
  var countEl = $("count");
  var errorEl = $("error");
  var addBtn = $("addBtn");
  var guardEl = $("guard");
  var guardText = $("guardText");
  var guardBtns = $("guardBtns");

  var data = null;     // the five weeks on screen, as the server sent them
  // The note being edited or removed, if any: { id, li, dirty(), close() }. Only one at a time, and
  // never while the add form holds text, so a redraw can't swallow work that isn't saved.
  var current = null;

  // ---------- plain sentences and keep/discard questions ----------

  function clearGuard() {
    guardEl.hidden = true;
    guardText.textContent = "";
    guardBtns.replaceChildren();
  }
  // A question with two buttons; the safe one (keep) has focus.
  function askGuard(text, yesLabel, keepLabel, onYes) {
    clearGuard();
    guardText.textContent = text;
    var yes = el("button", { type: "button", class: "hs-btn", text: yesLabel });
    var keep = el("button", { type: "button", class: "hs-btn", text: keepLabel });
    yes.addEventListener("click", function () { clearGuard(); onYes(); });
    keep.addEventListener("click", function () { clearGuard(); });
    guardBtns.append(yes, keep);
    guardEl.hidden = false;
    guardEl.scrollIntoView({ block: "nearest" });
    keep.focus();
  }
  function sayGuard(text) {
    clearGuard();
    guardText.textContent = text;
    guardEl.hidden = false;
    guardEl.scrollIntoView({ block: "nearest" });
  }
  // What is open with unsaved words in it: "composer", "edit", or "" for nothing.
  function unsaved() {
    if (!composer.hidden && bodyEl.value.trim()) return "composer";
    if (current && current.li.isConnected && current.dirty()) return "edit";
    return "";
  }
  // Runs the callback now, or after the person agrees to throw away what is unsaved.
  function leave(proceed) {
    var what = unsaved();
    if (!what) { proceed(); return; }
    askGuard(what === "composer" ? "Throw away the note you are writing?" : "Throw away your changes to the note you are editing?",
      "Throw away", what === "composer" ? "Keep writing" : "Keep editing", proceed);
  }
  // Makes room for an edit or a remove on note li: refuses (with a sentence on that note) while
  // another edit has changes or the add form has text; otherwise closes whatever is open.
  function freeUp(li) {
    clearGuard();
    if (current && !current.li.isConnected) current = null;
    if (!composer.hidden && bodyEl.value.trim()) { flash(li, "Post or throw away the note you are writing first."); return false; }
    if (current) {
      if (current.dirty()) { flash(li, "Save or cancel the note you are editing first."); return false; }
      current.close();
      current = null;
    }
    if (!composer.hidden) closeComposer();
    clearGuard();
    return true;
  }
  function focusIn(root, sel, fallback) {
    var t = (root && root.querySelector(sel)) || fallback;
    if (t && !t.disabled && !t.hidden) t.focus();
  }
  function noteEl(id) { return wallEl.querySelector('[data-id="' + id + '"]'); }

  // ---------- times ----------

  var SYD = "Australia/Sydney";
  function sydDate(iso) {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: SYD });
  }
  // "11:20 am" when it was posted today; otherwise with the day in front ("Mon 12 Oct 9:10 am").
  function signedAt(iso) {
    var d = new Date(iso);
    var time = d.toLocaleTimeString("en-AU", { timeZone: SYD, hour: "numeric", minute: "2-digit" });
    if (data && sydDate(iso) === data.today) return time;
    return d.toLocaleDateString("en-AU", { timeZone: SYD, weekday: "short", day: "numeric", month: "short" }).replace(",", "") + " " + time;
  }

  function plusDays(date, n) {
    return new Date(Date.parse(date + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  }
  function dayLabel(date) {
    return new Date(date + "T00:00:00Z").toLocaleDateString("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).replace(",", "");
  }
  function shortDate(date) {
    return new Date(date + "T00:00:00Z").toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "short" });
  }

  function showMessage(text) {
    messageEl.textContent = text;
    messageEl.hidden = false;
    boardEl.hidden = true;
  }

  // ---------- the week and day pickers ----------

  var FORM_WEEKS = 13;   // this week and the twelve after it

  // Week options: this week and the weeks ahead, plus the note's own week if it falls outside.
  function weekOptions(select, selected) {
    select.replaceChildren();
    var weeks = [];
    for (var i = 0; i < FORM_WEEKS; i++) weeks.push(plusDays(data.thisWeek, 7 * i));
    if (selected && weeks.indexOf(selected) < 0) { weeks.push(selected); weeks.sort(); }
    weeks.forEach(function (w) {
      var tag = w === data.thisWeek ? " (this week)" : w === plusDays(data.thisWeek, 7) ? " (next week)" : "";
      var o = el("option", { value: w, text: "Week of " + shortDate(w) + tag });
      if (w === selected) o.selected = true;
      select.append(o);
    });
  }
  // Day options for a week: Any day, then Monday to Friday. `keep` is a weekday index 0-4 to keep, or -1.
  function dayOptions(select, week, keep) {
    select.replaceChildren(el("option", { value: "", text: "Any day" }));
    for (var i = 0; i < 5; i++) {
      var date = plusDays(week, i);
      var o = el("option", { value: date, text: dayLabel(date) });
      if (i === keep) o.selected = true;
      select.append(o);
    }
  }
  function dayIndex(week, date) {
    if (!date) return -1;
    return Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(week + "T00:00:00Z")) / 86400000);
  }

  // ---------- reacts: four small drawn marks, ink on the paper ----------

  var REACTS = [
    { kind: "up", label: "Thumbs up", mine: "Take back your thumbs up" },
    { kind: "down", label: "Thumbs down", mine: "Take back your thumbs down" },
    { kind: "laugh", label: "Laughing", mine: "Take back your laughing" },
    { kind: "sad", label: "Sad", mine: "Take back your sad" },
  ];
  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  // One mark: a 24 by 24 line drawing, no fill, one stroke weight, in the text colour.
  function reactMark(kind) {
    var svg = svgEl("svg", { "class": "nt-mark", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" });
    function p(d) { return svgEl("path", { d: d }); }
    if (kind === "up" || kind === "down") {
      var g = svgEl("g", kind === "down" ? { transform: "rotate(180 12 12)" } : {});
      g.append(p("M3.5 11H7v8.5H3.5z"), p("M7 11l4-7c1.6 0 2.5 1.1 2.5 2.5v3h5.3a1.8 1.8 0 0 1 1.8 2.2L19.3 18a2 2 0 0 1-2 1.5H7"));
      svg.append(g);
    } else {
      svg.append(svgEl("circle", { cx: "12", cy: "12", r: "9" }));
      if (kind === "laugh") {
        svg.append(p("M7.8 10.6q1-1.7 2-0"), p("M14.2 10.6q1-1.7 2-0"), p("M7.5 13.8h9a4.5 4.5 0 0 1-9 0z"));
      } else {
        svg.append(p("M9 10v1"), p("M15 10v1"), p("M8.5 16.6q3.5-3.4 7 0"), p("M16.6 12.6q0.9 1.2 0 2"));
      }
    }
    return svg;
  }

  // A person's name on a colour chip: their board worker colour (or a stable one from their id).
  function nameChip(name, hue) {
    var chip = el("span", { class: "nt-who", text: name });
    if (typeof hue === "number") {
      var c = hueColors(hue);
      chip.style.background = c.bg;
      chip.style.color = c.fg;
    }
    return chip;
  }

  function noteItem(n) {
    var li = el("article", { class: "nt-note", "data-id": n.id });
    if (n.dayName) li.append(el("div", { class: "nt-daytag", text: n.dayName }));
    li.append(el("p", { class: "nt-text", text: n.body }));
    var sign = el("div", { class: "nt-sign" });
    sign.append(nameChip(n.author.name, n.author.hue), " \u00b7 " + signedAt(n.createdAt));
    if (n.edited) sign.append(el("span", { class: "nt-edited", text: " (edited)" }));
    li.append(sign);
    var foot = el("div", { class: "nt-foot" });
    var anyReact = REACTS.some(function (r) { return n.reacts[r.kind].count > 0; });
    if (n.canReact || anyReact) foot.append(reactRow(li, n));
    if (n.canEdit) {
      var actions = el("div", { class: "nt-actions" });
      var edit = el("button", { type: "button", class: "hs-btn", text: "Edit" });
      var remove = el("button", { type: "button", class: "hs-btn", text: "Remove" });
      edit.addEventListener("click", function () { startEdit(li, n); });
      remove.addEventListener("click", function () { askRemove(li, n); });
      actions.append(edit, remove);
      foot.append(actions);
    }
    li.append(foot);
    var who = reactorList(n);
    if (who) li.append(who);
    return li;
  }

  // Names of who reacted, one line per react that has any.
  function reactorList(n) {
    var box = null;
    REACTS.forEach(function (r) {
      var info = n.reacts[r.kind];
      if (!info.count) return;
      if (!box) box = el("div", { class: "nt-reactors" });
      var line = el("div", { class: "nt-reactor-line" });
      line.append(reactMark(r.kind));
      line.firstChild.setAttribute("class", "nt-mark nt-mark-small");
      line.append(el("span", { class: "nt-sr", text: r.label + ": " }));
      info.people.forEach(function (p) { line.append(nameChip(p.name, p.hue), " "); });
      box.append(line);
    });
    return box;
  }

  // The four reacts: a count beside each mark. A react nobody has given shows faintly until the note
  // is hovered or focused. Your own note shows its marks but they do nothing.
  function reactRow(li, n) {
    var row = el("div", { class: "nt-reacts", role: "group", "aria-label": "Reacts" });
    REACTS.forEach(function (r) {
      var info = n.reacts[r.kind];
      var btn = el("button", {
        type: "button",
        class: "nt-ack nt-react" + (info.count ? "" : " nt-react-zero"),
        "data-kind": r.kind,
        "aria-pressed": n.canReact ? (info.mine ? "true" : "false") : false,
        "aria-label": !n.canReact ? r.label + " (you can't react to your own note)" : info.mine ? r.mine : "Give this note: " + r.label,
        title: !n.canReact ? "You can't react to your own note" : info.mine ? r.mine : r.label,
        disabled: !n.canReact,
      });
      btn.append(reactMark(r.kind));
      btn.append(el("span", { class: "nt-ack-count", text: info.count ? String(info.count) : "" }));
      if (n.canReact) {
        btn.addEventListener("click", async function () {
          btn.disabled = true;
          try {
            var saved = await api("/api/notes/" + n.id + "/react/" + r.kind, { method: info.mine ? "DELETE" : "PUT" });
            if (current && current.id === n.id) current = null;
            var fresh = noteItem(saved);
            li.replaceWith(fresh);
            focusIn(fresh, '.nt-react[data-kind="' + r.kind + '"]');
          } catch (e) {
            btn.disabled = false;
            btn.focus();
            flash(li, e.message);
          }
        });
      }
      row.append(btn);
    });
    return row;
  }

  function flash(li, text) {
    var old = li.querySelector(".nt-flash");
    if (old) old.remove();
    li.append(el("p", { class: "nt-edit-msg nt-flash", role: "alert", text: text }));
  }

  function startEdit(li, n) {
    if (current && current.id === n.id && current.li.isConnected) return;
    if (!freeUp(li)) return;
    var text = el("textarea", { class: "hs-input nt-body-input", rows: "4", maxlength: String(BODY_MAX), "aria-label": "Edit note" });
    text.value = n.body;
    var week = el("select", { class: "hs-input", "aria-label": "Week" });
    weekOptions(week, n.weekStart);
    var day = el("select", { class: "hs-input", "aria-label": "Day" });
    dayOptions(day, n.weekStart, dayIndex(n.weekStart, n.date));
    // Choosing another week keeps the same weekday tag (or no tag) in that week.
    week.addEventListener("change", function () {
      dayOptions(day, week.value, day.selectedIndex - 1);
    });
    var msg = el("span", { class: "nt-edit-msg", role: "alert" });
    var save = el("button", { type: "button", class: "hs-btn", text: "Save" });
    var cancel = el("button", { type: "button", class: "hs-btn", text: "Cancel" });
    var row = el("div", { class: "nt-edit-row" }, week, day, save, cancel, msg);
    li.replaceChildren(el("div", { class: "nt-edit" }, text, row));
    current = {
      id: n.id,
      li: li,
      dirty: function () { return text.value !== n.body || week.value !== n.weekStart || day.value !== (n.date || ""); },
      close: function () { li.replaceWith(noteItem(n)); },
    };
    text.focus();
    cancel.addEventListener("click", function () {
      current = null;
      var fresh = noteItem(n);
      li.replaceWith(fresh);
      focusIn(fresh, ".nt-actions .hs-btn");
    });
    save.addEventListener("click", async function () {
      msg.textContent = "";
      save.disabled = true;
      try {
        var saved = await api("/api/notes/" + n.id, {
          method: "PATCH",
          body: JSON.stringify({ body: text.value, week: week.value, date: day.value || null, updatedAt: n.updatedAt }),
        });
        current = null;
        await reloadFor(saved.weekStart);
        focusIn(noteEl(saved.id), ".nt-actions .hs-btn", addBtn);
      } catch (e) {
        msg.textContent = e.message;
        save.disabled = false;
      }
    });
  }

  function askRemove(li, n) {
    if (current && current.id === n.id && current.li.isConnected) return;
    if (!freeUp(li)) return;
    var sure = el("span", { class: "nt-sure", text: "Remove this note?" });
    var yes = el("button", { type: "button", class: "hs-btn", text: "Remove" });
    var keep = el("button", { type: "button", class: "hs-btn", text: "Keep" });
    var msg = el("span", { class: "nt-edit-msg", role: "alert" });
    var actions = li.querySelector(".nt-actions");
    actions.replaceChildren(sure, yes, keep, msg);
    current = {
      id: n.id,
      li: li,
      dirty: function () { return false; },
      close: function () { li.replaceWith(noteItem(n)); },
    };
    keep.focus();
    keep.addEventListener("click", function () {
      current = null;
      var fresh = noteItem(n);
      li.replaceWith(fresh);
      focusIn(fresh, ".nt-actions .hs-btn");
    });
    yes.addEventListener("click", async function () {
      yes.disabled = true;
      try {
        await api("/api/notes/" + n.id, { method: "DELETE" });
        current = null;
        await load(data.from);
        focusIn(wallEl, ".nt-new", addBtn);
      } catch (e) {
        msg.textContent = e.message;
        yes.disabled = false;
      }
    });
  }

  // ---------- the wall ----------

  function render() {
    $("weekHead").textContent = data.label;
    $("thisBtn").disabled = data.centred;
    current = null;   // the wall is redrawn, so nothing is open on it any more
    wallEl.replaceChildren();
    data.weeks.forEach(function (w) {
      var head = el("h2", { class: "nt-day-head" }, w.heading, el("span", { class: "nt-week-sub", text: w.sub }));
      var stack = el("div", { class: "nt-stack" });
      w.notes.forEach(function (n) { stack.append(noteItem(n)); });
      var col = el("section", { class: "nt-day" + (w.current ? " nt-day-today" : "") + (w.past ? " nt-past" : ""), "data-week": w.weekStart }, head, stack);
      if (w.canAdd) {
        var add = el("button", { type: "button", class: "nt-new", text: "+ New note" });
        add.addEventListener("click", function () { openComposer(w.weekStart); });
        col.append(add);
      } else if (!w.notes.length) {
        col.append(el("p", { class: "nt-none", text: "No notes" }));
      }
      wallEl.append(col);
    });
  }

  function urlFor(from) {
    return "?dept=" + encodeURIComponent(dept) + (from ? "&from=" + encodeURIComponent(from) : "");
  }

  // Loads five weeks starting at a Monday (none = this week centred) and draws them. `push` adds a
  // history entry; "replace" rewrites the current one. The address names the first week only when
  // the window has been moved off centre.
  async function load(from, push) {
    var q = "/api/notes?dept=" + encodeURIComponent(dept) + (from ? "&from=" + encodeURIComponent(from) : "");
    var d = await api(q);
    var changed = !data || data.from !== d.from;
    data = d;
    titleEl.textContent = d.deptLabel + " notes";
    document.title = d.deptLabel + " notes - Crosscuts";
    messageEl.hidden = true;
    boardEl.hidden = false;
    if (changed) closeComposer();
    clearGuard();
    render();
    var url = urlFor(d.centred ? "" : d.from);
    if (push === "push") history.pushState(null, "", url);
    else if (push === "replace") history.replaceState(null, "", url);
  }

  // After a save that put a note in another week: stay if that week is on screen, else centre on it.
  async function reloadFor(weekStart) {
    var shown = data.weeks.some(function (w) { return w.weekStart === weekStart; });
    if (shown) await load(data.from);
    else await load(plusDays(weekStart, -14), "push");
  }

  async function go(from, push) {
    try {
      await load(from, push);
    } catch (e) {
      messageEl.textContent = e.message;
      messageEl.hidden = false;
    }
  }

  $("lastBtn").addEventListener("click", function () { if (data) leave(function () { go(data.prev, "push"); }); });
  $("nextBtn").addEventListener("click", function () { if (data) leave(function () { go(data.next, "push"); }); });
  $("thisBtn").addEventListener("click", function () { if (data) leave(function () { go(null, "push"); }); });
  // The address names the first week (from=); an older address with week= centres on that week.
  function fromParam() {
    var q = new URLSearchParams(location.search);
    if (q.get("from")) return q.get("from");
    if (q.get("week")) return plusDays(q.get("week"), -14);
    return null;
  }
  window.addEventListener("popstate", function () {
    var f = fromParam();
    if (data && unsaved()) {
      // Put the address back and ask first; agreeing moves on as a fresh step.
      history.pushState(null, "", urlFor(data.centred ? "" : data.from));
      leave(function () { go(f, "push"); });
      return;
    }
    go(f);
  });

  // ---------- the add form ----------

  function updateCount() {
    var n = bodyEl.value.length;
    countEl.textContent = n ? n + " / " + BODY_MAX : "";
    countEl.className = "nt-count" + (n > BODY_MAX - 200 ? " nt-count-near" : "");
  }
  bodyEl.addEventListener("input", updateCount);

  function openComposer(week) {
    if (!data) return;
    if (current && !current.li.isConnected) current = null;
    if (current) {
      if (current.dirty()) { sayGuard("Save or cancel the note you are editing before you add a new one."); return; }
      current.close();
      current = null;
    }
    clearGuard();
    var pick = week && week >= data.thisWeek ? week : data.thisWeek;
    weekOptions(weekEl, pick);
    dayOptions(dayEl, pick, -1);
    errorEl.textContent = "";
    composer.hidden = false;
    composer.scrollIntoView({ block: "nearest" });
    bodyEl.focus();
  }
  weekEl.addEventListener("change", function () { dayOptions(dayEl, weekEl.value, dayEl.value ? dayEl.selectedIndex - 1 : -1); });
  function closeComposer(refocus) {
    composer.hidden = true;
    bodyEl.value = "";
    errorEl.textContent = "";
    updateCount();
    if (refocus === true && !addBtn.hidden) addBtn.focus();
  }

  addBtn.addEventListener("click", function () { if (composer.hidden) openComposer(); else bodyEl.focus(); });
  $("cancel").addEventListener("click", function () { closeComposer(true); });
  composer.addEventListener("keydown", function (e) { if (e.key === "Escape") closeComposer(true); });

  composer.addEventListener("submit", async function (e) {
    e.preventDefault();
    errorEl.textContent = "";
    if (current && current.li.isConnected) {
      errorEl.textContent = "Save or cancel the note you are editing first";
      return;
    }
    if (!bodyEl.value.trim()) {
      errorEl.textContent = "Write something to leave a note";
      bodyEl.focus();
      return;
    }
    postBtn.disabled = true;
    try {
      var saved = await api("/api/notes", {
        method: "POST",
        body: JSON.stringify({ dept: dept, week: weekEl.value, date: dayEl.value || null, body: bodyEl.value }),
      });
      closeComposer();
      await reloadFor(saved.weekStart);
      focusIn(noteEl(saved.id), ".nt-ack:not(:disabled)", addBtn);
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      postBtn.disabled = false;
    }
  });

  // A tab left open shows fresh notes (and the right "today") when it is next looked at.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || boardEl.hidden || (current && current.li.isConnected) || !composer.hidden) return;
    load(data.from).catch(function () {});
  });

  // ---------- start ----------

  (async function start() {
    if (!dept) {
      showMessage("Choose a department's Notes page from the menu.");
      return;
    }
    try {
      await load(fromParam(), "replace");
    } catch (e) {
      // 0.2.0: someone with design.view but not the Projects notes still gets the Projects
      // dashboard below (projectsdash.js), so the page just says so instead of refusing.
      if (/^Forbidden/.test(e.message) && dept === "design" && window.cc && window.cc.ready) {
        await window.cc.ready;
        if (window.cc.can("design.view")) {
          titleEl.textContent = "Projects";
          document.title = "Projects - Crosscuts";
          showMessage("The Projects notes are for the people in Projects. The Projects pages are below.");
          return;
        }
      }
      if (/^Forbidden/.test(e.message)) showMessage("These notes are only for the people in that department. You don't have access to them.");
      else if (/Unknown department/.test(e.message)) showMessage("There is no Notes page for that department. Choose one from the menu.");
      else if (/^from must be/.test(e.message)) {
        try { await load(null, "replace"); } catch (e2) { showMessage(e2.message); }
      } else showMessage(e.message);
    }
  })();
})();
