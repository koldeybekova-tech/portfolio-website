window.addEventListener("DOMContentLoaded", () => {
  const revealItems = Array.from(document.querySelectorAll(".reveal"));
  const cursor = document.querySelector(".plane-cursor");
  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  if (cursor && canHover) {
    let mouseX = -100;
    let mouseY = -100;
    let cursorX = -100;
    let cursorY = -100;

    const moveCursor = () => {
      cursorX += (mouseX - cursorX) * 0.24;
      cursorY += (mouseY - cursorY) * 0.24;
      cursor.style.left = `${cursorX}px`;
      cursor.style.top = `${cursorY}px`;
      requestAnimationFrame(moveCursor);
    };

    window.addEventListener("mousemove", (event) => {
      mouseX = event.clientX + 8;
      mouseY = event.clientY + 8;
    });

    document.querySelectorAll("a, button, input, textarea").forEach((item) => {
      item.addEventListener("mouseenter", () => cursor.classList.add("is-link"));
      item.addEventListener("mouseleave", () => cursor.classList.remove("is-link"));
    });

    moveCursor();
  }

  if (!window.gsap) {
    document.documentElement.dataset.gsap = "missing";
    revealItems.forEach((item) => item.classList.add("is-visible"));
    return;
  }

  document.documentElement.dataset.gsap = window.gsap.version;
  window.gsap.set(revealItems, { autoAlpha: 0, y: 28 });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        window.gsap.to(entry.target, {
          autoAlpha: 1,
          y: 0,
          duration: 0.72,
          ease: "power3.out",
        });
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.12 }
  );

  revealItems.forEach((item) => observer.observe(item));

  window.gsap.fromTo(
    ".status-card",
    { rotate: -7, y: 24 },
    { rotate: -3, y: 0, duration: 0.9, delay: 0.35, ease: "back.out(1.8)" }
  );

  window.gsap.fromTo(
    ".blob",
    { scale: 0.9, rotate: -12 },
    { scale: 1, rotate: (index) => (index === 0 ? -7 : 9), duration: 1, delay: 0.2, stagger: 0.12, ease: "power3.out" }
  );
});
