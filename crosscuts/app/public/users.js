(function () {
  // api(), toast(), guarded() come from /shared.js, loaded before this file.
  const $ = (id) => document.getElementById(id);

  const ROLE_LABELS = {
    admin: "Admin",
    accounts: "Accounts",
    design_pm: "Design / PM",
    scheduling: "Scheduling",
    showroom: "Showroom",
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
