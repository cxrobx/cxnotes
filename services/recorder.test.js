const test = require('node:test');
const assert = require('node:assert');

const {
  Recorder,
  sckStartupVerdict,
  watchSckStartup,
  sckSilentWarning,
  resolveSystemCaptureMethod,
  sessionTimestamp,
  oversizeWarning,
  SCK_START_TIMEOUT_MS,
  WAV_HEADER_BYTES,
  planStitch,
  wavDurationMs,
  resolveFinalTrackStatus,
  DualTrackRecorder,
  SYSTEM_RESTART_MAX
} = require('./recorder');

// ---------------------------------------------------------------------------
// sckStartupVerdict — the pure decision behind the SCK health check
// ---------------------------------------------------------------------------

test('sckStartupVerdict: a header-only file at 3s is still WARMING UP, not dead', () => {
  // THE REGRESSION. The old check was a one-shot setTimeout at exactly 3000ms
  // testing `size <= 44`. On a busy Mac (3 displays, ~570 windows, 53 apps) SCK
  // needs ~2.5-3s to deliver its first frame, so a healthy capture was declared
  // dead. Session 2026-07-31_16-45-59 lost exactly this race — back when a dead
  // verdict swapped the session to BlackHole and recorded silence. The verdict
  // now only raises a warning, but calling a live capture dead is still wrong.
  assert.strictEqual(sckStartupVerdict(WAV_HEADER_BYTES, 3000), 'wait');
});

test('sckStartupVerdict: measured cold-start latencies are not called dead', () => {
  // Observed on the affected machine: ~1.65s warm, ~2.5-3.0s cold.
  for (const elapsed of [1650, 1680, 2500, 2900, 3000, 4000]) {
    assert.strictEqual(
      sckStartupVerdict(WAV_HEADER_BYTES, elapsed),
      'wait',
      `header-only at ${elapsed}ms should keep waiting`
    );
  }
});

test('sckStartupVerdict: any byte past the header means SCK is alive', () => {
  assert.strictEqual(sckStartupVerdict(WAV_HEADER_BYTES + 1, 0), 'alive');
  // Real first-write size seen from the helper at ~16kB/s mono 16-bit.
  assert.strictEqual(sckStartupVerdict(30764, 3000), 'alive');
});

test('sckStartupVerdict: a genuinely dead SCK is still called dead at the timeout', () => {
  assert.strictEqual(sckStartupVerdict(WAV_HEADER_BYTES, SCK_START_TIMEOUT_MS), 'dead');
  assert.strictEqual(sckStartupVerdict(0, SCK_START_TIMEOUT_MS + 1), 'dead');
});

test('sckStartupVerdict: a missing file (0 bytes) is treated as not-yet-started', () => {
  assert.strictEqual(sckStartupVerdict(0, 500), 'wait');
});

test('sckStartupVerdict: alive wins over the timeout (never discard real audio)', () => {
  // A capture holding real frames must never be judged dead, however late the
  // poll runs — a false 'dead' now cries wolf about a track that is fine, and
  // used to delete the file outright.
  assert.strictEqual(sckStartupVerdict(999999, SCK_START_TIMEOUT_MS * 10), 'alive');
});

// ---------------------------------------------------------------------------
// watchSckStartup — the polling wrapper
// ---------------------------------------------------------------------------

/** Drive the watcher manually: collect the tick fn instead of using real timers. */
function harness({ sizes, recording = true, timeoutMs = SCK_START_TIMEOUT_MS }) {
  let now = 0;
  let tick = null;
  let cleared = false;
  const calls = [];
  let idx = 0;

  watchSckStartup({
    getFilePath: () => '/fake/system.wav',
    isRecording: () => recording,
    onNoAudio: () => calls.push('warned'),
    onDecided: (v) => calls.push(`decided:${v}`),
    timeoutMs,
    _fs: {
      statSync: () => {
        const size = sizes[Math.min(idx, sizes.length - 1)];
        if (size === null) throw new Error('ENOENT');
        return { size };
      }
    },
    _setInterval: (fn) => { tick = fn; return 'handle'; },
    _clearInterval: () => { cleared = true; },
    _now: () => now
  });

  return {
    advance(ms) { now += ms; idx += 1; tick(); },
    calls,
    isCleared: () => cleared
  };
}

test('watchSckStartup: a slow SCK start raises NO warning (the production bug)', () => {
  // Header-only for the first 2.5s, then frames land — the real cold-start shape.
  const h = harness({ sizes: [44, 44, 44, 44, 44, 30764] });
  for (let i = 0; i < 5; i++) h.advance(500);
  assert.deepStrictEqual(h.calls, ['decided:alive']);
  assert.ok(!h.calls.includes('warned'), 'must not cry wolf on a healthy slow start');
  assert.ok(h.isCleared(), 'polling should stop once SCK is confirmed alive');
});

test('watchSckStartup: a truly dead SCK warns after the timeout', () => {
  const h = harness({ sizes: [44] });
  for (let i = 0; i < 16; i++) h.advance(500);
  assert.ok(h.calls.includes('warned'), 'a never-starting SCK must tell the user');
  assert.ok(h.isCleared());
});

test('watchSckStartup: no warning fires before the timeout elapses', () => {
  const h = harness({ sizes: [44] });
  for (let i = 0; i < 15; i++) h.advance(500); // 7.5s — just under 8s
  assert.ok(!h.calls.includes('warned'), 'must not warn early');
});

test('watchSckStartup: stops quietly when recording ends first', () => {
  const h = harness({ sizes: [44], recording: false });
  h.advance(500);
  assert.deepStrictEqual(h.calls, ['decided:stopped']);
  assert.ok(!h.calls.includes('warned'));
});

// ---------------------------------------------------------------------------
// sckSilentWarning — make a silent SCK capture self-diagnosing
// ---------------------------------------------------------------------------

test('sckSilentWarning: says the system track is silent AND that the mic survives', () => {
  // Both halves matter. Without the first the user does not know to re-record;
  // without the second they assume the whole session is lost and stop.
  const msg = sckSilentWarning('Chris’s AirPods Pro');
  assert.match(msg, /system track will be silent/);
  assert.match(msg, /microphone is still recording/i);
});

test('sckSilentWarning: names the output device, whatever it is', () => {
  // Unlike the old BlackHole warning this makes no judgement about whether the
  // device is "right" — that judgement was a regex on a device NAME, which was
  // wrong in both directions. The name is evidence for a human, not a verdict.
  for (const device of ['Chris’s AirPods Pro', 'BlackHole 2ch', 'Some Aggregate Device']) {
    assert.match(sckSilentWarning(device), new RegExp(device.replace(/[’]/g, '.')));
  }
});

test('sckSilentWarning: degrades to the base message when output is unknown', () => {
  const msg = sckSilentWarning(null);
  assert.match(msg, /system track will be silent/);
  assert.doesNotMatch(msg, /Current output device/);
});

test('sckSilentWarning: never advises installing BlackHole', () => {
  // The fallback is gone; advertising it would send the user to configure a
  // device that no longer participates in capture.
  for (const device of [null, 'MacBook Pro Speakers']) {
    assert.doesNotMatch(sckSilentWarning(device), /BlackHole|Multi-Output/i);
  }
});

// ---------------------------------------------------------------------------
// resolveSystemCaptureMethod — one success case, three throws, no fallback
// ---------------------------------------------------------------------------

test('resolveSystemCaptureMethod: SCK available and permitted is the success case', () => {
  const r = resolveSystemCaptureMethod('/bin/sck', {
    _check: () => ({ available: true, permitted: true }),
    _exists: () => true
  });

  assert.deepStrictEqual(r, { method: 'sck', sckBinaryPath: '/bin/sck' });
});

test('resolveSystemCaptureMethod: a configured-but-unbuilt helper says BUILD, not macOS', () => {
  // Both an unbuilt helper and an old OS arrive as "SCK unavailable", and the
  // fixes are opposite. Deciding on the file's existence rather than on
  // checkSckAvailable's reason wording is what keeps them apart.
  assert.throws(
    () => resolveSystemCaptureMethod('/configured/but/absent/sck', {
      _exists: () => false,
      _check: () => ({ available: false, permitted: null, reason: 'SCK binary not found' })
    }),
    (err) => {
      assert.match(err.message, /npm run build:native/);
      assert.doesNotMatch(err.message, /macOS 13/, 'the OS is not the problem here');
      return true;
    }
  );
});

test('resolveSystemCaptureMethod: each failure names ONE specific, correct fix', () => {
  // The old error named two wrong fixes at once ("grant permission or install
  // BlackHole 2ch") — for a missing binary neither was the answer. Each cause
  // must now point at its own remedy and NOT at the others'.
  const cases = [
    {
      label: 'helper missing',
      path: null,
      check: () => { throw new Error('should not probe without a path'); },
      wants: /npm run build:native/,
      rejects: /permission|macOS 13/
    },
    {
      label: 'grant refused',
      path: '/bin/sck',
      exists: () => true,
      check: () => ({ available: true, permitted: false }),
      wants: /Screen Recording/,
      rejects: /build:native|macOS 13/
    },
    {
      label: 'SCK unavailable',
      path: '/bin/sck',
      exists: () => true,
      check: () => ({ available: false, permitted: null, reason: 'no SCK on this OS' }),
      wants: /macOS 13/,
      rejects: /build:native|Screen Recording/
    }
  ];

  for (const c of cases) {
    assert.throws(
      () => resolveSystemCaptureMethod(c.path, { _check: c.check, _exists: c.exists || (() => true) }),
      (err) => {
        assert.match(err.message, c.wants, `${c.label}: names its own fix`);
        assert.doesNotMatch(err.message, c.rejects, `${c.label}: does not name another's`);
        assert.doesNotMatch(err.message, /BlackHole/i, `${c.label}: never mentions BlackHole`);
        return true;
      },
      c.label
    );
  }
});

test('resolveSystemCaptureMethod: never returns a non-SCK method', () => {
  // The guard against re-introducing a fallback by return value rather than by
  // a new branch. Anything other than a throw here must be SCK.
  for (const check of [
    () => ({ available: false, permitted: null }),
    () => ({ available: true, permitted: false }),
    () => ({ available: true, permitted: true })
  ]) {
    let result = null;
    try { result = resolveSystemCaptureMethod('/bin/sck', { _check: check, _exists: () => true }); } catch { /* expected */ }
    if (result) assert.strictEqual(result.method, 'sck');
  }
});

/* ── sessionTimestamp ────────────────────────────────────────── */

test('sessionTimestamp renders YYYY-MM-DD_HH-MM-SS in UTC', () => {
  const stamp = sessionTimestamp(new Date('2026-08-07T14:23:45.678Z'));

  assert.strictEqual(stamp, '2026-08-07_14-23-45');
  assert.strictEqual(stamp.length, 19, 'no milliseconds, no trailing Z');
});

test('sessionTimestamp output is what the summariser can parse back', () => {
  // services/summariser.js recovers a meeting date from the directory name via
  // /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_session/, so this shape is a
  // contract between the two modules, not a cosmetic choice.
  const stamp = sessionTimestamp(new Date('2026-01-02T03:04:05Z'));

  assert.match(`${stamp}_session`, /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_session/);
});

test('sessionTimestamp sorts chronologically as a plain string', () => {
  const earlier = sessionTimestamp(new Date('2026-08-07T09:00:00Z'));
  const later = sessionTimestamp(new Date('2026-08-07T14:00:00Z'));

  assert.ok(earlier < later, 'the recordings list sorts on this');
});

/* ── oversizeWarning ─────────────────────────────────────────── */

test('oversizeWarning reports whole megabytes', () => {
  assert.strictEqual(
    oversizeWarning(1024 * 1024 * 1024),
    'Recording size is 1024MB. Consider stopping to avoid disk space issues.'
  );
});

test('oversizeWarning rounds rather than truncating', () => {
  assert.match(oversizeWarning(1.6 * 1024 * 1024), /is 2MB/);
});

test('oversizeWarning suggests stopping, and does not claim to have stopped', () => {
  // Warning rather than stopping is deliberate: losing a long meeting to an
  // automatic cut-off would be far worse than a large file.
  const message = oversizeWarning(2 * 1024 * 1024 * 1024);

  assert.match(message, /Consider stopping/);
  assert.doesNotMatch(message, /stopped|aborted|cancelled/i);
});

/* ── Recorder lifecycle guards ───────────────────────────────── */

test('a fresh Recorder reports no status and is not recording', () => {
  const rec = new Recorder('/tmp/does-not-matter');

  assert.strictEqual(rec.getStatus(), null);
  assert.strictEqual(rec.isRecording, false);
  assert.strictEqual(rec.captureProcess, null);
});

test('Recorder.stop rejects when nothing is being recorded', async () => {
  const rec = new Recorder('/tmp/does-not-matter');

  await assert.rejects(() => rec.stop(), /Nothing is being recorded/);
});

test('Recorder.start refuses to start a second recording', () => {
  const rec = new Recorder('/tmp/does-not-matter');
  rec.isRecording = true;

  assert.throws(() => rec.start(), /already running/);
});

test('Recorder.getStatus reports elapsed time while recording', () => {
  const rec = new Recorder('/tmp/does-not-matter');
  rec.isRecording = true;
  rec.startTime = Date.now() - 5000;
  rec.currentFile = '/tmp/x_recording.wav';

  const status = rec.getStatus();

  assert.strictEqual(status.isRecording, true);
  assert.strictEqual(status.filepath, '/tmp/x_recording.wav');
  assert.ok(status.duration >= 5000 && status.duration < 6000);
});

test('Recorder.cleanup clears both timers, not just the size monitor', () => {
  // The SCK health interval used to be left running by cleanup(), so an
  // interval holding a closure over a dead recorder kept the process alive.
  const rec = new Recorder('/tmp/does-not-matter');
  rec.sizeInterval = setInterval(() => {}, 1000);
  rec._sckHealthInterval = setInterval(() => {}, 1000);

  rec.cleanup();

  assert.strictEqual(rec.sizeInterval, null);
  assert.strictEqual(rec._sckHealthInterval, null, 'the SCK timer must go too');
  assert.strictEqual(rec.isRecording, false);
});

test('Recorder.cleanup is safe with no timers and no process', () => {
  const rec = new Recorder('/tmp/does-not-matter');

  assert.doesNotThrow(() => rec.cleanup());
  assert.strictEqual(rec.isRecording, false);
});

test('Recorder.cleanup kills a live capture process', () => {
  const rec = new Recorder('/tmp/does-not-matter');
  const signals = [];
  rec.isRecording = true;
  rec.captureProcess = { kill: (sig) => signals.push(sig) };

  rec.cleanup();

  assert.deepStrictEqual(signals, ['SIGKILL'], 'quitting does not wait politely');
});

test('Recorder.cleanup leaves an already-stopped process alone', () => {
  const rec = new Recorder('/tmp/does-not-matter');
  const signals = [];
  rec.isRecording = false;
  rec.captureProcess = { kill: (sig) => signals.push(sig) };

  rec.cleanup();

  assert.deepStrictEqual(signals, []);
});

// ---------------------------------------------------------------------------
// Restart stitching — the offset arithmetic that keeps the two tracks aligned
// ---------------------------------------------------------------------------

/** A capture file holding `seconds` of 16 kHz 16-bit mono audio. */
function partOf(file, seconds, stoppedAt) {
  return { file, bytes: WAV_HEADER_BYTES + Math.round(seconds * 16000 * 2), stoppedAt };
}

test('wavDurationMs reads duration from size alone', () => {
  assert.strictEqual(wavDurationMs(WAV_HEADER_BYTES + 16000 * 2 * 10), 10000);
  assert.strictEqual(wavDurationMs(WAV_HEADER_BYTES), 0, 'a header-only file holds nothing');
  assert.strictEqual(wavDurationMs(0), 0, 'a missing file is not negative');
  assert.strictEqual(wavDurationMs(undefined), 0);
});

test('planStitch leaves a single part alone — there is nothing to join', () => {
  const segments = planStitch([partOf('system.wav', 60, 100000)]);
  assert.deepStrictEqual(segments, [{ type: 'part', file: 'system.wav' }]);
});

test('planStitch pads the wall-clock gap between two parts', () => {
  // Part one ran 10s and was stopped at t=100000.
  // Part two holds 5s and was stopped at t=108000, so its audio began at
  // t=103000 — a 3s gap while the capture was being restarted.
  const segments = planStitch([
    partOf('system.wav', 10, 100000),
    partOf('system.part2.wav', 5, 108000)
  ]);

  assert.deepStrictEqual(segments, [
    { type: 'part', file: 'system.wav' },
    { type: 'pad', ms: 3000 },
    { type: 'part', file: 'system.part2.wav' }
  ]);
});

test('planStitch derives audio start from the STOP time, absorbing SCK startup lag', () => {
  // The whole reason the gap is computed backwards from `stoppedAt` rather than
  // forwards from a spawn time: ScreenCaptureKit takes 1.7-3s to deliver its
  // first frame, so a part spawned at T does not start recording at T. Here the
  // replacement was spawned immediately but only produced 2s of audio before
  // being stopped at t=110000 — so 8s of wall clock is missing, not 3s.
  const segments = planStitch([
    partOf('system.wav', 10, 100000),
    partOf('system.part2.wav', 2, 110000)
  ]);

  assert.deepStrictEqual(segments[1], { type: 'pad', ms: 8000 });
});

test('planStitch never emits a negative pad', () => {
  // Clock skew, or a part that overlaps its predecessor. A negative pad would
  // silently shorten the track and skew everything after it.
  const segments = planStitch([
    partOf('system.wav', 10, 100000),
    partOf('system.part2.wav', 30, 105000)
  ]);

  assert.deepStrictEqual(segments, [
    { type: 'part', file: 'system.wav' },
    { type: 'part', file: 'system.part2.wav' }
  ], 'no pad at all rather than a negative one');
});

test('planStitch handles the maximum of two restarts', () => {
  const segments = planStitch([
    partOf('system.wav', 10, 100000),
    partOf('system.part2.wav', 10, 115000),   // audio began 105000 → 5s gap
    partOf('system.part3.wav', 10, 132000)    // audio began 122000 → 7s gap
  ]);

  assert.deepStrictEqual(segments.map((s) => s.type), ['part', 'pad', 'part', 'pad', 'part']);
  assert.strictEqual(segments[1].ms, 5000);
  assert.strictEqual(segments[3].ms, 7000);
});

test('planStitch keeps the stitched track the same length as the wall clock it spans', () => {
  // The property that actually matters: transcriptMerger orders entries by each
  // file's own internal offsets, so if the stitched system track is shorter than
  // the time it covers, every word after the gap is attributed to the wrong
  // moment and the speakers interleave wrongly for the rest of the meeting.
  const parts = [
    partOf('system.wav', 12, 100000),
    partOf('system.part2.wav', 20, 140000)
  ];
  const segments = planStitch(parts);

  const stitchedMs = segments.reduce((total, seg) => (
    total + (seg.type === 'pad' ? seg.ms : wavDurationMs(parts.find((p) => p.file === seg.file).bytes))
  ), 0);

  const firstAudioStart = parts[0].stoppedAt - wavDurationMs(parts[0].bytes);
  const spannedMs = parts[parts.length - 1].stoppedAt - firstAudioStart;

  assert.strictEqual(stitchedMs, spannedMs);
});

// ---------------------------------------------------------------------------
// resolveFinalTrackStatus — stopping must not overwrite a mid-flight verdict
// ---------------------------------------------------------------------------

test('resolveFinalTrackStatus does NOT relabel a silent track as complete', () => {
  // The bug this replaces: `status = size > 0 ? 'complete' : 'empty'`. A
  // zero-filled WAV has a perfectly healthy size, so a track already known to be
  // silent was relabelled complete on the way out and every downstream badge,
  // note and manifest consumer read it as a successful capture.
  assert.strictEqual(resolveFinalTrackStatus('silent', 5_000_000), 'silent');
});

test('resolveFinalTrackStatus preserves failure states that have audio behind them', () => {
  assert.strictEqual(resolveFinalTrackStatus('failed', 5_000_000), 'failed');
  assert.strictEqual(resolveFinalTrackStatus('error', 5_000_000), 'error');
});

test('resolveFinalTrackStatus completes an ordinary recording', () => {
  assert.strictEqual(resolveFinalTrackStatus('recording', 5_000_000), 'complete');
});

test('resolveFinalTrackStatus calls a zero-byte file empty whatever it was', () => {
  assert.strictEqual(resolveFinalTrackStatus('silent', 0), 'empty');
  assert.strictEqual(resolveFinalTrackStatus('recording', 0), 'empty');
});

// ---------------------------------------------------------------------------
// restartSystemCapture — the guards around a live capture process
// ---------------------------------------------------------------------------

const { EventEmitter } = require('node:events');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');

/** A child process that exits shortly after being signalled. */
function fakeProcess() {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => { setTimeout(() => proc.emit('exit', 0, 'SIGTERM'), 10); };
  return proc;
}

/** A DualTrackRecorder mid-recording, with the environment stubbed out. */
function recordingRecorder() {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'cxnotes-restart-'));
  const rec = new DualTrackRecorder(dir, 'mic', 'Remote', 'Me', '/fake/sck', {});

  rec.sessionDir = dir;
  rec.systemFile = nodePath.join(dir, 'system.wav');
  rec.micFile = nodePath.join(dir, 'mic.wav');
  rec.isRecording = true;
  rec.manifest = { tracks: { system: {}, mic: {} } };
  rec.systemParts = [{ file: rec.systemFile, spawnedAt: Date.now(), stoppedAt: null, bytes: 0 }];
  rec.systemProcess = fakeProcess();

  rec._resolveCapture = () => ({ method: 'sck', sckBinaryPath: '/fake/sck' });
  rec.spawned = [];
  rec._spawnSystemCapture = (bin, file) => { rec.spawned.push(file); return fakeProcess(); };

  rec.cleanupDir = () => nodeFs.rmSync(dir, { recursive: true, force: true });
  return rec;
}

test('restartSystemCapture: an ordinary restart spawns a replacement', async () => {
  // The control. Without it, "never spawn" would pass every guard test below
  // while quietly disabling the entire feature.
  const rec = recordingRecorder();
  try {
    const result = await rec.restartSystemCapture('test', () => {});

    assert.strictEqual(result.restarted, true);
    assert.strictEqual(rec.spawned.length, 1);
    assert.match(rec.spawned[0], /system\.part2\.wav$/);
    assert.strictEqual(rec.systemParts.length, 2);
    assert.strictEqual(rec.manifest.tracks.system.restarts, 1);
  } finally {
    rec.cleanupDir();
  }
});

test('restartSystemCapture: a stop DURING the restart does not orphan a helper', async () => {
  // THE BUG. Killing the old helper takes up to RESTART_STOP_GRACE_MS, and the
  // guard at the top of restartSystemCapture ran before that wait. A stop
  // landing inside the window has already captured `systemProcess` into its own
  // kill list, so a replacement spawned afterwards is owned by nobody and keeps
  // recording forever — gotcha #4 exactly.
  const rec = recordingRecorder();
  try {
    const pending = rec.restartSystemCapture('test', () => {});

    // The user hits Stop while the old helper is still being drained.
    rec.isRecording = false;
    rec._stopping = true;

    const result = await pending;

    assert.strictEqual(result.restarted, false);
    assert.strictEqual(rec.spawned.length, 0, 'no helper may be spawned after a stop begins');
    assert.strictEqual(rec.systemParts.length, 1, 'and no phantom part is recorded');
  } finally {
    rec.cleanupDir();
  }
});

test('restartSystemCapture: refuses once the restart budget is spent', async () => {
  const rec = recordingRecorder();
  try {
    rec.systemRestartCount = SYSTEM_RESTART_MAX;
    const result = await rec.restartSystemCapture('test', () => {});

    assert.strictEqual(result.restarted, false);
    assert.strictEqual(rec.spawned.length, 0);
  } finally {
    rec.cleanupDir();
  }
});

test('restartSystemCapture: refuses a second restart too soon after the first', async () => {
  const rec = recordingRecorder();
  try {
    rec.systemRestartCount = 1;
    rec.lastSystemRestartAt = Date.now() - 1000; // well inside the interval
    const result = await rec.restartSystemCapture('test', () => {});

    assert.strictEqual(result.restarted, false);
    assert.strictEqual(rec.spawned.length, 0);
  } finally {
    rec.cleanupDir();
  }
});

test('restartSystemCapture: never signals the mic', async () => {
  // The property invariant #22 turns on. A restart that touched the mic would
  // turn a recoverable one-track gap into a hole in both.
  const rec = recordingRecorder();
  try {
    const micSignals = [];
    rec.micProcess = fakeProcess();
    rec.micProcess.kill = (sig) => micSignals.push(sig);

    await rec.restartSystemCapture('test', () => {});

    assert.deepStrictEqual(micSignals, [], 'the mic process must not be signalled');
    assert.strictEqual(rec.micFile, nodePath.join(rec.sessionDir, 'mic.wav'), 'and its file is unchanged');
  } finally {
    rec.cleanupDir();
  }
});

// ---------------------------------------------------------------------------
// stitchSystemParts — what happens to system.wav when things go sideways
// ---------------------------------------------------------------------------

/**
 * Write a real 16 kHz 16-bit mono WAV holding `seconds` of non-silent audio
 * (or a bare header at 0). The full `fmt ` chunk matters: the stitch shells out
 * to sox, and sox refuses a file whose header it cannot parse — a truncated
 * header makes the test fail somewhere other than where it is aiming.
 */
function writeCapture(file, seconds) {
  const samples = Math.round(seconds * 16000);
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);          // PCM
  header.writeUInt16LE(1, 22);          // mono
  header.writeUInt32LE(16000, 24);      // sample rate
  header.writeUInt32LE(32000, 28);      // byte rate
  header.writeUInt16LE(2, 32);          // block align
  header.writeUInt16LE(16, 34);         // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples * 2, 40);

  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(6000, i * 2);
  nodeFs.writeFileSync(file, Buffer.concat([header, data]));
}

test('stitchSystemParts: promotes the only part holding audio when part one is empty', async () => {
  // THE CASE THIS EXISTS FOR. The system capture produced not one byte, the
  // restart fixed it, and all the audio is in part two. Leaving `system.wav` as
  // the empty husk would throw away the recording in precisely the situation
  // where the recovery worked perfectly.
  const rec = recordingRecorder();
  try {
    const part2 = nodePath.join(rec.sessionDir, 'system.part2.wav');
    writeCapture(rec.systemFile, 0);  // header only — SCK delivered nothing
    writeCapture(part2, 5);
    rec.systemParts = [
      { file: rec.systemFile, stoppedAt: 1000, bytes: 0 },
      { file: part2, stoppedAt: 9000, bytes: 0 }
    ];

    const result = await rec.stitchSystemParts();

    assert.strictEqual(result.stitched, true);
    assert.ok(nodeFs.statSync(rec.systemFile).size > WAV_HEADER_BYTES,
      'system.wav must hold the surviving audio, not the empty husk');
    assert.ok(nodeFs.existsSync(nodePath.join(rec.sessionDir, 'system.part1.wav')),
      'the empty part is still kept');
  } finally {
    rec.cleanupDir();
  }
});

test('stitchSystemParts: leaves system.wav alone when part one is the only audio', async () => {
  const rec = recordingRecorder();
  try {
    writeCapture(rec.systemFile, 5);
    const part2 = nodePath.join(rec.sessionDir, 'system.part2.wav');
    writeCapture(part2, 0); // the restart produced nothing
    rec.systemParts = [
      { file: rec.systemFile, stoppedAt: 1000, bytes: 0 },
      { file: part2, stoppedAt: 9000, bytes: 0 }
    ];
    const before = nodeFs.statSync(rec.systemFile).size;

    await rec.stitchSystemParts();

    assert.strictEqual(nodeFs.statSync(rec.systemFile).size, before);
  } finally {
    rec.cleanupDir();
  }
});

test('_replaceSystemFileWith: a failed swap puts part one BACK at system.wav', () => {
  // Otherwise the session ends with no `system.wav` at all and the track is
  // reported missing — strictly worse than the documented failure mode, which
  // is "you keep the pre-restart audio".
  const rec = recordingRecorder();
  try {
    writeCapture(rec.systemFile, 5);
    const original = nodeFs.statSync(rec.systemFile).size;

    assert.throws(() => rec._replaceSystemFileWith('/nope/missing.wav'));

    assert.ok(nodeFs.existsSync(rec.systemFile), 'system.wav must still exist');
    assert.strictEqual(nodeFs.statSync(rec.systemFile).size, original);
    assert.strictEqual(rec.systemParts[0].file, rec.systemFile,
      'and the part list must not claim it moved');
  } finally {
    rec.cleanupDir();
  }
});

test('stitchSystemParts: a stitch failure leaves the pre-restart audio in place', async () => {
  const rec = recordingRecorder();
  try {
    writeCapture(rec.systemFile, 5);
    const part2 = nodePath.join(rec.sessionDir, 'system.part2.wav');
    writeCapture(part2, 5);
    rec.systemParts = [
      { file: rec.systemFile, stoppedAt: 1000, bytes: 0 },
      { file: part2, stoppedAt: 9000, bytes: 0 }
    ];
    const before = nodeFs.statSync(rec.systemFile).size;

    // Force the swap to fail at the last step.
    rec._replaceSystemFileWith = () => { throw new Error('disk full'); };
    const result = await rec.stitchSystemParts();

    assert.strictEqual(result.stitched, false);
    assert.strictEqual(result.reason, 'disk full');
    assert.strictEqual(nodeFs.statSync(rec.systemFile).size, before,
      'part one survives as system.wav — the documented degradation');
  } finally {
    rec.cleanupDir();
  }
});

test('stitchSystemParts: joins two parts with a pad and reports the right length', async () => {
  // The happy path, through real sox. 4s of audio, a 3s gap while the capture
  // restarted, then 5s more — the finished track must be 12s, not 9s, or every
  // word after the gap is attributed three seconds early for the rest of the
  // meeting (see planStitch).
  const rec = recordingRecorder();
  try {
    const part2 = nodePath.join(rec.sessionDir, 'system.part2.wav');
    writeCapture(rec.systemFile, 4);
    writeCapture(part2, 5);
    rec.systemParts = [
      { file: rec.systemFile, stoppedAt: 100000, bytes: 0 },
      // stopped at 108000 holding 5s → audio began 103000 → a 3s gap.
      { file: part2, stoppedAt: 108000, bytes: 0 }
    ];

    const result = await rec.stitchSystemParts();
    assert.strictEqual(result.stitched, true);

    const seconds = (nodeFs.statSync(rec.systemFile).size - WAV_HEADER_BYTES) / 32000;
    assert.ok(Math.abs(seconds - 12) < 0.1, `expected ~12s, got ${seconds.toFixed(2)}s`);

    // Both parts survive as their own files.
    assert.ok(nodeFs.existsSync(nodePath.join(rec.sessionDir, 'system.part1.wav')));
    assert.ok(nodeFs.existsSync(part2));

    // And the working pad files are cleaned up.
    const leftovers = nodeFs.readdirSync(rec.sessionDir).filter((f) => f.includes('pad'));
    assert.deepStrictEqual(leftovers, [], 'pads are scratch, not artefacts');
  } finally {
    rec.cleanupDir();
  }
});


test('resolveFinalTrackStatus: a measured-silent track is never called complete', () => {
  // A restart resets the track to 'recording', erasing any earlier 'silent'
  // verdict — so the only thing that can be trusted at the end is the file.
  assert.strictEqual(
    resolveFinalTrackStatus('recording', 5_000_000, { measuredSilent: true }),
    'silent'
  );
});

test('resolveFinalTrackStatus: a measured-audible track completes normally', () => {
  assert.strictEqual(
    resolveFinalTrackStatus('recording', 5_000_000, { measuredSilent: false }),
    'complete'
  );
});

test('resolveFinalTrackStatus: a cause of death outranks restating the silence', () => {
  // 'failed' explains WHY it is silent, which is strictly more useful.
  assert.strictEqual(
    resolveFinalTrackStatus('failed', 5_000_000, { measuredSilent: true }),
    'failed'
  );
});

// ---------------------------------------------------------------------------
// Call audio at stop (T206, invariant #26) — the promise that a session with
// no call is left exactly as ScreenCaptureKit wrote it.
// ---------------------------------------------------------------------------

/** A recorder with real track files on disk, ready for `stop()`. */
function stoppableRecorder(callCapture) {
  const rec = recordingRecorder();
  writeCapture(rec.systemFile, 3);
  writeCapture(rec.micFile, 3);
  rec.micProcess = fakeProcess();
  rec.startTime = Date.now() - 3000;
  rec.manifest = { tracks: { system: { status: 'recording' }, mic: { status: 'recording' } }, slides: {} };
  rec.callCapture = callCapture;
  return rec;
}

/** A stand-in CallCaptureSession that reports the given segments. */
function fakeCallCapture(segments) {
  return {
    stopped: false,
    stop: async function () { this.stopped = true; return { status: 'stopped', reason: null, segments, events: [] }; },
    kill() {}
  };
}

test('stop without call audio leaves system.wav byte-identical and adds nothing', async () => {
  const rec = stoppableRecorder(null);
  try {
    const before = nodeFs.readFileSync(rec.systemFile);
    await rec.stop();
    assert.deepStrictEqual(nodeFs.readFileSync(rec.systemFile), before);
    assert.ok(!nodeFs.existsSync(nodePath.join(rec.sessionDir, 'system.sck.wav')));
    assert.strictEqual(rec.manifest.callAudio, undefined);
  } finally {
    rec.cleanupDir();
  }
});

test('stop with call audio on but no call (a Meet/Zoom session) leaves system.wav byte-identical', async () => {
  const call = fakeCallCapture([]);
  const rec = stoppableRecorder(call);
  try {
    const before = nodeFs.readFileSync(rec.systemFile);
    await rec.stop();
    assert.strictEqual(call.stopped, true);
    assert.deepStrictEqual(nodeFs.readFileSync(rec.systemFile), before);
    assert.ok(!nodeFs.existsSync(nodePath.join(rec.sessionDir, 'system.sck.wav')));
    assert.strictEqual(rec.manifest.callAudio.mixed, false);
    assert.deepStrictEqual(rec.manifest.callAudio.segments, [], 'recorded as "the tap never fired"');
  } finally {
    rec.cleanupDir();
  }
});

test('stop with a silent call segment does not touch system.wav', async () => {
  const rec = stoppableRecorder(fakeCallCapture([{
    file: 'call.1.wav', sampleRate: 16000, startEpochMs: Date.now() - 2000, endEpochMs: Date.now(),
    frames: 32000, peak: 0, endReason: 'call-ended'
  }]));
  try {
    const before = nodeFs.readFileSync(rec.systemFile);
    await rec.stop();
    assert.deepStrictEqual(nodeFs.readFileSync(rec.systemFile), before);
    assert.strictEqual(rec.manifest.callAudio.segments.length, 1, 'still recorded');
  } finally {
    rec.cleanupDir();
  }
});

test('stop with an audible call mixes it in and keeps the original', { skip: spawnSyncSox() }, async () => {
  const rec = stoppableRecorder(null);
  try {
    writeCapture(nodePath.join(rec.sessionDir, 'call.1.wav'), 1);
    rec.callCapture = fakeCallCapture([{
      file: 'call.1.wav', sampleRate: 16000, startEpochMs: Date.now() - 1500, endEpochMs: Date.now() - 500,
      frames: 16000, peak: 6000, endReason: 'call-ended'
    }]);
    const before = nodeFs.readFileSync(rec.systemFile);
    await rec.stop();
    assert.strictEqual(rec.manifest.callAudio.mixed, true, rec.manifest.callAudio.mixError);
    assert.deepStrictEqual(nodeFs.readFileSync(nodePath.join(rec.sessionDir, 'system.sck.wav')), before);
    assert.notDeepStrictEqual(nodeFs.readFileSync(rec.systemFile), before);
    assert.ok(nodeFs.existsSync(nodePath.join(rec.sessionDir, 'call.1.wav')), 'the raw segment is kept');
  } finally {
    rec.cleanupDir();
  }
});

/** Skip reason when sox is not installed, else false. */
function spawnSyncSox() {
  return require('child_process').spawnSync('sox', ['--version']).status === 0 ? false : 'sox not installed';
}
