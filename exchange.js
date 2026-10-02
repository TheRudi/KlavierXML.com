(() => {
  const DB_NAME = "klavierxml-exchange";
  const STORE = "scores";
  const MAX_BYTES = 50 * 1024;
  const MAX_FILES = 100;
  const ALLOWED = new Set(["xml", "musicxml", "mxl"]);
  const EXCHANGE_REPO = "TheRudi/KlavierXML.com";
  const EXCHANGE_BRANCHES = [
    window.KlavierExchangeConfig?.branch,
    "cursor/klavierxml-website-4be4",
    "main",
  ].filter(Boolean);

  const listEl = document.getElementById("exchange-list");
  const emptyEl = document.getElementById("library-empty");
  const statusEl = document.getElementById("upload-status");
  const form = document.getElementById("upload-form");
  const fileInput = document.getElementById("score-file");
  const fileNameEl = document.getElementById("file-name");
  const titleInput = document.getElementById("score-title");
  const composerInput = document.getElementById("score-composer");
  const searchInput = document.getElementById("library-search");
  const countEl = document.getElementById("library-count");
  const tabs = document.querySelectorAll(".library-tab");

  if (!listEl || !form) return;

  let builtin = [];
  let sharedScores = [];
  let localScores = [];
  let activeTab = "all";
  let query = "";
  let exchangeBranch = EXCHANGE_BRANCHES[0] || "main";

  const getPublishToken = () =>
    String(
      window.KlavierExchangeConfig?.token ||
        window.localStorage.getItem("klavierxml-exchange-token") ||
        ""
    ).trim();

  const githubHeaders = (token, extra = {}) => ({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  const resolveExchangeBranch = async () => {
    for (const branch of EXCHANGE_BRANCHES) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${EXCHANGE_REPO}/contents/exchange/shared-manifest.json?ref=${encodeURIComponent(branch)}`,
          { headers: githubHeaders(getPublishToken()) }
        );
        if (res.ok) {
          exchangeBranch = branch;
          return branch;
        }
      } catch (err) {
        // try next branch
      }
    }
    exchangeBranch = EXCHANGE_BRANCHES[0] || "main";
    return exchangeBranch;
  };

  const sharedFilePath = (id) => `exchange/files/${id}.mxl`;

  const sharedDownloadUrl = (item) =>
    item.file
      ? `exchange/${item.file}`
      : item.downloadUrl || `exchange/files/${item.id}.mxl`;

  const fetchSharedCatalog = async () => {
    // Prefer the live site copy so every visitor sees the same library.
    try {
      const localRes = await fetch(`exchange/shared-manifest.json?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (localRes.ok) {
        const data = await localRes.json();
        return {
          updated: data.updated || "",
          scores: Array.isArray(data.scores) ? data.scores.slice(0, MAX_FILES) : [],
          sha: null,
        };
      }
    } catch (err) {
      // Fall through to GitHub API.
    }

    await resolveExchangeBranch();
    const res = await fetch(
      `https://api.github.com/repos/${EXCHANGE_REPO}/contents/exchange/shared-manifest.json?ref=${encodeURIComponent(exchangeBranch)}`,
      { headers: githubHeaders(getPublishToken()), cache: "no-store" }
    );
    if (res.status === 404) return { updated: "", scores: [], sha: null };
    if (!res.ok) throw new Error("Could not load the shared exchange library.");
    const data = await res.json();
    const decoded = JSON.parse(atob(String(data.content || "").replace(/\n/g, "")));
    return {
      updated: decoded.updated || "",
      scores: Array.isArray(decoded.scores) ? decoded.scores.slice(0, MAX_FILES) : [],
      sha: data.sha || null,
    };
  };

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const base64 = result.includes(",") ? result.split(",")[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error("Could not read the score file."));
      reader.readAsDataURL(blob);
    });

  const githubPutContent = async (path, contentBase64, message, sha) => {
    const token = getPublishToken();
    if (!token) throw new Error("NO_TOKEN");
    await resolveExchangeBranch();
    const res = await fetch(
      `https://api.github.com/repos/${EXCHANGE_REPO}/contents/${path}`,
      {
        method: "PUT",
        headers: githubHeaders(token, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          message,
          content: contentBase64,
          branch: exchangeBranch,
          ...(sha ? { sha } : {}),
        }),
      }
    );
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(
        `Could not publish to GitHub (${res.status}). ${detail.slice(0, 180)}`
      );
    }
    return res.json();
  };

  const githubDeleteContent = async (path, message, sha) => {
    const token = getPublishToken();
    if (!token || !sha) return;
    await resolveExchangeBranch();
    await fetch(`https://api.github.com/repos/${EXCHANGE_REPO}/contents/${path}`, {
      method: "DELETE",
      headers: githubHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({ message, sha, branch: exchangeBranch }),
    });
  };

  const githubGetContentMeta = async (path) => {
    await resolveExchangeBranch();
    const res = await fetch(
      `https://api.github.com/repos/${EXCHANGE_REPO}/contents/${path}?ref=${encodeURIComponent(exchangeBranch)}`,
      { headers: githubHeaders(getPublishToken()), cache: "no-store" }
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return res.json();
  };

  const uploadPackageToDpaste = async (payload) => {
    const body = new URLSearchParams({
      content: JSON.stringify(payload),
      expiry_days: "365",
      format: "json",
    });
    const res = await fetch("https://dpaste.com/api/v2/", {
      method: "POST",
      body,
    });
    if (!res.ok) throw new Error("Could not stage the score for publishing.");
    const url = (await res.text()).trim();
    return url.endsWith(".txt") ? url : `${url}.txt`;
  };

  const openPublishIssue = (entry, packageUrl) => {
    const title = `exchange-upload: ${entry.title}`.slice(0, 80);
    const body = [
      "<!-- klavierxml-exchange-upload -->",
      "```json",
      JSON.stringify(
        {
          id: entry.id,
          title: entry.title,
          composer: entry.composer,
          credit: entry.credit,
          filename: entry.filename,
          format: "mxl",
          bytes: entry.bytes,
          added: entry.added,
          license: entry.license,
          packageUrl,
        },
        null,
        2
      ),
      "```",
      "",
      "This issue was opened from the MusicXML exchange upload form.",
    ].join("\n");
    const url = `https://github.com/${EXCHANGE_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const openRemoveIssue = (item) => {
    const title = `exchange-remove: ${item.id}`.slice(0, 80);
    const body = [
      "<!-- klavierxml-exchange-remove -->",
      "```json",
      JSON.stringify(
        {
          id: item.id,
          title: item.title,
        },
        null,
        2
      ),
      "```",
    ].join("\n");
    const url = `https://github.com/${EXCHANGE_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const publishSharedScore = async (entry, blob) => {
    const catalog = await fetchSharedCatalog();
    if (catalog.scores.length >= MAX_FILES) {
      throw new Error(
        `The shared exchange already has ${MAX_FILES} scores. Remove one before uploading another.`
      );
    }
    if (catalog.scores.some((score) => score.id === entry.id)) {
      return sharedDownloadUrl(entry);
    }

    const filePath = sharedFilePath(entry.id);
    const relativeFile = `files/${entry.id}.mxl`;
    const nextEntry = {
      id: entry.id,
      title: entry.title,
      composer: entry.composer,
      credit: entry.credit,
      filename: entry.filename,
      format: "mxl",
      bytes: entry.bytes,
      added: entry.added,
      file: relativeFile,
      license: entry.license,
    };
    const nextCatalog = {
      updated: new Date().toISOString().slice(0, 10),
      scores: [nextEntry, ...catalog.scores].slice(0, MAX_FILES),
    };

    try {
      const contentBase64 = await blobToBase64(blob);
      await githubPutContent(
        filePath,
        contentBase64,
        `exchange: add ${entry.filename}`
      );
      const manifestMeta = await githubGetContentMeta(
        "exchange/shared-manifest.json"
      );
      const catalogBase64 = btoa(
        unescape(encodeURIComponent(JSON.stringify(nextCatalog, null, 2)))
      );
      await githubPutContent(
        "exchange/shared-manifest.json",
        catalogBase64,
        `exchange: list ${entry.title}`,
        manifestMeta?.sha
      );
      sharedScores = nextCatalog.scores;
      return relativeFile;
    } catch (err) {
      if (!String(err.message || "").includes("NO_TOKEN") && getPublishToken()) {
        throw err;
      }
      // Tokenless fallback: stage the package publicly, then open a GitHub issue
      // that the exchange Action turns into a shared score for everyone.
      const packageUrl = await uploadPackageToDpaste({
        ...nextEntry,
        contentBase64: await blobToBase64(blob),
      });
      openPublishIssue(nextEntry, packageUrl);
      entry.pendingPackageUrl = packageUrl;
      throw new Error("CONFIRM_ISSUE");
    }
  };

  const removeSharedScore = async (item) => {
    try {
      const catalog = await fetchSharedCatalog();
      const nextScores = catalog.scores.filter((score) => score.id !== item.id);
      const nextCatalog = {
        updated: new Date().toISOString().slice(0, 10),
        scores: nextScores,
      };
      const fileMeta = await githubGetContentMeta(sharedFilePath(item.id));
      if (fileMeta?.sha) {
        await githubDeleteContent(
          sharedFilePath(item.id),
          `exchange: remove ${item.filename || item.id}`,
          fileMeta.sha
        );
      }
      const manifestMeta = await githubGetContentMeta(
        "exchange/shared-manifest.json"
      );
      const catalogBase64 = btoa(
        unescape(encodeURIComponent(JSON.stringify(nextCatalog, null, 2)))
      );
      await githubPutContent(
        "exchange/shared-manifest.json",
        catalogBase64,
        `exchange: unlist ${item.title || item.id}`,
        manifestMeta?.sha
      );
      sharedScores = nextScores;
    } catch (err) {
      if (!String(err.message || "").includes("NO_TOKEN") && getPublishToken()) {
        throw err;
      }
      openRemoveIssue(item);
      throw new Error("CONFIRM_ISSUE_REMOVE");
    }
  };

  const removeScore = async (item) => {
    const label = item.title || "this score";
    if (!window.confirm(`Remove “${label}” from the exchange?`)) return;

    try {
      if (item.source === "shared" || String(item.id || "").startsWith("shared-")) {
        try {
          await removeSharedScore(item);
        } catch (err) {
          if (String(err.message || "") === "CONFIRM_ISSUE_REMOVE") {
            setStatus(
              "Removal staged. Confirm the GitHub issue that just opened to remove it for everyone."
            );
            return;
          }
          throw err;
        }
      }
      if (localScores.some((score) => score.id === item.id)) {
        await deleteLocal(item.id);
        localScores = await loadLocal();
      }
      render();
      setStatus("Removed from the exchange.");
    } catch (err) {
      setStatus(err.message || "Could not remove that score.", "error");
    }
  };

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

  const stemFromFile = (name) =>
    String(name || "")
      .replace(/\.(xml|musicxml|mxl)$/i, "")
      .trim() || "score";

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

  const updateCount = () => {
    if (!countEl) return;
    countEl.textContent = `${sharedScores.length} shared · ${builtin.length} built-in · ${localScores.length} on this device · max ${MAX_FILES} shared`;
  };

  const matchesQuery = (item) => {
    if (!query) return true;
    const hay = `${item.title} ${item.composer} ${item.credit || ""}`.toLowerCase();
    return hay.includes(query);
  };

  const visibleItems = () => {
    const builtinItems = builtin.map((item) => ({
      ...item,
      source: "builtin",
    }));
    const sharedItems = sharedScores.map((item) => ({
      ...item,
      source: "shared",
    }));
    const localItems = localScores.map((item) => ({
      ...item,
      source: "local",
    }));

    let items;
    if (activeTab === "community") {
      items = [...sharedItems, ...builtinItems];
    } else if (activeTab === "local") {
      items = localItems;
    } else {
      const seen = new Set();
      items = [];
      [...sharedItems, ...localItems, ...builtinItems].forEach((item) => {
        const key = item.id || `${item.source}-${item.title}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push(item);
      });
    }
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

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };

  const u16 = (n) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return b;
  };

  const u32 = (n) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return b;
  };

  const concatBytes = (parts) => {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
      out.set(part, offset);
      offset += part.length;
    });
    return out;
  };

  const deflateRaw = async (bytes) => {
    if (typeof CompressionStream === "undefined") {
      throw new Error("This browser cannot compress MusicXML into MXL.");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(
      new CompressionStream("deflate-raw")
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  const encodeUtf8 = (text) => new TextEncoder().encode(text);

  const buildMxlArchive = async (scoreText) => {
    const container = `<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="score.xml">
    </rootfile>
  </rootfiles>
</container>
`;
    const entries = [
      ["META-INF/container.xml", encodeUtf8(container)],
      ["score.xml", encodeUtf8(scoreText)],
    ];

    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const [name, raw] of entries) {
      const nameBytes = encodeUtf8(name);
      const compressed = await deflateRaw(raw);
      const crc = crc32(raw);
      const local = concatBytes([
        u32(0x04034b50),
        u16(20),
        u16(0),
        u16(8),
        u16(0),
        u16(0),
        u32(crc),
        u32(compressed.length),
        u32(raw.length),
        u16(nameBytes.length),
        u16(0),
        nameBytes,
        compressed,
      ]);
      const central = concatBytes([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(8),
        u16(0),
        u16(0),
        u32(crc),
        u32(compressed.length),
        u32(raw.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]);
      locals.push(local);
      centrals.push(central);
      offset += local.length;
    }

    const localPart = concatBytes(locals);
    const centralPart = concatBytes(centrals);
    const eocd = concatBytes([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(entries.length),
      u16(entries.length),
      u32(centralPart.length),
      u32(localPart.length),
      u16(0),
    ]);
    return concatBytes([localPart, centralPart, eocd]);
  };

  const stripBom = (text) => text.replace(/^\uFEFF/, "");

  const normalizeMusicXml = (buffer) => {
    let text = stripBom(new TextDecoder().decode(buffer)).trim();
    if (!text) throw new Error("That file is empty.");

    // If the upload was already an MXL/ZIP, refuse here; caller handles .mxl.
    if (text.startsWith("PK")) {
      throw new Error("This looks like an MXL file. Upload it with a .mxl name.");
    }

    // Accept common MusicXML roots, with or without namespaces/DOCTYPE.
    const hasScore =
      /<score-partwise\b/i.test(text) ||
      /<score-timewise\b/i.test(text) ||
      /<!DOCTYPE\s+score-partwise\b/i.test(text) ||
      /<!DOCTYPE\s+score-timewise\b/i.test(text);

    if (!hasScore) {
      // Some exporters wrap the score; still try if it is XML-ish.
      if (!/^<\?xml\b/i.test(text) && !/^</.test(text)) {
        throw new Error("That file does not look like MusicXML.");
      }
      throw new Error(
        "That XML file does not contain a MusicXML score (score-partwise or score-timewise)."
      );
    }
    return text;
  };

  const xmlToMxl = async (xmlBuffer, originalName) => {
    const scoreText = normalizeMusicXml(xmlBuffer);
    const archive = await buildMxlArchive(scoreText);
    if (archive.length > MAX_BYTES) {
      throw new Error(
        "Converted MXL is larger than 50 KB. Use a smaller score."
      );
    }
    const filename = `${stemFromFile(originalName) || "score"}.mxl`;
    const blob = new Blob([archive], {
      type: "application/vnd.recordare.musicxml",
    });
    return { blob, filename, bytes: archive.length };
  };

  const prepareScoreFile = async (file, ext, buffer) => {
    if (ext === "mxl") {
      const bytes = new Uint8Array(buffer);
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        throw new Error("That .mxl file is not a valid MusicXML archive.");
      }
      if (bytes.length > MAX_BYTES) {
        throw new Error("That MXL file is larger than 50 KB.");
      }
      return {
        blob: new Blob([buffer], {
          type: file.type || "application/vnd.recordare.musicxml",
        }),
        filename: file.name.toLowerCase().endsWith(".mxl")
          ? file.name
          : `${stemFromFile(file.name)}.mxl`,
        bytes: bytes.length,
        converted: false,
      };
    }

    setStatus("Converting XML to MXL…");
    const converted = await xmlToMxl(buffer, file.name);

    // Verify the archive can be read the same way Klavier reads MXL files.
    if (window.KlavierPlayer?.unzipXml) {
      const xml = await window.KlavierPlayer.unzipXml(
        await converted.blob.arrayBuffer()
      );
      if (!/score-partwise|score-timewise/i.test(xml)) {
        throw new Error("Converted MXL could not be verified.");
      }
    }

    return { ...converted, converted: true };
  };

  const render = () => {
    const items = visibleItems();
    listEl.innerHTML = "";
    emptyEl.hidden = items.length > 0;
    updateCount();

    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "exchange-item";

      const meta = document.createElement("div");
      meta.className = "exchange-item-meta";

      const badge = document.createElement("span");
      badge.className = "exchange-badge";
      badge.textContent =
        item.source === "local"
          ? "On this device"
          : item.source === "shared"
            ? "Shared"
            : "Built-in";

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
          if (item.source === "local" && item.blob) {
            downloadBlob(item.blob, item.filename);
            return;
          }
          if (item.source === "shared") {
            const res = await fetch(sharedDownloadUrl(item));
            if (!res.ok) throw new Error("Download failed");
            downloadBlob(await res.blob(), item.filename || `${item.id}.mxl`);
            return;
          }
          const res = await fetch(`exchange/${item.file}`);
          if (!res.ok) throw new Error("Download failed");
          const blob = await res.blob();
          const name = item.file.split("/").pop();
          downloadBlob(blob, name);
        } catch (err) {
          setStatus(err.message || "Could not download that score.", "error");
        }
      });
      actions.append(downloadBtn);

      if (item.source === "local" || item.source === "shared") {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "btn btn-ghost";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => {
          removeScore(item);
        });
        actions.append(removeBtn);
      }

      li.append(meta, actions);
      listEl.append(li);
    });
  };

  const loadBuiltin = async () => {
    const res = await fetch("exchange/manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load the built-in library.");
    const data = await res.json();
    builtin = (Array.isArray(data.scores) ? data.scores : []).slice(0, MAX_FILES);
  };

  const loadShared = async () => {
    const catalog = await fetchSharedCatalog();
    sharedScores = catalog.scores;
  };

  const readFile = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });

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
      setStatus("That file is larger than 50 KB.", "error");
      return;
    }
    if (sharedScores.length >= MAX_FILES) {
      setStatus(
        `The shared exchange already has ${MAX_FILES} scores. Remove one before uploading another.`,
        "error"
      );
      return;
    }

    const title = (titleInput.value || titleFromFile(file.name)).trim();
    const composer = (composerInput.value || "").trim();

    try {
      setStatus(ext === "mxl" ? "Uploading…" : "Converting XML to MXL…");
      const buffer = await readFile(file);
      const prepared = await prepareScoreFile(file, ext, buffer);
      const id = `shared-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const record = {
        id,
        title,
        composer: composer || "Uploaded score",
        credit: prepared.converted
          ? "Converted to MXL · shared exchange"
          : "Shared exchange",
        filename: prepared.filename.endsWith(".mxl")
          ? prepared.filename
          : `${stemFromFile(prepared.filename)}.mxl`,
        format: "mxl",
        bytes: prepared.bytes,
        blob: prepared.blob,
        added: new Date().toISOString().slice(0, 10),
        license:
          "Uploaded by a community member. Only share files you have rights to distribute.",
      };

      setStatus("Publishing for everyone…");
      try {
        await publishSharedScore(record, prepared.blob);
      } catch (err) {
        if (String(err.message || "") === "CONFIRM_ISSUE") {
          // Keep a local copy so the uploader can still download immediately.
          localScores = await loadLocal();
          if (localScores.length >= MAX_FILES) {
            const oldest = [...localScores].sort((a, b) =>
              String(a.added).localeCompare(String(b.added))
            )[0];
            if (oldest) await deleteLocal(oldest.id);
          }
          await saveLocal(record);
          localScores = await loadLocal();
          activeTab = "local";
          tabs.forEach((tab) => {
            const on = tab.dataset.tab === "local";
            tab.classList.toggle("is-active", on);
            tab.setAttribute("aria-selected", on ? "true" : "false");
          });
          render();
          form.reset();
          fileNameEl.textContent = "No file chosen";
          setStatus(
            "Score staged. Confirm the GitHub issue that just opened to publish it for everyone."
          );
          // Watch for the Action to publish the shared score.
          let tries = 0;
          const poll = window.setInterval(async () => {
            tries += 1;
            try {
              await loadShared();
              render();
              if (sharedScores.some((score) => score.id === record.id)) {
                window.clearInterval(poll);
                activeTab = "community";
                tabs.forEach((tab) => {
                  const on = tab.dataset.tab === "community";
                  tab.classList.toggle("is-active", on);
                  tab.setAttribute("aria-selected", on ? "true" : "false");
                });
                render();
                setStatus(
                  "Published for everyone. Anyone can download it below."
                );
              }
            } catch (err) {
              // keep polling briefly
            }
            if (tries >= 24) window.clearInterval(poll);
          }, 5000);
          return;
        }
        throw err;
      }

      // Keep a local copy for faster re-download on this device.
      localScores = await loadLocal();
      if (localScores.length >= MAX_FILES) {
        const oldest = [...localScores].sort((a, b) =>
          String(a.added).localeCompare(String(b.added))
        )[0];
        if (oldest) await deleteLocal(oldest.id);
      }
      await saveLocal(record);
      localScores = await loadLocal();

      activeTab = "community";
      tabs.forEach((tab) => {
        const on = tab.dataset.tab === "community";
        tab.classList.toggle("is-active", on);
        tab.setAttribute("aria-selected", on ? "true" : "false");
      });
      render();

      form.reset();
      fileNameEl.textContent = "No file chosen";
      const convertedNote = prepared.converted ? " Converted to MXL." : "";
      setStatus(
        `Published for everyone. Anyone can download it below.${convertedNote}`
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
        loadBuiltin().catch(() => {
          builtin = [];
        }),
        loadShared().catch(() => {
          sharedScores = [];
        }),
        loadLocal()
          .then(async (rows) => {
            if (rows.length > MAX_FILES) {
              const sorted = [...rows].sort((a, b) =>
                String(b.added || "").localeCompare(String(a.added || ""))
              );
              const keep = new Set(
                sorted.slice(0, MAX_FILES).map((item) => item.id)
              );
              await Promise.all(
                rows
                  .filter((item) => !keep.has(item.id))
                  .map((item) => deleteLocal(item.id))
              );
              localScores = await loadLocal();
            } else {
              localScores = rows;
            }
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
