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

  const TOP_TAGS = 20;

  const input = document.getElementById("search-input");
  const grid = document.getElementById("grid");
  const resultCount = document.getElementById("result-count");
  const emptyState = document.getElementById("empty-state");
  const chipBar = document.getElementById("tg-chips");
  const lightbox = document.getElementById("lightbox");
  const lightboxDialog = document.getElementById("lightbox-dialog");
  const lightboxImg = document.getElementById("lightbox-img");
  const lightboxClose = document.getElementById("lightbox-close");

  let allPhotos = [];
  let fuse = null;
  let tagCounts = []; // [{tag, count}] from /api/photos/tags, most used first
  const selected = new Set(); // chosen tags (all must match)
  let showAllTags = false;
  let lastFocus = null; // the tile that opened the lightbox

  // The same rule as lib/tags.js splitTags: trim, lowercase, drop empties, de-duplicate.
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

  function renderCount(n) {
    resultCount.textContent = `${n} ${n === 1 ? "photo" : "photos"}`;
  }

  // — tag chips —
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
      applyFilter();
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
      chipBar.hidden = true;
      return;
    }
    chipBar.hidden = false;
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
      more.textContent = showAllTags ? "Fewer tags" : `All tags (${tagCounts.length})`;
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
        applyFilter();
        const first = chipBar.querySelector(".tg-chip");
        if (first) first.focus();
      });
      chipBar.appendChild(clear);
    }
  }

  // — photo tiles —
  function render(photos) {
    grid.innerHTML = "";
    for (const photo of photos) {
      // A real button, so Tab, Enter and Space open the photo.
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "tile";
      tile.setAttribute("aria-label", photo.tags || "Job photo");
      tile.addEventListener("click", () => openLightbox(photo, tile));

      const img = document.createElement("img");
      img.src = photo.thumbUrl;
      img.alt = "";
      img.loading = "lazy";
      if (photo.width && photo.height) {
        img.style.aspectRatio = `${photo.width} / ${photo.height}`;
      }
      tile.appendChild(img);

      if (photo.tags) {
        const cap = document.createElement("span");
        cap.className = "tile-cap";
        cap.textContent = photo.tags;
        tile.appendChild(cap);
      }

      grid.appendChild(tile);
    }

    renderCount(photos.length);
    grid.style.display = photos.length ? "" : "none";
    emptyState.style.display = photos.length ? "none" : "block";
  }

  function applyFilter() {
    if (!fuse) return; // photos still loading (or failed to) — nothing to search yet
    // The chosen tags narrow the set first (every one must match)...
    let pool = allPhotos;
    if (selected.size > 0) {
      pool = allPhotos.filter((p) => {
        const own = splitTags(p.tags);
        for (const t of selected) if (!own.includes(t)) return false;
        return true;
      });
    }
    // ...then the fuzzy search ranks within that set.
    const q = input.value.trim();
    if (!q) {
      render(pool);
      return;
    }
    const inPool = new Set(pool);
    render(fuse.search(q).map((r) => r.item).filter((p) => inPool.has(p)));
  }

  // — lightbox —
  function isOpen() {
    return lightbox.classList.contains("open");
  }

  function setBackgroundInert(on) {
    for (const el of document.querySelectorAll(".hero, .results")) el.inert = on;
  }

  function openLightbox(photo, tile) {
    lastFocus = tile || document.activeElement;
    lightboxImg.src = photo.url;
    lightboxImg.alt = photo.tags || "Job photo";
    lightboxDialog.setAttribute("aria-label", photo.tags || "Job photo");
    lightbox.classList.add("open");
    setBackgroundInert(true);
    lightboxClose.focus();
  }

  function closeLightbox() {
    if (!isOpen()) return;
    lightbox.classList.remove("open");
    lightboxImg.src = "";
    setBackgroundInert(false);
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  lightboxClose.addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if (!isOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeLightbox();
    } else if (e.key === "Tab") {
      // Close is the only control inside the dialog: keep focus on it.
      e.preventDefault();
      lightboxClose.focus();
    }
  });

  input.addEventListener("input", applyFilter);

  // The tag counts are a nicety: if they fail, the search still works.
  const tagsReady = authFetch("/api/photos/tags")
    .then((res) => (res.ok ? res.json() : []))
    .then((rows) => {
      tagCounts = Array.isArray(rows) ? rows : [];
    })
    .catch(() => {
      tagCounts = [];
    });

  authFetch("/api/photos")
    .then((res) => res.json())
    .then(async (photos) => {
      allPhotos = photos;
      fuse = new Fuse(allPhotos, {
        keys: ["tags"],
        threshold: 0.35,
        ignoreLocation: true,
      });
      await tagsReady;
      renderChips();
      // applyFilter, not render(allPhotos): honours anything typed while the
      // photos were still loading.
      applyFilter();
    })
    .catch(() => {
      resultCount.textContent = "Couldn't load photos.";
    });
})();
