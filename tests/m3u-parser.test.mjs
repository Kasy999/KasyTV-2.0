import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u, looksLikeM3u, XTREAM_RE } from '../src/services/m3u-parser.js';

const SAMPLE = `#EXTM3U url-tvg="http://epg.example/epg.xml.gz" catchup="shift" catchup-days="3"
#EXTINF:-1 tvg-id="ard.de" tvg-name="Das Erste" tvg-logo="https://logo/ard.png" tvg-chno="1" group-title="Deutschland",Das Erste HD
#EXTVLCOPT:http-user-agent=TestUA
http://stream.example/ard/index.m3u8
#EXTINF:-1 tvg-id="zdf.de" group-title="Deutschland;HD",ZDF, "HD"
http://stream.example/zdf.m3u8|Referer=http://x.example
#EXTINF:-1,Film A
#EXTGRP:Filme
http://vod.example/movie/user/pass/123.mp4
#EXTINF:-1 tvg-id="ard.de",Das Erste (Backup)
http://stream.example/ard2.ts
http://plain.example/live/kanal%20eins.m3u8
`;

test('parses channels, groups, attributes', () => {
  const r = parseM3u(SAMPLE);
  assert.equal(r.channels.length, 5);
  assert.deepEqual(r.epgUrls, ['http://epg.example/epg.xml.gz']);
  const [ard, zdf, film, ard2, plain] = r.channels;
  assert.equal(ard.name, 'Das Erste HD');
  assert.equal(ard.number, 1);
  assert.equal(ard.logo, 'https://logo/ard.png');
  assert.equal(ard.group, 'Deutschland');
  assert.equal(ard.headers['User-Agent'], 'TestUA');
  assert.equal(ard.catchup.type, 'SHIFT');
  assert.equal(ard.catchup.days, 3);
  assert.equal(zdf.name, 'ZDF, "HD"');
  assert.equal(zdf.url, 'http://stream.example/zdf.m3u8');
  assert.equal(zdf.headers.Referer, 'http://x.example');
  assert.equal(zdf.group, 'Deutschland');
  assert.equal(film.group, 'Filme');
  assert.equal(film.kind, 'vod');
  assert.equal(ard2.id, 'ard.de#2', 'duplicate ids get a suffix');
  assert.equal(plain.name, 'kanal eins.m3u8');
  assert.equal(plain.group, 'Ohne Kategorie');
  assert.deepEqual(r.groups.map((g) => g.name), ['Deutschland', 'Filme', 'Ohne Kategorie']);
});

test('BOM, CRLF and relative URLs', () => {
  const r = parseM3u('﻿#EXTM3U\r\n#EXTINF:-1 tvg-logo="logos/a.png",A\r\nstreams/a.m3u8\r\n', { baseUrl: 'https://host.example/lists/list.m3u' });
  assert.equal(r.channels[0].url, 'https://host.example/lists/streams/a.m3u8');
  assert.equal(r.channels[0].logo, 'https://host.example/lists/logos/a.png');
});

test('HLS master playlist is recognised, not taken as channel list', () => {
  const r = parseM3u('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n');
  assert.equal(r.channels.length, 0);
  assert.equal(r.isMaster, true);
});

test('xtream detection and looksLikeM3u', () => {
  assert.ok(XTREAM_RE.test('http://p.example:8080/user/pass/12345'));
  assert.ok(looksLikeM3u('#EXTM3U\n'));
  assert.ok(!looksLikeM3u('<html>nope</html>'));
});

test('large list performance', () => {
  let s = '#EXTM3U\n';
  for (let i = 0; i < 50000; i++) s += `#EXTINF:-1 tvg-id="c${i}" tvg-logo="http://l/${i}.png" group-title="G${i % 40}",Kanal ${i}\nhttp://s.example/${i}.m3u8\n`;
  const t0 = performance.now();
  const r = parseM3u(s);
  const ms = performance.now() - t0;
  assert.equal(r.channels.length, 50000);
  assert.equal(r.groups.length, 40);
  assert.ok(ms < 3000, 'parse took ' + ms + ' ms');
  console.log(`50 000 Sender in ${Math.round(ms)} ms`);
});
