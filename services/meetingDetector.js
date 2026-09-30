/**
 * Meeting Detector
 *
 * Polls the OS every POLL_INTERVAL_MS for active meetings (Zoom, FaceTime,
 * Google Meet) using privacy-preserving signals only:
 *   - pgrep for app-specific helper processes (e.g. Zoom's CptHost)
 *   - pmset -g assertions for mic/audio power assertions held by browsers/apps
 *
 * No AppleScript, no URL reads, no window/tab enumeration. No Automation/TCC
 * consent required.
 *
 * Hysteresis: an app is only considered "meeting ended" after MISS_THRESHOLD
 * consecutive polls with no signal. This prevents single transient failures
 * from re-triggering the banner mid-meeting.
 *
 * Calendar enrichment (optional): the constructor accepts an async `enricher`
 * that returns the currently in-progress calendar event (or null). When a
 * meeting is detected, the canonical fingerprint becomes the calendar
 * `occurrenceFingerprint` if the enricher returns a match — which means a
 * user-dismissed pre-meeting banner ALSO suppresses the detector banner for
 * the same occurrence. App-only detections keep the old `<app>-<timestamp>`
 * fingerprint shape.
 *
 * Dismissal state lives in the injected `dismissalRegistry`, not on the
 * detector. There is no `markDismissed` here — callers should go through the
 * registry directly.
 */

const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const POLL_INTERVAL_MS = 10000;
const MISS_THRESHOLD = 3;
const ENRICHER_TIMEOUT_MS = 500;

class MeetingDetector {
  /**
   * @param {object} [opts]
   * @param {object} [opts.dismissalRegistry] - shared registry; required for dedup
   * @param {() => Promise<object|null>} [opts.enricher] - async lookup for the current calendar event
   */
  constructor({ dismissalRegistry = null, enricher = null } = {}) {
    this._registry = dismissalRegistry;
    this._enricher = enricher;

    this._interval = null;
    this._running = false;
    this._callback = null;

    // app -> { firstDetectedAt, consecutiveMisses, fingerprint, displayName }
    this._activeApps = new Map();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._interval = setInterval(() => {
      this._poll().catch(() => { /* never crash the app on detector errors */ });
    }, POLL_INTERVAL_MS);
    // Fire once immediately so the first meeting isn't delayed by the interval
    this._poll().catch(() => {});
  }

  stop() {
    this._running = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    // Clear active state so a resume doesn't replay stale detections
    this._activeApps.clear();
  }

  onMeetingDetected(callback) {
    this._callback = callback;
  }

  /**
   * Run the enricher with a bounded timeout. Returns null on miss, timeout,
   * or error — the detector falls back to the un-enriched banner in any of
   * those cases.
   */
  async _tryEnrich() {
    if (typeof this._enricher !== 'function') return null;

    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ENRICHER_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this._enricher()),
        timeoutPromise
      ]);
      return result || null;
    } catch (_err) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  _isDismissed(fingerprint) {
    if (!this._registry || !fingerprint) return false;
    return this._registry.isDismissed(fingerprint);
  }

  async _poll() {
    if (!this._running) return;

    // One pmset call per poll, shared across all detectors
    let assertions = '';
    try {
      const { stdout } = await execAsync('pmset -g assertions');
      assertions = stdout;
    } catch (err) {
      // pmset failed — continue with empty assertions
    }

    const [zoomActive, facetimeActive, meetActive] = await Promise.all([
      this._detectZoom(assertions),
      this._detectFaceTime(assertions),
      this._detectMeet(assertions)
    ]);

    const currentDetections = {};
    if (zoomActive) currentDetections.zoom = { displayName: 'Zoom' };
    if (facetimeActive) currentDetections.facetime = { displayName: 'FaceTime' };
    if (meetActive) currentDetections.meet = { displayName: 'Google Meet' };

    // For each currently detected app: either reset miss counter or fire a new detection
    for (const app of Object.keys(currentDetections)) {
      const existing = this._activeApps.get(app);
      if (existing) {
        existing.consecutiveMisses = 0;
        continue;
      }

      const firstDetectedAt = Date.now();
      const appFingerprint = `${app}-${firstDetectedAt}`;

      // Try to enrich with the current calendar event. If we hit, the calendar
      // fingerprint becomes the canonical id used everywhere — including the
      // dismissal check — so dismissing the pre-meeting banner also suppresses
      // this detector firing for the same occurrence.
      const calendarEvent = await this._tryEnrich();
      const fingerprint = calendarEvent && typeof calendarEvent.occurrenceFingerprint === 'string'
        ? calendarEvent.occurrenceFingerprint
        : appFingerprint;

      this._activeApps.set(app, {
        firstDetectedAt,
        consecutiveMisses: 0,
        fingerprint,
        appFingerprint,
        displayName: currentDetections[app].displayName
      });

      if (this._isDismissed(fingerprint)) continue;
      if (!this._callback) continue;

      try {
        this._callback({
          app,
          displayName: currentDetections[app].displayName,
          fingerprint,
          appFingerprint,
          calendarEvent
        });
      } catch (_err) {
        // Callback errors must not kill the detector loop
      }
    }

    // Hysteresis: increment misses for apps not detected this tick.
    // Only drop after MISS_THRESHOLD consecutive misses — one transient failure
    // (lsof/pmset/pgrep hiccup, brief reconnect) must NOT reset the fingerprint.
    for (const [app, state] of this._activeApps.entries()) {
      if (!currentDetections[app]) {
        state.consecutiveMisses++;
        if (state.consecutiveMisses >= MISS_THRESHOLD) {
          this._activeApps.delete(app);
        }
      }
    }
  }

  /**
   * Zoom: CptHost helper is spawned only during an active meeting. Fallback
   * to a mic/audio assertion held by zoom.us.
   */
  async _detectZoom(assertions) {
    try {
      const { stdout } = await execAsync('pgrep -x CptHost');
      if (stdout.trim()) return true;
    } catch (err) {
      // pgrep exits non-zero when no match — that's expected, fall through
    }

    return assertionMatches(assertions, /zoom\.us/i);
  }

  /**
   * FaceTime: the FaceTime.app process can be running without an active call
   * (contact list), so we require a mic/audio assertion.
   */
  async _detectFaceTime(assertions) {
    return assertionMatches(assertions, /FaceTime/);
  }

  /**
   * Google Meet: no URL or tab reads. A Chrome helper (or Safari) holding a
   * mic assertion is the signal. This fires for any browser meeting (Meet,
   * Whereby, Discord web, etc.), which is fine — the banner is generic.
   *
   * Does NOT fire for a stale Meet invite tab or a pre-join lobby, because
   * those don't hold a mic assertion.
   */
  async _detectMeet(assertions) {
    return assertionMatches(
      assertions,
      /Google Chrome Helper|Safari|firefox|Arc Helper|Brave Browser Helper/i
    );
  }
}

/**
 * Check whether any single line of `pmset -g assertions` output matches
 * the given process regex AND references an active audio/mic assertion.
 */
function assertionMatches(assertions, processRegex) {
  if (!assertions) return false;
  const audioRegex = /(audio-capture|microphone|AudioIn)/i;
  const lines = assertions.split('\n');
  return lines.some(line => processRegex.test(line) && audioRegex.test(line));
}

module.exports = { MeetingDetector };
