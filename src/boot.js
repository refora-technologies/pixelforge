'use strict';

// Runs before first paint. Settings live in the main process, so the theme and
// accent are mirrored in localStorage and applied here to avoid a flash of the
// wrong colours. A separate file (not an inline script) so the page's
// Content-Security-Policy can forbid inline scripts entirely.
(function () {
  try {
    var root = document.documentElement;
    var theme = localStorage.getItem('pf.theme');
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    var accent = localStorage.getItem('pf.accent');
    if (accent && /^#[0-9a-f]{6}$/i.test(accent)) {
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-rgb', [1, 3, 5].map(function (i) { return parseInt(accent.slice(i, i + 2), 16); }).join(', '));
    }
  } catch (e) { /* storage unavailable: the renderer applies settings shortly */ }
})();
