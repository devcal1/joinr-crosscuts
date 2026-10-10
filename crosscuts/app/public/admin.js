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

  function splitTags(value) {
    return value.split(",").map((t) => t.trim()).filter(Boolean);
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

  async function saveTags(photoId, value) {
    const res = await authFetch(`/api/photos/${photoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: value }),
    });
    if (!res.ok) throw new Error();
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
  async function uploadPhotos(files, tags) {
    const created = [];
    const failed = [];
    for (let i = 0; i < files.length; i += MAX_FILES_PER_REQUEST) {
      const chunk = files.slice(i, i + MAX_FILES_PER_REQUEST);
      try {
        const formData = new FormData();
        for (const file of chunk) formData.append("photos", file);
        formData.append("tags", tags);
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
    tagsField.value = photo.tags || "";
    tagsField.addEventListener("change", async () => {
      try {
        await saveTags(photo.id, tagsField.value);
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
    const addTagBtn = document.createElement("button");
    addTagBtn.type = "button";
    addTagBtn.className = "hs-btn";
    addTagBtn.textContent = "+";
    const appendTag = async () => {
      const newTags = splitTags(addTagInput.value);
      if (newTags.length === 0) return;
      const combined = withAppendedTags(tagsField.value, newTags);
      addTagBtn.disabled = true;
      try {
        await saveTags(photo.id, combined);
        tagsField.value = combined;
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
            const combined = withAppendedTags(tagsField.value, [t]);
            await saveTags(photo.id, combined);
            tagsField.value = combined;
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
        tr.remove();
      } catch {
        setStatus("Failed to delete photo.", "error");
      }
    });
    actions.appendChild(deleteBtn);
    actionsTd.appendChild(actions);
    tr.appendChild(actionsTd);

    return tr;
  }

  async function loadPhotos() {
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted">Loading…</td></tr>';
    try {
      const res = await authFetch("/api/photos");
      const photos = await res.json();
      tbody.innerHTML = "";
      if (photos.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-muted">No photos yet.</td></tr>';
        return;
      }
      for (const photo of photos) {
        tbody.appendChild(renderRow(photo));
      }
    } catch {
      tbody.innerHTML = '<tr><td colspan="4" class="status error">Failed to load photos.</td></tr>';
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!filesInput.files.length) return;

    uploadBtn.disabled = true;
    setStatus(`Uploading ${filesInput.files.length} photo(s)…`);
    try {
      const { created, failed } = await uploadPhotos([...filesInput.files], tagsInput.value);
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

  loadPhotos();
})();
