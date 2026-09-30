const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { checkSckAvailable, findDefaultOutputDevice } = require('../utils/audioDevices');
const { repairWavHeader, measureWavPeak } = require('../utils/audioProcessing');
const { requireBinary } = require('../utils/binaries');
const { planCallMix, mixCallAudio } = require('./callCapture');

/**
 * sox by ABSOLUTE path.
 *
 * NEVER spawn the bare name: a Dock-launched app has no Homebrew on its PATH,
 * so `spawn('sox')` fails with ENOENT on every machine except the one that
 * built the app (see utils/binaries.js). Resolved per call and cached there, so
 * installing sox and retrying works without a restart.
 */
function soxBin() {
  return requireBinary('sox', { installHint: 'brew install sox' });
}

/** Bytes in a bare WAV header — a file this size holds no audio frames yet. */
const WAV_HEADER_BYTES = 44;

/**
 * Exit code the SCK helper uses when its capture stream dies mid-session.
 *
 * Mirrors `EXIT_STREAM_DIED` in `native/sck-audio-capture/Sources/AudioCapture.swift`.
 * The helper used to log the failure, stop writing, and then idle until it was
 * asked to stop — at which point it exited 0 and a 29-minute meeting captured as
 * 114 seconds was filed as complete. A non-zero exit is the channel the parent
 * already watches.
 */
const EXIT_STREAM_DIED = 4;

/** How often to re-check whether SCK has started producing audio. */
const SCK_HEALTH_POLL_MS = 500;

/**
 * How long to wait for SCK's FIRST audio bytes before declaring it dead.
 *
 * ScreenCaptureKit enumerates every display, window and running application
 * before its stream delivers a frame, so first-audio latency scales with how
 * busy the machine is: ~1.7s warm, but ~2.5-3s cold on a Mac with several
 * displays and hundreds of open windows. The old check was a single-shot
 * timeout at exactly 3000ms, which lost that race and declared a perfectly
 * healthy SCK dead.
 *
 * 8s gives ample headroom over the worst observed cold start while still
 * raising the alarm inside a meeting's opening remarks.
 *
 * Crossing it is now a WARNING, not a switch. It used to hand the session to
 * sox+BlackHole, which records silence unless the user has routed system
 * output through a Multi-Output Device — so a slow-but-healthy SCK was
 * converted into a meeting that captured nothing. Warning keeps the mic track
 * and lets a late SCK recover; failing over guaranteed the loss.
 */
const SCK_START_TIMEOUT_MS = 8000;

/**
 * Decide whether a starting SCK capture is alive, still warming up, or dead.
 *
 * Pure so it can be unit-tested without timers or a real capture.
 *
 * @param {number} sizeBytes - Current size of the capture file (0 if missing)
 * @param {number} elapsedMs - Time since the SCK process was spawned
 * @param {number} [timeoutMs=SCK_START_TIMEOUT_MS] - Give-up threshold
 * @returns {'alive'|'wait'|'dead'}
 */
function sckStartupVerdict(sizeBytes, elapsedMs, timeoutMs = SCK_START_TIMEOUT_MS) {
  // Any bytes beyond the header mean frames are landing — SCK is up.
  if (sizeBytes > WAV_HEADER_BYTES) return 'alive';
  if (elapsedMs >= timeoutMs) return 'dead';
  return 'wait';
}

/**
 * Poll a freshly-spawned SCK capture until it produces audio (or gives up).
 *
 * Replaces a one-shot setTimeout: a slow start is no longer mistaken for a
 * dead capture. Stops polling as soon as the verdict is decided, and never
 * fires `onNoAudio` once the file has real frames.
 *
 * `onNoAudio` WARNS — it does not swap capture methods and does not touch the
 * file. The recording continues, because the mic track is still worth keeping
 * and a late SCK can still start delivering.
 *
 * @param {object} opts
 * @param {Function} opts.getFilePath - Returns the capture file path
 * @param {Function} opts.isRecording - Returns whether recording is still live
 * @param {Function} opts.onNoAudio - Called if SCK never produced audio
 * @param {Function} [opts.onDecided] - Called with the final verdict
 * @returns {*} Interval handle (clear with clearInterval)
 */
function watchSckStartup({
  getFilePath,
  isRecording,
  onNoAudio,
  onDecided,
  pollMs = SCK_HEALTH_POLL_MS,
  timeoutMs = SCK_START_TIMEOUT_MS,
  _fs = fs,
  _setInterval = setInterval,
  _clearInterval = clearInterval,
  _now = Date.now
}) {
  const state = { handle: null, startedAt: _now(), settled: false };

  const settle = (verdict) => {
    if (state.settled) return;
    state.settled = true;
    if (state.handle !== null) _clearInterval(state.handle);
    if (onDecided) onDecided(verdict);
  };

  const tick = () => {
    if (state.settled) return;
    if (!isRecording()) { settle('stopped'); return; }

    let size = 0;
    try {
      size = _fs.statSync(getFilePath()).size;
    } catch {
      // File not created yet — treated as 0 bytes, keep waiting.
    }

    const verdict = sckStartupVerdict(size, _now() - state.startedAt, timeoutMs);
    if (verdict === 'wait') return;

    settle(verdict);
    if (verdict === 'dead') {
      console.warn(
        `SCK produced no audio data after ${timeoutMs}ms — warning; capture continues`
      );
      onNoAudio();
    } else {
      console.log('SCK is producing audio — staying on ScreenCaptureKit');
    }
  };

  state.handle = _setInterval(tick, pollMs);
  // If the interval already fired synchronously (test doubles), honour the settle.
  if (state.settled) _clearInterval(state.handle);
  return state.handle;
}

/**
 * Build the user-facing warning for an SCK capture that produced no audio.
 *
 * Naming the live output device keeps the warning diagnosable: a silent system
 * track alongside "Output is currently AirPods Pro" is a very different
 * investigation from one where output is a virtual device with nothing behind
 * it (gotcha #5's ARK/coreaudiod wedge, or an aggregate carrying no signal).
 *
 * @param {string} [outputDevice] - Current default output device name
 * @returns {string}
 */
function sckSilentWarning(outputDevice) {
  const base =
    'ScreenCaptureKit is producing no audio — the system track will be silent. ' +
    'The microphone is still recording.';
  if (!outputDevice) return base;
  return `${base} Current output device: "${outputDevice}".`;
}

/**
 * Determine how system audio will be captured.
 *
 * ScreenCaptureKit is the ONLY method. There is deliberately no fallback:
 * sox+BlackHole was removed because it could not fail loudly. BlackHole is a
 * virtual cable, so unless the user has routed system output through a
 * Multi-Output Device it carries nothing, and the fallback produced a
 * correctly-sized, digitally-silent WAV that only surfaced after the meeting.
 * In 58 recorded sessions it engaged once and that session was a total loss.
 * A refusal here is recoverable in seconds; a silent recording is not
 * recoverable at all.
 *
 * The two failure causes are reported separately because the fixes differ —
 * one is "build the helper", the other is "grant the permission". Collapsing
 * them into one message is what made the old error name two wrong fixes.
 *
 * @param {string|null} sckBinaryPath - Path to sck-audio-capture binary
 * @param {{_check?: Function, _exists?: Function}} [deps] - test injection, matching `_exec`/`_fs` elsewhere
 * @returns {{method: 'sck', sckBinaryPath: string}}
 * @throws {Error} If SCK is unavailable or unpermitted
 */
function resolveSystemCaptureMethod(
  sckBinaryPath,
  { _check = checkSckAvailable, _exists = fs.existsSync } = {}
) {
  // An unbuilt helper and an unsupported OS both surface as "SCK unavailable",
  // but the fixes are opposite, so the missing FILE is checked first. Deriving
  // this from checkSckAvailable's reason string would work today and break the
  // moment that wording changes; the file either exists or it does not.
  if (!sckBinaryPath || !_exists(sckBinaryPath)) {
    throw new Error(
      'System audio capture is unavailable: the sck-audio-capture helper was not found.\n' +
      'Build it with: npm run build:native'
    );
  }

  const sckStatus = _check(sckBinaryPath);

  if (sckStatus.available && sckStatus.permitted) {
    console.log('System audio capture: using ScreenCaptureKit');
    return { method: 'sck', sckBinaryPath };
  }

  if (sckStatus.available && sckStatus.permitted === false) {
    throw new Error(
      'System audio capture is unavailable: Screen Recording permission has not been granted.\n' +
      'Grant it in System Settings > Privacy & Security > Screen Recording, then restart CXNotes.'
    );
  }

  throw new Error(
    `System audio capture is unavailable: ${sckStatus.reason || 'ScreenCaptureKit could not start'}.\n` +
    'ScreenCaptureKit requires macOS 13 or later.'
  );
}

/**
 * ============================================
 * Restarting system capture in place
 * ============================================
 *
 * When the system capture dies or is proven to be delivering nothing, the fix
 * is to start it again — NOT to switch to another capture method (invariant #1).
 * The mic track is never involved: the two tracks are independent processes
 * writing independent files, and a restart signals only `systemProcess`.
 *
 * A restarted capture writes to a NEW file, because the helper truncates
 * whatever path it is handed — pointing it back at `system.wav` would delete
 * everything recorded so far. The parts are stitched back into one file at stop.
 */

/** A session gets at most this many restarts before it stops trying. */
const SYSTEM_RESTART_MAX = 2;

/**
 * Minimum gap between restarts.
 *
 * Guards against a capture that dies instantly and repeatedly: without it, a
 * helper failing on spawn would burn the entire restart budget inside a second
 * and fill the session directory with empty parts.
 */
const SYSTEM_RESTART_MIN_INTERVAL_MS = 30000;

/**
 * How long the outgoing helper gets to finalise its WAV during a restart.
 *
 * Much shorter than the 10s used at stop, because every second here is a second
 * of the meeting that neither part is recording. The helper only has to flush
 * and patch a header, which is immediate; the grace exists so a wedged process
 * cannot stall the replacement indefinitely.
 */
const RESTART_STOP_GRACE_MS = 2000;

/** 16 kHz, 16-bit, mono — the format both tracks are recorded in. */
const BYTES_PER_SECOND = 16000 * 2;

/**
 * How much audio a capture file holds, from its size alone.
 *
 * @param {number} bytes - Total file size including the 44-byte header
 * @returns {number} Duration in ms (0 for a header-only or missing file)
 */
function wavDurationMs(bytes) {
  const dataBytes = Math.max(0, (bytes || 0) - WAV_HEADER_BYTES);
  return Math.round((dataBytes / BYTES_PER_SECOND) * 1000);
}

/**
 * Work out how to reassemble the capture parts into one continuous track.
 *
 * Pure, and separated from the sox call because the arithmetic is the part that
 * can be quietly wrong. The padding is NOT cosmetic: `transcriptMerger` orders
 * the merged transcript by each file's own internal offsets, so if the system
 * track is shorter than the wall-clock time it spans, everything after the gap
 * is attributed to the wrong moment and the two speakers interleave wrongly for
 * the rest of the meeting.
 *
 * A part's audio does not begin when its process was spawned — ScreenCaptureKit
 * takes 1.7-3s to deliver its first frame. So rather than trusting the spawn
 * time, each part's true audio start is derived backwards from the moment it
 * stopped: a helper writes continuously until it is killed, so
 * `audioStart = stoppedAt - duration`. That is self-correcting for startup
 * latency of any size, which a spawn-time calculation is not.
 *
 * The gap inserted between two parts is therefore the wall-clock time between
 * one part's last sample and the next part's first, and is always interior —
 * `trimSilence` only ever trims leading and trailing silence, so it cannot eat
 * a pad and re-break the alignment this exists to preserve.
 *
 * @param {Array<{file: string, bytes: number, stoppedAt: number}>} parts - in order
 * @returns {Array<{type: 'part', file: string}|{type: 'pad', ms: number}>}
 */
function planStitch(parts) {
  const segments = [];

  parts.forEach((part, i) => {
    if (i > 0) {
      const previous = parts[i - 1];
      const audioStart = part.stoppedAt - wavDurationMs(part.bytes);
      // Clock skew, or a part that outlived its recorded stop time, must never
      // produce a negative pad — that would silently shorten the track.
      const gapMs = Math.max(0, audioStart - previous.stoppedAt);
      if (gapMs > 0) segments.push({ type: 'pad', ms: gapMs });
    }
    segments.push({ type: 'part', file: part.file });
  });

  return segments;
}

/**
 * Statuses that a clean stop must NOT overwrite.
 *
 * The stop path used to end with `status = size > 0 ? 'complete' : 'empty'`,
 * which is only a size check — and a zero-filled WAV has a perfectly healthy
 * size. So a track already marked `silent` mid-flight was relabelled `complete`
 * on the way out, and every downstream consumer, badge and note read it as a
 * successful capture. The mid-flight verdict was made with evidence this one
 * does not have; it wins.
 */
const STICKY_TRACK_STATUSES = new Set(['silent', 'failed', 'error']);

/**
 * The status a track should carry once recording has stopped.
 *
 * `measuredSilent` outranks the running bookkeeping, and has to. A restart
 * resets the track's status to `'recording'` — it must, because the replacement
 * capture may well be healthy — and that quietly ERASES a `'silent'` verdict
 * reached before it. So a session that was judged dead, restarted, and stopped
 * before the (deliberately long) second verdict could land would end up labelled
 * `'complete'` while holding nothing but zeroes. That is the original bug
 * wearing a different hat, and no amount of in-flight flag juggling fixes it;
 * only reading the file does.
 *
 * A sticky status still wins over `measuredSilent`, because `'failed'` explains
 * the silence and is strictly more informative than restating it.
 *
 * @param {string} currentStatus - status as left by the recording
 * @param {number} sizeBytes
 * @param {{measuredSilent?: boolean}} [evidence] - from an actual scan of the file
 * @returns {string}
 */
function resolveFinalTrackStatus(currentStatus, sizeBytes, { measuredSilent = false } = {}) {
  if (!sizeBytes) return 'empty';
  if (STICKY_TRACK_STATUSES.has(currentStatus)) return currentStatus;
  if (measuredSilent) return 'silent';
  return 'complete';
}

/** Run sox with the given arguments, rejecting on a non-zero exit. */
function runSox(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(soxBin(), args);
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('error', (err) => reject(new Error(`sox: ${err.message}`)));
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sox exited ${code}: ${stderr.trim().split('\n').pop()}`));
    });
  });
}

/**
 * Write a WAV of pure silence, in the same format as the capture tracks.
 *
 * @param {string} outputFile
 * @param {number} ms
 */
function generateSilenceWav(outputFile, ms) {
  return runSox([
    '-n', '-r', '16000', '-b', '16', '-c', '1',
    outputFile,
    'trim', '0.0', (ms / 1000).toFixed(3)
  ]);
}

/** How often the size monitor looks at the growing file. */
const SIZE_CHECK_INTERVAL_MS = 30000;

/** Warn once a single recording passes this. */
const MAX_RECORDING_BYTES = 1024 * 1024 * 1024;

/** How long a capture process gets to exit on SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 10000;

/** Breathing room after SIGKILL for the last bytes to reach disk. */
const POST_KILL_SETTLE_MS = 200;

/**
 * `YYYY-MM-DD_HH-MM-SS`, from an ISO instant.
 *
 * Both recorders name their output with this, and both used to build it from
 * the same chain of replaces. The exact shape is load-bearing beyond cosmetics:
 * session directories are matched by `SESSION_STAMP` in the summariser to
 * recover a meeting's date, and the recordings list sorts on it.
 *
 * @param {Date} [now]
 * @returns {string}
 */
function sessionTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/**
 * The message shown when a recording grows past the size ceiling.
 *
 * Pure, so the wording and the rounding can be tested without waiting out a
 * 30-second interval against a gigabyte file.
 *
 * @param {number} bytes
 * @returns {string}
 */
function oversizeWarning(bytes) {
  const megabytes = Math.round(bytes / (1024 * 1024));
  return `Recording size is ${megabytes}MB. Consider stopping to avoid disk space issues.`;
}

/**
 * Single-track recorder: system audio only, one WAV, no session directory.
 *
 * Reached when `recordingMode` is `'system'`. Dual-track is the default and is
 * handled by DualTrackRecorder below; this path exists for capturing a call
 * where the microphone is not wanted, and it produces a flat file rather than a
 * session, which is why the skeleton and marker features skip it (invariants
 * #13 and #16).
 *
 * Capture is ScreenCaptureKit, and only ScreenCaptureKit. If it starts but
 * never delivers audio (gotcha #5) the session warns and keeps recording
 * rather than switching methods — see resolveSystemCaptureMethod.
 */
class Recorder {
  /**
   * @param {string} outputDir - base directory for recordings
   * @param {string|null} [sckBinaryPath] - path to the sck-audio-capture binary
   */
  constructor(outputDir, sckBinaryPath = null) {
    this.outputDir = outputDir;
    this.sckBinaryPath = sckBinaryPath;

    this.captureProcess = null;
    this.captureMethod = null;
    this.currentFile = null;

    this.isRecording = false;
    this.startTime = null;

    this.sizeInterval = null;
    this._sckHealthInterval = null;
    this.maxRecordingSize = MAX_RECORDING_BYTES;
  }

  /**
   * Begin capturing.
   *
   * @param {Function} [warningCallback] - receives size and permission warnings
   * @returns {{filepath: string, startTime: number, captureMethod: string}}
   * @throws {Error} if a recording is already running
   */
  start(warningCallback) {
    if (this.isRecording) {
      throw new Error('A recording is already running — stop it before starting another.');
    }

    const recordingsDir = path.join(this.outputDir, 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }

    this.currentFile = path.join(recordingsDir, `${sessionTimestamp()}_recording.wav`);

    // Resolve capture method
    const capture = resolveSystemCaptureMethod(this.sckBinaryPath);
    this.captureMethod = capture.method;

    this.captureProcess = spawn(capture.sckBinaryPath, [
      this.currentFile,
      '--sample-rate', '16000',
      '--channels', '1',
      '--bit-depth', '16'
    ]);
    console.log('Using ScreenCaptureKit for system audio capture');

    // NOTE: throwing from an 'error' listener does not reach start()'s caller —
    // it surfaces as an uncaught exception. Preserved as-is rather than quietly
    // changed, because altering it changes what happens when a capture binary
    // fails to spawn, which is not something to alter blind.
    this.captureProcess.on('error', (err) => {
      console.error(`${this.captureMethod} process error:`, err);
      this.isRecording = false;
      throw new Error(`Could not start the recorder: ${err.message}`);
    });

    this.captureProcess.on('exit', (code, signal) => {
      if (!this.isRecording) return;

      console.error(`${this.captureMethod} process exited unexpectedly: code=${code}, signal=${signal}`);
      // SCK exits 2 when Screen Recording has not been granted, and that is a
      // thing the user can actually fix — so say so rather than dying silently.
      if (this.captureMethod === 'sck' && code === 2 && warningCallback) {
        warningCallback('Screen Recording permission denied. Please grant permission in System Settings.');
      } else if (warningCallback) {
        // Single-track mode has no second track to fall back on and no restart
        // path, so an ending here ends the recording outright: `isRecording`
        // goes false, `stopRecording()` then skips as "nothing to stop", and the
        // audio captured so far is never auto-processed. It is still on disk and
        // still listed with a Process button, but only if the user is told the
        // recording ended — otherwise they discover it after the meeting, which
        // is the whole failure mode this app is supposed to have stopped having.
        // Exit code 4 is the helper reporting its capture stream died under it.
        warningCallback(
          code === EXIT_STREAM_DIED
            ? 'System audio capture stopped unexpectedly — the recording has ended. '
              + 'What was captured is saved and can be processed from Recordings.'
            : `System audio capture exited (code ${code}) — the recording has ended. `
              + 'What was captured is saved and can be processed from Recordings.'
        );
      }
      this.isRecording = false;
    });

    this.captureProcess.stderr.on('data', (data) => {
      console.log(`${this.captureMethod} stderr: ${data}`);
    });

    this.isRecording = true;
    this.startTime = Date.now();

    // SCK can start cleanly and still deliver nothing but zeroed frames, so
    // health is judged by whether the file actually grows (gotcha #5). This
    // WARNS and keeps recording — it no longer swaps capture methods.
    this._sckHealthInterval = watchSckStartup({
      getFilePath: () => this.currentFile,
      isRecording: () => this.isRecording,
      onNoAudio: () => {
        if (warningCallback) warningCallback(sckSilentWarning(findDefaultOutputDevice()));
      }
    });

    if (warningCallback) this.startSizeMonitor(warningCallback);

    return {
      filepath: this.currentFile,
      startTime: this.startTime,
      captureMethod: this.captureMethod
    };
  }

  /** Drop both polling timers. Safe to call when neither is running. */
  _clearTimers() {
    for (const key of ['_sckHealthInterval', 'sizeInterval']) {
      if (!this[key]) continue;
      clearInterval(this[key]);
      this[key] = null;
    }
  }

  /**
   * Stop capturing and settle once the file is on disk.
   *
   * Resolves only after the capture process has exited, because the last block
   * of audio is written on the way out. If it will not go quietly it is killed
   * after a grace period and the file is taken as-is — a recording that exists
   * is worth more than a clean shutdown.
   *
   * @returns {Promise<{filepath: string, duration: number, size: number}>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.isRecording || !this.captureProcess) {
        reject(new Error('Nothing is being recorded right now'));
        return;
      }

      // Read the duration and drop the flag up front, so the tray stops showing
      // a live recording the moment the user asks for it rather than after the
      // process finally exits.
      const duration = Date.now() - this.startTime;
      this.isRecording = false;
      this._clearTimers();

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;

        if (!fs.existsSync(this.currentFile)) {
          reject(new Error('No recording file appeared on disk'));
          return;
        }

        // SCK does not always finalise the header when killed, which leaves a
        // file every player reads as zero-length.
        repairWavHeader(this.currentFile);

        const { size } = fs.statSync(this.currentFile);
        if (size === 0) {
          reject(new Error('The recording is 0 bytes — check that audio is routed to the capture device.'));
          return;
        }

        resolve({ filepath: this.currentFile, duration, size });
      };

      this.captureProcess.on('exit', finish);

      try {
        this.captureProcess.kill('SIGTERM');
      } catch (err) {
        reject(new Error(`Could not stop the recorder: ${err.message}`));
        return;
      }

      setTimeout(() => {
        if (settled) return;
        console.warn(`Recorder process did not exit after ${STOP_GRACE_MS / 1000}s — sending SIGKILL`);
        try {
          this.captureProcess.kill('SIGKILL');
        } catch { /* already gone */ }
        setTimeout(finish, POST_KILL_SETTLE_MS);
      }, STOP_GRACE_MS);
    });
  }

  /**
   * Current recording, or null when idle.
   *
   * @returns {{isRecording: boolean, duration: number, filepath: string}|null}
   */
  getStatus() {
    if (!this.isRecording) return null;

    return {
      isRecording: true,
      duration: Date.now() - this.startTime,
      filepath: this.currentFile
    };
  }

  /**
   * Warn once the file passes the size ceiling.
   *
   * Warns rather than stops: a long meeting is a legitimate thing to record,
   * and losing it to an automatic cut-off would be far worse than a big file.
   *
   * @param {Function} callback
   * @private
   */
  startSizeMonitor(callback) {
    this.sizeInterval = setInterval(() => {
      if (!this.isRecording || !this.currentFile) {
        this._clearTimers();
        return;
      }

      let size;
      try {
        ({ size } = fs.statSync(this.currentFile));
      } catch {
        return; // not created yet, or vanished — nothing to report either way
      }

      if (size > this.maxRecordingSize) callback(oversizeWarning(size));
    }, SIZE_CHECK_INTERVAL_MS);
  }

  /**
   * Tear everything down without waiting — for app quit.
   *
   * Unlike stop() this makes no promises about the file. It also clears the SCK
   * health timer, which the previous version left running: an interval holding
   * a closure over a dead recorder kept the process alive at quit.
   */
  cleanup() {
    this._clearTimers();

    if (this.captureProcess && this.isRecording) {
      try {
        this.captureProcess.kill('SIGKILL');
      } catch { /* already gone */ }
    }

    this.isRecording = false;
  }
}

/**
 * Dual-Track Audio Recorder
 *
 * Records system audio (ScreenCaptureKit) and microphone audio (sox)
 * simultaneously as separate tracks in a session directory.
 * Enables pseudo-speaker separation.
 */
class DualTrackRecorder {
  /**
   * Create a new DualTrackRecorder
   *
   * @param {string} outputDir - Base directory for recordings
   * @param {string} micDevice - Microphone device name for sox
   * @param {string} [systemLabel='Remote'] - Label for system audio speaker
   * @param {string} [micLabel='Me'] - Label for mic audio speaker
   * @param {string|null} [sckBinaryPath=null] - Path to sck-audio-capture binary
   * @param {object} [meetingContext={}] - Meeting context (title, participants, agenda)
   * @param {object|null} [slideCapture=null] - A `SlideCaptureSession`, or null
   *   when slide capture is off. Injected rather than constructed here so the
   *   recorder never learns where the helper binary lives, and so a test can
   *   pass a fake without a built helper or a Screen Recording grant.
   * @param {object} [slideOptions={}] - Source hints forwarded to the helper
   * @param {object|null} [callCapture=null] - A `CallCaptureSession`, or null
   *   when call audio is off. Injected for the same reasons as `slideCapture`.
   */
  constructor(outputDir, micDevice, systemLabel = 'Remote', micLabel = 'Me', sckBinaryPath = null, meetingContext = {}, slideCapture = null, slideOptions = {}, callCapture = null) {
    this.outputDir = outputDir;
    this.micDevice = micDevice;
    this.systemLabel = systemLabel;
    this.micLabel = micLabel;
    this.sckBinaryPath = sckBinaryPath;
    this.meetingContext = meetingContext;
    this.slideCapture = slideCapture;
    this.slideOptions = slideOptions;
    this.callCapture = callCapture;
    this.systemProcess = null;
    this.micProcess = null;
    this.captureMethod = null;
    this.sessionDir = null;
    this.systemFile = null;
    this.micFile = null;
    this.isRecording = false;
    this.startTime = null;
    this.manifest = null;

    // Every system-capture file this session has written, in order. One entry
    // unless the capture had to be restarted; stitched back into `system.wav`
    // at stop. Never emptied — see `stitchSystemParts`.
    this.systemParts = [];
    this.systemRestartCount = 0;
    this.lastSystemRestartAt = 0;
    // Set while we are deliberately killing the system helper, so its `exit`
    // handler can tell our own restart apart from the capture dying on us.
    this._restartingSystem = false;
    this._stopping = false;
    // Called with the new capture file after a restart, so the level monitor
    // can follow the track to its new file.
    this.onSystemPartChange = null;
    // Seam, matching the `_check`/`_exists` injection in
    // `resolveSystemCaptureMethod`: lets the restart path be tested without a
    // built helper or a Screen Recording grant.
    this._resolveCapture = () => resolveSystemCaptureMethod(this.sckBinaryPath);
  }

  /** Path for the Nth system capture file (part 1 is plain `system.wav`). */
  _systemPartPath(index) {
    return index === 0
      ? path.join(this.sessionDir, 'system.wav')
      : path.join(this.sessionDir, `system.part${index + 1}.wav`);
  }

  /**
   * Spawn the system capture helper against a given file, and wire its handlers.
   *
   * Shared by the initial start and every restart so the two cannot drift in
   * how they report errors or register parts.
   *
   * @param {string} binaryPath
   * @param {string} outputFile
   * @param {Function} [warningCallback]
   * @param {Function} [onUnexpectedExit] - called when the helper dies on its own
   * @returns {object} the spawned process
   */
  _spawnSystemCapture(binaryPath, outputFile, warningCallback, onUnexpectedExit) {
    const proc = spawn(binaryPath, [
      outputFile,
      '--sample-rate', '16000',
      '--channels', '1',
      '--bit-depth', '16'
    ]);

    proc.on('error', (err) => {
      console.error('System capture process error:', err);
      this.manifest.tracks.system.status = 'error';
      if (warningCallback) warningCallback(`System audio error: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      // A restart kills this process on purpose, and a stop kills it in the
      // ordinary way. Neither is the capture failing.
      if (this._restartingSystem || this._stopping || !this.isRecording) return;

      console.error(`System capture exited unexpectedly: code=${code}, signal=${signal}`);
      this.manifest.tracks.system.status = 'failed';

      if (this.captureMethod === 'sck' && code === 2 && warningCallback) {
        warningCallback('Screen Recording permission denied during recording.');
      }

      // Exit code 4 is the helper reporting that its stream died under it (a
      // display reconfiguration, most often). Before it existed the helper sat
      // there and eventually exited 0, so a capture that stopped 114 seconds
      // into a 29-minute meeting was indistinguishable from a healthy one.
      if (onUnexpectedExit) onUnexpectedExit({ code, signal });
    });

    proc.stderr.on('data', (data) => {
      console.log(`system capture stderr: ${data}`);
    });

    return proc;
  }

  /**
   * Is the recording still live enough to own a new capture process?
   *
   * The one condition that can flip WHILE a restart is in flight, which is why
   * it is separate: `canRestartSystemCapture` cannot be re-run mid-restart
   * because `_restartingSystem` is true by then and it would refuse every time.
   */
  _canOwnNewCapture() {
    return this.isRecording && !this._stopping;
  }

  /**
   * Whether a restart is allowed right now, and why not if it isn't.
   *
   * @param {number} [now]
   * @returns {{allowed: boolean, reason?: string}}
   */
  canRestartSystemCapture(now = Date.now()) {
    if (!this._canOwnNewCapture()) {
      return { allowed: false, reason: 'the recording is not running' };
    }
    if (this._restartingSystem) {
      return { allowed: false, reason: 'a restart is already in progress' };
    }
    if (this.systemRestartCount >= SYSTEM_RESTART_MAX) {
      return { allowed: false, reason: `already restarted ${SYSTEM_RESTART_MAX} times` };
    }
    if (this.lastSystemRestartAt && now - this.lastSystemRestartAt < SYSTEM_RESTART_MIN_INTERVAL_MS) {
      return { allowed: false, reason: 'restarted too recently' };
    }
    return { allowed: true };
  }

  /**
   * Restart system capture in place, onto a fresh part file.
   *
   * **The microphone is not touched.** It is not signalled, paused, or reopened;
   * `micProcess` and `micFile` are not referenced here at all. `mic.wav` grows
   * straight through a restart, which is what makes this recoverable rather than
   * destructive — the worst case is a gap in one track, never a gap in both.
   *
   * This is not a fallback (invariant #1): the capture method does not change.
   * It is the same ScreenCaptureKit helper, started again, because a capture
   * that has proven it is delivering nothing has nothing left to lose.
   *
   * @param {string} reason - for the log and the warning
   * @param {Function} [warningCallback]
   * @returns {Promise<{restarted: boolean, reason?: string, file?: string}>}
   */
  async restartSystemCapture(reason, warningCallback) {
    const verdict = this.canRestartSystemCapture();
    if (!verdict.allowed) {
      console.warn(`Not restarting system capture (${verdict.reason})`);
      return { restarted: false, reason: verdict.reason };
    }

    // Resolved BEFORE anything is killed: if the helper has gone missing there
    // is no replacement to be had, and a silent capture still running is worth
    // more than no capture at all.
    const capture = this._resolveCapture();

    this._restartingSystem = true;
    console.warn(`Restarting system capture: ${reason}`);

    try {
      const dying = this.systemProcess;
      if (dying) {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          dying.on('exit', finish);
          try { dying.kill('SIGTERM'); } catch { finish(); return; }
          setTimeout(() => {
            if (done) return;
            try { dying.kill('SIGKILL'); } catch { /* already gone */ }
            setTimeout(finish, POST_KILL_SETTLE_MS);
          }, RESTART_STOP_GRACE_MS);
        });
      }

      // Ask again, now that time has passed.
      //
      // Killing the old helper takes up to RESTART_STOP_GRACE_MS, and a stop
      // landing inside that window has already captured `systemProcess` into its
      // own kill list and moved on. Spawning here would hand it a replacement it
      // will never see — an SCK helper recording forever with no one left to
      // reap it, which is gotcha #4's failure exactly. The guard at the top of
      // this function cannot cover this: it ran before the wait.
      if (!this._canOwnNewCapture()) {
        console.warn('Abandoning system capture restart — the recording has stopped');
        return { restarted: false, reason: 'the recording stopped mid-restart' };
      }

      // Close out the part that just ended: the helper finalises its own header
      // on SIGTERM, but a SIGKILLed one leaves zeroes that read as empty.
      const finished = this.systemParts[this.systemParts.length - 1];
      if (finished) {
        repairWavHeader(finished.file);
        finished.stoppedAt = Date.now();
        try {
          finished.bytes = fs.statSync(finished.file).size;
        } catch {
          finished.bytes = 0;
        }
      }

      const nextFile = this._systemPartPath(this.systemParts.length);
      this.systemProcess = this._spawnSystemCapture(
        capture.sckBinaryPath,
        nextFile,
        warningCallback,
        this._onSystemDeath
      );
      this.systemParts.push({ file: nextFile, spawnedAt: Date.now(), stoppedAt: null, bytes: 0 });

      this.systemRestartCount += 1;
      this.lastSystemRestartAt = Date.now();
      this.manifest.tracks.system.status = 'recording';
      this.manifest.tracks.system.restarts = this.systemRestartCount;

      console.log(`System capture restarted onto ${path.basename(nextFile)}`);
      if (this.onSystemPartChange) this.onSystemPartChange(nextFile);

      return { restarted: true, file: nextFile };
    } catch (err) {
      console.error(`System capture restart failed: ${err.message}`);
      if (warningCallback) {
        warningCallback(`System audio stopped and could not be restarted: ${err.message}`);
      }
      return { restarted: false, reason: err.message };
    } finally {
      this._restartingSystem = false;
    }
  }

  /**
   * Start dual-track recording
   *
   * @param {Function} [warningCallback] - Optional callback for warnings
   * @returns {{sessionDir: string, systemFile: string, micFile: string, startTime: number, captureMethod: string}}
   * @throws {Error} If already recording or devices not found
   */
  start(warningCallback) {
    if (this.isRecording) {
      throw new Error('A recording is already running — stop it before starting another.');
    }

    // Resolve system audio capture method
    const capture = resolveSystemCaptureMethod(this.sckBinaryPath);
    this.captureMethod = capture.method;

    console.log(`Microphone device: ${this.micDevice}`);

    // Create session directory
    const recordingsDir = path.join(this.outputDir, 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }

    const timestamp = sessionTimestamp();
    const sessionId = timestamp;
    this.sessionDir = path.join(recordingsDir, `${timestamp}_session`);
    fs.mkdirSync(this.sessionDir, { recursive: true });

    this.systemFile = path.join(this.sessionDir, 'system.wav');
    this.micFile = path.join(this.sessionDir, 'mic.wav');

    // Write initial manifest
    this.manifest = {
      version: 1,
      sessionId: sessionId,
      mode: 'dual',
      captureMethod: this.captureMethod,
      startTime: new Date().toISOString(),
      endTime: null,
      duration: 0,
      tracks: {
        system: {
          file: 'system.wav',
          device: 'ScreenCaptureKit',
          sampleRate: 16000,
          channels: 1,
          bitDepth: 16,
          status: 'recording',
          size: 0,
          label: this.systemLabel
        },
        mic: {
          file: 'mic.wav',
          device: this.micDevice,
          sampleRate: 16000,
          channels: 1,
          bitDepth: 16,
          status: 'recording',
          size: 0,
          label: this.micLabel
        }
      },
      meetingContext: {
        title: this.meetingContext.title || '',
        participants: this.meetingContext.participants || '',
        agenda: this.meetingContext.agenda || ''
      },
      slides: {
        enabled: Boolean(this.slideCapture),
        status: this.slideCapture ? 'starting' : 'disabled',
        reason: null,
        keyframes: 0
      },
      callAudio: {
        enabled: Boolean(this.callCapture),
        status: this.callCapture ? 'starting' : 'disabled'
      },
      processing: {
        transcription: { system: null, mic: null, merged: null },
        summarisation: null,
        obsidianExport: null
      }
    };

    fs.writeFileSync(
      path.join(this.sessionDir, 'manifest.json'),
      JSON.stringify(this.manifest, null, 2),
      'utf-8'
    );

    // Spawn system audio process (16kHz mono — matches whisper.cpp native format)
    this._stopping = false;
    this._restartingSystem = false;
    this.systemRestartCount = 0;
    this.lastSystemRestartAt = 0;
    this.systemParts = [{
      file: this.systemFile,
      spawnedAt: Date.now(),
      stoppedAt: null,
      bytes: 0
    }];

    // A capture that dies on its own is restarted in place rather than left
    // dead for the rest of the meeting. Bound once so the initial capture and
    // every replacement are handled identically.
    this._onSystemDeath = ({ code }) => {
      this.restartSystemCapture(`system capture exited (code ${code})`, warningCallback)
        .then((result) => {
          if (!result.restarted && warningCallback) {
            warningCallback(
              'System audio capture stopped and could not be restarted — '
              + 'only the microphone is being recorded from here on.'
            );
          }
        })
        .catch((err) => console.error('Restart handler failed:', err.message));
    };

    this.systemProcess = this._spawnSystemCapture(
      capture.sckBinaryPath,
      this.systemFile,
      warningCallback,
      this._onSystemDeath
    );
    console.log('System audio: ScreenCaptureKit');

    // Health check: poll until SCK produces audio. If it never does, WARN and
    // keep going — the mic track is still worth having, and killing the system
    // capture to chase a fallback is what used to lose the whole meeting.
    this._sckHealthInterval = watchSckStartup({
      getFilePath: () => this.systemFile,
      isRecording: () => this.isRecording,
      onNoAudio: () => {
        this.manifest.tracks.system.status = 'silent';
        if (warningCallback) warningCallback(sckSilentWarning(findDefaultOutputDevice()));
      }
    });

    // Spawn mic sox process (always sox)
    this.micProcess = spawn(soxBin(), [
      '-t', 'coreaudio',
      this.micDevice,
      '-r', '16000',
      '-b', '16',
      '-c', '1',
      this.micFile
    ]);

    this.micProcess.on('error', (err) => {
      console.error('Mic sox process error:', err);
      this.manifest.tracks.mic.status = 'error';
      if (warningCallback) warningCallback(`Microphone error: ${err.message}`);
    });

    this.micProcess.on('exit', (code, signal) => {
      if (this.isRecording) {
        console.error(`Mic sox exited unexpectedly: code=${code}, signal=${signal}`);
        this.manifest.tracks.mic.status = 'failed';
      }
    });

    this.micProcess.stderr.on('data', (data) => {
      console.log(`mic sox stderr: ${data}`);
    });

    this.isRecording = true;
    this.startTime = Date.now();

    // Slides start LAST and cannot fail the recording. `start` reports rather
    // than throws, and the helper is a separate process, so the worst case here
    // is a session with audio and no slides — never the other way round.
    if (this.slideCapture) {
      try {
        const slides = this.slideCapture.start(
          this.sessionDir,
          { ...this.slideOptions, startEpochMs: this.startTime },
          warningCallback
        );
        this.manifest.slides.status = slides.status;
        this.manifest.slides.reason = slides.reason;
      } catch (err) {
        // Belt and braces: `start` is written not to throw, and if that ever
        // stops being true it must still not take the recording with it.
        console.error('Slide capture failed to start:', err.message);
        this.manifest.slides.status = 'error';
        this.manifest.slides.reason = err.message;
      }
    }

    // Call audio starts after everything else, for the same reason slides do:
    // it is a separate process that only reports, so the worst case is a
    // session exactly as it would have been without it (invariant #26).
    if (this.callCapture) {
      try {
        const call = this.callCapture.start(this.sessionDir, warningCallback);
        this.manifest.callAudio.status = call.status;
        this.manifest.callAudio.reason = call.reason;
      } catch (err) {
        console.error('Call audio failed to start:', err.message);
        this.manifest.callAudio.status = 'error';
        this.manifest.callAudio.reason = err.message;
      }
    }

    console.log(`Dual-track recording started in: ${this.sessionDir}`);

    return {
      sessionDir: this.sessionDir,
      systemFile: this.systemFile,
      micFile: this.micFile,
      startTime: this.startTime,
      captureMethod: this.captureMethod
    };
  }

  /**
   * Stop dual-track recording
   *
   * @returns {Promise<{sessionDir: string, systemFile: string, micFile: string, duration: number, systemSize: number, micSize: number, manifest: object}>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.isRecording) {
        reject(new Error('Nothing is being recorded right now'));
        return;
      }

      const duration = Date.now() - this.startTime;
      this.isRecording = false;
      // Set BEFORE the kills, so the system helper's exit handler reads this as
      // an ordinary stop rather than the capture dying and triggering a restart.
      this._stopping = true;

      // Clear SCK health check if pending
      if (this._sckHealthInterval) {
        clearInterval(this._sckHealthInterval);
        this._sckHealthInterval = null;
      }

      // Helper: stop a process with a 10s timeout before SIGKILL
      const stopWithTimeout = (proc, label) => new Promise((res) => {
        if (!proc) { res(label); return; }

        let done = false;
        proc.on('exit', () => { if (!done) { done = true; res(label); } });

        try {
          proc.kill('SIGTERM');
        } catch (err) {
          console.error(`Failed to stop ${label} process:`, err.message);
          done = true; res(label); return;
        }

        setTimeout(() => {
          if (done) return;
          console.warn(`${label} process did not exit after 10s — sending SIGKILL`);
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
          setTimeout(() => { if (!done) { done = true; res(label); } }, 200);
        }, 10000);
      });

      // The moment both tracks were told to stop — the reference the mic's
      // first sample is derived backwards from when placing call audio.
      this._stopRequestedAt = Date.now();

      // The call helper is signalled alongside the tracks so its open segment
      // ends when they do. `stop()` always resolves, within a few seconds.
      const callStopping = this.callCapture ? this.callCapture.stop() : null;

      // Kill both processes and wait for them to settle
      const stopPromises = [
        stopWithTimeout(this.systemProcess, 'system'),
        stopWithTimeout(this.micProcess, 'mic')
      ];

      // Wait for both to finish (partial success is OK)
      Promise.allSettled(stopPromises).then(async () => {
        // Small delay to let files flush
        await new Promise((r) => setTimeout(r, 500));

        // Everything below is wrapped because this callback is async: an
        // unguarded throw here would reject nothing and settle nothing, leaving
        // stopRecording() awaiting a promise that never resolves and the app
        // stuck showing a recording that has already ended.
        try {
          let systemSize = 0;
          let micSize = 0;

          // Close out the final capture part before anything reads its size.
          const finalPart = this.systemParts[this.systemParts.length - 1];
          if (finalPart && finalPart.stoppedAt == null) {
            finalPart.stoppedAt = Date.now();
            repairWavHeader(finalPart.file);
            try { finalPart.bytes = fs.statSync(finalPart.file).size; } catch { finalPart.bytes = 0; }
          }

          // Reassemble a restarted capture into one continuous track. Failure is
          // survivable by construction: `system.wav` IS part one, so a failed
          // stitch simply leaves the pre-restart audio in place — exactly what
          // this session would have produced before any of this existed.
          if (this.systemParts.length > 1) {
            const result = await this.stitchSystemParts();
            this.manifest.tracks.system.parts = this.systemParts.map((p) => ({
              file: path.basename(p.file),
              bytes: p.bytes
            }));
            this.manifest.tracks.system.stitched = result.stitched;
            if (!result.stitched) {
              console.warn(`System part stitching failed (${result.reason}) — keeping part 1 only`);
              this.manifest.tracks.system.stitchError = result.reason;
            }
          }

          // Mix in call audio (T206). Only a session whose call tap heard
          // sound gets here with anything to do; every other session leaves
          // system.wav exactly as ScreenCaptureKit wrote it. Runs before the
          // system file is measured, so the silence verdict sees the call.
          if (callStopping) {
            try {
              this.manifest.callAudio = await this._finishCallAudio(callStopping);
            } catch (err) {
              console.error('Call audio could not be finished:', err.message);
              this.manifest.callAudio = { enabled: true, status: 'error', reason: err.message, mixed: false };
            }
          }

          // Check system file
          if (fs.existsSync(this.systemFile)) {
            // Repair WAV header if SCK didn't finalise cleanly
            repairWavHeader(this.systemFile);
            const stats = fs.statSync(this.systemFile);
            systemSize = stats.size;
            this.manifest.tracks.system.size = systemSize;
            // Read the file rather than trust the bookkeeping — see
            // resolveFinalTrackStatus. The scan short-circuits on the first
            // audible sample, so a healthy track costs a few kilobytes and only
            // a genuinely silent one is read through.
            const systemPeak = measureWavPeak(this.systemFile);
            this.manifest.tracks.system.status = resolveFinalTrackStatus(
              this.manifest.tracks.system.status, systemSize,
              { measuredSilent: Boolean(systemPeak && systemPeak.silent) }
            );
          } else {
            this.manifest.tracks.system.status = 'missing';
          }

          // Check mic file
          if (fs.existsSync(this.micFile)) {
            repairWavHeader(this.micFile);
            const stats = fs.statSync(this.micFile);
            micSize = stats.size;
            this.manifest.tracks.mic.size = micSize;
            const micPeak = measureWavPeak(this.micFile);
            this.manifest.tracks.mic.status = resolveFinalTrackStatus(
              this.manifest.tracks.mic.status, micSize,
              { measuredSilent: Boolean(micPeak && micPeak.silent) }
            );
          } else {
            this.manifest.tracks.mic.status = 'missing';
          }

          // Stop slides and record what they caught. Never fatal: by this
          // point the audio is already on disk and worth filing regardless.
          if (this.slideCapture) {
            try {
              const summary = this.slideCapture.stop();
              this.manifest.slides = {
                enabled: true,
                status: summary.status,
                reason: summary.reason,
                keyframes: summary.keyframes,
                directory: summary.directory ? path.basename(summary.directory) : null,
                slides: summary.slides,
                events: summary.events
              };
              console.log(`  Slides: ${summary.keyframes} keyframes (${summary.status})`);
            } catch (err) {
              console.error('Slide capture failed to stop cleanly:', err.message);
              this.manifest.slides.status = 'error';
              this.manifest.slides.reason = err.message;
            }
          }

          // Update manifest
          this.manifest.endTime = new Date().toISOString();
          this.manifest.duration = duration;

          fs.writeFileSync(
            path.join(this.sessionDir, 'manifest.json'),
            JSON.stringify(this.manifest, null, 2),
            'utf-8'
          );

          console.log(`Dual-track recording stopped. Duration: ${Math.round(duration / 1000)}s`);
          console.log(`  System: ${(systemSize / (1024 * 1024)).toFixed(2)} MB (${this.manifest.tracks.system.status})`);
          console.log(`  Mic: ${(micSize / (1024 * 1024)).toFixed(2)} MB (${this.manifest.tracks.mic.status})`);

          resolve({
            sessionDir: this.sessionDir,
            systemFile: this.systemFile,
            micFile: this.micFile,
            duration: duration,
            systemSize: systemSize,
            micSize: micSize,
            manifest: this.manifest
          });
        } catch (err) {
          console.error(`Failed to finalise the session: ${err.message}`);
          reject(err);
        }
      });
    });
  }

  /**
   * Reassemble the capture parts into a single continuous `system.wav`.
   *
   * Only reached when the capture was restarted mid-session. The parts are
   * concatenated with a sox-generated silence pad standing in for each gap, so
   * the finished track spans the same wall-clock time as `mic.wav` and the two
   * transcripts still line up (see `planStitch`).
   *
   * Parts are never deleted, whether this succeeds or fails. They cost disk and
   * they are the only copy of the audio; if the stitch is ever wrong, the raw
   * material to redo it by hand is still sitting in the session directory.
   *
   * @returns {Promise<{stitched: boolean, reason?: string}>}
   */
  /**
   * Move `replacement` into place as `system.wav`, preserving what was there.
   *
   * `system.wav` is part one, so it has to be stepped aside rather than
   * overwritten — the parts are the only copy of the audio. The two renames are
   * a pair: if the second fails (a full disk, a vanished volume) the first is
   * undone, because a session with the pre-restart audio still at `system.wav`
   * is the documented failure mode, whereas one with NO `system.wav` at all is
   * a track the pipeline reports as missing.
   *
   * @param {string} replacement - file to become `system.wav`
   */
  _replaceSystemFileWith(replacement) {
    const partOne = path.join(this.sessionDir, 'system.part1.wav');
    const movedPartOne = fs.existsSync(this.systemFile);

    if (movedPartOne) {
      fs.renameSync(this.systemFile, partOne);
      this.systemParts[0].file = partOne;
    }

    try {
      fs.renameSync(replacement, this.systemFile);
    } catch (err) {
      if (movedPartOne) {
        try {
          fs.renameSync(partOne, this.systemFile);
          this.systemParts[0].file = this.systemFile;
        } catch { /* both renames failed — the parts are still on disk */ }
      }
      throw err;
    }
  }

  async stitchSystemParts() {
    const scratch = [];

    try {
      // Re-read every part's size at the last moment — part one's was recorded
      // before it was repaired, and a stale size skews every gap after it.
      for (const part of this.systemParts) {
        try { part.bytes = fs.statSync(part.file).size; } catch { part.bytes = 0; }
      }

      const usable = this.systemParts.filter((p) => p.bytes > WAV_HEADER_BYTES);
      if (usable.length === 0) return { stitched: false, reason: 'no part holds any audio' };

      if (usable.length === 1) {
        // Only one part holds audio, so there is nothing to join — but which
        // part it is matters enormously. If it is already `system.wav` we are
        // done. If it is a LATER part, then part one never produced a byte and
        // `system.wav` is an empty husk sitting where the pipeline will look;
        // leaving it there would discard the audio in the very case the restart
        // worked perfectly. Promote the survivor instead.
        const survivor = usable[0];
        if (survivor.file === this.systemFile) {
          return { stitched: false, reason: 'only one part holds audio' };
        }

        this._replaceSystemFileWith(survivor.file);
        survivor.file = this.systemFile;
        console.log(`Only ${path.basename(survivor.file)} held audio — promoted to system.wav`);
        return { stitched: true, reason: 'promoted the only part holding audio' };
      }

      const segments = planStitch(usable);
      const inputs = [];

      for (const [i, segment] of segments.entries()) {
        if (segment.type === 'part') {
          inputs.push(segment.file);
          continue;
        }
        const padFile = path.join(this.sessionDir, `system.pad${i}.wav`);
        await generateSilenceWav(padFile, segment.ms);
        scratch.push(padFile);
        inputs.push(padFile);
      }

      const stitchedFile = path.join(this.sessionDir, 'system.stitched.wav');
      await runSox([...inputs, stitchedFile]);

      // Replace only once sox has actually produced something.
      const stitchedSize = fs.statSync(stitchedFile).size;
      if (stitchedSize <= WAV_HEADER_BYTES) {
        return { stitched: false, reason: 'stitched file holds no audio' };
      }

      this._replaceSystemFileWith(stitchedFile);

      const padded = segments.filter((s) => s.type === 'pad');
      const paddedMs = padded.reduce((total, s) => total + s.ms, 0);
      console.log(
        `Stitched ${usable.length} system parts into system.wav `
        + `(${padded.length} gap(s), ${(paddedMs / 1000).toFixed(1)}s padded)`
      );

      return { stitched: true };
    } catch (err) {
      return { stitched: false, reason: err.message };
    } finally {
      // Pads are working files with no diagnostic value; the parts they sit
      // between are what matter, and those are kept.
      for (const file of scratch) {
        try { fs.unlinkSync(file); } catch { /* never mind */ }
      }
    }
  }

  /**
   * Stop the call helper's session record and, if it caught a call, mix it
   * into `system.wav`. See `services/callCapture.js` and invariant #26.
   *
   * @param {Promise<object>} callStopping - `CallCaptureSession.stop()`
   * @returns {Promise<object>} the manifest's `callAudio` record
   */
  async _finishCallAudio(callStopping) {
    const summary = await callStopping;
    const record = {
      enabled: true,
      status: summary.status,
      reason: summary.reason,
      // Recorded per session so a Meet or Zoom recording that ever trips the
      // call tap is visible here, rather than being assumed impossible.
      segments: summary.segments.map((s) => ({
        file: s.file, startEpochMs: s.startEpochMs, endEpochMs: s.endEpochMs,
        sampleRate: s.sampleRate, frames: s.frames, peak: s.peak, endReason: s.endReason
      })),
      mixed: false
    };

    let micBytes = 0;
    try { micBytes = fs.statSync(this.micFile).size; } catch { /* no mic file */ }
    const micAudioStartMs = micBytes > WAV_HEADER_BYTES
      ? this._stopRequestedAt - wavDurationMs(micBytes)
      : this.startTime;

    const plan = planCallMix({ segments: summary.segments, micAudioStartMs });
    if (plan.length === 0) return record;

    for (const segment of plan) repairWavHeader(path.join(this.sessionDir, segment.file));
    const result = await mixCallAudio({
      sessionDir: this.sessionDir,
      systemFile: this.systemFile,
      plan,
      runSox
    });
    record.mixed = result.mixed;
    record.mixedSegments = plan.map((p) => ({ file: p.file, offsetMs: p.offsetMs, trimHeadMs: p.trimHeadMs, sampleRate: p.sampleRate }));
    if (result.mixed) {
      console.log(`  Call audio: mixed ${plan.length} segment(s) into system.wav (original kept as system.sck.wav)`);
    } else {
      record.mixError = result.reason;
      console.warn(`  Call audio: not mixed (${result.reason}) — system.wav left as captured`);
    }
    return record;
  }

  /**
   * Get current recording status
   *
   * @returns {{isRecording: boolean, duration: number, sessionDir: string, tracks: object}|null}
   */
  getStatus() {
    if (!this.isRecording) {
      return null;
    }

    return {
      isRecording: true,
      duration: Date.now() - this.startTime,
      sessionDir: this.sessionDir,
      tracks: {
        system: { status: this.manifest.tracks.system.status },
        mic: { status: this.manifest.tracks.mic.status }
      }
    };
  }

  /**
   * Force cleanup (for emergency shutdown)
   */
  cleanup() {
    if (this.systemProcess && this.isRecording) {
      try { this.systemProcess.kill('SIGKILL'); } catch (err) { /* already dead */ }
    }
    if (this.micProcess && this.isRecording) {
      try { this.micProcess.kill('SIGKILL'); } catch (err) { /* already dead */ }
    }
    if (this.callCapture && this.isRecording) this.callCapture.kill();
    this.isRecording = false;
  }
}

module.exports = {
  Recorder,
  sessionTimestamp,
  oversizeWarning,
  DualTrackRecorder,
  sckStartupVerdict,
  watchSckStartup,
  sckSilentWarning,
  resolveSystemCaptureMethod,
  resolveFinalTrackStatus,
  planStitch,
  wavDurationMs,
  SCK_START_TIMEOUT_MS,
  SYSTEM_RESTART_MAX,
  SYSTEM_RESTART_MIN_INTERVAL_MS,
  WAV_HEADER_BYTES
};
