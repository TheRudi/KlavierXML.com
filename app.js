(() => {
  const keysRoot = document.getElementById("piano-keys");
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const id = link.getAttribute("href");
    if (!id || id === "#") return;
    const target = document.querySelector(id);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    history.pushState(null, "", id);
  });

  if (!keysRoot) return;

  const whiteCount = 21;
  const whitePitch = [0, 2, 4, 5, 7, 9, 11];
  const whites = [];
  const keyByMidi = new Map();
  const held = new Map();
  let midi = 48; // C3
  while (whites.length < whiteCount) {
    if (whitePitch.includes(midi % 12)) {
      const key = document.createElement("div");
      key.className = "white-key";
      key.dataset.midi = String(midi);
      keysRoot.appendChild(key);
      whites.push(key);
      keyByMidi.set(midi, key);
    }
    midi += 1;
  }

  const blackLayer = document.createElement("div");
  blackLayer.className = "black-keys";
  keysRoot.appendChild(blackLayer);

  const blacks = [];
  const whiteWidth = 100 / whiteCount;
  whites.forEach((white, index) => {
    if (index === whites.length - 1) return;
    const whiteMidi = Number(white.dataset.midi);
    const blackMidi = whiteMidi + 1;
    if (whitePitch.includes(blackMidi % 12)) return;
    const key = document.createElement("div");
    key.className = "black-key";
    key.dataset.midi = String(blackMidi);
    key.style.width = `${whiteWidth * 0.58}%`;
    key.style.left = `calc(${(index + 1) * whiteWidth}% - ${whiteWidth * 0.29}%)`;
    blackLayer.appendChild(key);
    blacks.push(key);
    keyByMidi.set(blackMidi, key);
  });

  window.KlavierKeys = {
    on(note) {
      const el = keyByMidi.get(note);
      if (!el) return;
      held.set(note, (held.get(note) || 0) + 1);
      el.classList.add("lit");
    },
    off(note) {
      const next = (held.get(note) || 1) - 1;
      if (next > 0) {
        held.set(note, next);
        return;
      }
      held.delete(note);
      keyByMidi.get(note)?.classList.remove("lit");
    },
    suspendDemo: false,
    clear() {
      held.clear();
      this.suspendDemo = false;
      keyByMidi.forEach((el) => el.classList.remove("lit"));
    },
  };

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduceMotion) {
    const phrase = [
      { t: 0, w: [3, 5], b: [1] },
      { t: 380, w: [5, 7], b: [] },
      { t: 760, w: [7, 8], b: [4] },
      { t: 1140, w: [8, 10], b: [] },
      { t: 1520, w: [10, 12], b: [6] },
      { t: 1900, w: [8, 12], b: [4, 6] },
      { t: 2400, w: [5, 7, 10], b: [1] },
      { t: 2900, w: [3, 7, 12], b: [] },
    ];

    const clearLit = () => {
      whites.forEach((el) => el.classList.remove("lit"));
      blacks.forEach((el) => el.classList.remove("lit"));
    };

    const playPhrase = () => {
      if (window.KlavierKeys?.suspendDemo) return;
      clearLit();
      phrase.forEach((step) => {
        window.setTimeout(() => {
          clearLit();
          step.w.forEach((i) => whites[i]?.classList.add("lit"));
          step.b.forEach((i) => blacks[i]?.classList.add("lit"));
        }, step.t);
      });
      window.setTimeout(clearLit, 3400);
    };

    playPhrase();
    window.setInterval(playPhrase, 5200);
  }

  const clipVideos = [...document.querySelectorAll(".clip video")];
  const clipButtons = [...document.querySelectorAll(".clip-sound")];
  if (reduceMotion) {
    clipVideos.forEach((video) => {
      video.removeAttribute("autoplay");
      video.pause();
    });
  }
  const setSound = (active) => {
    clipVideos.forEach((video, index) => {
      const button = clipButtons[index];
      const on = video === active;
      video.muted = !on;
      if (button) {
        button.setAttribute("aria-pressed", on ? "true" : "false");
        button.textContent = on ? "Sound on" : "Sound off";
      }
      if (on) {
        video.volume = 0.9;
        video.play();
      }
    });
  };
  clipButtons.forEach((button, index) => {
    button.addEventListener("click", () => {
      const video = clipVideos[index];
      setSound(video.muted ? video : null);
    });
  });

  const steps = document.querySelectorAll(".flow-step");
  if ("IntersectionObserver" in window && steps.length) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.35 }
    );
    steps.forEach((step) => observer.observe(step));
  } else {
    steps.forEach((step) => step.classList.add("is-visible"));
  }
})();
