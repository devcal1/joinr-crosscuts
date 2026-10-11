(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);

  // Only same-origin absolute paths; never the login page itself.
  function safeNext() {
    var n = params.get("next") || "";
    if (n.charAt(0) !== "/" || n.charAt(1) === "/" || /[\u0000-\u001F\u007F\\]/.test(n)) return "/";
    var u;
    try { u = new URL(n, location.origin); } catch (e) { return "/"; }
    if (u.origin !== location.origin) return "/";
    n = u.pathname + u.search + u.hash;
    if (/^\/login\.html(\?|#|$)/i.test(n)) return "/";
    return n;
  }
  function go() { location.replace(safeNext()); }

  function call(method, path, body) {
    var opts = { method: method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      if (res.status === 204) return { status: 204, ok: true, data: {} };
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  var forms = ["form-login", "form-unlock", "form-change"];
  function show(id) {
    $("loading").hidden = true;
    forms.forEach(function (f) { $(f).hidden = f !== id; });
    var inputs = $(id).querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].type !== "checkbox" && !inputs[i].closest("[hidden]")) { inputs[i].focus(); break; }
    }
  }
  function setError(form, msg) { form.querySelector("[data-error]").textContent = msg || ""; }
  function busy(form, on) { form.querySelector("button[type=submit]").disabled = on; }

  function lockoutMessage(data) {
    var mins = Math.max(1, Math.ceil((data.retryAfterSec || 60) / 60));
    return "Too many failed attempts. Try again in about " + mins + " minute" + (mins === 1 ? "" : "s") + ".";
  }

  // ---- sign in
  var formLogin = $("form-login");
  var typedPassword = "";
  formLogin.addEventListener("submit", function (e) {
    e.preventDefault();
    setError(formLogin, "");
    busy(formLogin, true);
    typedPassword = $("login-password").value;
    call("POST", "/api/auth/login", {
      username: $("login-username").value.trim(),
      password: typedPassword,
      remember: $("login-remember").checked,
    }).then(function (r) {
      busy(formLogin, false);
      if (r.ok) return afterLogin(r.data.user);
      if (r.status === 429) return setError(formLogin, lockoutMessage(r.data));
      setError(formLogin, r.data.error || "Could not sign in");
    }).catch(function () {
      busy(formLogin, false);
      setError(formLogin, "Could not reach the server");
    });
  });

  function afterLogin(user) {
    if (user && user.mustChangePassword) {
      if (user.passwordReason === "expired") {
        $("change-why").textContent = "Your password is six months old. Pick a new one to continue.";
      }
      $("change-current").value = typedPassword;
      show("form-change");
      if (typedPassword) $("change-new").focus();
      return;
    }
    go();
  }

  // ---- forced password change
  var formChange = $("form-change");
  formChange.addEventListener("submit", function (e) {
    e.preventDefault();
    setError(formChange, "");
    var cur = $("change-current").value;
    var nw = $("change-new").value;
    if (nw.length < 8) return setError(formChange, "New password must be at least 8 characters");
    if (nw !== $("change-confirm").value) return setError(formChange, "The new passwords don't match");
    busy(formChange, true);
    call("POST", "/api/auth/password", { currentPassword: cur, newPassword: nw }).then(function (r) {
      busy(formChange, false);
      if (r.ok) return go();
      setError(formChange, r.status === 429 ? lockoutMessage(r.data) : (r.data.error || "Could not change password"));
    }).catch(function () {
      busy(formChange, false);
      setError(formChange, "Could not reach the server");
    });
  });

  // ---- unlock
  var formUnlock = $("form-unlock");
  var usePin = false;
  function setUnlockMode(pin) {
    usePin = pin;
    $("unlock-pin-wrap").hidden = !pin;
    $("unlock-password-wrap").hidden = pin;
    $("unlock-pin").required = pin;
    $("unlock-password").required = !pin;
    $("unlock-toggle").textContent = pin ? "Use password instead" : "Use PIN instead";
  }
  function showUnlock(status) {
    $("unlock-title").textContent = "Unlock as " + (status.user && status.user.displayName ? status.user.displayName : "user");
    var pinOk = !!status.pinAvailable;
    $("unlock-toggle").hidden = !pinOk;
    setUnlockMode(pinOk);
    show("form-unlock");
  }
  $("unlock-toggle").addEventListener("click", function (e) {
    e.preventDefault();
    setUnlockMode(!usePin);
    setError(formUnlock, "");
    (usePin ? $("unlock-pin") : $("unlock-password")).focus();
  });
  $("unlock-signout").addEventListener("click", function (e) {
    e.preventDefault();
    call("POST", "/api/auth/logout").then(done, done);
    function done() {
      var n = params.get("next");
      location.replace("/login.html" + (n ? "?next=" + encodeURIComponent(n) : ""));
    }
  });
  formUnlock.addEventListener("submit", function (e) {
    e.preventDefault();
    setError(formUnlock, "");
    busy(formUnlock, true);
    var body = usePin ? { pin: $("unlock-pin").value } : { password: $("unlock-password").value };
    call("POST", "/api/auth/unlock", body).then(function (r) {
      busy(formUnlock, false);
      if (r.ok) return go();
      if (r.status === 429) return setError(formUnlock, lockoutMessage(r.data));
      if (usePin && r.data.pinAvailable === false) {
        $("unlock-toggle").hidden = true;
        setUnlockMode(false);
        $("unlock-password").focus();
        return setError(formUnlock, (r.data.error || "PIN refused") + " Use your password instead.");
      }
      setError(formUnlock, r.data.error || "Could not unlock");
      $("unlock-pin").value = "";
      $("unlock-password").value = "";
    }).catch(function () {
      busy(formUnlock, false);
      setError(formUnlock, "Could not reach the server");
    });
  });

  // ---- start
  call("GET", "/api/auth/status").then(function (r) {
    var s = r.data || {};
    if (s.setupNeeded) return location.replace("/setup.html");
    if (s.locked) return showUnlock(s);
    if (s.loggedIn) {
      // Already signed in: still honour a pending forced password change.
      return call("GET", "/api/auth/me").then(function (me) {
        if (me.ok && me.data.user.mustChangePassword) return afterLogin(me.data.user);
        go();
      });
    }
    show("form-login");
  }).catch(function () {
    $("loading").textContent = "Could not reach the server. Reload to try again.";
  });
})();
