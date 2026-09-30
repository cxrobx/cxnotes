'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  PROBE_FREQUENCIES,
  PROBE_TONE_MS,
  PROBE_AMPLITUDE,
  PROBE_AMPLITUDE_LIVE,
  CAPTURE_SAMPLE_RATE,
  DEFAULT_MIN_RATIO,
  DEFAULT_MIN_AMPLITUDE,
  goertzelPower,
  amplitudeFromPower,
  guardFrequencies,
  detectSignature,
  renderSignaturePcm,
  encodeWav,
  buildSignatureWav,
  signatureDurationMs
} = require('./captureProbe');

const FS = CAPTURE_SAMPLE_RATE;

/* ── helpers ─────────────────────────────────────────────────── */

/** Silence of n samples, with the signature optionally pasted in at `at`. */
function captureWith(signature, { totalSamples = FS * 2, at = FS / 2 } = {}) {
  const out = new Int16Array(totalSamples);
  if (signature) {
    for (let i = 0; i < signature.length && at + i < totalSamples; i++) {
      out[at + i] = signature[i];
    }
  }
  return out;
}

/** A single steady tone, for the "one tone is not a signature" tests. */
function tone(freq, ms, amplitude = PROBE_AMPLITUDE) {
  const n = Math.round((FS * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / FS) * amplitude * 32767);
  }
  return out;
}

function concat(...blocks) {
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

const signatureAt16k = (amplitude = PROBE_AMPLITUDE) =>
  renderSignaturePcm({ sampleRate: FS, amplitude });

/* ── goertzelPower ───────────────────────────────────────────── */

test('goertzelPower peaks at the frequency actually present', () => {
  const samples = tone(4400, 200);
  const onTarget = goertzelPower(samples, 0, samples.length, 4400, FS);
  const offTarget = goertzelPower(samples, 0, samples.length, 5900, FS);
  assert.ok(onTarget > offTarget * 1000, `expected ${onTarget} >> ${offTarget}`);
});

test('goertzelPower is zero on digital silence', () => {
  const samples = new Int16Array(FS);
  assert.strictEqual(goertzelPower(samples, 0, samples.length, 4400, FS), 0);
});

test('goertzelPower refuses a window running past the end rather than reading garbage', () => {
  const samples = tone(4400, 50);
  assert.strictEqual(goertzelPower(samples, 0, samples.length + 10, 4400, FS), 0);
  assert.strictEqual(goertzelPower(samples, -5, 10, 4400, FS), 0);
});

test('amplitudeFromPower recovers the amplitude that was synthesised', () => {
  const amp = 0.02;
  const samples = tone(4400, PROBE_TONE_MS, amp);
  const power = goertzelPower(samples, 0, samples.length, 4400, FS);
  const recovered = amplitudeFromPower(power, samples.length);
  const expected = amp * 32767;
  assert.ok(
    Math.abs(recovered - expected) / expected < 0.05,
    `recovered ${recovered.toFixed(0)}, expected about ${expected.toFixed(0)}`
  );
});

/* ── guard bands ─────────────────────────────────────────────── */

test('guard bands sit clear of the tone they bracket', () => {
  const guards = guardFrequencies(4400);
  assert.strictEqual(guards.length, 4);
  // Main lobe for a 120 ms window is ~17 Hz wide; every guard must be far
  // outside it or it measures the tone rather than its neighbourhood.
  for (const g of guards) assert.ok(Math.abs(g - 4400) >= 500, `guard ${g} too close`);
  assert.ok(guards.some((g) => g < 4400) && guards.some((g) => g > 4400), 'guards must bracket');
});

/* ── detectSignature: the positive case ──────────────────────── */

test('detectSignature finds the signature embedded in silence', () => {
  const result = detectSignature(captureWith(signatureAt16k()), { sampleRate: FS });
  assert.strictEqual(result.detected, true);
  assert.strictEqual(result.reason, 'ok');
});

test('detectSignature finds the signature wherever it lands in the region', () => {
  // Playback latency means the caller never knows the exact offset, so this has
  // to be a search rather than a check at a fixed position.
  for (const at of [0, 1000, FS, FS * 1.5]) {
    const samples = captureWith(signatureAt16k(), { totalSamples: FS * 2.5, at });
    assert.strictEqual(
      detectSignature(samples, { sampleRate: FS }).detected,
      true,
      `not found at offset ${at}`
    );
  }
});

test('detectSignature reports the gap between the two tones', () => {
  const result = detectSignature(captureWith(signatureAt16k()), { sampleRate: FS });
  assert.ok(
    Math.abs(result.gapMs - PROBE_TONE_MS) < 40,
    `gap ${result.gapMs} should be about one tone length (${PROBE_TONE_MS})`
  );
});

test('detectSignature still finds the quieter live-meeting signature', () => {
  const result = detectSignature(
    captureWith(signatureAt16k(PROBE_AMPLITUDE_LIVE)),
    { sampleRate: FS }
  );
  assert.strictEqual(result.detected, true);
});

/* ── detectSignature: everything that must NOT pass ──────────── */

test('detectSignature rejects digital silence — the failure this exists to catch', () => {
  const result = detectSignature(new Int16Array(FS * 2), { sampleRate: FS });
  assert.strictEqual(result.detected, false);
  assert.strictEqual(result.tones[0].amplitude, 0);
});

test('detectSignature rejects a single tone — one beep is not a signature', () => {
  for (const freq of PROBE_FREQUENCIES) {
    const samples = captureWith(tone(freq, PROBE_TONE_MS));
    assert.strictEqual(
      detectSignature(samples, { sampleRate: FS }).detected,
      false,
      `a lone ${freq} Hz tone was accepted`
    );
  }
});

test('detectSignature rejects the two tones in the WRONG ORDER', () => {
  // The ordering test is what stops two unrelated noises at the right two
  // frequencies from being read as our signature.
  const reversed = concat(
    tone(PROBE_FREQUENCIES[1], PROBE_TONE_MS),
    tone(PROBE_FREQUENCIES[0], PROBE_TONE_MS)
  );
  const result = detectSignature(captureWith(reversed), { sampleRate: FS });
  assert.strictEqual(result.detected, false);
  assert.strictEqual(result.reason, 'tones-out-of-order');
});

test('detectSignature rejects the right tones spaced too far apart', () => {
  const spread = concat(
    tone(PROBE_FREQUENCIES[0], PROBE_TONE_MS),
    new Int16Array(FS),                       // a full second of silence between
    tone(PROBE_FREQUENCIES[1], PROBE_TONE_MS)
  );
  const result = detectSignature(captureWith(spread, { totalSamples: FS * 3 }), { sampleRate: FS });
  assert.strictEqual(result.detected, false);
  assert.strictEqual(result.reason, 'tone-spacing-wrong');
});

test('detectSignature rejects a signature too faint to be ours', () => {
  // A capture attenuating our tone by 40 dB is not evidence the capture works;
  // the absolute floor is what stops numerical dust passing the ratio test.
  const result = detectSignature(captureWith(signatureAt16k(0.0002)), { sampleRate: FS });
  assert.strictEqual(result.detected, false);
  assert.ok(result.reason.endsWith('below-amplitude') || result.reason.endsWith('below-ratio'));
});

test('detectSignature rejects a region shorter than one tone', () => {
  const result = detectSignature(new Int16Array(100), { sampleRate: FS });
  assert.strictEqual(result.detected, false);
  assert.strictEqual(result.reason, 'too-short');
});

test('detectSignature survives being handed nothing at all', () => {
  assert.strictEqual(detectSignature(null, { sampleRate: FS }).detected, false);
  assert.strictEqual(detectSignature(new Int16Array(0), { sampleRate: FS }).detected, false);
});

test('detectSignature does not fire on broadband noise', () => {
  // Deterministic pseudo-noise: the Monte Carlo behind DEFAULT_MIN_RATIO is the
  // real study, but a regression here would be a silent loss of specificity.
  let seed = 99;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  const noise = new Int16Array(FS * 2);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.round(rnd() * 6000);
  assert.strictEqual(detectSignature(noise, { sampleRate: FS }).detected, false);
});

/* ── the thresholds themselves ───────────────────────────────── */

test('the minimum amplitude sits above the silence threshold it must outrank', () => {
  const { DEFAULT_SIGNAL_THRESHOLD } = require('./signalWatcher');
  // gotcha #16: a single sample of value 1 once read as audio. The probe floor
  // has to be well clear of that, not merely above zero.
  assert.ok(DEFAULT_MIN_AMPLITUDE > DEFAULT_SIGNAL_THRESHOLD * 5);
});

test('the live signature is quieter than the start-of-recording one', () => {
  // Not cosmetic: the live probe plays into a meeting people can hear.
  assert.ok(PROBE_AMPLITUDE_LIVE < PROBE_AMPLITUDE);
});

test('both probe frequencies land on exact Goertzel bin centres at 16 kHz', () => {
  // The reason these two values were chosen. A frequency between bins loses
  // energy to scalloping, which would eat into the detection margin for free.
  const windowLength = Math.round((FS * PROBE_TONE_MS) / 1000);
  for (const freq of PROBE_FREQUENCIES) {
    const k = (freq * windowLength) / FS;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-9, `${freq} Hz gives non-integer bin ${k}`);
  }
});

test('both probe frequencies stay below the Nyquist limit of the capture', () => {
  for (const freq of PROBE_FREQUENCIES) assert.ok(freq < FS / 2, `${freq} Hz exceeds Nyquist`);
});

test('the two probe frequencies are not harmonically related', () => {
  // If one were a harmonic of the other, its overtones could impersonate it.
  const ratio = PROBE_FREQUENCIES[1] / PROBE_FREQUENCIES[0];
  assert.ok(Math.abs(ratio - Math.round(ratio)) > 0.2, `ratio ${ratio} is too close to a harmonic`);
});

test('the ratio floor is set above what noise was measured to reach', () => {
  // Single-tone maxima ran to 71.7 in the Monte Carlo, but a false positive
  // needs BOTH tones plus ordering; 40 gave zero in 800 trials.
  assert.ok(DEFAULT_MIN_RATIO >= 40);
});

/* ── synthesis and WAV encoding ──────────────────────────────── */

test('renderSignaturePcm produces one tone-length per frequency', () => {
  const pcm = renderSignaturePcm({ sampleRate: FS });
  assert.strictEqual(pcm.length, Math.round((FS * PROBE_TONE_MS) / 1000) * PROBE_FREQUENCIES.length);
});

test('renderSignaturePcm honours the requested amplitude', () => {
  const pcm = renderSignaturePcm({ sampleRate: FS, amplitude: 0.02 });
  let peak = 0;
  for (const s of pcm) peak = Math.max(peak, Math.abs(s));
  const expected = 0.02 * 32767;
  assert.ok(Math.abs(peak - expected) / expected < 0.05, `peak ${peak}, expected ~${expected}`);
});

test('renderSignaturePcm fades each end, so there is no click to smear the guards', () => {
  const pcm = renderSignaturePcm({ sampleRate: FS });
  assert.strictEqual(pcm[0], 0);
  assert.strictEqual(pcm[pcm.length - 1], 0);
});

test('encodeWav writes a canonical 44-byte PCM header', () => {
  const wav = encodeWav(new Int16Array([0, 1, -1, 32767]), { sampleRate: 48000 });
  assert.strictEqual(wav.subarray(0, 4).toString(), 'RIFF');
  assert.strictEqual(wav.subarray(8, 12).toString(), 'WAVE');
  assert.strictEqual(wav.subarray(12, 16).toString(), 'fmt ');
  assert.strictEqual(wav.subarray(36, 40).toString(), 'data');
  assert.strictEqual(wav.readUInt16LE(20), 1);        // PCM
  assert.strictEqual(wav.readUInt16LE(22), 1);        // mono
  assert.strictEqual(wav.readUInt32LE(24), 48000);
  assert.strictEqual(wav.readUInt16LE(34), 16);       // bit depth
  assert.strictEqual(wav.readUInt32LE(40), 8);        // 4 samples × 2 bytes
  assert.strictEqual(wav.length, 44 + 8);
});

test('buildSignatureWav round-trips back into a detectable signature', () => {
  // The end-to-end contract in one test: what we WRITE is what we can FIND.
  const wav = buildSignatureWav({ sampleRate: FS });
  const dataSize = wav.readUInt32LE(40);
  const pcm = new Int16Array(dataSize / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = wav.readInt16LE(44 + i * 2);
  assert.strictEqual(detectSignature(captureWith(pcm), { sampleRate: FS }).detected, true);
});

test('signatureDurationMs covers every tone', () => {
  assert.strictEqual(signatureDurationMs(), PROBE_TONE_MS * PROBE_FREQUENCIES.length);
});
