'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Module = require('node:module');

const REPO_ROOT = path.resolve(__dirname);
const PRELOAD = path.join(REPO_ROOT, 'preload.js');

/**
 * Load the real preload with `electron` stubbed.
 *
 * Loading the actual file, rather than a pure module beside it, is deliberate:
 * the preload runs sandboxed in the app, where it may only require 'electron'
 * and Node built-ins. Testing a sibling module instead is what let a split-out
 * version pass every test while the real bridge failed to load at all.
 */
function loadPreload() {
  const stub = {
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { invoke: () => Promise.resolve(), on: () => {}, removeListener: () => {} }
  };
  const original = Module._load;
  Module._load = (request, parent, isMain) =>
    request === 'electron' ? stub : original.call(Module, request, parent, isMain);
  try {
    delete require.cache[PRELOAD];
    return require(PRELOAD);
  } finally {
    Module._load = original;
  }
}

const { BRIDGE_KEY, REQUEST_CHANNELS, EVENT_CHANNELS, buildRendererApi } = loadPreload();
const MAIN_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'main.js'), 'utf8');

/**
 * A recording stand-in for Electron's `ipcRenderer`. The real one cannot be
 * loaded outside Electron, which is the reason this surface went untested for
 * as long as it did.
 */
function fakeIpc() {
  const invoked = [];
  const subscribed = [];
  const removed = [];
  return {
    invoked,
    subscribed,
    removed,
    invoke(...args) {
      invoked.push(args);
      return Promise.resolve('RESULT');
    },
    on(channel, handler) {
      subscribed.push({ channel, handler });
    },
    removeListener(channel, handler) {
      removed.push({ channel, handler });
    }
  };
}

/* ── the surface itself ──────────────────────────────────────── */

test('the bridge is exposed under the single global the renderer reads', () => {
  assert.strictEqual(BRIDGE_KEY, 'meetingRecorder');
});

test('every exposed name is a function and nothing else leaks through', () => {
  const api = buildRendererApi(fakeIpc());
  for (const [name, value] of Object.entries(api)) {
    assert.strictEqual(typeof value, 'function', `${name} should be a function`);
  }
  const expected =
    Object.keys(REQUEST_CHANNELS).length + Object.keys(EVENT_CHANNELS).length + 1;
  assert.strictEqual(Object.keys(api).length, expected, 'no extra keys on the bridge');
});

test('the exposed names are exactly the ones the renderer expects', () => {
  // Frozen on purpose: this list is the renderer-facing contract, so adding or
  // renaming anything here should be a deliberate edit to this test, not a
  // silent consequence of editing the table.
  const EXPECTED = [
    'checkDependencies', 'chooseOutputDirectory', 'chooseVaultDirectory',
    'cleanupOldRecordings', 'confirmAction', 'deleteRecording',
    'detectVaultDirectory', 'generateNotes', 'getCalendarPermissionState',
    'getProcessingStatus', 'getRecordingStatus', 'getSettings',
    'getStorageStats', 'getVersion', 'listInputDevices', 'listRecordings',
    'onCompanionModeStatus', 'onError', 'onNotification', 'onProcessingComplete',
    'onProcessingProgress', 'onRecordingLevels', 'onRecordingUpdate',
    'onRecordingsChanged', 'openCalendarPrivacySettings', 'openFile',
    'openOutputDirectory', 'previewGlass', 'processRecording', 'removeListener',
    'reprocessSession', 'requestCalendarPermission',
    'requestScreenCapturePermission', 'resetSettings', 'resummariseSession',
    'runPreflight', 'startRecording', 'stopRecording', 'transcribeRecording',
    'updateSettings'
  ];
  const actual = Object.keys(buildRendererApi(fakeIpc())).sort();
  assert.deepStrictEqual(actual, EXPECTED);
});

test('everything renderer/app.js calls is actually on the bridge', () => {
  const rendererSource = fs.readFileSync(
    path.join(REPO_ROOT, 'renderer', 'app.js'),
    'utf8'
  );
  const api = buildRendererApi(fakeIpc());
  const used = new Set(
    [...rendererSource.matchAll(/\bapi\.([A-Za-z][A-Za-z0-9]*)\b/g)].map((m) => m[1])
  );
  assert.ok(used.size > 20, 'sanity: the renderer should use a lot of the bridge');
  for (const name of used) {
    assert.ok(name in api, `renderer/app.js calls api.${name}, which the bridge lacks`);
  }
});

/* ── request channels ────────────────────────────────────────── */

test('each request goes to its own channel and returns the promise', async () => {
  const ipc = fakeIpc();
  const api = buildRendererApi(ipc);

  const result = await api.getSettings();
  assert.strictEqual(result, 'RESULT', 'the invoke promise is passed straight back');
  assert.deepStrictEqual(ipc.invoked, [['settings:get']]);
});

test('a no-payload request sends the channel alone, not a stray undefined', () => {
  const ipc = fakeIpc();
  const api = buildRendererApi(ipc);

  // Called with an argument anyway — the arity in the table is what decides,
  // so a caller passing something extra cannot smuggle it across the bridge.
  api.startRecording('IGNORED');

  assert.deepStrictEqual(ipc.invoked, [['recording:start']]);
  assert.strictEqual(ipc.invoked[0].length, 1);
});

test('a payload request forwards exactly one argument', () => {
  const ipc = fakeIpc();
  const api = buildRendererApi(ipc);

  api.deleteRecording('meeting.wav', 'EXTRA');

  assert.deepStrictEqual(ipc.invoked, [['files:delete', 'meeting.wav']]);
});

test('every request name maps to the channel it has always mapped to', () => {
  // The full request map, captured from the behaviour of the previous
  // implementation. Any drift here is a renderer/main contract break.
  const EXPECTED = {
    startRecording: 'recording:start',
    stopRecording: 'recording:stop',
    getRecordingStatus: 'recording:status',
    listRecordings: 'files:list',
    getStorageStats: 'files:stats',
    deleteRecording: 'files:delete',
    cleanupOldRecordings: 'files:cleanup',
    openFile: 'files:open',
    transcribeRecording: 'process:transcribe',
    generateNotes: 'process:summarise',
    processRecording: 'process:full',
    reprocessSession: 'session:reprocess',
    resummariseSession: 'session:resummarise',
    getProcessingStatus: 'processing:status',
    listInputDevices: 'audio:listInputDevices',
    runPreflight: 'audio:preflight',
    getSettings: 'settings:get',
    updateSettings: 'settings:update',
    previewGlass: 'glass:preview',
    resetSettings: 'settings:reset',
    getCalendarPermissionState: 'calendar:getPermissionState',
    requestCalendarPermission: 'calendar:requestPermission',
    openCalendarPrivacySettings: 'calendar:openPrivacySettings',
    checkDependencies: 'system:dependencies',
    getVersion: 'system:version',
    openOutputDirectory: 'system:openOutputDir',
    chooseOutputDirectory: 'system:chooseOutputDir',
    chooseVaultDirectory: 'system:chooseVaultDir',
    detectVaultDirectory: 'system:detectVaultDir',
    requestScreenCapturePermission: 'system:requestScreenCapturePermission',
    confirmAction: 'dialog:confirm'
  };

  const ipc = fakeIpc();
  const api = buildRendererApi(ipc);
  const actual = {};
  for (const name of Object.keys(REQUEST_CHANNELS)) {
    ipc.invoked.length = 0;
    api[name]('PAYLOAD');
    actual[name] = ipc.invoked[0][0];
  }
  assert.deepStrictEqual(actual, EXPECTED);
});

test('which requests carry a payload has not drifted', () => {
  const WITH_PAYLOAD = [
    'confirmAction', 'deleteRecording', 'generateNotes', 'openFile',
    'previewGlass', 'processRecording', 'reprocessSession',
    'resummariseSession', 'transcribeRecording', 'updateSettings'
  ];
  const actual = Object.entries(REQUEST_CHANNELS)
    .filter(([, spec]) => spec.length > 1)
    .map(([name]) => name)
    .sort();
  assert.deepStrictEqual(actual, WITH_PAYLOAD);
});

test('every request channel has a handler registered in main.js', () => {
  // The half of the contract that lives in another file. Without this a typo in
  // a channel string is only discovered by clicking the button that uses it.
  const handled = new Set(
    [...MAIN_SOURCE.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1])
  );
  assert.ok(handled.size > 40, 'sanity: main.js should register many handlers');

  const missing = Object.values(REQUEST_CHANNELS)
    .map(([channel]) => channel)
    .filter((channel) => !handled.has(channel));
  assert.deepStrictEqual(missing, [], 'requests with no ipcMain.handle in main.js');
});

/* ── event channels ──────────────────────────────────────────── */

test('subscribing registers one listener on the matching channel', () => {
  const ipc = fakeIpc();
  const api = buildRendererApi(ipc);

  api.onRecordingUpdate(() => {});

  assert.strictEqual(ipc.subscribed.length, 1);
  assert.strictEqual(ipc.subscribed[0].channel, 'recording:update');
});

test('a subscriber receives the payload alone, never the Electron event', () => {
  const ipc = fakeIpc();
  const api = buildRendererApi(ipc);

  const seen = [];
  api.onProcessingComplete((...args) => seen.push(args));

  // Electron calls the listener as (event, data); the renderer must not be
  // handed `sender` — that is a route back out of the sandbox.
  ipc.subscribed[0].handler({ sender: 'WEBCONTENTS' }, { session: 'abc' });

  assert.deepStrictEqual(seen, [[{ session: 'abc' }]]);
  assert.strictEqual(seen[0].length, 1);
});

test('every event name maps to the channel it has always mapped to', () => {
  assert.deepStrictEqual({ ...EVENT_CHANNELS }, {
    onRecordingUpdate: 'recording:update',
    onRecordingLevels: 'recording:levels',
    onProcessingProgress: 'processing:progress',
    onProcessingComplete: 'processing:complete',
    onError: 'error',
    onNotification: 'notification',
    onRecordingsChanged: 'recordings:changed',
    onCompanionModeStatus: 'companion-mode-status'
  });
});

test('every event main actually sends still has a subscriber channel', () => {
  // `error` and `notification` are exposed but unsent today (see the note in
  // preloadApi.js). Listing them here rather than asserting all-must-be-sent
  // keeps this test honest: a *live* channel losing its sender is caught, and
  // wiring one of these two up later needs no change to the test.
  const NEVER_SENT = new Set(['error', 'notification']);

  const sent = new Set(
    [...MAIN_SOURCE.matchAll(/\.send\(\s*'([^']+)'/g)].map((m) => m[1])
  );
  const subscribable = new Set(Object.values(EVENT_CHANNELS));

  for (const channel of subscribable) {
    if (NEVER_SENT.has(channel)) {
      assert.ok(!sent.has(channel), `${channel} is now sent — take it off NEVER_SENT`);
    } else {
      assert.ok(sent.has(channel), `nothing in main.js sends '${channel}' any more`);
    }
  }
});

/* ── unsubscribing ───────────────────────────────────────────── */

test('removeListener passes the caller channel and function straight through', () => {
  const ipc = fakeIpc();
  const api = buildRendererApi(ipc);
  const handler = () => {};

  api.removeListener('recording:update', handler);

  assert.strictEqual(ipc.removed.length, 1);
  assert.strictEqual(ipc.removed[0].channel, 'recording:update');
  assert.strictEqual(ipc.removed[0].handler, handler);
});

/* ── the sandbox constraint ──────────────────────────────────── */

test('preload.js requires nothing but electron', () => {
  // The settings window runs with sandbox: true, where a preload may only
  // require 'electron' and Node built-ins. A require of any file of ours fails
  // at load and takes the WHOLE bridge with it — the window still renders and
  // every control is silently dead. Splitting this file up broke exactly that
  // way once; this test is the guard that stops it happening twice.
  const source = fs
    .readFileSync(path.join(REPO_ROOT, 'preload.js'), 'utf-8')
    // Strip comments first — the note above the require mentions require()
    // itself, and a doc comment is not a load-bearing dependency.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const required = [...source.matchAll(/require\(\s*'([^']+)'/g)].map((m) => m[1]);

  assert.deepStrictEqual(required, ['electron'], 'preload.js must stay self-contained');
  for (const spec of required) {
    assert.ok(!spec.startsWith('.'), `relative require '${spec}' cannot load in a sandboxed preload`);
  }
});

test('the bridge is exposed at load time, before anything can fail', () => {
  const Module2 = require('node:module');
  const order = [];
  const stub = {
    contextBridge: { exposeInMainWorld: (k) => order.push(`expose:${k}`) },
    ipcRenderer: { invoke: () => Promise.resolve(), on: () => {}, removeListener: () => {} }
  };
  const original = Module2._load;
  Module2._load = (r, p, m) => (r === 'electron' ? stub : original.call(Module2, r, p, m));
  try {
    delete require.cache[PRELOAD];
    require(PRELOAD);
  } finally {
    Module2._load = original;
  }

  assert.deepStrictEqual(order, ['expose:meetingRecorder'], 'exactly one bridge, exposed on load');
});
