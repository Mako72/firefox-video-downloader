/* Gemeinsames Einstellungsformular für Popup und Einstellungsseite. */
'use strict';
const VDL_DEFAULTS = {
  subfolder: 'Videos', askWhere: false, autoDeep: true, showAll: false, minSizeKB: 300,
  maxParallel: 2, autoResume: true, openSidebar: true, autoUpdate: true
};

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    if (k === 'text') e.textContent = attrs[k];
    else if (k === 'class') e.className = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  kids.forEach(c => e.append(c));
  return e;
}

async function renderSettings(root) {
  const s = await browser.storage.local.get(VDL_DEFAULTS);
  const save = (k, v) => {
    browser.storage.local.set({ [k]: v });
    saved.textContent = 'Gespeichert ✓';
    clearTimeout(save.t);
    save.t = setTimeout(() => { saved.textContent = ''; }, 1500);
  };

  const folder = el('input', { type: 'text', id: 'set-folder', placeholder: 'z. B. Videos oder Videos/Web', spellcheck: 'false' });
  folder.value = s.subfolder;
  folder.addEventListener('change', () => save('subfolder', folder.value.trim()));

  const check = (key, text) => {
    const c = el('input', { type: 'checkbox', id: 'set-' + key });
    c.checked = !!s[key];
    c.addEventListener('change', () => save(key, c.checked));
    return el('label', { class: 'set-check' }, c, el('span', { text }));
  };

  const min = el('input', { type: 'number', min: '0', step: '50', id: 'set-min' });
  min.value = s.minSizeKB;
  min.addEventListener('change', () => save('minSizeKB', Math.max(0, parseInt(min.value, 10) || 0)));

  const par = el('input', { type: 'number', min: '1', max: '6', step: '1', id: 'set-par' });
  par.value = s.maxParallel;
  par.addEventListener('change', () => save('maxParallel', Math.min(6, Math.max(1, parseInt(par.value, 10) || 2))));

  const saved = el('span', { class: 'set-saved' });

  root.replaceChildren(
    el('label', { class: 'set-label', for: 'set-folder', text: 'Download-Ordner' }),
    folder,
    el('p', { class: 'set-hint', text: 'Unterordner innerhalb deines Firefox-Download-Ordners. Leer lassen = direkt in den Download-Ordner. Den Hauptordner selbst änderst du in Firefox unter Einstellungen → Allgemein → Dateien und Anwendungen → Downloads.' }),
    check('askWhere', 'Vor jedem Download nach dem Speicherort fragen'),
    check('autoDeep', 'Tiefensuche automatisch starten, wenn kein Video gefunden wird'),
    check('showAll', 'Alle gefundenen Qualitätsstufen aufgeklappt anzeigen'),
    check('autoResume', 'Abgebrochene Downloads automatisch fortsetzen (auch nach Neustart)'),
    check('openSidebar', 'Seitenleiste beim Start eines Downloads öffnen'),
    check('autoUpdate', 'Updates automatisch suchen und installieren'),
    el('label', { class: 'set-label', for: 'set-par', text: 'Gleichzeitige Downloads' }),
    par,
    el('label', { class: 'set-label', for: 'set-min', text: 'Dateien kleiner als (KB) ausblenden' }),
    min,
    saved
  );
}
