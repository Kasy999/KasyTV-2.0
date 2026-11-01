/**
 * Streaming Matroska (MKV / WebM) demuxer – reads the file piece by piece as it arrives over the network and
 * hands out the compressed frames of each track. Nothing is decoded or converted here: the frames go unchanged
 * into fragmented MP4 (mp4.js), which the browser's own hardware decoder plays via Media Source Extensions.
 *
 *   const d = new MkvDemuxer({ onHeader, onFrame, onCluster });
 *   d.feed(uint8array)            // any chunk size, in file order
 *   d.restartAt(byteOffset)       // after a seek: continue at a cluster (or anywhere with resync: true)
 *
 * Supports: EBML header, SeekHead, Info, Tracks (incl. header-stripping compression), Cues, Clusters with
 * SimpleBlock / BlockGroup, Xiph / EBML / fixed lacing, unknown-size segments and clusters (live muxers).
 */

export const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  DefaultDuration: 0x23e383,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  FlagEnabled: 0xb9,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Name: 0x536e,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,
  Colour: 0x55b0,
  BitsPerChannel: 0x55b2,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  OutputSamplingFrequency: 0x78b5,
  Channels: 0x9f,
  BitDepth: 0x6264,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
};

const LEVEL1 = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cues, ID.Cluster, ID.Tags, ID.Chapters, ID.Attachments, 0xec /* Void */]);
const MAX_HEADER_ELEMENT = 32 * 1024 * 1024;

// ---------------------------------------------------------------- EBML primitives

/** Reads an element ID (marker bits kept). → { value, length } or null if incomplete / invalid. */
export function readId(buf, pos, end) {
  if (pos >= end) return null;
  const first = buf[pos];
  let len = 1;
  if (first & 0x80) len = 1;
  else if (first & 0x40) len = 2;
  else if (first & 0x20) len = 3;
  else if (first & 0x10) len = 4;
  else return { value: -1, length: 1 }; // invalid
  if (pos + len > end) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
  return { value: v, length: len };
}

/** Reads a size / number vint (marker bit removed). value === -1 → "unknown size". */
export function readVint(buf, pos, end) {
  if (pos >= end) return null;
  const first = buf[pos];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) {
    len++;
    mask >>= 1;
  }
  if (len > 8) return { value: -2, length: 1 }; // invalid
  if (pos + len > end) return null;
  let v = first & (mask - 1);
  let allOnes = v === mask - 1;
  for (let i = 1; i < len; i++) {
    const b = buf[pos + i];
    if (b !== 0xff) allOnes = false;
    v = v * 256 + b;
  }
  return { value: allOnes ? -1 : v, length: len };
}

function readUint(buf, pos, size) {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
  return v;
}

function readSint(buf, pos, size) {
  if (!size) return 0;
  let v = readUint(buf, pos, size);
  const max = Math.pow(2, 8 * size);
  if (v >= max / 2) v -= max;
  return v;
}

function readFloat(buf, pos, size) {
  const dv = new DataView(buf.buffer, buf.byteOffset + pos, size);
  if (size === 4) return dv.getFloat32(0);
  if (size === 8) return dv.getFloat64(0);
  return 0;
}

function readString(buf, pos, size) {
  let s = '';
  for (let i = 0; i < size; i++) {
    const c = buf[pos + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  try {
    return decodeURIComponent(escape(s)); // UTF-8
  } catch {
    return s;
  }
}

/** Iterates the children of a fully loaded master element. */
function* children(buf, pos, end) {
  while (pos < end) {
    const id = readId(buf, pos, end);
    if (!id || id.value < 0) return;
    const size = readVint(buf, pos + id.length, end);
    if (!size || size.value < 0) return;
    const start = pos + id.length + size.length;
    const stop = Math.min(end, start + size.value);
    yield { id: id.value, start, size: stop - start };
    pos = stop;
  }
}

// ---------------------------------------------------------------- header parsing

function parseInfo(buf, pos, end) {
  const info = { timecodeScale: 1000000, duration: 0 };
  for (const c of children(buf, pos, end)) {
    if (c.id === ID.TimecodeScale) info.timecodeScale = readUint(buf, c.start, c.size) || 1000000;
    else if (c.id === ID.Duration) info.duration = readFloat(buf, c.start, c.size);
  }
  return info;
}

function parseSeekHead(buf, pos, end) {
  const seeks = {};
  for (const c of children(buf, pos, end)) {
    if (c.id !== ID.Seek) continue;
    let id = 0;
    let p = -1;
    for (const s of children(buf, c.start, c.start + c.size)) {
      if (s.id === ID.SeekID) id = readUint(buf, s.start, s.size);
      else if (s.id === ID.SeekPosition) p = readUint(buf, s.start, s.size);
    }
    if (id && p >= 0 && seeks[id] === undefined) seeks[id] = p;
  }
  return seeks;
}

function parseTrack(buf, pos, end) {
  const t = { number: 0, type: 0, codecId: '', codecPrivate: null, defaultDuration: 0, language: 'und', name: '', isDefault: true, forced: false, enabled: true, codecDelay: 0, seekPreRoll: 0, video: null, audio: null, stripHeader: null, compressed: false };
  for (const c of children(buf, pos, end)) {
    switch (c.id) {
      case ID.TrackNumber:
        t.number = readUint(buf, c.start, c.size);
        break;
      case ID.TrackType:
        t.type = readUint(buf, c.start, c.size);
        break;
      case ID.CodecID:
        t.codecId = readString(buf, c.start, c.size);
        break;
      case ID.CodecPrivate:
        t.codecPrivate = buf.slice(c.start, c.start + c.size);
        break;
      case ID.DefaultDuration:
        t.defaultDuration = readUint(buf, c.start, c.size);
        break;
      case ID.CodecDelay:
        t.codecDelay = readUint(buf, c.start, c.size);
        break;
      case ID.SeekPreRoll:
        t.seekPreRoll = readUint(buf, c.start, c.size);
        break;
      case ID.Language:
        t.language = readString(buf, c.start, c.size) || 'und';
        break;
      case ID.LanguageBCP47:
        t.language = readString(buf, c.start, c.size) || t.language;
        break;
      case ID.Name:
        t.name = readString(buf, c.start, c.size);
        break;
      case ID.FlagDefault:
        t.isDefault = !!readUint(buf, c.start, c.size);
        break;
      case ID.FlagForced:
        t.forced = !!readUint(buf, c.start, c.size);
        break;
      case ID.FlagEnabled:
        t.enabled = !!readUint(buf, c.start, c.size);
        break;
      case ID.Video: {
        const v = { width: 0, height: 0, displayWidth: 0, displayHeight: 0, bitDepth: 8 };
        for (const d of children(buf, c.start, c.start + c.size)) {
          if (d.id === ID.PixelWidth) v.width = readUint(buf, d.start, d.size);
          else if (d.id === ID.PixelHeight) v.height = readUint(buf, d.start, d.size);
          else if (d.id === ID.DisplayWidth) v.displayWidth = readUint(buf, d.start, d.size);
          else if (d.id === ID.DisplayHeight) v.displayHeight = readUint(buf, d.start, d.size);
          else if (d.id === ID.Colour) {
            for (const k of children(buf, d.start, d.start + d.size)) if (k.id === ID.BitsPerChannel) v.bitDepth = readUint(buf, k.start, k.size) || 8;
          }
        }
        t.video = v;
        break;
      }
      case ID.Audio: {
        const a = { sampleRate: 8000, outputSampleRate: 0, channels: 1, bitDepth: 0 };
        for (const d of children(buf, c.start, c.start + c.size)) {
          if (d.id === ID.SamplingFrequency) a.sampleRate = readFloat(buf, d.start, d.size);
          else if (d.id === ID.OutputSamplingFrequency) a.outputSampleRate = readFloat(buf, d.start, d.size);
          else if (d.id === ID.Channels) a.channels = readUint(buf, d.start, d.size);
          else if (d.id === ID.BitDepth) a.bitDepth = readUint(buf, d.start, d.size);
        }
        t.audio = a;
        break;
      }
      case ID.ContentEncodings:
        for (const e of children(buf, c.start, c.start + c.size)) {
          if (e.id !== ID.ContentEncoding) continue;
          for (const cc of children(buf, e.start, e.start + e.size)) {
            if (cc.id !== ID.ContentCompression) continue;
            let algo = 0;
            let settings = null;
            for (const s of children(buf, cc.start, cc.start + cc.size)) {
              if (s.id === ID.ContentCompAlgo) algo = readUint(buf, s.start, s.size);
              else if (s.id === ID.ContentCompSettings) settings = buf.slice(s.start, s.start + s.size);
            }
            if (algo === 3 && settings) t.stripHeader = settings;
            else t.compressed = true; // zlib / bzlib / lzo – not supported
          }
        }
        break;
      default:
    }
  }
  return t;
}

function parseTracks(buf, pos, end) {
  const tracks = [];
  for (const c of children(buf, pos, end)) if (c.id === ID.TrackEntry) tracks.push(parseTrack(buf, c.start, c.start + c.size));
  return tracks;
}

function parseCues(buf, pos, end) {
  const cues = [];
  for (const c of children(buf, pos, end)) {
    if (c.id !== ID.CuePoint) continue;
    let time = -1;
    let cluster = -1;
    let track = 0;
    for (const p of children(buf, c.start, c.start + c.size)) {
      if (p.id === ID.CueTime) time = readUint(buf, p.start, p.size);
      else if (p.id === ID.CueTrackPositions && cluster < 0) {
        for (const q of children(buf, p.start, p.start + p.size)) {
          if (q.id === ID.CueClusterPosition) cluster = readUint(buf, q.start, q.size);
          else if (q.id === ID.CueTrack) track = readUint(buf, q.start, q.size);
        }
      }
    }
    if (time >= 0 && cluster >= 0) cues.push({ time, cluster, track });
  }
  cues.sort((a, b) => a.time - b.time);
  return cues;
}

/** Parses a complete Cues element given as bytes starting at the element header. */
export function parseCuesElement(bytes) {
  const id = readId(bytes, 0, bytes.length);
  if (!id || id.value !== ID.Cues) return null;
  const size = readVint(bytes, id.length, bytes.length);
  if (!size || size.value < 0) return null;
  const start = id.length + size.length;
  if (start + size.value > bytes.length) return { needed: start + size.value };
  return { cues: parseCues(bytes, start, start + size.value) };
}

// ---------------------------------------------------------------- blocks

function splitLaces(buf, pos, end, lacing) {
  const count = buf[pos] + 1;
  pos++;
  const sizes = [];
  if (lacing === 1) {
    // Xiph
    for (let i = 0; i < count - 1; i++) {
      let s = 0;
      let b;
      do {
        b = buf[pos++];
        s += b;
      } while (b === 255 && pos < end);
      sizes.push(s);
    }
  } else if (lacing === 3) {
    // EBML
    const first = readVint(buf, pos, end);
    if (!first) return [];
    pos += first.length;
    sizes.push(first.value);
    let last = first.value;
    for (let i = 1; i < count - 1; i++) {
      const v = readVint(buf, pos, end);
      if (!v) return [];
      pos += v.length;
      const bias = Math.pow(2, 7 * v.length - 1) - 1;
      last += v.value - bias;
      sizes.push(last);
    }
  } else {
    // fixed
    const each = Math.floor((end - pos) / count);
    for (let i = 0; i < count - 1; i++) sizes.push(each);
  }
  const used = sizes.reduce((a, b) => a + b, 0);
  sizes.push(end - pos - used);
  const out = [];
  for (const s of sizes) {
    if (s < 0 || pos + s > end) break;
    out.push([pos, pos + s]);
    pos += s;
  }
  return out;
}

// ---------------------------------------------------------------- demuxer

export class MkvDemuxer {
  constructor({ onHeader, onFrame, onCluster, onCues } = {}) {
    this.cb = { onHeader, onFrame, onCluster, onCues };
    this.buf = new Uint8Array(0);
    this.bufStart = 0; // absolute file offset of buf[0]
    this.pos = 0; // absolute offset of the next unparsed byte
    this.skip = 0;
    this.headerDone = false; // EBML header + segment start seen
    this.segmentStart = -1;
    this.info = { timecodeScale: 1000000, duration: 0 };
    this.seeks = {};
    this.tracks = null;
    this.trackMap = new Map();
    this.cues = null;
    this.clusterEnd = null; // null = not inside a cluster, Infinity = unknown size
    this.clusterTime = 0;
    this.resync = false;
    this.headerSent = false;
  }

  /** Continue reading at an absolute byte offset (seek). resync: offset is a guess, search the next cluster. */
  restartAt(offset, { resync = false } = {}) {
    this.buf = new Uint8Array(0);
    this.bufStart = offset;
    this.pos = offset;
    this.skip = 0;
    this.clusterEnd = null;
    this.resync = resync;
  }

  feed(chunk) {
    if (!chunk || !chunk.length) return;
    const used = this.pos - this.bufStart;
    const keep = this.buf.length - used;
    // Append, dropping everything before pos.
    const next = new Uint8Array(Math.max(0, keep) + chunk.length);
    if (keep > 0) next.set(this.buf.subarray(used), 0);
    next.set(chunk, Math.max(0, keep));
    this.buf = next;
    this.bufStart = this.pos;
    while (this.step()) {
      /* keep parsing */
    }
  }

  get available() {
    return this.bufStart + this.buf.length - this.pos;
  }

  step() {
    const avail = this.available;
    if (avail <= 0) return false;
    if (this.skip > 0) {
      const n = Math.min(this.skip, avail);
      this.pos += n;
      this.skip -= n;
      return true;
    }
    const buf = this.buf;
    const rel = this.pos - this.bufStart;
    const end = buf.length;

    if (this.resync) {
      for (let i = rel; i + 4 <= end; i++) {
        if (buf[i] === 0x1f && buf[i + 1] === 0x43 && buf[i + 2] === 0xb6 && buf[i + 3] === 0x75) {
          this.pos = this.bufStart + i;
          this.resync = false;
          return true;
        }
      }
      this.pos = this.bufStart + Math.max(rel, end - 3);
      return false;
    }

    if (this.clusterEnd !== null && this.pos >= this.clusterEnd) this.clusterEnd = null;

    const id = readId(buf, rel, end);
    if (!id) return false;
    if (id.value < 0) {
      // Garbage – look for the next cluster.
      this.resync = true;
      return true;
    }
    const size = readVint(buf, rel + id.length, end);
    if (!size) return false;
    if (size.value === -2) {
      this.resync = true;
      return true;
    }
    const hdr = id.length + size.length;
    const unknown = size.value === -1;
    const total = unknown ? Infinity : hdr + size.value;

    if (!this.headerDone) {
      if (id.value === ID.EBML) {
        this.skip = total - 0;
        if (!isFinite(this.skip)) return false;
        return true;
      }
      if (id.value === ID.Segment) {
        this.segmentStart = this.pos + hdr;
        this.headerDone = true;
        this.pos += hdr;
        return true;
      }
      // Not a Matroska file
      throw new Error('Keine gültige MKV-Datei');
    }

    // ---------------- inside a cluster
    if (this.clusterEnd !== null && !LEVEL1.has(id.value)) {
      if (id.value === ID.Timecode || id.value === ID.SimpleBlock || id.value === ID.BlockGroup) {
        if (unknown) {
          this.resync = true;
          return true;
        }
        if (avail < total) return false;
        const start = rel + hdr;
        const stop = start + size.value;
        if (id.value === ID.Timecode) this.clusterTime = readUint(buf, start, size.value);
        else if (id.value === ID.SimpleBlock) this.block(buf, start, stop, null, -1);
        else {
          let blk = null;
          let duration = -1;
          let referenced = false;
          for (const c of children(buf, start, stop)) {
            if (c.id === ID.Block) blk = c;
            else if (c.id === ID.BlockDuration) duration = readUint(buf, c.start, c.size);
            else if (c.id === ID.ReferenceBlock) referenced = true;
          }
          if (blk) this.block(buf, blk.start, blk.start + blk.size, !referenced, duration);
        }
        this.pos += total;
        return true;
      }
      if (unknown) {
        this.resync = true;
        return true;
      }
      this.skip = total;
      return true;
    }
    this.clusterEnd = null;

    // ---------------- level 1
    if (id.value === ID.Cluster) {
      this.sendHeader();
      this.clusterEnd = unknown ? Infinity : this.pos + total;
      this.clusterTime = 0;
      if (this.cb.onCluster) this.cb.onCluster(this.pos);
      this.pos += hdr;
      return true;
    }
    if (id.value === ID.Info || id.value === ID.Tracks || id.value === ID.SeekHead || id.value === ID.Cues) {
      if (unknown || size.value > MAX_HEADER_ELEMENT) {
        if (unknown) {
          this.resync = true;
          return true;
        }
        this.skip = total;
        return true;
      }
      if (avail < total) return false;
      const start = rel + hdr;
      const stop = start + size.value;
      if (id.value === ID.Info) this.info = parseInfo(buf, start, stop);
      else if (id.value === ID.SeekHead) Object.assign(this.seeks, parseSeekHead(buf, start, stop));
      else if (id.value === ID.Tracks) {
        this.tracks = parseTracks(buf, start, stop);
        this.trackMap = new Map(this.tracks.map((t) => [t.number, t]));
      } else if (id.value === ID.Cues) {
        this.cues = parseCues(buf, start, stop);
        if (this.cb.onCues) this.cb.onCues(this.cues);
      }
      this.pos += total;
      return true;
    }
    if (unknown) {
      this.resync = true;
      return true;
    }
    this.skip = total;
    return true;
  }

  sendHeader() {
    if (this.headerSent || !this.tracks) return;
    this.headerSent = true;
    if (this.cb.onHeader) {
      this.cb.onHeader({
        info: this.info,
        tracks: this.tracks,
        segmentStart: this.segmentStart,
        cuesPosition: this.seeks[ID.Cues] !== undefined ? this.segmentStart + this.seeks[ID.Cues] : -1,
        cues: this.cues,
      });
    }
  }

  block(buf, start, stop, keyframe, duration) {
    const tn = readVint(buf, start, stop);
    if (!tn) return;
    const track = this.trackMap.get(tn.value);
    if (!track || !this.cb.onFrame) return;
    let p = start + tn.length;
    const rel = readSint(buf, p, 2);
    const flags = buf[p + 2];
    p += 3;
    const key = keyframe === null ? !!(flags & 0x80) : keyframe;
    const lacing = (flags >> 1) & 3;
    const scale = this.info.timecodeScale;
    const timeNs = (this.clusterTime + rel) * scale;
    const durNs = duration >= 0 ? duration * scale : 0;
    const ranges = lacing ? splitLaces(buf, p, stop, lacing) : [[p, stop]];
    const per = ranges.length > 1 ? track.defaultDuration || (durNs ? durNs / ranges.length : 0) : 0;
    ranges.forEach(([a, b], i) => {
      let data = buf.slice(a, b);
      if (track.stripHeader) {
        const full = new Uint8Array(track.stripHeader.length + data.length);
        full.set(track.stripHeader, 0);
        full.set(data, track.stripHeader.length);
        data = full;
      }
      this.cb.onFrame({ track: track.number, timeNs: timeNs + i * per, key, durationNs: ranges.length > 1 ? per : durNs, data });
    });
  }
}
