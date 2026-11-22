/* Läuft in jeder Seite und in jedem eingebetteten Frame (iframe).
 * Sucht Videos im DOM, erzeugt Vorschaubilder und führt auf Anfrage eine Tiefensuche aus. */
(() => {
  'use strict';
  if (window.__vdlInjected) return;
  window.__vdlInjected = true;

  const EXT = '(?:mp4|m4v|webm|mkv|mov|ogv|ogg|flv|f4v|avi|wmv|asf|3gp|3g2|mpg|mpeg|m2ts|mts|vob|divx|m3u8|mpd)';
  const URL_RE = new RegExp('(?:https?:)?\\/\\/[^\\s"\'<>()\\\\{}|^`]+?\\.' + EXT + '(?:\\?[^\\s"\'<>\\\\{}|^`]*)?(?=$|[\\s"\'<>\\\\),;])', 'gi');
  const REL_RE = new RegExp('["\'(=]((?:\\.{0,2}\\/)?[\\w\\-.\\/%~+]+\\.' + EXT + '(?:\\?[^"\'\\s<>)]*)?)(?=["\')\\s&])', 'gi');
  const HAS_EXT = new RegExp('\\.' + EXT + '(?:$|[?#&"\'\\s])', 'i');

  const abs = u => {
    if (!u) return null;
    try { return new URL(u.trim(), document.baseURI).href; } catch (e) { return null; }
  };
  const unescapeText = t => t.replace(/\\u002[fF]/g, '/').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

  function roots() {
    const out = [document];
    const walk = root => {
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length && i < 30000; i++) {
        if (all[i].shadowRoot) { out.push(all[i].shadowRoot); walk(all[i].shadowRoot); }
      }
    };
    try { walk(document); } catch (e) { /* ignore */ }
    return out;
  }
  const qAll = (rs, sel) => rs.flatMap(r => Array.from(r.querySelectorAll(sel)));

  function captureFrame(v) {
    try {
      if (v.readyState >= 2 && v.videoWidth > 0) {
        const c = document.createElement('canvas');
        const w = 320;
        const h = Math.max(1, Math.round(w * v.videoHeight / v.videoWidth));
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        const data = c.toDataURL('image/jpeg', 0.72);
        if (data.length > 1500) return data;
      }
    } catch (e) { /* fremde Herkunft – Canvas gesperrt */ }
    return null;
  }

  let lastSig = '';

  function scan(deep) {
    const items = [];
    const seen = new Set();
    const add = (url, extra) => {
      const a = abs(url);
      if (!a || !/^https?:/i.test(a)) return;
      const k = a + '|' + (extra && extra.groupHint || '');
      if (seen.has(k)) return;
      seen.add(k);
      items.push(Object.assign({ url: a }, extra || {}));
    };
    const rs = roots();
    let pageThumb = null, pageThumbQuality = 0, bestArea = 0;

    // <video>-Elemente
    qAll(rs, 'video').forEach((v, idx) => {
      const frame = captureFrame(v);
      const poster = v.poster ? abs(v.poster) : null;
      const thumb = frame || poster;
      const area = (v.clientWidth || 0) * (v.clientHeight || 0);
      if (thumb && (area >= bestArea || !pageThumb)) {
        const q = frame ? 3 : 2;
        if (q >= pageThumbQuality) { pageThumb = thumb; pageThumbQuality = q; bestArea = area; }
      }
      const sources = Array.from(v.querySelectorAll('source'));
      const hint = sources.length > 1 ? 'video:' + location.href + '#' + idx : null;
      const cur = v.currentSrc || v.src;
      sources.forEach(s => {
        const label = ['size', 'res', 'label', 'data-res', 'data-quality', 'data-size', 'title', 'quality']
          .map(a => s.getAttribute(a)).filter(Boolean).join(' ');
        const src = abs(s.getAttribute('src') || s.src);
        const playing = src && src === cur;
        add(src, { type: s.type || '', isVideoSrc: true, label, thumb, groupHint: hint,
          width: playing ? v.videoWidth || 0 : 0, height: playing ? v.videoHeight || 0 : 0 });
      });
      if (cur && !cur.startsWith('blob:')) {
        add(cur, { isVideoSrc: true, thumb, width: v.videoWidth || 0, height: v.videoHeight || 0, groupHint: hint });
      }
    });

    // Links, Meta-Angaben, Einbettungen
    qAll(rs, 'a[href]').forEach(a => {
      const h = a.getAttribute('href');
      if (h && HAS_EXT.test(h)) add(h, { label: (a.textContent || '').trim().slice(0, 40) });
    });
    qAll(rs, 'meta[property^="og:video"], meta[name^="og:video"], meta[name^="twitter:player:stream"], meta[itemprop="contentUrl"], meta[property="video"]')
      .forEach(m => {
        const c = m.getAttribute('content');
        if (c && /^(https?:)?\/\//.test(c.trim()) && !/type$|width$|height$/.test(m.getAttribute('property') || '')) {
          if (HAS_EXT.test(c)) add(c, {});
        }
      });
    qAll(rs, 'link[rel="video_src"], embed[src], object[data], iframe[src]').forEach(e => {
      const u = e.getAttribute('src') || e.getAttribute('data') || e.getAttribute('href');
      if (u && HAS_EXT.test(u)) add(u, { isVideoSrc: e.tagName !== 'IFRAME' });
    });
    qAll(rs, '[data-src],[data-video],[data-video-src],[data-video-url],[data-url],[data-file],[data-hls],[data-dash],[data-mp4],[data-webm],[data-stream],[data-source],[data-href]')
      .forEach(el => {
        for (const at of el.attributes) {
          if (at.name.startsWith('data-') && at.value.length < 3000 && HAS_EXT.test(at.value)) {
            extract(at.value).forEach(u => add(u, {}));
          }
        }
      });
    if (!pageThumb) {
      const og = document.querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"]');
      if (og && og.content) { pageThumb = abs(og.content); pageThumbQuality = 1; }
    }

    if (deep) deepScan(rs, add);

    const msg = {
      type: 'domMedia', deep: !!deep, pageUrl: location.href,
      items, pageThumb: window === window.top || pageThumbQuality >= 2 ? pageThumb : null, pageThumbQuality
    };
    const sig = JSON.stringify([items.map(i => i.url + (i.thumb ? 1 : 0)), !!pageThumb, pageThumbQuality]);
    if (!deep && sig === lastSig) return Promise.resolve(true);
    lastSig = sig;
    return browser.runtime.sendMessage(msg).catch(() => {});
  }

  function extract(text) {
    const out = new Set();
    if (!text) return out;
    const t = unescapeText(text);
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(t))) out.add(m[0].startsWith('//') ? location.protocol + m[0] : m[0]);
    REL_RE.lastIndex = 0;
    while ((m = REL_RE.exec(t))) {
      if (!/^(https?:)?\/\//.test(m[1])) out.add(m[1]);
    }
    // Ganzer Wert ist eine (relative) Adresse
    const trimmed = t.trim();
    if (/^[\w\-.\/%~:?=&+#;@!$*]+$/.test(trimmed) && HAS_EXT.test(trimmed) && trimmed.length < 2000) out.add(trimmed);
    return out;
  }

  function deepScan(rs, add) {
    // 1. Alle Attribute aller Elemente
    for (const el of qAll(rs, '*')) {
      for (const at of el.attributes) {
        if (at.value.length < 5000 && HAS_EXT.test(at.value)) extract(at.value).forEach(u => add(u, {}));
      }
    }
    // 2. Skripte und strukturierte Daten
    qAll(rs, 'script').forEach(s => {
      if (s.src) return;
      const txt = s.textContent || '';
      if (s.type === 'application/ld+json') {
        try {
          const walk = o => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) return o.forEach(walk);
            for (const k of ['contentUrl', 'embedUrl', 'url']) {
              if (typeof o[k] === 'string' && HAS_EXT.test(o[k])) add(o[k], {});
            }
            Object.values(o).forEach(walk);
          };
          walk(JSON.parse(txt));
        } catch (e) { /* ignore */ }
      }
      if (txt.length < 8e6) extract(txt).forEach(u => add(u, {}));
    });
    // 3. Gesamter Quelltext (inkl. Kommentare, noscript, Templates)
    try {
      const html = document.documentElement.outerHTML;
      if (html.length < 2e7) extract(html).forEach(u => add(u, {}));
    } catch (e) { /* ignore */ }
    // 4. Bereits geladene Ressourcen
    try {
      performance.getEntriesByType('resource').forEach(e => {
        if (HAS_EXT.test(e.name) && !/\.(m4s|ts)(\?|$)/i.test(e.name)) add(e.name, {});
      });
    } catch (e) { /* ignore */ }
  }

  // Erste Suche und spätere Änderungen beobachten
  let timer = null;
  const later = (ms) => { clearTimeout(timer); timer = setTimeout(() => scan(false), ms || 1200); };
  scan(false);
  setTimeout(() => scan(false), 3000);
  try {
    new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && (/^(VIDEO|SOURCE|IFRAME|EMBED|OBJECT)$/.test(n.nodeName) || (n.querySelector && n.querySelector('video,source,iframe,embed')))) {
            later();
            return;
          }
        }
        if (m.type === 'attributes') { later(); return; }
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'poster'] });
  } catch (e) { /* ignore */ }
  ['loadedmetadata', 'playing', 'seeked'].forEach(ev =>
    document.addEventListener(ev, e => { if (e.target && e.target.nodeName === 'VIDEO') later(400); }, true));

  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'scan') { lastSig = ''; return scan(false).then(() => true); }
    if (msg.type === 'deepScan') return scan(true).then(() => true);
    if (msg.type === 'pageFetch') {
      // Lädt als die Seite selbst: gleiche Cookies, gleicher Referer, gleiche Herkunft
      const f = (typeof content !== 'undefined' && content.fetch) ? content.fetch.bind(content) : fetch;
      const headers = {};
      if (msg.range) headers.Range = 'bytes=' + msg.range.start + '-' + msg.range.end;
      return f(msg.url, { credentials: 'include', headers, cache: 'no-store' })
        .then(async r => {
          if (!r.ok) return { ok: false, status: r.status };
          return msg.text ? { ok: true, status: r.status, text: await r.text() } : { ok: true, status: r.status, buf: await r.arrayBuffer() };
        })
        .catch(e => ({ ok: false, status: 0, error: String(e && e.message || e) }));
    }
  });
})();
