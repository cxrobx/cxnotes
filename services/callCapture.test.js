'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  CallCaptureSession,
  resolveCallBinaryPath,
  buildCallArgs,
  parseCallEvent,
  parseCallManifest,
  effectiveSampleRate,
  planCallMix,
  segmentPrepArgs,
  mixArgs,
  withSampleRate,
  mixCallAudio,
  SCK_ORIGINAL
} = require('./callCapture');
const { SILENCE_PEAK_THRESHOLD } = require('../utils/audioProcessing');

/** A stand-in for a spawned helper. */
function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.signals = [];
  proc.kill = (signal) => { proc.signals.push(signal); };
  return proc;
}

function segment(overrides = {}) {
  return {
    index: 1,
    file: 'call.1.wav',
    sampleRate: 24000,
    startEpochMs: 1_000_000,
    endEpochMs: 1_010_000,
    frames: 240000,
    peak: 9000,
    endReason: 'call-ended',
    ...overrides
  };
}

/* ── paths, args, events ─────────────────────────────────────── */

test('the packaged helper lives in Resources; a dev build in its .build dir', () => {
  assert.strictEqual(
    resolveCallBinaryPath({ isPackaged: true, resourcesPath: '/App/Contents/Resources', appDir: '/x' }),
    '/App/Contents/Resources/call-audio-tap'
  );
  assert.strictEqual(
    resolveCallBinaryPath({ isPackaged: false, appDir: '/repo' }),
    '/repo/native/call-audio-tap/.build/release/call-audio-tap'
  );
});

test('args are the session dir, plus a poll interval only when given', () => {
  assert.deepStrictEqual(buildCallArgs('/s'), ['/s']);
  assert.deepStrictEqual(buildCallArgs('/s', { pollMs: 100 }), ['/s', '--poll-ms', '100']);
});

test('only JSON lines with an event are events', () => {
  assert.deepStrictEqual(parseCallEvent('{"event":"ready","pollMs":250}'), { event: 'ready', pollMs: 250 });
  assert.strictEqual(parseCallEvent('[call-audio-tap] hello'), null);
  assert.strictEqual(parseCallEvent('{"no":"event"}'), null);
  assert.strictEqual(parseCallEvent('{broken'), null);
});

/* ── call.json ───────────────────────────────────────────────── */

test('call.json parses into segments and drops malformed entries', () => {
  const text = JSON.stringify({
    version: 1,
    segments: [
      segment(),
      { ...segment(), file: '../../etc/passwd' },
      { ...segment(), sampleRate: 0 },
      { ...segment(), startEpochMs: 'soon' },
      null
    ]
  });
  const parsed = parseCallManifest(text);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].file, 'call.1.wav');
});

test('a missing or broken call.json is no segments, never a throw', () => {
  assert.deepStrictEqual(parseCallManifest(''), []);
  assert.deepStrictEqual(parseCallManifest('{not json'), []);
  assert.deepStrictEqual(parseCallManifest('{"segments":"no"}'), []);
});

/* ── the gate: nothing to mix means nothing is touched ───────── */

test('no segments → empty plan (every Meet, Zoom and setting-off session)', () => {
  assert.deepStrictEqual(planCallMix({ segments: [], micAudioStartMs: 1 }), []);
  assert.deepStrictEqual(planCallMix({ segments: undefined, micAudioStartMs: 1 }), []);
});

test('a segment that heard only silence is not mixed', () => {
  const silent = segment({ peak: 0 });
  const lsb = segment({ peak: SILENCE_PEAK_THRESHOLD - 1 });
  const empty = segment({ frames: 0 });
  assert.deepStrictEqual(planCallMix({ segments: [silent, lsb, empty], micAudioStartMs: 999_000 }), []);
});

test('an unusable mic clock means no mix rather than a misplaced one', () => {
  assert.deepStrictEqual(planCallMix({ segments: [segment()], micAudioStartMs: NaN }), []);
});

test('mixCallAudio with an empty plan does not read, write or rename anything', async () => {
  const touched = [];
  const spyFs = new Proxy({}, { get: (_, name) => (...args) => { touched.push(name); return false; } });
  let soxCalls = 0;
  const result = await mixCallAudio({
    sessionDir: '/s', systemFile: '/s/system.wav', plan: [],
    runSox: async () => { soxCalls += 1; }, fsImpl: spyFs
  });
  assert.strictEqual(result.mixed, false);
  assert.strictEqual(soxCalls, 0);
  assert.deepStrictEqual(touched, []);
});

/* ── placement ───────────────────────────────────────────────── */

test('a segment is placed by its start relative to the mic’s first sample', () => {
  const [plan] = planCallMix({ segments: [segment({ startEpochMs: 1_012_345 })], micAudioStartMs: 1_000_000 });
  assert.strictEqual(plan.offsetMs, 12_345);
  assert.strictEqual(plan.trimHeadMs, 0);
  assert.strictEqual(plan.file, 'call.1.wav');
});

test('a call already running at record start is trimmed, not shifted', () => {
  const [plan] = planCallMix({ segments: [segment({ startEpochMs: 998_000 })], micAudioStartMs: 1_000_000 });
  assert.strictEqual(plan.offsetMs, 0);
  assert.strictEqual(plan.trimHeadMs, 2000);
});

test('several segments each keep their own place', () => {
  const plans = planCallMix({
    segments: [
      segment({ file: 'call.1.wav', startEpochMs: 1_005_000 }),
      segment({ file: 'call.2.wav', startEpochMs: 1_060_000, peak: 0 }),
      segment({ file: 'call.3.wav', startEpochMs: 1_120_000 })
    ],
    micAudioStartMs: 1_000_000
  });
  assert.deepStrictEqual(plans.map((p) => [p.file, p.offsetMs]), [['call.1.wav', 5000], ['call.3.wav', 120_000]]);
});

/* ── rate ────────────────────────────────────────────────────── */

test('a header rate that matches the delivery rate is trusted', () => {
  assert.strictEqual(effectiveSampleRate(segment({ sampleRate: 48000, frames: 480_000 })), 48000);
});

test('AirPods dropping to 24 kHz under a 48 kHz header is corrected', () => {
  // 10 s of wall clock, 240k frames → 24 kHz delivered, header still says 48.
  assert.strictEqual(effectiveSampleRate(segment({ sampleRate: 48000, frames: 240_000 })), 24000);
});

test('too short to measure → the header rate stands', () => {
  assert.strictEqual(
    effectiveSampleRate(segment({ sampleRate: 48000, frames: 12_000, endEpochMs: 1_000_500 })),
    48000
  );
});

test('withSampleRate rewrites both rate fields in a copy', () => {
  const header = Buffer.alloc(44);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  const fixed = withSampleRate(header, 24000);
  assert.strictEqual(fixed.readUInt32LE(24), 24000);
  assert.strictEqual(fixed.readUInt32LE(28), 48000);
  assert.strictEqual(header.readUInt32LE(24), 48000, 'the original buffer is untouched');
});

/* ── sox arguments ───────────────────────────────────────────── */

test('prep resamples to 16 kHz mono, trims the head, then pads to its place', () => {
  assert.deepStrictEqual(
    segmentPrepArgs('in.wav', 'out.wav', { offsetMs: 12_345, trimHeadMs: 0 }),
    ['-D', 'in.wav', '-r', '16000', '-b', '16', '-c', '1', 'out.wav', 'trim', '0.000', 'pad', '12.345']
  );
});

test('the mix keeps every input at unity gain', () => {
  // sox -m otherwise scales each input by 1/n and halves the system track.
  assert.deepStrictEqual(
    mixArgs('system.wav', ['a.wav', 'b.wav'], 'out.wav'),
    ['-D', '-m', '-v', '1', 'system.wav', '-v', '1', 'a.wav', '-v', '1', 'b.wav', 'out.wav']
  );
});

/* ── mixing on disk ──────────────────────────────────────────── */

function tmpSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-call-'));
  fs.writeFileSync(path.join(dir, 'system.wav'), 'SCK');
  fs.writeFileSync(path.join(dir, 'call.1.wav'), Buffer.alloc(44));
  return dir;
}

test('a successful mix steps the original aside and keeps the segment', async () => {
  const dir = tmpSession();
  const result = await mixCallAudio({
    sessionDir: dir, systemFile: path.join(dir, 'system.wav'),
    plan: [{ file: 'call.1.wav', offsetMs: 0, trimHeadMs: 0, sampleRate: 24000, headerRate: 24000 }],
    runSox: async (args) => { fs.writeFileSync(lastPath(args), 'OUT'); }
  });
  assert.strictEqual(result.mixed, true, result.reason);
  assert.strictEqual(fs.readFileSync(path.join(dir, SCK_ORIGINAL), 'utf-8'), 'SCK');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'system.wav'), 'utf-8'), 'OUT');
  assert.ok(fs.existsSync(path.join(dir, 'call.1.wav')), 'the raw call segment is never deleted');
  assert.deepStrictEqual(
    fs.readdirSync(dir).sort(),
    ['call.1.wav', 'system.sck.wav', 'system.wav'],
    'scratch files are cleaned up'
  );
});

/** The output path of a prep call is args[8]; of a mix call, the last arg. */
function lastPath(args) {
  return args[1] === '-m' ? args[args.length - 1] : args[8];
}

test('a failed sox leaves system.wav exactly as it was', async () => {
  const dir = tmpSession();
  const result = await mixCallAudio({
    sessionDir: dir, systemFile: path.join(dir, 'system.wav'),
    plan: [{ file: 'call.1.wav', offsetMs: 0, trimHeadMs: 0, sampleRate: 24000, headerRate: 24000 }],
    runSox: async () => { throw new Error('sox exploded'); }
  });
  assert.strictEqual(result.mixed, false);
  assert.match(result.reason, /sox exploded/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'system.wav'), 'utf-8'), 'SCK');
  assert.ok(!fs.existsSync(path.join(dir, SCK_ORIGINAL)));
});

test('a failed final rename puts the original back', async () => {
  const dir = tmpSession();
  const realRename = fs.renameSync;
  let renames = 0;
  const flakyFs = {
    ...fs,
    renameSync: (from, to) => {
      renames += 1;
      if (renames === 2) throw new Error('disk full');
      return realRename(from, to);
    }
  };
  const result = await mixCallAudio({
    sessionDir: dir, systemFile: path.join(dir, 'system.wav'),
    plan: [{ file: 'call.1.wav', offsetMs: 0, trimHeadMs: 0, sampleRate: 24000, headerRate: 24000 }],
    runSox: async (args) => { fs.writeFileSync(lastPath(args), 'OUT'); },
    fsImpl: flakyFs
  });
  assert.strictEqual(result.mixed, false);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'system.wav'), 'utf-8'), 'SCK');
});

test('a corrected rate is applied to a copy, never the raw segment', async () => {
  const dir = tmpSession();
  const raw = Buffer.alloc(44);
  raw.writeUInt32LE(48000, 24);
  fs.writeFileSync(path.join(dir, 'call.1.wav'), raw);
  let prepInput = null;
  await mixCallAudio({
    sessionDir: dir, systemFile: path.join(dir, 'system.wav'),
    plan: [{ file: 'call.1.wav', offsetMs: 0, trimHeadMs: 0, sampleRate: 24000, headerRate: 48000 }],
    runSox: async (args) => {
      if (args[1] !== '-m') prepInput = fs.readFileSync(args[1]).readUInt32LE(24);
      fs.writeFileSync(lastPath(args), 'OUT');
    }
  });
  assert.strictEqual(prepInput, 24000);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'call.1.wav')).readUInt32LE(24), 48000);
});

/* ── real sox, end to end ────────────────────────────────────── */

const soxAvailable = spawnSync('sox', ['--version']).status === 0;

test('real sox: the call lands at its offset and every other sample is untouched', { skip: !soxAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-call-sox-'));
  const systemFile = path.join(dir, 'system.wav');
  // A system track with real content (a quiet 300 Hz tone), so "untouched" is
  // a claim about audio and not just about silence.
  spawnSync('sox', ['-n', '-r', '16000', '-b', '16', '-c', '1', systemFile, 'synth', '4', 'sine', '300', 'vol', '0.1']);
  spawnSync('sox', ['-n', '-r', '24000', '-b', '16', '-c', '1', path.join(dir, 'call.1.wav'), 'synth', '1', 'sine', '440', 'vol', '0.5']);
  const before = readSamples(systemFile);

  const runSox = async (args) => {
    const r = spawnSync('sox', args, { encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const result = await mixCallAudio({
    sessionDir: dir, systemFile,
    plan: [{ file: 'call.1.wav', offsetMs: 2000, trimHeadMs: 0, sampleRate: 24000, headerRate: 24000 }],
    runSox
  });
  assert.strictEqual(result.mixed, true, result.reason);

  const after = readSamples(systemFile);
  assert.strictEqual(after.length, before.length);
  const differing = [];
  for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) differing.push(i / 16000);
  assert.ok(differing.length > 15000, 'the call is in the track');
  // A few ms of resampler ringing at the call's leading edge is physics.
  assert.ok(differing[0] >= 1.99, `nothing changed before the call (first at ${differing[0]}s)`);
  assert.ok(differing[differing.length - 1] < 3.0, 'nothing changed after it');
  assert.deepStrictEqual(readSamples(path.join(dir, SCK_ORIGINAL)), before, 'the original is kept verbatim');
});

/** Int16 samples of a 44-byte-header WAV. */
function readSamples(file) {
  const buf = fs.readFileSync(file);
  const out = [];
  for (let i = 44; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

/* ── the session ─────────────────────────────────────────────── */

function sessionWith(overrides = {}) {
  const proc = fakeProcess();
  const registered = [];
  const session = new CallCaptureSession('/fake/call-audio-tap', {
    spawn: () => proc,
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ version: 1, segments: [segment()] }),
    onSpawn: (p) => registered.push(p),
    ...overrides
  });
  return { session, proc, registered };
}

test('a missing helper reports unavailable and never spawns', () => {
  let spawned = false;
  const session = new CallCaptureSession('/nope', { existsSync: () => false, spawn: () => { spawned = true; } });
  const result = session.start('/s');
  assert.strictEqual(result.started, false);
  assert.strictEqual(result.status, 'unavailable');
  assert.strictEqual(spawned, false);
});

test('a spawn that throws is reported, not thrown', () => {
  const session = new CallCaptureSession('/x', { existsSync: () => true, spawn: () => { throw new Error('EACCES'); } });
  const result = session.start('/s');
  assert.strictEqual(result.started, false);
  assert.match(result.reason, /EACCES/);
});

test('the helper is registered for the quit drain', () => {
  const { session, proc, registered } = sessionWith();
  session.start('/s');
  assert.deepStrictEqual(registered, [proc]);
});

test('events move the status; silent-tap warns once per event', () => {
  const warnings = [];
  const { session, proc } = sessionWith();
  session.start('/s', (w) => warnings.push(w));
  proc.stdout.emit('data', '{"event":"ready"}\n');
  assert.strictEqual(session.status, 'watching');
  proc.stdout.emit('data', '{"event":"segment-start","index":1}\n{"event":"silent-');
  assert.strictEqual(session.status, 'capturing');
  proc.stdout.emit('data', 'tap","index":1}\n');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /System Audio Recording/);
  proc.stdout.emit('data', '{"event":"segment-end","index":1}\n');
  assert.strictEqual(session.status, 'watching');
});

test('stop sends SIGTERM and resolves with the segments from call.json', async () => {
  const { session, proc } = sessionWith();
  session.start('/s');
  const stopping = session.stop();
  assert.deepStrictEqual(proc.signals, ['SIGTERM']);
  proc.emit('exit', 0);
  const summary = await stopping;
  assert.strictEqual(summary.status, 'stopped');
  assert.strictEqual(summary.segments.length, 1);
});

test('a helper that ignores SIGTERM is killed, and stop still resolves', async () => {
  let fire = null;
  const { session, proc } = sessionWith({ setTimeout: (fn) => { fire = fn; return 1; }, clearTimeout: () => {} });
  session.start('/s');
  const stopping = session.stop();
  fire();
  const summary = await stopping;
  assert.deepStrictEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Array.isArray(summary.segments));
});

test('stop with nothing running resolves immediately', async () => {
  const session = new CallCaptureSession('/x', { existsSync: () => false });
  session.start('/s');
  const summary = await session.stop();
  assert.strictEqual(summary.status, 'unavailable');
});

test('a session restarted for a new recording forgets the last one', () => {
  const { session, proc } = sessionWith();
  session.start('/a');
  proc.stdout.emit('data', '{"event":"ready"}\n');
  session.start('/b');
  assert.strictEqual(session.sessionDir, '/b');
  assert.deepStrictEqual(session.events, []);
});
