'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  runSlideOcr,
  renderSlidesBlock,
  condenseSlide,
  bindSlidesToTranscript,
  writeSlidesJson
} = require('./slideText');

const slide = (offsetMs, lines, file = `s-${offsetMs}.jpg`) => ({ offsetMs, file, lines, text: lines.join('\n') });

/* ── condenseSlide ───────────────────────────────────────────── */

test('condenseSlide joins lines and drops single-character noise', () => {
  assert.strictEqual(
    condenseSlide({ lines: ['ACCESS TO CAPITAL', 'x', 'Carver State Bank'] }),
    'ACCESS TO CAPITAL · Carver State Bank'
  );
});

test('condenseSlide falls back to the flat text field', () => {
  assert.strictEqual(condenseSlide({ text: 'One\nTwo' }), 'One · Two');
});

test('condenseSlide truncates rather than flooding the prompt', () => {
  const long = condenseSlide({ lines: [ 'word '.repeat(400) ] }, 50);
  assert.ok(long.length <= 50);
  assert.ok(long.endsWith('…'));
});

/* ── renderSlidesBlock ───────────────────────────────────────── */

test('renderSlidesBlock is empty when there are no slides', () => {
  assert.strictEqual(renderSlidesBlock([]), '');
  assert.strictEqual(renderSlidesBlock(null), '');
  assert.strictEqual(renderSlidesBlock(undefined), '');
});

test('renderSlidesBlock times slides on the transcript clock', () => {
  const block = renderSlidesBlock([slide(842000, ['E-Verify required']), slide(1000, ['ACCESS TO CAPITAL'])]);
  assert.match(block, /\[00:01\] ACCESS TO CAPITAL/);
  assert.match(block, /\[14:02\] E-Verify required/);
  assert.ok(block.indexOf('00:01') < block.indexOf('14:02'), 'slides are ordered by time');
});

test('renderSlidesBlock warns the model not to quote OCR', () => {
  const block = renderSlidesBlock([slide(0, ['Carver State Bank'])]);
  assert.match(block, /context rather than quotation/);
  assert.match(block, /transcript is the better source/);
  assert.match(block, /Never present OCR text as a verbatim quote/);
});

test('renderSlidesBlock caps the list and says how many it left out', () => {
  const many = Array.from({ length: 50 }, (_, i) => slide(i * 1000, [`Slide number ${i}`]));
  const block = renderSlidesBlock(many, { maxSlides: 10 });
  assert.match(block, /\(\+40 further slides not listed\)/);
  assert.strictEqual((block.match(/Slide number/g) || []).length, 10);
});

test('renderSlidesBlock ignores slides with no readable text', () => {
  assert.strictEqual(renderSlidesBlock([slide(1000, ['', ' ', 'x'])]), '');
});

test('renderSlidesBlock ignores entries with no timestamp', () => {
  assert.strictEqual(renderSlidesBlock([{ file: 'a.jpg', lines: ['Something'] }]), '');
});

/* ── bindSlidesToTranscript ──────────────────────────────────── */

test('bindSlidesToTranscript keeps a slide in effect until the next one', () => {
  const entries = [{ start: 0 }, { start: 5000 }, { start: 20000 }, { start: 90000 }];
  const bound = bindSlidesToTranscript(entries, [slide(4000, ['A']), slide(60000, ['B'])]);
  assert.strictEqual(bound[0].slide, null, 'nothing was on screen yet');
  assert.strictEqual(bound[1].slide.offsetMs, 4000);
  assert.strictEqual(bound[2].slide.offsetMs, 4000, 'still the same slide');
  assert.strictEqual(bound[3].slide.offsetMs, 60000);
});

test('bindSlidesToTranscript handles no slides and no entries', () => {
  assert.deepStrictEqual(bindSlidesToTranscript([{ start: 0 }], []), [{ start: 0, slide: null }]);
  assert.deepStrictEqual(bindSlidesToTranscript([], [slide(0, ['A'])]), []);
  assert.deepStrictEqual(bindSlidesToTranscript(null, null), []);
});

test('bindSlidesToTranscript sorts slides it was given out of order', () => {
  const bound = bindSlidesToTranscript([{ start: 10000 }], [slide(60000, ['B']), slide(4000, ['A'])]);
  assert.strictEqual(bound[0].slide.offsetMs, 4000);
});

/* ── runSlideOcr ─────────────────────────────────────────────── */

test('runSlideOcr parses the helper output', () => {
  const result = runSlideOcr('/fake/bin', '/session/slides', {
    existsSync: () => true,
    execFileSync: () => JSON.stringify({ slides: [{ file: 'a.jpg', offsetMs: 5, text: 'Hi', lines: ['Hi'] }] })
  });
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.slides.length, 1);
});

test('runSlideOcr reports a missing helper without throwing', () => {
  const result = runSlideOcr('/fake/bin', '/session/slides', { existsSync: () => false });
  assert.deepStrictEqual(result.slides, []);
  assert.match(result.error, /helper was not found/);
});

test('runSlideOcr is quiet about a session that has no slides directory', () => {
  const result = runSlideOcr('/fake/bin', '/session/slides', {
    existsSync: (p) => p === '/fake/bin'
  });
  assert.deepStrictEqual(result.slides, []);
  assert.strictEqual(result.error, null, 'no slides is normal, not an error');
});

test('runSlideOcr turns a helper crash into an error, not a throw', () => {
  const result = runSlideOcr('/fake/bin', '/session/slides', {
    existsSync: () => true,
    execFileSync: () => { throw new Error('exit 1'); }
  });
  assert.deepStrictEqual(result.slides, []);
  assert.match(result.error, /exit 1/);
});

test('runSlideOcr survives unparseable output', () => {
  const result = runSlideOcr('/fake/bin', '/session/slides', {
    existsSync: () => true,
    execFileSync: () => 'not json'
  });
  assert.deepStrictEqual(result.slides, []);
  assert.ok(result.error);
});

/* ── writeSlidesJson ─────────────────────────────────────────── */

test('writeSlidesJson writes the record and reports the path', () => {
  let written = null;
  const target = writeSlidesJson('/session/slides', [slide(0, ['A'])], {
    writeFileSync: (p, body) => { written = { p, body }; }
  });
  assert.strictEqual(target, '/session/slides/slides.json');
  assert.match(written.body, /"slides"/);
});

test('writeSlidesJson does nothing for an empty set', () => {
  assert.strictEqual(writeSlidesJson('/session/slides', [], { writeFileSync: () => {} }), null);
});

test('writeSlidesJson swallows a write failure', () => {
  const target = writeSlidesJson('/session/slides', [slide(0, ['A'])], {
    writeFileSync: () => { throw new Error('EACCES'); }
  });
  assert.strictEqual(target, null);
});
