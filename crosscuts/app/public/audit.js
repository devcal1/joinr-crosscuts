// Audit log viewer (read-only). Data comes from GET /api/audit and /api/audit/actions.
(function () {
  const PAGE_SIZE = 100;
  const $ = (id) => document.getElementById(id);
  const state = { offset: 0, total: 0 };

  const sydneyFmt = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });

  function fmtTime(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : sydneyFmt.format(d);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function valueText(v) {
    if (v === null) return "null";
    if (typeof v === "string") return v;
    return JSON.stringify(v, null, 2);
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  // One side of the before/after view. `other` is the opposite side, used to flag changed keys.
  function renderPane(title, value, other) {
    const pane = el("div", "diff-pane");
    pane.appendChild(el("h3", null, title));
    if (value === null || value === undefined) {
      pane.appendChild(el("div", "none", "(none)"));
      return pane;
    }
    const dl = el("dl", "kv mono");
    if (isPlainObject(value)) {
      const otherObj = isPlainObject(other) ? other : null;
      for (const key of Object.keys(value)) {
        const changed =
          !otherObj || !(key in otherObj) || JSON.stringify(otherObj[key]) !== JSON.stringify(value[key]);
        const dt = el("dt", changed && other != null ? "changed dt" : null, key);
        const dd = el("dd", changed && other != null ? "changed" : null, valueText(value[key]));
        dl.append(dt, dd);
      }
    } else {
      const same = JSON.stringify(value) === JSON.stringify(other);
      dl.append(el("dt", null, "value"), el("dd", !same && other != null ? "changed" : null, valueText(value)));
    }
    pane.appendChild(dl);
    return pane;
  }

  function renderDetail(row) {
    const tr = el("tr", "detail");
    const td = el("td");
    td.colSpan = 6;
    const diff = el("div", "diff");
    diff.append(renderPane("Before", row.before, row.after), renderPane("After", row.after, row.before));
    td.appendChild(diff);
    tr.appendChild(td);
    return tr;
  }

  function renderRow(row) {
    const hasDetail = row.before != null || row.after != null;
    const tr = el("tr", "row" + (hasDetail ? " has-detail" : ""));

    const chev = el("td", "col-chev");
    if (hasDetail) chev.appendChild(el("span", "chev", "Show"));
    tr.appendChild(chev);

    tr.appendChild(el("td", "nowrap", fmtTime(row.at)));

    const who = el("td");
    who.appendChild(document.createTextNode(row.actorLabel || "system"));
    if (row.actorUserId != null) who.appendChild(el("span", "sub", "user #" + row.actorUserId));
    tr.appendChild(who);

    tr.appendChild(el("td", "action-name mono", row.action));

    const ent = el("td");
    if (row.entityType || row.entityId != null) {
      ent.appendChild(document.createTextNode(row.entityType || ""));
      if (row.entityId != null) ent.appendChild(el("span", "sub mono", "#" + row.entityId));
    } else {
      ent.appendChild(el("span", "none", "—"));
    }
    tr.appendChild(ent);

    tr.appendChild(el("td", "mono nowrap", row.ip || ""));

    if (hasDetail) {
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      tr.setAttribute("aria-expanded", "false");
      const toggle = () => {
        const open = tr.classList.toggle("open");
        tr.setAttribute("aria-expanded", String(open));
        const mark = tr.querySelector(".chev");
        if (mark) mark.textContent = open ? "Hide" : "Show";
        if (open) {
          tr._detail = renderDetail(row);
          tr.after(tr._detail);
        } else if (tr._detail) {
          tr._detail.remove();
          tr._detail = null;
        }
      };
      tr.addEventListener("click", toggle);
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    }
    return tr;
  }

  function currentQuery() {
    const q = new URLSearchParams();
    const set = (k, id) => {
      const v = $(id).value.trim();
      if (v) q.set(k, v);
    };
    set("actor", "f-actor");
    set("action", "f-action");
    set("entityType", "f-etype");
    set("entityId", "f-eid");
    set("from", "f-from");
    set("to", "f-to");
    q.set("limit", String(PAGE_SIZE));
    q.set("offset", String(state.offset));
    return q;
  }

  async function load() {
    $("count").textContent = "Loading…";
    try {
      const data = await api("/api/audit?" + currentQuery().toString());
      state.total = data.total;
      // A filter change or deletion can leave us past the end; snap back.
      if (data.rows.length === 0 && data.total > 0 && state.offset > 0) {
        state.offset = Math.max(0, Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        return load();
      }
      const body = $("rows");
      body.replaceChildren(...data.rows.map(renderRow));
      $("empty").hidden = data.rows.length > 0;
      const from = data.total === 0 ? 0 : state.offset + 1;
      const to = state.offset + data.rows.length;
      $("count").textContent = `${data.total.toLocaleString("en-AU")} ${data.total === 1 ? "entry" : "entries"}` +
        (data.total ? ` — showing ${from}–${to}` : "");
      const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      $("page-info").textContent = `Page ${Math.floor(state.offset / PAGE_SIZE) + 1} of ${pages}`;
      $("prev").disabled = state.offset <= 0;
      $("next").disabled = state.offset + PAGE_SIZE >= data.total;
    } catch (e) {
      $("rows").replaceChildren();
      $("empty").hidden = true;
      $("count").textContent = "Couldn't load the audit log: " + e.message;
      $("prev").disabled = true;
      $("next").disabled = true;
    }
  }

  async function loadActions() {
    try {
      const actions = await api("/api/audit/actions");
      const sel = $("f-action");
      const keep = sel.value;
      for (const a of actions) {
        const o = document.createElement("option");
        o.value = a;
        o.textContent = a;
        sel.appendChild(o);
      }
      // Also offer each dotted group as a prefix ("auth.", "user.", "job.").
      const groups = [...new Set(actions.filter((a) => a.includes(".")).map((a) => a.split(".")[0] + "."))];
      groups.reverse().forEach((g) => {
        const o = document.createElement("option");
        o.value = g;
        o.textContent = g + "* (all)";
        sel.insertBefore(o, sel.options[1]);
      });
      sel.value = keep;
    } catch (_) {
      /* the table still works without the dropdown */
    }
  }

  $("filters").addEventListener("submit", (e) => {
    e.preventDefault();
    state.offset = 0;
    load();
  });
  $("f-reset").addEventListener("click", () => {
    $("filters").reset();
    state.offset = 0;
    load();
  });
  $("prev").addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - PAGE_SIZE);
    load();
  });
  $("next").addEventListener("click", () => {
    state.offset += PAGE_SIZE;
    load();
  });

  loadActions();
  load();
})();
