/* Gemeinsame Anzeige-Helfer für Popup und Seitenleiste. */
'use strict';

function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toLocaleString('de-DE', { maximumFractionDigits: i >= 2 ? 1 : 0 }) + ' ' + u[i];
}
function fmtDur(s) {
  if (!s || !isFinite(s) || s < 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  const pad = x => String(x).padStart(2, '0');
  return h ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
}
function fmtEta(s) {
  if (!s || !isFinite(s)) return '';
  if (s < 60) return 'noch ' + Math.max(1, Math.round(s)) + ' s';
  if (s < 3600) return 'noch ' + Math.round(s / 60) + ' min';
  return 'noch ' + Math.floor(s / 3600) + ' h ' + Math.round(s % 3600 / 60) + ' min';
}

/** Fortschritt eines Auftrags: Prozent (oder null = unbestimmt) und Textzeilen. */
function jobProgress(j) {
  let pct = null;
  if (j.state === 'done') pct = 100;
  else if (j.kind === 'direct') { if (j.estTotal > 0) pct = Math.min(100, j.bytes / j.estTotal * 100); }
  else if (j.total > 0) pct = Math.min(100, j.done / j.total * 100);

  const parts = [];
  if (pct != null && j.state !== 'done') parts.push(Math.floor(pct) + ' %');
  if (j.bytes) {
    const exact = j.kind === 'direct' || j.state === 'done';
    parts.push(fmtBytes(j.bytes) + (j.estTotal && j.state !== 'done' ? ' von ' + (exact ? '' : '≈ ') + fmtBytes(j.estTotal) : ''));
  }
  if (j.state === 'running' && j.speed > 0) parts.push(fmtBytes(j.speed) + '/s');
  if (j.state === 'running' && j.eta > 0) parts.push(fmtEta(j.eta));
  return { pct, line: parts.join(' · ') };
}

function jobStatus(j) {
  const now = Date.now();
  switch (j.state) {
    case 'queued': return { cls: '', text: 'Wartet…' + (j.note ? ' ' + j.note : '') };
    case 'running': return { cls: '', text: j.phase || 'Lade herunter', sub: j.note };
    case 'merging': return { cls: '', text: j.phase || 'Datei wird zusammengesetzt…' };
    case 'paused': return { cls: 'warn', text: 'Pausiert' + (j.note ? ' – ' + j.note : '') };
    case 'interrupted': {
      const wait = j.retryAt ? (j.retryAt - now) / 1000 : 0;
      return {
        cls: 'warn',
        text: 'Unterbrochen' + (j.error ? ': ' + j.error : '') +
          (wait > 0 ? ' – neuer Versuch in ' + fmtDur(wait) : ' – „Fortsetzen“ klicken')
      };
    }
    case 'done': return { cls: 'ok', text: '✓ Fertig' + (j.filename ? ': ' + j.filename : ''), sub: j.note };
    case 'error': return { cls: 'err', text: 'Fehler: ' + (j.error || 'unbekannt') };
    case 'cancelled': return { cls: 'muted', text: 'Abgebrochen' + (j.note ? ' – ' + j.note : '') };
    default: return { cls: '', text: j.state };
  }
}
