'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  SilenceWatcher,
  classifyTrackGrowth,
  computeTrackHealth,
  DEFAULT_STALL_TIMEOUT_MS,
} = require('./silenceWatcher');

const STALL = DEFAULT_STALL_TIMEOUT_MS; // 120000

/**
 * Build a watcher with a mutable clock and trigger/resume counters. Tests
 * advance `clock.t` and feed `watcher.update(levels, { trackHealth })`.
 */
function makeWatcher({ mode = 'dual', requiredSilenceMs = 1000, thresholdLevel = 0.12 } = {}) {
  const clock = { t: 0 };
  const triggers = [];
  const resumes = [];
  const watcher = new SilenceWatcher({
    requiredSilenceMs,
    mode,
    thresholdLevel,
    onTrigger: () => triggers.push(clock.t),
    onResume: () => resumes.push(clock.t),
    now: () => clock.t,
  });
  return { watcher, clock, triggers, resumes };
}

const SILENT = { system: 0, mic: 0 };
const BOTH_LIVE = { trackHealth: { system: 'live', mic: 'live' } };

// ---------------------------------------------------------------------------
// Regression: existing behaviour preserved
// ---------------------------------------------------------------------------

test('regression: dual both-live silent → triggers exactly once', () => {
  const { watcher, clock, triggers } = makeWatcher();
  clock.t = 0;
  watcher.update(SILENT, BOTH_LIVE); // streakStart = 0
  assert.equal(triggers.length, 0);
  clock.t = 1000;
  watcher.update(SILENT, BOTH_LIVE); // 1000 - 0 >= 1000 → trigger
  assert.equal(triggers.length, 1);
  clock.t = 2000;
  watcher.update(SILENT, BOTH_LIVE); // prompted state → no re-fire
  assert.equal(triggers.length, 1);
});

test('regression: dual both-live, one side speaking → never triggers', () => {
  const { watcher, clock, triggers } = makeWatcher();
  const speaking = { system: 0.5, mic: 0 };
  for (const t of [0, 1000, 2000, 3000]) {
    clock.t = t;
    watcher.update(speaking, BOTH_LIVE);
  }
  assert.equal(triggers.length, 0);
});

test('regression: transient unknown pauses and resets the streak', () => {
  const { watcher, clock, triggers } = makeWatcher();
  clock.t = 0;
  watcher.update(SILENT, BOTH_LIVE); // streakStart = 0
  clock.t = 500;
  watcher.update(SILENT, { trackHealth: { system: 'unknown', mic: 'live' } }); // pause → reset
  clock.t = 1000;
  watcher.update(SILENT, BOTH_LIVE); // streakStart = 1000 (would have fired had streak survived)
  assert.equal(triggers.length, 0);
  clock.t = 2000;
  watcher.update(SILENT, BOTH_LIVE); // 2000 - 1000 >= 1000 → trigger
  assert.equal(triggers.length, 1);
});

test('regression: prompted + resume cancels and re-arms', () => {
  const { watcher, clock, triggers, resumes } = makeWatcher();
  clock.t = 0;
  watcher.update(SILENT, BOTH_LIVE);
  clock.t = 1000;
  watcher.update(SILENT, BOTH_LIVE); // trigger → prompted
  assert.equal(triggers.length, 1);
  assert.equal(watcher.state, 'prompted');
  clock.t = 1500;
  watcher.update({ system: 0.5, mic: 0 }, BOTH_LIVE); // non-silent → resume
  assert.equal(resumes.length, 1);
  assert.equal(watcher.state, 'active');
  // Re-armed: a fresh silent window can trigger again.
  clock.t = 2000;
  watcher.update(SILENT, BOTH_LIVE); // streakStart = 2000
  clock.t = 3000;
  watcher.update(SILENT, BOTH_LIVE); // trigger again
  assert.equal(triggers.length, 2);
});

test('regression: prompted + still silent → no re-fire, no resume', () => {
  const { watcher, clock, triggers, resumes } = makeWatcher();
  clock.t = 0;
  watcher.update(SILENT, BOTH_LIVE);
  clock.t = 1000;
  watcher.update(SILENT, BOTH_LIVE); // trigger
  clock.t = 9000;
  watcher.update(SILENT, BOTH_LIVE); // still silent, prompted → no-op
  assert.equal(triggers.length, 1);
  assert.equal(resumes.length, 0);
});

test('regression: bare update(levels) with no trackHealth → never triggers (safe default)', () => {
  const { watcher, clock, triggers } = makeWatcher();
  for (const t of [0, 1000, 2000]) {
    clock.t = t;
    watcher.update(SILENT); // no 2nd arg → all relevant tracks 'unknown' → pause
  }
  assert.equal(triggers.length, 0);
});

// ---------------------------------------------------------------------------
// The fix: per-track live/ended classification
// ---------------------------------------------------------------------------

test('fix: dual system:ended + mic:live silent → triggers (the incident)', () => {
  const { watcher, clock, triggers } = makeWatcher();
  const health = { trackHealth: { system: 'ended', mic: 'live' } };
  clock.t = 0;
  watcher.update(SILENT, health); // live = [mic], mic silent → silent, streakStart = 0
  clock.t = 1000;
  watcher.update(SILENT, health); // trigger
  assert.equal(triggers.length, 1);
});

test('fix: dual system:ended + mic:live speaking → does NOT trigger', () => {
  const { watcher, clock, triggers } = makeWatcher();
  const health = { trackHealth: { system: 'ended', mic: 'live' } };
  const micSpeaking = { system: 0, mic: 0.5 };
  for (const t of [0, 1000, 2000]) {
    clock.t = t;
    watcher.update(micSpeaking, health); // live = [mic], mic loud → not silent
  }
  assert.equal(triggers.length, 0);
});

test('fix: dual both ended → triggers (dead capture), levels ignored', () => {
  const { watcher, clock, triggers } = makeWatcher();
  const health = { trackHealth: { system: 'ended', mic: 'ended' } };
  const loud = { system: 0.9, mic: 0.9 }; // levels must be ignored when all ended
  clock.t = 0;
  watcher.update(loud, health); // live = [] → silent, streakStart = 0
  clock.t = 1000;
  watcher.update(loud, health); // trigger
  assert.equal(triggers.length, 1);
});

test('fix: system-mode system:ended → triggers', () => {
  const { watcher, clock, triggers } = makeWatcher({ mode: 'system' });
  const health = { trackHealth: { system: 'ended' } };
  clock.t = 0;
  watcher.update({ system: 0.9 }, health); // live = [] → silent
  clock.t = 1000;
  watcher.update({ system: 0.9 }, health); // trigger
  assert.equal(triggers.length, 1);
});

test('fix: system-mode system:unknown → never triggers', () => {
  const { watcher, clock, triggers } = makeWatcher({ mode: 'system' });
  const health = { trackHealth: { system: 'unknown' } };
  for (const t of [0, 1000, 2000]) {
    clock.t = t;
    watcher.update({ system: 0 }, health);
  }
  assert.equal(triggers.length, 0);
});

test('fix: live→ended mid-streak does NOT reset the streak', () => {
  const { watcher, clock, triggers } = makeWatcher();
  clock.t = 0;
  watcher.update(SILENT, BOTH_LIVE); // streakStart = 0 (both live, silent)
  clock.t = 500;
  watcher.update(SILENT, { trackHealth: { system: 'ended', mic: 'live' } }); // streak continues
  assert.equal(triggers.length, 0);
  clock.t = 1000;
  watcher.update(SILENT, { trackHealth: { system: 'ended', mic: 'live' } }); // 1000 - 0 >= 1000 → trigger
  assert.equal(triggers.length, 1);
});

// ---------------------------------------------------------------------------
// classifyTrackGrowth (pure helper)
// ---------------------------------------------------------------------------

test('classify: grew → live, advances size + growth clock', () => {
  const r = classifyTrackGrowth({ lastSize: 100, lastGrowthAt: 0 }, 200, 50, STALL);
  assert.deepEqual(r, { status: 'live', lastSize: 200, lastGrowthAt: 50 });
});

test('classify: brief no-grow → unknown, growth clock unchanged', () => {
  const prev = { lastSize: 200, lastGrowthAt: 0 };
  const r = classifyTrackGrowth(prev, 200, 1000, STALL); // 1000 < 120000
  assert.deepEqual(r, { status: 'unknown', lastSize: 200, lastGrowthAt: 0 });
});

test('classify: long no-grow → ended, boundary is >= stallMs', () => {
  const prev = { lastSize: 200, lastGrowthAt: 0 };
  assert.equal(classifyTrackGrowth(prev, 200, STALL, STALL).status, 'ended'); // exactly stallMs
  assert.equal(classifyTrackGrowth(prev, 200, STALL - 1, STALL).status, 'unknown'); // just under
});

test('classify: size==null → unknown then ended, keeps prior size/clock', () => {
  const prev = { lastSize: 200, lastGrowthAt: 0 };
  const r1 = classifyTrackGrowth(prev, null, 1000, STALL);
  assert.deepEqual(r1, { status: 'unknown', lastSize: 200, lastGrowthAt: 0 });
  const r2 = classifyTrackGrowth(r1, null, STALL, STALL);
  assert.equal(r2.status, 'ended');
});

test('classify: first poll (prev null/undefined) → live or unknown, never ended', () => {
  const a = classifyTrackGrowth(null, 1000, 999999, STALL); // size > 44
  assert.deepEqual(a, { status: 'live', lastSize: 1000, lastGrowthAt: 999999 });
  const b = classifyTrackGrowth(undefined, 44, 999999, STALL); // size <= 44 (header only)
  assert.deepEqual(b, { status: 'unknown', lastSize: 44, lastGrowthAt: 999999 });
  const c = classifyTrackGrowth(null, null, 999999, STALL); // unreadable
  assert.deepEqual(c, { status: 'unknown', lastSize: 0, lastGrowthAt: 999999 });
});

test('classify: size <= WAV header → not live', () => {
  const r = classifyTrackGrowth({ lastSize: 0, lastGrowthAt: 0 }, 44, 10, STALL);
  assert.notEqual(r.status, 'live');
  assert.equal(r.status, 'unknown');
});

test('classify: shrink → not live, keeps prior size', () => {
  const r = classifyTrackGrowth({ lastSize: 200, lastGrowthAt: 0 }, 100, 10, STALL);
  assert.notEqual(r.status, 'live');
  assert.equal(r.lastSize, 200);
});

// ---------------------------------------------------------------------------
// computeTrackHealth (shared poll body — pure given an injected readSize)
// ---------------------------------------------------------------------------

test('computeTrackHealth: maps each track to its status and mutates trackGrowth', () => {
  const tracks = { system: { path: '/sys' }, mic: { path: '/mic' } };
  const trackGrowth = {};
  const sizes = { '/sys': 1000, '/mic': 1000 };
  const readSize = (p) => sizes[p];

  // First poll: both grow from nothing → live.
  let health = computeTrackHealth({ tracks, trackGrowth, now: 0, stallMs: STALL, readSize });
  assert.deepEqual(health, { system: 'live', mic: 'live' });
  assert.equal(trackGrowth.system.lastGrowthAt, 0);
  assert.equal(trackGrowth.mic.lastSize, 1000);

  // System stalls (size frozen), mic keeps growing. Brief → system 'unknown'.
  sizes['/mic'] = 2000;
  health = computeTrackHealth({ tracks, trackGrowth, now: 1000, stallMs: STALL, readSize });
  assert.deepEqual(health, { system: 'unknown', mic: 'live' });

  // System stalled >= stallMs → 'ended'; mic still growing → 'live'.
  sizes['/mic'] = 3000;
  health = computeTrackHealth({ tracks, trackGrowth, now: STALL, stallMs: STALL, readSize });
  assert.deepEqual(health, { system: 'ended', mic: 'live' });
});

test('computeTrackHealth: unreadable size (readSize → null) is treated as no-growth', () => {
  const tracks = { system: { path: '/sys' } };
  const trackGrowth = {};
  const readSize = () => null; // always unreadable

  const first = computeTrackHealth({ tracks, trackGrowth, now: 0, stallMs: STALL, readSize });
  assert.deepEqual(first, { system: 'unknown' }); // first poll, never ended
  const later = computeTrackHealth({ tracks, trackGrowth, now: STALL, stallMs: STALL, readSize });
  assert.deepEqual(later, { system: 'ended' });
});

// ---------------------------------------------------------------------------
// Incident replay: the real timeline, old logic vs new logic side by side
// ---------------------------------------------------------------------------

/**
 * Replay the 2026-05-29 incident: both tracks live + active, then the system
 * (SCK) track freezes at T while the mic keeps recording silence. `deriveHealth`
 * maps the two real per-track statuses to the `trackHealth` actually fed to the
 * watcher — letting us drive the OLD global-boolean logic and the NEW per-track
 * logic through the identical timeline and watcher.
 */
function replayIncident(deriveHealth) {
  const clock = { t: 0 };
  const triggers = [];
  const watcher = new SilenceWatcher({
    requiredSilenceMs: 300000, // 5 min, matching the incident settings
    mode: 'dual',
    thresholdLevel: 0.12,
    onTrigger: () => triggers.push(clock.t),
    now: () => clock.t,
  });

  const POLL = 30000;
  const SYSTEM_FREEZE_AT = 600000; // meeting ends → SCK stops producing frames
  const MIC_SILENT_FROM = 600000; // everyone stops talking, mic keeps recording
  const END = 1080000; // past freeze + 120s stall + 300s silence streak

  let sys = null;
  let mic = null;
  for (let t = 0; t <= END; t += POLL) {
    clock.t = t;
    const systemSize = 1000 + 32 * Math.min(t, SYSTEM_FREEZE_AT); // grows then freezes
    const micSize = 1000 + 32 * t; // always grows
    const levels = { system: 0, mic: t < MIC_SILENT_FROM ? 0.5 : 0 };

    sys = classifyTrackGrowth(sys, systemSize, t, STALL);
    mic = classifyTrackGrowth(mic, micSize, t, STALL);

    watcher.update(levels, { trackHealth: deriveHealth(sys.status, mic.status) });
  }
  return triggers;
}

test('incident replay: OLD global-healthy logic never fires (reproduces the bug)', () => {
  // Old behaviour: healthy = every track grew this poll. A single stalled track
  // makes the whole poll "unknown" forever.
  const triggers = replayIncident((sysStatus, micStatus) => {
    const healthy = sysStatus === 'live' && micStatus === 'live';
    return healthy
      ? { system: 'live', mic: 'live' }
      : { system: 'unknown', mic: 'unknown' };
  });
  assert.equal(triggers.length, 0);
});

test('incident replay: NEW per-track logic fires once (proves the fix)', () => {
  // New behaviour: each track keeps its real status; the stalled system track
  // becomes 'ended' and the live mic track is judged on its own.
  const triggers = replayIncident((sysStatus, micStatus) => ({
    system: sysStatus,
    mic: micStatus,
  }));
  assert.equal(triggers.length, 1);
});
