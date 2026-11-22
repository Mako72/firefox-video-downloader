'use strict';
/* global renderSettings, el, fmtBytes, fmtDur, jobProgress, jobStatus */

let tabId = null;
let state = { groups: [], deep: 'idle', settings: {} };
let autoDeepDone = false;
const cards = new Map();
const expanded = new Set();

const $list = document.getElementById('list');
const $status = document.getElementById('status');
const $deep = document.getElementById('deep');
const $settings = document.getElementById('settings');

function nameOf(it) {
  if (it.kind === 'hls') return 'HLS-Stream';
  if (it.kind === 'dash') return 'DASH-Stream';
  try {
    const last = decodeURIComponent(new URL(it.url).pathname.split('/').pop() || '');
    return last || new URL(it.url).hostname;
  } catch (e) { return it.url; }
}
function qualityText(it) {
  if (it.label) return it.label;
  if (it.height) return it.height + 'p';
  return '';
}

async function refresh() {
  if (tabId == null) return;
  state = await browser.runtime.sendMessage({ type: 'getList', tabId });
  render();
}
let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}

function render() {
  const { groups, deep } = state;
  $deep.disabled = deep === 'running';
  $deep.textContent = deep === 'running' ? '⏳ Suche…' : '🔍 Tiefensuche';

  $status.replaceChildren();
  if (state.update && state.update.available) {
    const u = el('div', { class: 'upd' }, el('span', { text: '⬆ Update ' + (state.update.latest || '') + ' verfügbar – ' }));
    const a = el('button', { class: 'toggle', text: 'in der Seitenleiste installieren' });
    a.addEventListener('click', openSidebar);
    u.append(a);
    $status.append(u);
  }
  if (deep === 'running') {
    $status.append(el('span', { class: 'spin' }), 'Tiefensuche läuft – Seite, Skripte und eingebettete Frames werden durchsucht…');
  } else if (groups.length) {
    $status.append(groups.length === 1 ? '1 Video gefunden' : groups.length + ' Videos gefunden');
  }

  const keep = new Set(groups.map(g => g.key));
  for (const [k, c] of cards) if (!keep.has(k)) { c.root.remove(); cards.delete(k); }

  if (!groups.length) {
    if (!$list.querySelector('.empty')) {
      $list.replaceChildren(el('li', { class: 'empty' },
        el('b', { text: deep === 'running' ? 'Suche läuft…' : 'Kein Video gefunden' }),
        el('span', { text: deep === 'done'
          ? 'Tipp: Starte das Video kurz und öffne dieses Fenster erneut. Manche Seiten laden ihre Videos erst beim Abspielen.'
          : 'Starte die Tiefensuche, um versteckte und eingebettete Videos aufzuspüren.' })));
    } else {
      $list.querySelector('.empty b').textContent = deep === 'running' ? 'Suche läuft…' : 'Kein Video gefunden';
    }
    return;
  }
  const empty = $list.querySelector('.empty');
  if (empty) empty.remove();

  groups.forEach((g, i) => {
    let c = cards.get(g.key);
    if (!c) { c = createCard(g); cards.set(g.key, c); }
    updateCard(c, g);
    if ($list.children[i] !== c.root) $list.insertBefore(c.root, $list.children[i] || null);
  });
}

function createCard(g) {
  const c = {};
  c.thumb = el('div', { class: 'thumb' });
  c.dur = el('span', { class: 'dur' });
  c.name = el('div', { class: 'name' });
  c.meta = el('div', { class: 'meta' });
  c.msg = el('div', { class: 'msg' });
  c.actions = el('div', { class: 'actions' });
  c.othersWrap = el('div');
  c.body = el('div', { class: 'body' }, c.name, c.meta, c.msg, c.othersWrap, c.actions);
  c.root = el('li', { class: 'card' }, c.thumb, c.body);
  c.thumbSrc = null;
  return c;
}

function setThumb(c, g) {
  const best = g.best;
  const want = g.thumb ? 'img:' + g.thumb : (best.kind === 'direct' ? 'vid:' + best.url : 'ph');
  if (c.thumbSrc === want) return;
  c.thumbSrc = want;
  let node;
  if (g.thumb) {
    node = el('img', { src: g.thumb, alt: '', referrerpolicy: 'no-referrer' });
    node.addEventListener('error', () => { node.replaceWith(el('span', { class: 'ph', text: '🎬' })); });
  } else if (best.kind === 'direct') {
    node = el('video', { muted: '', preload: 'metadata', src: best.url + '#t=3' });
    node.muted = true;
    node.addEventListener('error', () => { node.replaceWith(el('span', { class: 'ph', text: '🎬' })); });
    node.addEventListener('loadedmetadata', () => { if (!best.duration && node.duration && isFinite(node.duration)) c.dur.textContent = fmtDur(node.duration); });
  } else {
    node = el('span', { class: 'ph', text: '📡' });
  }
  c.thumb.replaceChildren(node, c.dur);
}

function jobView(job) {
  if (!job) return null;
  const p = jobProgress(job);
  const st = jobStatus(job);
  const active = ['running', 'merging', 'queued'].includes(job.state);
  const resumable = job.state === 'paused' || job.state === 'interrupted';
  let text = st.text;
  if (job.state === 'running' && p.line) text = (job.phase || 'Lade herunter') + ' – ' + p.line;
  return { active, resumable, pct: p.pct, cls: st.cls, text, id: job.id, done: job.state === 'done' };
}

function openSidebar() {
  // muss direkt im Klick-Handler aufgerufen werden (Nutzeraktion)
  browser.sidebarAction.open().catch(() => {});
}

function statusView(it) {
  switch (it.status) {
    case 'protected': return { cls: 'err', text: 'Verschlüsselt/DRM-geschützt – Download nicht möglich', block: true };
    case 'live': return { cls: 'warn', text: 'Live-Stream – Download wird nicht unterstützt', block: true };
    case 'error': return { cls: 'err', text: 'Konnte nicht gelesen werden: ' + (it.error || ''), block: false };
    case 'analyzing': case 'new': return { cls: '', text: 'Wird analysiert…', block: false };
    default: return null;
  }
}

function updateCard(c, g) {
  const it = g.best;
  setThumb(c, g);
  c.dur.textContent = fmtDur(it.duration) || c.dur.textContent;
  c.dur.hidden = !c.dur.textContent;
  c.name.textContent = nameOf(it);
  c.name.title = it.url;

  const tags = [];
  const q = qualityText(it);
  if (q) tags.push(el('span', { class: 'tag q', text: q }));
  tags.push(el('span', { class: 'tag', text: String(it.ext).toUpperCase() }));
  if (it.size) tags.push(el('span', { class: 'tag', text: (it.kind === 'direct' ? '' : '≈ ') + fmtBytes(it.size) }));
  const versions = Math.max(g.others.length + 1, it.variantCount || 0);
  if (versions > 1) tags.push(el('span', { class: 'tag best', text: 'Beste von ' + versions + ' Versionen' }));
  if (it.sources.includes('deep') && !it.sources.includes('network') && !it.sources.includes('dom')) tags.push(el('span', { class: 'tag', text: 'Tiefensuche' }));
  c.meta.replaceChildren(...tags);

  const jv = jobView(it.job);
  const sv = statusView(it);
  const info = jv || sv;
  c.msg.className = 'msg' + (info && info.cls ? ' ' + info.cls : '');
  c.msg.textContent = info ? info.text : (it.separateAudio ? 'Bild und Ton werden zusammengeführt' : '');

  // Aktionen
  c.actions.replaceChildren();
  if (jv && (jv.active || jv.resumable)) {
    const bar = el('div', { class: 'bar' + (jv.pct == null && jv.active ? ' indet' : '') }, el('div'));
    if (jv.pct != null) bar.firstChild.style.width = jv.pct + '%';
    const ctl = jv.active
      ? el('button', { class: 'btn ghost small', text: '⏸', title: 'Pausieren' })
      : el('button', { class: 'btn small', text: '▶', title: 'Fortsetzen' });
    ctl.addEventListener('click', () => browser.runtime.sendMessage({ type: jv.active ? 'pauseJob' : 'resumeJob', id: jv.id }).then(refreshSoon));
    const cancel = el('button', { class: 'btn danger small', text: '✕', title: 'Abbrechen' });
    cancel.addEventListener('click', () => browser.runtime.sendMessage({ type: 'cancelJob', id: jv.id }).then(refreshSoon));
    c.actions.append(bar, ctl, cancel);
  } else {
    const dl = el('button', { class: 'btn', text: jv && jv.done ? '⬇ Erneut laden' : '⬇ Herunterladen' });
    dl.disabled = !!(sv && sv.block);
    dl.addEventListener('click', () => {
      if (state.settings.openSidebar) openSidebar();
      dl.disabled = true;
      browser.runtime.sendMessage({ type: 'download', tabId, key: it.key }).then(refreshSoon);
    });
    c.actions.append(dl);
  }

  // weitere Versionen
  c.othersWrap.replaceChildren();
  if (g.others.length) {
    const open = state.settings.showAll || expanded.has(g.key);
    const t = el('button', { class: 'toggle', text: (open ? '▾ ' : '▸ ') + 'Weitere Versionen (' + g.others.length + ')' });
    t.addEventListener('click', () => {
      if (expanded.has(g.key)) expanded.delete(g.key); else expanded.add(g.key);
      render();
    });
    c.othersWrap.append(t);
    if (open) {
      const ul = el('ul', { class: 'others' });
      for (const o of g.others) {
        const b = el('button', { class: 'btn ghost small', text: '⬇' });
        b.title = 'Diese Version herunterladen';
        b.addEventListener('click', () => {
          if (state.settings.openSidebar) openSidebar();
          browser.runtime.sendMessage({ type: 'download', tabId, key: o.key }).then(refreshSoon);
        });
        const ojv = jobView(o.job);
        const desc = [qualityText(o) || 'unbekannte Qualität', String(o.ext).toUpperCase(), fmtBytes(o.size), ojv ? ojv.text : ''].filter(Boolean).join(' · ');
        const span = el('span', { text: desc });
        span.title = o.url;
        ul.append(el('li', {}, span, b));
      }
      c.othersWrap.append(ul);
    }
  }
}

function startDeep() {
  browser.runtime.sendMessage({ type: 'deepSearch', tabId }).then(refreshSoon);
}

$deep.addEventListener('click', startDeep);
document.getElementById('side').addEventListener('click', () => { openSidebar(); window.close(); });
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
  await refresh();
  await browser.runtime.sendMessage({ type: 'rescan', tabId }).catch(() => {});
  setTimeout(async () => {
    await refresh();
    if (!state.groups.length && state.settings.autoDeep && state.deep === 'idle' && !autoDeepDone) {
      autoDeepDone = true;
      startDeep();
    }
  }, 800);
})();
