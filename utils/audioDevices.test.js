'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  listInputDevices
} = require('./audioDevices');

// Realistic system_profiler SPAudioDataType output: device names at 8-space
// indent, properties at 10-space indent (gotcha #1 — do not reformat).
const PROFILER_OUTPUT = [
  'Audio:',
  '',
  '    Devices:',
  '',
  '        MacBook Pro Microphone:',
  '',
  '          Default Input Device: Yes',
  '          Input Channels: 1',
  '          Manufacturer: Apple Inc.',
  '          Current SampleRate: 48000',
  '          Transport: Built-in',
  '',
  '        BlackHole 2ch:',
  '',
  '          Input Channels: 2',
  '          Manufacturer: Existential Audio Inc.',
  '          Current SampleRate: 48000',
  '          Transport: Virtual',
  '',
  '        MacBook Pro Speakers:',
  '',
  '          Default Output Device: Yes',
  '          Output Channels: 2',
  '',
].join('\n');

function makeExec(outputs) {
  let call = 0;
  const exec = () => {
    const result = outputs[Math.min(call, outputs.length - 1)];
    call += 1;
    if (result instanceof Error) throw result;
    return result;
  };
  exec.calls = () => call;
  return exec;
}

test('parses devices with input channels on the first attempt, no retry', () => {
  const exec = makeExec([PROFILER_OUTPUT]);
  let slept = 0;
  const devices = listInputDevices({ _exec: exec, _sleep: () => { slept += 1; } });

  assert.equal(exec.calls(), 1);
  assert.equal(slept, 0);
  assert.deepEqual(devices.map((d) => d.name), ['MacBook Pro Microphone', 'BlackHole 2ch']);
  assert.equal(devices[0].isDefault, true);
  assert.equal(devices[1].transport, 'Virtual');
});

test('retries once after a transient empty enumeration and returns the second result', () => {
  const exec = makeExec(['Audio:\n\n    Devices:\n', PROFILER_OUTPUT]);
  let slept = 0;
  const devices = listInputDevices({ _exec: exec, _sleep: () => { slept += 1; } });

  assert.equal(exec.calls(), 2);
  assert.equal(slept, 1);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].name, 'MacBook Pro Microphone');
});

test('retries when system_profiler throws, then recovers', () => {
  const exec = makeExec([new Error('spawn failed'), PROFILER_OUTPUT]);
  const devices = listInputDevices({ _exec: exec, _sleep: () => {} });

  assert.equal(exec.calls(), 2);
  assert.equal(devices.length, 2);
});

test('returns empty after both attempts find nothing (no infinite retry)', () => {
  const exec = makeExec(['Audio:\n\n    Devices:\n']);
  let slept = 0;
  const devices = listInputDevices({ _exec: exec, _sleep: () => { slept += 1; } });

  assert.equal(exec.calls(), 2);
  assert.equal(slept, 1);
  assert.deepEqual(devices, []);
});

test('honours the injected retry delay', () => {
  const exec = makeExec(['', PROFILER_OUTPUT]);
  const delays = [];
  listInputDevices({ retryDelayMs: 50, _exec: exec, _sleep: (ms) => delays.push(ms) });

  assert.deepEqual(delays, [50]);
});

/* ── the BlackHole fallback, deliberately absent ─────────────── */

test('findBlackHoleDevice is gone — SCK is the only system-audio route', () => {
  // Removed with the sox+BlackHole fallback. Asserted rather than merely
  // deleted: a re-added detector is the first step back toward a capture path
  // that reports itself ready and then records silence. See
  // resolveSystemCaptureMethod() in services/recorder.js.
  const audioDevices = require('./audioDevices');
  assert.strictEqual(audioDevices.findBlackHoleDevice, undefined);
  assert.strictEqual(audioDevices.BLACKHOLE_SOX_DEVICE, undefined);
});
