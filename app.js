(() => {
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

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
