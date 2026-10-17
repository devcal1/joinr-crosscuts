// New from Joinr: the inbox of won quotes. Talks to /api/joinr (routes/joinr.js,
// docs/plans/m6-contracts.md sections 3, 5 and 6). All text from Joinr goes in through
// textContent; links are only http(s).
(function () {
  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : true;
  }

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }
  const SYD = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" });
  function fmtInstant(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return "";
    return fmtYmd(SYD.format(d));
  }
  function fmtMoney(c) {
    return "$" + (c / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function ago(iso) {
    const t = Date.parse(iso || "");
    if (Number.isNaN(t)) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
    const h = Math.round(m / 60);
    if (h < 48) return h + (h === 1 ? " hour ago" : " hours ago");
    const d = Math.round(h / 24);
    return d + " days ago";
  }
  function httpUrl(u) {
    return typeof u === "string" && /^https?:\/\/\S+$/i.test(u) ? u : null;
  }
  const num = (n) => String(Math.round(n * 100) / 100);

  const VIEWS = [
    ["new", "Waiting for a person"],
    ["changed", "Changed"],
    ["decided", "Made into jobs"],
    ["ignored", "Ignored"],
    ["withdrawn", "Withdrawn"],
  ];
  const STATE_BADGE = {
    new: ["New", "hs-badge-teal"],
    accepted: ["Accepted", "hs-badge-go"],
    linked: ["Linked", "hs-badge-go"],
    ignored: ["Ignored", "hs-badge-na"],
    withdrawn: ["Withdrawn", "hs-badge-violet"],
  };
  const EMPTY = {
    new: "Nothing is waiting. Won quotes become jobs by themselves; only a quote the system could not handle waits here.",
    changed: "Nothing has changed in Joinr since you decided.",
    decided: "No quotes have become jobs yet.",
    ignored: "No ignored quotes.",
    withdrawn: "No withdrawn quotes.",
  };

  const tabsEl = document.getElementById("tabs");
  const syncLineEl = document.getElementById("syncLine");
  const syncBtn = document.getElementById("syncBtn");
  const messageEl = document.getElementById("message");
  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty");

  const params = new URLSearchParams(location.search);
  const wantItem = Number(params.get("item")) > 0 ? Number(params.get("item")) : null;
  let highlight = wantItem;

  let view = "new";
  let rows = [];
  let counts = {};
  let sync = null;
  let syncFailed = false;
  let loaded = false;
  let seq = 0;

  function setMessage(msg, kind) {
    messageEl.textContent = msg || "";
    messageEl.className = "in-message " + (kind || "");
  }

  // ---- sync line ---------------------------------------------------------------------

  function renderSync() {
    syncLineEl.replaceChildren();
    syncBtn.hidden = !can("jobs.edit");
    syncBtn.disabled = false;
    if (!sync) {
      syncLineEl.textContent = syncFailed ? "Sync status unavailable." : "Checking...";
      return;
    }
    if (!sync.configured) {
      syncLineEl.textContent = "Joinr is not set up yet. An admin adds the address and key on the Users page.";
      return;
    }
    const bits = [];
    if (sync.lastOkAt) bits.push("Last checked " + ago(sync.lastOkAt) + ".");
    else bits.push("Not checked yet.");
    syncLineEl.append(document.createTextNode(bits.join(" ")));
    if (sync.lastError) {
      const when = sync.lastErrorAt ? " (" + ago(sync.lastErrorAt) + ")" : "";
      syncLineEl.append(document.createTextNode(" "), el("span", { class: "in-err", text: "Last problem: " + sync.lastError + when }));
    }
  }

  // ---- tabs ----------------------------------------------------------------------------

  function renderTabs() {
    tabsEl.replaceChildren();
    for (const [key, label] of VIEWS) {
      const n = counts[key];
      const btn = el(
        "button",
        { type: "button", class: "hs-btn in-tab", "aria-pressed": key === view ? "true" : "false" },
        el("span", { text: label })
      );
      if (typeof n === "number") btn.append(el("span", { class: "in-tab-n" + (key === "changed" && n > 0 ? " in-attn" : ""), text: String(n) }));
      btn.addEventListener("click", () => {
        if (view === key) return;
        view = key;
        highlight = null;
        setMessage("", "");
        load();
      });
      tabsEl.append(btn);
    }
  }

  // ---- cards -------------------------------------------------------------------------

  function fact(k, ...vs) {
    return el("div", { class: "in-fact" }, el("div", { class: "in-fact-k", text: k }), el("div", { class: "in-fact-v" }, ...vs));
  }
  const wide = (node) => {
    node.classList.add("in-fact-wide");
    return node;
  };
  const line = (text, cls) => el("div", { class: cls || "", text });

  function eventText(it) {
    switch (it.lastEvent) {
      case "unwon": return "Joinr says this quote is no longer won (now " + it.joinrStatus + ").";
      case "deleted": return "This quote was deleted in Joinr.";
      case "won": return "Joinr marked a quote won again (a new revision, or won once more).";
      default: return "This quote was edited in Joinr.";
    }
  }

  function specFact(q) {
    const s = q.spec || {};
    const parts = [];
    if (s.sheetCount != null) parts.push("Sheets: " + s.sheetCount);
    if (s.twoPac != null) parts.push("Two-pac: " + (s.twoPac ? "Yes" : "No"));
    if (s.benchtop) parts.push("Benchtop: " + s.benchtop.charAt(0).toUpperCase() + s.benchtop.slice(1));
    if (s.jobType) parts.push("Job type: " + s.jobType);
    const kids = [];
    kids.push(line(parts.length ? parts.join(", ") : "Nothing normalised"));
    const raw = q.raw || {};
    const asTyped = [];
    if (raw.doorsPanels && raw.doorsPanels.length) asTyped.push("Doors/panels: " + raw.doorsPanels.join(", "));
    if (raw.benchtops && raw.benchtops.length) asTyped.push("Benchtop: " + raw.benchtops.join(", "));
    if (raw.jobTypes && raw.jobTypes.length) asTyped.push("Job type: " + raw.jobTypes.join(", "));
    if (asTyped.length) kids.push(line("As typed: " + asTyped.join("; "), "in-muted"));
    return wide(fact("Spec", ...kids));
  }

  function hoursFact(h) {
    if (!h) return null;
    const bits = ["office", "factory", "site", "travel"].filter((k) => h[k] != null).map((k) => k + " " + num(h[k]));
    return bits.length ? wide(fact("Estimated hours", line(bits.join(", ")))) : null;
  }

  function buildCard(it) {
    const q = it.quote || {};
    const [stLabel, stBadge] = STATE_BADGE[it.state] || [it.state, "hs-badge-na"];
    const badges = el("div", { class: "in-badges" }, el("span", { class: "hs-badge " + stBadge, text: stLabel }));
    if (it.changed) badges.append(el("span", { class: "hs-badge hs-badge-check", text: "Changed in Joinr" }));

    const card = el("article", {
      class: "hs-card in-card" + (it.state === "new" ? " in-new" : "") + (it.changed ? " in-changed" : ""),
      id: "item-" + it.id,
    });
    card.append(
      el(
        "div",
        { class: "in-card-head" },
        el("span", { class: "in-qn", text: it.quoteNumber || "No quote number" }),
        el("span", { class: "in-site", text: q.siteAddress || q.label || q.clientName || "" }),
        badges
      )
    );

    const facts = el("div", { class: "in-facts" });
    const client = [];
    client.push(el("b", { text: q.clientName || "No client name" }));
    if (q.clientPhone) client.push(line(q.clientPhone));
    if (q.clientEmail) client.push(line(q.clientEmail));
    facts.append(wide(fact("Client", ...client)));
    if (q.valueIncGstCents != null) facts.append(fact("Value inc GST", el("b", { text: fmtMoney(q.valueIncGstCents) })));
    else if (can("jobs.value")) facts.append(fact("Value inc GST", line("Not priced in Joinr", "in-muted")));
    if (q.quoteDate) facts.append(fact("Quote date", line(fmtYmd(q.quoteDate))));
    if (q.wonAt) facts.append(fact("Won", line(fmtInstant(q.wonAt))));
    facts.append(specFact(q));
    const hf = hoursFact(q.estimatedHours);
    if (hf) facts.append(hf);
    if (q.reference) facts.append(fact("Reference", line(q.reference)));
    if (q.label && q.label !== q.siteAddress) facts.append(fact("Label", line(q.label)));
    const url = httpUrl(q.url);
    if (url) {
      const a = el("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: "Open in Joinr" });
      facts.append(fact("Quote", a));
    }
    if (it.job) {
      const who = it.decidedBy && it.decidedBy.id == null && it.decidedBy.name ? " automatically" : it.decidedBy && it.decidedBy.name ? " by " + it.decidedBy.name : "";
      const on = it.decidedAt ? " on " + fmtInstant(it.decidedAt) : "";
      facts.append(
        wide(fact(
          it.state === "linked" ? "Linked to" : "Job",
          el("a", { href: "/job.html?id=" + encodeURIComponent(it.job.id), text: it.job.name || "Job " + it.job.id }),
          line((it.state === "linked" ? "Linked" : "Accepted") + who + on, "in-muted")
        ))
      );
    } else if (it.state === "ignored" && it.decidedAt) {
      const who = it.decidedBy && it.decidedBy.name ? " by " + it.decidedBy.name : "";
      facts.append(fact("Ignored", line(fmtInstant(it.decidedAt) + who, "in-muted")));
    }
    card.append(facts);

    if (it.state === "withdrawn") {
      card.append(
        el("div", { class: "hs-callout hs-callout-orange in-note" }, el("h3", { text: "Withdrawn" }), el("p", { text: eventText(it) }))
      );
    }

    if (it.changed) {
      const note = el(
        "div",
        { class: "hs-callout hs-callout-orange in-note" },
        el("h3", { text: "Changed in Joinr" }),
        el("p", { text: eventText(it) })
      );
      if (it.job) note.append(el("p", { class: "in-muted", text: "The job has not been changed." }));
      if (it.differences && it.differences.length) {
        const ul = el("ul", { class: "in-diff" });
        for (const d of it.differences) {
          ul.append(el("li", {}, el("b", { text: d.label + ": " }), document.createTextNode("job " + d.job + ", Joinr " + d.joinr)));
        }
        note.append(el("p", { class: "in-muted", text: "Where the job and Joinr now differ:" }), ul);
      }
      card.append(note);
    }

    // Actions (jobs.edit; the server checks too).
    if (can("jobs.edit")) {
      const acts = el("div", { class: "in-acts" });
      if (it.state === "new") {
        acts.append(button("Accept", "hs-btn hs-btn-primary", () => doAccept(it)));
        if (it.matches > 0) {
          acts.append(button("Link to existing job (" + it.matches + ")", "hs-btn", () => openLink(it, card)));
        }
      }
      if (it.state === "new" || it.state === "withdrawn") acts.append(button("Ignore", "hs-btn", () => doIgnore(it)));
      if (it.changed) {
        acts.append(el("span", { class: "in-spacer" }), button("Acknowledge", "hs-btn hs-btn-check", () => doAck(it)));
      }
      if (acts.childNodes.length) card.append(acts);
    }
    return card;
  }

  function button(label, cls, onClick) {
    const b = el("button", { type: "button", class: cls, text: label });
    b.addEventListener("click", onClick);
    return b;
  }

  function render() {
    renderTabs();
    renderSync();
    listEl.replaceChildren();
    emptyEl.hidden = rows.length > 0;
    if (!rows.length) emptyEl.textContent = EMPTY[view] || "Nothing to show.";
    for (const it of rows) listEl.append(buildCard(it));
    if (highlight != null) {
      const card = document.getElementById("item-" + highlight);
      if (card) {
        card.classList.add("in-hl");
        card.scrollIntoView({ block: "center" });
      }
      highlight = null;
    }
  }

  // ---- actions ---------------------------------------------------------------------------

  function busy(on) {
    for (const b of document.querySelectorAll(".in-list button, #syncBtn")) b.disabled = on;
  }

  async function act(it, path, body, done) {
    busy(true);
    setMessage("Saving...", "");
    try {
      const res = await api("/api/joinr/intake/" + it.id + "/" + path, { method: "POST", body: JSON.stringify(body || {}) });
      setMessage(done(res, it), "ok");
    } catch (e) {
      setMessage(e.message, "err");
    }
    await load();
  }

  function doAccept(it) {
    return act(it, "accept", {}, () => (it.quoteNumber || "Quote") + " accepted. A job was created at Won.");
  }

  async function doIgnore(it) {
    const ok = await confirmDialog(
      "Ignore this quote?",
      (it.quoteNumber || "This quote") + " will stay in the Ignored list. If Joinr changes it later, it is marked as changed, not brought back as new.",
      "Ignore",
      "Keep"
    );
    if (!ok) return;
    return act(it, "ignore", {}, () => (it.quoteNumber || "Quote") + " ignored.");
  }

  function doAck(it) {
    return act(it, "acknowledge", {}, () => "Marked as seen.");
  }

  async function openLink(it, card) {
    const existing = card.querySelector(".in-linkbox");
    if (existing) {
      existing.remove();
      return;
    }
    const sel = el("select", { class: "hs-input", id: "link-" + it.id, "aria-label": "Job to link" });
    const go = button("Link", "hs-btn hs-btn-primary", async () => {
      if (!sel.value) return;
      await act(it, "link", { jobId: Number(sel.value) }, () => (it.quoteNumber || "Quote") + " linked to the job.");
    });
    go.disabled = true;
    const box = el(
      "div",
      { class: "in-linkbox" },
      el("label", { for: "link-" + it.id, text: "Job" }),
      sel,
      go,
      el("p", { class: "in-muted in-linkhint", text: "Fills only the empty fields on the job. Nothing else on the job changes." })
    );
    card.append(box);
    try {
      const full = await api("/api/joinr/intake/" + it.id);
      const jobs = full.matchJobs || [];
      sel.replaceChildren(el("option", { value: "", text: jobs.length ? "Choose a job..." : "No matching jobs" }));
      for (const j of jobs) {
        const label = j.name + (j.clientName ? " - " + j.clientName : "") + (j.stage ? " (" + j.stage.replace(/_/g, " ") + ")" : "");
        sel.append(el("option", { value: String(j.id), text: label }));
      }
      if (jobs.length === 1) sel.value = String(jobs[0].id);
      go.disabled = !sel.value;
      sel.addEventListener("change", () => {
        go.disabled = !sel.value;
      });
    } catch (e) {
      setMessage(e.message, "err");
      box.remove();
    }
  }

  // A modal on the shell's cc-dialog frame. Resolves true only when the confirm button is pressed.
  function confirmDialog(title, note, confirmLabel, keepLabel) {
    return new Promise((resolve) => {
      let answer = false;
      const dlg = el("dialog", { class: "cc-dialog in-dialog", "aria-label": title });
      const keep = el("button", { type: "button", class: "hs-btn", text: keepLabel });
      const yes = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: confirmLabel });
      keep.addEventListener("click", () => dlg.close());
      yes.addEventListener("click", () => {
        answer = true;
        dlg.close();
      });
      dlg.append(
        el(
          "div",
          { class: "cc-dialog-form" },
          el("h2", { class: "cc-dialog-title", text: title }),
          el("p", { class: "cc-dialog-note", text: note }),
          el("div", { class: "cc-dialog-actions" }, keep, yes)
        )
      );
      document.body.append(dlg);
      dlg.addEventListener("mousedown", (e) => {
        if (e.target === dlg) dlg.close();
      });
      dlg.addEventListener("close", () => {
        dlg.remove();
        resolve(answer);
      });
      dlg.showModal();
    });
  }

  // ---- loading -----------------------------------------------------------------------------

  async function load() {
    const mine = ++seq;
    let res;
    try {
      res = await api("/api/joinr/intake?state=" + encodeURIComponent(view));
    } catch (e) {
      if (mine === seq) {
        syncFailed = true;
        renderSync();
        setMessage(e.message, "err");
      }
      return;
    }
    if (mine !== seq) return;
    rows = res.rows || [];
    counts = res.counts || {};
    sync = res.sync || null;
    syncFailed = !sync;
    loaded = true;
    render();
  }

  syncBtn.addEventListener("click", async () => {
    busy(true);
    setMessage("Checking Joinr...", "");
    try {
      const res = await api("/api/joinr/sync", { method: "POST", body: "{}" });
      if (res && res.ok === false) setMessage(res.error || "The check failed.", "err");
      else setMessage(res && res.items ? res.items + (res.items === 1 ? " change" : " changes") + " from Joinr." : "Nothing new from Joinr.", "ok");
    } catch (e) {
      setMessage(e.message === "Not built" ? "Sync is not available yet." : e.message, "err");
    }
    await load();
  });

  // ?item=N: open the view that holds it, then scroll to it and highlight it.
  async function start() {
    if (wantItem) {
      try {
        const it = await api("/api/joinr/intake/" + wantItem);
        if (it.state === "new") view = "new";
        else if (it.changed) view = "changed";
        else if (it.state === "ignored") view = "ignored";
        else if (it.state === "withdrawn") view = "withdrawn";
        else view = "decided";
      } catch (e) {
        highlight = null;
        setMessage(e.message, "err");
      }
    }
    renderTabs();
    renderSync();
    await load();
  }

  start();
  // The shell may finish loading permissions after first paint.
  document.addEventListener("cc:ready", () => {
    if (loaded) render();
  });
})();
