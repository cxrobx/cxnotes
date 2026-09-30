'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseScreenTextCsv,
  normaliseName,
  looksLikeName,
  parseRoster,
  matchRoster,
  bestNameInSample,
  buildSpeakerTimeline,
  renderSpeakerBlock
} = require('./speakerNames');

/* ── normaliseName ───────────────────────────────────────────── */

test('normaliseName strips the decoration meeting UIs add', () => {
  assert.strictEqual(normaliseName('Chris Robinson (Host)'), 'Chris Robinson');
  assert.strictEqual(normaliseName('Mary McCarthy (she/her)'), 'Mary McCarthy');
  assert.strictEqual(normaliseName('Cassius F. Butts, Author'), 'Cassius F. Butts');
  assert.strictEqual(normaliseName('  Bruce   Bell  '), 'Bruce Bell');
});

/* ── looksLikeName ───────────────────────────────────────────── */

test('looksLikeName accepts real display names', () => {
  for (const name of ['Bruce Bell', 'Cassius F. Butts', 'Mary McCarthy', "Loleta O'Parrish", 'Aleesha Carter']) {
    assert.ok(looksLikeName(name), `${name} should read as a name`);
  }
});

test('looksLikeName rejects meeting UI chrome', () => {
  for (const chrome of ['Mute', 'Unmute', 'Participants', 'Share Screen', 'Stop Video', 'Recording', 'Gallery View']) {
    assert.ok(!looksLikeName(chrome), `${chrome} should not read as a name`);
  }
});

test('looksLikeName rejects slide headings and prose', () => {
  assert.ok(!looksLikeName('ACCESS TO CAPITAL'), 'shouted headings are not names');
  assert.ok(!looksLikeName('Call Doug Hood at the bank today.'), 'sentences are not names');
  assert.ok(!looksLikeName('Room 4'), 'digits are not names');
  assert.ok(!looksLikeName('chris@example.org'), 'addresses are not names');
});

test('looksLikeName rejects a bare single word', () => {
  // "Recording" and "Marketing" pass every other test, so one word is never
  // enough on its own.
  assert.ok(!looksLikeName('Marketing'));
  assert.ok(!looksLikeName('Cassius'));
});

test('looksLikeName allows lowercase particles inside a surname', () => {
  assert.ok(looksLikeName('Ludwig van Beethoven'));
  assert.ok(looksLikeName('Ada de Souza'));
});

/* ── roster matching ─────────────────────────────────────────── */

test('parseRoster splits the participants field', () => {
  assert.deepStrictEqual(
    parseRoster('Bruce Bell, Cassius Butts; Mary McCarthy\nAleesha Carter'),
    ['Bruce Bell', 'Cassius Butts', 'Mary McCarthy', 'Aleesha Carter']
  );
  assert.deepStrictEqual(parseRoster(''), []);
  assert.deepStrictEqual(parseRoster(null), []);
});

test('matchRoster prefers the roster spelling over what the screen said', () => {
  const roster = ['Cassius Butts', 'Breanna Holmes'];
  assert.strictEqual(matchRoster('Cassius F. Butts', roster), 'Cassius Butts');
  assert.strictEqual(matchRoster('Brianna Holmes', roster), 'Breanna Holmes', 'OCR misspelling still matches');
});

test('matchRoster refuses a surname match with the wrong initial', () => {
  assert.strictEqual(matchRoster('Michael Holmes', ['Breanna Holmes']), null);
});

test('matchRoster ignores short surnames that collide easily', () => {
  assert.strictEqual(matchRoster('Adam Fox', ['Alan Fox']), null, 'a three-letter surname is not enough');
});

/* ── bestNameInSample ────────────────────────────────────────── */

test('bestNameInSample skips chrome and returns the name', () => {
  const best = bestNameInSample(['Mute', 'Participants', 'Bruce Bell', 'Chat']);
  assert.deepStrictEqual(best, { name: 'Bruce Bell', source: 'screen' });
});

test('bestNameInSample prefers a roster hit over an earlier name-shaped line', () => {
  const best = bestNameInSample(['Random Person', 'Cassius F. Butts'], ['Cassius Butts']);
  assert.deepStrictEqual(best, { name: 'Cassius Butts', source: 'roster' });
});

test('bestNameInSample returns null when nothing is name-shaped', () => {
  assert.strictEqual(bestNameInSample(['Mute', 'ACCESS TO CAPITAL', '']), null);
  assert.strictEqual(bestNameInSample([]), null);
});

/* ── buildSpeakerTimeline ────────────────────────────────────── */

const sample = (offsetMs, ...lines) => ({ offsetMs, mode: 'meeting-window', lines });

test('buildSpeakerTimeline merges a run of the same name into one range', () => {
  const timeline = buildSpeakerTimeline([
    sample(0, 'Bruce Bell'), sample(4000, 'Bruce Bell'), sample(8000, 'Bruce Bell'),
    sample(12000, 'Cassius F. Butts'), sample(16000, 'Cassius F. Butts')
  ]);
  assert.strictEqual(timeline.length, 2);
  assert.deepStrictEqual(
    timeline.map(s => [s.name, s.fromMs, s.toMs]),
    [['Bruce Bell', 0, 12000], ['Cassius F. Butts', 12000, 16000]]
  );
});

test('buildSpeakerTimeline drops a name that flickered for one sample', () => {
  const timeline = buildSpeakerTimeline([
    sample(0, 'Bruce Bell'), sample(4000, 'Bruce Bell'),
    sample(8000, 'Noise Name'),
    sample(8500, 'Bruce Bell'), sample(12000, 'Bruce Bell')
  ]);
  assert.ok(!timeline.some(s => s.name === 'Noise Name'), 'a 500ms flicker is OCR noise');
});

test('buildSpeakerTimeline upgrades a run once the roster confirms it', () => {
  const timeline = buildSpeakerTimeline([
    sample(0, 'Cassius Butt'), sample(4000, 'Cassius Butt'), sample(8000, 'Cassius Butt')
  ], { roster: ['Cassius Butts'] });
  assert.strictEqual(timeline[0].name, 'Cassius Butts');
  assert.strictEqual(timeline[0].source, 'roster');
});

test('buildSpeakerTimeline extends the last range to the end of the meeting', () => {
  const timeline = buildSpeakerTimeline(
    [sample(0, 'Bruce Bell'), sample(4000, 'Bruce Bell')],
    { endMs: 3_600_000 }
  );
  assert.strictEqual(timeline[0].toMs, 3_600_000);
});

test('buildSpeakerTimeline copes with no samples', () => {
  assert.deepStrictEqual(buildSpeakerTimeline([]), []);
  assert.deepStrictEqual(buildSpeakerTimeline(null), []);
});

/* ── CSV parsing ─────────────────────────────────────────────── */

test('parseScreenTextCsv reads samples and splits the label list', () => {
  const rows = parseScreenTextCsv([
    'offset_ms,mode,text',
    '4000,meeting-window,"Mute|Bruce Bell|Participants"',
    '8000,shared-window,"Keynote|Slide 4"'
  ].join('\n'));
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0].lines, ['Mute', 'Bruce Bell', 'Participants']);
  assert.strictEqual(rows[1].mode, 'shared-window');
});

test('parseScreenTextCsv skips malformed rows rather than throwing', () => {
  const rows = parseScreenTextCsv('offset_ms,mode,text\nbroken\n4000,m,"Bruce Bell"');
  assert.strictEqual(rows.length, 1);
});

/* ── renderSpeakerBlock ──────────────────────────────────────── */

test('renderSpeakerBlock is empty with no timeline', () => {
  assert.strictEqual(renderSpeakerBlock([]), '');
  assert.strictEqual(renderSpeakerBlock(null), '');
});

test('renderSpeakerBlock marks unconfirmed names and tells the model to keep the label when unsure', () => {
  const block = renderSpeakerBlock([
    { fromMs: 0, toMs: 60000, name: 'Bruce Bell', source: 'screen' },
    { fromMs: 60000, toMs: 120000, name: 'Cassius Butts', source: 'roster' }
  ], { systemLabel: 'Audience' });

  assert.match(block, /\[00:00 - 01:00\] Bruce Bell \(read from screen, unconfirmed\)/);
  assert.match(block, /\[01:00 - 02:00\] Cassius Butts$/m, 'a roster-confirmed name carries no caveat');
  assert.match(block, /keep "Audience" rather than guess a name/);
  assert.match(block, /wrongly attributed quote is worse/);
});

test('renderSpeakerBlock caps a long timeline and says so', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({
    fromMs: i * 1000, toMs: i * 1000 + 900, name: `Person Number${i}`, source: 'screen'
  }));
  const block = renderSpeakerBlock(many, { maxSegments: 5 });
  assert.match(block, /\(\+75 further name changes not listed\)/);
});
