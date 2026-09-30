'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  AUDIO_PROOF_PEAK,
  readWavSamplesFrom,
  peakOf,
  playSignature,
  verifyCapture,
  probeCostMs
} = require('./probeRunner');
const {
  renderSignaturePcm,
  encodeWav,
  CAPTURE_SAMPLE_RATE,
  PROBE_AMPLITUDE,
  PROBE_AMPLITUDE_LIVE
} = require('./captureProbe');

const FS = CAPTURE_SAMPLE_RATE;

/* ── harness ─────────────────────────────────────────────────── */

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-probe-test-'));
  return path.join(dir, name);
}

/** A WAV on disk holding `samples`, the way the capture helper would leave it. */
function writeCapture(file, samples = new Int16Array(0)) {
  fs.writeFileSync(file, encodeWav(samples, { sampleRate: FS }));
  return file;
}

function appendSamples(file, samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  fs.appendFileSync(file, buf);
}

function noise(n, amp) {
  let seed = 4242;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] = Math.round((seed / 4294967296 - 0.5) * 2 * amp);
  }
  return out;
}

/**
 * A stand-in for afplay that runs `onPlay` and then exits with `code`.
 *
 * `onPlay` is where a test simulates what ScreenCaptureKit did — or did not —
 * write into the capture file while the sound was playing.
 */
function fakePlayer({ onPlay = () => {}, code = 0, failSpawn = false } = {}) {
  return () => {
    if (failSpawn) throw new Error('spawn refused');
    const proc = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      try { onPlay(); } catch { /* surface as a failed capture, not a crash */ }
      proc.emit('exit', code);
    });
    return proc;
  };
}

const noSleep = () => Promise.resolve();

const verify = (opts) => verifyCapture({
  sleep: noSleep,
  tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-probe-sig-')),
  ...opts
});

/* ── readWavSamplesFrom ──────────────────────────────────────── */

test('readWavSamplesFrom reads the PCM after the header', () => {
  const file = writeCapture(tmpFile('c.wav'), new Int16Array([1, -2, 3, -4]));
  const samples = readWavSamplesFrom(file);
  assert.deepStrictEqual(Array.from(samples), [1, -2, 3, -4]);
});

test('readWavSamplesFrom reads only from the requested offset', () => {
  const file = writeCapture(tmpFile('c.wav'), new Int16Array([1, 2, 3, 4]));
  const samples = readWavSamplesFrom(file, 44 + 4); // skip two samples
  assert.deepStrictEqual(Array.from(samples), [3, 4]);
});

test('readWavSamplesFrom returns empty rather than throwing on a missing file', () => {
  // Every caller is on a path where the honest answer is "no samples"; an
  // exception here would turn a diagnosable silent capture into a failed start.
  assert.strictEqual(readWavSamplesFrom('/nope/nothing.wav').length, 0);
});

test('readWavSamplesFrom returns empty for a header-only capture', () => {
  const file = writeCapture(tmpFile('c.wav'));
  assert.strictEqual(readWavSamplesFrom(file).length, 0);
});

test('readWavSamplesFrom never returns half a sample', () => {
  const file = writeCapture(tmpFile('c.wav'), new Int16Array([7, 8]));
  fs.appendFileSync(file, Buffer.from([0x01])); // a torn trailing byte
  assert.strictEqual(readWavSamplesFrom(file).length % 1, 0);
  assert.deepStrictEqual(Array.from(readWavSamplesFrom(file)), [7, 8]);
});

/* ── peakOf ──────────────────────────────────────────────────── */

test('peakOf reports the largest magnitude, sign-independent', () => {
  assert.strictEqual(peakOf(new Int16Array([0, 5, -9, 2])), 9);
  assert.strictEqual(peakOf(new Int16Array(10)), 0);
  assert.strictEqual(peakOf(new Int16Array(0)), 0);
});

/* ── playSignature ───────────────────────────────────────────── */

test('playSignature reports failure instead of throwing when the player will not spawn', async () => {
  const result = await playSignature({ spawnFn: fakePlayer({ failSpawn: true }) });
  assert.strictEqual(result.played, false);
  assert.match(result.reason, /spawn-failed/);
});

test('playSignature reports failure on a non-zero player exit', async () => {
  const result = await playSignature({ spawnFn: fakePlayer({ code: 3 }) });
  assert.strictEqual(result.played, false);
  assert.strictEqual(result.reason, 'player-exit-3');
});

test('playSignature deletes the temp signature file it wrote', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-probe-clean-'));
  await playSignature({ spawnFn: fakePlayer({}), tmpDir });
  assert.deepStrictEqual(fs.readdirSync(tmpDir), [], 'temp signature was left behind');
});

test('playSignature registers the player for cleanup', async () => {
  // Invariant #3: anything spawned must be reapable, including a hung afplay.
  const seen = [];
  await playSignature({ spawnFn: fakePlayer({}), registerProcess: (p) => seen.push(p) });
  assert.strictEqual(seen.length, 1);
});

/* ── verifyCapture: the verdict that matters ─────────────────── */

test('verifyCapture calls a silent capture DEAD — the failure that lost four meetings', async () => {
  const file = writeCapture(tmpFile('system.wav'), new Int16Array(FS)); // a second of zeros
  const result = await verify({
    filePath: file,
    // The capture writes nothing but zeros while the tone plays: exactly the
    // zero-fill failure of gotchas #15/#16.
    spawnFn: fakePlayer({ onPlay: () => appendSamples(file, new Int16Array(FS)) })
  });

  assert.strictEqual(result.verdict, 'dead');
  assert.strictEqual(result.confidence, 'silent-under-probe');
  assert.strictEqual(result.peak, 0);
});

test('verifyCapture calls a capture that returns the signature ALIVE', async () => {
  const file = writeCapture(tmpFile('system.wav'));
  const result = await verify({
    filePath: file,
    spawnFn: fakePlayer({
      onPlay: () => {
        appendSamples(file, new Int16Array(2000));
        appendSamples(file, renderSignaturePcm({ sampleRate: FS, amplitude: PROBE_AMPLITUDE }));
        appendSamples(file, new Int16Array(2000));
      }
    })
  });

  assert.strictEqual(result.verdict, 'alive');
  assert.strictEqual(result.confidence, 'signature-detected');
  assert.strictEqual(result.detection.detected, true);
});

test('verifyCapture accepts the quieter live signature too', async () => {
  const file = writeCapture(tmpFile('system.wav'));
  const result = await verify({
    filePath: file,
    amplitude: PROBE_AMPLITUDE_LIVE,
    spawnFn: fakePlayer({
      onPlay: () => appendSamples(
        file,
        renderSignaturePcm({ sampleRate: FS, amplitude: PROBE_AMPLITUDE_LIVE })
      )
    })
  });
  assert.strictEqual(result.verdict, 'alive');
});

test('verifyCapture calls a capture recording real audio ALIVE even with no signature found', async () => {
  // Loud content masks the tones (measured: true positives collapse under
  // noise). It does not matter — audio demonstrably reached the file, which is
  // the entire proposition under test.
  const file = writeCapture(tmpFile('system.wav'));
  const result = await verify({
    filePath: file,
    spawnFn: fakePlayer({ onPlay: () => appendSamples(file, noise(FS, 9000)) })
  });

  assert.strictEqual(result.verdict, 'alive');
  assert.strictEqual(result.confidence, 'audio-present');
  assert.strictEqual(result.detection.detected, false);
  assert.ok(result.peak >= AUDIO_PROOF_PEAK);
});

test('verifyCapture reports INCONCLUSIVE for a faint signal that is not the signature', async () => {
  const file = writeCapture(tmpFile('system.wav'));
  const result = await verify({
    filePath: file,
    spawnFn: fakePlayer({ onPlay: () => appendSamples(file, noise(FS, 60)) })
  });

  assert.strictEqual(result.verdict, 'inconclusive');
  assert.strictEqual(result.confidence, 'faint-signal');
});

test('verifyCapture blames itself, never the capture, when it cannot play a sound', async () => {
  // Reporting "dead" because WE failed to make a noise is the false alarm that
  // teaches people to click past these warnings.
  const file = writeCapture(tmpFile('system.wav'), new Int16Array(FS));
  const result = await verify({
    filePath: file,
    spawnFn: fakePlayer({ failSpawn: true })
  });

  assert.strictEqual(result.verdict, 'inconclusive');
  assert.strictEqual(result.confidence, 'probe-not-played');
  assert.strictEqual(result.probed, false);
});

test('verifyCapture ignores audio recorded BEFORE the probe was played', async () => {
  // The load-bearing one. A meeting that was recording fine for twenty minutes
  // and died a second ago must not be excused by its own earlier audio, so the
  // read starts at the byte offset playback began from.
  const file = writeCapture(tmpFile('system.wav'), noise(FS * 3, 12000)); // healthy history
  const result = await verify({
    filePath: file,
    spawnFn: fakePlayer({ onPlay: () => appendSamples(file, new Int16Array(FS)) })
  });

  assert.strictEqual(result.verdict, 'dead', 'earlier audio was counted as proof');
  assert.strictEqual(result.peak, 0);
});

test('verifyCapture treats a vanished capture file as dead, not as a crash', async () => {
  const file = tmpFile('gone.wav'); // never created
  const result = await verify({ filePath: file, spawnFn: fakePlayer({}) });
  assert.strictEqual(result.verdict, 'dead');
});

test('verifyCapture registers the player it spawns', async () => {
  const file = writeCapture(tmpFile('system.wav'));
  const seen = [];
  await verify({ filePath: file, spawnFn: fakePlayer({}), registerProcess: (p) => seen.push(p) });
  assert.strictEqual(seen.length, 1);
});

/* ── budgeting ───────────────────────────────────────────────── */

test('probeCostMs accounts for both the sound and the settle wait', () => {
  const cost = probeCostMs({ settleMs: 1000 });
  assert.ok(cost > 1000, 'settle time alone is not the whole cost');
  assert.ok(cost < 4000, 'a start-path delay this long would be felt');
});

test('the audio-proof floor sits below what the quietest probe itself produces', () => {
  // Otherwise a captured probe could fail the cruder test it is meant to imply,
  // and the two paths would disagree about the same capture.
  const quietest = PROBE_AMPLITUDE_LIVE * 32767;
  assert.ok(AUDIO_PROOF_PEAK < quietest, `${AUDIO_PROOF_PEAK} should be under ${quietest}`);
});
