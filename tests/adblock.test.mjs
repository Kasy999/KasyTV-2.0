import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser globals for the store module.
globalThis.window = { addEventListener() {} };
globalThis.location = { href: 'https://kasy.example/', origin: 'https://kasy.example', protocol: 'https:' };

const { filterVodPlaylist, isBlocked, fragmentIsAd } = await import('../src/services/adblock.js');
const { SegmentSkipper } = await import('../src/services/sponsorblock.js');

const VOD = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.0,
seg1.ts
#EXT-X-CUE-OUT:DURATION=12
#EXT-X-DISCONTINUITY
#EXTINF:6.0,
ad1.ts
#EXT-X-CUE-OUT-CONT:ElapsedTime=6,Duration=12
#EXTINF:6.0,
ad2.ts
#EXT-X-CUE-IN
#EXT-X-DISCONTINUITY
#EXTINF:6.0,
seg2.ts
#EXTINF:6.0,
https://pubads.g.doubleclick.net/ad.ts
#EXTINF:6.0,
seg3.ts
#EXT-X-ENDLIST
`;

test('removes marked ad breaks and ad-host segments from VOD playlists', () => {
  const r = filterVodPlaylist(VOD, 'https://cdn.example/vod/index.m3u8');
  assert.equal(r.removed, 3);
  assert.equal(r.seconds, 18);
  assert.ok(!r.text.includes('ad1.ts') && !r.text.includes('ad2.ts') && !r.text.includes('doubleclick'));
  assert.ok(r.text.includes('seg1.ts') && r.text.includes('seg2.ts') && r.text.includes('seg3.ts'));
  assert.ok(r.text.includes('#EXT-X-ENDLIST'));
  // every segment URI still has its #EXTINF
  const lines = r.text.trim().split('\n');
  lines.forEach((l, i) => {
    if (/^seg\d\.ts$/.test(l)) assert.ok(lines[i - 1].startsWith('#EXTINF') || lines[i - 1].startsWith('#EXT-X-DISCONTINUITY') === false);
  });
});

test('live playlists are left alone', () => {
  const live = VOD.replace('#EXT-X-PLAYLIST-TYPE:VOD\n', '').replace('#EXT-X-ENDLIST\n', '');
  const r = filterVodPlaylist(live, 'https://cdn.example/live.m3u8');
  assert.equal(r.removed, 0);
  assert.equal(r.text, live);
});

test('host matching incl. subdomains', () => {
  assert.ok(isBlocked('https://pagead2.googlesyndication.com/x.js'));
  assert.ok(isBlocked('https://a.b.doubleclick.net/y'));
  assert.ok(!isBlocked('https://cdn.example/video.m3u8'));
  assert.ok(!isBlocked('https://kasy.example/app.js'));
});

test('live fragment tags toggle ad state', () => {
  const st = { inAd: false };
  assert.equal(fragmentIsAd([['EXT-X-CUE-OUT', 'DURATION=30']], st), true);
  assert.equal(fragmentIsAd([['EXTINF', '6.0']], st), true);
  assert.equal(fragmentIsAd([['EXT-X-CUE-IN']], st), false);
});

test('segment skipper: auto skip, button, mute', async () => {
  let t = 0;
  let muted = false;
  const seeks = [];
  const ui = [];
  const sk = new SegmentSkipper(
    { time: () => t, duration: () => 600, seek: (x) => { seeks.push(x); t = x; }, setMuted: (m) => (muted = m), isMuted: () => muted },
    (e) => ui.push(e.type),
  );
  clearInterval(sk.timer);
  sk.setSegments([
    { start: 10, end: 40, action: 'skip', label: 'Sponsor' },
    { start: 100, end: 130, action: 'button', label: 'Intro' },
    { start: 200, end: 220, action: 'mute', label: 'Musik' },
  ]);
  for (t = 0; t < 12; t += 0.25) sk.tick();
  assert.deepEqual(seeks, [40]);
  t = 99.5; sk.tick(); t = 101; sk.tick();
  assert.ok(ui.includes('button'));
  sk.skip();
  assert.equal(seeks[1], 130);
  t = 199.6; sk.tick(); t = 200.5; sk.tick();
  assert.equal(muted, true);
  t = 221; sk.tick();
  assert.equal(muted, false);
  sk.destroy();
});
