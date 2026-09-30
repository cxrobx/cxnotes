/**
 * SilenceWatcher
 *
 * A small, timer-free state machine that tracks a continuous silence streak
 * across the per-poll audio levels produced by `LevelMonitor`. When silence has
 * persisted for `requiredSilenceMs`, it fires `onTrigger` once (the caller then
 * shows the "still recording?" prompt and owns the grace timer). If audio
 * resumes while the prompt is up, it fires `onResume` so the caller can cancel
 * the auto-stop.
 *
 * It owns NO timers of its own — it is driven entirely by `update()` calls from
 * the existing 150ms level-monitor poll, using the wall clock (`this.now`,
 * injectable for tests) to measure the streak. This keeps it trivially
 * unit-testable.
 *
 * Per-track health (hazard #4 / #5): `LevelMonitor._readLevel` returns 0 on a
 * missing, empty, or unreadable file — indistinguishable from genuine silence.
 * The caller classifies each track's growth per poll (see `classifyTrackGrowth`)
 * and passes a `trackHealth` map of `live | unknown | ended`:
 *   - **live**   — the file grew this poll. Counts toward the silence test.
 *   - **unknown** — not grown, but for less than `stallMs` (a brief read failure
 *     or a gap between flushes). Transient; the whole poll is treated as unknown
 *     so a momentary stall cannot masquerade as a finished meeting.
 *   - **ended**  — not grown for `>= stallMs` (the capture is dead — e.g. the
 *     meeting app quit and the per-app SCContentFilter stopped producing frames,
 *     gotchas #5). Excluded from the silence test rather than allowed to mute it.
 *
 * Silence is judged over the *live* tracks only. A single permanently-stalled
 * track no longer disables auto-stop for the rest of the recording (the
 * 2h39m-for-a-25min-meeting incident, session 2026-05-29_20-03-47): the live
 * track is judged on its own. When ALL relevant tracks are `ended` (a fully-dead
 * capture) the poll is treated as silence — newly auto-stopping sessions that
 * previously ran forever. As always this only ever routes through the prompt +
 * grace timer; it NEVER silently stops.
 *
 * Known limitation (gotchas.md #5 / SCK zero-fill): if Rogue Amoeba's ARK.driver
 * zero-fills system.wav, the file still *grows* (status `live`) but reads as
 * silence. In dual mode this only reaches the trigger if the mic track is *also*
 * silent (the user is only listening, not speaking) — and even then we prompt
 * rather than stop, so the user sees "still recording?" and can keep it alive.
 * The prompt-then-grace design is the deliberate safety net for exactly this
 * case; never change it to a silent auto-stop.
 *
 * Threshold: `thresholdLevel` is the 0..1 normalised level (0 ≈ -60dB, 1 ≈ 0dB)
 * below which a track counts as silent. The default ~0.12 (≈ -53dB) sits above
 * ambient room hiss but well below spoken words. Empirically tunable — lower it
 * if the prompt fires during quiet-but-active calls.
 */

const DEFAULT_THRESHOLD_LEVEL = 0.12;
const DEFAULT_STALL_TIMEOUT_MS = 120000;
const WAV_HEADER_BYTES = 44;

/**
 * Classify a single track's growth between polls. Pure — takes the current size
 * as a NUMBER (never a path), so it has no `fs` dependency and is testable under
 * plain node. The caller is responsible for reading the size and persisting the
 * returned `{ lastSize, lastGrowthAt }` back as the next poll's `prev`.
 *
 * @param {{lastSize: number, lastGrowthAt: number}|null|undefined} prev - Prior
 *   state for this track, or null/undefined on the first poll.
 * @param {number|null} size - Current file size in bytes, or null if unreadable.
 * @param {number} now - Current wall-clock time (ms).
 * @param {number} stallMs - How long without growth before a track is 'ended'.
 * @returns {{status: 'live'|'unknown'|'ended', lastSize: number, lastGrowthAt: number}}
 */
function classifyTrackGrowth(prev, size, now, stallMs) {
  // First sight of this track: seed the growth clock. Never 'ended' on the
  // first poll — there is no prior size to measure growth against.
  if (!prev) {
    return {
      status: size != null && size > WAV_HEADER_BYTES ? 'live' : 'unknown',
      lastSize: size != null ? size : 0,
      lastGrowthAt: now,
    };
  }

  // Grew this poll → live; reset the growth clock.
  if (size != null && size > prev.lastSize && size > WAV_HEADER_BYTES) {
    return { status: 'live', lastSize: size, lastGrowthAt: now };
  }

  // No growth (including unreadable size==null or a shrink): keep the prior
  // size/clock. Transient (< stallMs) → 'unknown'; long stall (>= stallMs) →
  // 'ended'.
  const status = now - prev.lastGrowthAt >= stallMs ? 'ended' : 'unknown';
  return { status, lastSize: prev.lastSize, lastGrowthAt: prev.lastGrowthAt };
}

/**
 * Build one poll's per-track health map (`{ name: 'live'|'unknown'|'ended' }`)
 * to hand to `SilenceWatcher.update`. This is the exact per-poll body run by
 * `main.js startLevelMonitor()` — kept here, and shared, so the production path
 * and its tests can never drift.
 *
 * Pure given `readSize`: the sole impure dependency (reading file sizes off
 * disk) is injected, so this module stays free of `fs`/electron and runs under
 * plain node. Mutates `trackGrowth` in place, storing each track's new growth
 * state for the next poll, and returns the status map.
 *
 * @param {object} opts
 * @param {Object<string, {path: string}>} opts.tracks - `LevelMonitor.tracks` shape.
 * @param {Object<string, object>} opts.trackGrowth - Prior per-track growth state; mutated in place.
 * @param {number} opts.now - Current wall-clock time (ms).
 * @param {number} opts.stallMs - Stall timeout before a non-growing track is 'ended'.
 * @param {(path: string) => (number|null)} opts.readSize - Size in bytes, or null if unreadable.
 * @returns {Object<string, 'live'|'unknown'|'ended'>}
 */
function computeTrackHealth({ tracks, trackGrowth, now, stallMs, readSize }) {
  const trackHealth = {};
  for (const [name, track] of Object.entries(tracks)) {
    const size = readSize(track.path);
    const state = classifyTrackGrowth(trackGrowth[name], size, now, stallMs);
    trackGrowth[name] = state;
    trackHealth[name] = state.status;
  }
  return trackHealth;
}

class SilenceWatcher {
  /**
   * @param {object} opts
   * @param {number} opts.requiredSilenceMs - Continuous silence before triggering.
   * @param {'dual'|'system'} [opts.mode='dual'] - Which tracks are relevant.
   * @param {number} [opts.thresholdLevel=0.12] - 0..1 level below which a track is silent.
   * @param {Function} opts.onTrigger - Fired once when the silence streak completes.
   * @param {Function} [opts.onResume] - Fired when audio resumes during the 'prompted' state.
   * @param {Function} [opts.now=Date.now] - Clock seam for deterministic tests.
   */
  constructor({ requiredSilenceMs, mode = 'dual', thresholdLevel = DEFAULT_THRESHOLD_LEVEL, onTrigger, onResume, now = Date.now } = {}) {
    this.requiredSilenceMs = requiredSilenceMs;
    this.mode = mode;
    this.thresholdLevel = thresholdLevel;
    this.onTrigger = onTrigger || (() => {});
    this.onResume = onResume || (() => {});
    this.now = now;

    // 'active'   — counting toward (or idle below) the silence threshold.
    // 'prompted' — onTrigger already fired, prompt is up, grace timer running.
    this.state = 'active';
    this.streakStart = null;
  }

  /**
   * Feed one poll of levels plus a per-track health map.
   *
   * @param {{system?: number, mic?: number}} levels - Normalised 0..1 levels.
   * @param {{trackHealth?: Object<string, 'live'|'unknown'|'ended'>}} [opts] -
   *   Per-track status for this poll. A missing/unrecognised status for a
   *   relevant track is treated as 'unknown' (the only safe default).
   */
  update(levels, { trackHealth } = {}) {
    const now = this.now();

    const relevant = this.mode === 'dual' ? ['system', 'mic'] : ['system'];
    const statuses = relevant.map((name) => (trackHealth && trackHealth[name]) || 'unknown');

    // Step 1: any relevant track 'unknown' (or unrecognised) → the whole poll is
    // unknown. Pause accumulation, never trigger. Do not touch the 'prompted'
    // state — a stalled read shouldn't be mistaken for resumed audio either.
    if (statuses.some((s) => s !== 'live' && s !== 'ended')) {
      if (this.state === 'active') {
        this.streakStart = null;
      }
      return;
    }

    // Step 2: every relevant track is 'live' or 'ended'. Judge silence over the
    // live tracks only; 'ended' tracks (dead capture) contribute nothing. When
    // all relevant tracks are 'ended' the capture is fully dead → silence.
    const live = relevant.filter((name, i) => statuses[i] === 'live');
    const silent = live.length === 0
      ? true
      : live.every((name) => (levels[name] || 0) < this.thresholdLevel);

    if (this.state === 'prompted') {
      // Prompt is up and the grace timer is running. The first genuinely
      // non-silent poll means someone started talking again — cancel.
      if (!silent) {
        this.onResume();
        this.reset();
      }
      return;
    }

    // state === 'active'
    if (!silent) {
      this.streakStart = null;
      return;
    }

    if (this.streakStart == null) {
      this.streakStart = now;
      return;
    }

    if (now - this.streakStart >= this.requiredSilenceMs) {
      this.state = 'prompted';
      this.onTrigger();
    }
  }

  /** Re-arm for the next silent window. */
  reset() {
    this.state = 'active';
    this.streakStart = null;
  }
}

module.exports = {
  SilenceWatcher,
  classifyTrackGrowth,
  computeTrackHealth,
  DEFAULT_THRESHOLD_LEVEL,
  DEFAULT_STALL_TIMEOUT_MS,
  WAV_HEADER_BYTES,
};
