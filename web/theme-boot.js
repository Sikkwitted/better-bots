// Runs before the stylesheet paints, so a light-theme page never flashes dark.
// A separate file, not inline: the console's Content-Security-Policy allows
// scripts from this origin only.
(() => {
  let pref = 'system';
  try { pref = localStorage.getItem('better-bots-theme') ?? 'system'; } catch { /* private mode */ }
  const system = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.themePref = pref;
  document.documentElement.dataset.theme = pref === 'system' ? system : pref;
})();
