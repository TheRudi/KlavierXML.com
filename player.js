(() => {
  const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const samples = new Map();
  let ctx = null;
  let master = null;
  let current = null;
  let requestId = 0;

  const midiName = (midi) => NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

  const child = (el, name) => [...el.children].find((node) => node.localName === name);

  const hasChild = (el, name) => [...el.children].some((node) => node.localName === name);

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzipXml(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("This score file is not a valid MXL archive.");
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const files = {};
    for (let i = 0; i < count; i += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const method = view.getUint16(offset + 10, true);
      const compSize = view.getUint32(offset + 20, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localOff = view.getUint32(offset + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
      const localNameLen = view.getUint16(localOff + 26, true);
      const localExtraLen = view.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + localNameLen + localExtraLen;
      const compressed = bytes.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = compressed;
      else if (method === 8) data = await inflate(compressed);
      else throw new Error("This score uses an unsupported compression method.");
      files[name] = data;
      offset += 46 + nameLen + extraLen + commentLen;
    }
    const xmlName = Object.keys(files).find((name) => name.endsWith("score.xml") || (name.endsWith(".xml") && !name.includes("container")));
    if (!xmlName) throw new Error("No MusicXML score was found in this file.");
    return new TextDecoder().decode(files[xmlName]);
  }

  function parseMusicXml(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("This score could not be read.");
    const notes = [];
    let pieceEnd = 0;
    for (const part of doc.getElementsByTagName("part")) {
      let seconds = 0;
      let divisions = 1;
      let tempo = 100;
      let lastStart = 0;
      const openTies = new Map();
      for (const measure of [...part.children].filter((node) => node.localName === "measure")) {
        for (const el of measure.children) {
          if (el.localName === "attributes") {
            const divisionsNode = child(el, "divisions");
            if (divisionsNode) divisions = Number(divisionsNode.textContent) || divisions;
          }
          if (el.localName === "direction") {
            const sound = child(el, "sound");
            const tempoAttr = sound?.getAttribute("tempo");
            if (tempoAttr) tempo = Number(tempoAttr) || tempo;
            const perMinute = el.getElementsByTagName("per-minute")[0];
            if (perMinute?.textContent) tempo = Number(perMinute.textContent) || tempo;
          }
          if (el.localName === "backup" || el.localName === "forward") {
            const dur = Number(child(el, "duration")?.textContent || 0);
            const delta = (dur / divisions) * (60 / tempo);
            seconds += el.localName === "forward" ? delta : -delta;
          }
          if (el.localName !== "note" || hasChild(el, "grace") || hasChild(el, "cue")) continue;
          const chord = hasChild(el, "chord");
          const rest = hasChild(el, "rest");
          const dur = Number(child(el, "duration")?.textContent || 0);
          const sec = (dur / divisions) * (60 / tempo);
          const start = chord ? lastStart : seconds;
          if (!rest) {
            const pitch = child(el, "pitch");
            if (pitch) {
              const step = child(pitch, "step")?.textContent || "C";
              const alter = Number(child(pitch, "alter")?.textContent || 0);
              const octave = Number(child(pitch, "octave")?.textContent || 4);
              const noteMidi = (octave + 1) * 12 + (STEP[step] ?? 0) + alter;
              const ties = [...el.getElementsByTagName("tie")].map((node) => node.getAttribute("type"));
              const tieStop = ties.includes("stop");
              const tieStart = ties.includes("start");
              if (tieStop && openTies.has(noteMidi)) {
                const prev = openTies.get(noteMidi);
                prev.duration = Math.max(0.05, start + sec - prev.start);
                if (tieStart) openTies.set(noteMidi, prev);
                else openTies.delete(noteMidi);
              } else {
                const event = { midi: noteMidi, start, duration: Math.max(0.05, sec), velocity: 0.86 };
                notes.push(event);
                if (tieStart) openTies.set(noteMidi, event);
              }
            }
          }
          if (!chord) {
            seconds = start + sec;
            lastStart = start;
          }
          pieceEnd = Math.max(pieceEnd, seconds);
        }
      }
    }
    notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    const duration = notes.reduce((end, note) => Math.max(end, note.start + note.duration), pieceEnd);
    return { notes, duration };
  }

  function formatTime(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }

  async function ensureAudio() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtx();
      master = ctx.createGain();
      master.gain.value = 0.42;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") await ctx.resume();
  }

  async function sampleFor(midi) {
    const name = midiName(Math.round(midi));
    if (samples.has(name)) return samples.get(name);
    const response = await fetch(`piano/${name}.mp3`);
    if (!response.ok) return null;
    const audio = await ctx.decodeAudioData(await response.arrayBuffer());
    samples.set(name, audio);
    return audio;
  }

  function stop() {
    requestId += 1;
    if (!current) return;
    current.timers.forEach((id) => window.clearTimeout(id));
    if (current.tick) window.clearInterval(current.tick);
    current.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    });
    window.KlavierKeys?.clear();
    current.button.disabled = false;
    current.button.textContent = "Play";
    current.button.setAttribute("aria-pressed", "false");
    if (!current.finished) current.status.textContent = "Stopped";
    current = null;
  }

  async function play(button) {
    const url = button.dataset.play;
    const card = button.closest(".score-card");
    const status = card.querySelector(".play-status");
    if (current?.button === button) {
      stop();
      return;
    }
    stop();
    const id = requestId;
    status.textContent = "Loading piano…";
    button.disabled = true;
    try {
      const cancelled = () => {
        if (id === requestId) return false;
        if (!current || current.button !== button) button.disabled = false;
        return true;
      };
      await ensureAudio();
      if (cancelled()) return;
      const response = await fetch(url);
      if (!response.ok) throw new Error("The score could not be loaded.");
      const xml = await unzipXml(await response.arrayBuffer());
      const score = parseMusicXml(xml);
      if (cancelled()) return;
      if (!score.notes.length) throw new Error("This score has no notes to play.");
      const needed = [...new Set(score.notes.map((note) => Math.round(note.midi)))];
      await Promise.all(needed.map((midi) => sampleFor(midi)));
      if (cancelled()) return;
      const timers = [];
      const sources = [];
      const session = { button, status, timers, sources, tick: 0, finished: false };
      current = session;
      button.disabled = false;
      button.textContent = "Stop";
      button.setAttribute("aria-pressed", "true");
      if (window.KlavierKeys) window.KlavierKeys.suspendDemo = true;
      status.textContent = `Playing · 0:00 / ${formatTime(score.duration)}`;
      const startAt = ctx.currentTime + 0.12;
      const started = performance.now();
      score.notes.forEach((note) => {
        const buffer = samples.get(midiName(Math.round(note.midi)));
        if (!buffer) return;
        const when = startAt + note.start;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        const peak = Math.max(0.05, note.velocity);
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.exponentialRampToValueAtTime(peak, when + 0.015);
        const release = when + Math.max(0.08, note.duration);
        gain.gain.setValueAtTime(peak, Math.max(when + 0.03, release - 0.06));
        gain.gain.exponentialRampToValueAtTime(0.0001, release + 0.14);
        source.connect(gain);
        gain.connect(master);
        source.start(when);
        source.stop(release + 0.16);
        sources.push(source);
        timers.push(window.setTimeout(() => window.KlavierKeys?.on(Math.round(note.midi)), note.start * 1000));
        timers.push(window.setTimeout(() => window.KlavierKeys?.off(Math.round(note.midi)), (note.start + note.duration) * 1000));
      });
      session.tick = window.setInterval(() => {
        if (current !== session) {
          window.clearInterval(session.tick);
          return;
        }
        const elapsed = (performance.now() - started) / 1000;
        status.textContent = `Playing · ${formatTime(elapsed)} / ${formatTime(score.duration)}`;
        if (elapsed >= score.duration + 0.2) {
          window.clearInterval(session.tick);
          session.finished = true;
          status.textContent = "Finished";
          stop();
        }
      }, 250);
    } catch (error) {
      button.disabled = false;
      button.textContent = "Play";
      status.textContent = error.message || "Playback failed.";
      if (current?.button === button) current = null;
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-play]");
    if (!button) return;
    play(button);
  });

  window.KlavierPlayer = { parseMusicXml, unzipXml };
})();
