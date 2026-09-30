'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const path = require('path');

const {
  SlideCaptureSession,
  resolveSlideBinaryPath,
  buildSlideArgs,
  parseSlideEvent,
  parseSlidesCsv,
  resolveAudioSourceBundle,
  EXIT_UNRESOLVED
} = require('./slideCapture');

/** A stand-in for a spawned helper. */
function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = null;
  proc.kill = (signal) => { proc.killed = signal; };
  return proc;
}

function sessionWith(overrides = {}) {
  const proc = fakeProcess();
  const session = new SlideCaptureSession('/fake/sck-slide-capture', {
    spawn: () => proc,
    existsSync: () => true,
    readFileSync: () => 'offset_ms,file,width,height,mode,source\n',
    ...overrides
  });
  return { session, proc };
}

/* ── path and argument construction ──────────────────────────── */

test('resolveSlideBinaryPath points at Resources when packaged', () => {
  assert.strictEqual(
    resolveSlideBinaryPath({ isPackaged: true, resourcesPath: '/A/Contents/Resources', appDir: '/src' }),
    '/A/Contents/Resources/sck-slide-capture'
  );
});

test('resolveSlideBinaryPath points at the build directory in development', () => {
  assert.strictEqual(
    resolveSlideBinaryPath({ isPackaged: false, appDir: '/src' }),
    path.join('/src', 'native', 'sck-slide-capture', '.build', 'release', 'sck-slide-capture')
  );
});

test('buildSlideArgs passes only the options it was given', () => {
  assert.deepStrictEqual(buildSlideArgs('/s/slides'), ['/s/slides']);
  assert.deepStrictEqual(
    buildSlideArgs('/s/slides', { sourceBundle: 'us.zoom.xos', startEpochMs: 1700, stabilityMs: 2000 }),
    ['/s/slides', '--source-bundle', 'us.zoom.xos', '--start-epoch-ms', '1700', '--stability-ms', '2000']
  );
});

/* ── event and CSV parsing ───────────────────────────────────── */

test('parseSlideEvent accepts an event line and rejects everything else', () => {
  assert.deepStrictEqual(
    parseSlideEvent('{"event":"resolved","mode":"meeting-window"}'),
    { event: 'resolved', mode: 'meeting-window' }
  );
  assert.strictEqual(parseSlideEvent('STATUS: capturing'), null);
  assert.strictEqual(parseSlideEvent('{"nope":1}'), null, 'JSON without an event field is not an event');
  assert.strictEqual(parseSlideEvent('{broken'), null);
  assert.strictEqual(parseSlideEvent(''), null);
});

test('parseSlidesCsv reads rows and skips the header', () => {
  const rows = parseSlidesCsv([
    'offset_ms,file,width,height,mode,source',
    '683,slide-000-00000683.jpg,586,476,meeting-window,"Zoom Meeting"',
    '9210,slide-001-00009210.jpg,1440,900,shared-window,"Keynote"'
  ].join('\n'));
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], {
    offsetMs: 683, file: 'slide-000-00000683.jpg', width: 586, height: 476,
    mode: 'meeting-window', source: 'Zoom Meeting'
  });
  assert.strictEqual(rows[1].mode, 'shared-window');
});

test('parseSlidesCsv survives a truncated final line', () => {
  const rows = parseSlidesCsv('offset_ms,file,width,height,mode,source\n683,a.jpg,1,1,m,"s"\n12,par');
  assert.strictEqual(rows.length, 1);
});

/* ── audio source resolution ─────────────────────────────────── */

test('resolveAudioSourceBundle prefers a native meeting app', () => {
  assert.strictEqual(resolveAudioSourceBundle({ detected: 'zoom' }).sourceBundle, 'us.zoom.xos');
  assert.strictEqual(resolveAudioSourceBundle({ detected: 'facetime' }).sourceBundle, 'com.apple.FaceTime');
});

test('resolveAudioSourceBundle falls back to the browser holding audio', () => {
  const assertions = [
    'pid 411(Music): [0x01] Active PreventUserIdleSystemSleep',
    'pid 902(zen): [0x0f] Active PreventUserIdleSystemSleep named: "audio-capture"'
  ].join('\n');
  assert.strictEqual(resolveAudioSourceBundle({ assertions }).sourceBundle, 'app.zen-browser.zen');
});

test('resolveAudioSourceBundle ignores a browser with no audio assertion', () => {
  const assertions = 'pid 902(Google Chrome Helper): [0x0f] Active PreventUserIdleDisplaySleep';
  assert.strictEqual(resolveAudioSourceBundle({ assertions }).sourceBundle, null);
});

test('resolveAudioSourceBundle returns null rather than guessing', () => {
  const result = resolveAudioSourceBundle({});
  assert.strictEqual(result.sourceBundle, null);
  assert.match(result.why, /no audio source/);
});

/* ── session lifecycle ───────────────────────────────────────── */

test('a missing helper reports unavailable instead of throwing', () => {
  const session = new SlideCaptureSession('/nope/sck-slide-capture', { existsSync: () => false });
  const result = session.start('/session');
  assert.strictEqual(result.started, false);
  assert.strictEqual(result.status, 'unavailable');
  assert.match(result.reason, /build:native/);
});

test('a null binary path reports unavailable instead of throwing', () => {
  const session = new SlideCaptureSession(null, { existsSync: () => true });
  assert.strictEqual(session.start('/session').status, 'unavailable');
});

test('a spawn failure warns and never throws', () => {
  const warnings = [];
  const session = new SlideCaptureSession('/fake/bin', {
    existsSync: () => true,
    spawn: () => { throw new Error('EACCES'); }
  });
  const result = session.start('/session', {}, (msg) => warnings.push(msg));
  assert.strictEqual(result.started, false);
  assert.strictEqual(result.status, 'error');
  assert.strictEqual(warnings.length, 1);
});

test('events move the status from waiting to capturing', () => {
  const { session, proc } = sessionWith();
  assert.strictEqual(session.start('/session').status, 'waiting');

  proc.stdout.emit('data', '{"event":"unresolved","detail":"no meeting window"}\n');
  assert.strictEqual(session.status, 'waiting');
  assert.match(session.reason, /no meeting window/);

  proc.stdout.emit('data', '{"event":"resolved","mode":"meeting-window","detail":"Zoom"}\n');
  assert.strictEqual(session.status, 'capturing');
  assert.strictEqual(session.reason, null);
});

test('a lost source returns to waiting rather than erroring', () => {
  const { session, proc } = sessionWith();
  session.start('/session');
  proc.stdout.emit('data', '{"event":"resolved","mode":"meeting-window"}\n');
  proc.stdout.emit('data', '{"event":"source-lost","detail":"window navigated away"}\n');
  assert.strictEqual(session.status, 'waiting');
  assert.match(session.reason, /navigated away/);
});

test('events split across chunks are still parsed', () => {
  const { session, proc } = sessionWith();
  session.start('/session');
  proc.stdout.emit('data', '{"event":"res');
  proc.stdout.emit('data', 'olved","mode":"meeting-window"}\n');
  assert.strictEqual(session.status, 'capturing');
});

test('exit code 3 is recorded as a deliberate non-capture, not a failure', () => {
  const { session, proc } = sessionWith();
  session.start('/session');
  proc.emit('exit', EXIT_UNRESOLVED);
  assert.strictEqual(session.status, 'unresolved');
});

test('an unexpected exit code is recorded as an error', () => {
  const { session, proc } = sessionWith();
  session.start('/session');
  proc.emit('exit', 1);
  assert.strictEqual(session.status, 'error');
});

test('stop signals the helper and reports what landed on disk', () => {
  const csv = [
    'offset_ms,file,width,height,mode,source',
    '683,slide-000.jpg,1440,900,meeting-window,"Zoom Meeting"',
    '40210,slide-001.jpg,1440,900,shared-window,"Keynote"'
  ].join('\n');
  const { session, proc } = sessionWith({ readFileSync: () => csv });
  session.start('/session');
  proc.stdout.emit('data', '{"event":"resolved","mode":"meeting-window"}\n');

  const summary = session.stop();
  assert.strictEqual(proc.killed, 'SIGTERM');
  assert.strictEqual(summary.keyframes, 2);
  assert.strictEqual(summary.slides[1].mode, 'shared-window');
  assert.strictEqual(summary.directory, path.join('/session', 'slides'));
  assert.strictEqual(summary.events.length, 1);
});

test('stop is safe when nothing ever started', () => {
  const session = new SlideCaptureSession(null, { existsSync: () => false });
  const summary = session.stop();
  assert.strictEqual(summary.keyframes, 0);
  assert.strictEqual(summary.directory, null);
});

test('an unreadable slides.csv reports zero keyframes rather than throwing', () => {
  const { session } = sessionWith({
    readFileSync: () => { throw new Error('EIO'); }
  });
  session.start('/session');
  assert.strictEqual(session.summary().keyframes, 0);
});
