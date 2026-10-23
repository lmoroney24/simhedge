// Scroll reveal: each section fades and slides up as it scrolls into view.
// If JavaScript is off, or the visitor's device asks for reduced motion,
// everything simply shows normally.

(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !("IntersectionObserver" in window)) return;

  const sections = document.querySelectorAll("main .card, main .intro");
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("revealed");
        observer.unobserve(entry.target); // reveal once, then leave it alone
      }
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });

  sections.forEach(section => {
    section.classList.add("reveal");
    observer.observe(section);
  });
})();
