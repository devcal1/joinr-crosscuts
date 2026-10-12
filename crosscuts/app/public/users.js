(function () {
  // api(), toast(), guarded() come from /shared.js, loaded before this file.
  const $ = (id) => document.getElementById(id);

  const ROLE_LABELS = {
    admin: "Admin",
    accounts: "Accounts",
    design_pm: "Design / PM",
    scheduling: "Scheduling",
    showroom: "Showroom",
    workshop: "Workshop",
    ordering: "Ordering",
    workshop_manager: "Workshop Manager",
  };

  let meta = { roles: [], keys: [], presets: {} };
  let users = [];
  let selectedId = null;
  let myId = null; // best effort, from /api/auth/me; stays null if unavailable

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const roleLabel = (r) => ROLE_LABELS[r] || r;
  const selected = () => users.find((u) => u.id === selectedId) || null;

  function fmtDate(iso) {
    if (!iso) return "Never";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString("en-AU", {
      timeZone: "Australia/Sydney",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  // Keys the given roles hand out, before any override.
  function presetKeys(roles) {
    const s = new Set();
    for (const r of roles) for (const k of meta.presets[r] || []) s.add(k);
    return s;
  }

  function roleChecks(container, checked) {
    container.innerHTML = "";
    for (const role of meta.roles) {
      const cb = h("input", { type: "checkbox", value: role });
      cb.checked = checked.includes(role);
      container.append(h("label", {}, cb, roleLabel(role)));
    }
  }

  const checkedRoles = (container) =>
    [...container.querySelectorAll("input:checked")].map((cb) => cb.value);

  // --- Loading ---

  async function load() {
    users = await api("/api/users");
    renderTable();
    renderDetail();
  }

  // Replace one user in place from an API response, then redraw.
  function applyUser(u, resetForm) {
    const i = users.findIndex((x) => x.id === u.id);
    if (i >= 0) users[i] = u;
    else users.push(u);
    renderTable();
    renderDetail(resetForm);
  }

  // --- Table ---

  function renderTable() {
    const body = $("userRows");
    body.innerHTML = "";
    $("emptyMsg").hidden = users.length > 0;
    $("userTable").hidden = users.length === 0;
    for (const u of users) {
      const tr = h("tr", { class: (u.id === selectedId ? "selected " : "") + (u.disabled ? "is-disabled" : "") });
      tr.addEventListener("click", () => select(u.id));
      const nameBtn = h("a", { class: "user-name", href: "#", text: u.displayName });
      nameBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        select(u.id);
      });
      tr.append(
        h("td", {}, nameBtn),
        h("td", { text: u.username }),
        h(
          "td",
          { class: "roles" },
          u.roles.length ? u.roles.map((r) => h("span", { class: "hs-pill hs-pill-na", text: roleLabel(r) })) : h("span", { class: "text-muted", text: "none" }),
          u.overrides.length ? h("span", { class: "hs-pill hs-pill-check", text: `${u.overrides.length} override${u.overrides.length === 1 ? "" : "s"}` }) : null
        ),
        h(
          "td",
          {},
          u.disabled ? h("span", { class: "hs-badge hs-badge-stop", text: "Disabled" }) : h("span", { class: "hs-badge hs-badge-go", text: "Active" }),
          u.mustChangePassword ? h("span", { class: "hs-badge hs-badge-check", text: "Must change password" }) : null
        ),
        h("td", { text: fmtDate(u.lastLoginAt) }),
        h("td", { class: "num", text: String(u.activeSessions) })
      );
      body.append(tr);
    }
  }

  function select(id) {
    selectedId = id;
    renderTable();
    renderDetail();
    $("detail").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // --- Detail panel ---

  function renderDetail(resetForm) {
    const u = selected();
    $("detail").hidden = !u;
    if (!u) return;
    const self = myId !== null && u.id === myId;

    $("detailTitle").textContent = `${u.displayName} (${u.username})${self ? " - you" : ""}`;
    // Reset the edit form only when switching user or after a profile save, so
    // changing an override doesn't wipe a half-typed name or unsaved role ticks.
    if (resetForm || $("detail").dataset.forUser !== String(u.id)) {
      $("detail").dataset.forUser = String(u.id);
      $("editDisplayName").value = u.displayName;
      $("resetPassword").value = "";
      roleChecks($("editRoles"), u.roles);
    }

    const tog = $("toggleDisabled");
    tog.textContent = u.disabled ? "Enable account" : "Disable account";
    tog.classList.toggle("hs-btn-stop", !u.disabled);
    tog.disabled = self && !u.disabled;
    tog.title = self && !u.disabled ? "You can't disable your own account" : "";

    $("signOutAll").textContent = `Sign out everywhere (${u.activeSessions})`;

    renderOverrides(u);
    renderEffective(u);
  }

  function renderOverrides(u) {
    const preset = presetKeys(u.roles);
    const effective = new Set(u.perms);
    const byKey = new Map(u.overrides.map((o) => [o.key, o.effect]));
    const list = $("overrideList");
    list.innerHTML = "";
    for (const key of meta.keys) {
      const cur = byKey.get(key) || "default";
      const inPreset = preset.has(key);
      const seg = h("div", { class: "seg", role: "group", "aria-label": `Override for ${key}` });
      for (const [v, label] of [["default", "Default"], ["grant", "Grant"], ["revoke", "Revoke"]]) {
        seg.append(
          h("button", { type: "button", "data-v": v, "aria-pressed": String(cur === v), text: label, onclick: () => setOverride(u, key, v, cur) })
        );
      }
      const on = effective.has(key);
      list.append(
        h(
          "div",
          { class: "ov-row" },
          h("div", { class: "ov-key" }, key, h("small", { text: inPreset ? "from role" : "not in role" })),
          seg,
          h("div", { class: "ov-eff " + (on ? "on" : "off"), text: on ? "allowed" : "denied" })
        )
      );
    }
  }

  function renderEffective(u) {
    const preset = presetKeys(u.roles);
    $("effectiveCount").textContent = `(${u.perms.length} of ${meta.keys.length})`;
    const box = $("effectiveChips");
    box.innerHTML = "";
    if (!u.perms.length) box.append(h("span", { class: "text-muted", text: "No permissions." }));
    for (const k of u.perms) box.append(h("span", { class: "chip hs-pill " + (preset.has(k) ? "hs-pill-na" : "granted"), text: k, title: preset.has(k) ? "From role" : "Granted by override" }));
  }

  // --- Actions ---

  const setOverride = guarded(async (u, key, value, current) => {
    if (value === current) return;
    const path = `/api/users/${u.id}/overrides/${encodeURIComponent(key)}`;
    const updated =
      value === "default"
        ? await api(path, { method: "DELETE" })
        : await api(path, { method: "PUT", body: JSON.stringify({ effect: value }) });
    applyUser(updated);
  });

  $("saveProfile").addEventListener(
    "click",
    guarded(async () => {
      const u = selected();
      if (!u) return;
      const displayName = $("editDisplayName").value.trim();
      const roles = checkedRoles($("editRoles"));
      const body = {};
      if (displayName !== u.displayName) body.displayName = displayName;
      if (roles.slice().sort().join() !== u.roles.slice().sort().join()) body.roles = roles;
      if (!Object.keys(body).length) return toast("Nothing to save");
      applyUser(await api(`/api/users/${u.id}`, { method: "PATCH", body: JSON.stringify(body) }), true);
      toast("Saved");
    })
  );

  $("toggleDisabled").addEventListener(
    "click",
    guarded(async () => {
      const u = selected();
      if (!u) return;
      if (!u.disabled && !confirm(`Disable ${u.displayName}? They'll be signed out everywhere and can't sign in.`)) return;
      applyUser(await api(`/api/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ disabled: !u.disabled }) }), true);
      toast(u.disabled ? "Account enabled" : "Account disabled");
    })
  );

  $("signOutAll").addEventListener(
    "click",
    guarded(async () => {
      const u = selected();
      if (!u) return;
      if (!confirm(`Sign ${u.displayName} out of every device?`)) return;
      await api(`/api/users/${u.id}/sessions/revoke`, { method: "POST" });
      toast("Signed out everywhere");
      await load();
    })
  );

  $("resetBtn").addEventListener(
    "click",
    guarded(async () => {
      const u = selected();
      if (!u) return;
      const password = $("resetPassword").value;
      if (password.length < 8) return toast("Password must be at least 8 characters");
      if (!confirm(`Reset ${u.displayName}'s password? They'll be signed out everywhere.`)) return;
      await api(`/api/users/${u.id}/password`, { method: "POST", body: JSON.stringify({ password }) });
      $("resetPassword").value = "";
      toast("Password reset. They must change it at next sign-in.");
      await load();
    })
  );

  $("detailClose").addEventListener("click", () => {
    selectedId = null;
    delete $("detail").dataset.forUser;
    renderTable();
    renderDetail();
  });

  // --- Add user ---

  function openAdd(open) {
    $("addForm").hidden = !open;
    if (open) {
      roleChecks($("newRoles"), []);
      $("newUsername").focus();
    } else {
      $("addForm").reset();
    }
  }
  $("addToggle").addEventListener("click", () => openAdd($("addForm").hidden));
  $("addCancel").addEventListener("click", () => openAdd(false));

  $("addForm").addEventListener(
    "submit",
    guarded(async (e) => {
      e.preventDefault();
      const body = {
        username: $("newUsername").value.trim().toLowerCase(),
        displayName: $("newDisplayName").value.trim(),
        password: $("newPassword").value,
        roles: checkedRoles($("newRoles")),
      };
      const created = await api("/api/users", { method: "POST", body: JSON.stringify(body) });
      openAdd(false);
      toast(`Created ${created.displayName}`);
      await load();
      select(created.id);
    })
  );

  // --- Business details and invoicing ---

  const TEXT_FIELDS = {
    tradingName: "setTradingName",
    legalName: "setLegalName",
    abn: "setAbn",
    address: "setAddress",
    phone: "setPhone",
    email: "setEmail",
    bankAccountName: "setBankAccountName",
    bsb: "setBsb",
    accountNumber: "setAccountNumber",
  };
  const NUMBERING = ["setPrefix", "setNextNumber", "setPad"];
  let numberLocked = false;

  function showSettingsError(msg) {
    $("settingsError").textContent = msg || "";
    $("settingsError").hidden = !msg;
  }

  function fillSettings(s) {
    for (const [field, id] of Object.entries(TEXT_FIELDS)) $(id).value = s.business[field] || "";
    $("setTermsText").value = s.invoice.termsText || "";
    $("setPrefix").value = s.invoice.prefix;
    $("setNextNumber").value = s.invoice.nextNumber;
    $("setPad").value = s.invoice.pad;
    $("setDefaultDays").value = s.invoice.defaultDays;
    numberLocked = !!s.invoice.numberLocked;
    for (const id of NUMBERING) $(id).disabled = numberLocked;
    $("setLockNote").hidden = !numberLocked;
  }

  // Whole-number fields: "" or a non-integer is a mistake the person should see, not a silent skip.
  function intField(id, label) {
    const raw = $(id).value.trim();
    if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a whole number`);
    return Number(raw);
  }

  async function loadSettings() {
    fillSettings(await api("/api/settings"));
  }

  $("settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    showSettingsError("");
    const btn = $("settingsSave");
    btn.disabled = true;
    try {
      const business = {};
      for (const [field, id] of Object.entries(TEXT_FIELDS)) business[field] = $(id).value;
      const invoice = { termsText: $("setTermsText").value, defaultDays: intField("setDefaultDays", "Default days to pay") };
      // Locked numbering is left out of the request; the server would also accept the unchanged values.
      if (!numberLocked) {
        invoice.prefix = $("setPrefix").value;
        invoice.nextNumber = intField("setNextNumber", "Next number");
        invoice.pad = intField("setPad", "Number padding");
      }
      fillSettings(await api("/api/settings", { method: "PUT", body: JSON.stringify({ business, invoice }) }));
      toast("Saved");
    } catch (err) {
      showSettingsError(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("roundupBtn").addEventListener(
    "click",
    guarded(async () => {
      if (!confirm("Send the invoice round-up now to everyone who can edit invoices?")) return;
      const r = await api("/api/notifications/roundup/run", { method: "POST" });
      toast(r && r.sent > 0 ? `Round-up sent to ${r.sent} ${r.sent === 1 ? "person" : "people"}` : "Nothing to report");
    })
  );

  guarded(loadSettings)();

  // --- Joinr connection ---

  const JOINR_DEFAULT_URL = "https://app.joinr.com.au";
  const JOINR_URL_HINT =
    "Leave empty to use the standard address. Changing the address removes the saved key; enter the key for the new address.";
  let joinrKeyFromEnv = false;
  let joinrUrlFromEnv = false;

  function showJoinrError(msg) {
    $("joinrError").textContent = msg || "";
    $("joinrError").hidden = !msg;
  }

  function showJoinrResult(msg, ok) {
    const el = $("joinrTestResult");
    el.textContent = msg || "";
    el.className = "joinr-result" + (msg ? (ok ? " ok" : " bad") : "");
    el.hidden = !msg;
  }

  function renderJoinrStatus(s) {
    const el = $("joinrStatus");
    el.textContent = "";
    if (!s || !s.configured) {
      el.textContent = "Not connected: no API key is set.";
      return;
    }
    let line = s.lastRunAt ? `Last checked ${fmtDate(s.lastRunAt)}` : "Not checked yet";
    if (s.lastOkAt) line += `. Last successful check ${fmtDate(s.lastOkAt)}`;
    el.append(line + ".");
    if (s.lastError) {
      el.append(h("span", { class: "joinr-err", text: `Last error${s.lastErrorAt ? ` (${fmtDate(s.lastErrorAt)})` : ""}: ${s.lastError}` }));
    }
  }

  function fillJoinr(s) {
    // The standard address shows as the placeholder, not as a value to edit.
    $("joinrUrl").value = s.baseUrl && s.baseUrl !== JOINR_DEFAULT_URL ? s.baseUrl : "";
    $("joinrKey").value = "";
    joinrUrlFromEnv = !!s.baseUrlFromEnv;
    $("joinrUrl").disabled = joinrUrlFromEnv;
    $("joinrUrlHint").textContent = joinrUrlFromEnv
      ? `Set by the server's environment (JOINR_BASE_URL)${s.baseUrl ? `: ${s.baseUrl}` : ""}. Change it there.`
      : JOINR_URL_HINT;
    joinrKeyFromEnv = !!(s.key && s.key.fromEnv);
    const configured = !!(s.key && s.key.configured);
    $("joinrKeyHint").textContent = configured
      ? `Set, ending ••••${s.key.last4 || ""}${joinrKeyFromEnv ? " (set by the server's environment)" : ""}`
      : "Not set";
    $("joinrKey").placeholder = configured ? "Enter a new key to replace it" : "Paste the key from Joinr";
    $("joinrKey").disabled = joinrKeyFromEnv;
    $("joinrRemove").hidden = !configured || joinrKeyFromEnv;
    $("joinrTest").disabled = !configured;
    $("joinrImport").disabled = !configured;
    renderJoinrStatus(s.sync);
  }

  async function loadJoinr() {
    fillJoinr(await api("/api/joinr/settings"));
  }

  $("joinrSave").addEventListener("click", async () => {
    showJoinrError("");
    showJoinrResult("");
    const btn = $("joinrSave");
    btn.disabled = true;
    try {
      // An address set by the environment is not sent (the field is disabled).
      const body = joinrUrlFromEnv ? {} : { baseUrl: $("joinrUrl").value.trim() };
      const key = $("joinrKey").value.trim();
      if (key) body.apiKey = key;
      fillJoinr(await api("/api/joinr/settings", { method: "PUT", body: JSON.stringify(body) }));
      toast("Saved");
    } catch (err) {
      showJoinrError(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("joinrTest").addEventListener(
    "click",
    guarded(async () => {
      showJoinrError("");
      if ($("joinrKey").value.trim()) {
        showJoinrResult("Save the new key first; the test uses what is saved.", false);
        return;
      }
      showJoinrResult("Testing...", true);
      const btn = $("joinrTest");
      btn.disabled = true;
      try {
        const r = await api("/api/joinr/test", { method: "POST" });
        showJoinrResult(r.ok ? `Connection OK. Joinr is at position ${r.cursor}.` : `Failed: ${r.error}`, r.ok);
      } catch (err) {
        showJoinrResult("");
        throw err;
      } finally {
        btn.disabled = false;
      }
    })
  );

  $("joinrRemove").addEventListener(
    "click",
    guarded(async () => {
      if (!confirm("Remove the Joinr API key? New won quotes will stop arriving until a key is set again.")) return;
      showJoinrError("");
      showJoinrResult("");
      fillJoinr(await api("/api/joinr/settings/key", { method: "DELETE" }));
      toast("Key removed");
    })
  );

  $("joinrImport").addEventListener(
    "click",
    guarded(async () => {
      if (!confirm("Import every quote that is currently won in Joinr into the New from Joinr page? Quotes already there are not duplicated.")) return;
      showJoinrError("");
      showJoinrResult("Importing...", true);
      const btn = $("joinrImport");
      btn.disabled = true;
      try {
        const r = await api("/api/joinr/import", { method: "POST" });
        if (r && r.ok && r.truncated) {
          // Stopped at the page limit: what came in is kept; running it again continues.
          showJoinrResult(`Imported ${r.items} ${r.items === 1 ? "item" : "items"}. ${r.message || "Stopped early; run it again to continue."}`, false);
        } else if (r && r.ok) {
          showJoinrResult(`Import finished: ${r.items} ${r.items === 1 ? "item" : "items"}.`, true);
        } else {
          showJoinrResult(`Import failed: ${(r && r.error) || "unknown error"}`, false);
        }
        await loadJoinr();
      } catch (err) {
        // The server's own message (for example "Not built") is the useful part.
        showJoinrResult(`Import failed: ${err.message}`, false);
      } finally {
        btn.disabled = false;
      }
    })
  );

  guarded(loadJoinr)();

  // --- Backups (docs/plans/backup-contracts.md section 10) ---
  // Everything shown comes from GET /api/backup/status: states and fixed sentences only, never a
  // passphrase, password or address. All text goes in through textContent (h() with text).

  // The same sentence as lib/backup/sentences.js FIX_FIRST.
  const BK_FIX_FIRST =
    "The NAS refused the last copy's password or module. Place the NAS files again with the backup helper first: repeated refusals could make the NAS block the Umbrel.";
  const BK_POLL_MS = 3000;
  let bkPollTimer = null;
  // After Back up now: the newest finished run id seen just before it was pressed. Runs with a
  // higher id are this press's (or the run it joined), whatever the browser's clock says.
  let bkWatching = null;

  function bkBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1024) return `${n} ${n === 1 ? "byte" : "bytes"}`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  const bkPlural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const bkSydneyDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(d);
  const bkSydneyHour = (d) =>
    Number(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", hourCycle: "h23" }).format(d));

  // "Tonight at 1:30 am", "Today at 3:45 pm", "Saturday at 1:30 am", or the full date.
  function bkWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const now = new Date();
    if (d.getTime() <= now.getTime() + 30000) return "Due now";
    const time = d.toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", minute: "2-digit" }).toLowerCase();
    const day = bkSydneyDay(d);
    const today = bkSydneyDay(now);
    const tomorrow = bkSydneyDay(new Date(now.getTime() + 86400000));
    const small = bkSydneyHour(d) < 6;
    if (day === today) return `${small && bkSydneyHour(now) < 6 ? "Tonight" : "Today"} at ${time}`;
    if (day === tomorrow) return `${small ? "Tonight" : "Tomorrow"} at ${time}`;
    if (d.getTime() - now.getTime() < 7 * 86400000) {
      const weekday = d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "long" });
      return `${weekday} at ${time}`;
    }
    return fmtDate(iso);
  }

  const BK_TRIGGER = { manual: "Back up now", schedule: "scheduled", startup: "catch-up after a restart" };

  function bkRunLine(run) {
    const when = fmtDate(run.finishedAt || run.startedAt);
    const by = BK_TRIGGER[run.trigger] || run.trigger;
    return `${when}, ${by}`;
  }

  function bkSnapshotState(s) {
    switch (s.snapshot.state) {
      case "ready":
        return ["On", "bk-good"];
      case "off":
        return ["Off: the backup passphrase is not on the server", "bk-attend"];
      case "invalid":
        return ["Not usable: the backup passphrase file is not usable (one line, at least 12 characters)", "bk-attend"];
      case "no_7zip":
        return ["7-Zip is missing", "bk-attend"];
      default:
        return [String(s.snapshot.state), "bk-attend"];
    }
  }

  function bkCopyState(s) {
    const c = s.copy;
    const f = c.files || {};
    switch (c.state) {
      case "off":
        return ["Not set up", "bk-attend"];
      case "half":
        return [`Half set up: ${f.nasUrl === "missing" ? "nas-url" : "nas-password"} is missing`, "bk-attend"];
      case "invalid": {
        const bad = [];
        if (f.nasUrl === "not_usable") bad.push("nas-url is not an rsync://account@IP/module address");
        if (f.nasPassword === "not_usable") bad.push("nas-password is not usable");
        return [`Not usable: ${bad.length ? bad.join(" and ") : "a NAS file is not usable"}`, "bk-attend"];
      }
      case "locked":
        return [`Locked: ${BK_FIX_FIRST}`, "bk-attend"];
      case "ready":
        if (!s.tools.rsync) return ["Set up, but rsync is missing from the app image", "bk-attend"];
        if (s.snapshot.passphrase !== "set") return ["Set up, but it waits for the backup passphrase", "bk-attend"];
        return ["Set up", "bk-good"];
      default:
        return [String(c.state), "bk-attend"];
    }
  }

  // One kind's facts as hs-kvt rows: [label, text, class, sub-line].
  function bkFacts(container, rows) {
    container.innerHTML = "";
    for (const [label, text, cls, sub] of rows) {
      container.append(
        h("div", { class: "k", text: label }),
        h("div", { class: "v" + (cls ? ` ${cls}` : "") }, h("span", { text }), sub ? h("span", { class: "bk-sub", text: sub }) : null)
      );
    }
  }

  function bkKindRows(s, kind, stateCell, noun) {
    const k = s[kind];
    const rows = [["State", stateCell[0], stateCell[1]]];
    const running = s.running && s.running.kind === kind;
    if (running) {
      rows.push(["Last", "Running now.", "bk-good", `Started ${fmtDate(s.running.startedAt)}`]);
    } else if (k.last) {
      rows.push(["Last", k.last.sentence, k.last.status === "failed" ? "bk-attend" : "", bkRunLine(k.last)]);
      if (k.last.status === "failed" && k.lastSuccess) {
        rows.push(["Last good", fmtDate(k.lastSuccess.finishedAt || k.lastSuccess.startedAt), ""]);
      }
    } else {
      rows.push(["Last", `No ${noun} yet.`, ""]);
    }
    if (!s.scheduleOn) rows.push(["Next", "Not scheduled on this server", ""]);
    else if (k.retryAt) rows.push(["Next try", bkWhen(k.retryAt), "bk-attend"]);
    else if (k.nextAt) rows.push(["Next", bkWhen(k.nextAt), ""]);
    if (k.overdue) {
      const since = k.lastSuccess ? `since ${fmtDate(k.lastSuccess.finishedAt || k.lastSuccess.startedAt)}` : "yet";
      rows.push(["Overdue", kind === "copy" ? `No proven copy ${since}` : `No good snapshot ${since}`, "bk-attend"]);
    }
    return rows;
  }

  function bkKindLabel(a) {
    if (a.kind === "manual") return "Back up now";
    if (a.kind === "premigrate") {
      const m = a.migration != null ? a.migration : Number((/premigrate-(\d+)-/.exec(a.name) || [])[1]);
      return Number.isFinite(m) ? `Before migration ${String(m).padStart(3, "0")}` : "Before migration";
    }
    return "Nightly";
  }

  function bkArchives(s) {
    const body = $("bkArchiveRows");
    body.innerHTML = "";
    if (!s.archives.length) {
      body.append(h("tr", {}, h("td", { colspan: "3", class: "text-muted", text: "No archives yet." })));
    }
    for (const a of s.archives) {
      body.append(
        h("tr", {}, h("td", { text: fmtDate(a.made) }), h("td", { text: bkKindLabel(a) }), h("td", { class: "num", text: bkBytes(a.bytes) }))
      );
    }
    const t = s.totals;
    let line = `${bkPlural(t.archives, "archive", "archives")}, ${bkBytes(t.archiveBytes)}`;
    if (t.unverified) line += `; ${t.unverified} unverified set aside`;
    line += ".";
    if (t.blobsTracked) line += ` ${bkPlural(t.blobsTracked, "private file", "private files")} encrypted for the NAS, ${t.blobsProven} proved there.`;
    $("bkTotals").textContent = line;
  }

  function bkShowResult(msg, cls) {
    const el = $("bkResult");
    el.textContent = msg || "";
    el.className = "bk-result" + (msg && cls ? ` ${cls}` : "");
    el.hidden = !msg;
  }

  function renderBackups(s) {
    const banner = $("bkBanner");
    banner.hidden = s.enabled;
    banner.textContent = s.enabled ? "" : "Backups are switched off on this server.";
    bkFacts($("bkSnapshot"), bkKindRows(s, "snapshot", bkSnapshotState(s), "snapshot"));
    bkFacts($("bkCopy"), bkKindRows(s, "copy", bkCopyState(s), "copy"));
    bkArchives(s);
    const btn = $("backupRun");
    btn.disabled = !!s.running || !s.enabled;
    btn.textContent = s.running ? "Backing up…" : "Back up now";
  }

  // The newest finished run id in a status (0 when there is none). A run still going is left out,
  // so a run that Back up now joins counts as this press's.
  function bkNewestFinishedId(s) {
    let newest = 0;
    for (const run of (s && s.recent) || []) {
      if (run && run.status !== "running" && Number(run.id) > newest) newest = Number(run.id);
    }
    return newest;
  }

  // After a run this page started: the new sentences, in orange if either job failed.
  function bkFinished(s) {
    const after = bkWatching;
    bkWatching = null;
    const mine = (run) => run && run.status !== "running" && Number(run.id) > after;
    const parts = [];
    let failed = false;
    for (const run of [s.snapshot.last, s.copy.last]) {
      if (!mine(run)) continue;
      parts.push(`${run.kind === "copy" ? "Copy" : "Snapshot"}: ${run.sentence}`);
      if (run.status === "failed") failed = true;
    }
    if (parts.length) bkShowResult(parts.join(" "), failed ? "bk-attend" : "bk-good");
    else bkShowResult("");
  }

  async function loadBackups() {
    clearTimeout(bkPollTimer);
    bkPollTimer = null;
    const s = await api("/api/backup/status");
    renderBackups(s);
    if (s.running) {
      // Poll only while a run is in progress.
      bkPollTimer = setTimeout(bkPoll, BK_POLL_MS);
    } else if (bkWatching !== null) {
      bkFinished(s);
    }
  }

  // One poll while a run is in progress. A failed poll stops polling, gives the button back and
  // says so in one short line (the run itself carries on on the server).
  async function bkPoll() {
    try {
      await loadBackups();
    } catch (err) {
      clearTimeout(bkPollTimer);
      bkPollTimer = null;
      bkWatching = null;
      const btn = $("backupRun");
      btn.disabled = false;
      btn.textContent = "Back up now";
      bkShowResult("The backup status could not be read. Reload the page to see how the run went.", "bk-attend");
    }
  }

  $("backupRun").addEventListener("click", async () => {
    const btn = $("backupRun");
    btn.disabled = true;
    bkShowResult("");
    try {
      // The newest finished run before this press, from a fresh status: the runs after it are ours.
      const before = await api("/api/backup/status");
      const after = bkNewestFinishedId(before);
      const r = await api("/api/backup/run", { method: "POST" });
      bkWatching = after;
      bkShowResult(r && r.joined ? "A backup is already running. Waiting for it to finish…" : "Backing up…", "bk-good");
    } catch (err) {
      // 409 and 429 carry a fixed sentence in {error}.
      bkShowResult(err.message, "bk-attend");
      btn.disabled = false;
      return;
    }
    await bkPoll();
  });

  guarded(loadBackups)();

  // --- Boot ---

  guarded(async () => {
    meta = await api("/api/users/meta");
    // Who am I? Used only to disable self-destructive buttons; the server enforces the rules.
    try {
      const me = await api("/api/auth/me");
      if (me && me.user) myId = me.user.id;
    } catch (e) {
      /* auth may be unavailable in dev */
    }
    await load();
  })();
})();
