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
// Busy has two reasons, and the pointer is the dot while either holds:
//   nav   a same-tab link to another page of this site was clicked, a form submitted, or the page is
//         unloading. Cleared by pageshow (back/forward cache), by a prompt that kept the user here
//         (beforeunload with preventDefault), or by the 20 s safety timeout.
//   load  the new page, from the start of parsing until DOMContentLoaded, the shell is ready (when
//         the page has one) and no fetch the page started during that time is still in flight, held
//         for a quiet 250 ms (a page's chained requests). After that the load phase is over for good:
//         later fetches (saves, the board's 5-minute reload, message polls, the alerts count) never
//         set busy. A fetch can also opt out inside the load phase with { ccBackground: true }.
// Nothing here changes layout, print or exportJpg(): the cursor is not drawn in any of them.
(function () {
  "use strict";
  if (window.ccBusy) return;

  var SAFETY_MS = 20000;   // busy can never stick longer than this
  var QUIET_MS = 250;      // no fetch in flight for this long ends the load phase
  var PULSE_MS = 110;      // frame step
  var FRAMES = [1, 2, 3, 4, 3, 2]; // 3 is the still frame (no class)

  var root = document.documentElement;
  var reasons = { nav: false, load: false };
  var loadPhase = true;
  var inflight = 0;
  var domReady = document.readyState !== "loading";
  var shellReady = false;
  var settleTimer = null, safetyTimer = null, pulseTimer = null, frame = 0;
  // Reduced motion: the still dot, no timer.
  function reduced() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
  }

  function isBusy() { return reasons.nav || reasons.load; }

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
    loadPhase = false;
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

  // ---------- fetch counting (load phase only) ----------
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      if (!loadPhase || (init && init.ccBackground)) return origFetch.apply(this, arguments);
      inflight++;
      var done = function () { inflight--; poke(); };
      var p;
      try { p = origFetch.apply(this, arguments); } catch (e) { done(); throw e; }
      p.then(done, done);
      return p;
    };
  }

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
    reasons: function () { return { nav: reasons.nav, load: reasons.load }; },
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
