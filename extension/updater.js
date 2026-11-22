'use strict';
/* Update-Funktion.
 * 1. Firefox prüft regelmäßig selbst über die update_url im Manifest und lädt neue Versionen.
 *    Die Erweiterung installiert sie, sobald keine Downloads mehr laufen (unterbrochene laufen danach weiter).
 * 2. Zusätzlich eigene Prüfung (alle 6 Stunden und per Button), damit man sofort sieht, ob es Neues gibt.
 * global settings, settingsReady, jobs, flush */

const MANIFEST = browser.runtime.getManifest();
const GECKO = (MANIFEST.browser_specific_settings || {}).gecko || {};
const ADDON_ID = GECKO.id || '';
const UPDATE_URL = GECKO.update_url || '';

const updateInfo = {
  current: MANIFEST.version, latest: '', link: '', available: false, pendingReload: false,
  state: 'idle', message: '', checkedAt: 0, hasUrl: !!UPDATE_URL
};

function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function notifyUpdate() {
  browser.runtime.sendMessage({ type: 'updateInfo', update: updateInfo }).catch(() => {});
  browser.browserAction.setTitle({ title: updateInfo.available ? 'Video-Downloader – Update ' + updateInfo.latest + ' verfügbar' : 'Video-Downloader' }).catch(() => {});
}

browser.storage.local.get({ updateState: null }).then(({ updateState }) => {
  if (!updateState) return;
  updateInfo.checkedAt = updateState.checkedAt || 0;
  if (updateState.latest && cmpVer(updateState.latest, updateInfo.current) > 0) {
    Object.assign(updateInfo, { latest: updateState.latest, link: updateState.link, available: true, state: 'available', message: 'Version ' + updateState.latest + ' ist verfügbar.' });
  }
});

async function checkForUpdates() {
  if (!UPDATE_URL) {
    Object.assign(updateInfo, { state: 'error', message: 'Keine Update-Adresse hinterlegt.' });
    return notifyUpdate();
  }
  updateInfo.state = 'checking';
  updateInfo.message = 'Suche nach Updates…';
  notifyUpdate();
  try {
    const r = await fetch(UPDATE_URL + (UPDATE_URL.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const list = (((data.addons || {})[ADDON_ID] || {}).updates) || [];
    let best = null;
    for (const u of list) if (u && u.version && (!best || cmpVer(u.version, best.version) > 0)) best = u;
    updateInfo.checkedAt = Date.now();
    if (best && cmpVer(best.version, updateInfo.current) > 0) {
      Object.assign(updateInfo, {
        available: true, latest: best.version, link: best.update_link || '',
        state: updateInfo.pendingReload ? 'ready' : 'available',
        message: updateInfo.pendingReload ? 'Version ' + best.version + ' ist bereit zur Installation.' : 'Version ' + best.version + ' ist verfügbar.'
      });
    } else {
      Object.assign(updateInfo, { available: false, latest: best ? best.version : updateInfo.current, state: 'uptodate', message: 'Du verwendest die neueste Version.' });
    }
  } catch (e) {
    Object.assign(updateInfo, { state: 'error', message: 'Update-Prüfung fehlgeschlagen: ' + e.message });
  }
  browser.storage.local.set({ updateState: { latest: updateInfo.latest, link: updateInfo.link, checkedAt: updateInfo.checkedAt } });
  notifyUpdate();
}

function hasActiveJobs() {
  for (const j of jobs.values()) if (j.state === 'running' || j.state === 'merging') return true;
  return false;
}

async function applyUpdate() {
  updateInfo.message = 'Update wird installiert…';
  notifyUpdate();
  await flush();
  browser.runtime.reload();
}

// Wird aufgerufen, sobald ein Download endet oder pausiert
function maybeApplyUpdate() {
  if (!updateInfo.pendingReload || !settings.autoUpdate) return;
  if (hasActiveJobs()) return;
  applyUpdate();
}

// Firefox hat eine neue Version heruntergeladen
browser.runtime.onUpdateAvailable.addListener(details => {
  Object.assign(updateInfo, {
    pendingReload: true, available: true, latest: details.version || updateInfo.latest, state: 'ready',
    message: 'Version ' + (details.version || '') + ' wurde heruntergeladen.' +
      (hasActiveJobs() ? ' Sie wird installiert, sobald die laufenden Downloads fertig sind.' : '')
  });
  notifyUpdate();
  maybeApplyUpdate();
});

browser.runtime.onInstalled.addListener(details => {
  if (details.reason === 'update') {
    Object.assign(updateInfo, { state: 'updated', message: 'Aktualisiert von ' + details.previousVersion + ' auf ' + updateInfo.current + '.' });
    browser.storage.local.set({ updateState: { latest: updateInfo.current, link: '', checkedAt: Date.now() } });
  }
});

browser.alarms.create('vdl-update-check', { delayInMinutes: 2, periodInMinutes: 360 });
browser.alarms.onAlarm.addListener(a => {
  if (a.name === 'vdl-update-check') settingsReady.then(() => { if (settings.autoUpdate) checkForUpdates(); });
});

browser.runtime.onMessage.addListener(msg => {
  switch (msg.type) {
    case 'checkUpdates':
      return checkForUpdates().then(() => updateInfo);
    case 'installUpdate':
      if (updateInfo.pendingReload) { applyUpdate(); return Promise.resolve(true); }
      if (updateInfo.link) return browser.tabs.create({ url: updateInfo.link }).then(() => true);
      return Promise.resolve(false);
    case 'getUpdate':
      return Promise.resolve(updateInfo);
  }
});
