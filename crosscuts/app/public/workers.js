(function () {
  const listEl = document.getElementById("workerList");
  const newNameInput = document.getElementById("newWorkerName");
  const addBtn = document.getElementById("addWorkerBtn");

  // api(), toast(), guarded(), hueColors() now live in shared.js, loaded before this file.

  async function loadWorkers() {
    const workers = await api("/api/workers");
    render(workers);
  }

  function render(workers) {
    listEl.innerHTML = "";
    for (const w of workers) {
      const row = document.createElement("div");
      row.className = "worker-row" + (w.archived ? " archived" : "");

      const swatch = document.createElement("div");
      swatch.className = "swatch";
      swatch.style.background = w.bg;
      row.appendChild(swatch);

      const nameInput = document.createElement("input");
      nameInput.className = "input";
      nameInput.type = "text";
      nameInput.value = w.name;
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") nameInput.blur();
      });
      nameInput.addEventListener("blur", guarded(async () => {
        const value = nameInput.value.trim();
        if (!value || value === w.name) {
          nameInput.value = w.name;
          return;
        }
        await api(`/api/workers/${w.id}`, { method: "PATCH", body: JSON.stringify({ name: value }) });
        await loadWorkers();
      }));
      row.appendChild(nameInput);

      const hueWrap = document.createElement("div");
      hueWrap.className = "hue-row";
      const hueInput = document.createElement("input");
      hueInput.type = "range";
      hueInput.min = 0;
      hueInput.max = 359;
      hueInput.value = w.hue;
      hueInput.addEventListener("input", () => {
        swatch.style.background = hueColors(Number(hueInput.value)).bg;
      });
      hueInput.addEventListener("change", guarded(async () => {
        await api(`/api/workers/${w.id}`, { method: "PATCH", body: JSON.stringify({ hue: Number(hueInput.value) }) });
        await loadWorkers();
      }));
      hueWrap.appendChild(hueInput);
      row.appendChild(hueWrap);

      const archiveBtn = document.createElement("button");
      archiveBtn.type = "button";
      archiveBtn.className = "btn btn-secondary";
      archiveBtn.textContent = w.archived ? "Restore" : "Archive";
      archiveBtn.addEventListener("click", guarded(async () => {
        await api(`/api/workers/${w.id}`, { method: "PATCH", body: JSON.stringify({ archived: !w.archived }) });
        await loadWorkers();
      }));
      row.appendChild(archiveBtn);

      listEl.appendChild(row);
    }
  }

  const addWorker = guarded(async () => {
    const name = newNameInput.value.trim();
    if (!name) return;
    await api("/api/workers", { method: "POST", body: JSON.stringify({ name }) });
    newNameInput.value = "";
    await loadWorkers();
  });
  addBtn.addEventListener("click", addWorker);
  newNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addWorker();
  });

  loadWorkers().catch((e) => {
    listEl.textContent = `Couldn't load workers: ${e.message}`;
  });
})();
