'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  formatOffset,
  normaliseLabel,
  createMarker,
  addMarker,
  parseMarkers,
  writeMarkers,
  readMarkers,
  renderMarkersBlock,
  renderMarkersMarkdown,
  DEFAULT_LABEL,
  MAX_LABEL_LENGTH
} = require('./markers');

/* ── formatOffset ────────────────────────────────────────────── */

test('formatOffset renders mm:ss below an hour', () => {
  assert.strictEqual(formatOffset(0), '00:00');
  assert.strictEqual(formatOffset(9_000), '00:09');
  assert.strictEqual(formatOffset(492_000), '08:12');
  assert.strictEqual(formatOffset(3_599_000), '59:59');
});

test('formatOffset grows an hours field past 60 minutes', () => {
  assert.strictEqual(formatOffset(3_600_000), '1:00:00');
  assert.strictEqual(formatOffset(3_753_000), '1:02:33');
});

test('formatOffset clamps nonsense to zero rather than throwing', () => {
  assert.strictEqual(formatOffset(-5_000), '00:00');
  assert.strictEqual(formatOffset(NaN), '00:00');
  assert.strictEqual(formatOffset(undefined), '00:00');
});

/* ── normaliseLabel ──────────────────────────────────────────── */

test('normaliseLabel collapses whitespace and trims', () => {
  assert.strictEqual(normaliseLabel('  pricing   objection \n'), 'pricing objection');
});

test('normaliseLabel falls back for empty or non-string input', () => {
  assert.strictEqual(normaliseLabel(''), DEFAULT_LABEL);
  assert.strictEqual(normaliseLabel('   '), DEFAULT_LABEL);
  assert.strictEqual(normaliseLabel(undefined), DEFAULT_LABEL);
  assert.strictEqual(normaliseLabel(42), DEFAULT_LABEL);
});

test('normaliseLabel caps very long labels with an ellipsis', () => {
  const long = 'x'.repeat(MAX_LABEL_LENGTH + 50);
  const out = normaliseLabel(long);
  assert.strictEqual(out.length, MAX_LABEL_LENGTH);
  assert.ok(out.endsWith('…'));
});

/* ── createMarker ────────────────────────────────────────────── */

test('createMarker measures the offset from the recording start', () => {
  const startTime = 1_000_000;
  const marker = createMarker('Pricing objection', { startTime, now: startTime + 492_000 });
  assert.strictEqual(marker.atMs, 492_000);
  assert.strictEqual(marker.offset, '08:12');
  assert.strictEqual(marker.label, 'Pricing objection');
  assert.strictEqual(marker.at, new Date(startTime + 492_000).toISOString());
});

test('createMarker never produces a negative offset', () => {
  const marker = createMarker('early', { startTime: 5_000, now: 1_000 });
  assert.strictEqual(marker.atMs, 0);
  assert.strictEqual(marker.offset, '00:00');
});

test('createMarker without a label uses the generic fallback', () => {
  const marker = createMarker(undefined, { startTime: 0, now: 60_000 });
  assert.strictEqual(marker.label, DEFAULT_LABEL);
});

/* ── addMarker ───────────────────────────────────────────────── */

test('addMarker keeps the list ordered by offset and does not mutate', () => {
  const first = [{ atMs: 10_000, label: 'a' }];
  const next = addMarker(first, { atMs: 5_000, label: 'b' });

  assert.strictEqual(first.length, 1, 'original array untouched');
  assert.deepStrictEqual(next.map((m) => m.label), ['b', 'a']);
});

test('addMarker tolerates a missing starting list', () => {
  const next = addMarker(undefined, { atMs: 1_000, label: 'a' });
  assert.strictEqual(next.length, 1);
});

/* ── parseMarkers ────────────────────────────────────────────── */

test('parseMarkers accepts a bare array and a wrapped object', () => {
  const bare = parseMarkers('[{"atMs":1000,"label":"a"}]');
  const wrapped = parseMarkers('{"markers":[{"atMs":1000,"label":"a"}]}');
  assert.strictEqual(bare.length, 1);
  assert.strictEqual(wrapped.length, 1);
});

test('parseMarkers backfills a missing offset from atMs', () => {
  const [marker] = parseMarkers('[{"atMs":492000,"label":"a"}]');
  assert.strictEqual(marker.offset, '08:12');
});

test('parseMarkers returns an empty list for corrupt JSON rather than throwing', () => {
  assert.deepStrictEqual(parseMarkers('{not json'), []);
  assert.deepStrictEqual(parseMarkers('"a string"'), []);
  assert.deepStrictEqual(parseMarkers(''), []);
});

test('parseMarkers drops non-object entries and sorts what remains', () => {
  const out = parseMarkers('[{"atMs":9000,"label":"late"},null,7,{"atMs":1000,"label":"early"}]');
  assert.deepStrictEqual(out.map((m) => m.label), ['early', 'late']);
});

/* ── write/read round trip (injected fs) ─────────────────────── */

function fakeFs() {
  const files = new Map();
  return {
    files,
    writeFileSync: (p, data) => files.set(p, data),
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    }
  };
}

test('writeMarkers then readMarkers round-trips through the session directory', () => {
  const fs = fakeFs();
  const markers = [createMarker('Pricing objection', { startTime: 0, now: 492_000 })];

  assert.strictEqual(writeMarkers('/tmp/session', markers, { fs }), true);
  assert.deepStrictEqual(readMarkers('/tmp/session', { fs }).map((m) => m.offset), ['08:12']);
});

test('readMarkers returns an empty list when the file is absent', () => {
  assert.deepStrictEqual(readMarkers('/tmp/nothing-here', { fs: fakeFs() }), []);
});

test('writeMarkers reports failure instead of throwing mid-recording', () => {
  const fs = {
    writeFileSync: () => { throw new Error('disk full'); },
    readFileSync: () => { throw new Error('nope'); }
  };
  assert.strictEqual(writeMarkers('/tmp/session', [], { fs }), false);
});

test('writeMarkers is a no-op without a session directory (system-only mode)', () => {
  const fs = fakeFs();
  assert.strictEqual(writeMarkers(null, [{ atMs: 0 }], { fs }), false);
  assert.strictEqual(fs.files.size, 0);
});

/* ── prompt / markdown rendering ─────────────────────────────── */

test('renderMarkersBlock is empty for no markers so the prompt is unchanged', () => {
  assert.strictEqual(renderMarkersBlock([]), '');
  assert.strictEqual(renderMarkersBlock(undefined), '');
});

test('renderMarkersBlock lists every marker and names the speaker', () => {
  const block = renderMarkersBlock(
    [
      { atMs: 492_000, offset: '08:12', label: 'Pricing objection' },
      { atMs: 1_180_000, offset: '19:40', label: 'FieldPulse handoff' }
    ],
    { speakerLabel: 'Me' }
  );

  assert.ok(block.includes('"Me"'));
  assert.ok(block.includes('08:12 — Pricing objection'));
  assert.ok(block.includes('19:40 — FieldPulse handoff'));
  assert.ok(block.includes('Flagged Moments'), 'asks for the section that surfaces them');
  assert.ok(/do not invent/i.test(block), 'keeps the no-hallucination guard');
});

test('renderMarkersMarkdown emits a bold-offset bullet list', () => {
  const md = renderMarkersMarkdown([{ atMs: 492_000, offset: '08:12', label: 'Pricing objection' }]);
  assert.strictEqual(md, '- **08:12** — Pricing objection');
});
