'use strict';
/* global renderSettings, el, fmtBytes, fmtDur, jobProgress, jobStatus */

let tabId = null;
let tabTitle = '';
let state = { groups: [], deep: 'idle', settings: {}, update: null };
let autoDeepDone = false;
const rows = new Map();

const $list = document.getElementById('list');
const $deep = document.getElementById('deep');
const $settings = document.getElementById('settings');
const $notice = document.getElementById('notice');
const $count = document.getElementById('count');
const $menu = document.getElementById('menu');

const send = m => browser.runtime.sendMessage(m);

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------
function openSidebar() {
  // muss direkt im Klick-Handler aufgerufen werden (Nutzeraktion)
  browser.sidebarAction.open().catch(() => {});
}
function toast(text) {
  const t = el('div', { class: 'toast', text });
  document.body.append(t);
  setTimeout(() => t.remove(), 1600);
}
function fileName(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch (e) { return ''; }
}
function titleOf(it) {
  if (it.kind === 'direct') {
    const f = fileName(it.url);
    // Dateinamen wie "1080.mp4" oder "video.mp4" sagen wenig – dann lieber den Seitentitel
    if (f && !/^(video|index|master|playlist|media|file|stream)?[_\-]?\d*p?\.[a-z0-9]+$/i.test(f)) return f;
  }
  return tabTitle || fileName(it.url) || 'Video';
}
function qualityText(it) { return it.label || (it.height ? it.height + 'p' : ''); }
function subline(it, versions) {
  const parts = [];
  const q = qualityText(it);
  if (q) parts.push(el('b', { text: q }));
  parts.push(String(it.ext).toUpperCase());
  if (it.size) parts.push((it.kind === 'direct' ? '' : '≈ ') + fmtBytes(it.size));
  if (versions > 1) parts.push('beste von ' + versions);
  if (it.separateAudio) parts.push('Bild + Ton');
  const out = [];
  parts.forEach((p, i) => { if (i) out.push(' · '); out.push(p); });
  return out;
}
function blocked(it) {
  if (it.status === 'protected') return 'Verschlüsselt/DRM – nicht möglich';
  if (it.status === 'live') return 'Live-Stream – nicht unterstützt';
  return '';
}

// ---------------------------------------------------------------------------
// Daten holen und anzeigen
// ---------------------------------------------------------------------------
async function refresh() {
  if (tabId == null) return;
  state = await send({ type: 'getList', tabId });
  render();
}
let refreshTimer = null;
function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 120); }

function render() {
  const { groups, deep } = state;
  $deep.disabled = deep === 'running';
  $deep.classList.toggle('spinning', deep === 'running');

  // Hinweiszeile (Update / Tiefensuche)
  $notice.replaceChildren();
  if (deep === 'running') {
    $notice.append(el('span', { class: 'spin' }), 'Tiefensuche läuft …');
  } else if (state.update && state.update.available) {
    const b = el('button', { class: 'linkbtn', text: 'In der Seitenleiste installieren' });
    b.addEventListener('click', openSidebar);
    $notice.append('⬆ Update ' + (state.update.latest || '') + ' verfügbar.', b);
  }
  $notice.hidden = !$notice.childNodes.length;

  $count.textContent = groups.length === 1 ? '1 Video auf dieser Seite' : groups.length + ' Videos auf dieser Seite';

  const keep = new Set(groups.map(g => g.key));
  for (const [k, r] of rows) if (!keep.has(k)) { r.root.remove(); rows.delete(k); }

  if (!groups.length) {
    const msg = deep === 'running' ? 'Suche läuft …' : 'Kein Video gefunden';
    const tip = deep === 'done'
      ? 'Starte das Video kurz und öffne dieses Fenster erneut. Manche Seiten laden Videos erst beim Abspielen.'
      : 'Mit 🔍 oben werden auch versteckte und eingebettete Videos gesucht.';
    let box = $list.querySelector('.emptybox');
    if (!box) { box = el('li', { class: 'emptybox' }, el('b'), el('span')); $list.replaceChildren(box); }
    box.firstChild.textContent = msg;
    box.lastChild.textContent = tip;
    return;
  }
  const empty = $list.querySelector('.emptybox');
  if (empty) empty.remove();

  groups.forEach((g, i) => {
    let r = rows.get(g.key);
    if (!r) { r = createRow(); rows.set(g.key, r); }
    updateRow(r, g);
    if ($list.children[i] !== r.root) $list.insertBefore(r.root, $list.children[i] || null);
  });
}

function createRow() {
  const r = {};
  r.th = el('div', { class: 'th' });
  r.dur = el('span', { class: 'dur' });
  r.ti = el('div', { class: 'ti' });
  r.sub = el('div', { class: 'sub' });
  r.state = el('div', { class: 'state' });
  r.pbar = el('div', { class: 'pbar' }, el('div'));
  r.mid = el('div', { class: 'mid' }, r.ti, r.sub, r.state, r.pbar);
  r.acts = el('div', { class: 'acts' });
  r.root = el('li', { class: 'row' }, r.th, r.mid, r.acts);
  r.thumbKey = null;
  return r;
}

function setThumb(r, g) {
  const it = g.best;
  const want = g.thumb ? 'img:' + g.thumb : (it.kind === 'direct' ? 'vid:' + it.url : 'ph');
  if (r.thumbKey === want) return;
  r.thumbKey = want;
  const ph = () => el('span', { text: it.kind === 'direct' ? '🎬' : '📡' });
  let node;
  if (g.thumb) {
    node = el('img', { src: g.thumb, alt: '', referrerpolicy: 'no-referrer' });
    node.addEventListener('error', () => node.replaceWith(ph()));
  } else if (it.kind === 'direct') {
    node = el('video', { preload: 'metadata', src: it.url + '#t=3' });
    node.muted = true;
    node.addEventListener('error', () => node.replaceWith(ph()));
    node.addEventListener('loadedmetadata', () => {
      if (!it.duration && isFinite(node.duration)) { r.dur.textContent = fmtDur(node.duration); r.dur.hidden = false; }
    });
  } else node = ph();
  r.th.replaceChildren(node, r.dur);
}

function updateRow(r, g) {
  const it = g.best;
  setThumb(r, g);
  if (it.duration) r.dur.textContent = fmtDur(it.duration);
  r.dur.hidden = !r.dur.textContent;
  r.ti.textContent = titleOf(it);
  r.ti.title = it.url;
  const versions = Math.max(g.others.length + 1, it.variantCount || 0);
  r.sub.replaceChildren(...subline(it, versions));

  const job = it.job;
  const block = blocked(it);
  const active = job && ['running', 'merging', 'queued'].includes(job.state);
  const resumable = job && ['paused', 'interrupted'].includes(job.state);

  // Statuszeile + Balken
  let stText = '', stCls = '';
  if (job) {
    const st = jobStatus(job);
    const p = jobProgress(job);
    stText = job.state === 'running' && p.line ? p.line : st.text;
    stCls = st.cls || '';
    r.pbar.hidden = !(active || resumable);
    r.pbar.className = 'pbar' + (p.pct == null && active ? ' indet' : '');
    r.pbar.firstChild.style.width = (p.pct == null ? 0 : p.pct) + '%';
  } else {
    r.pbar.hidden = true;
    if (block) { stText = block; stCls = 'err'; }
    else if (it.status === 'analyzing' || it.status === 'new') stText = 'Wird analysiert …';
    else if (it.status === 'error') { stText = 'Nicht lesbar: ' + (it.error || ''); stCls = 'err'; }
  }
  r.state.className = 'state ' + stCls;
  r.state.textContent = stText;
  r.state.hidden = !stText;

  // Knöpfe
  r.acts.replaceChildren();
  let main;
  if (active) {
    main = el('button', { class: 'dl ghost', title: 'Pausieren', text: '⏸' });
    main.addEventListener('click', () => send({ type: 'pauseJob', id: job.id }).then(refreshSoon));
  } else if (resumable) {
    main = el('button', { class: 'dl', title: 'Fortsetzen', text: '▶' });
    main.addEventListener('click', () => send({ type: 'resumeJob', id: job.id }).then(refreshSoon));
  } else {
    main = el('button', { class: 'dl', title: job && job.state === 'done' ? 'Erneut herunterladen' : 'Herunterladen (beste Qualität)', text: '⬇' });
    main.disabled = !!block;
    main.addEventListener('click', () => startDownload(it.key, false));
  }
  const more = el('button', { class: 'more', title: 'Weitere Aktionen', text: '⋮' });
  more.addEventListener('click', ev => { ev.stopPropagation(); openMenu(more, g); });
  r.acts.append(main, more);
}

function startDownload(key, askWhere) {
  if (state.settings.openSidebar) openSidebar();
  send({ type: 'download', tabId, key, askWhere: askWhere ? true : undefined }).then(refreshSoon);
}

// ---------------------------------------------------------------------------
// Aktionsmenü (⋮)
// ---------------------------------------------------------------------------
function closeMenu() { $menu.hidden = true; $menu.replaceChildren(); }
document.addEventListener('click', e => { if (!$menu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

function item(text, onClick, opts) {
  const b = el('button', {}, el('span', { text }));
  if (opts && opts.right) b.append(el('span', { class: 'q', text: opts.right }));
  if (opts && opts.disabled) b.disabled = true;
  b.addEventListener('click', () => { closeMenu(); onClick(); });
  return b;
}

function openMenu(anchor, g) {
  const it = g.best;
  const job = it.job;
  const block = !!blocked(it);
  const kids = [];
  const active = job && ['running', 'merging', 'queued'].includes(job.state);
  const resumable = job && ['paused', 'interrupted'].includes(job.state);

  if (active || resumable) {
    if (active) kids.push(item('⏸  Pausieren', () => send({ type: 'pauseJob', id: job.id }).then(refreshSoon)));
    if (resumable) kids.push(item('▶  Fortsetzen', () => send({ type: 'resumeJob', id: job.id }).then(refreshSoon)));
    kids.push(item('✕  Abbrechen', () => send({ type: 'cancelJob', id: job.id }).then(refreshSoon)));
    kids.push(el('div', { class: 'sep' }));
  }
  kids.push(item('⬇  Herunterladen', () => startDownload(it.key, false), { right: qualityText(it), disabled: block }));
  kids.push(item('💾  Speichern unter …', () => startDownload(it.key, true), { disabled: block }));
  if (g.others.length) {
    kids.push(el('div', { class: 'sep' }), el('div', { class: 'hd', text: 'Andere Qualität' }));
    for (const o of g.others) {
      const right = [String(o.ext).toUpperCase(), fmtBytes(o.size)].filter(x => x && x !== '0 B').join(' · ');
      kids.push(item('⬇  ' + (qualityText(o) || 'unbekannt'), () => startDownload(o.key, false), { right }));
    }
  }
  kids.push(el('div', { class: 'sep' }));
  kids.push(item('🔗  Adresse kopieren', () => {
    navigator.clipboard.writeText(it.url).then(() => toast('Adresse kopiert'), () => toast('Kopieren nicht möglich'));
  }));
  if (it.kind === 'direct') kids.push(item('▶  Vorschau im neuen Tab', () => browser.tabs.create({ url: it.url })));
  kids.push(item('📋  Download-Seitenleiste', openSidebar));

  $menu.replaceChildren(...kids);
  $menu.hidden = false;
  // Position: unter dem Knopf, rechtsbündig, im Fenster halten
  const a = anchor.getBoundingClientRect();
  const w = $menu.offsetWidth, h = $menu.offsetHeight;
  let left = Math.max(6, Math.min(a.right - w, window.innerWidth - w - 6));
  let top = a.bottom + 4;
  if (top + h > window.innerHeight - 6) top = Math.max(6, a.top - h - 4);
  $menu.style.left = left + 'px';
  $menu.style.top = top + 'px';
}

// ---------------------------------------------------------------------------
// Kopfzeile, Tiefensuche, Einstellungen
// ---------------------------------------------------------------------------
function startDeep() { send({ type: 'deepSearch', tabId }).then(refreshSoon); }

$deep.addEventListener('click', startDeep);
document.getElementById('side').addEventListener('click', () => { openSidebar(); window.close(); });
document.getElementById('openSide').addEventListener('click', () => { openSidebar(); window.close(); });
document.getElementById('gear').addEventListener('click', async () => {
  if ($settings.hidden) await renderSettings($settings);
  $settings.hidden = !$settings.hidden;
});

browser.runtime.onMessage.addListener(msg => {
  if (msg.type === 'mediaUpdated' && msg.tabId === tabId) refreshSoon();
  if (msg.type === 'jobsUpdated') refreshSoon();
});
browser.storage.onChanged.addListener(() => refreshSoon());

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  tabId = tab.id;
  tabTitle = tab.title || '';
  await refresh();
  await send({ type: 'rescan', tabId }).catch(() => {});
  setTimeout(async () => {
    await refresh();
    if (!state.groups.length && state.settings.autoDeep && state.deep === 'idle' && !autoDeepDone) {
      autoDeepDone = true;
      startDeep();
    }
  }, 800);
})();
