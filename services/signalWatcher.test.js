'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  SignalWatcher,
  DEFAULT_SIGNAL_THRESHOLD,
  DEFAULT_ESCALATION_MS
} = require('./signalWatcher');

/**
 * Measured, not invented.
 *
 * `ROOM` is the peak a MacBook Pro's built-in microphone produces in an EMPTY
 * room (2084, measured 2026-08-14); per-poll peaks during real speech a couple
 * of feet away ran 146-441. Those two ranges OVERLAP, which is why this watcher
 * does not try to tell talking from a room, and why the caller manages the cost
 * of a false verdict instead of the watcher trying to avoid one.
 */
const SPEECH = 8000;
const ROOM = 2084;
const SILENCE = 0;

function makeWatcher(overrides = {}) {
  const verdicts = [];
  let now = 1000;

  const watcher = new SignalWatcher({
    mode: 'dual',
    requiredDeadMs: 45000,
    onDead: (verdict) => verdicts.push(verdict),
    now: () => now,
    ...overrides
  });

  return {
    watcher,
    verdicts,
    /** Feed n polls at the real 150ms cadence. */
    poll(peaks, count = 1) {
      for (let i = 0; i < count; i++) {
        watcher.update(typeof peaks === 'function' ? peaks(i) : peaks);
        now += 150;
      }
    }
  };
}

/**
 * Somebody talking, as a microphone actually sees it: peaks well above the room
 * during words, dropping back to room tone in the gaps between them. A constant
 * level is NOT speech — it is a tone, and it would be its own noise floor.
 */
function talking(system) {
  return (i) => ({ system, mic: i % 2 === 0 ? SPEECH : ROOM });
}

test('SignalWatcher — the failure it exists to catch', async (t) => {
  await t.test('replays the Aug 13 shape: system exactly zero while someone talks', () => {
    const h = makeWatcher();

    // The measured shape of the lost meeting: the mic recorded a full
    // conversation while system.wav held 0 non-zero samples across all
    // 32,042,880 frames.
    h.poll(talking(SILENCE), 800);

    assert.strictEqual(h.verdicts.length, 1, 'should reach exactly one verdict');
    assert.strictEqual(h.verdicts[0].track, 'system');
  });

  await t.test('fires only once, however long the silence continues', () => {
    const h = makeWatcher();
    h.poll(talking(SILENCE), 4000);
    assert.strictEqual(h.verdicts.length, 1);
  });

  await t.test('waits out the full window before deciding', () => {
    const h = makeWatcher();

    h.poll(talking(SILENCE), 100); // ~7.5s of speech
    assert.strictEqual(h.verdicts.length, 0, 'must not fire early');

    h.poll(talking(SILENCE), 700);
    assert.strictEqual(h.verdicts.length, 1);
  });

});

test('SignalWatcher — what must NOT trigger it', async (t) => {
  await t.test('a working system track is never flagged', () => {
    const h = makeWatcher();
    h.poll(talking(SPEECH), 4000);
    assert.strictEqual(h.verdicts.length, 0);
  });

  await t.test('one early burst of system audio clears the suspicion for good', () => {
    const h = makeWatcher();

    // The capture has PROVEN it can deliver audio, so silence after that is
    // just silence — however long it lasts.
    h.poll({ system: SPEECH, mic: SPEECH }, 5);
    h.poll(talking(SILENCE), 4000);

    assert.strictEqual(h.verdicts.length, 0);
  });

  await t.test('silence on BOTH tracks is not evidence of a broken capture', () => {
    const h = makeWatcher();
    h.poll({ system: SILENCE, mic: SILENCE }, 4000);
    assert.strictEqual(h.verdicts.length, 0);
  });

  await t.test('an unreadable system track is never treated as silent', () => {
    // `null` is "could not read the file", which is exactly what a level of 0
    // cannot distinguish itself from — the trap invariant #10 documents.
    const h = makeWatcher();
    h.poll(talking(null), 4000);
    assert.strictEqual(h.verdicts.length, 0);
  });

  await t.test('system-only mode never fires — there is nothing to corroborate with', () => {
    const h = makeWatcher({ mode: 'system' });
    h.poll({ system: SILENCE }, 4000);
    assert.strictEqual(h.verdicts.length, 0);
  });

  await t.test('a stray least-significant bit does not count as system signal', () => {
    const h = makeWatcher();
    h.poll(talking(DEFAULT_SIGNAL_THRESHOLD), 800);
    assert.strictEqual(h.verdicts.length, 1, 'a glitched sample must not clear a dead stream');
  });

  await t.test('a system peak just above the threshold IS signal', () => {
    const h = makeWatcher();
    h.poll(talking(DEFAULT_SIGNAL_THRESHOLD + 1), 800);
    assert.strictEqual(h.verdicts.length, 0);
  });
});

test('SignalWatcher — re-arming after a restart', async (t) => {
  await t.test('rearm clears the verdict and the clock, so it cannot re-fire instantly', () => {
    const h = makeWatcher();
    h.poll(talking(SILENCE), 800);
    assert.strictEqual(h.verdicts.length, 1);

    h.watcher.rearm();
    assert.strictEqual(h.watcher.isDead(), false);

    // The replacement has produced nothing YET. Judging it on the dead one's
    // history would fire again within two polls and burn the restart budget.
    h.poll(talking(SILENCE), 100);
    assert.strictEqual(h.verdicts.length, 1, 'must not fire again immediately');

    h.poll(talking(SILENCE), 700);
    assert.strictEqual(h.verdicts.length, 2, 'a restart that also fails is still reported');
  });

  await t.test('rearm keeps the mic evidence — the mic was never restarted', () => {
    const h = makeWatcher();
    h.poll(talking(SILENCE), 800);
    h.watcher.rearm();

    assert.strictEqual(h.watcher.micHasSignal, true);
  });

  await t.test('rearm can widen the window, so a second verdict means more', () => {
    // The caller escalates on re-arm: a first verdict is cheap and ambient, and
    // only one that survives a restart AND a much longer window is worth
    // interrupting anyone over.
    const h = makeWatcher();
    h.poll(talking(SILENCE), 800);
    assert.strictEqual(h.verdicts.length, 1);

    h.watcher.rearm({ requiredDeadMs: DEFAULT_ESCALATION_MS });

    h.poll(talking(SILENCE), 1000); // 150s — past the OLD window, not the new one
    assert.strictEqual(h.verdicts.length, 1, 'the widened window must actually apply');

    h.poll(talking(SILENCE), 1100); // past 5 minutes
    assert.strictEqual(h.verdicts.length, 2);
  });

  await t.test('a restart that works clears the verdict for good', () => {
    const h = makeWatcher();
    h.poll(talking(SILENCE), 800);
    h.watcher.rearm();

    h.poll(talking(SPEECH), 4000);
    assert.strictEqual(h.verdicts.length, 1, 'the recovered capture must not be flagged');
    assert.strictEqual(h.watcher.isDead(), false);
  });
});

test('SignalWatcher — the window measures evidence, not elapsed recording', async (t) => {
  await t.test('no time is counted before construction or the first poll', () => {
    const verdicts = [];
    let now = 1000;
    const watcher = new SignalWatcher({
      mode: 'dual',
      requiredDeadMs: 45000,
      onDead: (v) => verdicts.push(v),
      now: () => now
    });

    // The watcher is built before the capture processes have written anything;
    // counting from construction would eat the whole window for free.
    now += 60000;
    watcher.update({ system: SILENCE, mic: ROOM });
    watcher.update({ system: SILENCE, mic: SPEECH });
    assert.strictEqual(verdicts.length, 0);
  });

  await t.test('unreadable polls pause the window rather than filling it', () => {
    const h = makeWatcher();

    h.poll(talking(SILENCE), 200);  // ~15s of speech evidence
    h.poll(talking(null), 4000);    // 600s of knowing nothing about the system
    assert.strictEqual(h.verdicts.length, 0, 'unreadable time must not accumulate');

    h.poll(talking(SILENCE), 700);
    assert.strictEqual(h.verdicts.length, 1);
  });
});
