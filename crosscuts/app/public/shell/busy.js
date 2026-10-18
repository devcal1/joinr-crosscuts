// Crosscuts loading cursor (seventh named exception in CLAUDE.md, Todd 2026-10-18).
//
//   <script src="/shell/busy.js"></script>     (in <head> of every page, the three without the
//                                               menu bar too; shell.js loads it if a page lacks it)
//
// While a page is loading, or after a link or form is used and the next page is awaited, the mouse
// pointer is the Joinr dot, gently pulsing. This script only toggles classes on <html>:
//   cc-busy          the pointer is the dot (rules and the four dot images: shell.css, cursor-dot-N.svg)
//   cc-f1 .. cc-f4   which frame of the pulse (no class = the still frame, also used for reduced motion)
//
// Busy has three reasons, and the pointer is the dot while any holds:
//   nav   a same-tab link to another page of this site was clicked, a form submitted, or the page is
//         unloading. Cleared by pageshow (back/forward cache), by a prompt that kept the user here
//         (beforeunload with preventDefault), or by the 20 s safety timeout.
//   load  the new page, from the start of parsing until DOMContentLoaded, the shell is ready (when
//         the page has one) and no fetch the page started during that time is still in flight, held
//         for a quiet 250 ms (a page's chained requests). After that the load phase is over for good:
//         later fetches (saves, the board's 5-minute reload, message polls, the alerts count) never
//         set busy by themselves. A fetch can also opt out with { ccBackground: true }.
//   act   (added 2026-10-18, Todd) an action the user started on an open page is in progress: a
//         fetch (or XMLHttpRequest, for uploads) that begins within 1 s of a user gesture (pointerdown,
//         pointerup, click, Enter or Space, submit, change of a form control), still in flight after
//         300 ms (quick saves never flicker it). Cleared when all such requests have finished. The
//         page stays fully usable: no pointer blocking. Timers (the board's 5-minute reload, polls)
//         do not follow a gesture, so they do not count; the shell's own polls are also flagged
//         { ccBackground: true }, and so can page code that wants to opt out.
// Nothing here changes layout, print or exportJpg(): the cursor is not drawn in any of them.
(function () {
  "use strict";
  if (window.ccBusy) return;

  var SAFETY_MS = 20000;   // busy can never stick longer than this
  var GESTURE_MS = 1000;   // a request starting within this of a user gesture is the user's action
  var ACT_DELAY_MS = 300;  // ...and shows the dot only if still running after this
  var CHAIN_MS = 150;      // a follow-up request this soon after an action's request ended is part of it
  var QUIET_MS = 250;      // no fetch in flight for this long ends the load phase
  var PULSE_MS = 110;      // frame step
  var FRAMES = [1, 2, 3, 4, 3, 2]; // 3 is the still frame (no class)

  var root = document.documentElement;
  var reasons = { nav: false, load: false, act: false };
  var lastGesture = -1e9, lastActEnd = -1e9, actInflight = 0, actEpoch = 0, actTimer = null;
  var loadPhase = true;
  var inflight = 0;
  var domReady = document.readyState !== "loading";
  var shellReady = false;
  var settleTimer = null, safetyTimer = null, pulseTimer = null, frame = 0;
  // Reduced motion: the still dot, no timer.
  function reduced() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
  }

  function isBusy() { return reasons.nav || reasons.load || reasons.act; }

  function setFrame(i) {
    var n = FRAMES[i % FRAMES.length];
    root.classList.remove("cc-f1", "cc-f2", "cc-f4");
    if (n !== 3) root.classList.add("cc-f" + n);
  }
  function startPulse() {
    if (pulseTimer || reduced()) return;
    frame = 0;
    setFrame(frame);
    pulseTimer = setInterval(function () { frame = (frame + 1) % FRAMES.length; setFrame(frame); }, PULSE_MS);
  }
  function stopPulse() {
    if (pulseTimer) clearInterval(pulseTimer);
    pulseTimer = null;
    root.classList.remove("cc-f1", "cc-f2", "cc-f4");
  }
  function apply() {
    if (isBusy()) {
      if (!root.classList.contains("cc-busy")) {
        root.classList.add("cc-busy");
        clearTimeout(safetyTimer);
        safetyTimer = setTimeout(clearAll, SAFETY_MS);
      }
      startPulse();
    } else {
      root.classList.remove("cc-busy");
      clearTimeout(safetyTimer);
      safetyTimer = null;
      stopPulse();
    }
  }
  function clearAll() {
    reasons.nav = false;
    reasons.load = false;
    reasons.act = false;
    loadPhase = false;
    actEpoch++;
    actInflight = 0;
    clearTimeout(actTimer);
    actTimer = null;
    clearTimeout(settleTimer);
    apply();
  }
  function setReason(name, on) {
    if (reasons[name] === on) return;
    reasons[name] = on;
    apply();
  }

  // ---------- the load phase ----------
  function needsShell() { return !!document.getElementById("cc-shell"); }
  function settle() {
    if (!loadPhase) return;
    if (!domReady || inflight > 0) return;
    if (needsShell() && !shellReady) return;
    loadPhase = false;
    setReason("load", false);
  }
  function poke() {
    if (!loadPhase) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, QUIET_MS);
  }

  // ---------- user actions on an open page ----------
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function gesture() { lastGesture = now(); }
  ["pointerdown", "pointerup", "click", "submit"].forEach(function (t) {
    document.addEventListener(t, gesture, true);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") gesture();
  }, true);
  document.addEventListener("change", function (e) {
    var el = e.target, n = el && el.tagName;
    if (n === "INPUT" || n === "SELECT" || n === "TEXTAREA") gesture();
  }, true);

  // Returns a function to call when the request ends, or null when it is not the user's action.
  function trackAct() {
    var t = now();
    if (!(t - lastGesture <= GESTURE_MS || actInflight > 0 || t - lastActEnd <= CHAIN_MS)) return null;
    var epoch = actEpoch;
    actInflight++;
    if (!reasons.act && !actTimer) {
      actTimer = setTimeout(function () {
        actTimer = null;
        if (actInflight > 0) setReason("act", true);
      }, ACT_DELAY_MS);
    }
    var ended = false;
    return function () {
      if (ended || epoch !== actEpoch) return;
      ended = true;
      actInflight--;
      lastActEnd = now();
      if (actInflight <= 0) {
        actInflight = 0;
        clearTimeout(actTimer);
        actTimer = null;
        setReason("act", false);
      }
    };
  }

  // ---------- fetch counting ----------
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      if (init && init.ccBackground) return origFetch.apply(this, arguments);
      var done, p;
      if (loadPhase) {
        inflight++;
        done = function () { inflight--; poke(); };
      } else {
        done = trackAct();
        if (!done) return origFetch.apply(this, arguments);
      }
      try { p = origFetch.apply(this, arguments); } catch (e) { done(); throw e; }
      p.then(done, done);
      return p;
    };
  }
  // Uploads with progress use XMLHttpRequest: counted as a user action the same way (never in the
  // load phase). Set xhr.ccBackground = true before send() to opt out.
  try {
    var xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      if (!loadPhase && !this.ccBackground) {
        var done = trackAct();
        if (done) this.addEventListener("loadend", done);
      }
      return xhrSend.apply(this, arguments);
    };
  } catch (e) { /* no XHR */ }

  // ---------- navigation ----------
  function isPageLink(a) {
    if (!a || !a.getAttribute("href")) return false;
    if (a.hasAttribute("download")) return false;
    var t = (a.getAttribute("target") || "").toLowerCase();
    if (t && t !== "_self") return false;
    var u;
    try { u = new URL(a.href, location.href); } catch (e) { return false; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.origin !== location.origin) return false;
    // Only the app's own pages: not files, images or /api downloads, which leave the page in place.
    if (u.pathname !== "/" && !/\.html?$/i.test(u.pathname)) return false;
    // A link to a place on this very page (#anchor, or the same address) goes nowhere.
    if (u.pathname === location.pathname && u.search === location.search) return false;
    return true;
  }
  function startNavIfNotPrevented(e) {
    // Page code may cancel a click or submit; decide after every handler has run.
    setTimeout(function () { if (!e.defaultPrevented) setReason("nav", true); }, 0);
  }
  document.addEventListener("click", function (e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var el = e.target;
    var a = el && el.closest ? el.closest("a[href]") : null;
    if (!isPageLink(a)) return;
    startNavIfNotPrevented(e);
  }, true);
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || f.tagName !== "FORM") return;
    var sub = e.submitter;
    var method = String((sub && sub.getAttribute("formmethod")) || f.getAttribute("method") || "get").toLowerCase();
    if (method === "dialog") return;
    var t = String((sub && sub.getAttribute("formtarget")) || f.getAttribute("target") || "").toLowerCase();
    if (t && t !== "_self") return;
    startNavIfNotPrevented(e);
  }, true);
  window.addEventListener("beforeunload", function (e) {
    setReason("nav", true);
    // A page's "leave this page?" prompt that the user answers Stay to: we are still here.
    setTimeout(function () {
      if (e.defaultPrevented || (e.returnValue !== undefined && e.returnValue !== "" && e.returnValue !== true)) setReason("nav", false);
    }, 0);
  });
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) {
      // Restored from the back/forward cache: nothing is loading.
      clearAll();
    }
  });

  // ---------- start ----------
  document.addEventListener("cc:ready", function () { shellReady = true; poke(); });
  if (window.cc && window.cc.__shell) {
    // shell.js loaded us late, after cc:ready may have fired: its promise tells us.
    if (window.cc.ready && window.cc.ready.then) window.cc.ready.then(function () { shellReady = true; poke(); });
  }
  if (!domReady) document.addEventListener("DOMContentLoaded", function () { domReady = true; poke(); });
  else poke();

  // The cursor rules live in shell.css. Pages load it from shell.js, late, and the three without
  // the menu bar never did, so make sure it is requested now, from the head.
  try {
    var hasCss = Array.prototype.some.call(document.querySelectorAll("link[rel=stylesheet]"), function (l) {
      return /(^|\/)shell\/shell\.css$/.test(l.getAttribute("href") || "");
    });
    if (!hasCss) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/shell/shell.css";
      (document.head || root).appendChild(link);
    }
  } catch (err) { /* the pointer falls back to the browser default */ }

  // Busy from the first line of the page: the pointer is already the dot while it is parsed.
  reasons.load = true;
  apply();

  window.ccBusy = {
    isBusy: isBusy,
    reasons: function () { return { nav: reasons.nav, load: reasons.load, act: reasons.act }; },
    actInflight: function () { return actInflight; },
    inflight: function () { return inflight; },
    timerActive: function () { return !!pulseTimer; },
    loadPhase: function () { return loadPhase; },
    reduced: reduced,
    // For tests and page code that wants to show the cursor itself.
    isPageLink: isPageLink,
    on: function () { setReason("nav", true); },
    off: clearAll,
  };
})();
