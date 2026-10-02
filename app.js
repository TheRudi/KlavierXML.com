(() => {
  const keysRoot = document.getElementById("piano-keys");
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  if (!keysRoot) return;

  const whiteCount = 21;
  const blackPattern = [1, 1, 0, 1, 1, 1, 0]; // after white keys C..B

  const whites = [];
  for (let i = 0; i < whiteCount; i += 1) {
    const key = document.createElement("div");
    key.className = "white-key";
    key.dataset.index = String(i);
    keysRoot.appendChild(key);
    whites.push(key);
  }

  const blackLayer = document.createElement("div");
  blackLayer.className = "black-keys";
  keysRoot.appendChild(blackLayer);

  const blacks = [];
  const whiteWidth = 100 / whiteCount;

  for (let i = 0; i < whiteCount - 1; i += 1) {
    const step = i % 7;
    if (!blackPattern[step]) continue;
    const key = document.createElement("div");
    key.className = "black-key";
    key.style.left = `calc(${(i + 1) * whiteWidth}% - ${whiteWidth * 0.31}%)`;
    blackLayer.appendChild(key);
    blacks.push(key);
  }

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
