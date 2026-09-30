/**
 * SignalWatcher
 *
 * Answers the one question nothing in this app has ever asked: **is the audio
 * actually audio?**
 *
 * Every health check that came before it measures whether the capture file is
 * *growing*. A zero-filled WAV grows at exactly the byte rate of speech, so a
 * growth check cannot fail — which is how four separate causes each produced a
 * full-length, digitally-silent system track that was transcribed, summarised,
 * badged complete and filed into the right vault folder. This watcher measures
 * the samples instead.
 *
 * Like `SilenceWatcher` (whose shape it deliberately mirrors) it owns NO timers:
 * it is driven by the existing 150 ms `LevelMonitor` poll and measures elapsed
 * time from an injectable clock, so it is testable under plain `node --test`.
 *
 * It is fed PEAKS, not levels. `LevelMonitor._readLevel` clamps anything at or
 * below -60 dBFS to `0`, so a level of `0` cannot distinguish a quiet room from
 * a dead capture; `_readPeak` returns the largest raw sample, where `0` means
 * every sample was exactly zero and `null` means the file could not be read.
 * A `null` is never evidence of silence.
 *
 * ## What it takes to reach a verdict
 *
 * Digital silence on the system track is perfectly legitimate on its own —
 * nothing is playing yet, the call has not connected, nobody has joined. It only
 * becomes evidence when the mic corroborates that *something* is happening, and
 * has done for `requiredDeadMs`.
 *
 * That corroboration is deliberately weak, and the weakness is the design.
 * Distinguishing "someone is talking" from "a room exists" cannot be done
 * honestly from these numbers: a MacBook Pro's built-in mic measures a peak of
 * 2084 in an EMPTY room, while measured per-poll peaks during real speech from a
 * couple of feet away ran 146-441. Those distributions overlap completely, so
 * any loudness gate is really a guess about gain and distance, and a guess in
 * the wrong direction here means a missed meeting.
 *
 * So this does not guess. It reports early and often, and the COST of being
 * wrong is managed by the caller instead: the first verdict restarts the capture
 * and raises a quiet, ambient warning (menu bar, panel) that disappears by
 * itself the moment real audio arrives — which is exactly what happens when the
 * cause was innocent and the call simply had not connected. Only a verdict that
 * survives a restart and a much longer second window is worth interrupting
 * anyone over. See `main.js handleDeadSystemSignal`.
 *
 * Note that evidence accrues more slowly than wall-clock: a measured ~42% of
 * polls find no new bytes to read and yield `null`, which is correctly counted
 * as no evidence either way. A 45 s window is therefore nearer 75 s in practice.
 *
 * In system-only mode there is no mic to corroborate with, so this NEVER fires.
 * "Nothing is playing" and "the capture is dead" are genuinely indistinguishable
 * without a second track, and a warning that cannot tell them apart would train
 * the user to ignore it. That mode is covered after the fact instead, by the
 * exact-zero scan at processing time.
 *
 * It never stops a recording. Its verdict feeds the in-place restart and the
 * user-facing warnings, and nothing else.
 */

/**
 * Peak below which a track counts as having produced nothing.
 *
 * Not `0`, so that a stray least-significant bit — a single glitched sample in
 * an otherwise dead stream — cannot mark a broken capture as healthy. Not much
 * above it either: at 16-bit, 4 is about -78 dBFS, far below any real audio and
 * far below even a noise floor. The failures this exists to catch measured
 * exactly zero across every sample (0 non-zero samples in 32,042,880 frames),
 * so the precise value matters much less than the tri-state handling around it.
 */
const DEFAULT_SIGNAL_THRESHOLD = 4;

/** Evidence needed before the first, quiet verdict. */
const DEFAULT_REQUIRED_DEAD_MS = 45000;

/**
 * Evidence needed before a verdict is worth interrupting someone over.
 *
 * Used by the caller when re-arming after a restart. Reaching it means the
 * capture was already restarted once and STILL produced nothing across a further
 * five minutes — at which point the innocent explanation (the call had not
 * connected yet) has run out, and a notification is earned rather than noise.
 */
const DEFAULT_ESCALATION_MS = 300000;

class SignalWatcher {
  /**
   * @param {object} opts
   * @param {'dual'|'system'} [opts.mode='dual'] - Only 'dual' can reach a verdict.
   * @param {number} [opts.requiredDeadMs=45000] - Evidence must hold this long.
   * @param {number} [opts.signalThreshold=4] - Peak above which a track has signal.
   * @param {Function} opts.onDead - Fired ONCE per arming, with a reason string.
   * @param {Function} [opts.now=Date.now] - Clock seam for deterministic tests.
   */
  constructor({
    mode = 'dual',
    requiredDeadMs = DEFAULT_REQUIRED_DEAD_MS,
    signalThreshold = DEFAULT_SIGNAL_THRESHOLD,
    onDead,
    now = Date.now
  } = {}) {
    this.mode = mode;
    this.requiredDeadMs = requiredDeadMs;
    this.signalThreshold = signalThreshold;
    this.onDead = onDead || (() => {});
    this.now = now;

    this.lastPollAt = null;
    this.evidenceMs = 0;
    this.fired = false;
    this.systemHasSignal = false;
    this.micHasSignal = false;
  }

  /**
   * Feed one poll's peaks.
   *
   * @param {{system?: (number|null), mic?: (number|null)}} peaks - Raw sample
   *   peaks. `null` means unreadable and is ignored entirely — it is never
   *   counted as silence.
   */
  update(peaks = {}) {
    const now = this.now();
    // Time since the previous poll. Measured rather than assumed, because the
    // window has to be wall-clock — a stalled or throttled poll loop must not
    // shorten it.
    const sincePoll = this.lastPollAt == null ? 0 : Math.max(0, now - this.lastPollAt);
    this.lastPollAt = now;

    if (this._hasSignal(peaks.system)) this.systemHasSignal = true;
    if (this._hasSignal(peaks.mic)) this.micHasSignal = true;

    if (this.fired) return;
    if (this.mode !== 'dual') return;

    // Any signal on the system track at any point clears the suspicion for this
    // arming — the capture has proven it can deliver audio.
    if (this.systemHasSignal) return;

    // Time only counts as evidence when BOTH halves of the case hold for it:
    //
    //   - the system track was readable and held nothing. An unreadable file
    //     proves nothing in either direction, and treating that absence as
    //     silence would report a healthy capture as dead and restart it — the
    //     precise trap invariant #10 exists to document.
    //   - the mic had already proven signal, so something audible was happening
    //     that a working system capture ought to have heard some of.
    //
    // Accumulating rather than measuring from a start point is what keeps those
    // two conditions honest: the clock effectively begins when someone first
    // speaks, and pauses whenever the evidence lapses.
    const systemReadable = typeof peaks.system === 'number';
    if (!systemReadable || !this.micHasSignal) return;

    this.evidenceMs += sincePoll;
    if (this.evidenceMs < this.requiredDeadMs) return;

    this.fired = true;
    this.onDead({
      track: 'system',
      elapsedMs: this.evidenceMs,
      reason: 'System capture has produced no audio since the recording began, '
        + 'while the microphone has.'
    });
  }

  /** Has this track proven it can deliver audio? `null` proves nothing. */
  _hasSignal(peak) {
    return typeof peak === 'number' && peak > this.signalThreshold;
  }

  /** Current verdict, for the panel and the manifest. */
  isDead() {
    return this.fired;
  }

  /**
   * Re-arm after the system capture has been restarted onto a new file.
   *
   * The clock and the system track's history both have to go: the replacement
   * capture has produced nothing yet, and judging it on the dead one's silence
   * would fire again immediately and burn the session's restart budget in a
   * couple of polls. The mic's proven signal is deliberately KEPT — the mic was
   * never restarted, and it is still evidence that something audible is
   * happening.
   */
  rearm({ requiredDeadMs } = {}) {
    this.lastPollAt = null;
    this.evidenceMs = 0;
    this.fired = false;
    this.systemHasSignal = false;
    // The caller widens the window on re-arm so the second verdict means
    // something the first did not: the capture was already restarted once and
    // still produced nothing. `micHasSignal` is KEPT — the mic was never
    // restarted, so what was measured about it is still true.
    if (typeof requiredDeadMs === 'number') this.requiredDeadMs = requiredDeadMs;
  }
}

module.exports = {
  SignalWatcher,
  DEFAULT_SIGNAL_THRESHOLD,
  DEFAULT_REQUIRED_DEAD_MS,
  DEFAULT_ESCALATION_MS
};
