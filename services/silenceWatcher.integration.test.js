'use strict';

/**
 * Integration tests for the silence auto-stop *glue* — the part the pure
 * `silenceWatcher.test.js` can't reach. Those tests feed `classifyTrackGrowth`
 * plain numbers; here we exercise the real on-disk chain against actual files:
 *
 *   fs.statSync(path).size  →  computeTrackHealth(...)  →  watcher.update()
 *
 * `poll()` below calls the SAME `computeTrackHealth` that `main.js`
 * `startLevelMonitor()` runs in production — only the injected `readSize` reader
 * differs (both are a try/statSync/catch). Files are real and grown/stalled on
 * disk; only the clock is injected, so a 120s stall and an N-minute streak
 * collapse to milliseconds. No Electron, no audio, no waiting.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const { SilenceWatcher, computeTrackHealth } = require('./silenceWatcher');

/** Real on-disk size reader, mirroring main.js `statSizeOrNull`. */
function readSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'n4c-silence-'));
}

/** Seed a file with a 44-byte WAV header + one data chunk (size > header). */
function writeWav(p) {
  fs.writeFileSync(p, Buffer.alloc(44 + 3200));
}

/** Simulate the recorder appending ~100ms of 16kHz/16-bit mono frames. */
function grow(p, bytes = 3200) {
  fs.appendFileSync(p, Buffer.alloc(bytes));
}

/**
 * Build a test rig over real files. `poll(levels)` mirrors the production poll
 * body exactly, so this covers main.js's actual read→classify→update shape.
 */
function makeRig({ dir, requiredSilenceMs = 1000, stallMs = 1000, mode = 'dual' }) {
  const tracks = { system: { path: path.join(dir, 'system.wav') } };
  if (mode === 'dual') tracks.mic = { path: path.join(dir, 'mic.wav') };
  for (const t of Object.values(tracks)) writeWav(t.path);

  const clock = { t: 0 };
  const triggers = [];
  const watcher = new SilenceWatcher({
    requiredSilenceMs,
    mode,
    thresholdLevel: 0.12,
    onTrigger: () => triggers.push(clock.t),
    now: () => clock.t,
  });
  const trackGrowth = {};

  const poll = (levels) => {
    const trackHealth = computeTrackHealth({ tracks, trackGrowth, now: clock.t, stallMs, readSize });
    watcher.update(levels, { trackHealth });
  };

  return { tracks, clock, triggers, poll };
}

// ---------------------------------------------------------------------------

test('integration (real files): system track stalls, mic stays live + silent → fires once', () => {
  const dir = makeTempDir();
  try {
    const { tracks, clock, triggers, poll } = makeRig({ dir });

    // Phase 1 — both files growing, someone talking (mic loud): no streak.
    clock.t = 0;   grow(tracks.system.path); grow(tracks.mic.path); poll({ system: 0, mic: 0.5 });
    clock.t = 500; grow(tracks.system.path); grow(tracks.mic.path); poll({ system: 0, mic: 0.5 });
    assert.equal(triggers.length, 0);

    // Phase 2 — system stalls (we stop appending to it); mic keeps growing;
    // everyone goes silent. While < stallMs since the last system growth (t=500)
    // the system track is 'unknown' → the whole poll pauses (the #4/#5 guard).
    clock.t = 1000; grow(tracks.mic.path); poll({ system: 0, mic: 0 }); // 500ms stalled → unknown
    clock.t = 1400; grow(tracks.mic.path); poll({ system: 0, mic: 0 }); // 900ms stalled → unknown
    assert.equal(triggers.length, 0);

    // Phase 3 — system stalled >= stallMs → 'ended'; the live, silent mic is now
    // judged on its own and the streak completes. (Under the OLD global-healthy
    // logic this poll and every one after it would have stayed paused forever.)
    clock.t = 1500; grow(tracks.mic.path); poll({ system: 0, mic: 0 }); // ended → streakStart = 1500
    clock.t = 2000; grow(tracks.mic.path); poll({ system: 0, mic: 0 });
    assert.equal(triggers.length, 0);
    clock.t = 2500; grow(tracks.mic.path); poll({ system: 0, mic: 0 }); // requiredSilenceMs elapsed → fire
    assert.equal(triggers.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integration (real files): stalled system + mic still speaking → never fires', () => {
  const dir = makeTempDir();
  try {
    const { tracks, clock, triggers, poll } = makeRig({ dir });

    clock.t = 0; grow(tracks.system.path); grow(tracks.mic.path); poll({ system: 0, mic: 0.5 });
    // System stalls forever; mic keeps growing AND keeps speaking. A live track
    // with speech must keep the recording alive — the safe direction.
    for (const t of [1000, 1500, 2000, 3000, 4000]) {
      clock.t = t;
      grow(tracks.mic.path);
      poll({ system: 0, mic: 0.5 });
    }
    assert.equal(triggers.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integration (real files): system file vanishes (statSync throws) → ended, mic live+silent → fires', () => {
  const dir = makeTempDir();
  try {
    const { tracks, clock, triggers, poll } = makeRig({ dir });

    clock.t = 0; grow(tracks.system.path); grow(tracks.mic.path); poll({ system: 0, mic: 0.5 });

    // Delete the system file mid-recording → fs.statSync throws → size=null →
    // exercises the catch branch (no growth → unknown → ended).
    fs.rmSync(tracks.system.path);
    clock.t = 500;  grow(tracks.mic.path); poll({ system: 0, mic: 0 }); // 500ms → unknown (pause)
    assert.equal(triggers.length, 0);
    clock.t = 1000; grow(tracks.mic.path); poll({ system: 0, mic: 0 }); // ended → streakStart = 1000
    clock.t = 1500; grow(tracks.mic.path); poll({ system: 0, mic: 0 });
    assert.equal(triggers.length, 0);
    clock.t = 2000; grow(tracks.mic.path); poll({ system: 0, mic: 0 }); // requiredSilenceMs elapsed → fire
    assert.equal(triggers.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integration (real files): both tracks stall → all-ended counts as silence → fires', () => {
  const dir = makeTempDir();
  try {
    const { tracks, clock, triggers, poll } = makeRig({ dir });

    clock.t = 0; grow(tracks.system.path); grow(tracks.mic.path); poll({ system: 0.5, mic: 0.5 });
    // Both stall (e.g. whole capture pipeline dies). Levels are stale/loud but
    // must be ignored once both tracks are 'ended'.
    clock.t = 1000; poll({ system: 0.5, mic: 0.5 }); // both ended (1000-0>=1000) → silent → streakStart = 1000
    clock.t = 1500; poll({ system: 0.5, mic: 0.5 });
    assert.equal(triggers.length, 0);
    clock.t = 2000; poll({ system: 0.5, mic: 0.5 }); // requiredSilenceMs elapsed → fire
    assert.equal(triggers.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
