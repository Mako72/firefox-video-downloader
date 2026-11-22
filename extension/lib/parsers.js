/* Gemeinsame Hilfsfunktionen: Formaterkennung, Qualitätsbestimmung, HLS- und DASH-Parser.
 * Läuft im Hintergrundskript und (für Tests) in Node. */
(function (g) {
  'use strict';

  const VIDEO_EXT = new Set([
    'mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'ogg', 'flv', 'f4v', 'avi', 'wmv', 'asf',
    '3gp', '3g2', 'mpg', 'mpeg', 'mpe', 'm2v', 'mts', 'm2ts', 'vob', 'divx', 'rm', 'rmvb', 'qt', 'hevc'
  ]);
  const HLS_TYPES = new Set([
    'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/mpegurl',
    'audio/mpegurl', 'audio/x-mpegurl', 'video/x-mpegurl', 'video/mpegurl'
  ]);
  const DASH_TYPES = new Set(['application/dash+xml', 'video/vnd.mpeg.dash.mpd']);
  const RANGE_PARAMS = ['range', 'bytestart', 'byteend', 'bytes'];
  const URL_EXT_PATTERN = '(?:' + [...VIDEO_EXT, 'm3u8', 'mpd'].join('|') + ')';

  function getExt(url) {
    try {
      const last = new URL(url).pathname.split('/').pop();
      const i = last.lastIndexOf('.');
      return i >= 0 ? last.slice(i + 1).toLowerCase() : '';
    } catch (e) { return ''; }
  }

  /** Entfernt Anker und Byte-Range-Parameter, damit Teilanfragen desselben Videos zusammenfallen. */
  function cleanUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      if (RANGE_PARAMS.some(p => u.searchParams.has(p))) {
        RANGE_PARAMS.forEach(p => u.searchParams.delete(p));
      }
      return u.href;
    } catch (e) { return url; }
  }

  function classify(url, contentType) {
    const ct = (contentType || '').toLowerCase().split(';')[0].trim();
    const ext = getExt(url);
    if (HLS_TYPES.has(ct) || ext === 'm3u8') return 'hls';
    if (DASH_TYPES.has(ct) || ext === 'mpd') return 'dash';
    if (ct === 'video/mp2t' || ct === 'video/iso.segment' || ext === 'm4s') return 'segment';
    if (ext === 'ts') {
      return (!ct || ct.includes('video') || ct.includes('octet')) ? 'segment' : null;
    }
    if (ct.startsWith('video/')) return 'direct';
    if (VIDEO_EXT.has(ext) && (!ct || ct.includes('octet') || ct.includes('binary') || ct.startsWith('video/'))) return 'direct';
    return null;
  }

  function looksLikeSegment(url) {
    let p = url;
    try { p = new URL(url).pathname; } catch (e) { /* ignore */ }
    return /(?:^|[\/_\-.])(?:seg(?:ment)?|chunk|frag(?:ment)?|part|init)[\-_]?\d*(?:[\/_\-.]|$)/i.test(p) ||
      /[\/_\-](?:\d{1,6})\.(?:mp4|m4v|m4a|ts|webm)$/i.test(p);
  }

  // ---------- Qualität ----------
  const QUAL_WORDS = {
    '8k': 4320, '4k': 2160, 'uhd': 2160, '2k': 1440, 'qhd': 1440, 'fullhd': 1080, 'fhd': 1080,
    'hd': 720, 'hq': 720, 'high': 1080, 'large': 1080, 'sd': 480, 'medium': 480, 'med': 480,
    'mobile': 360, 'lq': 240, 'low': 240, 'small': 240, 'original': 9000, 'source': 9000, 'orig': 9000
  };
  const WORDS = Object.keys(QUAL_WORDS).join('|');
  const HEIGHTS = '4320|2160|1440|1080|720|576|540|480|432|360|288|270|240|180|144';
  const B = '[\\/_\\-.=,&?\\s]';
  const RE_RES = /(?:^|[^0-9])(\d{3,4})x(\d{3,4})(?![0-9])/i;
  const RE_P = new RegExp('(?:^|[^0-9])(' + HEIGHTS + ')p(?![a-z0-9])', 'i');
  const RE_BARE = new RegExp('(?:^|' + B + ')(' + HEIGHTS + ')(?=$|' + B + ')', 'i');
  const RE_WORD = new RegExp('(?:^|' + B + ')(' + WORDS + ')(?=$|' + B + ')', 'i');

  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  /** Liefert {height, rank, label} aus einem beliebigen Text (URL, Label, Attribut). */
  function qualityFromString(str) {
    if (!str) return { height: 0, rank: 0, label: '' };
    let s = String(str);
    try { const u = new URL(s); s = u.pathname + u.search; } catch (e) { /* kein URL */ }
    s = safeDecode(s);
    let m = s.match(RE_RES);
    if (m && +m[2] >= 100) return { height: +m[2], width: +m[1], rank: +m[2], label: m[2] + 'p' };
    m = s.match(RE_P) || s.match(RE_BARE);
    if (m) return { height: +m[1], rank: +m[1], label: m[1] + 'p' };
    m = s.match(RE_WORD);
    if (m) {
      const w = m[1].toLowerCase();
      const r = QUAL_WORDS[w];
      return { height: r >= 9000 ? 0 : r, rank: r, label: r >= 9000 ? 'Original' : (r + 'p') };
    }
    return { height: 0, rank: 0, label: '' };
  }

  const VOLATILE_PARAMS = /^(quality|q|res|resolution|height|width|format|fmt|token|sig|signature|expires|exp|e|hash|h|st|ttl|auth|key|policy|t|ts|time|cb|_|rnd|random|v)$/i;
  const NORMALIZE_RE = new RegExp('(^|[\\/_\\-.=])(\\d{3,4}x\\d{3,4}|(?:' + HEIGHTS + ')p?|' + WORDS + ')(?=$|[\\/_\\-.=])', 'gi');

  /** Schlüssel, unter dem verschiedene Qualitätsstufen desselben Videos zusammengefasst werden. */
  function groupKey(url) {
    try {
      const u = new URL(cleanUrl(url));
      const rawPath = safeDecode(u.pathname).toLowerCase();
      const hasExt = VIDEO_EXT.has(getExt(u.href));
      let p = rawPath.replace(/\.[a-z0-9]{2,5}$/, '');
      p = p.replace(NORMALIZE_RE, '$1*').replace(NORMALIZE_RE, '$1*');
      let q = '';
      if (!hasExt) {
        const keep = [];
        u.searchParams.forEach((v, k) => { if (!VOLATILE_PARAMS.test(k)) keep.push(k + '=' + v); });
        q = keep.sort().join('&');
      }
      const host = u.hostname.replace(/^[a-z\-]*\d+[a-z\-]*\./i, '');
      return host + p + (q ? '?' + q : '');
    } catch (e) { return url; }
  }

  // ---------- HLS ----------
  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) {
      let v = m[2];
      if (v.startsWith('"')) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }

  function parseByteRange(s) {
    const [len, off] = String(s).split('@');
    return { length: parseInt(len, 10), offset: off !== undefined ? parseInt(off, 10) : null };
  }

  function parseM3U8(text, base) {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('Keine gültige HLS-Playlist');
    const abs = u => new URL(u, base).href;

    if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
      const variants = [];
      const audio = [];
      let sessionKey = false;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('#EXT-X-STREAM-INF:')) {
          const a = parseAttrs(l.slice(18));
          let j = i + 1;
          while (j < lines.length && lines[j].startsWith('#')) j++;
          if (j < lines.length) {
            const res = (a.RESOLUTION || '').split('x');
            variants.push({
              url: abs(lines[j]),
              bandwidth: +(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || 0),
              peak: +(a.BANDWIDTH || 0),
              width: +res[0] || 0,
              height: +res[1] || 0,
              codecs: a.CODECS || '',
              audioGroup: a.AUDIO || null
            });
            i = j;
          }
        } else if (l.startsWith('#EXT-X-MEDIA:')) {
          const a = parseAttrs(l.slice(13));
          if (a.TYPE === 'AUDIO' && a.URI) {
            audio.push({
              url: abs(a.URI), group: a['GROUP-ID'], name: a.NAME || '',
              language: a.LANGUAGE || '', isDefault: a.DEFAULT === 'YES'
            });
          }
        } else if (l.startsWith('#EXT-X-SESSION-KEY:')) {
          const a = parseAttrs(l.slice(19));
          if (a.METHOD && a.METHOD !== 'NONE') sessionKey = true;
        }
      }
      // Reine Audio-Varianten (z. B. CODECS="mp4a...") nach hinten
      const isAudioOnly = v => v.codecs && !/avc|hvc|hev|vp0?9|av01|vp8|mp4v/i.test(v.codecs) && !v.height;
      variants.sort((a, b) => (isAudioOnly(a) - isAudioOnly(b)) || (b.height - a.height) || (b.bandwidth - a.bandwidth));
      return { type: 'master', variants, audio, encrypted: sessionKey };
    }

    const segments = [];
    let map = null, encrypted = false, duration = 0, ended = false, vod = false;
    let segDur = 0, pending = null;
    const lastEnd = {};
    for (const l of lines) {
      if (l.startsWith('#EXTINF:')) segDur = parseFloat(l.slice(8)) || 0;
      else if (l.startsWith('#EXT-X-BYTERANGE:')) pending = parseByteRange(l.slice(17));
      else if (l.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(l.slice(11));
        if (a.METHOD && a.METHOD !== 'NONE') encrypted = true;
      } else if (l.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(l.slice(11));
        map = { url: abs(a.URI), range: null };
        if (a.BYTERANGE) {
          const r = parseByteRange(a.BYTERANGE);
          const off = r.offset || 0;
          map.range = { start: off, end: off + r.length - 1 };
        }
      } else if (l.startsWith('#EXT-X-ENDLIST')) ended = true;
      else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) vod = /VOD/i.test(l);
      else if (!l.startsWith('#')) {
        const url = abs(l);
        let range = null;
        if (pending) {
          const off = pending.offset !== null ? pending.offset : (lastEnd[url] || 0);
          range = { start: off, end: off + pending.length - 1 };
          lastEnd[url] = off + pending.length;
          pending = null;
        }
        segments.push({ url, range, duration: segDur });
        duration += segDur;
        segDur = 0;
      }
    }
    return { type: 'media', segments, map, encrypted, duration, live: !ended && !vod };
  }

  // ---------- DASH ----------
  function isoDuration(s) {
    if (!s) return 0;
    const m = String(s).match(/^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    if (!m) return 0;
    const n = i => parseFloat(m[i] || 0);
    return n(1) * 31536000 + n(2) * 2592000 + n(3) * 86400 + n(4) * 3600 + n(5) * 60 + n(6);
  }

  function parseMPD(text, mpdUrl) {
    if (typeof g.DOMParser === 'undefined') throw new Error('DOMParser nicht verfügbar');
    const doc = new g.DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('MPD konnte nicht gelesen werden');
    const mpd = doc.documentElement;
    const kids = (el, name) => el ? Array.from(el.children).filter(c => c.localName === name) : [];
    const baseOf = (el, parent) => {
      const b = kids(el, 'BaseURL')[0];
      return b ? new URL(b.textContent.trim(), parent).href : parent;
    };
    const attrs = el => {
      const o = {};
      if (el) for (const a of Array.from(el.attributes)) o[a.name] = a.value;
      return o;
    };
    const readTimeline = tplEl => {
      const tl = kids(tplEl, 'SegmentTimeline')[0];
      if (!tl) return null;
      return kids(tl, 'S').map(s => ({
        t: s.hasAttribute('t') ? +s.getAttribute('t') : null,
        d: +s.getAttribute('d'),
        r: s.hasAttribute('r') ? +s.getAttribute('r') : 0
      }));
    };
    const mergeTpl = (...els) => {
      let out = null;
      for (const el of els) {
        if (!el) continue;
        out = Object.assign(out || {}, attrs(el));
        const tl = readTimeline(el);
        if (tl) out.timeline = tl;
      }
      return out;
    };

    const live = mpd.getAttribute('type') === 'dynamic';
    const total = isoDuration(mpd.getAttribute('mediaPresentationDuration'));
    const periods = kids(mpd, 'Period');
    let period = null, pDur = -1;
    periods.forEach((p, i) => {
      let d = isoDuration(p.getAttribute('duration'));
      if (!d) {
        const start = isoDuration(p.getAttribute('start'));
        const next = periods[i + 1];
        d = next ? isoDuration(next.getAttribute('start')) - start : (total ? total - start : 0);
      }
      if (d > pDur) { pDur = d; period = p; }
    });
    if (!period) throw new Error('MPD enthält keine Period');
    const duration = pDur > 0 ? pDur : total;
    const pBase = baseOf(period, baseOf(mpd, mpdUrl));
    const pTpl = kids(period, 'SegmentTemplate')[0];

    const video = [], audio = [];
    let protectedAny = false;
    for (const as of kids(period, 'AdaptationSet')) {
      const asBase = baseOf(as, pBase);
      const asMime = as.getAttribute('mimeType') || '';
      const asType = as.getAttribute('contentType') || asMime.split('/')[0];
      const asProt = kids(as, 'ContentProtection').length > 0;
      const asTpl = kids(as, 'SegmentTemplate')[0];
      const asList = kids(as, 'SegmentList')[0];
      for (const rep of kids(as, 'Representation')) {
        const mime = rep.getAttribute('mimeType') || asMime;
        const codecs = rep.getAttribute('codecs') || as.getAttribute('codecs') || '';
        let type = asType || mime.split('/')[0];
        if (type !== 'video' && type !== 'audio') {
          type = /avc|hvc|hev|vp0?9|av01|vp8/i.test(codecs) ? 'video'
            : /mp4a|opus|ac-3|ec-3|vorbis|flac/i.test(codecs) ? 'audio' : '';
        }
        if (type !== 'video' && type !== 'audio') continue;
        const prot = asProt || kids(rep, 'ContentProtection').length > 0;
        if (prot) protectedAny = true;
        const base = baseOf(rep, asBase);
        const r = {
          id: rep.getAttribute('id') || '',
          bandwidth: +rep.getAttribute('bandwidth') || 0,
          width: +(rep.getAttribute('width') || as.getAttribute('width')) || 0,
          height: +(rep.getAttribute('height') || as.getAttribute('height')) || 0,
          mime, codecs, protected: prot, base, duration,
          lang: as.getAttribute('lang') || '',
          tpl: mergeTpl(pTpl, asTpl, kids(rep, 'SegmentTemplate')[0]),
          list: null
        };
        const listEl = kids(rep, 'SegmentList')[0] || asList;
        if (listEl) {
          const init = kids(listEl, 'Initialization')[0];
          const toRange = s => { if (!s) return null; const [a, b] = s.split('-').map(Number); return { start: a, end: b }; };
          r.list = {
            init: init ? { url: new URL(init.getAttribute('sourceURL') || '', base).href, range: toRange(init.getAttribute('range')) } : null,
            segs: kids(listEl, 'SegmentURL').map(s => ({
              url: new URL(s.getAttribute('media') || '', base).href,
              range: toRange(s.getAttribute('mediaRange'))
            }))
          };
        }
        (type === 'video' ? video : audio).push(r);
      }
    }
    video.sort((a, b) => (a.protected - b.protected) || (b.height - a.height) || (b.bandwidth - a.bandwidth));
    audio.sort((a, b) => (a.protected - b.protected) || (b.bandwidth - a.bandwidth));
    return { live, protected: protectedAny, duration, video, audio };
  }

  function fillTemplate(tpl, rep, number, time) {
    return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$|\$\$/g, (m, name, width) => {
      if (m === '$$') return '$';
      let v = name === 'RepresentationID' ? rep.id : name === 'Number' ? number : name === 'Bandwidth' ? rep.bandwidth : time;
      v = String(v);
      if (width && name !== 'RepresentationID') v = v.padStart(+width, '0');
      return v;
    });
  }

  /** Liste der herunterzuladenden Teile einer DASH-Representation. */
  function dashSegments(rep, mpdUrl) {
    const parts = [];
    const t = rep.tpl;
    if (t && t.media) {
      const ts = +t.timescale || 1;
      const start = t.startNumber != null ? +t.startNumber : 1;
      if (t.initialization) parts.push({ url: new URL(fillTemplate(t.initialization, rep, start, 0), rep.base).href, init: true });
      if (t.timeline && t.timeline.length) {
        let time = 0, num = start;
        const pto = +t.presentationTimeOffset || 0;
        const periodEnd = rep.duration ? rep.duration * ts + pto : Infinity;
        t.timeline.forEach((s, idx) => {
          if (s.t !== null) time = s.t;
          let r = s.r || 0;
          if (r < 0) {
            const next = t.timeline[idx + 1];
            const end = next && next.t !== null ? next.t : periodEnd;
            if (!isFinite(end)) throw new Error('Unbegrenzte Segmentliste (Live-Stream)');
            r = Math.ceil((end - time) / s.d) - 1;
          }
          for (let k = 0; k <= r; k++) {
            parts.push({ url: new URL(fillTemplate(t.media, rep, num, time), rep.base).href });
            time += s.d;
            num++;
          }
        });
      } else if (t.duration) {
        if (!rep.duration) throw new Error('Dauer des Streams unbekannt');
        const d = +t.duration;
        const count = Math.ceil((rep.duration * ts) / d);
        for (let k = 0; k < count; k++) {
          parts.push({ url: new URL(fillTemplate(t.media, rep, start + k, k * d), rep.base).href });
        }
      }
      return parts;
    }
    if (rep.list && rep.list.segs.length) {
      if (rep.list.init) parts.push(Object.assign({ init: true }, rep.list.init));
      return parts.concat(rep.list.segs);
    }
    if (!rep.base || rep.base === mpdUrl) throw new Error('Keine Segmentinformation gefunden');
    return [{ url: rep.base, single: true }];
  }

  g.VDL = {
    VIDEO_EXT, URL_EXT_PATTERN, getExt, cleanUrl, classify, looksLikeSegment,
    qualityFromString, groupKey, parseM3U8, parseMPD, dashSegments, isoDuration
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
