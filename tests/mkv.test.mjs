import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {};
const { MkvDemuxer, readVint } = await import('../src/player/mkv/demuxer.js');
const { describeTrack, initSegment } = await import('../src/player/mkv/mp4.js');
const { TrackPacker } = await import('../src/player/mkv/mkv-source.js');

// ---- tiny EBML writer for a synthetic Matroska file
function vsize(n) {
  // 8-byte size vint
  const b = [0x01];
  for (let i = 6; i >= 0; i--) b.push(Math.floor(n / Math.pow(2, 8 * i)) & 255);
  return b;
}
function idBytes(id) {
  const out = [];
  while (id > 0) {
    out.unshift(id & 255);
    id = Math.floor(id / 256);
  }
  return out;
}
const el = (id, ...body) => {
  const data = body.flat(Infinity);
  return [...idBytes(id), ...vsize(data.length), ...data];
};
const uint = (id, v, len = 4) => el(id, Array.from({ length: len }, (_, i) => (v >> (8 * (len - 1 - i))) & 255));
const strEl = (id, s) => el(id, [...s].map((c) => c.charCodeAt(0)));

function simpleBlock(track, rel, key, payload) {
  return el(0xa3, [0x80 | track, (rel >> 8) & 255, rel & 255, key ? 0x80 : 0, ...payload]);
}

function buildFile() {
  const avcC = [1, 0x64, 0, 0x1e, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1e, 1, 0, 2, 0x68, 0xce];
  const asc = [0x11, 0x90]; // AAC LC 48 kHz stereo
  const tracks = el(
    0x1654ae6b,
    el(0xae, uint(0xd7, 1, 1), uint(0x83, 1, 1), strEl(0x86, 'V_MPEG4/ISO/AVC'), el(0x63a2, avcC), uint(0x23e383, 40000000), el(0xe0, uint(0xb0, 640, 2), uint(0xba, 360, 2))),
    el(0xae, uint(0xd7, 2, 1), uint(0x83, 2, 1), strEl(0x86, 'A_AAC'), el(0x63a2, asc), strEl(0x22b59c, 'ger'), el(0xe1, [0xb5, 0x88, 0x40, 0xe7, 0x70, 0, 0, 0, 0, 0], uint(0x9f, 2, 1))),
  );
  const info = el(0x1549a966, uint(0x2ad7b1, 1000000), [0x44, 0x89, 0x84, 0x46, 0x9c, 0x40, 0x00]); // duration 20000 ms (float32)
  // Video in decode order with B-frames: I0 P120 B40 B80 | I160 P280 B200 B240 (ms)
  const v = (t, key) => simpleBlock(1, t, key, [0, 0, 0, 1, key ? 0x65 : 0x41, t & 255]);
  const a = (t) => simpleBlock(2, t, true, [0x21, 0x10, t & 255]);
  const cluster1 = el(0x1f43b675, uint(0xe7, 0, 2), v(0, true), a(0), v(120, false), a(21), v(40, false), v(80, false), a(43), a(64));
  const cluster2 = el(0x1f43b675, uint(0xe7, 160, 2), v(0, true), a(5), v(120, false), v(40, false), v(80, false), a(26));
  const segment = el(0x18538067, info, tracks, cluster1, cluster2);
  const ebml = el(0x1a45dfa3, strEl(0x4282, 'matroska'));
  return new Uint8Array([...ebml, ...segment]);
}

test('vint decoding incl. unknown size', () => {
  assert.deepEqual(readVint(new Uint8Array([0x81]), 0, 1), { value: 1, length: 1 });
  assert.deepEqual(readVint(new Uint8Array([0x40, 0x02]), 0, 2), { value: 2, length: 2 });
  assert.equal(readVint(new Uint8Array([0xff]), 0, 1).value, -1);
  assert.equal(readVint(new Uint8Array([0x01, 255, 255, 255, 255, 255, 255, 255]), 0, 8).value, -1);
});

test('demuxer: header, frames, timestamps – independent of chunk size', () => {
  const file = buildFile();
  for (const chunk of [1, 7, 64, file.length]) {
    let header = null;
    const frames = [];
    const d = new MkvDemuxer({ onHeader: (h) => (header = h), onFrame: (f) => frames.push(f) });
    for (let i = 0; i < file.length; i += chunk) d.feed(file.subarray(i, i + chunk));
    assert.ok(header, 'header at chunk ' + chunk);
    assert.equal(header.tracks.length, 2);
    assert.equal(header.tracks[0].codecId, 'V_MPEG4/ISO/AVC');
    assert.equal(header.tracks[1].language, 'ger');
    assert.equal(header.info.duration, 20000);
    const video = frames.filter((f) => f.track === 1);
    assert.deepEqual(video.map((f) => f.timeNs / 1e6), [0, 120, 40, 80, 160, 280, 200, 240]);
    assert.deepEqual(video.map((f) => f.key), [true, false, false, false, true, false, false, false]);
    assert.equal(frames.filter((f) => f.track === 2).length, 6);
  }
});

test('codec strings and init segment', () => {
  const file = buildFile();
  let header = null;
  new MkvDemuxer({ onHeader: (h) => (header = h) }).feed(file);
  const vd = describeTrack(header.tracks[0]);
  const ad = describeTrack(header.tracks[1]);
  assert.equal(vd.codecString, 'avc1.64001E');
  assert.equal(ad.codecString, 'mp4a.40.2');
  assert.equal(ad.sampleRate, 48000);
  const init = initSegment(vd);
  const type = (o) => String.fromCharCode(...init.subarray(o + 4, o + 8));
  assert.equal(type(0), 'ftyp');
  const ftypLen = new DataView(init.buffer).getUint32(0);
  assert.equal(type(ftypLen), 'moov');
  assert.equal(ftypLen + new DataView(init.buffer).getUint32(ftypLen), init.length);
  assert.ok(describeTrack({ type: 2, codecId: 'A_DTS', audio: { sampleRate: 48000, channels: 6 } }).unsupported);
});

test('B-frames: decode times monotonic and never after presentation', () => {
  const file = buildFile();
  let header = null;
  const out = [];
  let packer = null;
  const d = new MkvDemuxer({
    onHeader: (h) => {
      header = h;
      packer = new TrackPacker(describeTrack(h.tracks[0]), 0);
    },
    onFrame: (f) => {
      if (f.track !== 1) return;
      const o = packer.push(f);
      if (o) out.push(o);
    },
  });
  d.feed(file);
  out.push(packer.flush());
  assert.ok(header);
  assert.equal(out.length, 2);
  // Parse trun of every fragment: dts = tfdt + Σ durations, pts = dts + cts
  const all = [];
  for (const frag of out) {
    const dv = new DataView(frag.buffer, frag.byteOffset);
    const find = (name) => {
      for (let i = 0; i < frag.length - 4; i++) if (String.fromCharCode(...frag.subarray(i, i + 4)) === name) return i - 4;
      return -1;
    };
    const tfdt = find('tfdt');
    let dts = dv.getUint32(tfdt + 12) * 4294967296 + dv.getUint32(tfdt + 16);
    const trun = find('trun');
    const n = dv.getUint32(trun + 12);
    for (let i = 0; i < n; i++) {
      const o = trun + 20 + i * 16;
      const dur = dv.getUint32(o);
      const cts = dv.getInt32(o + 12);
      all.push({ dts, pts: dts + cts });
      dts += dur;
    }
  }
  for (let i = 0; i < all.length; i++) {
    assert.ok(all[i].dts <= all[i].pts, 'dts <= pts');
    if (i) assert.ok(all[i].dts > all[i - 1].dts, 'monotonic dts');
  }
  // presentation order restored, shifted by the decode delay (40 ms for I P B B)
  assert.deepEqual(all.map((s) => s.pts / 90).sort((a, b) => a - b), [40, 80, 120, 160, 200, 240, 280, 320]);
});
