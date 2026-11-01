/**
 * Fragmented-MP4 writer for the MKV decoder: wraps the unchanged Matroska frames into ISO-BMFF init segments
 * and moof/mdat fragments (one track per SourceBuffer). Nothing is re-encoded – the bitstream stays bit-identical,
 * only the container changes, so the browser's own (hardware) decoder does the actual decoding.
 *
 * Video: H.264/AVC, H.265/HEVC, AV1, VP9.  Audio: AAC, Opus, FLAC, AC-3, E-AC-3, MP3.
 * Everything else (DTS, TrueHD, Vorbis, PCM …) is reported as unsupported – the player then fetches only the
 * audio converted from the server (video still plays directly).
 */

// ---------------------------------------------------------------- byte helpers

function u8(...a) {
  return new Uint8Array(a);
}
function u16(v) {
  return u8((v >> 8) & 255, v & 255);
}
function u32(v) {
  return u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}
function u64(v) {
  const hi = Math.floor(v / 4294967296);
  const lo = v - hi * 4294967296;
  return concat(u32(hi), u32(lo));
}
function str(s) {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}
export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function box(type, ...payload) {
  const body = concat(...payload);
  return concat(u32(body.length + 8), str(type), body);
}
function fullbox(type, version, flags, ...payload) {
  return box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
}
const hex2 = (n) => (n < 16 ? '0' : '') + n.toString(16).toUpperCase();

// ---------------------------------------------------------------- codec detection

const SR_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function aacConfigFromCodecId(codecId, sampleRate, channels) {
  // Old Matroska IDs without CodecPrivate: A_AAC/MPEG4/LC, A_AAC/MPEG2/LC/SBR …
  let aot = 2;
  if (/MAIN/.test(codecId)) aot = 1;
  else if (/SSR/.test(codecId)) aot = 3;
  else if (/LTP/.test(codecId)) aot = 4;
  let idx = SR_TABLE.indexOf(Math.round(sampleRate));
  if (idx < 0) idx = 4;
  return u8((aot << 3) | (idx >> 1), ((idx & 1) << 7) | ((channels & 15) << 3));
}

function aacInfo(asc) {
  const aot = asc[0] >> 3;
  const idx = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  const rate = idx === 15 ? ((asc[1] & 0x7f) << 17) | (asc[2] << 9) | (asc[3] << 1) | (asc[4] >> 7) : SR_TABLE[idx] || 48000;
  return { aot: aot === 31 ? 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5)) : aot, rate };
}

function avcCodecString(avcC) {
  return 'avc1.' + hex2(avcC[1]) + hex2(avcC[2]) + hex2(avcC[3]);
}

function hevcCodecString(h) {
  const space = ['', 'A', 'B', 'C'][h[1] >> 6];
  const tier = (h[1] >> 5) & 1 ? 'H' : 'L';
  const profile = h[1] & 31;
  let compat = ((h[2] << 24) | (h[3] << 16) | (h[4] << 8) | h[5]) >>> 0;
  let rev = 0;
  for (let i = 0; i < 32; i++) {
    rev = (rev << 1) | (compat & 1);
    compat >>>= 1;
  }
  const cons = [h[6], h[7], h[8], h[9], h[10], h[11]];
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return ['hvc1', space + profile, (rev >>> 0).toString(16).toUpperCase(), tier + h[12]].concat(cons.map((c) => c.toString(16).toUpperCase())).join('.');
}

function av1CodecString(c) {
  const profile = c[1] >> 5;
  const level = c[1] & 31;
  const tier = c[2] >> 7 ? 'H' : 'M';
  const high = (c[2] >> 6) & 1;
  const twelve = (c[2] >> 5) & 1;
  const depth = profile === 2 && high ? (twelve ? 12 : 10) : high ? 10 : 8;
  return `av01.${profile}.${level < 10 ? '0' : ''}${level}${tier}.${depth < 10 ? '0' : ''}${depth}`;
}

/** First bytes of an AC-3 frame → dac3 payload. */
function ac3Specific(f) {
  if (!f || f.length < 8 || f[0] !== 0x0b || f[1] !== 0x77) return null;
  const fscod = f[4] >> 6;
  const frmsizecod = f[4] & 0x3f;
  const bsid = f[5] >> 3;
  const bsmod = f[5] & 7;
  // bit reader from byte 6
  let bit = 48;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((f[bit >> 3] >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  const acmod = read(3);
  if (acmod & 1 && acmod !== 1) read(2);
  if (acmod & 4) read(2);
  if (acmod === 2) read(2);
  const lfeon = read(1);
  const rate = frmsizecod >> 1;
  const b0 = (fscod << 6) | (bsid << 1) | (bsmod >> 2);
  const b1 = ((bsmod & 3) << 6) | (acmod << 3) | (lfeon << 2) | (rate >> 3);
  const b2 = (rate & 7) << 5;
  const channels = [2, 1, 2, 3, 3, 4, 4, 5][acmod] + lfeon;
  return { box: u8(b0, b1, b2), sampleRate: [48000, 44100, 32000][fscod] || 48000, channels };
}

/** First bytes of an E-AC-3 frame → dec3 payload. */
function eac3Specific(f) {
  if (!f || f.length < 8 || f[0] !== 0x0b || f[1] !== 0x77) return null;
  const frmsiz = ((f[2] & 7) << 8) | f[3];
  const fscod = f[4] >> 6;
  const numblkscod = (f[4] >> 4) & 3;
  const acmod = (f[4] >> 1) & 7;
  const lfeon = f[4] & 1;
  const bsid = f[5] >> 3;
  const sampleRate = fscod === 3 ? [24000, 22050, 16000][numblkscod] || 24000 : [48000, 44100, 32000][fscod];
  const blocks = fscod === 3 ? 6 : [1, 2, 3, 6][numblkscod];
  const bytes = (frmsiz + 1) * 2;
  const kbps = Math.round((bytes * 8 * sampleRate) / (blocks * 256) / 1000);
  const fs = fscod === 3 ? 0 : fscod;
  // data_rate(13) num_ind_sub(3)=0 | fscod(2) bsid(5) reserved(1) asvc(1) bsmod(3) acmod(3) lfeon(1) reserved(3) num_dep_sub(4) reserved(1)
  const b = new Uint8Array(5);
  b[0] = (kbps >> 5) & 255;
  b[1] = ((kbps & 31) << 3) | 0;
  b[2] = (fs << 6) | (bsid << 1) | 0;
  b[3] = (0 << 7) | (0 << 4) | (acmod << 1) | lfeon;
  b[4] = 0;
  const channels = [2, 1, 2, 3, 3, 4, 4, 5][acmod] + lfeon;
  return { box: b, sampleRate, channels, samples: blocks * 256 };
}

function mp3Info(f) {
  if (!f || f.length < 4 || f[0] !== 0xff || (f[1] & 0xe0) !== 0xe0) return null;
  const version = (f[1] >> 3) & 3; // 3 = MPEG1
  const layer = (f[1] >> 1) & 3; // 1 = layer III
  const srIdx = (f[2] >> 2) & 3;
  const base = [44100, 48000, 32000][srIdx] || 44100;
  const sampleRate = version === 3 ? base : version === 2 ? base / 2 : base / 4;
  const samples = layer === 3 ? 384 : layer === 1 && version !== 3 ? 576 : 1152;
  const channels = (f[3] >> 6) === 3 ? 1 : 2;
  return { sampleRate, samples, channels };
}

/** Samples in one Opus packet (48 kHz). */
function opusSamples(f) {
  if (!f || !f.length) return 960;
  const toc = f[0];
  const config = toc >> 3;
  let ms;
  if (config < 12) ms = [10, 20, 40, 60][config & 3];
  else if (config < 16) ms = [10, 20][config & 1];
  else ms = [2.5, 5, 10, 20][config & 3];
  const c = toc & 3;
  const frames = c === 0 ? 1 : c === 3 ? (f[1] || 1) & 0x3f : 2;
  return Math.round(ms * 48 * frames);
}

function flacSamples(f, streamInfoBlock) {
  if (f && f.length > 4 && f[0] === 0xff && (f[1] & 0xfe) === 0xf8) {
    const bs = f[2] >> 4;
    if (bs === 1) return 192;
    if (bs >= 2 && bs <= 5) return 576 << (bs - 2);
    if (bs >= 8) return 256 << (bs - 8);
    // 6/7: value at the end of the header after the UTF-8 coded frame number
    let p = 4;
    const lead = f[p];
    let extra = 0;
    if (lead >= 0xfe) extra = 6;
    else if (lead >= 0xfc) extra = 5;
    else if (lead >= 0xf8) extra = 4;
    else if (lead >= 0xf0) extra = 3;
    else if (lead >= 0xe0) extra = 2;
    else if (lead >= 0xc0) extra = 1;
    p += 1 + extra;
    if (bs === 6) return f[p] + 1;
    return ((f[p] << 8) | f[p + 1]) + 1;
  }
  if (streamInfoBlock) return (streamInfoBlock[2] << 8) | streamInfoBlock[3];
  return 0;
}

function opusHeadToDops(head) {
  // OpusHead (little endian) → dOps (big endian)
  if (!head || head.length < 19) return null;
  const channels = head[9];
  const preSkip = head[10] | (head[11] << 8);
  const rate = (head[12] | (head[13] << 8) | (head[14] << 16) | (head[15] << 24)) >>> 0;
  const gain = head[16] | (head[17] << 8);
  const family = head[18];
  let tail = new Uint8Array(0);
  if (family !== 0 && head.length >= 21 + channels) tail = head.slice(19, 21 + channels);
  return { box: concat(u8(0, channels), u16(preSkip), u32(rate), u16(gain), u8(family), tail), channels };
}

function flacStreamInfo(priv) {
  // CodecPrivate = "fLaC" + metadata blocks; dfLa wants the blocks with the last-block flag set.
  if (!priv || priv.length < 42) return null;
  let p = priv[0] === 0x66 && priv[1] === 0x4c && priv[2] === 0x61 && priv[3] === 0x43 ? 4 : 0;
  const type = priv[p] & 0x7f;
  const len = (priv[p + 1] << 16) | (priv[p + 2] << 8) | priv[p + 3];
  if (type !== 0 || len < 34) return null;
  const block = priv.slice(p, p + 4 + len);
  block[0] = 0x80; // last block, STREAMINFO
  const si = block.subarray(4);
  const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
  const channels = ((si[12] >> 1) & 7) + 1;
  return { box: block, sampleRate, channels, streamInfo: si };
}

/**
 * Describes a Matroska track for MSE. firstFrame is needed for AC-3/E-AC-3/MP3 (config comes from the bitstream).
 * → { kind, codec, codecString, mime, timescale, ... } | { unsupported: 'reason' } | { needsFrame: true }
 */
export function describeTrack(t, firstFrame) {
  const id = t.codecId || '';
  if (t.compressed) return { unsupported: 'komprimierte Spur' };
  if (t.type === 1 && t.video) {
    const v = t.video;
    const base = { kind: 'video', timescale: 90000, width: v.width, height: v.height, displayWidth: v.displayWidth || v.width, displayHeight: v.displayHeight || v.height };
    if (id === 'V_MPEG4/ISO/AVC' && t.codecPrivate && t.codecPrivate.length > 6) return { ...base, codec: 'avc', entry: 'avc1', configBox: box('avcC', t.codecPrivate), codecString: avcCodecString(t.codecPrivate) };
    if (id === 'V_MPEGH/ISO/HEVC' && t.codecPrivate && t.codecPrivate.length > 22) return { ...base, codec: 'hevc', entry: 'hvc1', configBox: box('hvcC', t.codecPrivate), codecString: hevcCodecString(t.codecPrivate) };
    if (id === 'V_AV1' && t.codecPrivate && t.codecPrivate.length >= 4) return { ...base, codec: 'av1', entry: 'av01', configBox: box('av1C', t.codecPrivate), codecString: av1CodecString(t.codecPrivate) };
    if (id === 'V_VP9') {
      const depth = v.bitDepth || 8;
      const profile = depth > 8 ? 2 : 0;
      const vpcc = fullbox('vpcC', 1, 0, u8(profile, 40, (depth << 4) | (1 << 1) | 0, 1, 1, 1), u16(0));
      return { ...base, codec: 'vp9', entry: 'vp09', configBox: vpcc, codecString: `vp09.${profile < 10 ? '0' : ''}${profile}.40.${depth < 10 ? '0' : ''}${depth}` };
    }
    return { unsupported: id.replace(/^V_/, '') || 'Video' };
  }
  if (t.type === 2 && t.audio) {
    const a = t.audio;
    const rate = Math.round(a.sampleRate) || 48000;
    const ch = a.channels || 2;
    if (id.startsWith('A_AAC')) {
      const asc = t.codecPrivate && t.codecPrivate.length >= 2 ? t.codecPrivate : aacConfigFromCodecId(id, rate, ch);
      const info = aacInfo(asc);
      return { kind: 'audio', codec: 'aac', entry: 'mp4a', configBox: esds(0x40, asc), codecString: 'mp4a.40.' + info.aot, timescale: info.rate || rate, sampleRate: info.rate || rate, channels: ch, frameSamples: 1024 };
    }
    if (id === 'A_OPUS') {
      const d = opusHeadToDops(t.codecPrivate);
      if (!d) return { unsupported: 'Opus ohne Kopfdaten' };
      return { kind: 'audio', codec: 'opus', entry: 'Opus', configBox: box('dOps', d.box), codecString: 'opus', timescale: 48000, sampleRate: 48000, channels: d.channels, samplesOf: opusSamples };
    }
    if (id === 'A_FLAC') {
      const s = flacStreamInfo(t.codecPrivate);
      if (!s) return { unsupported: 'FLAC ohne Kopfdaten' };
      return { kind: 'audio', codec: 'flac', entry: 'fLaC', configBox: fullbox('dfLa', 0, 0, s.box), codecString: 'flac', timescale: s.sampleRate, sampleRate: s.sampleRate, channels: s.channels, samplesOf: (f) => flacSamples(f, s.streamInfo) };
    }
    if (id === 'A_AC3') {
      if (!firstFrame) return { needsFrame: true };
      const s = ac3Specific(firstFrame);
      if (!s) return { unsupported: 'AC-3' };
      return { kind: 'audio', codec: 'ac3', entry: 'ac-3', configBox: box('dac3', s.box), codecString: 'ac-3', timescale: s.sampleRate, sampleRate: s.sampleRate, channels: s.channels, frameSamples: 1536 };
    }
    if (id === 'A_EAC3') {
      if (!firstFrame) return { needsFrame: true };
      const s = eac3Specific(firstFrame);
      if (!s) return { unsupported: 'E-AC-3' };
      return { kind: 'audio', codec: 'eac3', entry: 'ec-3', configBox: box('dec3', s.box), codecString: 'ec-3', timescale: s.sampleRate, sampleRate: s.sampleRate, channels: s.channels, frameSamples: s.samples };
    }
    if (id === 'A_MPEG/L3' || id === 'A_MPEG/L2') {
      if (!firstFrame) return { needsFrame: true };
      const s = mp3Info(firstFrame);
      if (!s) return { unsupported: 'MP3' };
      return { kind: 'audio', codec: 'mp3', entry: 'mp4a', configBox: esds(0x6b, null), codecString: 'mp4a.6B', altCodecStrings: ['mp3', 'mp4a.69'], timescale: s.sampleRate, sampleRate: s.sampleRate, channels: s.channels, frameSamples: s.samples };
    }
    const names = { A_DTS: 'DTS', 'A_DTS/EXPRESS': 'DTS Express', 'A_DTS/LOSSLESS': 'DTS-HD MA', A_TRUEHD: 'Dolby TrueHD', A_VORBIS: 'Vorbis', 'A_PCM/INT/LIT': 'PCM', 'A_PCM/INT/BIG': 'PCM', 'A_PCM/FLOAT/IEEE': 'PCM', A_ALAC: 'ALAC', A_MLP: 'MLP' };
    return { unsupported: names[id] || id.replace(/^A_/, '') || 'Audio' };
  }
  return { unsupported: 'keine Video-/Tonspur' };
}

/** Is a described track playable through MSE on this device? Sets desc.mime. */
export function mseSupports(desc) {
  const MS = window.ManagedMediaSource || window.MediaSource || window.WebKitMediaSource;
  if (!MS || !desc || desc.unsupported) return false;
  const list = [desc.codecString].concat(desc.altCodecStrings || []);
  for (const c of list) {
    const mime = `${desc.kind}/mp4; codecs="${c}"`;
    try {
      if (MS.isTypeSupported(mime)) {
        desc.mime = mime;
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

function descriptor(tag, body) {
  const n = body.length;
  return concat(u8(tag, 0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f), body);
}

function esds(objectType, dsi) {
  const dec = concat(u8(objectType, 0x15, 0, 0, 0), u32(0), u32(0), dsi ? descriptor(5, dsi) : new Uint8Array(0));
  const es = concat(u16(1), u8(0), descriptor(4, dec), descriptor(6, u8(2)));
  return fullbox('esds', 0, 0, descriptor(3, es));
}

// ---------------------------------------------------------------- init segment

const MATRIX = concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

function sampleEntry(d) {
  if (d.kind === 'video') {
    const w = d.width || 1920;
    const hgt = d.height || 1080;
    const extra = [];
    if (d.displayWidth && d.displayHeight && d.displayWidth * hgt !== d.displayHeight * w) {
      // pixel aspect ratio from the display size
      extra.push(box('pasp', u32(d.displayWidth * hgt), u32(d.displayHeight * w)));
    }
    return box(
      d.entry,
      new Uint8Array(6),
      u16(1),
      new Uint8Array(16),
      u16(w),
      u16(hgt),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1),
      new Uint8Array(32),
      u16(0x18),
      u16(0xffff),
      d.configBox,
      ...extra,
    );
  }
  const rate = d.sampleRate > 65535 ? 0 : d.sampleRate;
  return box(d.entry, new Uint8Array(6), u16(1), new Uint8Array(8), u16(d.channels || 2), u16(16), u16(0), u16(0), u32(rate * 65536), d.configBox);
}

export function initSegment(d) {
  const video = d.kind === 'video';
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso6'), str('mp41'), str(video ? d.entry : 'mp41'));
  const mvhd = fullbox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x10000), u16(0x100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2));
  const tkhd = fullbox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), new Uint8Array(8), u16(0), u16(0), u16(video ? 0 : 0x100), u16(0), MATRIX, u32((video ? d.displayWidth || d.width : 0) * 65536), u32((video ? d.displayHeight || d.height : 0) * 65536));
  const mdhd = fullbox('mdhd', 0, 0, u32(0), u32(0), u32(d.timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullbox('hdlr', 0, 0, u32(0), str(video ? 'vide' : 'soun'), new Uint8Array(12), str(video ? 'VideoHandler' : 'SoundHandler'), u8(0));
  const mediaHeader = video ? fullbox('vmhd', 0, 1, new Uint8Array(8)) : fullbox('smhd', 0, 0, u32(0));
  const dinf = box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1)));
  const stbl = box(
    'stbl',
    fullbox('stsd', 0, 0, u32(1), sampleEntry(d)),
    fullbox('stts', 0, 0, u32(0)),
    fullbox('stsc', 0, 0, u32(0)),
    fullbox('stsz', 0, 0, u32(0), u32(0)),
    fullbox('stco', 0, 0, u32(0)),
  );
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', mediaHeader, dinf, stbl)));
  const mvex = box('mvex', fullbox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  return concat(ftyp, box('moov', mvhd, trak, mvex));
}

// ---------------------------------------------------------------- fragments

/**
 * samples: [{ data, duration, cts, key }] (time in the track timescale), baseDts: decode time of the first sample.
 */
export function fragment(seq, baseDts, samples) {
  const n = samples.length;
  const flags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;
  const trunBody = new Uint8Array(8 + n * 16);
  const dv = new DataView(trunBody.buffer);
  dv.setUint32(0, n);
  // data offset at [4] – filled below
  let mdatSize = 0;
  samples.forEach((s, i) => {
    const o = 8 + i * 16;
    dv.setUint32(o, Math.max(0, Math.round(s.duration)));
    dv.setUint32(o + 4, s.data.length);
    dv.setUint32(o + 8, s.key ? 0x02000000 : 0x01010000);
    dv.setInt32(o + 12, Math.round(s.cts || 0));
    mdatSize += s.data.length;
  });
  const mfhd = fullbox('mfhd', 0, 0, u32(seq));
  const tfhd = fullbox('tfhd', 0, 0x020000, u32(1));
  const tfdt = fullbox('tfdt', 1, 0, u64(Math.max(0, Math.round(baseDts))));
  const trunLen = 12 + trunBody.length;
  const trafLen = 8 + tfhd.length + tfdt.length + trunLen;
  const moofLen = 8 + mfhd.length + trafLen;
  dv.setInt32(4, moofLen + 8);
  const trun = fullbox('trun', 1, flags, trunBody);
  const moof = box('moof', mfhd, box('traf', tfhd, tfdt, trun));
  const mdat = new Uint8Array(8 + mdatSize);
  new DataView(mdat.buffer).setUint32(0, mdat.length);
  mdat.set(str('mdat'), 4);
  let o = 8;
  for (const s of samples) {
    mdat.set(s.data, o);
    o += s.data.length;
  }
  return concat(moof, mdat);
}

/** Samples per audio frame, if the codec defines it. */
export function audioFrameSamples(desc, data) {
  if (desc.frameSamples) return desc.frameSamples;
  if (desc.samplesOf) return desc.samplesOf(data) || 0;
  return 0;
}
