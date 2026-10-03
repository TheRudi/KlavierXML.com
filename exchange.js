(() => {
  const DB_NAME = "klavierxml-exchange";
  const STORE = "scores";
  const MAX_MXL_BYTES = 100 * 1024;
  const MAX_XML_BYTES = 1024 * 1024 * 1024;
  const MAX_FILES = 100;
  const ALLOWED = new Set(["xml", "musicxml", "mxl"]);
  const REMOVE_PASSWORD = "Kla4FürW3n1ger€";
  const STORAGE_BUCKET = "exchange";

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
  const adminPasswordInput = document.getElementById("admin-password");

  if (!listEl || !form) return;

  let builtin = [];
  let sharedScores = [];
  let localScores = [];
  let query = "";
  let supabaseClient = null;

  const canShowRemove = () =>
    String(adminPasswordInput?.value || "") === REMOVE_PASSWORD;

  const getSupabaseConfig = () => {
    const url = String(window.KlavierExchangeConfig?.supabaseUrl || "").trim();
    const anonKey = String(
      window.KlavierExchangeConfig?.supabaseAnonKey || ""
    ).trim();
    return { url, anonKey };
  };

  const getSupabase = () => {
    if (supabaseClient) return supabaseClient;
    const { url, anonKey } = getSupabaseConfig();
    if (!url || !anonKey) return null;
    if (!window.supabase?.createClient) {
      throw new Error("Supabase library failed to load. Refresh and try again.");
    }
    supabaseClient = window.supabase.createClient(url, anonKey);
    return supabaseClient;
  };

  const requireSupabase = () => {
    const client = getSupabase();
    if (!client) {
      throw new Error(
        "Supabase is not configured yet. Add supabaseUrl and supabaseAnonKey to exchange-config.js."
      );
    }
    return client;
  };

  const storagePathFor = (id) => `files/${id}.mxl`;

  const rowToScore = (row) => ({
    id: row.id,
    title: row.title,
    composer: row.composer,
    credit: row.credit || "",
    filename: row.filename,
    format: row.format || "mxl",
    bytes: row.bytes || 0,
    added: row.added || "",
    file: row.storage_path || storagePathFor(row.id),
    license: row.license || "",
    storage_path: row.storage_path || storagePathFor(row.id),
  });

  const fetchSharedBlob = async (item) => {
    const client = requireSupabase();
    const path = item.storage_path || item.file || storagePathFor(item.id);
    const { data, error } = await client.storage.from(STORAGE_BUCKET).download(path);
    if (error || !data) {
      throw new Error(error?.message || "Download failed");
    }
    return data;
  };

  const fetchSharedCatalog = async () => {
    const client = getSupabase();
    if (!client) {
      return { scores: [] };
    }
    const { data, error } = await client
      .from("exchange_scores")
      .select(
        "id, title, composer, credit, filename, format, bytes, added, license, storage_path"
      )
      .order("created_at", { ascending: false })
      .limit(MAX_FILES);
    if (error) {
      throw new Error(error.message || "Could not load the shared exchange library.");
    }
    return {
      scores: (Array.isArray(data) ? data : []).map(rowToScore),
    };
  };

  const publishSharedScore = async (entry, blob) => {
    const client = requireSupabase();
    const catalog = await fetchSharedCatalog();
    if (catalog.scores.length >= MAX_FILES) {
      throw new Error(
        `The shared exchange already has ${MAX_FILES} scores. Remove one before uploading another.`
      );
    }
    if (catalog.scores.some((score) => score.id === entry.id)) {
      sharedScores = catalog.scores;
      return true;
    }

    const storagePath = storagePathFor(entry.id);
    const { error: uploadError } = await client.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, blob, {
        contentType: "application/vnd.recordare.musicxml",
        upsert: false,
      });
    if (uploadError) {
      throw new Error(uploadError.message || "Could not upload the score file.");
    }

    const row = {
      id: entry.id,
      title: entry.title,
      composer: entry.composer,
      credit: entry.credit,
      filename: entry.filename,
      format: "mxl",
      bytes: entry.bytes,
      added: entry.added,
      license: entry.license,
      storage_path: storagePath,
    };
    const { error: insertError } = await client.from("exchange_scores").insert(row);
    if (insertError) {
      await client.storage.from(STORAGE_BUCKET).remove([storagePath]);
      throw new Error(insertError.message || "Could not publish the score listing.");
    }

    sharedScores = [rowToScore(row), ...catalog.scores].slice(0, MAX_FILES);
    return true;
  };

  const removeSharedScore = async (item) => {
    const client = requireSupabase();
    const path = item.storage_path || item.file || storagePathFor(item.id);
    const { error: dbError } = await client
      .from("exchange_scores")
      .delete()
      .eq("id", item.id);
    if (dbError) {
      throw new Error(dbError.message || "Could not remove that score.");
    }
    await client.storage.from(STORAGE_BUCKET).remove([path]);
    sharedScores = sharedScores.filter((score) => score.id !== item.id);
  };

  const removeScore = async (item) => {
    const label = item.title || "this score";
    if (!window.confirm(`Remove “${label}” from the exchange?`)) return;

    try {
      if (item.source === "shared") {
        await removeSharedScore(item);
        render();
        setStatus("Removed from the exchange.");
        return;
      }
      setStatus("Built-in scores cannot be removed.", "error");
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
    const total = visibleItems().length;
    countEl.textContent = `${total} score${total === 1 ? "" : "s"} · max ${MAX_FILES}`;
  };

  const matchesQuery = (item) => {
    if (!query) return true;
    const hay = `${item.title} ${item.composer} ${item.credit || ""}`.toLowerCase();
    return hay.includes(query);
  };

  const visibleItems = () => {
    // Same library on every browser/device: shared catalog + built-ins only.
    // Per-browser IndexedDB copies are a download cache, not a separate list.
    const items = [
      ...sharedScores.map((item) => ({ ...item, source: "shared" })),
      ...builtin.map((item) => ({ ...item, source: "builtin" })),
    ];
    const seen = new Set();
    return items.filter((item) => {
      const key = item.id || `${item.source}-${item.title}-${item.file || item.filename}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return matchesQuery(item);
    });
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
    if (archive.length > MAX_MXL_BYTES) {
      throw new Error(
        "Converted MXL is larger than 100 KB. Use a smaller score."
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
      if (bytes.length > MAX_MXL_BYTES) {
        throw new Error("That MXL file is larger than 100 KB.");
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
        item.source === "shared" ? "Shared" : "Built-in";

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
            const cached = localScores.find((row) => row.id === item.id && row.blob);
            if (cached?.blob) {
              downloadBlob(cached.blob, item.filename || `${item.id}.mxl`);
              return;
            }
            downloadBlob(
              await fetchSharedBlob(item),
              item.filename || `${item.id}.mxl`
            );
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

      if (canShowRemove() && item.source === "shared") {
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
    if (ext === "mxl" && file.size > MAX_MXL_BYTES) {
      setStatus("That MXL file is larger than 100 KB.", "error");
      return;
    }
    if ((ext === "xml" || ext === "musicxml") && file.size > MAX_XML_BYTES) {
      setStatus("That XML file is larger than 1 GB.", "error");
      return;
    }
    if (sharedScores.length >= MAX_FILES) {
      setStatus(
        `The shared library already has ${MAX_FILES} scores. Remove one before uploading another.`,
        "error"
      );
      return;
    }

    const title = (titleInput.value || "").trim();
    const composer = (composerInput.value || "").trim();
    if (title.length < 2) {
      setStatus("Title must be at least 2 characters.", "error");
      titleInput.focus();
      return;
    }
    if (composer.length < 2) {
      setStatus("Composer must be at least 2 characters.", "error");
      composerInput.focus();
      return;
    }

    try {
      setStatus(ext === "mxl" ? "Uploading…" : "Converting XML to MXL…");
      const buffer = await readFile(file);
      const prepared = await prepareScoreFile(file, ext, buffer);
      const id = `shared-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const record = {
        id,
        title,
        composer,
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
      const publishedShared = await publishSharedScore(record, prepared.blob);
      if (!publishedShared) {
        throw new Error("Could not publish this score for everyone. Try again.");
      }

      // Local cache only — the visible library is always the shared catalog.
      localScores = await loadLocal();
      if (localScores.length >= MAX_FILES) {
        const oldest = [...localScores].sort((a, b) =>
          String(a.added).localeCompare(String(b.added))
        )[0];
        if (oldest) await deleteLocal(oldest.id);
      }
      await saveLocal(record);
      localScores = await loadLocal();
      await loadShared().catch(() => {});

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

  searchInput?.addEventListener("input", () => {
    query = searchInput.value.trim().toLowerCase();
    render();
  });

  adminPasswordInput?.addEventListener("input", () => {
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
