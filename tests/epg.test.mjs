import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.location = { href: 'https://kasy.example/', origin: 'https://kasy.example', protocol: 'https:' };

const { XmltvParser, parseTime, normalizeName, nowNext } = await import('../src/services/epg.js');
const { buildArchiveUrl, isAvailable, hasArchive } = await import('../src/services/catchup.js');

test('XMLTV time with offset', () => {
  assert.equal(parseTime('20261029201500 +0100'), Date.UTC(2026, 9, 29, 19, 15, 0));
  assert.equal(parseTime('202610292015 -0200'), Date.UTC(2026, 9, 29, 22, 15, 0));
});

test('streaming parser matches by id and display-name, across chunk borders', () => {
  const now = Date.UTC(2026, 9, 29, 19, 0, 0);
  const xml = `<?xml version="1.0"?><tv>
<channel id="ard.de"><display-name>Das Erste HD</display-name></channel>
<channel id="x123"><display-name>ZDF</display-name></channel>
<programme start="20261029190000 +0000" stop="20261029194500 +0000" channel="ard.de"><title>Tagesschau &amp; Wetter</title><desc>Nachrichten</desc><category>News</category></programme>
<programme start="20261029194500 +0000" stop="20261029210000 +0000" channel="ard.de"><title><![CDATA[Film <A>]]></title></programme>
<programme start="20261029190000 +0000" stop="20261029200000 +0000" channel="x123"><title>heute</title></programme>
<programme start="20261029190000 +0000" stop="20261029200000 +0000" channel="other"><title>ignoriert</title></programme>
</tv>`;
  const byId = { 'ard.de': ['ard'] };
  const byName = { [normalizeName('ZDF HD')]: ['zdf'] };
  const p = new XmltvParser({
    fromMs: now - 86400000,
    toMs: now + 86400000,
    acceptChannel(id, names) {
      if (byId[id]) return byId[id];
      for (const n of names) if (byName[normalizeName(n)]) return byName[normalizeName(n)];
      return [];
    },
  });
  for (let i = 0; i < xml.length; i += 37) p.feed(xml.slice(i, i + 37));
  const r = p.finish();
  assert.equal(r.count, 3);
  assert.equal(r.programs.ard.length, 2);
  assert.equal(r.programs.ard[0][2], 'Tagesschau & Wetter');
  assert.equal(r.programs.ard[1][2], 'Film <A>');
  assert.equal(r.programs.zdf[0][2], 'heute');
  const nn = nowNext({ programs: r.programs }, { id: 'ard', tvgShiftHours: 0 }, now + 10 * 60000);
  assert.equal(nn.now.title, 'Tagesschau & Wetter');
  assert.equal(nn.next.title, 'Film <A>');
});

test('archive URLs (catch-up types)', () => {
  const start = Date.UTC(2026, 9, 29, 18, 0, 0);
  const end = start + 3600000;
  const now = end + 7200000;
  const s = start / 1000;
  const shift = { url: 'http://p.example/live/ard.m3u8', catchup: { type: 'SHIFT', source: null, days: 7 } };
  assert.equal(buildArchiveUrl(shift, start, end, now), `http://p.example/live/ard.m3u8?utc=${s}&lutc=${now / 1000}`);
  const def = { url: 'http://p.example/ard', catchup: { type: 'DEFAULT', source: 'http://p.example/ard?start={utc}&end={utcend}&d={duration:60}', days: 3 } };
  assert.equal(buildArchiveUrl(def, start, end, now), `http://p.example/ard?start=${s}&end=${s + 3600}&d=60`);
  const fl = { url: 'http://fl.example/ard/index.m3u8?token=x', catchup: { type: 'FLUSSONIC', source: null, days: 3 } };
  assert.equal(buildArchiveUrl(fl, start, end, now), `http://fl.example/ard/index-${s}-3600.m3u8?token=x`);
  const xt = { url: 'http://xt.example:8080/user/pass/123', catchup: { type: 'XTREAM', source: null, days: 3 } };
  assert.match(buildArchiveUrl(xt, start, end, now), /^http:\/\/xt\.example:8080\/timeshift\/user\/pass\/60\/\d{4}-\d{2}-\d{2}:\d{2}-\d{2}\/123\.ts$/);
  assert.ok(hasArchive(shift));
  assert.ok(isAvailable(shift, start, now));
  assert.ok(!isAvailable(shift, start - 8 * 86400000, now));
  assert.equal(buildArchiveUrl({ url: 'x', catchup: { type: 'NONE', days: 0 } }, start, end, now), null);
});

test('name/id normalisation for iptv-org and open-epg ids', () => {
  assert.equal(normalizeName('3sat.de@SD'), normalizeName('3sat'));
  assert.equal(normalizeName('3sat (720p)'), '3sat');
  assert.equal(normalizeName('13TH STREET.de'), normalizeName('13th Street HD'));
  assert.equal(normalizeName('Das Erste HD [Geo-blocked]'), 'daserste');
  assert.equal(normalizeName('ZDF'), 'zdf');
});

test('generic words are optional when matching', async () => {
  const { nameKeys } = await import('../src/services/epg.js');
  const inter = (a, b) => [...nameKeys(a)].some((k) => nameKeys(b).has(k));
  assert.ok(inter('BR Fernsehen (720p)', 'BR.de'));
  assert.ok(inter('WDR Fernsehen', 'WDR'));
  assert.ok(inter('Bibel TV (720p)', 'Bibel TV.de'));
  assert.ok(!inter('ZDFneo', 'ZDF'));
});
