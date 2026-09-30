'use strict';

const fs = require('fs');
const path = require('path');
const { spawn: defaultSpawn } = require('child_process');
const { SILENCE_PEAK_THRESHOLD } = require('../utils/audioProcessing');

/**
 * Call audio — the remote party of iPhone-handoff and FaceTime calls (T206).
 *
 * Those calls are played by the system daemon `avconferenced`, not by an app,
 * and ScreenCaptureKit cannot hear it with either filter shape: measured
 * 2026-09-25, a voicemail greeting left nothing above -60 dBFS in `system.wav`
 * while the start probe reported the capture healthy (gotcha #24).
 *
 * The fix is ADDITIVE and built so a Meet or Zoom recording cannot tell it
 * exists (invariant #26):
 *  - The `call-audio-tap` helper is its own process, like slide capture, so it
 *    can never take `sck-audio-capture` or the mic down with it.
 *  - It only builds a tap while `avconferenced` is playing audio. Through a
 *    whole Zoom call (mic + camera) and a Meet call that never happened, so a
 *    normal meeting gets no tap, no device and no file.
 *  - At stop, a session with no audible call segment leaves `system.wav`
 *    exactly as ScreenCaptureKit wrote it. `planCallMix` returning `[]` is that
 *    gate, and it is pinned by tests.
 * Every failure path here ends in a warning or a recorded reason, never a throw.
 */

/** Written by the helper; the record of truth for what landed on disk. */
const CALL_MANIFEST = 'call.json';

/** What `system.wav` is renamed to when call audio is mixed in. Never deleted. */
const SCK_ORIGINAL = 'system.sck.wav';

/** The rate every capture track is stored at. */
const TARGET_RATE = 16000;

/** SIGTERM → this long to finish the open segment → SIGKILL. */
const CALL_STOP_GRACE_MS = 3000;

/** Rates a Core Audio device reports. A measured rate is snapped to one. */
const STANDARD_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000];

/**
 * Below this, a segment is too short to measure a rate from — a few buffers of
 * jitter dominate — so its header rate is trusted.
 */
const MIN_RATE_CHECK_MS = 2000;

/**
 * Path to the helper, mirroring `resolveSlideBinaryPath`.
 *
 * @param {{isPackaged: boolean, resourcesPath?: string, appDir: string}} env
 * @returns {string}
 */
function resolveCallBinaryPath({ isPackaged, resourcesPath, appDir }) {
  if (isPackaged && resourcesPath) {
    return path.join(resourcesPath, 'call-audio-tap');
  }
  return path.join(appDir, 'native', 'call-audio-tap', '.build', 'release', 'call-audio-tap');
}

/**
 * @param {string} sessionDir
 * @param {{pollMs?: number}} [options]
 * @returns {string[]}
 */
function buildCallArgs(sessionDir, options = {}) {
  const args = [sessionDir];
  if (options.pollMs) args.push('--poll-ms', String(options.pollMs));
  return args;
}

/**
 * Parse one line of the helper's stdout.
 *
 * @param {string} line
 * @returns {object|null}
 */
function parseCallEvent(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed.event === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read `call.json` into validated segments. A malformed file or entry yields
 * fewer segments, never a throw — the worst case is the session as it is today.
 *
 * @param {string} text
 * @returns {Array<{index: number, file: string, sampleRate: number, startEpochMs: number, endEpochMs: number, frames: number, peak: number, endReason: string}>}
 */
function parseCallManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.segments)) return [];

  const isCount = (n) => Number.isFinite(n) && n >= 0;
  return parsed.segments.filter((s) => s
    && typeof s.file === 'string'
    && /^call\.\d+\.wav$/.test(s.file)
    && isCount(s.sampleRate) && s.sampleRate > 0
    && isCount(s.startEpochMs) && s.startEpochMs > 0
    && isCount(s.endEpochMs)
    && isCount(s.frames)
    && isCount(s.peak))
    .map((s) => ({
      index: s.index,
      file: s.file,
      sampleRate: s.sampleRate,
      startEpochMs: s.startEpochMs,
      endEpochMs: s.endEpochMs,
      frames: s.frames,
      peak: s.peak,
      endReason: typeof s.endReason === 'string' ? s.endReason : 'unknown'
    }));
}

/**
 * The rate a segment was actually delivered at.
 *
 * AirPods drop to a call rate (16/24 kHz) without the reported rate always
 * following — Meeting Copilot measured tap callbacks falling 86/s → 47/s with
 * the default device unchanged. The helper opens a new segment whenever the
 * REPORTED rate changes; this is the backstop for when it doesn't. The frame
 * count over the wall-clock span is snapped to a standard rate, and only
 * replaces the header rate when the two disagree by more than 25% — well above
 * buffer jitter, well below the smallest real switch (48 → 32 kHz is 33%).
 *
 * @param {{sampleRate: number, frames: number, startEpochMs: number, endEpochMs: number}} segment
 * @returns {number}
 */
function effectiveSampleRate(segment) {
  const spanMs = segment.endEpochMs - segment.startEpochMs;
  if (!(spanMs >= MIN_RATE_CHECK_MS) || !(segment.frames > 0)) return segment.sampleRate;
  const measured = segment.frames / (spanMs / 1000);
  if (Math.abs(measured - segment.sampleRate) / segment.sampleRate <= 0.25) return segment.sampleRate;
  return STANDARD_RATES.reduce((best, rate) => (
    Math.abs(rate - measured) < Math.abs(best - measured) ? rate : best
  ), STANDARD_RATES[0]);
}

/**
 * Decide what, if anything, to mix into `system.wav`.
 *
 * THE GATE: an empty result means the session is left exactly as it was —
 * no file is read, written or renamed. That is every session with the setting
 * off, every Meet and Zoom call, and every call whose tap heard only silence.
 *
 * Placement is on the MIC's clock, not `system.wav`'s. The transcript merge
 * treats sample 0 of both tracks as the same instant, and on a phone call the
 * thing that must line up is the other side's turns against YOUR turns. The
 * mic's first sample is derived backwards from when it was stopped
 * (`micAudioStartMs`), the same self-correcting move `planStitch` uses.
 *
 * @param {object} input
 * @param {Array} input.segments - from `parseCallManifest`
 * @param {number} input.micAudioStartMs - epoch ms of mic.wav's first sample
 * @param {number} [input.threshold] - Int16 peak below which a segment is silence
 * @returns {Array<{file: string, offsetMs: number, trimHeadMs: number, sampleRate: number, headerRate: number}>}
 */
function planCallMix({ segments, micAudioStartMs, threshold = SILENCE_PEAK_THRESHOLD }) {
  if (!Array.isArray(segments) || !Number.isFinite(micAudioStartMs)) return [];

  return segments
    .filter((s) => s.frames > 0 && s.peak >= threshold)
    .map((s) => {
      const offset = s.startEpochMs - micAudioStartMs;
      return {
        file: s.file,
        // A call already running when recording started: drop the part of the
        // segment from before the mic's first sample rather than shift it.
        offsetMs: Math.max(0, Math.round(offset)),
        trimHeadMs: Math.max(0, Math.round(-offset)),
        sampleRate: effectiveSampleRate(s),
        headerRate: s.sampleRate
      };
    });
}

/**
 * sox arguments turning one segment into a 16 kHz mono track that starts at
 * its place on the recording's clock. `trim` runs before `pad` on purpose: the
 * head is cut in the segment's own time, then silence is added in front.
 * `-D` (no dither) here and in `mixArgs` keeps the padding exact zeros, so the
 * mix leaves every ScreenCaptureKit sample outside the call bit-identical.
 *
 * @param {string} input
 * @param {string} output
 * @param {{offsetMs: number, trimHeadMs: number}} plan
 * @returns {string[]}
 */
function segmentPrepArgs(input, output, plan) {
  return [
    '-D',
    input,
    '-r', String(TARGET_RATE), '-b', '16', '-c', '1',
    output,
    'trim', (plan.trimHeadMs / 1000).toFixed(3),
    'pad', (plan.offsetMs / 1000).toFixed(3)
  ];
}

/**
 * sox arguments mixing the prepared segments into the system track.
 *
 * `-v 1` on every input is load-bearing: `sox -m` otherwise scales each input
 * by 1/n, which would quietly halve the level of every existing system track
 * a call is mixed into.
 *
 * @param {string} systemFile
 * @param {string[]} prepared
 * @param {string} output
 * @returns {string[]}
 */
function mixArgs(systemFile, prepared, output) {
  const args = ['-D', '-m', '-v', '1', systemFile];
  for (const file of prepared) args.push('-v', '1', file);
  args.push(output);
  return args;
}

/**
 * Rewrite a 16-bit mono WAV header's rate fields, in a buffer copy.
 *
 * @param {Buffer} wav
 * @param {number} rate
 * @returns {Buffer}
 */
function withSampleRate(wav, rate) {
  const copy = Buffer.from(wav);
  copy.writeUInt32LE(rate, 24);
  copy.writeUInt32LE(rate * 2, 28);
  return copy;
}

/**
 * Mix planned call segments into `system.wav`.
 *
 * Only ever called with a non-empty plan. The original is stepped aside to
 * `system.sck.wav` rather than overwritten, the segment files are never
 * deleted, and the two renames are a pair: if the second fails the first is
 * undone, so the worst outcome is `system.wav` exactly as ScreenCaptureKit
 * wrote it — which is what the session would have had without this feature.
 *
 * @param {object} input
 * @param {string} input.sessionDir
 * @param {string} input.systemFile
 * @param {Array} input.plan - non-empty, from `planCallMix`
 * @param {(args: string[]) => Promise<void>} input.runSox
 * @param {object} [input.fsImpl]
 * @returns {Promise<{mixed: boolean, reason?: string}>}
 */
async function mixCallAudio({ sessionDir, systemFile, plan, runSox, fsImpl = fs }) {
  if (!Array.isArray(plan) || plan.length === 0) return { mixed: false, reason: 'no call audio' };
  if (!fsImpl.existsSync(systemFile)) return { mixed: false, reason: 'system.wav is missing' };

  const scratch = [];
  try {
    const prepared = [];
    for (const [i, segment] of plan.entries()) {
      let input = path.join(sessionDir, segment.file);
      if (segment.sampleRate !== segment.headerRate) {
        // The raw segment is the only copy of the call; correct a copy.
        const fixed = path.join(sessionDir, `call.rate${i}.wav`);
        fsImpl.writeFileSync(fixed, withSampleRate(fsImpl.readFileSync(input), segment.sampleRate));
        scratch.push(fixed);
        input = fixed;
      }
      const output = path.join(sessionDir, `call.prep${i}.wav`);
      await runSox(segmentPrepArgs(input, output, segment));
      scratch.push(output);
      prepared.push(output);
    }

    const mixedFile = path.join(sessionDir, 'system.withcall.wav');
    await runSox(mixArgs(systemFile, prepared, mixedFile));
    scratch.push(mixedFile);

    const original = path.join(sessionDir, SCK_ORIGINAL);
    fsImpl.renameSync(systemFile, original);
    try {
      fsImpl.renameSync(mixedFile, systemFile);
    } catch (err) {
      try { fsImpl.renameSync(original, systemFile); } catch { /* both failed; files remain */ }
      throw err;
    }
    return { mixed: true };
  } catch (err) {
    return { mixed: false, reason: err.message };
  } finally {
    for (const file of scratch) {
      try { if (fsImpl.existsSync(file)) fsImpl.unlinkSync(file); } catch { /* never mind */ }
    }
  }
}

/**
 * A running call-audio helper, owned by one recording session.
 */
class CallCaptureSession {
  /**
   * @param {string|null} binaryPath
   * @param {{spawn?: Function, existsSync?: Function, readFileSync?: Function, onSpawn?: Function, setTimeout?: Function, clearTimeout?: Function}} [deps]
   *   `onSpawn` receives the child so the app can register it for the quit
   *   drain (invariants #3/#21).
   */
  constructor(binaryPath, deps = {}) {
    this.binaryPath = binaryPath;
    this._spawn = deps.spawn || defaultSpawn;
    this._exists = deps.existsSync || fs.existsSync;
    this._readFile = deps.readFileSync || fs.readFileSync;
    this._onSpawn = deps.onSpawn || null;
    this._setTimeout = deps.setTimeout || setTimeout;
    this._clearTimeout = deps.clearTimeout || clearTimeout;
    this._reset();
  }

  _reset() {
    this.process = null;
    this.sessionDir = null;
    this.events = [];
    this.status = 'idle';
    this.reason = null;
    this._exited = null;
  }

  /**
   * Start watching for calls. Reports, never throws.
   *
   * @param {string} sessionDir
   * @param {Function|null} [warningCallback]
   * @returns {{started: boolean, status: string, reason: string|null}}
   */
  start(sessionDir, warningCallback = null) {
    this._reset();
    this.sessionDir = sessionDir;

    if (!this.binaryPath || !this._exists(this.binaryPath)) {
      this.status = 'unavailable';
      this.reason = 'the call-audio-tap helper was not found (npm run build:native)';
      return this._result(false);
    }

    let proc;
    try {
      proc = this._spawn(this.binaryPath, buildCallArgs(sessionDir));
    } catch (err) {
      this.status = 'error';
      this.reason = `could not start call audio: ${err.message}`;
      return this._result(false);
    }

    this.process = proc;
    this.status = 'starting';
    if (this._onSpawn) {
      try { this._onSpawn(proc); } catch { /* registration is best effort */ }
    }

    this._exited = new Promise((resolve) => {
      proc.on('exit', (code) => {
        this.process = null;
        if (this.status === 'stopping' || code === 0) this.status = 'stopped';
        else if (code === 69) this.status = 'unavailable';
        else {
          this.status = 'error';
          this.reason = this.reason || `call audio helper exited with code ${code}`;
        }
        resolve();
      });
    });

    let buffer = '';
    proc.stdout?.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const event = parseCallEvent(line);
        if (event) this._record(event, warningCallback);
      }
    });

    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(text);
    });

    proc.on('error', (err) => {
      this.status = 'error';
      this.reason = err.message;
    });

    return this._result(true);
  }

  _record(event, warningCallback) {
    // Events are kept for the manifest but capped: they describe a session,
    // and a flapping daemon must not grow the manifest without bound.
    if (this.events.length < 100) this.events.push({ ...event, at: Date.now() });

    if (event.event === 'ready') this.status = 'watching';
    else if (event.event === 'segment-start') this.status = 'capturing';
    else if (event.event === 'segment-end') this.status = 'watching';
    else if (event.event === 'unavailable') {
      this.status = 'unavailable';
      this.reason = event.detail || null;
    } else if (event.event === 'error') {
      this.reason = event.detail || 'call audio error';
      if (warningCallback) warningCallback(`Call audio: ${this.reason}`);
    } else if (event.event === 'silent-tap') {
      // Only reachable DURING a call — the one place this feature can speak up.
      if (warningCallback) {
        warningCallback('Call audio is recording silence. Allow CXNotes under System Settings → Privacy & Security → Screen & System Audio Recording.');
      }
    }
  }

  _result(started) {
    return { started, status: this.status, reason: this.reason };
  }

  /**
   * Stop the helper and report what it recorded. Always resolves, within
   * CALL_STOP_GRACE_MS plus a moment: a hung helper costs call audio, never
   * the stop.
   *
   * @returns {Promise<object>} see `summary`
   */
  async stop() {
    const proc = this.process;
    if (proc) {
      this.status = 'stopping';
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      await new Promise((resolve) => {
        const timer = this._setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, CALL_STOP_GRACE_MS);
        this._exited.then(() => { this._clearTimeout(timer); resolve(); });
      });
    }
    return this.summary();
  }

  /** Force-kill for emergency shutdown. */
  kill() {
    if (this.process) {
      try { this.process.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  /**
   * @returns {{status: string, reason: string|null, segments: Array, events: Array}}
   */
  summary() {
    let segments = [];
    if (this.sessionDir) {
      const file = path.join(this.sessionDir, CALL_MANIFEST);
      try {
        if (this._exists(file)) segments = parseCallManifest(this._readFile(file, 'utf-8'));
      } catch {
        segments = [];
      }
    }
    return { status: this.status, reason: this.reason, segments, events: this.events };
  }
}

module.exports = {
  CallCaptureSession,
  resolveCallBinaryPath,
  buildCallArgs,
  parseCallEvent,
  parseCallManifest,
  effectiveSampleRate,
  planCallMix,
  segmentPrepArgs,
  mixArgs,
  withSampleRate,
  mixCallAudio,
  CALL_MANIFEST,
  SCK_ORIGINAL,
  CALL_STOP_GRACE_MS,
  STANDARD_RATES
};
