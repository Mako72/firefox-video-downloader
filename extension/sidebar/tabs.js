/* Reiter der Seitenleiste: „Videos“ und „Downloads“. Der zuletzt gewählte Reiter wird gemerkt. */
(() => {
  'use strict';
  const panels = { videos: document.getElementById('panelVideos'), downloads: document.getElementById('panelDownloads') };
  const tabs = document.querySelectorAll('.tabs .tab');
  function show(name) {
    if (!panels[name]) name = 'videos';
    for (const k in panels) panels[k].hidden = k !== name;
    tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === name));
    try { sessionStorage.setItem('vdlPanel', name); } catch (e) { /* ignore */ }
  }
  tabs.forEach(t => t.addEventListener('click', () => show(t.dataset.panel)));
  window.vdlShowPanel = show;
  let start = 'videos';
  try { start = sessionStorage.getItem('vdlPanel') || 'videos'; } catch (e) { /* ignore */ }
  show(start);
})();
