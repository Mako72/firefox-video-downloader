'use strict';
/* Download-Aufträge: Warteschlange, Fortsetzen an der Abbruchstelle, automatische Wiederaufnahme,
 * Pausieren/Abbrechen, Fortschritt und Restzeit.
 * global VDL, VDLMp4, VDLStore, settings, settingsReady, tabs, rememberReferer, fetchText, scheduleUpdate, maybeApplyUpdate */

const jobs = new Map();        // id -> Auftrag (wird in IndexedDB gespeichert)
const rt = new Map();          // id -> Laufzeitdaten eines Stream-Downloads {ctrl, reason, lastBytes, lastTime}
const dlToJob = new Map();     // Firefox-Download-ID -> Auftrags-ID
const retryTimers = new Map();
const speedState = new Map();
const ACTIVE = new Set(['running', 'merging']);
const FINAL = new Set(['done', 'cancelled', 'error']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Hilfsfunktionen für Dateinamen
// ---------------------------------------------------------------------------
function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120) || 'video';
}
function buildPath(filename) {
  const folder = String(settings.subfolder || '').split(/[\\/]+/).map(s => s.trim()).filter(Boolean)
    .map(s => s.replace(/[:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+$/, '_')).join('/');
  return folder ? folder + '/' + filename : filename;
}
function extFromCt(ct) {
  ct = (ct || '').toLowerCase();
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('ogg')) return 'ogv';
  if (ct.includes('quicktime')) return 'mov';
  if (ct.includes('x-flv')) return 'flv';
  if (ct.includes('matroska')) return 'mkv';
  if (ct.includes('mp4')) return 'mp4';
  return '';
}
function baseName(title, label) {
  let t = sanitize(title || 'video');
  if (label) t += ' [' + label + ']';
  return t;
}
function sniffExt(u8, audio) {
  if (!u8 || u8.length < 8) return audio ? 'aac' : 'ts';
  if (u8[0] === 0x47) return 'ts';
  const t = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
  if (['ftyp', 'styp', 'moof', 'moov', 'sidx'].includes(t)) return audio ? 'm4a' : 'mp4';
  if (u8[0] === 0x1a && u8[1] === 0x45) return audio ? 'weba' : 'webm';
  if (audio && (u8[0] === 0x49 || (u8[0] === 0xff && (u8[1] & 0xf0) === 0xf0))) return 'aac';
  return audio ? 'aac' : 'ts';
}
const MIME = { mp4: 'video/mp4', m4a: 'audio/mp4', ts: 'video/mp2t', aac: 'audio/aac', webm: 'video/webm', weba: 'audio/webm' };
const DL_ERRORS = {
  NETWORK_FAILED: 'Netzwerkfehler', NETWORK_TIMEOUT: 'Zeitüberschreitung', NETWORK_DISCONNECTED: 'Verbindung getrennt',
  NETWORK_SERVER_DOWN: 'Server nicht erreichbar', SERVER_FAILED: 'Serverfehler', SERVER_BAD_CONTENT: 'Ungültige Antwort',
  SERVER_UNAUTHORIZED: 'Keine Berechtigung', SERVER_FORBIDDEN: 'Zugriff verweigert', SERVER_UNREACHABLE: 'Server nicht erreichbar',
  FILE_FAILED: 'Dateifehler', FILE_ACCESS_DENIED: 'Kein Schreibzugriff', FILE_NO_SPACE: 'Kein Speicherplatz',
  FILE_TOO_LARGE: 'Datei zu groß', CRASH: 'Absturz'
};

// ---------------------------------------------------------------------------
// Speichern und Benachrichtigen
// ---------------------------------------------------------------------------
const dirty = new Set();
let saveTimer = null;
function persist(job, now) {
  dirty.add(job.id);
  if (now) return flush();
  if (!saveTimer) saveTimer = setTimeout(flush, 1500);
  return Promise.resolve();
}
async function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const ids = [...dirty];
  dirty.clear();
  for (const id of ids) {
    const j = jobs.get(id);
    if (j) await VDLStore.putJob(j).catch(e => console.warn('Speichern fehlgeschlagen', e));
  }
}

let notifyTimer = null;
function notifyJobs(job) {
  if (job && job.tabId != null && tabs.has(job.tabId)) scheduleUpdate(job.tabId);
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    browser.runtime.sendMessage({ type: 'jobsUpdated' }).catch(() => {});
    const active = [...jobs.values()].filter(j => ACTIVE.has(j.state) || j.state === 'queued').length;
    browser.sidebarAction.setTitle({ title: active ? 'Video-Downloads (' + active + ' aktiv)' : 'Video-Downloads' }).catch(() => {});
  }, 300);
}

function setState(job, state, extra) {
  job.state = state;
  Object.assign(job, extra || {});
  if (FINAL.has(state)) { job.finished = Date.now(); scheduleAutoClear(job); }
  if (state !== 'running' && state !== 'merging') { job.speed = 0; job.eta = 0; }
  if (state !== 'interrupted') job.retryAt = 0;
  persist(job, true);
  notifyJobs(job);
  if (!ACTIVE.has(state) && typeof maybeApplyUpdate === 'function') setTimeout(maybeApplyUpdate, 500);
}

// Fertige (und abgebrochene) Downloads automatisch aus der Liste entfernen – je nach Einstellung.
// Die Dateien bleiben erhalten; Fehler bleiben stehen, damit man sie sieht.
const CLEARABLE = new Set(['done', 'cancelled']);
const CLEAR_DELAY = { immediate: 8000, '10min': 10 * 60000, '1h': 3600000, '1d': 86400000 };
function scheduleAutoClear(job) {
  const d = CLEAR_DELAY[settings.autoClear];
  if (!d || !CLEARABLE.has(job.state)) return;
  setTimeout(() => {
    const j = jobs.get(job.id);
    if (j && CLEARABLE.has(j.state)) removeJob(j.id);
  }, Math.max(0, (job.finished || Date.now()) + d - Date.now()));
}
function sweepFinished(onStartup) {
  for (const j of [...jobs.values()]) {
    if (!CLEARABLE.has(j.state)) continue;
    if (onStartup && settings.autoClear === 'restart') { removeJob(j.id); continue; }
    scheduleAutoClear(j);
  }
}

function jobPub(j) {
  if (!j) return null;
  return {
    id: j.id, kind: j.kind, title: j.title, label: j.label, base: j.base, filename: j.filename, thumb: j.thumb,
    state: j.state, error: j.error, note: j.note, phase: j.phase, done: j.done, total: j.total, bytes: j.bytes,
    estTotal: j.estTotal, speed: j.speed, eta: j.eta, retryAt: j.retryAt, created: j.created, finished: j.finished,
    downloadId: j.downloadId, restarts: j.restarts, itemKey: j.itemKey, source: j.source, pageUrl: j.pageUrl, audioOnly: !!j.audioOnly
  };
}
function jobForItem(key) {
  let best = null;
  for (const j of jobs.values()) if (j.itemKey === key && !j.audioOnly && (!best || j.created > best.created)) best = j;
  return jobPub(best);
}

// ---------------------------------------------------------------------------
// Auftrag anlegen und Warteschlange
// ---------------------------------------------------------------------------
async function createJob(tabId, key, opts) {
  opts = opts || {};
  const st = tabs.get(tabId);
  const it = st && st.items.get(key);
  if (!it) throw new Error('Video nicht mehr vorhanden – Seite neu laden');
  const audioOnly = !!opts.audioOnly;
  for (const j of jobs.values()) {
    if (j.source === it.url && !!j.audioOnly === audioOnly && !FINAL.has(j.state)) {
      if (!ACTIVE.has(j.state)) resumeJob(j.id);
      return j;
    }
  }
  const tab = await browser.tabs.get(tabId).catch(() => null);
  const title = (tab && tab.title) || 'video';
  let ext = 'mp4';
  if (it.kind === 'direct') {
    const e = VDL.getExt(it.url);
    ext = VDL.VIDEO_EXT.has(e) ? e : (extFromCt(it.ct) || 'mp4');
  }
  const thumb = it.thumb || st.pageThumb || null;
  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    kind: it.kind, source: it.url, itemKey: it.key, tabId,
    pageUrl: st.pageUrl || (tab && tab.url) || '', title, label: it.label || '',
    base: audioOnly ? sanitize(title) + ' (Ton)' : baseName(title, it.label), ext, filename: '',
    audioOnly, sizeHint: it.size || 0,
    thumb: thumb && thumb.length < 120000 ? thumb : null,
    created: Date.now(), state: 'queued', phase: '', note: '', error: '',
    done: 0, total: 0, bytes: 0, estTotal: it.size || 0, speed: 0, eta: 0,
    retries: 0, restarts: 0, refreshes: 0, retryAt: 0, tracks: null, downloadId: null,
    askWhere: opts.askWhere != null ? !!opts.askWhere : !!settings.askWhere, frameId: it.frameId || 0, viaPage: !!it.viaPage
  };
  jobs.set(job.id, job);
  await persist(job, true);
  notifyJobs(job);
  pumpJobs();
  return job;
}

function pumpJobs() {
  const all = [...jobs.values()];
  let free = Math.max(1, +settings.maxParallel || 2) - all.filter(j => ACTIVE.has(j.state)).length;
  const queued = all.filter(j => j.state === 'queued').sort((a, b) => a.created - b.created);
  for (const j of queued) {
    if (free <= 0) break;
    free--;
    runJob(j);
  }
}

function runJob(job) {
  job.phase = '';
  job.error = '';
  setState(job, 'running');
  if (job.kind === 'direct' && !job.audioOnly) runDirect(job);
  else runStream(job);
}

// ---------------------------------------------------------------------------
// Steuerung: Pause, Fortsetzen, Abbrechen, Entfernen
// ---------------------------------------------------------------------------
function resumeJob(id) {
  const j = jobs.get(id);
  if (!j || ACTIVE.has(j.state)) return;
  clearTimeout(retryTimers.get(id));
  retryTimers.delete(id);
  if (j.state === 'done') return;
  if (j.state === 'cancelled' || j.state === 'error') {
    // Neu starten
    j.retries = 0; j.refreshes = 0; j.note = ''; j.error = ''; j.permanent = false;
    if (j.state === 'cancelled') { j.tracks = null; j.done = 0; j.bytes = 0; j.total = 0; j.downloadId = null; }
  }
  if (j.state === 'interrupted') j.retries = 0;
  setState(j, 'queued');
  pumpJobs();
}

async function pauseJob(id) {
  const j = jobs.get(id);
  if (!j) return;
  clearTimeout(retryTimers.get(id));
  if (j.kind === 'direct' && j.state === 'running' && j.downloadId != null) {
    j.pausing = true;
    await browser.downloads.pause(j.downloadId).catch(() => {});
    j.pausing = false;
    setState(j, 'paused');
    pumpJobs();
    return;
  }
  const r = rt.get(id);
  if (r && j.state === 'running') { r.reason = 'pause'; r.ctrl.abort(); return; }
  if (j.state === 'queued' || j.state === 'interrupted') setState(j, 'paused');
}

async function cancelJob(id) {
  const j = jobs.get(id);
  if (!j || FINAL.has(j.state)) return;
  clearTimeout(retryTimers.get(id));
  if (j.kind === 'direct') {
    if (j.downloadId != null) {
      j.userCancel = true;
      await browser.downloads.cancel(j.downloadId).catch(() => {});
    }
    setState(j, 'cancelled', { note: '' });
    pumpJobs();
    return;
  }
  const r = rt.get(id);
  if (r) { r.reason = 'cancel'; r.ctrl.abort(); return; }
  await VDLStore.deleteParts(id).catch(() => {});
  setState(j, 'cancelled', { tracks: null, done: 0, bytes: 0, note: '' });
}

async function removeJob(id) {
  const j = jobs.get(id);
  if (!j) return;
  if (!FINAL.has(j.state)) await cancelJob(id);
  if (rt.has(id)) await sleep(300);
  await VDLStore.deleteParts(id).catch(() => {});
  await VDLStore.deleteJob(id).catch(() => {});
  jobs.delete(id);
  notifyJobs(j);
}

function scheduleRetry(job, msg) {
  if (!settings.autoResume) return setState(job, 'interrupted', { error: msg, retryAt: 0 });
  job.retries = (job.retries || 0) + 1;
  if (job.retries > 30) return setState(job, 'interrupted', { error: msg + ' – automatische Versuche beendet', retryAt: 0 });
  const delay = Math.min(300, 5 * Math.pow(2, job.retries - 1)) * 1000;
  setState(job, 'interrupted', { error: msg, retryAt: Date.now() + delay });
  clearTimeout(retryTimers.get(job.id));
  retryTimers.set(job.id, setTimeout(() => {
    retryTimers.delete(job.id);
    const j = jobs.get(job.id);
    if (j && j.state === 'interrupted') { setState(j, 'queued'); pumpJobs(); }
  }, delay));
}

browser.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.autoClear) setTimeout(() => sweepFinished(false), 100); });

// Sobald das Netz wieder da ist: unterbrochene Downloads sofort fortsetzen
window.addEventListener('online', () => {
  for (const j of jobs.values()) {
    if (j.state === 'interrupted' && settings.autoResume) {
      clearTimeout(retryTimers.get(j.id));
      setState(j, 'queued');
    }
  }
  pumpJobs();
});

// ---------------------------------------------------------------------------
// Fortschritt und Restzeit
// ---------------------------------------------------------------------------
function tick(job) {
  let s = speedState.get(job.id);
  const now = Date.now();
  if (!s) { s = { bytes: job.bytes, time: now }; speedState.set(job.id, s); }
  const dt = (now - s.time) / 1000;
  if (dt >= 1) {
    const inst = Math.max(0, (job.bytes - s.bytes) / dt);
    job.speed = job.speed ? job.speed * 0.7 + inst * 0.3 : inst;
    s.bytes = job.bytes;
    s.time = now;
  }
  if (job.kind !== 'direct' && job.done > 0 && job.total) {
    job.estTotal = Math.round(job.bytes / job.done * job.total);
  }
  if (job.speed > 0 && job.estTotal > job.bytes) {
    // Bei Streams: Restzeit auch aus Teilen/Zeit schätzen (stabiler bei schwankender Teilgröße)
    job.eta = (job.estTotal - job.bytes) / job.speed;
  } else if (job.estTotal && job.bytes >= job.estTotal) job.eta = 0;
  persist(job);
  notifyJobs(job);
}

// ---------------------------------------------------------------------------
// Stream-Downloads (HLS / DASH): Teile werden einzeln gespeichert
// ---------------------------------------------------------------------------
function permanent(msg) { const e = new Error(msg); e.permanent = true; return e; }

async function resolveTracks(job) {
  if (job.audioOnly) return resolveAudioTracks(job);
  if (job.kind === 'hls') {
    const pl = VDL.parseM3U8(await jobFetchText(job, job.source), job.source);
    let media = pl, audio = null;
    if (pl.type === 'master') {
      const best = pl.variants[0];
      if (!best) throw permanent('Playlist ohne Varianten');
      media = VDL.parseM3U8(await jobFetchText(job, best.url), best.url);
      if (best.height) job.label = best.height + 'p';
      if (best.audioGroup) {
        const cands = pl.audio.filter(a => a.group === best.audioGroup);
        const pick = cands.find(a => a.isDefault) || cands[0];
        if (pick) audio = VDL.parseM3U8(await jobFetchText(job, pick.url), pick.url);
      }
    }
    if (media.encrypted || (audio && audio.encrypted) || pl.encrypted) throw permanent('Verschlüsselter Stream – Download nicht möglich');
    if (media.live) throw permanent('Live-Stream – wird nicht unterstützt');
    const toParts = m => (m.map ? [{ url: m.map.url, range: m.map.range }] : [])
      .concat(m.segments.map(s => ({ url: s.url, range: s.range })));
    const tracks = [{ name: 'video', parts: toParts(media) }];
    if (audio) tracks.push({ name: 'audio', parts: toParts(audio) });
    return tracks;
  }
  if (job.kind === 'dash') {
    const mpd = VDL.parseMPD(await jobFetchText(job, job.source), job.source);
    if (mpd.live) throw permanent('Live-Stream – wird nicht unterstützt');
    const v = mpd.video.find(r => !r.protected);
    const a = mpd.audio.find(r => !r.protected);
    if (!v && !a) throw permanent('DRM-geschützt – Download nicht möglich');
    if (v && v.height) job.label = v.height + 'p';
    const strip = parts => parts.map(p => ({ url: p.url, range: p.range || null }));
    const tracks = [{ name: v ? 'video' : 'audio', parts: strip(VDL.dashSegments(v || a, job.source)) }];
    if (v && a) tracks.push({ name: 'audio', parts: strip(VDL.dashSegments(a, job.source)) });
    return tracks;
  }
  throw permanent('Unbekannter Typ');
}

const AUDIO_CODEC = /mp4a|ac-3|ec-3|opus|mp3|flac|vorbis/i;
const VIDEO_CODEC = /avc|hvc|hev|vp0?9|av01|vp8|mp4v/i;

/** Nur Ton: möglichst wenig laden und die Tonspur herausziehen */
async function resolveAudioTracks(job) {
  const toParts = m => (m.map ? [{ url: m.map.url, range: m.map.range }] : [])
    .concat(m.segments.map(s => ({ url: s.url, range: s.range })));
  job.extract = null;
  if (job.kind === 'dash') {
    const mpd = VDL.parseMPD(await jobFetchText(job, job.source), job.source);
    if (mpd.live) throw permanent('Live-Stream – wird nicht unterstützt');
    const a = mpd.audio.find(r => !r.protected);
    if (!a) throw permanent(mpd.protected ? 'DRM-geschützt – Download nicht möglich' : 'Dieser Stream hat keine eigene Tonspur');
    return [{ name: 'audio', parts: VDL.dashSegments(a, job.source).map(p => ({ url: p.url, range: p.range || null })) }];
  }
  if (job.kind === 'hls') {
    const pl = VDL.parseM3U8(await jobFetchText(job, job.source), job.source);
    let media = pl, audioOnlyVariant = false;
    if (pl.type === 'master') {
      // 1. eigene Tonspur (Audio-Gruppe)
      const best = pl.variants[0];
      const group = best && best.audioGroup;
      const cands = pl.audio.filter(a => !group || a.group === group);
      const pick = cands.find(a => a.isDefault) || cands[0];
      if (pick) {
        const m = VDL.parseM3U8(await jobFetchText(job, pick.url), pick.url);
        if (m.encrypted) throw permanent('Verschlüsselter Stream – Download nicht möglich');
        if (m.live) throw permanent('Live-Stream – wird nicht unterstützt');
        return [{ name: 'audio', parts: toParts(m) }];
      }
      // 2. reine Ton-Variante, sonst die kleinste Bildqualität (spart Daten)
      let v = pl.variants.find(x => x.codecs && AUDIO_CODEC.test(x.codecs) && !VIDEO_CODEC.test(x.codecs));
      audioOnlyVariant = !!v;
      if (!v) v = pl.variants.slice().sort((a, b) => ((a.bandwidth || 0) - (b.bandwidth || 0)) || ((a.height || 0) - (b.height || 0)))[0];
      media = VDL.parseM3U8(await jobFetchText(job, v.url), v.url);
    }
    if (media.encrypted || pl.encrypted) throw permanent('Verschlüsselter Stream – Download nicht möglich');
    if (media.live) throw permanent('Live-Stream – wird nicht unterstützt');
    if (audioOnlyVariant) return [{ name: 'audio', parts: toParts(media) }];
    if (media.map) throw permanent('„Nur Ton“ ist bei diesem Stream nicht möglich (Bild und Ton gemeinsam im MP4-Format).');
    job.extract = 'ts';
    return [{ name: 'muxed', parts: toParts(media) }];
  }
  // direkte Datei
  const ext = VDL.getExt(job.source);
  if (['ts', 'mts', 'm2ts'].includes(ext)) job.extract = 'ts';
  else if (['mp4', 'm4v', 'mov', 'm4a', '3gp', 'qt'].includes(ext) || /mp4|quicktime|3gpp/i.test(job.ct || '')) job.extract = 'mp4';
  else throw permanent('„Nur Ton“ ist bei diesem Dateiformat (' + (ext || job.ct || 'unbekannt') + ') nicht möglich.');
  let size = job.sizeHint;
  if (!size && !job.noRange) { try { size = (await probe(job.source)).size; } catch (e) { size = 0; } }
  const CH = 4 * 1024 * 1024;
  if (!size || job.noRange) return [{ name: 'file', parts: [{ url: job.source, range: null }] }];
  const parts = [];
  for (let st = 0; st < size; st += CH) parts.push({ url: job.source, range: { start: st, end: Math.min(size, st + CH) - 1 } });
  return [{ name: 'file', parts }];
}

// Anfrage über den geöffneten Tab (mit den Cookies, dem Referer und der Herkunft der Seite).
// Nötig, wenn der Server Hintergrund-Anfragen ablehnt (z. B. Cookie-Trennung pro Website, Hotlink-Schutz).
async function pageFetch(job, url, range, asText) {
  if (!job.injected) { await ensureInjected(job.tabId); job.injected = true; }
  const msg = { type: 'pageFetch', url, range: range || null, text: !!asText };
  let res;
  try {
    res = await browser.tabs.sendMessage(job.tabId, msg, { frameId: job.frameId || 0 });
  } catch (e) {
    if (job.frameId) {
      try { res = await browser.tabs.sendMessage(job.tabId, msg, { frameId: 0 }); } catch (e2) { res = null; }
    }
  }
  if (!res) {
    const e = new Error('Seite nicht erreichbar – bitte den Tab mit dem Video geöffnet lassen');
    e.noPage = true;
    throw e;
  }
  if (!res.ok) { const e = new Error('HTTP ' + (res.status || 0) + (res.error ? ' ' + res.error : '')); e.status = res.status; e.viaPage = true; throw e; }
  return asText ? res.text : new Uint8Array(res.buf);
}

function switchToPage(job) {
  if (job.viaPage) return;
  job.viaPage = true;
  job.note = 'Der Server lässt nur die Seite selbst laden – Download läuft über den geöffneten Tab. Bitte den Tab offen lassen.';
  persist(job, true);
  notifyJobs(job);
}

async function jobFetchText(job, url) {
  if (job.viaPage) return pageFetch(job, url, null, true);
  try {
    return await fetchText(url);
  } catch (e) {
    if (!/HTTP (401|403)/.test(e.message)) throw e;
    const t = await pageFetch(job, url, null, true);
    switchToPage(job);
    return t;
  }
}

async function fetchPart(p, signal, job) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (job && job.viaPage) return await pageFetch(job, p.url, p.range);
      const headers = {};
      if (p.range) headers.Range = 'bytes=' + p.range.start + '-' + p.range.end;
      const r = await fetch(p.url, { signal, headers, credentials: 'include' });
      if (!r.ok) {
        if (job && (r.status === 401 || r.status === 403)) {
          // Zweiter Weg: über die Seite laden
          const u8 = await pageFetch(job, p.url, p.range).catch(() => null);
          if (u8) { switchToPage(job); return u8; }
        }
        const e = new Error('HTTP ' + r.status); e.status = r.status; throw e;
      }
      if (p.range && r.status === 200 && job && job.kind === 'direct') {
        try { r.body && r.body.cancel(); } catch (x) { /* ignore */ }
        const e = new Error('Server unterstützt keine Teilanfragen'); e.noRange = true; throw e;
      }
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (e.name === 'AbortError' || e.noPage || e.noRange) throw e;
      if (signal && signal.aborted) throw e;
      const clientErr = e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
      if (clientErr || attempt >= 3) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

function abortError() { const e = new Error('Abgebrochen'); e.name = 'AbortError'; return e; }

async function runStream(job) {
  job.injected = false;
  const r = { ctrl: new AbortController(), reason: null };
  rt.set(job.id, r);
  speedState.delete(job.id);
  try {
    rememberReferer(job.source, job.pageUrl);
    if (!job.tracks) {
      job.phase = 'Playlist wird gelesen';
      notifyJobs(job);
      job.tracks = await resolveTracks(job);
      job.total = job.tracks.reduce((s, t) => s + t.parts.length, 0);
      job.done = 0; job.bytes = 0;
      job.base = job.audioOnly ? sanitize(job.title) + ' (Ton)' : baseName(job.title, job.label);
      await persist(job, true);
    }
    const hosts = new Set();
    job.tracks.forEach(t => t.parts.forEach(p => { try { const h = new URL(p.url).host; if (!hosts.has(h)) { hosts.add(h); rememberReferer(p.url, job.pageUrl); } } catch (e) { /* ignore */ } }));
    job.phase = 'Lade herunter';
    await fetchMissing(job, r);
    if (r.reason) throw abortError();
    await finishStream(job, r);
  } catch (e) {
    await handleStreamError(job, e, r);
  } finally {
    rt.delete(job.id);
    pumpJobs();
  }
}

async function fetchMissing(job, r) {
  const have = new Set(await VDLStore.partKeys(job.id));
  const todo = [];
  job.tracks.forEach((t, ti) => t.parts.forEach((p, i) => {
    if (!have.has(VDLStore.partKey(job.id, ti, i))) todo.push({ ti, i, p });
  }));
  job.done = job.total - todo.length;
  if (job.done > 0) job.note = job.note || 'An der abgebrochenen Stelle fortgesetzt (' + job.done + ' von ' + job.total + ' Teilen vorhanden).';
  notifyJobs(job);
  if (!todo.length) return;
  let next = 0;
  const worker = async () => {
    while (next < todo.length && !r.ctrl.signal.aborted) {
      const t = todo[next++];
      const u8 = await fetchPart(t.p, r.ctrl.signal, job);
      if (r.ctrl.signal.aborted) return;
      await VDLStore.putPart(job.id, t.ti, t.i, new Blob([u8]));
      job.done++;
      job.bytes += u8.byteLength;
      job.retries = 0;
      job.refreshes = 0;
      tick(job);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  } catch (e) {
    if (!r.ctrl.signal.aborted) r.ctrl.abort();
    throw e;
  }
}

async function handleStreamError(job, e, r) {
  if (r.reason === 'pause') return setState(job, 'paused', { phase: '' });
  if (r.reason === 'cancel') {
    await VDLStore.deleteParts(job.id).catch(() => {});
    return setState(job, 'cancelled', { tracks: null, done: 0, bytes: 0, phase: '', note: '' });
  }
  job.phase = '';
  if (e.permanent) return setState(job, 'error', { error: e.message, permanent: true });
  if (e.noPage) return setState(job, 'interrupted', { error: e.message, retryAt: 0 });
  if (e.noRange && !job.noRange) {
    job.noRange = true;
    return restartFromScratch(job, 'Server lädt nur am Stück – Download wurde in einem Teil neu gestartet.');
  }
  if (e.extractFailed) return setState(job, 'error', { error: e.message, permanent: true });
  if (e.saveCancelled) return setState(job, 'paused', { note: 'Speichern abgebrochen – „Fortsetzen“ speichert die fertige Datei erneut.' });
  if (e.status && [401, 403, 404, 410].includes(e.status)) {
    // Download-Adressen sind womöglich abgelaufen: Playlist neu lesen
    if ((job.refreshes || 0) < 3) {
      job.refreshes = (job.refreshes || 0) + 1;
      try {
        const fresh = await resolveTracks(job);
        const same = job.tracks && fresh.length === job.tracks.length &&
          fresh.every((t, i) => t.parts.length === job.tracks[i].parts.length);
        if (same) {
          job.tracks = fresh;
          job.note = 'Download-Adressen erneuert – wird an derselben Stelle fortgesetzt.';
          return setState(job, 'queued');
        }
        return restartFromScratch(job, 'Fortsetzen nicht möglich (Stream verändert) – Download wurde neu gestartet.', fresh);
      } catch (e2) {
        if (e2.permanent) return setState(job, 'error', { error: e2.message, permanent: true });
      }
    } else if ((job.restarts || 0) < 1) {
      return restartFromScratch(job, 'Fortsetzen nicht möglich – Download wurde neu gestartet.');
    } else {
      return setState(job, 'error', { error: 'Server verweigert den Zugriff (' + e.message + '), auch beim Laden über die Seite. Seite neu laden, das Video kurz abspielen und dann erneut herunterladen.' });
    }
  }
  scheduleRetry(job, (e && e.message) || 'Verbindungsfehler');
}

async function restartFromScratch(job, note, tracks) {
  await VDLStore.deleteParts(job.id).catch(() => {});
  job.restarts = (job.restarts || 0) + 1;
  job.tracks = tracks || null;
  job.total = tracks ? tracks.reduce((s, t) => s + t.parts.length, 0) : 0;
  job.done = 0; job.bytes = 0; job.refreshes = 0;
  setState(job, 'queued', { note });
}

async function finishStream(job, r) {
  setState(job, 'merging', { phase: 'Datei wird zusammengesetzt' });
  const keys = (await VDLStore.partKeys(job.id)).sort();
  const byTrack = job.tracks.map(() => []);
  for (const k of keys) {
    const ti = +k.split('|')[1];
    if (byTrack[ti]) byTrack[ti].push(k);
  }
  byTrack.forEach((ks, ti) => {
    if (ks.length !== job.tracks[ti].parts.length) throw new Error('Es fehlen noch Teile');
  });
  const load = async ks => { const out = []; for (const k of ks) out.push(await VDLStore.getPart(k)); return out; };
  const head = async b => new Uint8Array(await b.slice(0, 16).arrayBuffer());
  const vBlobs = await load(byTrack[0]);
  const isAudioOnly = job.tracks[0].name === 'audio';
  const vExt = sniffExt(await head(vBlobs[0]), isAudioOnly);
  const outputs = [];
  if (job.extract) {
    job.phase = 'Ton wird herausgezogen';
    notifyJobs(job);
    try {
      if (job.extract === 'ts') {
        const res = await VDLAudio.fromTs(vBlobs);
        outputs.push([res.chunks, res.mime, job.base + '.' + res.ext]);
      } else {
        const all = new Uint8Array(await new Blob(vBlobs).arrayBuffer());
        outputs.push([VDLAudio.fromMp4(all), 'audio/mp4', job.base + '.m4a']);
      }
    } catch (e) {
      const x = new Error('Ton konnte nicht herausgezogen werden: ' + e.message);
      x.extractFailed = true;
      throw x;
    }
  } else if (byTrack.length < 2) {
    outputs.push([vBlobs, MIME[vExt], job.base + '.' + vExt]);
  } else {
    const aBlobs = await load(byTrack[1]);
    const aExt = sniffExt(await head(aBlobs[0]), true);
    let merged = null;
    if (vExt === 'mp4' && aExt === 'm4a') {
      try {
        const toU8 = bs => Promise.all(bs.map(async b => new Uint8Array(await b.arrayBuffer())));
        merged = VDLMp4.merge(await toU8(vBlobs), await toU8(aBlobs));
      } catch (e) { console.warn('Zusammenführen fehlgeschlagen, speichere getrennt:', e); }
    }
    if (merged) outputs.push([merged, 'video/mp4', job.base + '.mp4']);
    else {
      job.note = 'Bild und Ton wurden getrennt gespeichert.';
      outputs.push([vBlobs, MIME[vExt], job.base + '.' + vExt]);
      outputs.push([aBlobs, MIME[aExt], job.base + ' (Tonspur).' + aExt]);
    }
  }
  if (r.reason) throw abortError();
  job.phase = 'Wird gespeichert';
  notifyJobs(job);
  const ids = [];
  for (const [parts, mime, name] of outputs) ids.push(await saveBlobAndWait(parts, mime, name, job));
  job.downloadId = ids[0];
  job.filename = outputs[0][2];
  await rememberLocation(job, ids[0], !!job.askWhere);
  await VDLStore.deleteParts(job.id).catch(() => {});
  setState(job, 'done', { phase: '', error: '', tracks: null, done: job.total, estTotal: job.bytes, permanent: false });
}

const waiters = new Map();
async function saveBlobAndWait(parts, mime, filename, job) {
  const url = URL.createObjectURL(new Blob(parts, { type: mime }));
  let id;
  try {
    job.relPath = buildPath(filename);
    id = await browser.downloads.download({ url, filename: job.relPath, saveAs: !!job.askWhere, conflictAction: 'uniquify' });
  } catch (e) {
    URL.revokeObjectURL(url);
    if (/cancel/i.test(e.message || '')) { const c = new Error('Speichern abgebrochen'); c.saveCancelled = true; throw c; }
    throw e;
  }
  try {
    await new Promise((resolve, reject) => {
      waiters.set(id, { resolve, reject });
      browser.downloads.search({ id }).then(([d]) => {
        if (d && d.state === 'complete') resolve();
        else if (d && d.state === 'interrupted') reject(new Error(DL_ERRORS[d.error] || d.error || 'Speichern fehlgeschlagen'));
      });
    });
  } finally {
    waiters.delete(id);
    URL.revokeObjectURL(url);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Letzten Speicherort merken
// Firefox lässt Erweiterungen nur innerhalb des Firefox-Download-Ordners selbst speichern.
// Daher: Download-Ordner ermitteln und einen per „Speichern unter …“ gewählten Ordner darin
// als Unterordner übernehmen. Liegt er außerhalb, wird das klar gemeldet.
// ---------------------------------------------------------------------------
const normDir = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const isWinPath = p => /^[a-z]:/i.test(p) || /^\/\//.test(p);
const sameDir = (a, b) => (isWinPath(a) ? a.toLowerCase() === b.toLowerCase() : a === b);
const dirOf = p => String(p).replace(/[\\/][^\\/]*$/, '');

async function storedBaseDir() {
  const s = await browser.storage.local.get({ downloadBaseDir: '' });
  return s.downloadBaseDir || '';
}
// Aus einem normalen Download (ohne Dialog) den Firefox-Download-Ordner ableiten
async function learnBaseDir(absPath, relPath) {
  if (!absPath || !relPath) return '';
  const absDir = normDir(dirOf(absPath));
  const relDir = normDir(dirOf(relPath) === relPath ? '' : dirOf(relPath));
  let base = absDir;
  if (relDir) {
    const tail = '/' + relDir;
    if (!sameDir(absDir.slice(-tail.length), tail)) return '';
    base = absDir.slice(0, -tail.length);
  }
  const native = absPath.includes('\\') ? base.replace(/\//g, '\\') : base;
  await browser.storage.local.set({ downloadBaseDir: native });
  return native;
}
// Falls noch unbekannt: winzige Testdatei speichern, Ort ablesen, Datei wieder löschen
async function probeBaseDir() {
  const url = URL.createObjectURL(new Blob(['Video-Downloader: Ordnertest – kann gelöscht werden'], { type: 'text/plain' }));
  try {
    const id = await browser.downloads.download({ url, filename: 'vdl-ordnertest.txt', saveAs: false, conflictAction: 'uniquify' });
    for (let i = 0; i < 50; i++) {
      const [d] = await browser.downloads.search({ id });
      if (d && d.state === 'complete') {
        const base = dirOf(d.filename);
        await browser.downloads.removeFile(id).catch(() => {});
        await browser.downloads.erase({ id }).catch(() => {});
        await browser.storage.local.set({ downloadBaseDir: base });
        return base;
      }
      if (d && d.state === 'interrupted') break;
      await sleep(100);
    }
  } catch (e) { /* ignore */ } finally { URL.revokeObjectURL(url); }
  return '';
}

async function rememberLocation(job, downloadId, viaDialog) {
  const [d] = await browser.downloads.search({ id: downloadId }).catch(() => []);
  if (!d || !d.filename) return;
  if (!viaDialog) { await learnBaseDir(d.filename, job.relPath); return; }
  if (settings.rememberLast === false) return;
  const chosenDir = dirOf(d.filename);
  let base = await storedBaseDir();
  if (!base) base = await probeBaseDir();
  if (!base) return;
  const nb = normDir(base), nd = normDir(chosenDir);
  let rel = null;
  if (sameDir(nd, nb)) rel = '';
  else if (sameDir(nd.slice(0, nb.length + 1), nb + '/')) rel = nd.slice(nb.length + 1);
  if (rel === null) {
    job.note = 'Gespeichert in „' + chosenDir + '“. Dieser Ordner liegt außerhalb des Firefox-Download-Ordners (' + base +
      '), dorthin darf Firefox Erweiterungen nicht automatisch speichern lassen. Lösung: In Firefox unter Einstellungen → Allgemein → Downloads diesen Ordner wählen.';
    await browser.storage.local.set({ lastOutsideDir: chosenDir });
    return;
  }
  if (rel !== (settings.subfolder || '')) {
    settings.subfolder = rel;
    await browser.storage.local.set({ subfolder: rel, lastOutsideDir: '' });
    job.note = 'Speicherort gemerkt – künftige Downloads landen automatisch in „' + chosenDir + '“.';
  }
}

// ---------------------------------------------------------------------------
// Direkte Dateien: Firefox lädt selbst (inkl. Fortsetzen per Range), wir überwachen
// ---------------------------------------------------------------------------
async function findDownload(job) {
  if (job.downloadId != null) {
    const [d] = await browser.downloads.search({ id: job.downloadId }).catch(() => []);
    if (d && (d.url === job.source || d.finalUrl === job.source)) return d;
  }
  const list = await browser.downloads.search({ url: job.source, orderBy: ['-startTime'], limit: 1 }).catch(() => []);
  return list[0] || null;
}

async function runDirect(job) {
  try {
    rememberReferer(job.source, job.pageUrl);
    if (job.downloadId != null) {
      const d = await findDownload(job);
      if (d) {
        job.downloadId = d.id;
        dlToJob.set(d.id, job.id);
        if (d.state === 'complete') return finishDirect(job, d);
        if (d.state === 'in_progress') {
          if (!d.paused) { ensurePoll(); return; }
          if (d.canResume) {
            await browser.downloads.resume(d.id);
            job.note = 'An der abgebrochenen Stelle fortgesetzt.';
            ensurePoll();
            return;
          }
          await browser.downloads.cancel(d.id).catch(() => {});
        }
        if (d.state === 'interrupted' && d.canResume) {
          await browser.downloads.resume(d.id);
          job.note = 'An der abgebrochenen Stelle fortgesetzt.';
          persist(job, true);
          ensurePoll();
          return;
        }
        // nicht fortsetzbar → alte Reste entfernen und neu laden
        await browser.downloads.removeFile(d.id).catch(() => {});
        await browser.downloads.erase({ id: d.id }).catch(() => {});
      }
      job.restarts = (job.restarts || 0) + 1;
      job.note = 'Fortsetzen war nicht möglich – Download wurde neu gestartet.';
      job.bytes = 0;
    }
    job.filename = job.base + '.' + job.ext;
    job.relPath = buildPath(job.filename);
    job.usedSaveAs = !!job.askWhere && !job.restarts;
    const id = await browser.downloads.download({
      url: job.source, filename: job.relPath,
      saveAs: !!job.askWhere && !job.restarts, conflictAction: 'uniquify'
    });
    job.downloadId = id;
    dlToJob.set(id, job.id);
    speedState.delete(job.id);
    persist(job, true);
    ensurePoll();
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/cancel/i.test(msg)) setState(job, 'cancelled', { note: 'Speichern-Dialog abgebrochen' });
    else scheduleRetry(job, msg);
    pumpJobs();
  }
}

async function finishDirect(job, d) {
  job.bytes = (d && (d.fileSize || d.bytesReceived)) || job.bytes;
  job.estTotal = job.bytes;
  if (d && d.filename) job.filename = d.filename.split(/[\\/]/).pop();
  if (d) await rememberLocation(job, d.id, !!job.usedSaveAs).catch(() => {});
  setState(job, 'done', { phase: '', error: '' });
  pumpJobs();
}

let pollTimer = null;
function ensurePoll() { if (!pollTimer) pollTimer = setInterval(poll, 1000); }
async function poll() {
  const act = [...jobs.values()].filter(j => j.kind === 'direct' && j.state === 'running' && j.downloadId != null);
  if (!act.length) { clearInterval(pollTimer); pollTimer = null; return; }
  for (const j of act) {
    const [d] = await browser.downloads.search({ id: j.downloadId }).catch(() => []);
    if (!d) continue;
    if (d.state === 'complete') { finishDirect(j, d); continue; }
    j.bytes = d.bytesReceived || 0;
    if (d.totalBytes > 0) j.estTotal = d.totalBytes;
    j.phase = d.paused ? 'Pausiert (Firefox)' : 'Lade herunter';
    tick(j);
    if (d.estimatedEndTime) {
      const eta = (Date.parse(d.estimatedEndTime) - Date.now()) / 1000;
      if (isFinite(eta) && eta >= 0) j.eta = eta;
    }
  }
}

browser.downloads.onChanged.addListener(async delta => {
  const w = waiters.get(delta.id);
  if (w && delta.state) {
    if (delta.state.current === 'complete') w.resolve();
    else if (delta.state.current === 'interrupted') {
      const err = delta.error ? delta.error.current : '';
      w.reject(new Error(DL_ERRORS[err] || err || 'Speichern fehlgeschlagen'));
    }
  }
  const jid = dlToJob.get(delta.id);
  const job = jid && jobs.get(jid);
  if (!job || job.kind !== 'direct' || job.downloadId !== delta.id) return;
  if (delta.state) {
    const cur = delta.state.current;
    if (cur === 'complete') {
      const [d] = await browser.downloads.search({ id: delta.id }).catch(() => []);
      return finishDirect(job, d);
    }
    if (cur === 'interrupted') {
      const err = delta.error ? delta.error.current : '';
      if (job.userCancel || err === 'USER_CANCELED') {
        job.userCancel = false;
        if (job.state !== 'cancelled') setState(job, 'cancelled', { note: '' });
        pumpJobs();
        return;
      }
      scheduleRetry(job, 'Abgebrochen: ' + (DL_ERRORS[err] || err || 'unbekannter Fehler'));
      pumpJobs();
      return;
    }
    if (cur === 'in_progress' && job.state !== 'running') { setState(job, 'running'); ensurePoll(); }
  }
  if (delta.paused) {
    if (delta.paused.current === true && job.state === 'running' && !job.pausing) setState(job, 'paused');
    if (delta.paused.current === false && job.state === 'paused') { setState(job, 'running'); ensurePoll(); }
  }
});

// ---------------------------------------------------------------------------
// Start: gespeicherte Aufträge laden und Unterbrochenes fortsetzen
// ---------------------------------------------------------------------------
async function restoreJobs() {
  await settingsReady;
  const all = await VDLStore.allJobs().catch(() => []);
  const cutoff = Date.now() - 30 * 86400000;
  for (const j of all) {
    if (FINAL.has(j.state) && (j.finished || 0) < cutoff) {
      VDLStore.deleteJob(j.id).catch(() => {});
      VDLStore.deleteParts(j.id).catch(() => {});
      continue;
    }
    jobs.set(j.id, j);
    if (j.downloadId != null) dlToJob.set(j.downloadId, j.id);
    if (['running', 'merging', 'queued', 'interrupted'].includes(j.state)) {
      j.speed = 0; j.eta = 0;
      if (settings.autoResume) {
        j.state = 'queued';
        if (j.done > 0 || j.kind === 'direct') j.note = 'Nach Neustart automatisch fortgesetzt.';
      } else j.state = 'interrupted';
      persist(j);
    }
  }
  notifyJobs();
  pumpJobs();
  sweepFinished(true);
}
restoreJobs();

// ---------------------------------------------------------------------------
// Nachrichten aus Popup und Seitenleiste
// ---------------------------------------------------------------------------
browser.runtime.onMessage.addListener(msg => {
  switch (msg.type) {
    case 'download':
      return createJob(msg.tabId, msg.key, { askWhere: msg.askWhere, audioOnly: msg.audioOnly }).then(j => j.id, e => ({ error: e.message }));
    case 'getJobs': {
      const order = { running: 0, merging: 0, queued: 1, interrupted: 2, paused: 3, error: 4, cancelled: 5, done: 6 };
      const list = [...jobs.values()].map(jobPub)
        .sort((a, b) => (order[a.state] - order[b.state]) || (b.created - a.created));
      return Promise.resolve({ jobs: list, settings, update: updateInfo });
    }
    case 'pauseJob': return pauseJob(msg.id).then(() => true);
    case 'resumeJob': resumeJob(msg.id); return Promise.resolve(true);
    case 'cancelJob': return cancelJob(msg.id).then(() => true);
    case 'removeJob': return removeJob(msg.id).then(() => true);
    case 'pauseAll':
      return Promise.all([...jobs.values()].filter(j => ACTIVE.has(j.state) || j.state === 'queued' || j.state === 'interrupted')
        .map(j => pauseJob(j.id))).then(() => true);
    case 'resumeAll':
      [...jobs.values()].filter(j => j.state === 'paused' || j.state === 'interrupted').forEach(j => resumeJob(j.id));
      return Promise.resolve(true);
    case 'clearFinished':
      return Promise.all([...jobs.values()].filter(j => j.state === 'done' || j.state === 'cancelled')
        .map(j => removeJob(j.id))).then(() => true);
  }
});
