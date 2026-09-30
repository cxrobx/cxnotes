'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { measureWavPeak, SILENCE_PEAK_THRESHOLD, trimSilence, trimSilenceArgs } = require('./audioProcessing');
const { resolveBinaryCached } = require('./binaries');

const HEADER_BYTES = 44;

/**
 * Write a 16 kHz 16-bit mono WAV whose samples come from `sampleAt`.
 *
 * Only the header fields anything here reads are filled in — `measureWavPeak`
 * skips the header wholesale and scans raw Int16 from byte 44, exactly as the
 * capture files are laid out.
 */
function writeWav(dir, name, sampleCount, sampleAt) {
  const file = path.join(dir, name);
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + sampleCount * 2, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(sampleCount * 2, 40);

  const data = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) data.writeInt16LE(sampleAt(i), i * 2);

  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-peak-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('measureWavPeak: a zero-filled capture is reported silent', () => {
  withTempDir((dir) => {
    // The measured shape of the lost meetings: a correctly-sized file, growing
    // at exactly the byte rate of speech, holding nothing at all.
    const file = writeWav(dir, 'system.wav', 160000, () => 0); // 10s of zeroes
    const result = measureWavPeak(file);

    assert.strictEqual(result.silent, true);
    assert.strictEqual(result.peak, 0);
    assert.strictEqual(result.samples, 160000, 'a silent file is scanned in full');
  });
});

test('measureWavPeak: real audio is not silent', () => {
  withTempDir((dir) => {
    const file = writeWav(dir, 'mic.wav', 160000, (i) => Math.round(8000 * Math.sin(i / 20)));
    const result = measureWavPeak(file);

    assert.strictEqual(result.silent, false);
    assert.ok(result.peak > SILENCE_PEAK_THRESHOLD, `expected proof of audio, got ${result.peak}`);
  });
});

test('measureWavPeak: peak is EXACT for a silent track, approximate otherwise', () => {
  withTempDir((dir) => {
    // The contract worth stating, because the value lands in the manifest.
    // A track that holds audio stops being scanned the moment that is proven,
    // so its `peak` is the first sample over the line — not the loudest moment
    // of the meeting. Nobody should read it as a level measurement.
    const loud = writeWav(dir, 'mic.wav', 160000, (i) => (i < 4 ? 50 : 30000));
    const loudResult = measureWavPeak(loud);
    assert.strictEqual(loudResult.silent, false);
    assert.ok(loudResult.peak < 30000, 'stopped before ever seeing the true maximum');

    // A silent track IS read in full, so its peak is genuinely the maximum —
    // which is the case anyone investigating a lost meeting cares about.
    const dead = writeWav(dir, 'system.wav', 160000, (i) => (i === 99 ? 3 : 0));
    const deadResult = measureWavPeak(dead);
    assert.strictEqual(deadResult.silent, true);
    assert.strictEqual(deadResult.peak, 3, 'the true maximum of a silent track');
    assert.strictEqual(deadResult.samples, 160000, 'and the whole file was read');
  });
});

test('measureWavPeak: a stray least-significant bit is NOT audio', () => {
  withTempDir((dir) => {
    // Observed for real: a dead capture produced a whole track whose peak was
    // exactly 1 — about -90 dBFS. With a zero threshold that single sample
    // marked the track as holding audio, so no warning header and no badge, and
    // the last line of defence was disarmed by one bit.
    const file = writeWav(dir, 'system.wav', 160000, (i) => (i === 159999 ? 1 : 0));
    const result = measureWavPeak(file);

    assert.strictEqual(result.peak, 1);
    assert.strictEqual(result.silent, true);
  });
});

test('measureWavPeak: one genuinely audible sample IS enough', () => {
  withTempDir((dir) => {
    // Deliberately at the very end, so this only passes if the whole file is
    // scanned rather than a leading slice of it.
    const file = writeWav(dir, 'system.wav', 160000, (i) => (i === 159999 ? 5000 : 0));
    const result = measureWavPeak(file);

    assert.strictEqual(result.silent, false);
    assert.strictEqual(result.peak, 5000);
  });
});

test('measureWavPeak: agrees with the live watcher about what silence is', () => {
  // The two must not disagree, or a track is judged dead while it is happening
  // and fine afterwards.
  const { DEFAULT_SIGNAL_THRESHOLD } = require('../services/signalWatcher');
  assert.strictEqual(SILENCE_PEAK_THRESHOLD, DEFAULT_SIGNAL_THRESHOLD);
});

test('measureWavPeak: stops at the FIRST audible sample, not the end of a chunk', () => {
  withTempDir((dir) => {
    // This runs on every stop, so the cost matters. A healthy two-hour meeting
    // is ~230 MB; reading it to the end of even one 1 MB chunk would be pure
    // waste when the answer is settled by sample five.
    const file = writeWav(dir, 'mic.wav', 4_000_000, (i) => (i < 10 ? 9000 : 0));
    const result = measureWavPeak(file);

    assert.strictEqual(result.silent, false);
    assert.ok(result.samples < 100, `should stop almost immediately, read ${result.samples}`);
  });
});

test('measureWavPeak: negative samples count by absolute value', () => {
  withTempDir((dir) => {
    // A waveform sitting entirely below zero is still audio. Comparing raw
    // signed values would call the loudest possible track silent.
    const file = writeWav(dir, 'system.wav', 1000, () => -20000);
    const result = measureWavPeak(file);

    assert.strictEqual(result.silent, false);
    assert.strictEqual(result.peak, 20000);
  });
});

test('measureWavPeak: a header-only file holds nothing', () => {
  withTempDir((dir) => {
    const file = writeWav(dir, 'system.wav', 0, () => 0);
    const result = measureWavPeak(file);

    assert.strictEqual(result.silent, true);
    assert.strictEqual(result.samples, 0);
  });
});

test('measureWavPeak: an unreadable file is null, NOT silent', () => {
  // The distinction the whole feature turns on. Returning `{silent: true}` for
  // a file that could not be opened would flag healthy recordings and prepend a
  // warning to notes that do not deserve one.
  assert.strictEqual(measureWavPeak('/nope/does/not/exist.wav'), null);
});

test('measureWavPeak: an odd trailing byte does not break the scan', () => {
  withTempDir((dir) => {
    // A capture killed mid-sample leaves half an Int16 behind.
    const file = writeWav(dir, 'system.wav', 100, () => 0);
    fs.appendFileSync(file, Buffer.from([0x7f]));

    const result = measureWavPeak(file);
    assert.strictEqual(result.silent, true, 'the stray byte is not a sample');
  });
});

// --- trimSilence: trailing only (2026-09-25) --------------------------------

test('trimSilenceArgs: never trims the head — no silence effect before the first reverse', () => {
  const args = trimSilenceArgs('in.wav', 'out.wav');
  const firstReverse = args.indexOf('reverse');
  const firstSilence = args.indexOf('silence');
  assert.ok(firstReverse > 0, 'reverses first');
  assert.ok(firstSilence > firstReverse, 'the only silence cut runs on the reversed audio');
  assert.strictEqual(args.filter((a) => a === 'silence').length, 1, 'one cut: the tail');
  assert.strictEqual(args[args.length - 1], 'reverse', 'reversed back');
});

test('trimSilence: keeps leading silence so sample 0 is still the recording start', async (t) => {
  if (!resolveBinaryCached('sox')) { t.skip('sox not installed'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-trim-'));
  try {
    const sr = 16000;
    const lead = 3 * sr; const tone = 2 * sr; const tail = 4 * sr;
    // The 09-25 shape: silence, speech, then a long quiet tail.
    const file = writeWav(dir, 'mic.wav', lead + tone + tail,
      (i) => (i >= lead && i < lead + tone ? Math.round(8000 * Math.sin(i / 8)) : 0));
    const result = await trimSilence(file);
    assert.strictEqual(result.trimmed, true);
    assert.strictEqual(result.edge, 'trailing');
    assert.strictEqual(result.leadingSec, 0);
    const samples = (fs.statSync(file).size - HEADER_BYTES) / 2;
    // Head kept whole (3 s), tail gone (≤ 0.6 s of it may survive sox's window).
    assert.ok(samples >= lead + tone, `head kept: ${samples / sr}s`);
    assert.ok(samples < lead + tone + 0.6 * sr, `tail trimmed: ${samples / sr}s`);
    // The tone still starts 3 s in.
    const buf = fs.readFileSync(file);
    let first = -1;
    for (let i = 0; i < samples; i++) {
      if (Math.abs(buf.readInt16LE(HEADER_BYTES + i * 2)) > 100) { first = i; break; }
    }
    assert.ok(Math.abs(first - lead) < 0.05 * sr, `speech onset unmoved: ${first / sr}s`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
