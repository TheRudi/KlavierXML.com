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
  const rightsInput = document.getElementById("upload-rights");
  const uploadSubmitBtn = document.getElementById("upload-submit");
  const uploadMultiBtn = document.getElementById("upload-multi");
  const searchInput = document.getElementById("library-search");
  const composerSelect = document.getElementById("library-composer");
  const scrollLimitInput = document.getElementById("library-scroll-limit");
  const scrollLimitLabelEl = document.getElementById("library-scroll-label");
  const songCountEl = document.getElementById("library-song-count");
  const countEl = document.getElementById("library-count");
  const totalEl = document.getElementById("library-total");
  const pagerEl = document.getElementById("library-pager");
  const pagerStatusEl = document.getElementById("library-pager-status");
  const prevPageBtn = document.getElementById("library-prev");
  const nextPageBtn = document.getElementById("library-next");
  const adminPasswordInput = document.getElementById("admin-password");
  const SCROLL_LIMIT_STORAGE_KEY = "klavierxml-exchange-scroll-limit";
  const SCROLL_LIMIT_ALL = 1010;
  const viewerEl = document.getElementById("score-viewer");
  const viewerTitleEl = document.getElementById("score-viewer-title");
  const viewerMetaEl = document.getElementById("score-viewer-meta");
  const viewerStatusEl = document.getElementById("score-viewer-status");
  const viewerPageEl = document.getElementById("score-viewer-page");
  const viewerCloseBtn = document.getElementById("score-viewer-close");
  const viewerCloseBackdrop = document.getElementById("score-viewer-close-backdrop");

  if (!listEl || !form) return;

  let builtin = [];
  let sharedScores = [];
  let localScores = [];
  let titleQuery = "";
  let composerFilter = "";
  let scrollLimit = 20;
  let listOffset = 0;
  let supabaseClient = null;
  let osmd = null;
  let viewerRequestId = 0;
  const blobCache = new Map();

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  const networkErrorMessage = (err) => {
    const msg = String(err?.message || err || "");
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
      return "Could not reach the score server. Check your connection and try again.";
    }
    return msg || "Could not load that score.";
  };

  const fetchWithRetry = async (url, options = {}, attempts = 3) => {
    let lastError;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const res = await fetch(url, options);
        if (!res.ok && res.status >= 500 && i < attempts - 1) {
          await sleep(250 * (i + 1));
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (i < attempts - 1) await sleep(250 * (i + 1));
      }
    }
    throw lastError || new Error("Failed to fetch");
  };

  const readStoredScrollLimit = () => {
    try {
      const raw = localStorage.getItem(SCROLL_LIMIT_STORAGE_KEY);
      if (raw == null) return 20;
      const n = Number(raw);
      if (!Number.isFinite(n)) return 20;
      if (n >= SCROLL_LIMIT_ALL) return SCROLL_LIMIT_ALL;
      return Math.min(1000, Math.max(20, Math.round(n / 10) * 10));
    } catch (_) {
      return 20;
    }
  };

  const syncScrollLimitUi = () => {
    const isAll = scrollLimit >= SCROLL_LIMIT_ALL;
    const valueText = isAll ? "Show all songs" : `Show ${scrollLimit} songs`;
    if (scrollLimitInput) {
      scrollLimitInput.value = String(scrollLimit);
      scrollLimitInput.setAttribute("aria-valuetext", valueText);
    }
    if (scrollLimitLabelEl) {
      scrollLimitLabelEl.textContent = valueText;
    }
  };

  scrollLimit = readStoredScrollLimit();
  syncScrollLimitUi();

  /** Fold accents/umlauts/diaeresis/cedilla so "fur" matches "für", "Noel" matches "Noël". */
  const foldText = (text) =>
    String(text || "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/ß/g, "ss")
      .replace(/ẞ/g, "ss")
      .toLowerCase();

  // "Ludwig van Beethoven" → beethoven, "Wolfgang Amadeus Mozart" → mozart
  const COMPOSER_NAME_NOISE =
    /^(van|von|de|del|der|den|la|le|di|da|du|des|dos|das|st|ste|jr|sr|ii|iii|iv)$/;

  const composerLastName = (composer) => {
    const parts = foldText(composer)
      .split(/[^a-z0-9]+/)
      .filter((part) => part && !COMPOSER_NAME_NOISE.test(part));
    return parts.length ? parts[parts.length - 1] : "";
  };

  const sameComposerLastName = (a, b) => {
    const left = composerLastName(a);
    const right = composerLastName(b);
    return Boolean(left) && left === right;
  };

  const titleWords = (title) =>
    foldText(title)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 2);

  /** Share of candidate title words that also appear in the other title. */
  const titleOverlapRatio = (candidateTitle, otherTitle) => {
    const a = titleWords(candidateTitle);
    const b = new Set(titleWords(otherTitle));
    if (!a.length || !b.size) return 0;
    let hits = 0;
    a.forEach((word) => {
      if (b.has(word)) hits += 1;
    });
    return hits / a.length;
  };

  const findSimilarExchangeScore = (title, composer, catalog = catalogItems()) => {
    if (!composerLastName(composer)) return null;
    let best = null;
    catalog.forEach((item) => {
      if (!sameComposerLastName(composer, item.composer)) return;
      const ratio = titleOverlapRatio(title, item.title);
      if (ratio < 0.5) return;
      if (!best || ratio > best.ratio) {
        best = { item, ratio };
      }
    });
    return best;
  };

  const confirmSimilarUpload = (title, composer, similar) => {
    const existing = `${similar.item.composer} — ${similar.item.title}`;
    const incoming = `${composer} — ${title}`;
    return window.confirm(
      `Upload this song: ${incoming}?\n\nIt looks very similar to ${existing} on the exchange server.`
    );
  };

  const canShowRemove = () =>
    String(adminPasswordInput?.value || "") === REMOVE_PASSWORD;

  const getApiBase = () =>
    String(window.KlavierExchangeConfig?.apiBase || "").trim().replace(/\/$/, "");

  const usesPhpApi = () => Boolean(getApiBase());

  const getSupabaseConfig = () => {
    const url = String(window.KlavierExchangeConfig?.supabaseUrl || "").trim();
    const anonKey = String(
      window.KlavierExchangeConfig?.supabaseAnonKey || ""
    ).trim();
    return { url, anonKey };
  };

  const getSupabase = () => {
    if (usesPhpApi()) return null;
    if (supabaseClient) return supabaseClient;
    const { url, anonKey } = getSupabaseConfig();
    if (!url || !anonKey) return null;
    if (!window.supabase?.createClient) {
      throw new Error("Supabase library failed to load. Refresh and try again.");
    }
    supabaseClient = window.supabase.createClient(url, anonKey);
    return supabaseClient;
  };

  const requireSharedBackend = () => {
    if (usesPhpApi()) return "php";
    const client = getSupabase();
    if (!client) {
      throw new Error(
        "Exchange backend is not configured. Set apiBase (PHP) or supabaseUrl/supabaseAnonKey in exchange-config.js."
      );
    }
    return "supabase";
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
    const cacheKey = `shared:${item.id}`;
    if (blobCache.has(cacheKey)) return blobCache.get(cacheKey);

    if (usesPhpApi()) {
      let lastError;
      for (let i = 0; i < 3; i += 1) {
        try {
          const res = await fetchWithRetry(
            `${getApiBase()}/file.php?id=${encodeURIComponent(item.id)}`,
            { cache: "force-cache" },
            1
          );
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(text || `Download failed (${res.status})`);
          }
          const blob = await res.blob();
          blobCache.set(cacheKey, blob);
          return blob;
        } catch (err) {
          lastError = err;
          if (i < 2) await sleep(300 * (i + 1));
        }
      }
      throw new Error(networkErrorMessage(lastError));
    }
    const client = getSupabase();
    if (!client) throw new Error("Exchange backend is not configured.");
    const path = item.storage_path || item.file || storagePathFor(item.id);
    const { data, error } = await client.storage.from(STORAGE_BUCKET).download(path);
    if (error || !data) {
      throw new Error(networkErrorMessage(error) || "Download failed");
    }
    blobCache.set(cacheKey, data);
    return data;
  };

  const fetchSharedCatalog = async () => {
    if (usesPhpApi()) {
      const res = await fetch(`${getApiBase()}/exchange.php`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Could not load the shared exchange library.");
      }
      const body = await res.json();
      return {
        scores: (Array.isArray(body.scores) ? body.scores : []).map(rowToScore),
      };
    }
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
    requireSharedBackend();
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

    if (usesPhpApi()) {
      const formData = new FormData();
      formData.append("id", entry.id);
      formData.append("title", entry.title);
      formData.append("composer", entry.composer);
      formData.append("credit", entry.credit || "");
      formData.append("filename", entry.filename);
      formData.append("added", entry.added || "");
      formData.append("license", entry.license || "");
      formData.append("file", blob, entry.filename || `${entry.id}.mxl`);
      const res = await fetch(`${getApiBase()}/exchange.php`, {
        method: "POST",
        body: formData,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Could not publish the score.");
      }
      if (body.score) {
        sharedScores = [rowToScore(body.score), ...catalog.scores].slice(0, MAX_FILES);
      } else if (Array.isArray(body.scores)) {
        sharedScores = body.scores.map(rowToScore);
      } else {
        sharedScores = [
          rowToScore({ ...entry, format: "mxl", storage_path: storagePath }),
          ...catalog.scores,
        ].slice(0, MAX_FILES);
      }
      return true;
    }

    const client = getSupabase();
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
    requireSharedBackend();
    if (usesPhpApi()) {
      const res = await fetch(
        `${getApiBase()}/exchange.php?id=${encodeURIComponent(item.id)}`,
        {
          method: "DELETE",
          headers: {
            "X-Admin-Password": String(adminPasswordInput?.value || ""),
          },
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Could not remove that score.");
      }
      sharedScores = sharedScores.filter((score) => score.id !== item.id);
      return;
    }

    const client = getSupabase();
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

  const humanizeFilePart = (value) =>
    String(value || "")
      .replace(/_+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  /** Guess from Composer-Title.xml / Composer-Full_Title.mxl (optional trailing -© / -⎕). */
  const metaFromFilename = (name) => {
    let stem = String(name || "")
      .replace(/\.(xml|musicxml|mxl)$/i, "")
      .trim();
    stem = stem.replace(/-(?:©|⎕|\[c\]|\(c\))$/iu, "");
    const dash = stem.indexOf("-");
    if (dash <= 0 || dash >= stem.length - 1) {
      return {
        title: humanizeFilePart(stem) || "Untitled score",
        composer: "",
      };
    }
    return {
      composer: humanizeFilePart(stem.slice(0, dash)),
      title: humanizeFilePart(stem.slice(dash + 1)) || "Untitled score",
    };
  };

  const titleFromFile = (name) => metaFromFilename(name).title;

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

  const pageSize = () => displayLimit();

  const clampListOffset = (matchedCount) => {
    const size = pageSize();
    if (!Number.isFinite(size) || matchedCount <= 0) {
      listOffset = 0;
      return;
    }
    listOffset = Math.floor(Math.max(0, listOffset) / size) * size;
    if (listOffset >= matchedCount) {
      listOffset = Math.floor(Math.max(0, matchedCount - 1) / size) * size;
    }
  };

  const updateCount = (shown, total, from = 0) => {
    const catalogTotal = catalogItems().length;
    const matched = total ?? filteredItems().length;
    const displayed = shown ?? 0;
    const start = matched === 0 ? 0 : from + 1;
    const end = from + displayed;
    if (totalEl) {
      totalEl.textContent =
        catalogTotal === 0
          ? ""
          : `· ${catalogTotal} song${catalogTotal === 1 ? "" : "s"}`;
    }
    if (countEl) {
      countEl.textContent =
        matched === 0
          ? `0 scores · max ${MAX_FILES}`
          : displayed < matched || from > 0
            ? `${start}–${end} of ${matched} scores · max ${MAX_FILES}`
            : `${matched} score${matched === 1 ? "" : "s"} · max ${MAX_FILES}`;
    }
    if (songCountEl) {
      songCountEl.textContent =
        matched === 0
          ? "0 songs"
          : displayed < matched || from > 0
            ? `${start}–${end} of ${matched} songs`
            : `${matched} song${matched === 1 ? "" : "s"}`;
    }
  };

  const updatePager = (matchedCount, shownCount) => {
    const size = pageSize();
    const paged = Number.isFinite(size);
    if (!pagerEl || !prevPageBtn || !nextPageBtn) return;

    if (!paged || matchedCount <= size) {
      pagerEl.hidden = true;
      return;
    }

    pagerEl.hidden = false;
    const hasPrev = listOffset > 0;
    const hasNext = listOffset + shownCount < matchedCount;
    prevPageBtn.disabled = !hasPrev;
    nextPageBtn.disabled = !hasNext;
    nextPageBtn.textContent = `Next ${size}`;
    if (pagerStatusEl) {
      const page = Math.floor(listOffset / size) + 1;
      const pages = Math.max(1, Math.ceil(matchedCount / size));
      pagerStatusEl.textContent = `Page ${page} of ${pages}`;
    }
  };

  const catalogItems = () => {
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
      return true;
    });
  };

  const matchesFilters = (item) => {
    if (composerFilter) {
      // Match by surname so "Beethoven" includes "Ludwig van Beethoven".
      if (!sameComposerLastName(item.composer, composerFilter)) return false;
    }
    if (titleQuery) {
      if (!foldText(item.title).includes(titleQuery)) return false;
    }
    return true;
  };

  const displayLimit = () =>
    scrollLimit >= SCROLL_LIMIT_ALL ? Infinity : scrollLimit;

  const filteredItems = () => catalogItems().filter(matchesFilters);

  /** Matching songs for the current page (All = full list). */
  const visibleItems = () => {
    const items = filteredItems();
    const size = pageSize();
    if (!Number.isFinite(size)) return items;
    clampListOffset(items.length);
    return items.slice(listOffset, listOffset + size);
  };

  const uniqueComposers = () => {
    const byFold = new Map();
    catalogItems().forEach((item) => {
      const name = String(item.composer || "").trim();
      if (!name) return;
      const key = foldText(name);
      if (!byFold.has(key)) byFold.set(key, name);
    });
    return [...byFold.values()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
  };

  const refreshComposerList = () => {
    if (!composerSelect) return;
    const previous = composerSelect.value;
    const composers = uniqueComposers();
    const signature = composers.join("\0");
    if (composerSelect.dataset.signature === signature) {
      composerFilter = composerSelect.value;
      return;
    }
    composerSelect.dataset.signature = signature;
    composerSelect.innerHTML = "";

    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All composers";
    composerSelect.append(allOpt);

    composers.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      composerSelect.append(opt);
    });

    const stillThere = [...composerSelect.options].some(
      (opt) => opt.value === previous
    );
    composerSelect.value = stillThere ? previous : "";
    composerFilter = composerSelect.value;
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

  const xmlElementText = (el) => String(el?.textContent || "").trim();

  const scoreHasTitle = (doc) =>
    [...doc.querySelectorAll("work-title, movement-title")].some(
      (el) => xmlElementText(el).length > 0
    );

  const scoreHasComposer = (doc) =>
    [...doc.querySelectorAll("creator")].some((el) => {
      const type = String(el.getAttribute("type") || "composer").toLowerCase();
      return type === "composer" && xmlElementText(el).length > 0;
    });

  /** Read title/composer from MusicXML text for form autofill. */
  const extractScoreMetadata = (xmlText) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) {
      return { title: "", composer: "" };
    }

    const firstText = (selectors) => {
      for (const sel of selectors) {
        for (const el of doc.querySelectorAll(sel)) {
          const text = xmlElementText(el);
          if (text) return text;
        }
      }
      return "";
    };

    const title = firstText(["work-title", "movement-title"]);

    let composer = "";
    for (const el of doc.querySelectorAll("creator")) {
      const type = String(el.getAttribute("type") || "composer").toLowerCase();
      const text = xmlElementText(el);
      if (!text) continue;
      if (type === "composer") {
        composer = text;
        break;
      }
      if (!composer && (type === "" || type === "composer")) composer = text;
    }
    if (!composer) {
      for (const el of doc.querySelectorAll("creator")) {
        const text = xmlElementText(el);
        if (text) {
          composer = text;
          break;
        }
      }
    }

    return { title, composer };
  };

  const xmlTextFromUpload = async (file, buffer) => {
    const ext = extensionOf(file.name);
    if (ext === "mxl") {
      if (!window.KlavierPlayer?.unzipXml) {
        throw new Error("Score reader is not ready yet. Try again in a moment.");
      }
      return window.KlavierPlayer.unzipXml(buffer);
    }
    return stripBom(new TextDecoder().decode(buffer)).trim();
  };

  const insertAfterRootOpen = (doc, root, node) => {
    const first = root.firstChild;
    if (first) root.insertBefore(node, first);
    else root.appendChild(node);
  };

  // MusicXML order: work, movement-*, identification, …
  const ensureXmlMetadata = (xmlText, title, composer) => {
    const wantedTitle = String(title || "").trim();
    const wantedComposer = String(composer || "").trim();
    if (!wantedTitle && !wantedComposer) return xmlText;

    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("That MusicXML file could not be parsed.");
    }
    const root =
      doc.getElementsByTagName("score-partwise")[0] ||
      doc.getElementsByTagName("score-timewise")[0];
    if (!root) return xmlText;

    if (wantedTitle && !scoreHasTitle(doc)) {
      let work = root.getElementsByTagName("work")[0];
      if (!work) {
        work = doc.createElement("work");
        insertAfterRootOpen(doc, root, work);
      }
      const workTitle = doc.createElement("work-title");
      workTitle.textContent = wantedTitle;
      work.insertBefore(workTitle, work.firstChild);
    }

    if (wantedComposer && !scoreHasComposer(doc)) {
      let identification = root.getElementsByTagName("identification")[0];
      if (!identification) {
        identification = doc.createElement("identification");
        const work = root.getElementsByTagName("work")[0];
        const movementTitle = root.getElementsByTagName("movement-title")[0];
        const movementNumber = root.getElementsByTagName("movement-number")[0];
        const anchor = work || movementNumber || movementTitle;
        if (anchor?.nextSibling) {
          root.insertBefore(identification, anchor.nextSibling);
        } else if (anchor) {
          root.appendChild(identification);
        } else {
          insertAfterRootOpen(doc, root, identification);
        }
      }
      const creator = doc.createElement("creator");
      creator.setAttribute("type", "composer");
      creator.textContent = wantedComposer;
      const encoding = identification.getElementsByTagName("encoding")[0];
      if (encoding) identification.insertBefore(creator, encoding);
      else identification.insertBefore(creator, identification.firstChild);
    }

    const serialized = new XMLSerializer().serializeToString(doc);
    // Keep an XML declaration if the source had one.
    if (/^\s*<\?xml\b/i.test(xmlText) && !/^\s*<\?xml\b/i.test(serialized)) {
      return `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
    }
    return serialized;
  };

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

  const xmlToMxl = async (xmlBuffer, originalName, title, composer) => {
    let scoreText = normalizeMusicXml(xmlBuffer);
    scoreText = ensureXmlMetadata(scoreText, title, composer);
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

  const prepareScoreFile = async (file, ext, buffer, title, composer) => {
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
    const converted = await xmlToMxl(buffer, file.name, title, composer);

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

  const setViewerStatus = (message, kind = "") => {
    if (!viewerStatusEl) return;
    viewerStatusEl.textContent = message || "";
    viewerStatusEl.hidden = !message;
    viewerStatusEl.dataset.kind = kind;
  };

  const closeScoreViewer = () => {
    viewerRequestId += 1;
    if (!viewerEl) return;
    viewerEl.hidden = true;
    document.body.style.overflow = "";
    if (viewerPageEl) viewerPageEl.innerHTML = "";
    osmd = null;
    setViewerStatus("");
  };

  const getScoreBlob = async (item) => {
    if (item.source === "local" && item.blob) return item.blob;
    if (item.source === "shared") {
      const cached = localScores.find((row) => row.id === item.id && row.blob);
      if (cached?.blob) return cached.blob;
      return fetchSharedBlob(item);
    }
    const cacheKey = `builtin:${item.file || item.id}`;
    if (blobCache.has(cacheKey)) return blobCache.get(cacheKey);
    let lastError;
    for (let i = 0; i < 3; i += 1) {
      try {
        const res = await fetchWithRetry(`exchange/${item.file}`, { cache: "force-cache" }, 1);
        if (!res.ok) throw new Error("Could not load that score.");
        const blob = await res.blob();
        blobCache.set(cacheKey, blob);
        return blob;
      } catch (err) {
        lastError = err;
        if (i < 2) await sleep(300 * (i + 1));
      }
    }
    throw new Error(networkErrorMessage(lastError));
  };

  /** OSMD/XML parsers can choke on remote DTD fetches from MusicXML DOCTYPE. */
  const sanitizeMusicXml = (xmlText) =>
    String(xmlText || "")
      .replace(/^\uFEFF/, "")
      .replace(/<!DOCTYPE[\s\S]*?>/i, "")
      .trim();

  const blobToMusicXml = async (blob) => {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
      if (!window.KlavierPlayer?.unzipXml) {
        throw new Error("MXL preview is unavailable in this browser.");
      }
      return sanitizeMusicXml(await window.KlavierPlayer.unzipXml(buffer));
    }
    const text = sanitizeMusicXml(new TextDecoder().decode(buffer));
    if (!/<score-partwise\b|<score-timewise\b/i.test(text)) {
      throw new Error("That file does not look like MusicXML.");
    }
    return text;
  };

  const getOsmd = () => {
    if (osmd) return osmd;
    const OSMD = window.opensheetmusicdisplay?.OpenSheetMusicDisplay;
    if (!OSMD || !viewerPageEl) {
      throw new Error("Score viewer failed to load. Refresh and try again.");
    }
    osmd = new OSMD(viewerPageEl, {
      autoResize: true,
      backend: "svg",
      drawTitle: true,
      drawSubtitle: false,
      drawComposer: true,
      drawLyricist: false,
      drawCredits: false,
      drawPartNames: false,
      drawPartAbbreviations: false,
      drawMeasureNumbers: true,
      pageFormat: "A4_P",
      drawUpToPageNumber: 1,
      drawingParameters: "compacttight",
    });
    return osmd;
  };

  const openScoreViewer = async (item) => {
    if (!viewerEl || !viewerPageEl) return;
    const requestId = ++viewerRequestId;
    viewerEl.hidden = false;
    document.body.style.overflow = "hidden";
    if (viewerTitleEl) viewerTitleEl.textContent = item.title || "Score";
    if (viewerMetaEl) {
      viewerMetaEl.textContent = [item.composer, "First page"]
        .filter(Boolean)
        .join(" · ");
    }
    viewerPageEl.innerHTML = "";
    setViewerStatus("Loading score…");

    try {
      const blob = await getScoreBlob(item);
      if (requestId !== viewerRequestId) return;
      const xml = await blobToMusicXml(blob);
      if (requestId !== viewerRequestId) return;
      setViewerStatus("Rendering first page…");
      const viewer = getOsmd();
      await viewer.load(xml);
      if (requestId !== viewerRequestId) return;
      viewer.setOptions({
        pageFormat: "A4_P",
        drawUpToPageNumber: 1,
      });
      viewer.render();
      setViewerStatus("Showing page 1");
    } catch (err) {
      if (requestId !== viewerRequestId) return;
      viewerPageEl.innerHTML = "";
      osmd = null;
      setViewerStatus(
        networkErrorMessage(err) || "Could not preview that score.",
        "error"
      );
    }
  };

  const render = () => {
    refreshComposerList();
    const matched = filteredItems();
    clampListOffset(matched.length);
    const items = visibleItems();
    listEl.innerHTML = "";
    emptyEl.hidden = matched.length > 0;
    updateCount(items.length, matched.length, listOffset);
    updatePager(matched.length, items.length);

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

      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "btn btn-ghost";
      viewBtn.textContent = "View";
      viewBtn.addEventListener("click", () => {
        openScoreViewer(item);
      });
      actions.append(viewBtn);

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

  const selectedFiles = () => [...(fileInput?.files || [])];

  const syncUploadButtonLabel = (count = selectedFiles().length) => {
    if (!uploadSubmitBtn) return;
    uploadSubmitBtn.textContent =
      count > 1 ? `Upload ${count} scores` : "Upload score";
  };

  const guessMetadataForFile = async (file) => {
    const fromName = metaFromFilename(file.name);
    const ext = extensionOf(file.name);
    if (!ALLOWED.has(ext)) return fromName;
    try {
      const buffer = await readFile(file);
      const xmlText = await xmlTextFromUpload(file, buffer);
      const fromXml = extractScoreMetadata(xmlText);
      return {
        title: fromXml.title || fromName.title,
        composer: fromXml.composer || fromName.composer,
      };
    } catch (_) {
      return fromName;
    }
  };

  const applyGuessedMetadata = (title, composer) => {
    const guessedTitle = String(title || "").trim();
    const guessedComposer = String(composer || "").trim();
    if (guessedTitle) titleInput.value = guessedTitle.slice(0, 120);
    if (guessedComposer) composerInput.value = guessedComposer.slice(0, 160);

    // Mirror into library search so similar existing scores are visible.
    refreshComposerList();
    if (searchInput) {
      searchInput.value = guessedTitle;
      titleQuery = foldText(guessedTitle);
    }
    if (composerSelect) {
      const folded = foldText(guessedComposer);
      const last = composerLastName(guessedComposer);
      const options = [...composerSelect.options].filter((opt) => opt.value);
      const match =
        (folded &&
          options.find((opt) => foldText(opt.value) === folded)) ||
        (last &&
          options.find((opt) => composerLastName(opt.value) === last)) ||
        null;
      composerSelect.value = match ? match.value : "";
      composerFilter = composerSelect.value;
    }
    listOffset = 0;
    render();
  };

  const cachePublishedLocally = async (record) => {
    localScores = await loadLocal();
    if (localScores.length >= MAX_FILES) {
      const oldest = [...localScores].sort((a, b) =>
        String(a.added).localeCompare(String(b.added))
      )[0];
      if (oldest) await deleteLocal(oldest.id);
    }
    await saveLocal(record);
    localScores = await loadLocal();
  };

  const uploadOneScore = async (file, title, composer, progressLabel) => {
    const ext = extensionOf(file.name);
    if (!ALLOWED.has(ext)) {
      throw new Error(`${file.name}: only .xml, .musicxml, and .mxl are accepted.`);
    }
    if (ext === "mxl" && file.size > MAX_MXL_BYTES) {
      throw new Error(`${file.name}: MXL larger than 100 KB.`);
    }
    if ((ext === "xml" || ext === "musicxml") && file.size > MAX_XML_BYTES) {
      throw new Error(`${file.name}: XML larger than 1 GB.`);
    }

    const safeTitle = String(title || "").trim();
    const safeComposer = String(composer || "").trim();
    if (safeTitle.length < 2 || safeComposer.length < 2) {
      throw new Error(
        `${file.name}: could not determine title and composer (need at least 2 characters each).`
      );
    }

    if (progressLabel) setStatus(progressLabel);
    const buffer = await readFile(file);
    const prepared = await prepareScoreFile(
      file,
      ext,
      buffer,
      safeTitle,
      safeComposer
    );
    const id = `shared-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      title: safeTitle,
      composer: safeComposer,
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

    setStatus(
      progressLabel
        ? progressLabel.replace(/Uploading|Converting/, "Publishing")
        : "Publishing for everyone…"
    );
    const publishedShared = await publishSharedScore(record, prepared.blob);
    if (!publishedShared) {
      throw new Error(`${file.name}: could not publish. Try again.`);
    }
    await cachePublishedLocally(record);
    return { record, converted: prepared.converted };
  };

  fileInput?.addEventListener("change", async () => {
    const files = selectedFiles();
    syncUploadButtonLabel(files.length);
    if (!files.length) {
      fileNameEl.textContent = "No file chosen";
      return;
    }

    if (files.length === 1) {
      fileNameEl.textContent = files[0].name;
      const meta = await guessMetadataForFile(files[0]);
      applyGuessedMetadata(meta.title, meta.composer);
      return;
    }

    fileNameEl.textContent = `${files.length} files chosen`;
    titleInput.value = "";
    composerInput.value = "";
    // Preview library matches for the first file.
    const firstMeta = await guessMetadataForFile(files[0]);
    applyGuessedMetadata(firstMeta.title, firstMeta.composer);
    titleInput.value = "";
    composerInput.value = "";
    setStatus(
      `${files.length} scores selected. Title and composer are taken from each file.`
    );
  });

  uploadMultiBtn?.addEventListener("click", () => {
    if (!fileInput) return;
    fileInput.value = "";
    fileInput.click();
  });

  form.addEventListener("reset", () => {
    window.setTimeout(() => {
      fileNameEl.textContent = "No file chosen";
      syncUploadButtonLabel(0);
    }, 0);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const files = selectedFiles();
    if (!files.length) {
      setStatus("Choose an XML or MXL file first.", "error");
      return;
    }
    if (!rightsInput?.checked) {
      setStatus("Confirm that you have the rights to upload and share.", "error");
      rightsInput?.focus();
      return;
    }

    const remainingSlots = MAX_FILES - sharedScores.length;
    if (remainingSlots <= 0) {
      setStatus(
        `The shared library already has ${MAX_FILES} scores. Remove one before uploading another.`,
        "error"
      );
      return;
    }
    if (files.length > remainingSlots) {
      setStatus(
        `Only ${remainingSlots} more score${remainingSlots === 1 ? "" : "s"} can be added (max ${MAX_FILES}).`,
        "error"
      );
      return;
    }

    const multi = files.length > 1;
    const formTitle = (titleInput.value || "").trim();
    const formComposer = (composerInput.value || "").trim();

    if (!multi) {
      if (formTitle.length < 2) {
        setStatus("Title must be at least 2 characters.", "error");
        titleInput.focus();
        return;
      }
      if (formComposer.length < 2) {
        setStatus("Composer must be at least 2 characters.", "error");
        composerInput.focus();
        return;
      }
    }

    let ok = 0;
    let skipped = 0;
    let convertedCount = 0;
    const failures = [];

    try {
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const progress = multi
          ? `Uploading ${i + 1} of ${files.length}: ${file.name}`
          : extensionOf(file.name) === "mxl"
            ? "Uploading…"
            : "Converting XML to MXL…";
        try {
          let title = formTitle;
          let composer = formComposer;
          if (multi || title.length < 2 || composer.length < 2) {
            const meta = await guessMetadataForFile(file);
            title = multi ? meta.title : title || meta.title;
            composer = multi ? meta.composer : composer || meta.composer;
          }

          if (multi) {
            const similar = findSimilarExchangeScore(title, composer);
            if (similar) {
              setStatus(
                `Similar score found for ${i + 1} of ${files.length}: ${file.name}`
              );
              if (!confirmSimilarUpload(title, composer, similar)) {
                skipped += 1;
                continue;
              }
            }
          }

          const result = await uploadOneScore(file, title, composer, progress);
          ok += 1;
          if (result.converted) convertedCount += 1;
          await loadShared().catch(() => {});
          render();
        } catch (err) {
          failures.push(err.message || String(err));
          if (!multi) throw err;
        }
      }

      form.reset();
      fileNameEl.textContent = "No file chosen";
      syncUploadButtonLabel(0);
      await loadShared().catch(() => {});
      render();

      if (multi) {
        const parts = [`Published ${ok} of ${files.length} scores.`];
        if (convertedCount) parts.push(`${convertedCount} converted to MXL.`);
        if (skipped) parts.push(`${skipped} skipped as similar.`);
        if (failures.length) {
          parts.push(
            `${failures.length} failed: ${failures.slice(0, 3).join(" · ")}`
          );
        }
        setStatus(parts.join(" "), failures.length ? "error" : "");
      } else {
        const convertedNote = convertedCount ? " Converted to MXL." : "";
        setStatus(
          `Published for everyone. Anyone can download it below.${convertedNote}`
        );
      }
    } catch (err) {
      setStatus(err.message || "Upload failed.", "error");
    }
  });

  searchInput?.addEventListener("input", () => {
    titleQuery = foldText(searchInput.value.trim());
    listOffset = 0;
    render();
  });

  composerSelect?.addEventListener("change", () => {
    composerFilter = composerSelect.value;
    listOffset = 0;
    render();
  });

  scrollLimitInput?.addEventListener("input", () => {
    const n = Number(scrollLimitInput.value);
    scrollLimit =
      Number.isFinite(n) && n >= SCROLL_LIMIT_ALL
        ? SCROLL_LIMIT_ALL
        : Math.min(1000, Math.max(20, Math.round((n || 20) / 10) * 10));
    listOffset = 0;
    syncScrollLimitUi();
    try {
      localStorage.setItem(SCROLL_LIMIT_STORAGE_KEY, String(scrollLimit));
    } catch (_) {
      /* ignore quota / private mode */
    }
    render();
  });

  prevPageBtn?.addEventListener("click", () => {
    const size = pageSize();
    if (!Number.isFinite(size)) return;
    listOffset = Math.max(0, listOffset - size);
    render();
  });

  nextPageBtn?.addEventListener("click", () => {
    const size = pageSize();
    if (!Number.isFinite(size)) return;
    listOffset += size;
    render();
  });

  adminPasswordInput?.addEventListener("input", () => {
    render();
  });

  viewerCloseBtn?.addEventListener("click", closeScoreViewer);
  viewerCloseBackdrop?.addEventListener("click", closeScoreViewer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && viewerEl && !viewerEl.hidden) {
      closeScoreViewer();
    }
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
      if (!usesPhpApi() && !getSupabase()) {
        setStatus(
          "Shared uploads need a backend. Set apiBase (PHP + Postgres) or supabaseUrl/supabaseAnonKey in exchange-config.js."
        );
      }
    } catch (err) {
      setStatus(err.message || "Could not open the exchange.", "error");
    }
  })();
})();
