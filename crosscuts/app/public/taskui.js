// The task dialog, shared by /tasks.html and the job page (and the home page tiles).
//
//   ccTasks.openTask(id, { onChange, onClose, scrollToComments })
//   ccTasks.newTask({ jobId, jobName, onChange, onClose })
//
// One dialog at a time. It shows the task's fields (editable for the creator, the assignee and
// admins while the task is open), Done / Reopen / Cancel task, files, and the comment thread
// (ccComments, comments.js). Talks to /api/tasks, /api/people and /api/job-records
// (docs/plans/m4-contracts.md sections 4 and 6). All user text goes in as text.
// Styles (tk- classes) are in tasks.css, which this script links if the page has not.
(function () {
  "use strict";
  if (window.ccTasks) return;

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var ALLOWED_EXT = ["pdf", "png", "jpg", "jpeg", "xlsx", "xls", "docx", "csv"];
  var MAX_BYTES = 25 * 1024 * 1024;

  function ensureStyles() {
    if (document.querySelector('link[rel="stylesheet"][href$="tasks.css"]')) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/tasks.css";
    document.head.appendChild(link);
  }

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

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

  function me() {
    return (window.cc && window.cc.me) || null;
  }

  function isAdmin() {
    var u = me();
    return !!(u && u.roles && u.roles.indexOf("admin") >= 0);
  }

  function fmtDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] + " " + m[1] : "";
  }

  function ago(iso) {
    return window.cc && typeof window.cc.timeAgo === "function" ? window.cc.timeAgo(iso) : "";
  }

  function fmtSize(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }

  function refreshCounts() {
    if (window.cc && typeof window.cc.refreshCounts === "function") window.cc.refreshCounts();
  }

  // JSON or multipart call. Errors carry .status and .body (a 409 stale edit brings .body.task).
  async function call(method, path, body) {
    var isForm = typeof FormData !== "undefined" && body instanceof FormData;
    var res = await fetch(path, {
      method: method,
      headers: body === undefined || isForm ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    if (res.status === 401 && !location.pathname.startsWith("/login.html")) {
      location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
      return new Promise(function () {});
    }
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      var err = new Error((data && data.error) || "Request failed (" + res.status + ")");
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  var peoplePromise = null;
  function loadPeople() {
    if (!peoplePromise) {
      peoplePromise = call("GET", "/api/people").then(function (d) { return d.rows; }).catch(function () {
        peoplePromise = null;
        return [];
      });
    }
    return peoplePromise;
  }

  var jobsPromise = null;
  function loadJobs() {
    if (!can("jobs.view")) return Promise.resolve([]);
    if (!jobsPromise) {
      jobsPromise = call("GET", "/api/job-records?archived=0").then(function (d) {
        return d.map(function (j) { return { id: j.id, name: j.name }; });
      }).catch(function () {
        jobsPromise = null;
        return [];
      });
    }
    return jobsPromise;
  }

  function jobLabel(j) {
    return j.name + " (#" + j.id + ")";
  }

  function field(label, id, control, wide) {
    return el("div", { class: "cc-field" + (wide ? " tk-wide" : "") }, el("label", { class: "cc-field-label", for: id, text: label }), control);
  }

  function readField(label, node, wide) {
    return el("div", { class: "cc-field" + (wide ? " tk-wide" : "") }, el("span", { class: "cc-field-label", text: label }), node);
  }

  var current = null; // the open dialog, so a second open replaces it

  // mode: "create" or "view". task is null in create mode.
  function show(opts) {
    ensureStyles();
    if (current) {
      try { current.close(); } catch (e) { /* already closed */ }
    }
    var o = opts || {};
    var task = o.task || null;
    var create = !task;
    var people = [];
    var jobs = [];
    var message = "";
    var messageKind = "";
    var busy = false;
    var pendingFiles = [];
    var draft = null;
    var commentsHost = null;
    var commentsMounted = null;

    var dlg = el("dialog", { class: "cc-dialog tk-dialog", "aria-label": create ? "New task" : "Task" });
    current = dlg;
    document.body.append(dlg);
    dlg.addEventListener("close", function () {
      if (current === dlg) current = null;
      dlg.remove();
      if (typeof o.onClose === "function") o.onClose();
    });

    function changed() {
      if (typeof o.onChange === "function") o.onChange();
      refreshCounts();
    }

    function say(text, kind) {
      message = text || "";
      messageKind = kind || "";
    }

    function editable() {
      return !create && task.canEdit && task.status === "open";
    }

    function mayCancel() {
      var u = me();
      return !create && task.status === "open" && !!u && (isAdmin() || task.createdBy.id === u.id);
    }

    // ---- actions ----

    // What is typed in the form, so a re-render (after an error, or a file pick) doesn't lose it.
    // Cleared whenever the task itself is replaced by the server's version.
    function snapshot() {
      var d = {};
      var any = false;
      [["title", "#tk-title"], ["notes", "#tk-notes"], ["assignee", "#tk-assignee"], ["due", "#tk-due"], ["job", "#tk-job"]].forEach(function (p) {
        var n = dlg.querySelector(p[1]);
        if (n) {
          d[p[0]] = n.value;
          any = true;
        }
      });
      draft = any ? d : null;
    }

    function drafted(name, fallback) {
      return draft && draft[name] !== undefined ? draft[name] : fallback;
    }

    async function guarded(fn) {
      if (busy) return;
      snapshot();
      busy = true;
      for (var b of dlg.querySelectorAll(".tk-actions button")) b.disabled = true;
      try {
        await fn();
      } catch (e) {
        await onError(e);
      }
      busy = false;
      render();
    }

    // A 409 shows the server's message and replaces the form with the server's current version.
    async function onError(e) {
      say(e.message, "err");
      if (e.status === 409 && !create) {
        draft = null;
        if (e.body && e.body.task) {
          task = e.body.task;
        } else {
          try {
            task = await call("GET", "/api/tasks/" + task.id);
          } catch (e2) { /* keep what we have */ }
        }
        changed();
      }
    }

    function formValues() {
      var v = {};
      var t = dlg.querySelector("#tk-title");
      if (t) v.title = t.value.trim();
      var n = dlg.querySelector("#tk-notes");
      if (n) v.notes = n.value;
      var a = dlg.querySelector("#tk-assignee");
      if (a) v.assigneeId = a.value ? Number(a.value) : null;
      var d = dlg.querySelector("#tk-due");
      if (d) v.dueDate = d.value || null;
      var j = dlg.querySelector("#tk-job");
      if (j) {
        var text = j.value.trim();
        if (!text) v.jobId = null;
        else {
          var hit = jobs.filter(function (x) { return jobLabel(x) === text; })[0];
          if (!hit) throw new Error("Choose a job from the list, or clear the job box");
          v.jobId = hit.id;
        }
      }
      return v;
    }

    // Only the fields that differ from the loaded task.
    function changesFrom(v) {
      var c = {};
      if (v.title !== undefined && v.title !== task.title) c.title = v.title;
      if (v.notes !== undefined && v.notes.trim() !== task.notes) c.notes = v.notes;
      if (v.assigneeId !== undefined && v.assigneeId !== task.assignee.id) c.assigneeId = v.assigneeId;
      if (v.dueDate !== undefined && v.dueDate !== (task.dueDate || null)) c.dueDate = v.dueDate;
      if (v.jobId !== undefined && v.jobId !== (task.job ? task.job.id : null)) c.jobId = v.jobId;
      return c;
    }

    // Saves edits if there are any; resolves true when the task is saved (or there was nothing to save).
    async function saveEdits() {
      if (!editable()) return true;
      var c = changesFrom(formValues());
      if (!Object.keys(c).length) return true;
      c.updatedAt = task.updatedAt;
      task = await call("PATCH", "/api/tasks/" + task.id, c);
      draft = null;
      changed();
      return true;
    }

    function save() {
      guarded(async function () {
        var had = Object.keys(changesFrom(formValues())).length > 0;
        await saveEdits();
        say(had ? "Saved." : "Nothing to save.", had ? "ok" : "");
      });
    }

    function status(action, done) {
      guarded(async function () {
        await saveEdits();
        task = await call("POST", "/api/tasks/" + task.id + "/" + action);
        draft = null;
        say(done, "ok");
        changed();
      });
    }

    function createTask() {
      guarded(async function () {
        var v = formValues();
        if (!v.title) throw new Error("Give the task a title");
        if (!v.assigneeId) throw new Error("Choose who it is for");
        var body = { title: v.title, assigneeId: v.assigneeId, notes: v.notes ? v.notes.trim() : "" };
        if (v.dueDate) body.dueDate = v.dueDate;
        if (v.jobId) body.jobId = v.jobId;
        else if (v.jobId === undefined && o.jobId) body.jobId = o.jobId; // no job picker without jobs.view
        var made = await call("POST", "/api/tasks", body);
        changed();
        var failed = [];
        for (var i = 0; i < pendingFiles.length; i++) {
          try {
            made = await upload(made.id, pendingFiles[i]);
          } catch (e) {
            failed.push(pendingFiles[i].name + ": " + e.message);
          }
        }
        pendingFiles = [];
        if (!failed.length) {
          if (typeof window.toast === "function") window.toast("Task raised");
          dlg.close();
          return;
        }
        // The task exists; carry on in its dialog and say which files didn't attach.
        task = made;
        create = false;
        draft = null;
        say("The task was raised, but " + failed.join("; "), "err");
        changed();
      });
    }

    function checkFile(file) {
      var ext = (/\.([^.]+)$/.exec(file.name) || [])[1];
      if (!ext || ALLOWED_EXT.indexOf(ext.toLowerCase()) < 0) return "That file type isn't allowed (PDF, Excel, Word, CSV, PNG or JPEG)";
      if (file.size > MAX_BYTES) return "That file is too big (25 MB at most)";
      if (file.size === 0) return "That file is empty";
      return "";
    }

    function upload(taskId, file) {
      var bad = checkFile(file);
      if (bad) return Promise.reject(new Error(bad));
      var fd = new FormData();
      fd.append("file", file, file.name);
      return call("POST", "/api/tasks/" + taskId + "/files", fd);
    }

    function attachSelected(input) {
      var file = input.files && input.files[0];
      if (!file) {
        say("Choose a file first.", "err");
        snapshot();
        render();
        return;
      }
      guarded(async function () {
        task = await upload(task.id, file);
        say("File attached.", "ok");
        changed();
      });
    }

    function removeFile(f) {
      guarded(async function () {
        task = await call("DELETE", "/api/tasks/" + task.id + "/files/" + f.id);
        say("File removed.", "ok");
        changed();
      });
    }

    // A button that needs a second press within 4 s.
    function confirmButton(label, confirmLabel, cls, run) {
      var btn = el("button", { type: "button", class: "hs-btn " + cls, text: label });
      var armed = null;
      btn.addEventListener("click", function () {
        if (!armed) {
          btn.textContent = confirmLabel;
          armed = setTimeout(function () {
            armed = null;
            btn.textContent = label;
          }, 4000);
          return;
        }
        clearTimeout(armed);
        armed = null;
        run();
      });
      return btn;
    }

    // ---- rendering ----

    function statusBadge() {
      var map = { open: ["Open", "hs-badge-teal"], done: ["Done", "hs-badge-go"], cancelled: ["Cancelled", "hs-badge-na"] };
      var s = map[task.status] || [task.status, "hs-badge-na"];
      var box = el("span", { class: "tk-badges" }, el("span", { class: "hs-badge " + s[1], text: s[0] }));
      if (task.overdue) box.append(el("span", { class: "hs-badge hs-badge-stop", text: "Overdue" }));
      return box;
    }

    function peopleSelect(selectedId) {
      var want = String(drafted("assignee", selectedId ? String(selectedId) : ""));
      var sel = el("select", { class: "hs-input tk-select", id: "tk-assignee" });
      if (create) sel.append(el("option", { value: "", text: "Choose a person" }));
      var seen = false;
      people.forEach(function (p) {
        var opt = el("option", { value: String(p.id), text: p.displayName });
        if (String(p.id) === want) {
          opt.selected = true;
          seen = true;
        }
        sel.append(opt);
      });
      // An assignee who can no longer be picked (disabled, or lost tasks.use) stays visible.
      if (!create && !seen) sel.append(el("option", { value: String(task.assignee.id), text: task.assignee.name, selected: true }));
      return sel;
    }

    function jobBox(selectedLabel) {
      var list = el("datalist", { id: "tk-joblist" });
      jobs.forEach(function (j) { list.append(el("option", { value: jobLabel(j) })); });
      var input = el("input", { class: "hs-input", id: "tk-job", type: "text", list: "tk-joblist", placeholder: "No job", autocomplete: "off", value: selectedLabel || "" });
      return el("div", { class: "tk-jobbox" }, input, list);
    }

    function filesBlock() {
      var box = el("div", { class: "tk-files" }, el("span", { class: "cc-field-label", text: "Files" }));
      var u = me();
      if (create) {
        var list = el("ul", { class: "tk-filelist" });
        pendingFiles.forEach(function (f, i) {
          var rm = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Remove" });
          rm.addEventListener("click", function () {
            pendingFiles.splice(i, 1);
            snapshot();
            render();
          });
          list.append(el("li", { class: "tk-file" }, el("span", { class: "tk-file-name", text: f.name }), el("span", { class: "tk-file-meta", text: fmtSize(f.size) }), rm));
        });
        if (pendingFiles.length) box.append(list);
        var pick = el("input", { type: "file", id: "tk-pick", class: "tk-pick", accept: ".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.docx,.csv", "aria-label": "Choose a file to attach" });
        pick.addEventListener("change", function () {
          var f = pick.files && pick.files[0];
          if (!f) return;
          var bad = checkFile(f);
          if (bad) say(bad, "err");
          else {
            pendingFiles.push(f);
            say("", "");
          }
          snapshot();
          render();
        });
        box.append(el("div", { class: "tk-attach" }, pick, el("span", { class: "tk-hint", text: "Attached when you create the task" })));
        return box;
      }
      if (!task.files.length) box.append(el("p", { class: "tk-none", text: "No files." }));
      else {
        var ul = el("ul", { class: "tk-filelist" });
        task.files.forEach(function (f) {
          var li = el("li", { class: "tk-file" });
          var a = el("a", { class: "tk-file-name", href: f.url, target: "_blank", rel: "noopener" });
          a.textContent = f.name;
          li.append(a, el("span", { class: "tk-file-meta", text: fmtSize(f.size) + (f.uploadedBy ? ", " + f.uploadedBy.name : "") + ", " + ago(f.uploadedAt) }));
          if (u && (isAdmin() || task.createdBy.id === u.id || (f.uploadedBy && f.uploadedBy.id === u.id))) {
            li.append(confirmButton("Remove", "Confirm remove", "hs-btn-quiet", function () { removeFile(f); }));
          }
          ul.append(li);
        });
        box.append(ul);
      }
      if (editable()) {
        var input = el("input", { type: "file", id: "tk-pick", class: "tk-pick", accept: ".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.docx,.csv", "aria-label": "Choose a file to attach" });
        var btn = el("button", { type: "button", class: "hs-btn", text: "Attach" });
        btn.addEventListener("click", function () { attachSelected(input); });
        box.append(el("div", { class: "tk-attach" }, input, btn));
      }
      return box;
    }

    function render() {
      var form = el("div", { class: "cc-dialog-form tk-form" });
      var canEdit = create || editable();

      // Heading
      var head = el("div", { class: "tk-head" });
      if (create) head.append(el("h2", { class: "cc-dialog-title", text: "New task" }));
      else head.append(el("h2", { class: "cc-dialog-title tk-heading", text: task.title }), statusBadge());
      form.append(head);

      // Fields
      var grid = el("div", { class: "tk-fields" });
      if (canEdit) {
        grid.append(field("Title", "tk-title", el("input", { class: "hs-input", id: "tk-title", type: "text", maxlength: "200", value: drafted("title", create ? "" : task.title), autocomplete: "off" }), true));
        grid.append(field("Assignee", "tk-assignee", peopleSelect(create ? null : task.assignee.id)));
        grid.append(field("Due date", "tk-due", el("input", { class: "hs-input tk-date", id: "tk-due", type: "date", value: drafted("due", create ? "" : task.dueDate || "") })));
        if (can("jobs.view")) {
          // The job the task starts with: the one passed in (a new task from a job page) or its own.
          var startJob = create ? (o.jobId ? { id: o.jobId, name: o.jobName || "" } : null) : task.job;
          if (startJob) {
            var known = jobs.filter(function (j) { return j.id === startJob.id; })[0];
            // A job that isn't in the active list (archived) still has to round-trip.
            if (!known) jobs = jobs.concat([{ id: startJob.id, name: startJob.name || "Job " + startJob.id }]);
            startJob = known || jobs[jobs.length - 1];
          }
          grid.append(field("Job", "tk-job", jobBox(drafted("job", startJob ? jobLabel(startJob) : "")), true));
        } else if (!create && task.job) {
          grid.append(readField("Job", el("span", { text: task.job.name }), true));
        } else if (create && o.jobId) {
          grid.append(readField("Job", el("span", { text: o.jobName || "Job " + o.jobId }), true));
        }
        grid.append(field("Notes", "tk-notes", el("textarea", { class: "hs-input tk-notes", id: "tk-notes", rows: "4", maxlength: "10000", text: drafted("notes", create ? "" : task.notes) }), true));
      } else {
        grid.append(readField("Assignee", el("span", { text: task.assignee.name })));
        grid.append(readField("Due date", el("span", { class: task.overdue ? "tk-overdue" : "", text: task.dueDate ? fmtDate(task.dueDate) : "None" })));
        var jv = el("span");
        if (task.job) {
          var ja = el("a", { href: "/job.html?id=" + task.job.id });
          ja.textContent = task.job.name;
          jv.append(ja);
        } else jv.textContent = "None";
        grid.append(readField("Job", jv, true));
        var nv = el("div", { class: "tk-notes-read" });
        nv.textContent = task.notes || "No notes.";
        grid.append(readField("Notes", nv, true));
      }
      form.append(grid);

      if (!create) {
        var meta = "Raised by " + task.createdBy.name + ", " + ago(task.createdAt) + ".";
        if (task.status === "done" && task.doneBy) meta += " Finished by " + task.doneBy.name + ", " + ago(task.doneAt) + ".";
        if (task.status === "cancelled") meta += " Cancelled.";
        form.append(el("p", { class: "tk-meta", text: meta }));
        if (!canEdit && task.status === "open") form.append(el("p", { class: "tk-meta", text: "Only the person who raised it, the assignee or an admin can change the details." }));
      }

      form.append(filesBlock());

      form.append(el("p", { class: "cc-dialog-error tk-message" + (messageKind === "ok" ? " cc-dialog-ok" : ""), role: "status", "aria-live": "polite", text: message }));

      // Actions
      var acts = el("div", { class: "cc-dialog-actions tk-actions" });
      var closeBtn = el("button", { type: "button", class: "hs-btn", text: "Close" });
      closeBtn.addEventListener("click", function () { dlg.close(); });
      if (create) {
        var mk = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Create task" });
        mk.addEventListener("click", createTask);
        acts.append(closeBtn, mk);
      } else {
        if (mayCancel()) {
          var cb = confirmButton("Cancel task", "Confirm cancel", "hs-btn-stop tk-cancel", function () { status("cancel", "Task cancelled."); });
          acts.append(cb);
        }
        acts.append(closeBtn);
        if (task.status === "open") {
          if (editable()) {
            var sv = el("button", { type: "button", class: "hs-btn", text: "Save" });
            sv.addEventListener("click", save);
            acts.append(sv);
          }
          var dn = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Done" });
          dn.addEventListener("click", function () { status("done", "Marked done."); });
          acts.append(dn);
        } else if (task.status === "done") {
          var ro = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Reopen" });
          ro.addEventListener("click", function () { status("reopen", "Task reopened."); });
          acts.append(ro);
        }
      }
      if (busy) for (var b of acts.querySelectorAll("button")) b.disabled = true;
      form.append(acts);

      // The thread is mounted once per task so a half-written comment survives re-renders.
      if (!create) {
        if (!commentsHost || commentsMounted !== task.id) {
          commentsHost = el("div", { class: "tk-comments", id: "tk-comments" });
          commentsMounted = task.id;
          if (window.ccComments) window.ccComments.mount(commentsHost, "task", task.id, { canWrite: true, onChange: changed });
        }
        form.append(commentsHost);
      }

      var keepScroll = dlg.scrollTop;
      dlg.replaceChildren(form);
      dlg.scrollTop = keepScroll;
    }

    // ---- open ----

    Promise.all([loadPeople(), loadJobs()]).then(function (r) {
      people = r[0];
      jobs = r[1];
      render();
      dlg.showModal();
      if (create) {
        var t = dlg.querySelector("#tk-title");
        if (t) t.focus();
      } else if (o.scrollToComments && commentsHost) {
        commentsHost.scrollIntoView({ block: "start" });
      }
    });

    return dlg;
  }

  function openTask(id, opts) {
    var o = opts || {};
    return call("GET", "/api/tasks/" + encodeURIComponent(id)).then(
      function (task) {
        show({ task: task, onChange: o.onChange, onClose: o.onClose, scrollToComments: !!o.scrollToComments });
      },
      function (e) {
        if (typeof window.toast === "function") window.toast(e.message);
        if (typeof o.onClose === "function") o.onClose();
      }
    );
  }

  function newTask(opts) {
    var o = opts || {};
    show({ task: null, jobId: o.jobId ? Number(o.jobId) : null, jobName: o.jobName || "", onChange: o.onChange, onClose: o.onClose });
  }

  window.ccTasks = { openTask: openTask, newTask: newTask };
})();
