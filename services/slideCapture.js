'use strict';

const fs = require('fs');
const path = require('path');
const { spawn: defaultSpawn } = require('child_process');

/**
 * Slide keyframe capture — orchestration for the `sck-slide-capture` helper.
 *
 * Deliberately a SEPARATE process from `sck-audio-capture`, not a second stream
 * inside it. Invariant #1 says system audio has no fallback and fails loudly;
 * that guarantee is worth more than slides are, so nothing here is allowed to
 * be in a position to take audio down with it. A crash, a permission change or
 * a wedged stream in the slide helper costs slides and nothing else. Every
 * failure path in this module therefore ends in a warning, never a throw.
 */

/** The helper exits 3 when it deliberately captured nothing. Not a failure. */
const EXIT_UNRESOLVED = 3;

/** Directory, relative to the session, that keyframes are written into. */
const SLIDES_DIRNAME = 'slides';

/**
 * Path to the slide capture helper, mirroring `getSckBinaryPath` in main.js.
 *
 * @param {{isPackaged: boolean, resourcesPath?: string, appDir: string}} env
 * @returns {string}
 */
function resolveSlideBinaryPath({ isPackaged, resourcesPath, appDir }) {
  if (isPackaged && resourcesPath) {
    return path.join(resourcesPath, 'sck-slide-capture');
  }
  return path.join(appDir, 'native', 'sck-slide-capture', '.build', 'release', 'sck-slide-capture');
}

/**
 * Build the helper's argument list.
 *
 * @param {string} slidesDir - Directory keyframes are written to
 * @param {object} [options]
 * @param {number|null} [options.sourcePid] - PID holding the meeting audio
 * @param {string|null} [options.sourceBundle] - Bundle id holding the meeting audio
 * @param {number|null} [options.startEpochMs] - Recording start, so slide
 *   offsets share the transcript's clock rather than the helper's own
 * @param {number} [options.fps]
 * @param {number} [options.maxWidth]
 * @param {number} [options.stabilityMs]
 * @returns {string[]}
 */
function buildSlideArgs(slidesDir, options = {}) {
  const args = [slidesDir];
  if (options.sourcePid) args.push('--source-pid', String(options.sourcePid));
  if (options.sourceBundle) args.push('--source-bundle', options.sourceBundle);
  if (options.startEpochMs) args.push('--start-epoch-ms', String(options.startEpochMs));
  if (options.fps) args.push('--fps', String(options.fps));
  if (options.maxWidth) args.push('--max-width', String(options.maxWidth));
  if (options.stabilityMs) args.push('--stability-ms', String(options.stabilityMs));
  return args;
}

/**
 * Parse one line of the helper's stdout.
 *
 * @param {string} line
 * @returns {object|null} The event, or null if the line is not one
 */
function parseSlideEvent(line) {
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
 * Read `slides.csv` into rows. The CSV is the record of truth for what was
 * kept — events describe intent, the file describes what landed.
 *
 * @param {string} csvText
 * @returns {Array<{offsetMs: number, file: string, width: number, height: number, mode: string, source: string}>}
 */
function parseSlidesCsv(csvText) {
  const rows = [];
  const lines = String(csvText || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('offset_ms,')) continue;
    const match = trimmed.match(/^(\d+),([^,]+),(\d+),(\d+),([^,]*),"?(.*?)"?$/);
    if (!match) continue;
    rows.push({
      offsetMs: parseInt(match[1], 10),
      file: match[2],
      width: parseInt(match[3], 10),
      height: parseInt(match[4], 10),
      mode: match[5],
      source: match[6]
    });
  }
  return rows;
}

/**
 * Processes that hold an audio assertion when a meeting is running in a
 * browser, mapped to the bundle id ScreenCaptureKit will report.
 *
 * A browser TAB is invisible to the OS, so the most the system can tell us is
 * which browser is making noise. That is still the piece the resolver needs:
 * it narrows the search to one application's windows, and the window TITLE
 * decides the rest.
 */
const BROWSER_ASSERTION_MAP = [
  [/Google Chrome/i, 'com.google.Chrome'],
  [/\bSafari\b/i, 'com.apple.Safari'],
  [/\bzen\b/i, 'app.zen-browser.zen'],
  [/firefox/i, 'org.mozilla.firefox'],
  [/\bArc\b/i, 'company.thebrowser.Browser'],
  [/Brave/i, 'com.brave.Browser'],
  [/Microsoft Edge/i, 'com.microsoft.edgemac'],
  [/Vivaldi/i, 'com.vivaldi.Vivaldi']
];

/** Native meeting apps the detector can name, by its own key. */
const MEETING_APP_BUNDLES = {
  zoom: 'us.zoom.xos',
  facetime: 'com.apple.FaceTime',
  teams: 'com.microsoft.teams',
  webex: 'Cisco-Systems.Spark'
};

/**
 * Work out which application the meeting audio belongs to.
 *
 * Prefers a native meeting app, because that is unambiguous. Falls back to
 * whichever browser holds an audio or microphone assertion in
 * `pmset -g assertions` — the same signal `meetingDetector` already uses to
 * decide a browser meeting is running.
 *
 * @param {{detected?: string|null, assertions?: string|null}} input
 * @returns {{sourceBundle: string|null, why: string}}
 */
function resolveAudioSourceBundle({ detected = null, assertions = null } = {}) {
  if (detected && MEETING_APP_BUNDLES[detected]) {
    return { sourceBundle: MEETING_APP_BUNDLES[detected], why: `${detected} is running` };
  }

  if (assertions) {
    const audioLine = /(audio-capture|microphone|AudioIn)/i;
    for (const line of String(assertions).split('\n')) {
      if (!audioLine.test(line)) continue;
      for (const [pattern, bundle] of BROWSER_ASSERTION_MAP) {
        if (pattern.test(line)) {
          return { sourceBundle: bundle, why: 'a browser holds the audio assertion' };
        }
      }
    }
  }

  // No hint. The helper falls back to "exactly one native meeting app is
  // running", and refuses if that is not true — which is the right answer.
  return { sourceBundle: null, why: 'no audio source could be identified' };
}

/**
 * A running slide capture, owned by one recording session.
 */
class SlideCaptureSession {
  /**
   * @param {string|null} binaryPath - Path to the helper, or null if unbuilt
   * @param {{spawn?: Function, existsSync?: Function, readFileSync?: Function}} [deps]
   *   Injection seam matching `_check`/`_exists` elsewhere in the codebase, so
   *   the orchestration is testable without a built helper or a screen grant.
   */
  constructor(binaryPath, deps = {}) {
    this.binaryPath = binaryPath;
    this._spawn = deps.spawn || defaultSpawn;
    this._exists = deps.existsSync || fs.existsSync;
    this._readFile = deps.readFileSync || fs.readFileSync;

    this.process = null;
    this.slidesDir = null;
    this.events = [];
    this.status = 'idle';
    /** Why nothing is being captured, when that is the case. */
    this.reason = null;
  }

  /**
   * Start capturing. Returns a status rather than throwing: a session that
   * cannot capture slides is still a perfectly good recording.
   *
   * @param {string} sessionDir
   * @param {object} [options] - see `buildSlideArgs`
   * @param {Function} [warningCallback]
   * @returns {{started: boolean, status: string, reason: string|null}}
   */
  start(sessionDir, options = {}, warningCallback = null) {
    if (!this.binaryPath || !this._exists(this.binaryPath)) {
      this.status = 'unavailable';
      this.reason = 'the sck-slide-capture helper was not found (npm run build:native)';
      return this._result(false);
    }

    this.slidesDir = path.join(sessionDir, SLIDES_DIRNAME);

    let proc;
    try {
      proc = this._spawn(this.binaryPath, buildSlideArgs(this.slidesDir, options));
    } catch (err) {
      this.status = 'error';
      this.reason = `could not start slide capture: ${err.message}`;
      if (warningCallback) warningCallback(this.reason);
      return this._result(false);
    }

    this.process = proc;
    this.status = 'waiting';
    this.reason = null;

    let stdoutBuffer = '';
    proc.stdout?.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const event = parseSlideEvent(line);
        if (event) this._record(event);
      }
    });

    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[slides] ${text}`);
    });

    proc.on('error', (err) => {
      this.status = 'error';
      this.reason = err.message;
      // Warn, never throw — audio is still recording.
      if (warningCallback) warningCallback(`Slide capture stopped: ${err.message}`);
    });

    proc.on('exit', (code) => {
      this.process = null;
      if (this.status === 'stopping' || code === 0) {
        this.status = 'stopped';
      } else if (code === EXIT_UNRESOLVED) {
        this.status = 'unresolved';
      } else {
        this.status = 'error';
        this.reason = this.reason || `slide capture exited with code ${code}`;
      }
    });

    return this._result(true);
  }

  /** Record an event and let it move the status. */
  _record(event) {
    this.events.push({ ...event, at: Date.now() });
    if (event.event === 'resolved' || event.event === 'source-changed') {
      this.status = 'capturing';
      this.reason = null;
    } else if (event.event === 'unresolved' || event.event === 'source-lost') {
      this.status = 'waiting';
      this.reason = event.detail || null;
    } else if (event.event === 'stream-died') {
      this.status = 'error';
      this.reason = event.detail || 'the slide stream died';
    }
  }

  _result(started) {
    return { started, status: this.status, reason: this.reason };
  }

  /** Stop the helper. Safe to call when nothing is running. */
  stop() {
    if (this.process) {
      this.status = 'stopping';
      try {
        this.process.kill('SIGTERM');
      } catch {
        // Already gone — nothing to do.
      }
    }
    return this.summary();
  }

  /**
   * What this session captured, for the manifest.
   *
   * @returns {{status: string, reason: string|null, directory: string|null, keyframes: number, slides: Array, events: Array}}
   */
  summary() {
    let slides = [];
    if (this.slidesDir) {
      const csvPath = path.join(this.slidesDir, 'slides.csv');
      if (this._exists(csvPath)) {
        try {
          slides = parseSlidesCsv(this._readFile(csvPath, 'utf-8'));
        } catch {
          slides = [];
        }
      }
    }
    return {
      status: this.status,
      reason: this.reason,
      directory: this.slidesDir,
      keyframes: slides.length,
      slides,
      events: this.events
    };
  }
}

module.exports = {
  SlideCaptureSession,
  resolveSlideBinaryPath,
  buildSlideArgs,
  parseSlideEvent,
  parseSlidesCsv,
  resolveAudioSourceBundle,
  MEETING_APP_BUNDLES,
  EXIT_UNRESOLVED,
  SLIDES_DIRNAME
};
