/**
 * Jellyfin REST client: login, libraries, rows, items, search, playback (direct play or HLS transcoding chosen
 * by a device profile built from what this browser can decode), progress reporting and media segments.
 */
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { normalizeServerUrl, isMixedContent } from '../core/util.js';
import { perf } from '../core/performance.js';

const CLIENT = 'Kasy TV PWA';
const VERSION = '2.0.0';
const TICKS = 10000; // per millisecond

function cfg() {
  return store.get('jellyfin');
}

export function isConnected() {
  const c = cfg();
  return !!(c.server && c.token && c.userId);
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/MiTV|MIBOX|Xiaomi/i.test(ua)) return 'Xiaomi TV';
  if (/Tizen/i.test(ua)) return 'Samsung TV';
  if (/Web0S|webOS/i.test(ua)) return 'LG TV';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Browser';
}

function authHeader(token) {
  const c = cfg();
  let s = `MediaBrowser Client="${CLIENT}", Device="${deviceName()}", DeviceId="${c.deviceId}", Version="${VERSION}"`;
  if (token) s += `, Token="${token}"`;
  return s;
}

async function request(method, path, { body, query, server, token, raw } = {}) {
  const c = cfg();
  const base = server || c.server;
  if (!base) throw new Error('Kein Jellyfin-Server eingerichtet');
  const url = new URL(base + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const tok = token !== undefined ? token : c.token;
  const headers = { 'X-Emby-Authorization': authHeader(tok), Authorization: authHeader(tok), Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url.toString(), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    if (isMixedContent(base)) throw new Error('Die App läuft über HTTPS, der Server über HTTP – der Browser blockiert das. Jellyfin per HTTPS (Reverse-Proxy) erreichbar machen oder die App per HTTP im Heimnetz öffnen.');
    throw new Error('Server nicht erreichbar (Adresse, Netzwerk oder CORS prüfen).');
  }
  if (res.status === 401) {
    if (tok && !server) bus.emit('jellyfin:unauthorized');
    throw new Error('Anmeldung abgelaufen oder falsch (401).');
  }
  if (!res.ok) throw new Error(`Jellyfin: HTTP ${res.status}`);
  if (raw) return res;
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------------- auth ----------------

export async function login(serverInput, username, password) {
  const server = normalizeServerUrl(serverInput);
  if (!server) throw new Error('Bitte die Server-Adresse eingeben.');
  const info = await request('GET', '/System/Info/Public', { server, token: null });
  const auth = await request('POST', '/Users/AuthenticateByName', { server, token: null, body: { Username: username, Pw: password || '' } });
  store.patch('jellyfin', {
    server,
    token: auth.AccessToken,
    userId: auth.User.Id,
    userName: auth.User.Name,
    serverId: auth.ServerId || info.Id,
    serverName: info.ServerName || '',
  });
  bus.emit('jellyfin:changed');
  return auth.User;
}

export async function publicInfo(serverInput) {
  return request('GET', '/System/Info/Public', { server: normalizeServerUrl(serverInput), token: null });
}

export async function logout() {
  try {
    if (isConnected()) await request('POST', '/Sessions/Logout');
  } catch {
    /* ignore */
  }
  store.patch('jellyfin', { token: '', userId: '', userName: '' });
  bus.emit('jellyfin:changed');
}

// ---------------- browsing ----------------

const FIELDS = 'PrimaryImageAspectRatio,Overview,Genres,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks,UserData,ChildCount,SeriesName,ParentIndexNumber,IndexNumber,ImageTags,BackdropImageTags,ParentBackdropImageTags,SeriesPrimaryImageTag,RemoteTrailers,MediaSources';

export async function views() {
  const r = await request('GET', `/Users/${cfg().userId}/Views`);
  return (r.Items || []).filter((v) => ['movies', 'tvshows', 'homevideos', 'musicvideos', 'boxsets', 'mixed', undefined, null].includes(v.CollectionType));
}

export async function resume(limit = 20) {
  const r = await request('GET', `/Users/${cfg().userId}/Items/Resume`, {
    query: { Limit: limit, MediaTypes: 'Video', Fields: FIELDS, EnableImageTypes: 'Primary,Backdrop,Thumb', ImageTypeLimit: 1 },
  });
  return r.Items || [];
}

export async function nextUp(limit = 20) {
  const r = await request('GET', '/Shows/NextUp', { query: { UserId: cfg().userId, Limit: limit, Fields: FIELDS } });
  return r.Items || [];
}

export async function latest(parentId, limit = 20) {
  return (
    (await request('GET', `/Users/${cfg().userId}/Items/Latest`, {
      query: { ParentId: parentId, Limit: limit, Fields: FIELDS, GroupItems: true, EnableImageTypes: 'Primary,Backdrop' },
    })) || []
  );
}

export async function items({ parentId, start = 0, limit = 60, sort = 'SortName', order = 'Ascending', types = 'Movie,Series', search, genre, favorites } = {}) {
  const r = await request('GET', `/Users/${cfg().userId}/Items`, {
    query: {
      ParentId: parentId,
      StartIndex: start,
      Limit: limit,
      SortBy: sort,
      SortOrder: order,
      IncludeItemTypes: types,
      Recursive: true,
      Fields: FIELDS,
      SearchTerm: search,
      Genres: genre,
      Filters: favorites ? 'IsFavorite' : undefined,
      EnableImageTypes: 'Primary,Backdrop',
      ImageTypeLimit: 1,
    },
  });
  return { items: r.Items || [], total: r.TotalRecordCount || 0 };
}

export async function item(id) {
  return request('GET', `/Users/${cfg().userId}/Items/${id}`);
}

export async function seasons(seriesId) {
  const r = await request('GET', `/Shows/${seriesId}/Seasons`, { query: { UserId: cfg().userId, Fields: 'ImageTags,UserData' } });
  return r.Items || [];
}

export async function episodes(seriesId, seasonId) {
  const r = await request('GET', `/Shows/${seriesId}/Episodes`, { query: { UserId: cfg().userId, SeasonId: seasonId, Fields: FIELDS } });
  return r.Items || [];
}

export async function nextEpisode(ep) {
  if (!ep.SeriesId) return null;
  const r = await request('GET', `/Shows/${ep.SeriesId}/Episodes`, { query: { UserId: cfg().userId, StartItemId: ep.Id, Limit: 2, Fields: FIELDS } });
  const list = r.Items || [];
  return list.length > 1 ? list[1] : null;
}

/** Previous and next episode of a series (across seasons). → { prev, next } */
export async function adjacentEpisodes(ep) {
  if (!ep || !ep.SeriesId) return { prev: null, next: null };
  const r = await request('GET', `/Shows/${ep.SeriesId}/Episodes`, { query: { UserId: cfg().userId, AdjacentTo: ep.Id, Fields: FIELDS } });
  const list = (r && r.Items) || [];
  const i = list.findIndex((x) => x.Id === ep.Id);
  if (i < 0) return { prev: null, next: (await nextEpisode(ep).catch(() => null)) || null };
  return { prev: list[i - 1] || null, next: list[i + 1] || null };
}

export async function setFavorite(id, fav) {
  return request(fav ? 'POST' : 'DELETE', `/Users/${cfg().userId}/FavoriteItems/${id}`);
}

export async function setPlayed(id, played) {
  return request(played ? 'POST' : 'DELETE', `/Users/${cfg().userId}/PlayedItems/${id}`);
}

// ---------------- images ----------------

export function imageUrl(it, type = 'Primary', { width, height, quality = 85 } = {}) {
  if (!it) return null;
  const c = cfg();
  let id = it.Id;
  let tag = null;
  if (type === 'Backdrop') {
    if (it.BackdropImageTags && it.BackdropImageTags.length) tag = it.BackdropImageTags[0];
    else if (it.ParentBackdropImageTags && it.ParentBackdropImageTags.length) {
      tag = it.ParentBackdropImageTags[0];
      id = it.ParentBackdropItemId || it.SeriesId;
    }
  } else {
    tag = it.ImageTags && it.ImageTags[type];
    if (!tag && type === 'Primary' && it.SeriesPrimaryImageTag) {
      id = it.SeriesId;
      tag = it.SeriesPrimaryImageTag;
    }
  }
  if (!tag || !id) return null;
  const q = new URLSearchParams({ quality: String(quality), tag });
  if (width) q.set('maxWidth', String(width));
  if (height) q.set('maxHeight', String(height));
  return `${c.server}/Items/${id}/Images/${type}${type === 'Backdrop' ? '/0' : ''}?${q}`;
}

export function posterUrl(it) {
  return imageUrl(it, 'Primary', { width: perf.posterWidth() });
}

export function thumbUrl(it) {
  return imageUrl(it, 'Backdrop', { width: perf.low ? 480 : 720 }) || imageUrl(it, 'Primary', { width: perf.posterWidth() });
}

export function backdropUrl(it) {
  return imageUrl(it, 'Backdrop', { width: perf.backdropWidth(), quality: perf.low ? 70 : 85 });
}

// ---------------- playback ----------------

function probe(type) {
  const v = document.createElement('video');
  try {
    return !!v.canPlayType(type).replace('no', '');
  } catch {
    return false;
  }
}

function mseProbe(type) {
  const MS = window.ManagedMediaSource || window.MediaSource || window.WebKitMediaSource;
  try {
    return !!(MS && MS.isTypeSupported(type));
  } catch {
    return false;
  }
}

/** Video codecs the MKV decoder can hand to this device's decoder (null = decoder off / no MSE). */
export function mkvDecoderCodecs() {
  if (store.get('player.mkvDecoder') === false) return null;
  const list = [];
  if (mseProbe('video/mp4; codecs="avc1.640029"')) list.push('h264');
  if (mseProbe('video/mp4; codecs="hvc1.1.6.L120.90"') || mseProbe('video/mp4; codecs="hev1.1.6.L120.90"')) list.push('hevc');
  if (mseProbe('video/mp4; codecs="av01.0.08M.08"')) list.push('av1');
  if (mseProbe('video/mp4; codecs="vp09.00.40.08"')) list.push('vp9');
  return list.length ? list.join(',') : null;
}

/** Device profile from what this browser really decodes (so Jellyfin only transcodes when needed). */
export function deviceProfile() {
  const nativeHls = probe('application/vnd.apple.mpegurl');
  const h264 = probe('video/mp4; codecs="avc1.640029"');
  const hevc = probe('video/mp4; codecs="hvc1.1.6.L123.B0"') || probe('video/mp4; codecs="hev1.1.6.L123.B0"');
  const av1 = probe('video/mp4; codecs="av01.0.08M.08"');
  const vp9 = probe('video/webm; codecs="vp9"');
  const ac3 = probe('audio/mp4; codecs="ac-3"');
  const eac3 = probe('audio/mp4; codecs="ec-3"');
  const opus = probe('audio/webm; codecs="opus"');
  const flac = probe('audio/flac') || probe('audio/mp4; codecs="flac"');
  const mkv = probe('video/x-matroska') || /Chrome|CrKey|Android/i.test(navigator.userAgent);

  const vCodecs = ['h264'].concat(hevc ? ['hevc'] : [], av1 ? ['av1'] : [], vp9 ? ['vp9'] : []).join(',');
  const aCodecs = ['aac', 'mp3'].concat(ac3 ? ['ac3'] : [], eac3 ? ['eac3'] : [], opus ? ['opus'] : [], flac ? ['flac'] : []).join(',');
  const direct = [
    { Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: vCodecs, AudioCodec: aCodecs },
    { Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9,av1', AudioCodec: 'vorbis,opus' },
    { Container: 'mp3', Type: 'Audio' },
    { Container: 'aac,m4a', Type: 'Audio' },
  ];
  const mkvDecoder = mkvDecoderCodecs();
  if (mkvDecoder) {
    // Kasy MKV decoder: MKV plays directly whenever the picture can be decoded here. Sound formats the browser
    // can't decode (DTS, TrueHD …) are converted on their own by the server – the video stays untouched.
    direct.push({ Container: 'mkv,webm', Type: 'Video', VideoCodec: mkvDecoder });
  } else if (mkv && h264) direct.push({ Container: 'mkv', Type: 'Video', VideoCodec: vCodecs, AudioCodec: aCodecs });

  return {
    Name: 'Kasy TV PWA',
    MaxStreamingBitrate: cfg().maxBitrate || 20000000,
    MaxStaticBitrate: 100000000,
    MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: direct,
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        AudioCodec: 'aac,mp3' + (ac3 ? ',ac3' : '') + (eac3 ? ',eac3' : ''),
        VideoCodec: 'h264' + (hevc && nativeHls ? ',hevc' : ''),
        Context: 'Streaming',
        Protocol: 'hls',
        MaxAudioChannels: '6',
        MinSegments: '1',
        BreakOnNonKeyFrames: true,
      },
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Context: 'Streaming', Protocol: 'http' },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      { Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '52', IsRequired: false }] },
    ],
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' },
      { Format: 'srt', Method: 'External' },
      { Format: 'subrip', Method: 'External' },
      { Format: 'ass', Method: 'External' },
      { Format: 'ssa', Method: 'External' },
      { Format: 'pgssub', Method: 'Encode' },
      { Format: 'dvdsub', Method: 'Encode' },
      { Format: 'dvbsub', Method: 'Encode' },
    ],
    ResponseProfiles: [],
  };
}

/**
 * Asks Jellyfin how to play an item. Returns a play descriptor for the player:
 * { url, type: 'hls'|'file', startSeconds, subtitles, audioTracks, mediaSourceId, playSessionId, item, method }
 */
export async function getPlayback(it, { startMs = null, audioIndex, subtitleIndex, forceTranscode = false } = {}) {
  const c = cfg();
  const body = {
    DeviceProfile: deviceProfile(),
    UserId: c.userId,
    MaxStreamingBitrate: c.maxBitrate || 20000000,
    StartTimeTicks: startMs ? Math.floor(startMs * TICKS) : 0,
    AudioStreamIndex: audioIndex,
    SubtitleStreamIndex: subtitleIndex,
    EnableDirectPlay: !forceTranscode && c.preferDirectPlay,
    EnableDirectStream: !forceTranscode,
    EnableTranscoding: true,
    AllowVideoStreamCopy: true,
    AllowAudioStreamCopy: true,
    AutoOpenLiveStream: true,
  };
  const info = await request('POST', `/Items/${it.Id}/PlaybackInfo`, { body, query: { UserId: c.userId } });
  if (info.ErrorCode) throw new Error('Jellyfin: ' + info.ErrorCode);
  const src = (info.MediaSources || [])[0];
  if (!src) throw new Error('Keine abspielbare Quelle');

  let url;
  let type;
  let method;
  if (!forceTranscode && (src.SupportsDirectPlay || src.SupportsDirectStream) && c.preferDirectPlay && !src.TranscodingUrl) {
    const q = new URLSearchParams({ Static: 'true', mediaSourceId: src.Id, deviceId: c.deviceId, api_key: c.token, playSessionId: info.PlaySessionId || '' });
    if (src.ETag) q.set('Tag', src.ETag);
    url = `${c.server}/Videos/${it.Id}/stream${src.Container ? '.' + src.Container.split(',')[0] : ''}?${q}`;
    type = 'file';
    method = 'DirectPlay';
    if (/mkv|matroska/i.test(src.Container || '') && mkvDecoderCodecs()) type = 'mkv';
  } else if (src.TranscodingUrl) {
    url = c.server + src.TranscodingUrl;
    if (!/api_key=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'api_key=' + c.token;
    type = /\.m3u8/i.test(src.TranscodingUrl) || src.TranscodingSubProtocol === 'hls' ? 'hls' : 'file';
    method = 'Transcode';
  } else {
    const q = new URLSearchParams({ Static: 'true', mediaSourceId: src.Id, deviceId: c.deviceId, api_key: c.token });
    url = `${c.server}/Videos/${it.Id}/stream?${q}`;
    type = 'file';
    method = 'DirectStream';
  }

  const streams = src.MediaStreams || [];
  const subtitles = streams
    .filter((s) => s.Type === 'Subtitle')
    .map((s) => {
      const text = s.IsTextSubtitleStream !== false;
      let vtt = null;
      if (text) {
        vtt = s.DeliveryUrl && s.DeliveryMethod === 'External' ? c.server + s.DeliveryUrl : `${c.server}/Videos/${it.Id}/${src.Id}/Subtitles/${s.Index}/0/Stream.vtt?api_key=${c.token}`;
        // DeliveryUrl may point to the original format – ask for WebVTT.
        vtt = vtt.replace(/\/Stream\.(srt|ass|ssa|sub|subrip)(\?|$)/i, '/Stream.vtt$2');
        if (!/api_key=/.test(vtt)) vtt += (vtt.includes('?') ? '&' : '?') + 'api_key=' + c.token;
      }
      return {
        index: s.Index,
        label: s.DisplayTitle || s.Title || s.Language || 'Untertitel ' + s.Index,
        lang: s.Language || '',
        url: vtt,
        burnIn: !text,
        isDefault: !!s.IsDefault,
        forced: !!s.IsForced,
        burnedNow: s.DeliveryMethod === 'Encode',
      };
    });
  const audioStreams = streams.filter((s) => s.Type === 'Audio');
  const chosenAudio = audioIndex !== undefined ? audioIndex : src.DefaultAudioStreamIndex;
  let mkv = null;
  if (type === 'mkv') {
    const pos = audioStreams.findIndex((s) => s.Index === chosenAudio);
    mkv = {
      size: src.Size || 0,
      durationSeconds: src.RunTimeTicks ? src.RunTimeTicks / TICKS / 1000 : 0,
      audioTrack: pos >= 0 ? pos : undefined,
      // Sound only, converted by the server (for DTS/TrueHD … the browser can't decode).
      externalAudio: (seconds, trackPos) => {
        const stream = audioStreams[trackPos];
        const q = new URLSearchParams({
          api_key: c.token,
          deviceId: c.deviceId,
          mediaSourceId: src.Id,
          playSessionId: info.PlaySessionId || '',
          audioCodec: 'mp3',
          audioBitRate: '192000',
          maxAudioChannels: '2',
          static: 'false',
          startTimeTicks: String(Math.floor(seconds * 1000 * TICKS)),
        });
        if (stream) q.set('audioStreamIndex', String(stream.Index));
        return `${c.server}/Audio/${it.Id}/stream.mp3?${q}`;
      },
    };
  }
  const audioTracks = audioStreams
    .map((s) => ({ index: s.Index, label: s.DisplayTitle || s.Language || 'Audio ' + s.Index, lang: s.Language || '', isDefault: s.Index === src.DefaultAudioStreamIndex }));

  return {
    url,
    type,
    method,
    mkv,
    // Jellyfin's HLS playlists cover the whole runtime, so the player seeks in both cases.
    startSeconds: startMs ? startMs / 1000 : 0,
    subtitles,
    audioTracks,
    audioIndex: audioIndex !== undefined ? audioIndex : src.DefaultAudioStreamIndex,
    subtitleIndex: subtitleIndex !== undefined ? subtitleIndex : src.DefaultSubtitleStreamIndex,
    mediaSourceId: src.Id,
    playSessionId: info.PlaySessionId,
    durationSeconds: src.RunTimeTicks ? src.RunTimeTicks / TICKS / 1000 : it.RunTimeTicks ? it.RunTimeTicks / TICKS / 1000 : 0,
  };
}

function progressBody(it, pb, positionSeconds, paused) {
  return {
    ItemId: it.Id,
    MediaSourceId: pb.mediaSourceId,
    PlaySessionId: pb.playSessionId,
    PositionTicks: Math.floor(positionSeconds * 1000 * TICKS),
    IsPaused: !!paused,
    CanSeek: true,
    PlayMethod: pb.method,
    AudioStreamIndex: pb.audioIndex,
    SubtitleStreamIndex: pb.subtitleIndex,
  };
}

export function reportStart(it, pb, pos) {
  return request('POST', '/Sessions/Playing', { body: progressBody(it, pb, pos, false) }).catch(() => {});
}

export function reportProgress(it, pb, pos, paused) {
  return request('POST', '/Sessions/Playing/Progress', { body: { ...progressBody(it, pb, pos, paused), EventName: 'TimeUpdate' } }).catch(() => {});
}

export function reportStopped(it, pb, pos) {
  const body = progressBody(it, pb, pos, false);
  // keepalive so the report survives closing the app
  const c = cfg();
  try {
    return fetch(`${c.server}/Sessions/Playing/Stopped`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': authHeader(c.token) },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Intro / credits segments: Jellyfin 10.10 MediaSegments API, then the Intro Skipper plugin endpoints. */
export async function mediaSegments(it) {
  const actions = store.get('player.skipSegments') || {};
  const toSeg = (type, start, end) => ({
    start,
    end,
    category: type,
    label: { Intro: 'Intro', Outro: 'Abspann', Recap: 'Rückblick', Preview: 'Vorschau', Commercial: 'Werbung' }[type] || type,
    action: actions[type] || 'off',
    source: 'jellyfin',
  });
  try {
    const r = await request('GET', `/MediaSegments/${it.Id}`);
    const list = (r && r.Items) || [];
    if (list.length) return list.map((s) => toSeg(s.Type, s.StartTicks / TICKS / 1000, s.EndTicks / TICKS / 1000)).filter((s) => s.action !== 'off');
  } catch {
    /* older server */
  }
  if (it.Type !== 'Episode') return [];
  try {
    const r = await request('GET', `/Episode/${it.Id}/IntroSkipperSegments`);
    const out = [];
    if (r && r.Introduction && r.Introduction.Valid !== false) out.push(toSeg('Intro', r.Introduction.IntroStart, r.Introduction.IntroEnd));
    if (r && r.Credits && r.Credits.Valid !== false) out.push(toSeg('Outro', r.Credits.IntroStart, r.Credits.IntroEnd));
    return out.filter((s) => s.action !== 'off' && s.end > s.start);
  } catch {
    /* plugin missing */
  }
  try {
    const r = await request('GET', `/Episode/${it.Id}/IntroTimestamps`);
    if (r && r.Valid) return [toSeg('Intro', r.IntroStart, r.IntroEnd)].filter((s) => s.action !== 'off');
  } catch {
    /* ignore */
  }
  return [];
}

/** Plausibility filter (port of SkipRules.kt): drops segments the server detected inside the film itself. */
export function plausibleSegments(segments, duration) {
  return segments.filter((s) => {
    const len = s.end - s.start;
    if (len < 5 || s.start < 0) return false;
    if (duration && s.start >= duration) return false;
    if (s.category === 'Intro') return len <= 240 && s.start <= 1200 && (!duration || s.start <= duration * 0.35);
    if (s.category === 'Outro') return len <= 900 && (!duration || s.start >= duration * 0.6);
    return len <= 600;
  });
}

export function ticksToSeconds(t) {
  return t ? t / TICKS / 1000 : 0;
}

export function formatRuntime(ticks) {
  const min = Math.round(ticksToSeconds(ticks) / 60);
  if (!min) return '';
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}
