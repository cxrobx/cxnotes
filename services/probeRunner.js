const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  buildSignatureWav,
  detectSignature,
  signatureDurationMs,
  PROBE_AMPLITUDE,
  PROBE_AMPLITUDE_LIVE,
  CAPTURE_SAMPLE_RATE
} = require('./captureProbe');
const { DEFAULT_SIGNAL_THRESHOLD } = require('./signalWatcher');

/**
 * ProbeRunner — the impure half of capture verification
 *
 * `captureProbe.js` synthesises a signature and finds it in samples. This plays
 * the sound, reads the file the capture helper is writing, and turns the two
 * into a verdict. Everything that touches the filesystem, the clock or a child
 * process lives here so the analysis stays testable under plain `node --test`.
 *
 * ## The rule that makes this safe: a probe only decides when the capture is quiet
 *
 * The Monte Carlo behind `DEFAULT_MIN_RATIO` establishes two things about
 * detection under loud broadband audio: false positives are possible at a low
 * rate, and true positives collapse outright because the tones are masked.
 * Either would be alarming if a probe result were treated as the answer on its
 * own. Neither matters here, because of how the verdict is composed:
 *
 *   - If the captured region contains REAL AUDIO, the capture has already proven
 *     itself. Samples demonstrably flowed from ScreenCaptureKit into the file,
 *     which is the entire proposition under test. The probe is not consulted, so
 *     a masked probe cannot raise a false alarm and a lucky one cannot flatter a
 *     broken capture into looking healthy.
 *   - Only when the region is DIGITALLY SILENT does the probe decide — and in
 *     that regime it is unambiguous, because there is nothing to mask it. That
 *     is the case the passive `SignalWatcher` can never resolve on its own:
 *     "the capture is dead" and "nothing is playing yet" look identical until
 *     we are the thing that is playing.
 *
 * So the loud case is answered by the audio, the quiet case is answered by the
 * probe, and neither is asked a question it cannot answer. The failure mode that
 * lost four meetings — a full-length track of exact zeros — falls squarely in
 * the second case and is now provable in about two seconds rather than
 * inferable, unreliably, after forty-five.
 */

/**
 * macOS's own player, by absolute path.
 *
 * A Dock-launched app inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else
 * (invariant #20, gotcha #14). `/usr/bin` survives that, so `afplay` is one of
 * the very few binaries safe to depend on — but it is still written absolute,
 * because a verification step that silently fails to run is worse than no
 * verification at all: it reports "probe not detected" and blames the capture.
 */
const AFPLAY = '/usr/bin/afplay';

/**
 * Peak above which the captured region counts as holding real audio.
 *
 * Comfortably above a stray least-significant bit (gotcha #16 records a single
 * sample of value 1 being read as audio) and above the shared silence threshold,
 * but below the ~259 the quietest probe itself lands at, so that a captured
 * probe always also satisfies the cruder test.
 */
const AUDIO_PROOF_PEAK = 200;

/**
 * How long to wait after playback before reading the capture.
 *
 * ScreenCaptureKit does not write the instant a sound is played; it flushes in
 * buffers. Measured end-to-end, 900 ms was reliably enough on this machine, so
 * this carries a margin over that. It is dead time on the recording-start path,
 * which is the one place the user is waiting, so it is not padded further
 * without a reason.
 */
const PROBE_SETTLE_MS = 1500;

/** Ceiling on the player. A hung `afplay` must never hold a recording hostage. */
const PLAYBACK_TIMEOUT_MS = 6000;

/**
 * Read 16-bit mono PCM from a WAV, starting at a byte offset.
 *
 * Deliberately tolerant: a capture file that is missing, truncated or shorter
 * than its header yields an empty array rather than throwing, because every
 * caller here is on a path where the honest answer is "no samples", and an
 * exception would turn a diagnosable silent capture into a crashed start.
 *
 * @param {string} filePath
 * @param {number} [fromByte=44] - Absolute byte offset; 44 skips the header.
 * @returns {Int16Array}
 */
function readWavSamplesFrom(filePath, fromByte = 44) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(44, fromByte) & ~1; // whole samples only
    const length = (size - start) & ~1;
    if (length <= 0) return new Int16Array(0);

    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);

    const out = new Int16Array(length / 2);
    for (let i = 0; i < out.length; i++) out[i] = buffer.readInt16LE(i * 2);
    return out;
  } catch {
    return new Int16Array(0);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Largest absolute sample in a block. */
function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Current size of a file, or 44 (an empty WAV) if it cannot be read. */
function currentSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 44;
  }
}

/**
 * Write the signature to a temp file and play it once, to the default output.
 *
 * Resolves with `{played: boolean, reason?: string}` and never rejects — a
 * verification step that throws would abort a recording start over a missing
 * sound file, which is the wrong trade in every case.
 */
function playSignature({
  amplitude = PROBE_AMPLITUDE,
  tmpDir = os.tmpdir(),
  registerProcess,
  spawnFn = spawn,
  timeoutMs = PLAYBACK_TIMEOUT_MS
} = {}) {
  return new Promise((resolve) => {
    let file;
    try {
      if (!fs.existsSync(AFPLAY)) {
        resolve({ played: false, reason: 'afplay-missing' });
        return;
      }
      file = path.join(tmpDir, `cxnotes-probe-${process.pid}-${Date.now()}.wav`);
      fs.writeFileSync(file, buildSignatureWav({ amplitude }));
    } catch (err) {
      resolve({ played: false, reason: `write-failed: ${err.message}` });
      return;
    }

    const cleanup = () => {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    };

    // Declared before anything can call `finish`, and with `let` rather than
    // `const`, because a synchronous spawn failure resolves the promise BEFORE
    // the timer is armed. Reaching into a `const` from that path is a temporal
    // dead zone: the throw lands inside the failure handler, so the one case
    // that has to degrade gracefully is the one case that crashes.
    let timer = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    let proc;
    try {
      proc = spawnFn(AFPLAY, [file], { stdio: 'ignore' });
    } catch (err) {
      finish({ played: false, reason: `spawn-failed: ${err.message}` });
      return;
    }

    if (registerProcess) registerProcess(proc);

    timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ played: false, reason: 'playback-timeout' });
    }, timeoutMs);

    proc.on('error', (err) => finish({ played: false, reason: `player-error: ${err.message}` }));
    proc.on('exit', (code) => {
      if (code === 0) finish({ played: true });
      else finish({ played: false, reason: `player-exit-${code}` });
    });
  });
}

/**
 * Play the signature into a live capture and decide whether the capture is alive.
 *
 * Reads only what was written from the moment playback began, so nothing that
 * happened earlier in the meeting can influence the result.
 *
 * Verdicts:
 *   - `alive`        — proven. Either the signature came back, or the region
 *                      holds real audio, which proves the same thing more
 *                      directly.
 *   - `dead`         — proven. We played a known sound into a capture that
 *                      recorded digital silence.
 *   - `inconclusive` — the region held something, but too little to call audio
 *                      and not our signature. Reported honestly rather than
 *                      rounded to a verdict; callers warn and continue.
 *
 * @param {object} opts
 * @param {string} opts.filePath - The WAV the capture helper is writing.
 * @param {number} [opts.amplitude] - Signature level; use the live constant mid-meeting.
 * @param {Function} [opts.registerProcess] - Cleanup registration (invariant #3).
 * @param {Function} [opts.sleep] - Seam for tests.
 * @returns {Promise<object>}
 */
async function verifyCapture({
  filePath,
  amplitude = PROBE_AMPLITUDE,
  registerProcess,
  tmpDir,
  spawnFn,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  settleMs = PROBE_SETTLE_MS,
  silenceThreshold = DEFAULT_SIGNAL_THRESHOLD,
  audioProofPeak = AUDIO_PROOF_PEAK,
  sampleRate = CAPTURE_SAMPLE_RATE
} = {}) {
  const startedAt = currentSize(filePath);

  const playback = await playSignature({ amplitude, registerProcess, tmpDir, spawnFn });
  if (!playback.played) {
    // We could not make a sound, so we learned nothing about the capture. This
    // must never read as failure — blaming the capture for our own inability to
    // play a file is precisely the false alarm that trains people to click past
    // these warnings.
    return {
      verdict: 'inconclusive',
      confidence: 'probe-not-played',
      reason: playback.reason,
      probed: false,
      peak: null,
      detection: null
    };
  }

  await sleep(settleMs);

  const samples = readWavSamplesFrom(filePath, startedAt);
  const peak = peakOf(samples);
  const detection = detectSignature(samples, { sampleRate });

  if (detection.detected) {
    return {
      verdict: 'alive',
      confidence: 'signature-detected',
      reason: 'The capture returned the signature that was played into it.',
      probed: true,
      peak,
      detection
    };
  }

  if (peak >= audioProofPeak) {
    // Loud content masks the signature (see the header). Nothing is wrong: audio
    // is demonstrably reaching the file, which is the only thing being tested.
    return {
      verdict: 'alive',
      confidence: 'audio-present',
      reason: 'The signature was not identified, but the capture is recording real audio.',
      probed: true,
      peak,
      detection
    };
  }

  if (peak > silenceThreshold) {
    return {
      verdict: 'inconclusive',
      confidence: 'faint-signal',
      reason: `The capture recorded a faint signal (peak ${peak}) but not the signature.`,
      probed: true,
      peak,
      detection
    };
  }

  return {
    verdict: 'dead',
    confidence: 'silent-under-probe',
    reason: 'A test tone was played and the system capture recorded digital silence.',
    probed: true,
    peak,
    detection
  };
}

/** Rough wall-clock cost of one verification, for callers budgeting a start. */
function probeCostMs({ settleMs = PROBE_SETTLE_MS } = {}) {
  return signatureDurationMs() + settleMs;
}

module.exports = {
  AFPLAY,
  AUDIO_PROOF_PEAK,
  PROBE_SETTLE_MS,
  PLAYBACK_TIMEOUT_MS,
  PROBE_AMPLITUDE,
  PROBE_AMPLITUDE_LIVE,
  readWavSamplesFrom,
  peakOf,
  playSignature,
  verifyCapture,
  probeCostMs
};
