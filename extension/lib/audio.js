/* Ton aus Videos herausziehen – ohne Neukodierung.
 *  - fromTs:  MPEG-TS (HLS-Teile)  → AAC (ADTS), MP3, AC-3 oder E-AC-3
 *  - fromMp4: normales MP4/MOV     → M4A (nur die Tonspur)
 * Wirft einen Fehler, wenn das Format nicht passt. */
(function (g) {
  'use strict';

  // ---------------------------------------------------------------------------
  // MPEG-TS
  // ---------------------------------------------------------------------------
  const TS_AUDIO = { 0x0f: 'aac', 0x03: 'mp3', 0x04: 'mp3', 0x81: 'ac3', 0x87: 'eac3' };
  const TS_MIME = { aac: 'audio/aac', mp3: 'audio/mpeg', ac3: 'audio/ac3', eac3: 'audio/eac3' };

  function TsDemuxer() {
    this.pmtPid = -1;
    this.audioPid = -1;
    this.ext = null;
    this.out = [];
    this.pes = null;
    this.rest = null;
  }
  TsDemuxer.prototype.push = function (u8) {
    if (this.rest) {
      const merged = new Uint8Array(this.rest.length + u8.length);
      merged.set(this.rest); merged.set(u8, this.rest.length);
      u8 = merged; this.rest = null;
    }
    let i = 0;
    while (i + 188 <= u8.length) {
      if (u8[i] !== 0x47) { i++; continue; } // neu synchronisieren
      this.packet(u8.subarray(i, i + 188));
      i += 188;
    }
    if (i < u8.length) this.rest = u8.slice(i);
  };
  TsDemuxer.prototype.packet = function (p) {
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const pusi = (p[1] & 0x40) !== 0;
    const afc = (p[3] >> 4) & 3;
    let off = 4;
    if (afc & 2) off += 1 + p[4];
    if (!(afc & 1) || off >= 188) return;
    const pl = p.subarray(off);
    if (pid === 0 && pusi) {
      const t = 1 + pl[0];
      const len = ((pl[t + 1] & 0x0f) << 8) | pl[t + 2];
      for (let j = t + 8; j + 4 <= t + 3 + len - 4; j += 4) {
        const prog = (pl[j] << 8) | pl[j + 1];
        if (prog !== 0) { this.pmtPid = ((pl[j + 2] & 0x1f) << 8) | pl[j + 3]; break; }
      }
    } else if (pid === this.pmtPid && pusi && this.audioPid < 0) {
      const t = 1 + pl[0];
      const len = ((pl[t + 1] & 0x0f) << 8) | pl[t + 2];
      const pil = ((pl[t + 10] & 0x0f) << 8) | pl[t + 11];
      let j = t + 12 + pil;
      const end = t + 3 + len - 4;
      while (j + 5 <= end) {
        const type = pl[j];
        const epid = ((pl[j + 1] & 0x1f) << 8) | pl[j + 2];
        const eil = ((pl[j + 3] & 0x0f) << 8) | pl[j + 4];
        if (TS_AUDIO[type]) { this.audioPid = epid; this.ext = TS_AUDIO[type]; break; }
        j += 5 + eil;
      }
    } else if (pid === this.audioPid) {
      if (pusi) { this.flush(); this.pes = []; }
      if (this.pes) this.pes.push(pl.slice());
    }
  };
  TsDemuxer.prototype.flush = function () {
    if (!this.pes || !this.pes.length) return;
    const len = this.pes.reduce((s, x) => s + x.length, 0);
    const b = new Uint8Array(len);
    let o = 0;
    for (const x of this.pes) { b.set(x, o); o += x.length; }
    this.pes = null;
    if (b.length < 9 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1) return;
    const data = b.subarray(9 + b[8]);
    if (data.length) this.out.push(data);
  };

  /** blobs: Liste von Blobs/Uint8Arrays mit TS-Daten in richtiger Reihenfolge */
  async function fromTs(blobs) {
    const d = new TsDemuxer();
    for (const b of blobs) {
      const u8 = b instanceof Uint8Array ? b : new Uint8Array(await b.arrayBuffer());
      d.push(u8);
    }
    d.flush();
    if (d.audioPid < 0) throw new Error('Keine Tonspur im Stream gefunden');
    if (!d.out.length) throw new Error('Tonspur ist leer');
    return { chunks: d.out, ext: d.ext, mime: TS_MIME[d.ext] || 'application/octet-stream' };
  }

  // ---------------------------------------------------------------------------
  // MP4 / MOV (nicht fragmentiert)
  // ---------------------------------------------------------------------------
  const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const w32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
  const typ = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  function boxes(b, start, end) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o), hdr = 8;
      const t = typ(b, o + 4);
      if (size === 1) { size = u32(b, o + 8) * 4294967296 + u32(b, o + 12); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) throw new Error('Ungültige MP4-Struktur');
      out.push({ type: t, start: o, hdr, end: o + size });
      o += size;
    }
    return out;
  }
  const kids = (b, box) => boxes(b, box.start + box.hdr, box.end);
  const kid = (b, box, t) => kids(b, box).find(x => x.type === t);
  function mkBox(t, parts) {
    const len = 8 + parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    w32(out, 0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);

  function fromMp4(u8) {
    const top = boxes(u8, 0, u8.length);
    const moov = top.find(x => x.type === 'moov');
    if (!moov) throw new Error('Kein MP4-Inhaltsverzeichnis (moov) gefunden');
    if (kid(u8, moov, 'mvex')) throw new Error('Fragmentiertes MP4 wird für „Nur Ton“ nicht unterstützt');
    const trak = kids(u8, moov).find(t => {
      if (t.type !== 'trak') return false;
      const mdia = kid(u8, t, 'mdia');
      const hdlr = mdia && kid(u8, mdia, 'hdlr');
      return hdlr && typ(u8, hdlr.start + hdlr.hdr + 8) === 'soun';
    });
    if (!trak) throw new Error('Keine Tonspur im Video gefunden');
    const stbl = kid(u8, kid(u8, kid(u8, trak, 'mdia'), 'minf'), 'stbl');

    // Chunks der Tonspur ermitteln (Position + Größe)
    const stsz = kid(u8, stbl, 'stsz'), stsc = kid(u8, stbl, 'stsc');
    const stco = kid(u8, stbl, 'stco') || kid(u8, stbl, 'co64');
    if (!stsz || !stsc || !stco) throw new Error('Unvollständige Tonspur');
    const p0 = stsz.start + stsz.hdr;
    const fixed = u32(u8, p0 + 4), nSamples = u32(u8, p0 + 8);
    const sampleSize = i => (fixed || u32(u8, p0 + 12 + i * 4));
    const pc = stco.start + stco.hdr;
    const nChunks = u32(u8, pc + 4);
    const is64 = stco.type === 'co64';
    const offs = [];
    for (let i = 0; i < nChunks; i++) {
      offs.push(is64 ? u32(u8, pc + 8 + i * 8) * 4294967296 + u32(u8, pc + 12 + i * 8) : u32(u8, pc + 8 + i * 4));
    }
    const ps = stsc.start + stsc.hdr;
    const nE = u32(u8, ps + 4);
    const ent = [];
    for (let i = 0; i < nE; i++) ent.push({ first: u32(u8, ps + 8 + i * 12), per: u32(u8, ps + 12 + i * 12) });
    const sizes = [];
    let s = 0;
    for (let c = 0; c < nChunks; c++) {
      let per = 0;
      for (const e of ent) if (e.first <= c + 1) per = e.per;
      let sz = 0;
      for (let k = 0; k < per && s < nSamples; k++, s++) sz += sampleSize(s);
      sizes.push(sz);
    }
    const dataLen = sizes.reduce((a, b) => a + b, 0);
    const use64 = dataLen > 0xfffffff0;

    // Neues stco/co64 (Platzhalter), Rest der Box-Struktur kopieren
    const newStco = new Uint8Array(16 + nChunks * (use64 ? 8 : 4));
    w32(newStco, 0, newStco.length);
    newStco.set([...(use64 ? 'co64' : 'stco')].map(c => c.charCodeAt(0)), 4);
    w32(newStco, 12, nChunks);
    const rebuild = box => {
      if (box.type === 'stco' || box.type === 'co64') return newStco;
      if (!CONTAINERS.has(box.type)) return u8.subarray(box.start, box.end);
      return mkBox(box.type, kids(u8, box).map(rebuild));
    };
    const mvhd = kid(u8, moov, 'mvhd');
    const newMoov = mkBox('moov', [u8.subarray(mvhd.start, mvhd.end), rebuild(trak)]);
    const ftyp = new Uint8Array([0, 0, 0, 28, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 2, 0, 77, 52, 65, 32, 109, 112, 52, 50, 105, 115, 111, 109]);
    const mdatHdr = new Uint8Array(use64 ? 16 : 8);
    if (use64) { w32(mdatHdr, 0, 1); mdatHdr.set([109, 100, 97, 116], 4); w32(mdatHdr, 8, Math.floor((dataLen + 16) / 4294967296)); w32(mdatHdr, 12, (dataLen + 16) >>> 0); }
    else { w32(mdatHdr, 0, dataLen + 8); mdatHdr.set([109, 100, 97, 116], 4); }

    // Offsets eintragen: Daten beginnen nach ftyp + moov + mdat-Kopf
    let pos = ftyp.length + newMoov.length + mdatHdr.length;
    const stcoPos = (() => { // Lage von newStco innerhalb newMoov suchen
      for (let i = 0; i < newMoov.length - 4; i++) {
        if (newMoov[i] === newStco[4] && newMoov[i + 1] === newStco[5] && newMoov[i + 2] === newStco[6] && newMoov[i + 3] === newStco[7] &&
          u32(newMoov, i - 4) === newStco.length) return i - 4;
      }
      return -1;
    })();
    if (stcoPos < 0) throw new Error('Interner Fehler beim Umbau');
    const chunks = [];
    for (let c = 0; c < nChunks; c++) {
      if (use64) { w32(newMoov, stcoPos + 16 + c * 8, Math.floor(pos / 4294967296)); w32(newMoov, stcoPos + 20 + c * 8, pos >>> 0); }
      else w32(newMoov, stcoPos + 16 + c * 4, pos);
      chunks.push(u8.subarray(offs[c], offs[c] + sizes[c]));
      pos += sizes[c];
    }
    return [ftyp, newMoov, mdatHdr, ...chunks];
  }

  g.VDLAudio = { fromTs, fromMp4 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
