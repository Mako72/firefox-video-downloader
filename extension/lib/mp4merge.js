/* Führt eine fragmentierte MP4-Videospur und eine fragmentierte MP4-Tonspur
 * (typisch für DASH und HLS/CMAF) ohne Neukodierung zu einer Datei zusammen.
 * Wirft einen Fehler, wenn das Format nicht passt – der Aufrufer speichert dann getrennt. */
(function (g) {
  'use strict';

  const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const w32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
  const type = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  function boxes(b, start = 0, end = b.length) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      const t = type(b, o + 4);
      let hdr = 8;
      if (size === 1) { size = u32(b, o + 8) * 4294967296 + u32(b, o + 12); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) throw new Error('Ungültige MP4-Box ' + t);
      out.push({ type: t, start: o, size, hdr, end: o + size });
      o += size;
    }
    return out;
  }
  const child = (b, box, t) => boxes(b, box.start + box.hdr, box.end).find(x => x.type === t);
  const children = (b, box) => boxes(b, box.start + box.hdr, box.end);
  const slice = (b, box) => b.subarray(box.start, box.end);

  function makeBox(t, parts) {
    const len = 8 + parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    w32(out, 0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function trakInfo(b, trak) {
    const tkhd = child(b, trak, 'tkhd');
    const v = b[tkhd.start + tkhd.hdr];
    const idOff = tkhd.start + tkhd.hdr + (v === 1 ? 20 : 12);
    const mdia = child(b, trak, 'mdia');
    const mdhd = child(b, mdia, 'mdhd');
    const mv = b[mdhd.start + mdhd.hdr];
    const timescale = u32(b, mdhd.start + mdhd.hdr + (mv === 1 ? 20 : 12));
    const hdlr = child(b, mdia, 'hdlr');
    const handler = type(b, hdlr.start + hdlr.hdr + 8);
    return { id: u32(b, idOff), idOff, timescale, handler };
  }

  /** Zerlegt einen Strom (Liste von Puffern) in Init-Teile und Fragmente. */
  function scan(buffers) {
    let ftyp = null, moov = null;
    const frags = [];
    let cur = null;
    for (const buf of buffers) {
      const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      for (const box of boxes(b)) {
        if (box.type === 'ftyp' && !ftyp) ftyp = { b, box };
        else if (box.type === 'moov' && !moov) moov = { b, box };
        else if (box.type === 'moof') { cur = { moof: { b, box }, data: [] }; frags.push(cur); }
        else if (box.type === 'mdat' && cur) cur.data.push(slice(b, box));
      }
    }
    if (!moov) throw new Error('Kein moov – kein fragmentiertes MP4');
    if (!child(moov.b, moov.box, 'mvex')) throw new Error('MP4 ist nicht fragmentiert');
    if (!frags.length) throw new Error('Keine Fragmente gefunden');
    return { ftyp, moov, frags };
  }

  function fragTime(b, moof, timescales) {
    for (const traf of children(b, moof)) {
      if (traf.type !== 'traf') continue;
      const tfhd = child(b, traf, 'tfhd');
      const flags = u32(b, tfhd.start + tfhd.hdr) & 0xffffff;
      if (flags & 1) throw new Error('Absolute Datenoffsets werden nicht unterstützt');
      const id = u32(b, tfhd.start + tfhd.hdr + 4);
      const tfdt = child(b, traf, 'tfdt');
      if (!tfdt) return null;
      const v = b[tfdt.start + tfdt.hdr];
      const p = tfdt.start + tfdt.hdr + 4;
      const t = v === 1 ? u32(b, p) * 4294967296 + u32(b, p + 4) : u32(b, p);
      return t / (timescales[id] || 1);
    }
    return null;
  }

  function merge(videoBuffers, audioBuffers) {
    const V = scan(videoBuffers);
    const A = scan(audioBuffers);
    const vb = V.moov.b, ab = A.moov.b;

    const vTraks = children(vb, V.moov.box).filter(x => x.type === 'trak');
    const vInfo = vTraks.map(t => trakInfo(vb, t));
    if (vInfo.some(i => i.handler === 'soun')) throw new Error('Video enthält bereits Ton');
    const aTrak = children(ab, A.moov.box).find(x => x.type === 'trak');
    if (!aTrak) throw new Error('Tonspur ohne trak');
    const aInfo = trakInfo(ab, aTrak);
    const newId = Math.max(...vInfo.map(i => i.id)) + 1;

    // Audio-trak mit neuer Track-ID kopieren
    const aTrakCopy = slice(ab, aTrak).slice();
    w32(aTrakCopy, aInfo.idOff - aTrak.start, newId);

    // Audio-trex kopieren und umnummerieren
    const aMvex = child(ab, A.moov.box, 'mvex');
    const aTrex = children(ab, aMvex).find(x => x.type === 'trex' && u32(ab, x.start + x.hdr + 4) === aInfo.id);
    if (!aTrex) throw new Error('Kein trex für Tonspur');
    const aTrexCopy = slice(ab, aTrex).slice();
    w32(aTrexCopy, aTrex.hdr + 4, newId);

    // Neues moov
    const moovParts = [];
    for (const c of children(vb, V.moov.box)) {
      if (c.type === 'mvhd') {
        const m = slice(vb, c).slice();
        w32(m, m.length - 4, newId + 1); // next_track_ID
        moovParts.push(m);
      } else if (c.type === 'mvex') {
        const parts = children(vb, c).map(x => slice(vb, x));
        parts.push(aTrexCopy);
        moovParts.push({ mvex: makeBox('mvex', parts) });
      } else moovParts.push(slice(vb, c));
    }
    const mvexIdx = moovParts.findIndex(p => p.mvex);
    const mvexBox = moovParts.splice(mvexIdx, 1)[0].mvex;
    const lastTrak = moovParts.reduce((acc, p, i) => (type(p, 4) === 'trak' ? i : acc), -1);
    moovParts.splice(lastTrak + 1, 0, aTrakCopy);
    moovParts.push(mvexBox);
    const moov = makeBox('moov', moovParts);

    // Fragmente: Audio-IDs umschreiben, nach Zeit verschränken
    const vScales = {}; vInfo.forEach(i => { vScales[i.id] = i.timescale; });
    const aScales = { [aInfo.id]: aInfo.timescale };
    const list = [];
    V.frags.forEach((f, i) => list.push({ f, t: fragTime(f.moof.b, f.moof.box, vScales), o: 0, i }));
    A.frags.forEach((f, i) => {
      const b = f.moof.b;
      for (const traf of children(b, f.moof.box)) {
        if (traf.type !== 'traf') continue;
        const tfhd = child(b, traf, 'tfhd');
        if (u32(b, tfhd.start + tfhd.hdr + 4) === aInfo.id) w32(b, tfhd.start + tfhd.hdr + 4, newId);
      }
      list.push({ f, t: fragTime(b, f.moof.box, { [newId]: aInfo.timescale, ...aScales }), o: 1, i });
    });
    if (list.every(x => x.t !== null)) list.sort((x, y) => (x.t - y.t) || (x.o - y.o) || (x.i - y.i));

    const out = [];
    if (V.ftyp) out.push(slice(V.ftyp.b, V.ftyp.box));
    out.push(moov);
    let seq = 1;
    for (const { f } of list) {
      const b = f.moof.b;
      const mfhd = child(b, f.moof.box, 'mfhd');
      if (mfhd) w32(b, mfhd.start + mfhd.hdr + 4, seq++);
      out.push(slice(b, f.moof.box));
      for (const d of f.data) out.push(d);
    }
    return out; // Liste von Uint8Arrays → new Blob(out)
  }

  g.VDLMp4 = { merge, boxes };
})(typeof globalThis !== 'undefined' ? globalThis : this);
