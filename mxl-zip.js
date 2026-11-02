(() => {
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

  const encodeUtf8 = (text) => new TextEncoder().encode(text);

  const deflateRaw = async (bytes) => {
    if (typeof CompressionStream === "undefined") {
      throw new Error("This browser cannot compress MusicXML into MXL.");
    }
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  const insertAfterRootOpen = (doc, root, node) => {
    const first = root.firstChild;
    if (first) root.insertBefore(node, first);
    else root.appendChild(node);
  };

  const xmlElementText = (el) => String(el?.textContent || "").trim();

  const ensureXmlMetadata = (xmlText, title, composer) => {
    const wantedTitle = String(title || "").trim();
    const wantedComposer = String(composer || "").trim();
    if (!wantedTitle && !wantedComposer) return xmlText;

    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("Converted MusicXML could not be parsed.");
    }
    const root =
      doc.getElementsByTagName("score-partwise")[0] ||
      doc.getElementsByTagName("score-timewise")[0];
    if (!root) throw new Error("Converted file is not valid MusicXML.");

    const hasTitle = [...doc.querySelectorAll("work-title, movement-title")].some(
      (el) => xmlElementText(el).length > 0
    );
    if (wantedTitle && !hasTitle) {
      let work = root.getElementsByTagName("work")[0];
      if (!work) {
        work = doc.createElement("work");
        insertAfterRootOpen(doc, root, work);
      }
      const workTitle = doc.createElement("work-title");
      workTitle.textContent = wantedTitle;
      work.insertBefore(workTitle, work.firstChild);
    }

    const hasComposer = [...doc.querySelectorAll("creator")].some((el) => {
      const type = String(el.getAttribute("type") || "composer").toLowerCase();
      return type === "composer" && xmlElementText(el).length > 0;
    });
    if (wantedComposer && !hasComposer) {
      let identification = root.getElementsByTagName("identification")[0];
      if (!identification) {
        identification = doc.createElement("identification");
        const work = root.getElementsByTagName("work")[0];
        if (work?.nextSibling) root.insertBefore(identification, work.nextSibling);
        else if (work) root.appendChild(identification);
        else insertAfterRootOpen(doc, root, identification);
      }
      const creator = doc.createElement("creator");
      creator.setAttribute("type", "composer");
      creator.textContent = wantedComposer;
      identification.insertBefore(creator, identification.firstChild);
    }

    let serialized = new XMLSerializer().serializeToString(doc);
    if (/^\s*<\?xml\b/i.test(xmlText) && !/^\s*<\?xml\b/i.test(serialized)) {
      serialized = `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
    }
    return serialized;
  };

  const extractScoreMetadata = (xmlText) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) return { title: "", composer: "" };
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
      if (!composer) composer = text;
    }
    return { title, composer };
  };

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

  const xmlToMxlBlob = async (xmlText, title, composer) => {
    const withMeta = ensureXmlMetadata(xmlText, title, composer);
    const archive = await buildMxlArchive(withMeta);
    return {
      blob: new Blob([archive], {
        type: "application/vnd.recordare.musicxml",
      }),
      bytes: archive.length,
      xml: withMeta,
    };
  };

  window.KlavierMxl = {
    extractScoreMetadata,
    ensureXmlMetadata,
    buildMxlArchive,
    xmlToMxlBlob,
  };
})();
