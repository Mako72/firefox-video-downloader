'use strict';
/* global VDL, VDLMp4 */

const DEFAULTS = {
  subfolder: 'Videos', askWhere: false, autoDeep: true, showAll: false, minSizeKB: 300,
  maxParallel: 2, autoResume: true, openSidebar: true, autoUpdate: true, iconAction: 'sidebar'
};
let settings = Object.assign({}, DEFAULTS);
const settingsReady = browser.storage.local.get(DEFAULTS).then(s => { settings = s; applyIconAction(); });

// Klick auf das Symbol: Seitenleiste öffnen/schließen (oder kleines Fenster, je nach Einstellung)
function applyIconAction() {
  browser.browserAction.setPopup({ popup: settings.iconAction === 'popup' ? 'popup/popup.html' : '' }).catch(() => {});
  browser.browserAction.setTitle({ title: settings.iconAction === 'popup' ? 'Video-Downloader' : 'Video-Downloader – Seitenleiste öffnen' }).catch(() => {});
}
browser.browserAction.onClicked.addListener(() => {
  // muss sofort im Klick passieren (Nutzeraktion), daher kein await davor
  const p = browser.sidebarAction.toggle ? browser.sidebarAction.toggle() : browser.sidebarAction.open();
  p.catch(() => browser.sidebarAction.open().catch(() => {}));
});
browser.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  for (const k in ch) settings[k] = ch[k].newValue;
  if (ch.iconAction) applyIconAction();
  for (const id of tabs.keys()) scheduleUpdate(id);
});

// ---------------------------------------------------------------------------
// Zustand pro Tab
// ---------------------------------------------------------------------------
const tabs = new Map();
function tabState(tabId) {
  let s = tabs.get(tabId);
  if (!s) {
    s = { items: new Map(), children: new Set(), pageThumb: null, pageUrl: '', deep: 'idle' };
    tabs.set(tabId, s);
  }
  return s;
}
browser.tabs.onRemoved.addListener(id => tabs.delete(id));

const refererByHost = new Map();
function rememberReferer(url, pageUrl) {
  if (!pageUrl || !/^https?:/.test(pageUrl)) return;
  try { refererByHost.set(new URL(url).host, pageUrl); } catch (e) { /* ignore */ }
}

const SEP_SOURCES = ['network', 'dom', 'deep', 'menu'];

function addItem(tabId, d) {
  if (tabId < 0 || !d.url || !/^https?:/i.test(d.url)) return null;
  const st = tabState(tabId);
  const key = VDL.cleanUrl(d.url);
  let it = st.items.get(key);
  const isNew = !it;
  if (!it) {
    it = {
      key, url: key, kind: d.kind || 'direct', sources: new Set(), size: 0, width: 0, height: 0,
      bandwidth: 0, rank: 0, label: '', thumb: null, status: 'new', error: '', ct: '', duration: 0,
      groupHint: null, info: null, separateAudio: false
    };
    st.items.set(key, it);
  }
  if (d.source && SEP_SOURCES.includes(d.source)) it.sources.add(d.source);
  if (d.kind && (it.kind === 'direct' || it.kind === 'segment') && (d.kind === 'hls' || d.kind === 'dash')) it.kind = d.kind;
  if (d.size && d.size > it.size) it.size = d.size;
  if (d.ct && !it.ct) it.ct = d.ct;
  if (d.width && !it.width) it.width = d.width;
  if (d.height && !it.height) it.height = d.height;
  if (d.thumb && !it.thumb) it.thumb = d.thumb;
  if (d.groupHint && !it.groupHint) it.groupHint = d.groupHint;
  if (d.frameId && !it.frameId) it.frameId = d.frameId;
  if (d.label) {
    const q = VDL.qualityFromString(d.label);
    if (q.rank && !it.height) { it.height = q.height; it.rank = q.rank; it.label = q.label; }
  }
  if (!it.height && !it.rank) {
    const q = VDL.qualityFromString(key);
    if (q.rank) { it.height = q.height; it.rank = q.rank; it.label = q.label; }
  }
  rememberReferer(key, d.pageUrl || st.pageUrl);
  if (isNew && it.kind !== 'segment') enqueueAnalysis(tabId, it);
  scheduleUpdate(tabId);
  return it;
}

// ---------------------------------------------------------------------------
// Netzwerk-Erkennung
// ---------------------------------------------------------------------------
browser.webRequest.onBeforeRequest.addListener(d => {
  if (d.type === 'main_frame' && d.tabId >= 0) {
    const st = tabState(d.tabId);
    st.items.clear(); st.children.clear(); st.pageThumb = null; st.deep = 'idle'; st.pageUrl = d.url; st.shownCount = 0;
    scheduleUpdate(d.tabId);
  }
}, { urls: ['<all_urls>'], types: ['main_frame'] });

function header(list, name) {
  const h = (list || []).find(x => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

browser.webRequest.onHeadersReceived.addListener(d => {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  const ct = header(d.responseHeaders, 'content-type');
  const kind = VDL.classify(d.url, ct);
  if (!kind) return;
  let size = parseInt(header(d.responseHeaders, 'content-length'), 10) || 0;
  const cr = header(d.responseHeaders, 'content-range').match(/\/(\d+)/);
  if (cr) size = +cr[1];
  const st = tabState(d.tabId);
  if (kind === 'segment') { st.sawSegments = true; return; }
  addItem(d.tabId, { url: d.url, kind, ct, size, source: 'network', pageUrl: d.documentUrl || st.pageUrl, frameId: d.frameId || 0 });
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other', 'main_frame', 'sub_frame'] }, ['responseHeaders']);

// Referer für eigene Anfragen (Analyse und Downloads) setzen – manche Server verlangen ihn.
browser.webRequest.onBeforeSendHeaders.addListener(d => {
  if (d.tabId !== -1) return;
  let host;
  try { host = new URL(d.url).host; } catch (e) { return; }
  const ref = refererByHost.get(host);
  if (!ref) return;
  const headers = d.requestHeaders.filter(h => h.name.toLowerCase() !== 'referer');
  headers.push({ name: 'Referer', value: ref });
  // Herkunft "moz-extension://…" durch die der Seite ersetzen (Hotlink-Schutz)
  const origin = headers.find(h => h.name.toLowerCase() === 'origin');
  if (origin && /^moz-extension:/i.test(origin.value)) {
    try { origin.value = new URL(ref).origin; } catch (e) { /* ignore */ }
  }
  return { requestHeaders: headers };
}, { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders']);

// ---------------------------------------------------------------------------
// Analyse (Playlists lesen, Größe ermitteln)
// ---------------------------------------------------------------------------
const queue = [];
let running = 0;
function enqueueAnalysis(tabId, it) {
  queue.push({ tabId, it });
  pump();
}
function pump() {
  while (running < 4 && queue.length) {
    const { tabId, it } = queue.shift();
    running++;
    analyze(tabId, it)
      .catch(e => { it.status = 'error'; it.error = e.message || String(e); })
      .finally(() => { running--; scheduleUpdate(tabId); pump(); });
  }
}

async function fetchText(url, signal) {
  const r = await fetch(url, { credentials: 'include', signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

async function probe(url) {
  let r;
  try {
    r = await fetch(url, { method: 'HEAD', credentials: 'include' });
    if (r.status === 405 || r.status === 403 || r.status === 501) r = null;
  } catch (e) { r = null; }
  if (!r) {
    const ctrl = new AbortController();
    r = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', signal: ctrl.signal });
    ctrl.abort();
  }
  if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
  const ct = r.headers.get('content-type') || '';
  let size = parseInt(r.headers.get('content-length'), 10) || 0;
  const cr = (r.headers.get('content-range') || '').match(/\/(\d+)/);
  if (cr) size = +cr[1];
  else if (r.status === 206) size = 0;
  return { ct, size, finalUrl: r.url };
}

async function analyze(tabId, it) {
  it.status = 'analyzing';
  const st = tabState(tabId);
  if (it.kind === 'direct') {
    if (!it.size || !it.ct) {
      const p = await probe(it.url);
      if (!it.ct) it.ct = p.ct;
      if (!it.size) it.size = p.size;
      const k = VDL.classify(p.finalUrl || it.url, p.ct);
      if (k === 'hls' || k === 'dash') { it.kind = k; return analyze(tabId, it); }
      if (!k && /text\/html|json|javascript|image\//i.test(p.ct)) { it.status = 'invalid'; return; }
    }
    it.status = 'ready';
    return;
  }

  if (it.kind === 'hls') {
    const pl = VDL.parseM3U8(await fetchText(it.url), it.url);
    it.info = pl;
    if (pl.type === 'master') {
      pl.variants.forEach(v => st.children.add(VDL.cleanUrl(v.url)));
      pl.audio.forEach(a => st.children.add(VDL.cleanUrl(a.url)));
      const best = pl.variants[0];
      if (!best) throw new Error('Playlist ohne Varianten');
      it.width = best.width; it.height = best.height || it.height; it.bandwidth = best.bandwidth;
      it.rank = it.height || Math.round(best.bandwidth / 5000);
      it.label = best.height ? best.height + 'p' : (best.bandwidth ? Math.round(best.bandwidth / 1000) + ' kbit/s' : '');
      it.variantCount = pl.variants.length;
      const media = VDL.parseM3U8(await fetchText(best.url), best.url);
      it.duration = media.duration;
      if (media.encrypted || pl.encrypted) { it.status = 'protected'; return; }
      if (media.live) { it.status = 'live'; return; }
      it.separateAudio = !!(best.audioGroup && pl.audio.some(a => a.group === best.audioGroup));
      if (best.peak && media.duration) { const est = Math.round(best.peak * media.duration / 8); if (est > 512 * 1024) it.size = est; }
    } else {
      it.duration = pl.duration;
      if (pl.encrypted) { it.status = 'protected'; return; }
      if (pl.live) { it.status = 'live'; return; }
    }
    // Wenn ein Master auftaucht, der diese Media-Playlist enthält, wird sie ausgeblendet (children).
    it.status = 'ready';
    return;
  }

  if (it.kind === 'dash') {
    const mpd = VDL.parseMPD(await fetchText(it.url), it.url);
    it.info = mpd;
    it.duration = mpd.duration;
    const v = mpd.video.find(r => !r.protected);
    const a = mpd.audio.find(r => !r.protected);
    if (!v && !a) { it.status = mpd.protected ? 'protected' : 'error'; it.error = 'Keine Spur gefunden'; return; }
    if (mpd.live) { it.status = 'live'; return; }
    const main = v || a;
    it.width = main.width; it.height = main.height; it.bandwidth = main.bandwidth;
    it.rank = it.height || Math.round(main.bandwidth / 5000);
    it.label = main.height ? main.height + 'p' : '';
    it.variantCount = mpd.video.length;
    it.separateAudio = !!(v && a);
    it.hasAudio = !!a;
    if (mpd.duration) it.size = Math.round(((v ? v.bandwidth : 0) + (a ? a.bandwidth : 0)) * mpd.duration / 8);
    it.status = 'ready';
  }
}

// ---------------------------------------------------------------------------
// Liste für das Popup aufbauen (Gruppierung, beste Qualität)
// ---------------------------------------------------------------------------
function isVisible(it, st, hasStream) {
  if (it.kind === 'segment') return false;
  if (st.children.has(it.key)) return false;
  if (it.status === 'invalid') return false;
  const onlyGuess = !it.sources.has('network') && !it.sources.has('menu');
  if (onlyGuess && (it.status === 'error' || it.status === 'new' || it.status === 'analyzing')) return false;
  if (it.kind === 'direct') {
    if (it.size && it.size < settings.minSizeKB * 1024) return false;
    if ((hasStream || st.sawSegments) && VDL.looksLikeSegment(it.url) && (!it.size || it.size < 8 * 1024 * 1024)) return false;
  }
  if ((it.kind === 'hls' || it.kind === 'dash') && it.status === 'error' && onlyGuess) return false;
  return true;
}

function score(it) {
  const sizeKnown = it.kind === 'direct' ? it.size : 0;
  return [it.status === 'ready' ? 1 : 0, it.rank || it.height || 0, it.bandwidth || 0, sizeKnown || it.size || 0];
}
function cmp(a, b) {
  const x = score(a), y = score(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
}

function pub(it) {
  return {
    key: it.key, url: it.url, kind: it.kind, size: it.size, width: it.width, height: it.height,
    bandwidth: it.bandwidth, label: it.label, status: it.status, error: it.error, duration: it.duration,
    ext: it.kind === 'direct' ? (VDL.getExt(it.url) || extFromCt(it.ct) || 'mp4') : it.kind.toUpperCase(),
    thumb: it.thumb, separateAudio: it.separateAudio, variantCount: it.variantCount || 0, hasAudio: it.hasAudio !== false, ct: it.ct,
    sources: [...it.sources], job: jobForItem(it.key)
  };
}

function buildList(tabId) {
  const st = tabs.get(tabId);
  if (!st) return [];
  const all = [...st.items.values()];
  const hasStream = all.some(i => (i.kind === 'hls' || i.kind === 'dash') && i.status !== 'error');
  const groups = new Map();
  for (const it of all) {
    if (!isVisible(it, st, hasStream)) continue;
    const k = it.kind === 'direct' ? (it.groupHint || VDL.groupKey(it.url)) : 'stream:' + it.key;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  // Gruppen mit groupHint (gleiches <video>) und URL-Schlüssel zusammenführen
  const byUrlKey = new Map();
  for (const [k, arr] of groups) {
    for (const it of arr) {
      if (it.kind !== 'direct') continue;
      const uk = VDL.groupKey(it.url);
      if (byUrlKey.has(uk) && byUrlKey.get(uk) !== k) {
        const other = byUrlKey.get(uk);
        if (groups.has(other) && groups.has(k)) {
          groups.get(k).push(...groups.get(other).filter(x => !groups.get(k).includes(x)));
          groups.delete(other);
        }
      }
      byUrlKey.set(uk, k);
    }
  }
  const out = [];
  for (const [k, arr] of groups) {
    arr.sort(cmp);
    const best = arr[0];
    out.push({
      key: k,
      best: pub(best),
      others: arr.slice(1).map(pub),
      thumb: best.thumb || (arr.find(a => a.thumb) || {}).thumb || st.pageThumb || null
    });
  }
  out.sort((a, b) => cmp(st.items.get(a.best.key), st.items.get(b.best.key)));
  return out;
}

// Symbol: grau ohne Videos, farbig mit Videos, kurzes Pulsieren bei neu gefundenen Videos
const iconAnim = new Map();
function updateIcon(tabId, n) {
  const st = tabs.get(tabId);
  const prev = st ? (st.shownCount || 0) : 0;
  if (st) st.shownCount = n;
  if (iconAnim.has(tabId)) return; // Animation setzt das Symbol am Ende selbst
  browser.browserAction.setIcon({ tabId, path: n ? 'icons/icon.svg' : 'icons/icon-off.svg' }).catch(() => {});
  if (n > prev) animateIcon(tabId);
}
function animateIcon(tabId) {
  let i = 0;
  const frames = ['icons/icon-glow.svg', 'icons/icon.svg'];
  const timer = setInterval(() => {
    if (i >= 6) {
      clearInterval(timer);
      iconAnim.delete(tabId);
      const st = tabs.get(tabId);
      const n = st ? st.shownCount || 0 : 0;
      browser.browserAction.setIcon({ tabId, path: n ? 'icons/icon.svg' : 'icons/icon-off.svg' }).catch(() => {});
      return;
    }
    browser.browserAction.setIcon({ tabId, path: frames[i % 2] }).catch(() => {});
    i++;
  }, 230);
  iconAnim.set(tabId, timer);
}
browser.tabs.onRemoved.addListener(id => { clearInterval(iconAnim.get(id)); iconAnim.delete(id); });

// Popup und Badge benachrichtigen (gedrosselt)
const pending = new Map();
function scheduleUpdate(tabId) {
  if (pending.has(tabId)) return;
  pending.set(tabId, setTimeout(() => {
    pending.delete(tabId);
    const n = buildList(tabId).length;
    browser.browserAction.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
    browser.browserAction.setBadgeBackgroundColor({ tabId, color: '#1f6feb' }).catch(() => {});
    updateIcon(tabId, n);
    browser.runtime.sendMessage({ type: 'mediaUpdated', tabId }).catch(() => {});
  }, 200));
}

// ---------------------------------------------------------------------------
// Tiefensuche
// ---------------------------------------------------------------------------
const DEEP_RE = new RegExp('(?:https?:)?\\/\\/[^\\s"\'<>()\\\\{}|^`]+?\\.' + VDL.URL_EXT_PATTERN + '(?:\\?[^\\s"\'<>\\\\{}|^`]*)?(?=$|[\\s"\'<>\\\\)])', 'gi');

function unescapeText(t) {
  return t.replace(/\\u002[fF]/g, '/').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
}

async function deepSearch(tabId) {
  const st = tabState(tabId);
  if (st.deep === 'running') return;
  st.deep = 'running';
  scheduleUpdate(tabId);
  try {
    await ensureInjected(tabId);
    await browser.tabs.sendMessage(tabId, { type: 'deepScan' }).catch(() => {});
    // Zusätzlich: Seitenquelltext neu laden und durchsuchen
    const tab = await browser.tabs.get(tabId);
    if (tab.url && /^https?:/.test(tab.url)) {
      try {
        const html = unescapeText(await fetchText(tab.url));
        const found = new Set();
        let m;
        DEEP_RE.lastIndex = 0;
        while ((m = DEEP_RE.exec(html))) {
          let u = m[0];
          if (u.startsWith('//')) u = new URL(tab.url).protocol + u;
          found.add(u);
        }
        for (const u of found) {
          const kind = VDL.classify(u, '');
          if (kind && kind !== 'segment') addItem(tabId, { url: u, kind, source: 'deep', pageUrl: tab.url });
        }
      } catch (e) { /* Quelltext nicht abrufbar */ }
    }
    // Warten, bis die Analyse der neuen Kandidaten durch ist
    const t0 = Date.now();
    while ((queue.length || running) && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 300));
  } finally {
    st.deep = 'done';
    scheduleUpdate(tabId);
  }
}

async function ensureInjected(tabId) {
  try {
    await browser.tabs.executeScript(tabId, { file: '/content.js', allFrames: true, matchAboutBlank: true, runAt: 'document_idle' });
  } catch (e) { /* z. B. about:-Seiten */ }
}

// ---------------------------------------------------------------------------
// Kontextmenü auf Videos
// ---------------------------------------------------------------------------
browser.menus.create({ id: 'vdl-video', title: 'Video herunterladen (beste Qualität)', contexts: ['video'] });
browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'vdl-video' || !tab) return;
  if (settings.openSidebar) browser.sidebarAction.open().catch(() => {});
  const src = info.srcUrl || '';
  if (/^https?:/i.test(src)) {
    const kind = VDL.classify(src, '') || 'direct';
    const it = addItem(tab.id, { url: src, kind: kind === 'segment' ? 'direct' : kind, source: 'menu', pageUrl: tab.url });
    if (it) {
      const t0 = Date.now();
      while ((it.status === 'new' || it.status === 'analyzing') && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 200));
      const g = buildList(tab.id).find(x => x.best.key === it.key || x.others.some(o => o.key === it.key));
      createJob(tab.id, g ? g.best.key : it.key).catch(e => console.warn(e));
    }
  } else {
    // Stream über MediaSource (blob:) – beste erkannte Quelle der Seite nehmen
    const list = buildList(tab.id).filter(g => g.best.status === 'ready');
    if (list.length) createJob(tab.id, list[0].best.key).catch(e => console.warn(e));
    else browser.browserAction.openPopup().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Nachrichten (Erkennung). Download- und Update-Nachrichten: jobs.js, updater.js
// ---------------------------------------------------------------------------
browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg.type) {
    case 'domMedia': {
      const tabId = sender.tab ? sender.tab.id : -1;
      if (tabId < 0) return;
      const st = tabState(tabId);
      if (sender.frameId === 0 && msg.pageUrl) st.pageUrl = msg.pageUrl;
      if (msg.pageThumb && (!st.pageThumb || (msg.pageThumbQuality || 0) > (st.pageThumbQuality || 0))) {
        st.pageThumb = msg.pageThumb;
        st.pageThumbQuality = msg.pageThumbQuality || 0;
      }
      for (const d of msg.items || []) {
        const kind = VDL.classify(d.url, d.type || '') || (d.isVideoSrc ? 'direct' : null);
        if (!kind || kind === 'segment') continue;
        addItem(tabId, Object.assign({}, d, { kind, source: msg.deep ? 'deep' : 'dom', pageUrl: msg.pageUrl, frameId: sender.frameId || 0 }));
      }
      scheduleUpdate(tabId);
      return;
    }
    case 'getList': {
      const st = tabs.get(msg.tabId);
      return Promise.resolve({ groups: buildList(msg.tabId), deep: st ? st.deep : 'idle', settings, update: updateInfo });
    }
    case 'rescan':
      return ensureInjected(msg.tabId)
        .then(() => browser.tabs.sendMessage(msg.tabId, { type: 'scan' }).catch(() => {}))
        .then(() => true);
    case 'deepSearch':
      deepSearch(msg.tabId);
      return Promise.resolve(true);
  }
});
