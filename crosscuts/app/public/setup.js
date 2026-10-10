(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var form = $("form-setup");
  var errorEl = form.querySelector("[data-error]");
  var button = form.querySelector("button[type=submit]");

  function call(method, path, body) {
    var opts = { method: method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  call("GET", "/api/auth/status").then(function (r) {
    if (!r.data.setupNeeded) return location.replace("/login.html");
    $("loading").hidden = true;
    form.hidden = false;
    $("setup-username").focus();
  }).catch(function () {
    $("loading").textContent = "Could not reach the server. Reload to try again.";
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorEl.textContent = "";
    var password = $("setup-password").value;
    if (password.length < 8) { errorEl.textContent = "Password must be at least 8 characters"; return; }
    if (password !== $("setup-confirm").value) { errorEl.textContent = "The passwords don't match"; return; }
    button.disabled = true;
    call("POST", "/api/auth/setup", {
      username: $("setup-username").value.trim(),
      displayName: $("setup-display").value.trim(),
      password: password,
    }).then(function (r) {
      if (r.ok) return location.replace("/");
      button.disabled = false;
      if (r.status === 404) return location.replace("/login.html");
      errorEl.textContent = r.data.error || "Could not create the administrator";
    }).catch(function () {
      button.disabled = false;
      errorEl.textContent = "Could not reach the server";
    });
  });
})();
