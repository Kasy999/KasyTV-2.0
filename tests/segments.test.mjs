import { test } from 'node:test';
import assert from 'node:assert/strict';

const { SegmentSkipper, youtubeId } = await import('../src/services/segments.js');

test('youtube id from links', () => {
  assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://example.com/video.mp4'), null);
});

test('segment skipper: auto skip, button', () => {
  let t = 0;
  const seeks = [];
  const ui = [];
  const sk = new SegmentSkipper(
    { time: () => t, duration: () => 600, seek: (x) => { seeks.push(x); t = x; }, setMuted() {}, isMuted: () => false },
    (e) => ui.push(e.type),
  );
  clearInterval(sk.timer);
  sk.setSegments([
    { start: 10, end: 40, action: 'skip', label: 'Intro' },
    { start: 100, end: 130, action: 'button', label: 'Abspann' },
  ]);
  for (t = 0; t < 12; t += 0.25) sk.tick();
  assert.deepEqual(seeks, [40]);
  t = 99.5; sk.tick(); t = 101; sk.tick();
  assert.ok(ui.includes('button'));
  sk.skip();
  assert.equal(seeks[1], 130);
  sk.destroy();
});
