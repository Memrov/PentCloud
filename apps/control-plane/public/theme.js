(() => {
  let mode = "dark";
  try { mode = localStorage.getItem("theme") || mode; } catch { /* Storage may be disabled. */ }
  document.documentElement.setAttribute("data-mode", mode);
  document.documentElement.style.colorScheme = mode;
})();
