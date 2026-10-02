(() => {
  const DB_NAME = "klavierxml-exchange";
  const STORE = "scores";
  const MAX_BYTES = 8 * 1024 * 1024;
  const ALLOWED = new Set(["xml", "musicxml", "mxl"]);

  const listEl = document.getElementById("exchange-list");
  const emptyEl = document.getElementById("library-empty");
  const statusEl = document.getElementById("upload-status");
  const form = document.getElementById("upload-form");
  const fileInput = document.getElementById("score-file");
  const fileNameEl = document.getElementById("file-name");
  const titleInput = document.getElementById("score-title");
  const composerInput = document.getElementById("score-composer");
  const shareInput = document.getElementById("score-share");
  const searchInput = document.getElementById("library-search");
  const tabs = document.querySelectorAll(".library-tab");

  if (!listEl || !form) return;

  let community = [];
  let localScores = [];
  let activeTab = "all";
  let query = "";

  const formatBytes = (n) => {
    if (!n && n !== 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  const extensionOf = (name) => {
    const parts = String(name || "").toLowerCase().split(".");
    return parts.length > 1 ? parts.pop() : "";
  };

  const titleFromFile = (name) =>
    String(name || "")
      .replace(/\.(xml|musicxml|mxl)$/i, "")
      .replace(/[_-]+/g, " ")
      .trim() || "Untitled score";

  const openDb = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  const withStore = async (mode, fn) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  };

  const loadLocal = async () => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  };

  const saveLocal = (record) =>
    withStore("readwrite", (store) => {
      store.put(record);
    });

  const deleteLocal = (id) =>
    withStore("readwrite", (store) => {
      store.delete(id);
    });

  const setStatus = (message, kind = "") => {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.dataset.kind = kind;
  };

  const matchesQuery = (item) => {
    if (!query) return true;
    const hay = `${item.title} ${item.composer} ${item.credit || ""}`.toLowerCase();
    return hay.includes(query);
  };

  const visibleItems = () => {
    const communityItems = community.map((item) => ({
      ...item,
      source: "community",
    }));
    const localItems = localScores.map((item) => ({
      ...item,
      source: "local",
    }));
    let items =
      activeTab === "community"
        ? communityItems
        : activeTab === "local"
          ? localItems
          : [...localItems, ...communityItems];
    return items.filter(matchesQuery);
  };

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const render = () => {
    const items = visibleItems();
    listEl.innerHTML = "";
    emptyEl.hidden = items.length > 0;

    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "exchange-item";

      const meta = document.createElement("div");
      meta.className = "exchange-item-meta";

      const badge = document.createElement("span");
      badge.className = "exchange-badge";
      badge.textContent =
        item.source === "local" ? "On this device" : "Community";

      const title = document.createElement("h3");
      title.textContent = item.title;

      const detail = document.createElement("p");
      const bits = [
        item.composer,
        item.credit,
        (item.format || extensionOf(item.filename || item.file) || "").toUpperCase(),
        formatBytes(item.bytes),
      ].filter(Boolean);
      detail.textContent = bits.join(" · ");

      meta.append(badge, title, detail);
      if (item.license) {
        const license = document.createElement("p");
        license.className = "exchange-license";
        license.textContent = item.license;
        meta.append(license);
      }

      const actions = document.createElement("div");
      actions.className = "exchange-item-actions";

      const downloadBtn = document.createElement("button");
      downloadBtn.type = "button";
      downloadBtn.className = "btn btn-primary";
      downloadBtn.textContent = "Download";
      downloadBtn.addEventListener("click", async () => {
        try {
          if (item.source === "local") {
            downloadBlob(item.blob, item.filename);
          } else {
            const res = await fetch(`exchange/${item.file}`);
            if (!res.ok) throw new Error("Download failed");
            const blob = await res.blob();
            const name = item.file.split("/").pop();
            downloadBlob(blob, name);
          }
        } catch (err) {
          setStatus(err.message || "Could not download that score.", "error");
        }
      });
      actions.append(downloadBtn);

      if (item.source === "local") {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "btn btn-ghost";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", async () => {
          await deleteLocal(item.id);
          localScores = await loadLocal();
          render();
          setStatus("Removed from this device.");
        });
        actions.append(removeBtn);
      }

      li.append(meta, actions);
      listEl.append(li);
    });
  };

  const loadCommunity = async () => {
    const res = await fetch("exchange/manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load the community library.");
    const data = await res.json();
    community = Array.isArray(data.scores) ? data.scores : [];
  };

  const readFile = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });

  const maybeEmailShare = async (file, title, composer) => {
    if (!shareInput?.checked) return false;
    const body = new FormData();
    body.append("_subject", `KlavierXML exchange upload: ${title}`);
    body.append(
      "message",
      `A MusicXML/MXL score was offered to the community library.\n\nTitle: ${title}\nComposer/credit: ${composer || "(none)"}\nFilename: ${file.name}\nSize: ${file.size} bytes\n`
    );
    body.append("score", file, file.name);
    body.append("_template", "table");
    body.append("_captcha", "false");

    const res = await fetch("https://formsubmit.co/ajax/rudilueg@gmail.com", {
      method: "POST",
      body,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        "Saved on this device, but sending for community review failed. Email rudilueg@gmail.com instead."
      );
    }
    return true;
  };

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileNameEl.textContent = file ? file.name : "No file chosen";
    if (file && !titleInput.value) titleInput.value = titleFromFile(file.name);
  });

  form.addEventListener("reset", () => {
    window.setTimeout(() => {
      fileNameEl.textContent = "No file chosen";
    }, 0);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = fileInput.files?.[0];
    if (!file) {
      setStatus("Choose an XML or MXL file first.", "error");
      return;
    }

    const ext = extensionOf(file.name);
    if (!ALLOWED.has(ext)) {
      setStatus("Only .xml, .musicxml, and .mxl files are accepted.", "error");
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus("That file is larger than 8 MB.", "error");
      return;
    }

    const title = (titleInput.value || titleFromFile(file.name)).trim();
    const composer = (composerInput.value || "").trim();

    try {
      setStatus("Uploading…");
      const buffer = await readFile(file);
      const blob = new Blob([buffer], { type: file.type || "application/octet-stream" });
      const record = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        composer: composer || "Uploaded score",
        credit: "Saved on this device",
        filename: file.name,
        format: ext,
        bytes: file.size,
        blob,
        added: new Date().toISOString().slice(0, 10),
        license: "Uploaded by you. Only share files you have rights to distribute.",
      };
      await saveLocal(record);
      localScores = await loadLocal();
      activeTab = "local";
      tabs.forEach((tab) => {
        const on = tab.dataset.tab === "local";
        tab.classList.toggle("is-active", on);
        tab.setAttribute("aria-selected", on ? "true" : "false");
      });
      render();

      let shared = false;
      try {
        shared = await maybeEmailShare(file, title, composer);
      } catch (err) {
        form.reset();
        fileNameEl.textContent = "No file chosen";
        setStatus(err.message, "error");
        return;
      }

      form.reset();
      fileNameEl.textContent = "No file chosen";
      setStatus(
        shared
          ? "Saved on this device and sent for community review."
          : "Saved on this device. You can download it below."
      );
    } catch (err) {
      setStatus(err.message || "Upload failed.", "error");
    }
  });

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab || "all";
      tabs.forEach((other) => {
        const on = other === tab;
        other.classList.toggle("is-active", on);
        other.setAttribute("aria-selected", on ? "true" : "false");
      });
      render();
    });
  });

  searchInput?.addEventListener("input", () => {
    query = searchInput.value.trim().toLowerCase();
    render();
  });

  (async () => {
    try {
      await Promise.all([
        loadCommunity().catch(() => {
          community = [];
        }),
        loadLocal()
          .then((rows) => {
            localScores = rows;
          })
          .catch(() => {
            localScores = [];
          }),
      ]);
      render();
    } catch (err) {
      setStatus(err.message || "Could not open the exchange.", "error");
    }
  })();
})();
