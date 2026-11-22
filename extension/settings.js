/* Gemeinsames Einstellungsformular für Popup und Einstellungsseite. */
'use strict';
const VDL_DEFAULTS = {
  subfolder: 'Videos', askWhere: false, autoDeep: true, showAll: false, minSizeKB: 300,
  maxParallel: 2, autoResume: true, openSidebar: true, autoUpdate: true, iconAction: 'sidebar', autoClear: 'never', rememberLast: true
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

  const par = el('select', { id: 'set-par' },
    ...[1, 2, 3, 4, 5, 6, 8, 10].map(n => el('option', { value: String(n), text: String(n) })),
    el('option', { value: '0', text: 'Unbegrenzt' }));
  par.value = String(s.maxParallel);
  if (par.value === '') par.value = '2';
  par.addEventListener('change', () => save('maxParallel', parseInt(par.value, 10)));

  const act = el('select', { id: 'set-act' },
    el('option', { value: 'sidebar', text: 'die Seitenleiste (mit erkannten Videos)' }),
    el('option', { value: 'popup', text: 'ein kleines Fenster' }));
  act.value = s.iconAction;
  act.addEventListener('change', () => save('iconAction', act.value));

  const clr = el('select', { id: 'set-clr' },
    el('option', { value: 'never', text: 'nie (nur von Hand)' }),
    el('option', { value: 'immediate', text: 'sofort nach dem Speichern' }),
    el('option', { value: '10min', text: 'nach 10 Minuten' }),
    el('option', { value: '1h', text: 'nach 1 Stunde' }),
    el('option', { value: '1d', text: 'nach 1 Tag' }),
    el('option', { value: 'restart', text: 'beim nächsten Firefox-Start' }));
  clr.value = s.autoClear;
  clr.addEventListener('change', () => save('autoClear', clr.value));

  const saved = el('span', { class: 'set-saved' });

  const extra = await browser.storage.local.get({ downloadBaseDir: '', lastOutsideDir: '' });
  const where = el('p', { class: 'set-hint set-where' });
  const showWhere = () => {
    const base = extra.downloadBaseDir;
    const sep = base.includes('\\') ? '\\' : '/';
    const sub = folder.value.trim().split(/[\\/]+/).filter(Boolean).join(sep);
    where.textContent = base ? 'Downloads landen in: ' + base + (sub ? sep + sub : '') : '';
    where.hidden = !base;
  };
  folder.addEventListener('input', showWhere);
  showWhere();
  const outside = el('p', { class: 'set-hint set-warn', text: extra.lastOutsideDir
    ? 'Zuletzt gewählt: „' + extra.lastOutsideDir + '“ – liegt außerhalb des Firefox-Download-Ordners und kann nicht automatisch verwendet werden. Lösung: diesen Ordner in Firefox als Download-Ordner einstellen.' : '' });
  outside.hidden = !extra.lastOutsideDir;

  root.replaceChildren(
    el('label', { class: 'set-label', for: 'set-act', text: 'Klick auf das Symbol öffnet' }),
    act,
    el('label', { class: 'set-label', for: 'set-folder', text: 'Download-Ordner' }),
    folder,
    where,
    el('p', { class: 'set-hint', text: 'Unterordner innerhalb deines Firefox-Download-Ordners. Leer lassen = direkt in den Download-Ordner. Den Hauptordner selbst änderst du in Firefox unter Einstellungen → Allgemein → Dateien und Anwendungen → Downloads.' }),
    check('rememberLast', 'Zuletzt mit „Speichern unter …“ gewählten Ordner merken und künftig automatisch dorthin speichern'),
    outside,
    check('askWhere', 'Vor jedem Download nach dem Speicherort fragen'),
    check('autoDeep', 'Tiefensuche automatisch starten, wenn kein Video gefunden wird'),
    check('showAll', 'Alle gefundenen Qualitätsstufen aufgeklappt anzeigen'),
    check('autoResume', 'Abgebrochene Downloads automatisch fortsetzen (auch nach Neustart)'),
    check('openSidebar', 'Seitenleiste beim Start eines Downloads öffnen'),
    check('autoUpdate', 'Updates automatisch suchen und installieren'),
    el('label', { class: 'set-label', for: 'set-clr', text: 'Fertige Downloads aus der Liste entfernen' }),
    clr,
    el('p', { class: 'set-hint', text: 'Gilt für fertige und abgebrochene Downloads. Die gespeicherten Dateien bleiben erhalten.' }),
    el('label', { class: 'set-label', for: 'set-par', text: 'Gleichzeitige Downloads' }),
    par,
    el('p', { class: 'set-hint', text: 'Weitere Downloads warten in der Schlange. Bei „Unbegrenzt“ starten alle sofort – Firefox selbst lädt aber höchstens etwa 6 Verbindungen gleichzeitig vom selben Server, sehr viele Downloads teilen sich also die Bandbreite.' }),
    el('label', { class: 'set-label', for: 'set-min', text: 'Dateien kleiner als (KB) ausblenden' }),
    min,
    saved
  );
}
