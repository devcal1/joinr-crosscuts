(function () {
  // Logged out (or locked) mid-session: go to the login page instead of showing an error.
  // The promise never resolves because the page is navigating away.
  async function authFetch(url, options) {
    const res = await fetch(url, options);
    if (res.status === 401 && !location.pathname.startsWith("/login.html")) {
      const body = await res.clone().json().catch(() => ({}));
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = (body.locked ? "/login.html?locked=1&next=" : "/login.html?next=") + next;
      return new Promise(() => {});
    }
    return res;
  }

  const form = document.getElementById("upload-form");
  const filesInput = document.getElementById("files");
  const tagsInput = document.getElementById("tags");
  const uploadBtn = document.getElementById("upload-btn");
  const statusEl = document.getElementById("upload-status");
  const tbody = document.getElementById("photo-tbody");
  const filePreview = document.getElementById("file-preview");
  const suggestBtn = document.getElementById("suggest-tags-btn");
  const suggestChips = document.getElementById("suggest-chips");
  const jobField = document.getElementById("job-field");
  const jobSelect = document.getElementById("job-id");
  const jobFilterField = document.getElementById("job-filter-field");
  const jobFilterSelect = document.getElementById("job-filter");
  const jobTh = document.getElementById("job-th");
  const chipBar = document.getElementById("tg-chips");
  const summaryEl = document.getElementById("filter-summary");

  const TOP_TAGS = 20;
  const RECENT_DAYS = 180;
  const OPEN_STAGES = new Set(["lead", "quoted", "won", "design_ordering", "ready_to_cut", "on_board"]);

  let canJobs = false; // jobs.view: the job picker, column and filter exist only for holders
  let jobsList = []; // [{id, name}] open and recently finished jobs, for the pickers
  let photos = []; // every photo, as last fetched
  let tagCounts = []; // [{tag, count}] from /api/photos/tags
  const selected = new Set(); // chosen tag chips (every one must match)
  let showAllTags = false;
  let jobFilter = "all"; // "all", "none" or a job id as a string
  let countSeq = 0; // newest tag-count request wins, so a slow old one can't show stale counts

  let previewUrls = [];

  function clearFilePreview() {
    for (const url of previewUrls) URL.revokeObjectURL(url);
    previewUrls = [];
    filePreview.innerHTML = "";
  }

  function clearSuggestions() {
    suggestChips.innerHTML = "";
  }

  filesInput.addEventListener("change", () => {
    clearFilePreview();
    clearSuggestions();
    for (const file of filesInput.files) {
      const url = URL.createObjectURL(file);
      previewUrls.push(url);
      const img = document.createElement("img");
      img.src = url;
      img.alt = file.name;
      filePreview.appendChild(img);
    }
  });

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso.replace(" ", "T") + "Z").toLocaleDateString();
  }

  // The same rule as lib/tags.js splitTags (the server applies it again on save).
  function splitTags(value) {
    const seen = new Set();
    const out = [];
    for (const raw of String(value || "").split(",")) {
      const t = raw.trim().toLowerCase();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    return out;
  }

  function withAppendedTags(existingValue, tagsToAdd) {
    // Normalize additions through the same splitter as the existing value, so
    // a suggestion like "matte black, brass hardware" can't defeat the dedupe
    // or smuggle a comma into a single tag.
    tagsToAdd = tagsToAdd.flatMap((t) => splitTags(t));
    const existing = splitTags(existingValue);
    const existingLower = new Set(existing.map((t) => t.toLowerCase()));
    for (const t of tagsToAdd) {
      if (!existingLower.has(t.toLowerCase())) {
        existing.push(t);
        existingLower.add(t.toLowerCase());
      }
    }
    return existing.join(", ");
  }

  // PATCH /api/photos/:id; resolves with the saved photo, rejects with the server's message.
  async function patchPhoto(photoId, changes) {
    const res = await authFetch(`/api/photos/${photoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Save failed");
    return body;
  }

  function saveTags(photoId, value) {
    return patchPhoto(photoId, { tags: value });
  }

  async function suggestTagsForFile(file) {
    const formData = new FormData();
    formData.append("photo", file);
    const res = await authFetch("/api/suggest-tags", { method: "POST", body: formData });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || "Failed to get suggestions");
      err.code = body.code;
      throw err;
    }
    return body.tags || [];
  }

  async function fetchPhotoAsFile(url) {
    const res = await authFetch(url);
    if (!res.ok) throw new Error("Couldn't load the photo");
    const blob = await res.blob();
    return new File([blob], "photo", { type: blob.type || "image/webp" });
  }

  // Run fn over items with at most `limit` in flight, returning
  // Promise.allSettled-shaped results in input order.
  async function mapWithLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const i = next++;
          try {
            results[i] = { status: "fulfilled", value: await fn(items[i]) };
          } catch (reason) {
            results[i] = { status: "rejected", reason };
          }
        }
      })
    );
    return results;
  }

  function suggestionErrorMessage(err) {
    if (err.code === "NOT_CONFIGURED") {
      return "Tag suggestions aren't set up yet — see the README for how to add a free Gemini API key.";
    }
    return err.message || "Couldn't get suggestions for this photo.";
  }

  // A suggested-tag chip: clicking it runs onPick(tag) and removes itself on
  // success, leaving the chip in place (with an error status) on failure.
  function makeTagChip(tag, onPick) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip hs-pill";
    chip.textContent = tag;
    chip.addEventListener("click", async () => {
      try {
        await onPick(tag);
        chip.remove();
      } catch {
        setStatus("Failed to add tag.", "error");
      }
    });
    return chip;
  }

  function formatUploadFailures(failed) {
    return failed.map((f) => `${f.filename} (${f.error})`).join("; ");
  }

  // Mirrors upload.array("photos", 100)'s maxCount in server.js — a single
  // request over that cap is rejected wholesale, so batches are chunked here.
  // Keep both in sync by hand if either changes.
  const MAX_FILES_PER_REQUEST = 100;

  // Shared by the single-form upload and the bulk-folder import — POSTs a
  // batch of files with one tag string (chunked to the server's per-request
  // cap) and returns the combined {created, failed} split. Throws only if the
  // first chunk fails outright, before anything has been recorded; a failure
  // after earlier chunks landed becomes failed[] entries instead, so the
  // caller never mistakes a partial import for a clean miss.
  async function uploadPhotos(files, tags, jobId) {
    const created = [];
    const failed = [];
    for (let i = 0; i < files.length; i += MAX_FILES_PER_REQUEST) {
      const chunk = files.slice(i, i + MAX_FILES_PER_REQUEST);
      try {
        const formData = new FormData();
        for (const file of chunk) formData.append("photos", file);
        formData.append("tags", tags);
        if (jobId) formData.append("jobId", jobId);
        const res = await authFetch("/api/photos", { method: "POST", body: formData });
        const body = await res.json().catch(() => ({}));
        if (!res.ok && !body.created) {
          throw new Error(body.error || "Upload failed");
        }
        created.push(...(body.created || []));
        failed.push(...(body.failed || []));
      } catch (e) {
        if (created.length === 0 && failed.length === 0) throw e;
        failed.push(...chunk.map((f) => ({ filename: f.name, error: e.message || "network error" })));
      }
    }
    return { created, failed };
  }

  // — job pickers —
  function fillJobOptions(select, currentId, currentName) {
    select.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No job";
    select.appendChild(none);
    let seen = currentId == null;
    for (const job of jobsList) {
      const opt = document.createElement("option");
      opt.value = String(job.id);
      opt.textContent = job.name;
      select.appendChild(opt);
      if (job.id === currentId) seen = true;
    }
    if (!seen) {
      // A photo linked to an older job still shows it.
      const opt = document.createElement("option");
      opt.value = String(currentId);
      opt.textContent = currentName || "Job " + currentId;
      select.appendChild(opt);
    }
    select.value = currentId == null ? "" : String(currentId);
  }

  async function loadJobs() {
    try {
      const res = await authFetch("/api/job-records?archived=0");
      if (!res.ok) throw new Error();
      const all = await res.json();
      const cutoff = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
      jobsList = all
        .filter((j) => {
          if (OPEN_STAGES.has(j.stage)) return true;
          if (j.stage === "complete" || j.stage === "invoiced") {
            const at = Date.parse(j.stageChangedAt);
            return Number.isFinite(at) && at >= cutoff;
          }
          return false; // lost, archived and older jobs are left out
        })
        .map((j) => ({ id: j.id, name: j.name }));
    } catch {
      jobsList = [];
      setStatus("Couldn't load the job list.", "error");
    }
    fillJobOptions(jobSelect, null);
  }

  // — filters: tag chips and the job filter, applied client-side to the table —
  function visiblePhotos() {
    return photos.filter((p) => {
      if (selected.size > 0) {
        const own = splitTags(p.tags);
        for (const t of selected) if (!own.includes(t)) return false;
      }
      if (canJobs && jobFilter !== "all") {
        if (jobFilter === "none") {
          if (p.jobId != null) return false;
        } else if (p.jobId !== Number(jobFilter)) {
          return false;
        }
      }
      return true;
    });
  }

  function updateSummary() {
    summaryEl.textContent = photos.length === 0 ? "" : "Showing " + visiblePhotos().length + " of " + photos.length + " photos";
  }

  function chipButton(tag, count) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "hs-pill tg-chip";
    chip.setAttribute("aria-pressed", selected.has(tag) ? "true" : "false");
    chip.appendChild(document.createTextNode(tag));
    const n = document.createElement("span");
    n.className = "tg-count";
    n.textContent = String(count);
    chip.appendChild(n);
    chip.addEventListener("click", () => {
      if (selected.has(tag)) selected.delete(tag);
      else selected.add(tag);
      renderChips();
      renderTable();
      // renderChips rebuilt the buttons: put focus back on the one just used.
      for (const b of chipBar.querySelectorAll(".tg-chip")) {
        if (b.firstChild.nodeValue === tag) {
          b.focus();
          break;
        }
      }
    });
    return chip;
  }

  function renderChips() {
    chipBar.innerHTML = "";
    if (tagCounts.length === 0) {
      const none = document.createElement("span");
      none.className = "text-muted";
      none.textContent = "No tags yet.";
      chipBar.appendChild(none);
      return;
    }
    // Top 20 by count; a chosen tag always stays visible, even outside the top 20.
    const shown = showAllTags
      ? tagCounts
      : tagCounts.filter((t, i) => i < TOP_TAGS || selected.has(t.tag));
    for (const t of shown) chipBar.appendChild(chipButton(t.tag, t.count));

    if (tagCounts.length > TOP_TAGS) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "hs-btn hs-btn-quiet tg-more";
      more.setAttribute("aria-expanded", showAllTags ? "true" : "false");
      more.textContent = showAllTags ? "Fewer tags" : "All tags (" + tagCounts.length + ")";
      more.addEventListener("click", () => {
        showAllTags = !showAllTags;
        renderChips();
        chipBar.querySelector(".tg-more").focus();
      });
      chipBar.appendChild(more);
    }

    if (selected.size > 0) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "hs-btn hs-btn-quiet tg-clear";
      clear.textContent = "Clear";
      clear.addEventListener("click", () => {
        selected.clear();
        renderChips();
        renderTable();
        const first = chipBar.querySelector(".tg-chip");
        if (first) first.focus();
      });
      chipBar.appendChild(clear);
    }
  }

  // The job filter lists each job that has photos, plus All and Unlinked.
  function renderJobFilter() {
    if (!canJobs) return;
    const byId = new Map();
    for (const p of photos) if (p.jobId != null) byId.set(p.jobId, p.jobName || "Job " + p.jobId);
    const jobs = [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" }));
    jobFilterSelect.innerHTML = "";
    for (const [value, label] of [["all", "All jobs"], ["none", "Unlinked"]]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      jobFilterSelect.appendChild(opt);
    }
    for (const [id, name] of jobs) {
      const opt = document.createElement("option");
      opt.value = String(id);
      opt.textContent = name;
      jobFilterSelect.appendChild(opt);
    }
    if (jobFilter !== "all" && jobFilter !== "none" && !byId.has(Number(jobFilter))) jobFilter = "all";
    jobFilterSelect.value = jobFilter;
  }

  jobFilterSelect.addEventListener("change", () => {
    jobFilter = jobFilterSelect.value;
    renderTable();
  });

  // Applies fresh tag counts. A tag nobody has any more can't stay chosen.
  function applyCounts(rows) {
    tagCounts = Array.isArray(rows) ? rows : [];
    let pruned = false;
    for (const t of [...selected]) {
      if (!tagCounts.some((c) => c.tag === t)) {
        selected.delete(t);
        pruned = true;
      }
    }
    renderChips();
    renderJobFilter();
    return pruned;
  }

  // Re-fetches the tag counts. Called after every upload, tag save, job link and
  // delete; the newest request wins, so counts are never stale.
  async function refreshCounts() {
    const mine = ++countSeq;
    let rows = null;
    try {
      const res = await authFetch("/api/photos/tags");
      if (res.ok) rows = await res.json();
    } catch {
      rows = null;
    }
    if (mine !== countSeq || rows === null) return; // superseded, or failed: keep what is shown
    if (applyCounts(rows)) renderTable();
    else updateSummary();
  }

  function renderRow(photo) {
    const tr = document.createElement("tr");

    const photoTd = document.createElement("td");
    const img = document.createElement("img");
    img.src = photo.thumbUrl;
    img.alt = photo.tags || "Job photo";
    photoTd.appendChild(img);
    tr.appendChild(photoTd);

    const tagsTd = document.createElement("td");
    const tagsField = document.createElement("input");
    tagsField.className = "hs-input tags-input";
    tagsField.setAttribute("aria-label", "Tags");
    tagsField.value = photo.tags || "";

    // Saves through the server, shows what it kept (tidied) and refreshes the chip counts.
    const commitTags = async (value) => {
      const saved = await saveTags(photo.id, value);
      photo.tags = saved.tags;
      tagsField.value = saved.tags;
      img.alt = saved.tags || "Job photo";
      refreshCounts();
    };

    tagsField.addEventListener("change", async () => {
      try {
        await commitTags(tagsField.value);
      } catch {
        setStatus("Failed to save tags.", "error");
      }
    });
    tagsTd.appendChild(tagsField);

    const addTagRow = document.createElement("div");
    addTagRow.className = "add-tag-row";
    const addTagInput = document.createElement("input");
    addTagInput.className = "hs-input";
    addTagInput.placeholder = "add a tag…";
    addTagInput.setAttribute("aria-label", "Add a tag");
    const addTagBtn = document.createElement("button");
    addTagBtn.type = "button";
    addTagBtn.className = "hs-btn";
    addTagBtn.textContent = "+";
    addTagBtn.setAttribute("aria-label", "Add tag");
    const appendTag = async () => {
      const newTags = splitTags(addTagInput.value);
      if (newTags.length === 0) return;
      const combined = withAppendedTags(tagsField.value, newTags);
      addTagBtn.disabled = true;
      try {
        await commitTags(combined);
        addTagInput.value = "";
      } catch {
        setStatus("Failed to add tag.", "error");
      } finally {
        addTagBtn.disabled = false;
      }
    };
    addTagBtn.addEventListener("click", appendTag);
    addTagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        appendTag();
      }
    });
    addTagRow.appendChild(addTagInput);
    addTagRow.appendChild(addTagBtn);
    tagsTd.appendChild(addTagRow);

    const rowSuggestBtn = document.createElement("button");
    rowSuggestBtn.type = "button";
    rowSuggestBtn.className = "hs-btn row-suggest-btn";
    rowSuggestBtn.textContent = "Suggest tags";

    const rowChips = document.createElement("div");
    rowChips.className = "tag-chips";

    rowSuggestBtn.addEventListener("click", async () => {
      rowSuggestBtn.disabled = true;
      rowChips.innerHTML = "";
      const originalLabel = rowSuggestBtn.textContent;
      rowSuggestBtn.textContent = "Suggesting…";
      try {
        // The 700px thumb, not the original: plenty for tagging, and a full
        // 20MB+ DSLR original base64-expands past Gemini's inline size cap.
        const file = await fetchPhotoAsFile(photo.thumbUrl);
        const tags = await suggestTagsForFile(file);
        if (tags.length === 0) {
          setStatus("No suggestions for this photo.", "error");
        }
        for (const tag of tags) {
          rowChips.appendChild(makeTagChip(tag, async (t) => {
            await commitTags(withAppendedTags(tagsField.value, [t]));
          }));
        }
      } catch (err) {
        setStatus(suggestionErrorMessage(err), "error");
      } finally {
        rowSuggestBtn.disabled = false;
        rowSuggestBtn.textContent = originalLabel;
      }
    });

    tagsTd.appendChild(rowSuggestBtn);
    tagsTd.appendChild(rowChips);

    tr.appendChild(tagsTd);

    if (canJobs) {
      const jobTd = document.createElement("td");
      const link = document.createElement("div");
      link.className = "job-link";
      const showLink = () => {
        link.textContent = "";
        if (photo.jobId == null) {
          link.className = "job-link text-muted";
          link.textContent = "No job";
          return;
        }
        link.className = "job-link";
        const a = document.createElement("a");
        a.href = "/job.html?id=" + encodeURIComponent(photo.jobId);
        a.textContent = photo.jobName || "Job " + photo.jobId;
        link.appendChild(a);
      };
      showLink();
      const select = document.createElement("select");
      select.className = "hs-input job-select";
      select.setAttribute("aria-label", "Job for this photo");
      fillJobOptions(select, photo.jobId, photo.jobName);
      select.addEventListener("change", async () => {
        select.disabled = true;
        try {
          const saved = await patchPhoto(photo.id, { jobId: select.value === "" ? null : Number(select.value) });
          photo.jobId = saved.jobId == null ? null : saved.jobId;
          photo.jobName = saved.jobName == null ? null : saved.jobName;
          showLink();
          refreshCounts();
        } catch (err) {
          fillJobOptions(select, photo.jobId, photo.jobName);
          setStatus(err.message || "Failed to change the job.", "error");
        } finally {
          select.disabled = false;
        }
      });
      jobTd.appendChild(link);
      jobTd.appendChild(select);
      tr.appendChild(jobTd);
    }

    const dateTd = document.createElement("td");
    dateTd.className = "text-muted";
    dateTd.textContent = formatDate(photo.createdAt);
    tr.appendChild(dateTd);

    const actionsTd = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "hs-btn hs-btn-stop";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm("Delete this photo? This can't be undone.")) return;
      try {
        const res = await authFetch(`/api/photos/${photo.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error();
        photos = photos.filter((p) => p.id !== photo.id);
        tr.remove();
        if (tbody.children.length === 0) renderTable();
        else updateSummary();
        refreshCounts();
      } catch {
        setStatus("Failed to delete photo.", "error");
      }
    });
    actions.appendChild(deleteBtn);
    actionsTd.appendChild(actions);
    tr.appendChild(actionsTd);

    return tr;
  }

  function renderTable() {
    const cols = canJobs ? 5 : 4;
    const rows = visiblePhotos();
    tbody.innerHTML = "";
    if (rows.length === 0) {
      const msg = photos.length === 0 ? "No photos yet." : "No photos match those filters.";
      tbody.innerHTML = '<tr><td colspan="' + cols + '" class="text-muted">' + msg + "</td></tr>";
    } else {
      for (const photo of rows) tbody.appendChild(renderRow(photo));
    }
    updateSummary();
  }

  async function loadPhotos() {
    const cols = canJobs ? 5 : 4;
    tbody.innerHTML = '<tr><td colspan="' + cols + '" class="text-muted">Loading…</td></tr>';
    const mine = ++countSeq;
    try {
      const [photosRes, tagsRes] = await Promise.all([authFetch("/api/photos"), authFetch("/api/photos/tags")]);
      if (!photosRes.ok) throw new Error();
      photos = await photosRes.json();
      const rows = tagsRes.ok ? await tagsRes.json() : null;
      // A newer count request has already (or will) show fresher numbers.
      if (mine === countSeq && rows !== null) applyCounts(rows);
      else renderJobFilter();
      renderTable();
    } catch {
      tbody.innerHTML = '<tr><td colspan="' + cols + '" class="status error">Failed to load photos.</td></tr>';
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!filesInput.files.length) return;

    uploadBtn.disabled = true;
    setStatus(`Uploading ${filesInput.files.length} photo(s)…`);
    try {
      const { created, failed } = await uploadPhotos([...filesInput.files], tagsInput.value, canJobs ? jobSelect.value : "");
      if (failed.length === 0) {
        setStatus("Upload complete.", "ok");
        form.reset();
      } else {
        setStatus(`Uploaded ${created.length} of ${created.length + failed.length} — failed: ${formatUploadFailures(failed)}`, "error");
        // Keep the typed tags for the retry, but clear the file selection so
        // re-submitting can't duplicate the photos that already made it in.
        const tags = tagsInput.value;
        form.reset();
        tagsInput.value = tags;
      }
      clearFilePreview();
      clearSuggestions();
      await loadPhotos();
    } catch (err) {
      setStatus(err.message || "Upload failed.", "error");
    } finally {
      uploadBtn.disabled = false;
    }
  });

  suggestBtn.addEventListener("click", async () => {
    if (!filesInput.files.length) {
      setStatus("Choose photos first, then suggest tags.", "error");
      return;
    }

    suggestBtn.disabled = true;
    clearSuggestions();
    setStatus(`Looking at ${filesInput.files.length} photo(s)…`);

    // Capped concurrency: an uncapped fan-out of full-size uploads buffers
    // multiples of 25MB in server memory and burns through the free Gemini
    // tier's per-minute rate limit in one burst.
    const results = await mapWithLimit([...filesInput.files], 3, suggestTagsForFile);
    suggestBtn.disabled = false;

    const notConfigured = results.some((r) => r.status === "rejected" && r.reason?.code === "NOT_CONFIGURED");
    if (notConfigured) {
      setStatus("Tag suggestions aren't set up yet — see the README for how to add a free Gemini API key.", "error");
      return;
    }

    const suggested = new Set();
    for (const r of results) {
      if (r.status === "fulfilled") {
        for (const tag of r.value) suggested.add(tag);
      }
    }

    if (suggested.size === 0) {
      const firstError = results.find((r) => r.status === "rejected")?.reason?.message;
      setStatus(firstError || "Couldn't get any suggestions — try tagging manually.", "error");
      return;
    }

    const okCount = results.filter((r) => r.status === "fulfilled").length;
    setStatus(okCount === results.length ? "" : `Got suggestions from ${okCount} of ${results.length} photo(s).`);
    for (const tag of suggested) {
      suggestChips.appendChild(makeTagChip(tag, (t) => {
        tagsInput.value = withAppendedTags(tagsInput.value, [t]);
      }));
    }
  });

  // — Bulk folder import —
  // ALLOWED_EXT/MAX_BULK_FILE_BYTES mirror ALLOWED_MIME/MAX_FILE_BYTES in
  // server.js — this is just a client-side pre-filter for a better UX
  // (skip obviously-bad files before uploading), the server enforces the
  // real limit regardless. Keep both in sync by hand if either changes.
  const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const MAX_BULK_FILE_BYTES = 25 * 1024 * 1024;
  const IGNORE_FILENAMES = new Set(["thumbs.db", "desktop.ini", ".ds_store"]);

  const bulkFolderInput = document.getElementById("bulk-folder");
  const bulkReview = document.getElementById("bulk-review");
  const bulkReviewTbody = document.getElementById("bulk-review-tbody");
  const bulkSkippedEl = document.getElementById("bulk-skipped");
  const bulkImportBtn = document.getElementById("bulk-import-btn");
  const bulkCancelBtn = document.getElementById("bulk-cancel-btn");
  const bulkStatusEl = document.getElementById("bulk-status");

  let bulkGroups = []; // [{ folder, tagInput: HTMLInputElement, checkbox: HTMLInputElement, files: File[] }]

  function setBulkStatus(message, kind) {
    bulkStatusEl.textContent = message;
    bulkStatusEl.className = "status" + (kind ? " " + kind : "");
  }

  function extOf(filename) {
    const i = filename.lastIndexOf(".");
    return i === -1 ? "" : filename.slice(i).toLowerCase();
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function groupFilesByFolder(fileList) {
    const groups = new Map(); // folder name -> File[]
    const skipped = []; // { path, reason }

    for (const file of fileList) {
      const relPath = file.webkitRelativePath || file.name;
      const parts = relPath.split("/");
      const baseName = parts[parts.length - 1];

      if (IGNORE_FILENAMES.has(baseName.toLowerCase())) continue;

      if (parts.length < 2) {
        skipped.push({ path: relPath, reason: "not inside a subfolder" });
        continue;
      }
      const folder = parts[parts.length - 2];

      if (!ALLOWED_EXT.has(extOf(baseName))) {
        skipped.push({ path: relPath, reason: "unsupported file type" });
        continue;
      }
      if (file.size > MAX_BULK_FILE_BYTES) {
        skipped.push({ path: relPath, reason: `over ${formatBytes(MAX_BULK_FILE_BYTES)} limit` });
        continue;
      }

      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(file);
    }

    return { groups, skipped };
  }

  function renderBulkReview(groups, skipped) {
    bulkReviewTbody.innerHTML = "";
    bulkGroups = [];

    for (const [folder, files] of groups) {
      const tr = document.createElement("tr");

      const checkTd = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkTd.appendChild(checkbox);
      tr.appendChild(checkTd);

      const folderTd = document.createElement("td");
      folderTd.textContent = folder;
      tr.appendChild(folderTd);

      const tagTd = document.createElement("td");
      const tagInput = document.createElement("input");
      tagInput.className = "hs-input tags-input";
      tagInput.value = folder.toLowerCase();
      tagTd.appendChild(tagInput);
      tr.appendChild(tagTd);

      const countTd = document.createElement("td");
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      countTd.textContent = `${files.length} (${formatBytes(totalBytes)})`;
      tr.appendChild(countTd);

      bulkReviewTbody.appendChild(tr);
      bulkGroups.push({ folder, tagInput, checkbox, files, tr });
    }

    if (skipped.length === 0) {
      bulkSkippedEl.textContent = "";
    } else {
      const reasons = skipped.slice(0, 5).map((s) => `${s.path} (${s.reason})`).join(", ");
      const more = skipped.length > 5 ? ` and ${skipped.length - 5} more` : "";
      bulkSkippedEl.textContent = `Skipping ${skipped.length} file(s): ${reasons}${more}.`;
    }

    setBulkStatus("");
    bulkReview.style.display = bulkGroups.length ? "" : "none";
    if (!bulkGroups.length) {
      setBulkStatus("No images found in that folder.", "error");
      bulkReview.style.display = "";
    }
  }

  bulkFolderInput.addEventListener("change", () => {
    const { groups, skipped } = groupFilesByFolder(bulkFolderInput.files);
    renderBulkReview(groups, skipped);
  });

  bulkCancelBtn.addEventListener("click", () => {
    bulkFolderInput.value = "";
    bulkGroups = [];
    bulkReview.style.display = "none";
    setBulkStatus("");
  });

  bulkImportBtn.addEventListener("click", async () => {
    const selected = bulkGroups.filter((g) => g.checkbox.checked);
    if (selected.length === 0) {
      setBulkStatus("Nothing selected to import.", "error");
      return;
    }

    bulkImportBtn.disabled = true;
    bulkCancelBtn.disabled = true;
    let done = 0;
    const problems = []; // per-folder summary strings for anything that wasn't a clean full success

    for (const group of selected) {
      done += 1;
      setBulkStatus(`Importing ${done}/${selected.length}: ${group.folder} (${group.files.length} photos)…`);
      try {
        const { created, failed } = await uploadPhotos(group.files, group.tagInput.value);
        if (failed.length > 0) {
          const duplicateNote = created.length > 0
            ? ` (re-importing this folder would duplicate the ${created.length} that succeeded)`
            : "";
          problems.push(`${group.folder}: ${failed.length} of ${group.files.length} failed — ${formatUploadFailures(failed)}${duplicateNote}`);
        } else {
          // Imported clean — uncheck and lock the row so a retry after
          // "Finished with issues" can't re-send it and duplicate its photos.
          group.checkbox.checked = false;
          group.checkbox.disabled = true;
          group.tagInput.disabled = true;
          group.tr.style.opacity = "0.55";
        }
      } catch (e) {
        problems.push(`${group.folder}: ${e.message || "network error"}`);
      }
    }

    bulkImportBtn.disabled = false;
    bulkCancelBtn.disabled = false;

    if (problems.length === 0) {
      setBulkStatus(`Imported ${selected.length} folder(s) successfully.`, "ok");
      bulkFolderInput.value = "";
      bulkGroups = [];
      bulkReview.style.display = "none";
    } else {
      setBulkStatus(`Finished with issues — ${problems.join(" | ")}`, "error");
    }

    await loadPhotos();
  });

  async function init() {
    try {
      if (window.cc && window.cc.ready) await window.cc.ready;
    } catch {
      // carry on without the job features
    }
    canJobs = !!(window.cc && typeof window.cc.can === "function" && window.cc.can("jobs.view"));
    if (canJobs) {
      jobField.hidden = false;
      jobFilterField.hidden = false;
      jobTh.hidden = false;
      await loadJobs();
    }
    await loadPhotos();
  }

  init();
})();
