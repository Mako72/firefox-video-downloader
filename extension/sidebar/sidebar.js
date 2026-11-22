/* global el, fmtBytes, fmtEta, jobProgress, jobStatus */
(() => {
'use strict';

const $jobs = document.getElementById('jobs');
const $summary = document.getElementById('summary');
const $update = document.getElementById('update');
let data = { jobs: [], update: null, settings: {} };
const rows = new Map();
const confirmCancel = new Map();

const send = m => browser.runtime.sendMessage(m);

async function refresh() {
  data = await send({ type: 'getJobs' });
  render();
}
let t = null;
function refreshSoon() { clearTimeout(t); t = setTimeout(refresh, 100); }

function button(text, cls, title, onClick) {
  const b = el('button', { class: 'btn small ' + (cls || ''), text });
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function render() {
  renderSummary();
  const ids = new Set(data.jobs.map(j => j.id));
  for (const [id, r] of rows) if (!ids.has(id)) { r.root.remove(); rows.delete(id); }
  if (!data.jobs.length) {
    if (!$jobs.querySelector('.empty-side')) {
      $jobs.replaceChildren(el('li', { class: 'empty-side' },
        el('div', { text: 'Noch keine Downloads.' }),
        el('div', { text: 'Klicke im Video-Downloader-Fenster auf „Herunterladen“ – der Fortschritt erscheint hier.' })));
    }
  } else {
    const empty = $jobs.querySelector('.empty-side');
    if (empty) empty.remove();
    data.jobs.forEach((j, i) => {
      let r = rows.get(j.id);
      if (!r) { r = createRow(j); rows.set(j.id, r); }
      updateRow(r, j);
      if ($jobs.children[i] !== r.root) $jobs.insertBefore(r.root, $jobs.children[i] || null);
    });
  }
  renderUpdate();
}

function renderSummary() {
  const active = data.jobs.filter(j => j.state === 'running' || j.state === 'merging');
  const waiting = data.jobs.filter(j => j.state === 'queued' || j.state === 'interrupted');
  const tc = document.getElementById('tabDownloadsCount');
  if (tc) tc.textContent = active.length + waiting.length ? String(active.length + waiting.length) : '';
  if (!active.length && !waiting.length) { $summary.replaceChildren(); return; }
  const speed = active.reduce((s, j) => s + (j.speed || 0), 0);
  const eta = Math.max(0, ...active.map(j => j.eta || 0));
  const bytes = active.reduce((s, j) => s + (j.bytes || 0), 0);
  const total = active.reduce((s, j) => s + (j.estTotal || 0), 0);
  const txt = [
    active.length + ' aktiv',
    waiting.length ? waiting.length + ' wartend' : '',
    speed ? fmtBytes(speed) + '/s' : '',
    eta ? fmtEta(eta) : ''
  ].filter(Boolean).join(' · ');
  const bar = el('div', { class: 'bar' + (total ? '' : ' indet') }, el('div'));
  if (total) bar.firstChild.style.width = Math.min(100, bytes / total * 100) + '%';
  $summary.replaceChildren(el('div', { text: 'Gesamt: ' + txt }), bar);
}

function createRow(j) {
  const r = {};
  r.thumb = el('div', { class: 'jthumb' });
  r.title = el('div', { class: 'jtitle' });
  r.meta = el('div', { class: 'jmeta' });
  r.bar = el('div', { class: 'bar big' }, el('div'));
  r.line = el('div', { class: 'line' });
  r.st = el('div', { class: 'st' });
  r.sub = el('div', { class: 'sub' });
  r.btns = el('div', { class: 'btns' });
  r.root = el('li', { class: 'job' },
    el('div', { class: 'top' }, r.thumb, el('div', { class: 'jinfo' }, r.title, r.meta)),
    r.bar, r.line, r.st, r.sub, r.btns);
  r.thumbSrc = undefined;
  return r;
}

function updateRow(r, j) {
  r.root.className = 'job ' + j.state;
  if (r.thumbSrc !== (j.thumb || null)) {
    r.thumbSrc = j.thumb || null;
    if (j.thumb) {
      const img = el('img', { src: j.thumb, alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.replaceWith(document.createTextNode('🎬')));
      r.thumb.replaceChildren(img);
    } else r.thumb.textContent = j.kind === 'direct' ? '🎬' : '📡';
  }
  r.title.textContent = j.title || j.filename || 'Video';
  r.title.title = j.source;
  const tags = [];
  if (j.label) tags.push(el('span', { class: 'tag q', text: j.label }));
  tags.push(el('span', { class: 'tag', text: j.kind === 'direct' ? 'Datei' : j.kind.toUpperCase() }));
  if (j.audioOnly) tags.push(el('span', { class: 'tag', text: '🎵 Nur Ton' }));
  if (j.restarts) tags.push(el('span', { class: 'tag', text: 'neu gestartet' }));
  r.meta.replaceChildren(...tags);

  const p = jobProgress(j);
  r.bar.className = 'bar big' + (p.pct == null && (j.state === 'running' || j.state === 'merging') ? ' indet' : '') +
    (j.state === 'done' ? ' okbar' : (j.state === 'paused' || j.state === 'interrupted') ? ' warnbar' : '');
  r.bar.firstChild.style.width = (p.pct == null ? (j.state === 'running' || j.state === 'merging' ? 30 : 0) : p.pct) + '%';
  r.bar.hidden = j.state === 'cancelled' || j.state === 'error';
  r.line.textContent = p.line;
  r.line.hidden = !p.line;
  const s = jobStatus(j);
  r.st.className = 'st ' + (s.cls || '');
  r.st.textContent = s.text;
  r.sub.textContent = s.sub || '';
  r.sub.hidden = !s.sub;

  // Buttons
  const b = [];
  const id = j.id;
  if (j.state === 'running' || j.state === 'queued') {
    b.push(button('⏸ Pausieren', 'ghost', 'Anhalten – später an derselben Stelle fortsetzen', () => send({ type: 'pauseJob', id }).then(refreshSoon)));
  }
  if (j.state === 'paused' || j.state === 'interrupted') {
    b.push(button('▶ Fortsetzen', '', 'An der abgebrochenen Stelle weiterladen', () => send({ type: 'resumeJob', id }).then(refreshSoon)));
  }
  if (['running', 'queued', 'paused', 'interrupted', 'merging'].includes(j.state)) {
    const armed = confirmCancel.get(id) > Date.now();
    b.push(button(armed ? 'Wirklich abbrechen?' : '✕ Abbrechen', 'danger', 'Download abbrechen und Teildaten löschen', () => {
      if (confirmCancel.get(id) > Date.now()) {
        confirmCancel.delete(id);
        send({ type: 'cancelJob', id }).then(refreshSoon);
      } else {
        confirmCancel.set(id, Date.now() + 3000);
        render();
        setTimeout(render, 3100);
      }
    }));
  }
  if (j.state === 'error' || j.state === 'cancelled') {
    b.push(button('↻ Neu starten', '', 'Download noch einmal von vorn beginnen', () => send({ type: 'resumeJob', id }).then(refreshSoon)));
  }
  if (j.state === 'done' && j.downloadId != null) {
    b.push(button('▶ Öffnen', '', 'Datei öffnen', () => browser.downloads.open(j.downloadId).catch(e => alertRow(r, e))));
    b.push(button('📂 Im Ordner zeigen', 'ghost', '', () => browser.downloads.show(j.downloadId).catch(e => alertRow(r, e))));
  }
  if (['done', 'error', 'cancelled'].includes(j.state)) {
    b.push(button('🗑', 'ghost', 'Aus der Liste entfernen (die Datei bleibt erhalten)', () => send({ type: 'removeJob', id }).then(refreshSoon)));
  }
  r.btns.replaceChildren(...b);
}

function alertRow(r, e) {
  r.sub.hidden = false;
  r.sub.textContent = 'Nicht möglich: ' + (e && e.message ? e.message : e) + ' (Datei verschoben oder gelöscht?)';
}

function renderUpdate() {
  const u = data.update;
  if (!u) { $update.replaceChildren(); return; }
  $update.className = 'update' + (u.available ? ' avail' : '');
  const kids = [];
  const row = el('div', { class: 'row' }, el('span', { text: 'Version ' + u.current }));
  if (u.pendingReload) {
    row.append(button('⬆ Jetzt installieren', '', 'Update installieren – laufende Downloads werden danach automatisch fortgesetzt',
      () => send({ type: 'installUpdate' })));
  } else if (u.available && u.link) {
    row.append(button('⬇ Update ' + u.latest + ' laden', '', 'Neue Version herunterladen und installieren',
      () => send({ type: 'installUpdate' })));
  } else {
    const c = button(u.state === 'checking' ? 'Suche…' : 'Nach Updates suchen', 'ghost', '', () => {
      c.disabled = true;
      send({ type: 'checkUpdates' }).then(upd => { data.update = upd; renderUpdate(); });
    });
    c.disabled = u.state === 'checking';
    row.append(c);
  }
  kids.push(row);
  if (u.message) kids.push(el('div', { text: u.message }));
  if (u.available && !u.pendingReload) {
    kids.push(el('div', { class: 'hint', text: 'Firefox fragt anschließend nach der Installation. Alternativ installiert Firefox Updates auch selbst: about:addons → Zahnrad → „Nach Updates suchen“.' }));
  } else if (u.checkedAt && !u.message) {
    kids.push(el('div', { class: 'hint', text: 'Zuletzt geprüft: ' + new Date(u.checkedAt).toLocaleString('de-DE') }));
  }
  $update.replaceChildren(...kids);
}

document.getElementById('pauseAll').addEventListener('click', () => send({ type: 'pauseAll' }).then(refreshSoon));
document.getElementById('resumeAll').addEventListener('click', () => send({ type: 'resumeAll' }).then(refreshSoon));
document.getElementById('clear').addEventListener('click', () => send({ type: 'clearFinished' }).then(refreshSoon));

browser.runtime.onMessage.addListener(msg => {
  if (msg.type === 'jobsUpdated') refreshSoon();
  if (msg.type === 'updateInfo') { data.update = msg.update; renderUpdate(); }
});
// Countdown für automatische Wiederholversuche aktualisieren
setInterval(() => { if (data.jobs.some(j => j.state === 'interrupted' && j.retryAt)) render(); }, 1000);
refresh();
})();
