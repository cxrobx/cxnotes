'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseCsvTranscript,
  mergeTranscripts,
  formatTimestamp,
  suppressMicBleed,
  tokeniseForBleed,
  tokenSimilarity
} = require('./transcriptMerger');

const SYSTEM = 'Audience';
const MIC = 'Chris';

function entry(start, end, text, speaker) {
  return { start, end, text, speaker };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-merger-'));
}

/* ── tokeniseForBleed ────────────────────────────────────────── */

test('tokeniseForBleed lowercases and drops punctuation', () => {
  assert.deepStrictEqual(
    tokeniseForBleed('Hey, what you MAY want to consider -- this.'),
    ['hey', 'what', 'you', 'may', 'want', 'to', 'consider', 'this']
  );
});

test('tokeniseForBleed keeps apostrophes and survives empty input', () => {
  assert.deepStrictEqual(tokeniseForBleed("don't stop"), ["don't", 'stop']);
  assert.deepStrictEqual(tokeniseForBleed(''), []);
  assert.deepStrictEqual(tokeniseForBleed(null), []);
});

/* ── tokenSimilarity ─────────────────────────────────────────── */

test('tokenSimilarity scores identical, overlapping and disjoint sets', () => {
  assert.strictEqual(tokenSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.strictEqual(tokenSimilarity(['a', 'b'], ['c', 'd']), 0);
  assert.strictEqual(tokenSimilarity([], ['a']), 0);
  assert.ok(tokenSimilarity(['a', 'b', 'c'], ['a', 'b', 'c', 'd']) > 0.8);
});

/* ── suppressMicBleed ────────────────────────────────────────── */

test('suppressMicBleed drops the mic copy of overlapping identical speech', () => {
  const entries = [
    entry(0, 2000, 'Through what I am looking to accomplish.', SYSTEM),
    entry(0, 3000, 'Through what I am looking to accomplish.', MIC)
  ];
  const { entries: kept, suppressed } = suppressMicBleed(entries, MIC, SYSTEM);
  assert.strictEqual(suppressed, 1);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].speaker, SYSTEM);
});

test('suppressMicBleed tolerates whisper transcribing the two tracks differently', () => {
  const entries = [
    entry(3000, 8000, 'And then they will give me their feedback and they will say you may want to consider this.', SYSTEM),
    entry(3200, 8400, 'And then they will give me their feedback and they will say, hey, you may want to consider this.', MIC)
  ];
  const { suppressed } = suppressMicBleed(entries, MIC, SYSTEM);
  assert.strictEqual(suppressed, 1);
});

test('suppressMicBleed keeps genuinely different speech at the same moment', () => {
  const entries = [
    entry(0, 4000, 'We rank number one in the country for doing business.', SYSTEM),
    entry(500, 4200, 'Sorry, could everyone please mute their microphones.', MIC)
  ];
  const { entries: kept, suppressed } = suppressMicBleed(entries, MIC, SYSTEM);
  assert.strictEqual(suppressed, 0);
  assert.strictEqual(kept.length, 2);
});

test('suppressMicBleed keeps the same words spoken at a different time', () => {
  const entries = [
    entry(0, 3000, 'Call Doug Hood at Carver State Bank.', SYSTEM),
    entry(600000, 603000, 'Call Doug Hood at Carver State Bank.', MIC)
  ];
  const { suppressed } = suppressMicBleed(entries, MIC, SYSTEM);
  assert.strictEqual(suppressed, 0);
});

test('suppressMicBleed requires exact equality for short utterances', () => {
  const exact = suppressMicBleed([
    entry(0, 800, 'Yes.', SYSTEM),
    entry(100, 900, 'Yes!', MIC)
  ], MIC, SYSTEM);
  assert.strictEqual(exact.suppressed, 1, 'identical short interjection is bleed');

  const different = suppressMicBleed([
    entry(0, 800, 'Yes.', SYSTEM),
    entry(100, 900, 'Right, okay.', MIC)
  ], MIC, SYSTEM);
  assert.strictEqual(different.suppressed, 0, 'a near miss is not close enough to drop');
});

test('suppressMicBleed never drops a system entry', () => {
  const entries = [
    entry(0, 2000, 'Same words on both tracks.', SYSTEM),
    entry(0, 2000, 'Same words on both tracks.', MIC),
    entry(2000, 4000, 'Only the system heard this.', SYSTEM)
  ];
  const { entries: kept } = suppressMicBleed(entries, MIC, SYSTEM);
  assert.strictEqual(kept.filter(e => e.speaker === SYSTEM).length, 2);
});

test('suppressMicBleed is a no-op when both labels are the same', () => {
  const entries = [
    entry(0, 2000, 'Identical text.', 'Both'),
    entry(0, 2000, 'Identical text.', 'Both')
  ];
  const { entries: kept, suppressed } = suppressMicBleed(entries, 'Both', 'Both');
  assert.strictEqual(suppressed, 0);
  assert.strictEqual(kept.length, 2);
});

test('suppressMicBleed is a no-op when the system track is empty', () => {
  const entries = [entry(0, 2000, 'Only me talking.', MIC)];
  const { entries: kept, suppressed } = suppressMicBleed(entries, MIC, SYSTEM);
  assert.strictEqual(suppressed, 0);
  assert.strictEqual(kept.length, 1);
});

test('suppressMicBleed handles a long run without losing later mic-only speech', () => {
  const entries = [];
  for (let i = 0; i < 50; i++) {
    const start = i * 5000;
    entries.push(entry(start, start + 4000, `Remote speaker line number ${i} about contracting.`, SYSTEM));
    entries.push(entry(start + 100, start + 4100, `Remote speaker line number ${i} about contracting.`, MIC));
  }
  entries.push(entry(300000, 304000, 'This is a question that only I asked out loud.', MIC));
  entries.sort((a, b) => a.start - b.start);

  const { entries: kept, suppressed } = suppressMicBleed(entries, MIC, SYSTEM);
  assert.strictEqual(suppressed, 50);
  const micKept = kept.filter(e => e.speaker === MIC);
  assert.strictEqual(micKept.length, 1);
  assert.match(micKept[0].text, /only I asked out loud/);
});

/* ── mergeTranscripts end to end ─────────────────────────────── */

test('mergeTranscripts writes a bled session once, not twice', () => {
  const dir = tmpdir();
  const systemCsv = path.join(dir, 'system_transcript.csv');
  const micCsv = path.join(dir, 'mic_transcript.csv');
  const out = path.join(dir, 'merged_transcript.txt');

  // Shape taken from the 2026-08-20 seminar, where AirPods put the remote
  // side onto the mic track and every line landed under both speakers.
  fs.writeFileSync(systemCsv, [
    '0,2000,"Through what I am looking to accomplish."',
    '3000,8000,"And then they will give me their feedback."',
    '8000,16000,"But I would definitely say my credit union is that institution."'
  ].join('\n'), 'utf-8');
  fs.writeFileSync(micCsv, [
    '0,3000,"Through what I am looking to accomplish."',
    '3000,8000,"And then they will give me their feedback."',
    '8000,16000,"But I would definitely say my credit union is that institution."'
  ].join('\n'), 'utf-8');

  mergeTranscripts(systemCsv, micCsv, out, SYSTEM, MIC);
  const lines = fs.readFileSync(out, 'utf-8').trim().split('\n');

  assert.strictEqual(lines.length, 3, 'each utterance appears exactly once');
  assert.ok(lines.every(line => line.includes(`] ${SYSTEM}:`)), 'the system track survives');
  assert.ok(!lines.some(line => line.includes(`] ${MIC}:`)), 'the mic copy is gone');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('mergeTranscripts keeps both speakers in a clean session', () => {
  const dir = tmpdir();
  const systemCsv = path.join(dir, 'system_transcript.csv');
  const micCsv = path.join(dir, 'mic_transcript.csv');
  const out = path.join(dir, 'merged_transcript.txt');

  fs.writeFileSync(systemCsv, '0,4000,"What does your company do?"\n', 'utf-8');
  fs.writeFileSync(micCsv, '4500,9000,"We build AI tooling for small businesses."\n', 'utf-8');

  mergeTranscripts(systemCsv, micCsv, out, SYSTEM, MIC);
  const text = fs.readFileSync(out, 'utf-8');

  assert.match(text, new RegExp(`${SYSTEM}: What does your company do`));
  assert.match(text, new RegExp(`${MIC}: We build AI tooling`));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('mergeTranscripts can be told to leave the bleed alone', () => {
  const dir = tmpdir();
  const systemCsv = path.join(dir, 'system_transcript.csv');
  const micCsv = path.join(dir, 'mic_transcript.csv');
  const out = path.join(dir, 'merged_transcript.txt');

  fs.writeFileSync(systemCsv, '0,2000,"Identical line of speech here."\n', 'utf-8');
  fs.writeFileSync(micCsv, '0,2000,"Identical line of speech here."\n', 'utf-8');

  mergeTranscripts(systemCsv, micCsv, out, SYSTEM, MIC, { suppressBleed: false });
  const lines = fs.readFileSync(out, 'utf-8').trim().split('\n');
  assert.strictEqual(lines.length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── existing behaviour still holds ──────────────────────────── */

test('parseCsvTranscript skips a header row and blank lines', () => {
  const dir = tmpdir();
  const csv = path.join(dir, 't.csv');
  fs.writeFileSync(csv, 'start,end,text\n0,1000,"Hello"\n\n1000,2000,"World"\n', 'utf-8');
  assert.deepStrictEqual(parseCsvTranscript(csv), [
    { start: 0, end: 1000, text: 'Hello' },
    { start: 1000, end: 2000, text: 'World' }
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mergeTranscripts still throws when both tracks are empty', () => {
  const dir = tmpdir();
  const out = path.join(dir, 'merged.txt');
  assert.throws(
    () => mergeTranscripts(null, null, out, SYSTEM, MIC),
    /no entries/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formatTimestamp grows an hours field', () => {
  assert.strictEqual(formatTimestamp(0), '00:00');
  assert.strictEqual(formatTimestamp(65_000), '01:05');
  assert.strictEqual(formatTimestamp(3_600_000), '01:00:00');
});

/* ── two-pass behaviour ──────────────────────────────────────── */

function bledSession(count, startAt = 0) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    const start = startAt + i * 5000;
    const line = `Remote speaker line number ${i} about government contracting.`;
    entries.push(entry(start, start + 4000, line, SYSTEM));
    entries.push(entry(start + 120, start + 4120, line, MIC));
  }
  return entries;
}

test('the relaxed pass catches fragments whisper segmented differently', () => {
  const entries = bledSession(20);
  // One system line, split into two shorter mic fragments — neither scores high
  // enough on symmetric similarity, both are contained by the system line.
  entries.push(entry(200000, 208000, 'Yeah, you may be better at it, but do not underestimate the power of teamwork.', SYSTEM));
  entries.push(entry(200100, 203000, 'Yeah, you may be better at it.', MIC));
  entries.push(entry(203100, 208100, 'But do not underestimate the power of teamwork.', MIC));
  entries.sort((a, b) => a.start - b.start);

  const result = suppressMicBleed(entries, MIC, SYSTEM);
  assert.strictEqual(result.relaxed, true, 'the track is compromised, so pass 2 runs');
  const survivors = result.entries.filter(e => e.speaker === MIC);
  assert.strictEqual(survivors.length, 0, 'both fragments are recognised as bleed');
});

test('a genuine second conversation survives inside a bled session', () => {
  // Shape of 2026-08-20: the seminar bleeds onto the mic for the whole session,
  // except a stretch where Chris was talking in a different meeting entirely.
  const entries = bledSession(20);
  const asideStart = 500000;
  const aside = [
    'All right, we will wait a couple more minutes and then we can get started.',
    'Hope everyone is having a good week so far, let us see here.',
    'Was there anything else on your point, or was that pretty much everything?',
    'Well, hope you have a good weekend and I will see you next week.'
  ];
  aside.forEach((text, i) => {
    entries.push(entry(asideStart + i * 6000, asideStart + i * 6000 + 5000, text, MIC));
  });
  entries.sort((a, b) => a.start - b.start);

  const result = suppressMicBleed(entries, MIC, SYSTEM);
  const survivors = result.entries.filter(e => e.speaker === MIC);
  assert.strictEqual(survivors.length, aside.length, 'the aside is kept in full');
  assert.strictEqual(result.suppressed, 20, 'and every bled line is still dropped');
});

test('short fragments are only dropped where the bleed is dense', () => {
  // bledSession(20) runs 0-99s, so 100s sits just inside the region window.
  const dense = bledSession(20);
  dense.push(entry(100000, 104000, 'All right, Jamie, good to see you.', SYSTEM));
  dense.push(entry(100100, 100900, 'Alright, Jamie.', MIC));
  dense.sort((a, b) => a.start - b.start);
  const inRegion = suppressMicBleed(dense, MIC, SYSTEM);
  assert.strictEqual(
    inRegion.entries.filter(e => e.speaker === MIC).length, 0,
    'inside a bleed region, a divergent fragment is bleed'
  );

  // Same fragment, far from any strict match — nothing decides against it.
  const sparse = bledSession(20);
  sparse.push(entry(900000, 904000, 'All right, Jamie, good to see you.', SYSTEM));
  sparse.push(entry(900100, 900900, 'Alright, Jamie.', MIC));
  sparse.sort((a, b) => a.start - b.start);
  const outOfRegion = suppressMicBleed(sparse, MIC, SYSTEM);
  assert.strictEqual(
    outOfRegion.entries.filter(e => e.speaker === MIC).length, 1,
    'in a gap, the same fragment is left alone'
  );
});

test('a clean session never reaches the relaxed pass', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) {
    entries.push(entry(i * 10000, i * 10000 + 4000, `The remote side says something number ${i}.`, SYSTEM));
    entries.push(entry(i * 10000 + 5000, i * 10000 + 9000, `And I reply with a different thought number ${i}.`, MIC));
  }
  entries.sort((a, b) => a.start - b.start);

  const result = suppressMicBleed(entries, MIC, SYSTEM);
  assert.strictEqual(result.relaxed, false);
  assert.strictEqual(result.suppressed, 0);
  assert.strictEqual(result.entries.length, 40);
});

test('one accidental match does not condemn the whole mic track', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) {
    entries.push(entry(i * 10000, i * 10000 + 4000, `The remote side says something number ${i}.`, SYSTEM));
    entries.push(entry(i * 10000 + 5000, i * 10000 + 9000, `And I reply with a different thought number ${i}.`, MIC));
  }
  // A single genuine echo — Chris repeating the remote side back at them.
  entries.push(entry(300000, 304000, 'So the deadline is the first of September.', SYSTEM));
  entries.push(entry(300200, 304200, 'So the deadline is the first of September.', MIC));
  entries.sort((a, b) => a.start - b.start);

  const result = suppressMicBleed(entries, MIC, SYSTEM);
  assert.strictEqual(result.strictMatches, 1);
  assert.ok(result.bleedRatio < 0.3, 'one match in twenty-one is not a compromised track');
  assert.strictEqual(result.relaxed, false);
  assert.strictEqual(result.suppressed, 1, 'the echo itself is still dropped');
});
