// Tasks page: the shared task queue. Talks to /api/tasks (see routes/tasks.js and
// docs/plans/m4-contracts.md sections 4 and 6). The task dialog is taskui.js.
(function () {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const VIEWS = [
    ["mine", "Mine"],
    ["raised", "Raised by me"],
    ["open", "All open"],
    ["done", "Done"],
  ];
  const EMPTY = {
    mine: "Nothing assigned to you.",
    raised: "You haven't raised any open tasks.",
    open: "No open tasks.",
    done: "No finished tasks yet.",
  };
  const STATUS = {
    open: ["Open", "hs-badge-teal"],
    done: ["Done", "hs-badge-go"],
    cancelled: ["Cancelled", "hs-badge-na"],
  };

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

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  const params = new URLSearchParams(location.search);
  let view = VIEWS.some((v) => v[0] === params.get("view")) ? params.get("view") : "mine";

  const viewsEl = document.getElementById("views");
  const countEl = document.getElementById("count");
  const messageEl = document.getElementById("message");
  const rowsEl = document.getElementById("rows");
  const emptyEl = document.getElementById("empty");
  const statusHead = document.getElementById("statusHead");
  const newBtn = document.getElementById("newTask");

  let rows = [];
  let seq = 0; // the newest list request wins
  let dialogOpen = false;

  function setMessage(msg, kind) {
    messageEl.textContent = msg || "";
    messageEl.className = "tk-pagemsg " + (kind || "");
  }

  function renderViews() {
    viewsEl.replaceChildren();
    for (const [key, label] of VIEWS) {
      const b = el("button", { type: "button", class: "hs-btn", "aria-pressed": key === view ? "true" : "false", text: label });
      b.addEventListener("click", () => {
        if (key === view) return;
        view = key;
        history.replaceState(null, "", key === "mine" ? location.pathname : `${location.pathname}?view=${key}`);
        renderViews();
        load();
      });
      viewsEl.append(b);
    }
  }

  function dueCell(t) {
    const td = el("td", { class: "tk-due" });
    if (!t.dueDate) return td;
    if (t.overdue) td.append(el("span", { class: "hs-badge hs-badge-stop", text: fmtDate(t.dueDate) }));
    else td.append(document.createTextNode(fmtDate(t.dueDate)));
    return td;
  }

  function render() {
    const showStatus = view === "done";
    statusHead.hidden = !showStatus;
    rowsEl.replaceChildren();
    emptyEl.hidden = rows.length > 0;
    if (!rows.length) emptyEl.textContent = EMPTY[view];
    countEl.textContent = rows.length + (rows.length === 1 ? " task" : " tasks");
    for (const t of rows) {
      const link = el("a", { class: "tk-title-link", href: `/tasks.html?task=${t.id}`, text: t.title });
      link.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        openTask(t.id);
      });
      const titleCell = el("td", { class: "tk-title" }, link);
      const bits = [];
      if (t.commentCount) bits.push(t.commentCount + (t.commentCount === 1 ? " comment" : " comments"));
      if (t.files.length) bits.push(t.files.length + (t.files.length === 1 ? " file" : " files"));
      // 0.2.0: made by a recurring task (Admin > Tasks).
      if (t.recurring) bits.push("Recurring");
      if (bits.length) titleCell.append(el("span", { class: "tk-sub", text: bits.join(", ") }));
      const job = el("td", { class: "tk-job" });
      if (t.job) job.append(el("a", { href: `/job.html?id=${t.job.id}`, text: t.job.name }));
      const tr = el(
        "tr",
        { class: t.status === "cancelled" ? "tk-cancelled" : "" },
        titleCell,
        el("td", { class: "tk-person", text: t.assignee.name }),
        dueCell(t),
        job,
        el("td", { class: "tk-person", text: t.createdBy.name })
      );
      if (showStatus) {
        const [label, badge] = STATUS[t.status] || [t.status, "hs-badge-na"];
        tr.append(el("td", {}, el("span", { class: "hs-badge " + badge, text: label })));
      }
      // The whole row opens the task; links inside it do their own thing.
      tr.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        openTask(t.id);
      });
      rowsEl.append(tr);
    }
  }

  async function load() {
    const mine = ++seq;
    let data;
    try {
      data = await api("/api/tasks?view=" + view);
    } catch (e) {
      if (mine === seq) {
        countEl.textContent = "";
        setMessage(e.message, "err");
      }
      return;
    }
    if (mine !== seq) return;
    setMessage("", "");
    rows = data.rows;
    render();
  }

  function openTask(id, scrollToComments) {
    if (!window.ccTasks) return;
    dialogOpen = true;
    window.ccTasks.openTask(id, {
      onChange: load,
      scrollToComments: !!scrollToComments,
      onClose: () => {
        dialogOpen = false;
        const p = new URLSearchParams(location.search);
        if (p.has("task")) {
          p.delete("task");
          const qs = p.toString();
          history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
        }
        load();
      },
    });
  }

  newBtn.addEventListener("click", () => {
    if (!window.ccTasks) return;
    dialogOpen = true;
    window.ccTasks.newTask({
      onChange: load,
      onClose: () => {
        dialogOpen = false;
      },
    });
  });

  // Coming back to the tab refreshes the list (unless a dialog is mid-edit).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !dialogOpen) load();
  });

  renderViews();
  load();
  if (params.get("task") && /^\d+$/.test(params.get("task"))) {
    openTask(params.get("task"), location.hash === "#comments");
  }
})();
