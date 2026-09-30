'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const { ProcessRegistry } = require('./processRegistry');

/**
 * A stand-in child process.
 *
 * `diesOn` says which signal it actually honours — that is the whole point of
 * these tests. A process that ignores SIGTERM is the orphan case, and the only
 * way to exercise it deterministically is to fake one.
 */
function fakeProc({ diesOn = 'SIGTERM', throwsOn = null } = {}) {
  const listeners = {};
  const proc = {
    signals: [],
    exitCode: null,
    killed: false,
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    kill(signal) {
      proc.signals.push(signal);
      if (throwsOn && signal === throwsOn) throw new Error('ESRCH');
      if (diesOn === signal || diesOn === 'any') proc.exit(0);
    },
    exit(code = 0) {
      if (proc.exitCode !== null) return;
      proc.exitCode = code;
      proc.killed = true;
      for (const fn of listeners.exit || []) fn(code);
    }
  };
  return proc;
}

/** Timers that fire immediately, so grace periods do not cost real seconds. */
function fastRegistry(opts = {}) {
  let clock = 0;
  return new ProcessRegistry({
    setTimeout: (fn) => { clock += 50; fn(); },
    now: () => clock,
    ...opts
  });
}

/* ── registration ────────────────────────────────────────────── */

test('a registered process is tracked', () => {
  const r = fastRegistry();
  r.register(fakeProc());

  assert.strictEqual(r.size, 1);
});

test('a process that exits on its own drops out of the set', () => {
  // Otherwise a long session accumulates dead handles and shutdown signals
  // corpses.
  const r = fastRegistry();
  const p = r.register(fakeProc());

  p.exit(0);

  assert.strictEqual(r.size, 0);
});

test('register returns the process, so it can wrap a spawn call', () => {
  const r = fastRegistry();
  const p = fakeProc();

  assert.strictEqual(r.register(p), p);
});

test('registering null is a no-op rather than a crash', () => {
  const r = fastRegistry();
  assert.doesNotThrow(() => r.register(null));
  assert.strictEqual(r.size, 0);
});

test('forget drops a process without signalling it', () => {
  const r = fastRegistry();
  const p = r.register(fakeProc());

  r.forget(p);
  r.signalAll('SIGTERM');

  assert.deepStrictEqual(p.signals, [], 'a forgotten process must not be signalled');
});

/* ── signalling ──────────────────────────────────────────────── */

test('signalAll reaches every live process', () => {
  const r = fastRegistry();
  const a = r.register(fakeProc({ diesOn: null }));
  const b = r.register(fakeProc({ diesOn: null }));

  assert.strictEqual(r.signalAll('SIGTERM'), 2);
  assert.deepStrictEqual(a.signals, ['SIGTERM']);
  assert.deepStrictEqual(b.signals, ['SIGTERM']);
});

test('one process throwing does not stop the others being signalled', () => {
  // The usual cause is that it already exited; a dead handle must never
  // shield the rest of the set at quit time.
  const r = fastRegistry();
  const bad = r.register(fakeProc({ throwsOn: 'SIGTERM', diesOn: null }));
  const good = r.register(fakeProc({ diesOn: null }));

  const delivered = r.signalAll('SIGTERM');

  assert.strictEqual(delivered, 1, 'the throwing one is not counted');
  assert.deepStrictEqual(good.signals, ['SIGTERM'], 'the healthy one still got it');
  assert.deepStrictEqual(bad.signals, ['SIGTERM'], 'it was still attempted');
});

test('signalling while processes die mid-iteration is safe', () => {
  const r = fastRegistry();
  for (let i = 0; i < 5; i += 1) r.register(fakeProc({ diesOn: 'SIGTERM' }));

  assert.doesNotThrow(() => r.signalAll('SIGTERM'));
  assert.strictEqual(r.size, 0, 'all five removed themselves as they exited');
});

/* ── shutdown: the behaviour that matters ────────────────────── */

test('a well-behaved child gets SIGTERM and nothing more', async () => {
  // SIGTERM lets the SCK helper finalise its WAV header. Killing it outright
  // leaves a file every player reads as zero-length, so the grace period is
  // what makes the last recording playable.
  const r = fastRegistry();
  const p = r.register(fakeProc({ diesOn: 'SIGTERM' }));

  const result = await r.shutdown();

  assert.deepStrictEqual(p.signals, ['SIGTERM']);
  assert.strictEqual(result.killed, 0);
  assert.strictEqual(r.size, 0);
});

test('a child that ignores SIGTERM is escalated to SIGKILL', async () => {
  // This is the orphaned-sox case: one signal, no wait, no escalation meant a
  // stubborn child outlived the app and held the microphone (gotcha #4).
  const r = fastRegistry({ graceMs: 200 });
  const stubborn = r.register(fakeProc({ diesOn: 'SIGKILL' }));

  const result = await r.shutdown();

  assert.deepStrictEqual(stubborn.signals, ['SIGTERM', 'SIGKILL']);
  assert.strictEqual(result.killed, 1);
  assert.strictEqual(r.size, 0, 'nothing is left behind');
});

test('shutdown mixes the two cases correctly', async () => {
  const r = fastRegistry({ graceMs: 200 });
  const polite = r.register(fakeProc({ diesOn: 'SIGTERM' }));
  const stubborn = r.register(fakeProc({ diesOn: 'SIGKILL' }));

  const result = await r.shutdown();

  assert.deepStrictEqual(polite.signals, ['SIGTERM'], 'no needless SIGKILL');
  assert.deepStrictEqual(stubborn.signals, ['SIGTERM', 'SIGKILL']);
  assert.strictEqual(result.termed, 2);
  assert.strictEqual(result.killed, 1);
});

test('shutdown with nothing registered resolves immediately', async () => {
  const r = fastRegistry();
  const result = await r.shutdown();

  assert.deepStrictEqual(result, { termed: 0, killed: 0, waitedMs: 0 });
});

test('shutdown does not wait at all when everything dies on SIGTERM', async () => {
  const r = fastRegistry({ graceMs: 5000 });
  r.register(fakeProc({ diesOn: 'SIGTERM' }));

  const result = await r.shutdown();

  assert.strictEqual(result.waitedMs, 0, 'quitting must not stall on healthy children');
});

test('shutdown always resolves, even if kill throws on both signals', async () => {
  // A shutdown path that can hang is worse than one that kills a moment early.
  const r = fastRegistry({ graceMs: 100 });
  const p = r.register(fakeProc({ throwsOn: 'SIGTERM', diesOn: null }));
  p.kill = () => { throw new Error('ESRCH'); };

  const result = await r.shutdown();

  assert.ok(result, 'resolved rather than hanging');
  assert.strictEqual(r.size, 0);
});

test('hasExited reads exitCode and signalCode, and ignores `killed`', () => {
  assert.strictEqual(ProcessRegistry.hasExited(null), true);
  assert.strictEqual(ProcessRegistry.hasExited({ exitCode: 0, signalCode: null }), true);
  assert.strictEqual(ProcessRegistry.hasExited({ exitCode: null, signalCode: 'SIGKILL' }), true);
  assert.strictEqual(ProcessRegistry.hasExited({ exitCode: null, signalCode: null }), false);

  // The one that matters: Node sets `killed` when a signal is SENT, not when
  // the process dies. Trusting it made the SIGKILL escalation unreachable.
  assert.strictEqual(
    ProcessRegistry.hasExited({ killed: true, exitCode: null, signalCode: null }),
    false,
    'a child that ignored SIGTERM is still alive, whatever `killed` says'
  );
});

/* ── against real processes ──────────────────────────────────── */

test('a real child process is actually dead after shutdown', async () => {
  // The fakes prove the logic; this proves the logic is aimed at the right API.
  const r = new ProcessRegistry({ graceMs: 1500 });
  const child = r.register(spawn('sleep', ['30']));

  assert.strictEqual(r.size, 1);
  await r.shutdown();

  // Give the OS a moment to reap it, then confirm signalling it fails.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/, 'the process must be gone');
});

test('a real child that ignores SIGTERM is still killed', async () => {
  // `sh -c 'trap "" TERM; sleep 30'` is a process that genuinely refuses to
  // die politely — exactly the shape that used to survive a quit.
  const r = new ProcessRegistry({ graceMs: 300 });
  const child = r.register(spawn('sh', ['-c', 'trap "" TERM; sleep 30']));

  // Wait for the shell to actually install the trap. Signalling it sooner kills
  // it politely and the test passes while proving nothing.
  await new Promise((resolve) => child.once('spawn', resolve));
  await new Promise((resolve) => setTimeout(resolve, 250));

  const result = await r.shutdown();

  assert.strictEqual(result.killed, 1, 'it had to be escalated');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/, 'and it is gone');
});
