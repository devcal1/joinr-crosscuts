(function () {
  const input = document.getElementById("search-input");
  const grid = document.getElementById("grid");
  const resultCount = document.getElementById("result-count");
  const emptyState = document.getElementById("empty-state");
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightbox-img");
  const lightboxClose = document.getElementById("lightbox-close");

  let allPhotos = [];
  let fuse = null;

  function renderCount(n) {
    resultCount.textContent = `${n} ${n === 1 ? "photo" : "photos"}`;
  }

  function render(photos) {
    grid.innerHTML = "";
    for (const photo of photos) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.addEventListener("click", () => openLightbox(photo));

      const img = document.createElement("img");
      img.src = photo.thumbUrl;
      img.alt = photo.tags || "Job photo";
      img.loading = "lazy";
      if (photo.width && photo.height) {
        img.style.aspectRatio = `${photo.width} / ${photo.height}`;
      }
      tile.appendChild(img);

      if (photo.tags) {
        const cap = document.createElement("div");
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
    const q = input.value.trim();
    if (!q) {
      render(allPhotos);
      return;
    }
    const results = fuse.search(q).map((r) => r.item);
    render(results);
  }

  function openLightbox(photo) {
    lightboxImg.src = photo.url;
    lightboxImg.alt = photo.tags || "Job photo";
    lightbox.classList.add("open");
  }

  function closeLightbox() {
    lightbox.classList.remove("open");
    lightboxImg.src = "";
  }

  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  lightboxClose.addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });

  input.addEventListener("input", applyFilter);

  fetch("/api/photos")
    .then((res) => res.json())
    .then((photos) => {
      allPhotos = photos;
      fuse = new Fuse(allPhotos, {
        keys: ["tags"],
        threshold: 0.35,
        ignoreLocation: true,
      });
      // applyFilter, not render(allPhotos): honours anything typed while the
      // photos were still loading.
      applyFilter();
    })
    .catch(() => {
      resultCount.textContent = "Couldn't load photos.";
    });
})();
