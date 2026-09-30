/**
 * CaptureProbe — proving a capture is alive instead of inferring it
 *
 * `SignalWatcher` answers "is the audio actually audio" by watching for samples
 * and corroborating with the microphone. That corroboration is the best a
 * PASSIVE observer can do, and its own doc comment concedes the limit: digital
 * silence on the system track is perfectly legitimate on its own, so a verdict
 * is really a bet that a working capture "ought to have heard some of" whatever
 * the mic heard. The bet is deliberately loose, and being wrong costs a restart.
 *
 * This module removes the bet. Instead of waiting to see whether audio turns up,
 * it PLAYS a known signal through the machine's own output and then looks for
 * exactly that signal in the captured samples. The two states that are
 * indistinguishable passively —
 *
 *     "the capture is dead"   vs   "nothing is playing yet"
 *
 * — are trivially distinguishable once we are the thing that is playing. A
 * missing signature is proof of failure. A present one is proof of capture.
 *
 * ## Why this works here, and the measurement that established it
 *
 * Measured on this machine 2026-08-17 against the installed signed helper, with
 * ARK.driver loaded and an RME Babyface Pro as output:
 *
 *   | filter shape | tone played via afplay | captured peak |
 *   |--------------|------------------------|---------------|
 *   | `excluding`  | yes                    | 0.999542      |
 *   | `excluding`  | no (control)           | 0.000000      |
 *   | `including`  | yes                    | 0.000000      |
 *
 * Two things follow. First, `afplay` IS visible to the shipped `excluding`
 * display-mix filter, so a CLI player is a usable probe source — which is NOT a
 * safe assumption in general and is the reason this was measured before a line
 * of it was written. Gotcha #5 warns that CLI players are invisible to the
 * per-app `including` filter and read `0.000000` even when capture works fine,
 * and the third row above reproduces that exactly. **If the filter shape ever
 * changes back, re-run the A/B before trusting this module** — `--filter-shape`
 * exists on the helper for precisely this.
 *
 * Second, and less obviously: the captured peak tracks the AMPLITUDE IN THE FILE
 * and is essentially independent of the system output volume (0.0995 at volume
 * 50, 0.0999 at 100, 0.0965 at 25, all for a file amplitude of 0.1). ScreenCapture-
 * Kit taps ahead of the master volume control. So how loud the probe is *to the
 * user* and how detectable it is *to us* are separate dials, and we own the one
 * that matters. That is what makes a near-inaudible probe viable: the signature
 * below sits ~34 dB down, where it is a faint blip in a quiet room, and still
 * lands two orders of magnitude above the silence threshold.
 *
 * The strongest form of that result, measured the same day: the signature is
 * recovered IDENTICALLY when the output is **muted** or the volume is **zero**
 * (peak 647 muted, 646 at volume 0, against 647 at normal volume). Two things
 * follow, and both matter more than they look:
 *
 *   - Someone working muted, or on a Mac whose volume is down, cannot be handed
 *     a false "your capture is dead" verdict. That failure mode would have made
 *     the whole feature untrustworthy for the exact careful user most likely to
 *     be recording something important.
 *   - Since audibility buys us NO detection margin, the amplitude can be chosen
 *     purely on politeness grounds. It is set by how little we are willing to
 *     intrude on a live meeting, not by what we need in order to hear it.
 *
 * ## What a failed probe does and does not prove
 *
 * A missing signature is only damning when the capture also contains NOTHING.
 * If real audio is present and the probe was simply masked or attenuated by
 * something in the output chain, the capture has already proven itself — audio
 * demonstrably flowed. `verifyCapture` in `services/probeRunner.js` is where
 * those two readings are combined; this module deliberately reports only what it
 * measured, and never the verdict.
 *
 * ## Why a two-tone signature and not a single beep
 *
 * A single tone can be imitated. Meeting audio contains whistles, alert sounds,
 * feedback and hold tones; a detector that fires on "there was energy near 4.4 kHz"
 * would confirm a healthy capture on the strength of someone's notification
 * chime. The signature is therefore an ORDERED PAIR of non-harmonically-related
 * tones, and detection requires both, in the right order, the right distance
 * apart, each standing above its own neighbouring guard bands. That is a shape
 * essentially nothing in a meeting produces by accident, and it is cheap.
 *
 * The frequencies are not arbitrary:
 *   - Both sit below 6.5 kHz, comfortably inside the 8 kHz Nyquist limit of the
 *     16 kHz capture, and clear of the top of the band where a resampler's
 *     rolloff would eat them.
 *   - Both sit above the bulk of speech energy (mostly under 4 kHz), so a
 *     talking meeting is a quiet background rather than competition.
 *   - 5900/4400 = 1.34 — deliberately not 1.5 or 2, so neither tone's harmonics
 *     can masquerade as the other.
 *   - At 16 kHz with a 120 ms window (1920 samples) the bin width is 8.333 Hz,
 *     and both 4400 and 5900 are exact integer multiples of it. They land dead
 *     on Goertzel bin centres, so there is no scalloping loss to budget for.
 *
 * Pure and Electron-free: it synthesises PCM and analyses PCM. Playing the sound
 * and reading the capture file belong to the caller (`services/probeRunner.js`),
 * so everything here is testable under plain `node --test`.
 */

/** The ordered pair. See the header for why these two values. */
const PROBE_FREQUENCIES = [4400, 5900];

/** Duration of EACH tone. 120 ms at 16 kHz is 1920 samples — see header. */
const PROBE_TONE_MS = 120;

/**
 * Peak amplitude of the signature at RECORDING START, as a fraction of full scale.
 *
 * 0.02 is about -34 dBFS. Because SCK taps ahead of the master volume (see
 * header), this is what we RECEIVE regardless of how loud the user is playing
 * things: measured at 615 in 16-bit terms, against a silence threshold of 4.
 * Over two orders of magnitude of margin, while being quiet enough at the
 * speaker to read as a soft interface blip rather than an alarm.
 *
 * Nobody is in a meeting yet when this one plays — it fires before the mic
 * starts — so a faint audible confirmation is if anything a feature.
 */
const PROBE_AMPLITUDE = 0.02;

/**
 * Peak amplitude for probes played DURING a live meeting.
 *
 * Quieter, for the obvious reason: this one plays while people are talking, and
 * on speakers the far side of the call can hear whatever we emit. Politeness is
 * the only thing setting this number, because detectability does not depend on
 * it in the way intuition suggests — measured at 0.005 the signature still came
 * back at amplitude 151 with a power ratio of 187,000:1, so even this is far
 * above what detection requires.
 *
 * Deliberately NOT zero-and-clever: muting the user's output to hide the probe
 * would work (capture is pre-volume) and is exactly the kind of silent
 * side-effect on someone's live meeting that this codebase should never take.
 */
const PROBE_AMPLITUDE_LIVE = 0.008;

/** Fade applied to each end of each tone, to avoid a broadband click. */
const PROBE_FADE_MS = 6;

/** Sample rate the app captures at, and therefore what detection assumes. */
const CAPTURE_SAMPLE_RATE = 16000;

/** Rate the signature is synthesised at for playback. */
const PLAYBACK_SAMPLE_RATE = 48000;

/**
 * How far above its guard bands a tone must stand to count as present.
 *
 * This is a RATIO of Goertzel powers, so it is immune to overall level: a probe
 * played under loud meeting audio and one played into silence both have to clear
 * the same bar relative to their own neighbourhood.
 *
 * Set from a 200-trial-per-level Monte Carlo over broadband noise rather than
 * from a couple of hardware runs, because `_bestWindowFor` takes the MAXIMUM
 * ratio across every window position — an extreme-value statistic that climbs
 * as the search widens. A threshold placed just above one observation of noise
 * is not a threshold. Measured single-tone maxima ran to **71.7**, and an early
 * value of 12 admitted a 1.5% false-positive rate at mid noise levels.
 *
 * 40 sits above the noise distribution in the regime where the probe is actually
 * relied upon (quiet capture: zero false positives in 200 trials, and true
 * probes clearing 171 at the 5th percentile) and costs no true positives there.
 *
 * It does NOT rescue detection under loud audio — masking wins, and the same
 * study shows true positives collapsing as noise rises. That is deliberate and
 * harmless: see `verifyCapture`, which never lets a probe result decide anything
 * unless the capture was quiet enough for the result to mean something.
 */
const DEFAULT_MIN_RATIO = 40;

/**
 * Minimum recovered amplitude, in 16-bit units, for a tone to count.
 *
 * The ratio test alone is not enough: in a digitally silent file every power is
 * zero, and 0/0 must not be allowed to look like a strong peak. This is the
 * absolute floor that makes the silent case unambiguous. Set well above the
 * silence threshold of 4 but far below what we actually transmit (~655), so it
 * survives a quiet output path without ever passing on numerical noise.
 */
const DEFAULT_MIN_AMPLITUDE = 40;

/** Analysis hop. Finer costs CPU; coarser blurs the ordering test. */
const DEFAULT_HOP_MS = 15;

/**
 * Slack on the gap between the two tones, in ms.
 *
 * The tones are contiguous, so the second should begin one tone-length after
 * the first. Playback jitter, resampling and the hop granularity all smear that,
 * and a window can lock on slightly early or late, so the test is a generous
 * band rather than an equality. It exists to enforce ORDER and rough spacing —
 * to reject two unrelated noises that happen to be at the right frequencies —
 * not to measure anything.
 */
const DEFAULT_GAP_TOLERANCE_MS = 70;

/**
 * Goertzel power for one frequency over one window.
 *
 * Chosen over an FFT because we care about a handful of known frequencies rather
 * than a spectrum: this is O(N) per frequency with no allocation, so scanning a
 * few hundred windows across a second of audio stays trivial.
 *
 * @param {Int16Array|Array<number>} samples
 * @param {number} start - First sample index of the window.
 * @param {number} length - Window length in samples.
 * @param {number} freq - Frequency of interest, Hz.
 * @param {number} sampleRate
 * @returns {number} Squared magnitude of that frequency's component.
 */
function goertzelPower(samples, start, length, freq, sampleRate) {
  if (length <= 0 || start < 0 || start + length > samples.length) return 0;

  const k = (freq * length) / sampleRate;
  const omega = (2 * Math.PI * k) / length;
  const coeff = 2 * Math.cos(omega);

  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i++) {
    const s0 = samples[start + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Recover a sinusoid's amplitude from its Goertzel power.
 *
 * For a real sinusoid of amplitude A across N samples the magnitude settles at
 * A*N/2, so this inverts that. Used for the absolute floor test, and reported so
 * a failing probe can say how much signal it DID find rather than just "no".
 */
function amplitudeFromPower(power, length) {
  if (length <= 0 || power <= 0) return 0;
  return (2 * Math.sqrt(power)) / length;
}

/**
 * Guard frequencies bracketing a target.
 *
 * Deliberately far outside the main lobe (which is ~17 Hz wide for a 120 ms
 * window) so they sample the broadband neighbourhood rather than the skirt of
 * the tone itself. Four of them, two either side, so that a single competing
 * tone sitting on one guard cannot by itself sink the ratio.
 */
function guardFrequencies(freq) {
  return [freq - 900, freq - 500, freq + 500, freq + 900];
}

/**
 * Scan every window position for one tone, and keep the best.
 *
 * "Best" is by ratio-to-guards rather than by raw power, because raw power is
 * maximised by whatever is loudest in the room and we are looking for what is
 * most tone-like.
 *
 * @returns {{index: number, offsetMs: number, ratio: number, amplitude: number}}
 */
function _bestWindowFor(samples, freq, { sampleRate, windowLength, hop }) {
  const guards = guardFrequencies(freq);
  let best = { index: -1, offsetMs: 0, ratio: 0, amplitude: 0 };

  for (let start = 0; start + windowLength <= samples.length; start += hop) {
    const power = goertzelPower(samples, start, windowLength, freq, sampleRate);

    let guardSum = 0;
    for (const g of guards) {
      guardSum += goertzelPower(samples, start, windowLength, g, sampleRate);
    }
    const guardMean = guardSum / guards.length;

    // A tiny epsilon keeps the division defined on a perfectly silent window.
    // It cannot manufacture a pass on its own: silence gives power 0, so the
    // ratio is 0, and the absolute amplitude test below is the real backstop.
    const ratio = power / (guardMean + 1e-9);

    if (ratio > best.ratio) {
      best = {
        index: start,
        offsetMs: (start / sampleRate) * 1000,
        ratio,
        amplitude: amplitudeFromPower(power, windowLength)
      };
    }
  }

  return best;
}

/**
 * Look for the signature in captured samples.
 *
 * The caller passes a region of the capture comfortably wider than the probe —
 * playback latency means we never know exactly where within it the tones landed,
 * which is why this searches rather than checks a fixed offset.
 *
 * Every failure names WHICH test failed and reports the measurements, because
 * "the probe was not detected" is about to be used as proof that a capture is
 * broken, and that claim has to be auditable after the fact.
 *
 * @param {Int16Array|Array<number>} samples - Captured 16-bit mono PCM.
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=16000]
 * @param {Array<number>} [opts.freqs] - The ordered pair.
 * @param {number} [opts.toneMs=120]
 * @param {number} [opts.minRatio=8]
 * @param {number} [opts.minAmplitude=40]
 * @param {number} [opts.hopMs=15]
 * @param {number} [opts.gapToleranceMs=70]
 * @returns {{detected: boolean, reason: string, tones: Array<object>, gapMs: (number|null)}}
 */
function detectSignature(samples, opts = {}) {
  const {
    sampleRate = CAPTURE_SAMPLE_RATE,
    freqs = PROBE_FREQUENCIES,
    toneMs = PROBE_TONE_MS,
    minRatio = DEFAULT_MIN_RATIO,
    minAmplitude = DEFAULT_MIN_AMPLITUDE,
    hopMs = DEFAULT_HOP_MS,
    gapToleranceMs = DEFAULT_GAP_TOLERANCE_MS
  } = opts;

  const windowLength = Math.round((sampleRate * toneMs) / 1000);
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));

  if (!samples || samples.length < windowLength) {
    return {
      detected: false,
      reason: 'too-short',
      tones: [],
      gapMs: null
    };
  }

  const tones = freqs.map((freq) => ({
    freq,
    ...(_bestWindowFor(samples, freq, { sampleRate, windowLength, hop }))
  }));

  const weak = tones.find((t) => t.ratio < minRatio);
  if (weak) {
    return {
      detected: false,
      reason: `tone-${weak.freq}-below-ratio`,
      tones,
      gapMs: null
    };
  }

  const quiet = tones.find((t) => t.amplitude < minAmplitude);
  if (quiet) {
    return {
      detected: false,
      reason: `tone-${quiet.freq}-below-amplitude`,
      tones,
      gapMs: null
    };
  }

  // Ordering and spacing. This is what stops two unrelated sounds at the right
  // two frequencies from passing: they would have to also be adjacent, and in
  // the right order.
  const gapMs = tones[1].offsetMs - tones[0].offsetMs;
  const expectedGapMs = toneMs;
  if (Math.abs(gapMs - expectedGapMs) > gapToleranceMs) {
    return {
      detected: false,
      reason: gapMs <= 0 ? 'tones-out-of-order' : 'tone-spacing-wrong',
      tones,
      gapMs
    };
  }

  return { detected: true, reason: 'ok', tones, gapMs };
}

/**
 * Synthesise the signature as 16-bit mono PCM.
 *
 * @returns {Int16Array}
 */
function renderSignaturePcm({
  sampleRate = PLAYBACK_SAMPLE_RATE,
  freqs = PROBE_FREQUENCIES,
  toneMs = PROBE_TONE_MS,
  amplitude = PROBE_AMPLITUDE,
  fadeMs = PROBE_FADE_MS
} = {}) {
  const toneSamples = Math.round((sampleRate * toneMs) / 1000);
  const fadeSamples = Math.max(1, Math.round((sampleRate * fadeMs) / 1000));
  const out = new Int16Array(toneSamples * freqs.length);

  freqs.forEach((freq, toneIndex) => {
    const base = toneIndex * toneSamples;
    for (let i = 0; i < toneSamples; i++) {
      // Raised-cosine ends. A hard start or stop is a step discontinuity, which
      // is broadband — audible as a click, and energy smeared across the guard
      // bands we are about to measure against.
      let envelope = 1;
      if (i < fadeSamples) {
        envelope = 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
      } else if (i >= toneSamples - fadeSamples) {
        const j = toneSamples - 1 - i;
        envelope = 0.5 * (1 - Math.cos((Math.PI * j) / fadeSamples));
      }

      const value = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude * envelope;
      out[base + i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
    }
  });

  return out;
}

/**
 * Wrap PCM in a 44-byte canonical WAV header.
 *
 * Written by hand rather than shelled out to sox: this has to work on a machine
 * where sox is missing or unresolvable (invariant #20), and a probe that cannot
 * run is a verification step that silently stops verifying.
 *
 * @returns {Buffer}
 */
function encodeWav(pcm, { sampleRate = PLAYBACK_SAMPLE_RATE, channels = 1 } = {}) {
  const bytesPerSample = 2;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);                                   // PCM chunk size
  buffer.writeUInt16LE(1, 20);                                    // format = PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(channels * bytesPerSample, 32);            // block align
  buffer.writeUInt16LE(16, 34);                                   // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < pcm.length; i++) {
    buffer.writeInt16LE(pcm[i], 44 + i * bytesPerSample);
  }

  return buffer;
}

/** Convenience: the playable signature as a ready-to-write WAV buffer. */
function buildSignatureWav(opts = {}) {
  const sampleRate = opts.sampleRate || PLAYBACK_SAMPLE_RATE;
  return encodeWav(renderSignaturePcm({ ...opts, sampleRate }), { sampleRate });
}

/** Total wall-clock length of the signature, ms. */
function signatureDurationMs({ freqs = PROBE_FREQUENCIES, toneMs = PROBE_TONE_MS } = {}) {
  return freqs.length * toneMs;
}

module.exports = {
  PROBE_FREQUENCIES,
  PROBE_TONE_MS,
  PROBE_AMPLITUDE,
  PROBE_AMPLITUDE_LIVE,
  PROBE_FADE_MS,
  CAPTURE_SAMPLE_RATE,
  PLAYBACK_SAMPLE_RATE,
  DEFAULT_MIN_RATIO,
  DEFAULT_MIN_AMPLITUDE,
  DEFAULT_HOP_MS,
  DEFAULT_GAP_TOLERANCE_MS,
  goertzelPower,
  amplitudeFromPower,
  guardFrequencies,
  detectSignature,
  renderSignaturePcm,
  encodeWav,
  buildSignatureWav,
  signatureDurationMs
};
