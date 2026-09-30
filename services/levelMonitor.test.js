'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LevelMonitor } = require('./levelMonitor');
const { computeTrackHealth, DEFAULT_STALL_TIMEOUT_MS } = require('./silenceWatcher');

const HEADER_BYTES = 44;

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-levels-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Create a WAV holding `n` samples produced by `fn`. */
function writeWav(file, n, fn) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.write('WAVE', 8, 'ascii');
  header.write('data', 36, 'ascii');
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(fn(i), i * 2);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

/** Append `n` more samples, as a live capture would. */
function appendSamples(file, n, fn) {
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(fn(i), i * 2);
  fs.appendFileSync(file, data);
}

test('_readPeak: reports the true peak of a track holding audio', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'mic.wav');
    writeWav(file, 1000, () => 9000);

    const monitor = new LevelMonitor(() => {});
    monitor.addTrack('mic', file);

    assert.strictEqual(monitor._readPeak(monitor.tracks.mic), 9000);
  });
});

test('_readPeak: reports 0 for a zero-filled capture', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'system.wav');
    writeWav(file, 1000, () => 0);

    const monitor = new LevelMonitor(() => {});
    monitor.addTrack('system', file);

    // The distinction the whole feature turns on: `_readLevel` would ALSO return
    // 0 here, and would return 0 for a quiet room, a missing file and a read
    // failure. Only the peak separates digital silence from all of those.
    assert.strictEqual(monitor._readPeak(monitor.tracks.system), 0);
    assert.strictEqual(monitor._readLevel(file), 0, 'level cannot tell these apart');
  });
});

test('_readPeak: an unreadable file is null, NOT 0', () => {
  const monitor = new LevelMonitor(() => {});
  monitor.addTrack('system', '/nope/missing.wav');

  assert.strictEqual(monitor._readPeak(monitor.tracks.system), null);
});

test('_readPeak: reads only what is new, so nothing is scanned twice', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'system.wav');
    writeWav(file, 1000, () => 5000);

    const monitor = new LevelMonitor(() => {});
    monitor.addTrack('system', file);

    assert.strictEqual(monitor._readPeak(monitor.tracks.system), 5000);

    // Nothing appended since — no new evidence either way, which is NOT silence.
    assert.strictEqual(monitor._readPeak(monitor.tracks.system), null);

    appendSamples(file, 1000, () => 0);
    assert.strictEqual(monitor._readPeak(monitor.tracks.system), 0, 'the new stretch is silent');
  });
});

test('_readPeak: covers every sample between polls, skipping none', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'system.wav');
    writeWav(file, 10, () => 0);

    const monitor = new LevelMonitor(() => {});
    monitor.addTrack('system', file);
    monitor._readPeak(monitor.tracks.system);

    // A single loud sample in the middle of an otherwise silent stretch. A
    // fixed trailing window would miss it and call the track dead.
    appendSamples(file, 5000, (i) => (i === 2500 ? 12000 : 0));
    assert.strictEqual(monitor._readPeak(monitor.tracks.system), 12000);
  });
});

test('_readPeak: a truncated or replaced file rewinds instead of reading past the end', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'system.wav');
    writeWav(file, 5000, () => 7000);

    const monitor = new LevelMonitor(() => {});
    monitor.addTrack('system', file);
    monitor._readPeak(monitor.tracks.system);

    // The helper truncates whatever path it is given — this is what a restart
    // onto the same path would look like.
    writeWav(file, 100, () => 3000);
    assert.strictEqual(monitor._readPeak(monitor.tracks.system), 3000);
  });
});

test('retargetTrack: follows the track to a new file and restarts its peak scan', () => {
  withTempDir((dir) => {
    const part1 = path.join(dir, 'system.wav');
    const part2 = path.join(dir, 'system.part2.wav');
    writeWav(part1, 5000, () => 0);
    writeWav(part2, 5000, () => 6000);

    const monitor = new LevelMonitor(() => {});
    monitor.addTrack('system', part1);
    assert.strictEqual(monitor._readPeak(monitor.tracks.system), 0);

    monitor.retargetTrack('system', part2);

    assert.strictEqual(monitor.tracks.system.path, part2);
    // The offset must start again from the new file's header. Carrying the old
    // one over would skip the first 5000 samples of the replacement.
    assert.strictEqual(monitor._readPeak(monitor.tracks.system), 6000);
  });
});

test('retargetTrack: ignores a track that was never added', () => {
  const monitor = new LevelMonitor(() => {});
  monitor.retargetTrack('system', '/some/file.wav');
  assert.deepStrictEqual(monitor.tracks, {});
});

test('a restarted track is classified LIVE once its growth state is cleared', () => {
  withTempDir((dir) => {
    const part1 = path.join(dir, 'system.wav');
    const part2 = path.join(dir, 'system.part2.wav');
    writeWav(part1, 100000, () => 5000); // a big first part
    writeWav(part2, 10, () => 5000);     // the replacement starts nearly empty

    const monitor = new LevelMonitor(() => {});
    monitor.addTrack('system', part1);

    const readSize = (p) => { try { return fs.statSync(p).size; } catch { return null; } };
    const growth = {};
    let now = 1000;

    computeTrackHealth({ tracks: monitor.tracks, trackGrowth: growth, now, stallMs: DEFAULT_STALL_TIMEOUT_MS, readSize });
    appendSamples(part1, 1000, () => 5000);
    now += 150;
    let health = computeTrackHealth({ tracks: monitor.tracks, trackGrowth: growth, now, stallMs: DEFAULT_STALL_TIMEOUT_MS, readSize });
    assert.strictEqual(health.system, 'live');

    // THE BUG this guards: the replacement file is far smaller than the one it
    // replaces, so `size > lastSize` is false on every poll. Left uncleared, a
    // perfectly healthy restarted capture reads as `unknown`, then `ended` after
    // the stall timeout — a red "stalled" chip on a working track, and the
    // silence watcher excluding it from its decision.
    monitor.retargetTrack('system', part2);
    delete growth.system;

    now += 150;
    computeTrackHealth({ tracks: monitor.tracks, trackGrowth: growth, now, stallMs: DEFAULT_STALL_TIMEOUT_MS, readSize });
    appendSamples(part2, 1000, () => 5000);
    now += 150;
    health = computeTrackHealth({ tracks: monitor.tracks, trackGrowth: growth, now, stallMs: DEFAULT_STALL_TIMEOUT_MS, readSize });

    assert.strictEqual(health.system, 'live', 'the replacement must not read as stalled');
  });
});

test('the poll hands peaks alongside levels', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'system.wav');
    writeWav(file, 1000, () => 4000);

    let received = null;
    const monitor = new LevelMonitor((levels, peaks) => { received = { levels, peaks }; });
    monitor.addTrack('system', file);
    monitor._poll();

    assert.ok(received, 'callback should fire');
    assert.strictEqual(received.peaks.system, 4000);
    assert.ok(typeof received.levels.system === 'number');
  });
});
