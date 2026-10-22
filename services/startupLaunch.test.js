'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { StartupLaunch } = require('./startupLaunch');
const { coerceSettings } = require('./settingsSchema');

function fixture({ saved = {}, item = {}, isPackaged = true, platform = 'darwin', fail = false } = {}) {
  const defaults = { launchAtStartup: true };
  const values = { ...defaults, ...saved };
  const writes = [];
  let reads = 0;
  let native = { openAtLogin: false, status: 'not-registered', ...item };
  const store = {
    get: (key) => values[key],
    set: (key, value) => { values[key] = value; },
    clear: () => {
      for (const key of Object.keys(values)) delete values[key];
      Object.assign(values, defaults);
    }
  };
  const app = {
    isPackaged,
    getLoginItemSettings: () => { reads++; return native; },
    setLoginItemSettings: (options) => {
      writes.push(options);
      if (!fail) native = { openAtLogin: options.openAtLogin, status: options.openAtLogin ? 'enabled' : 'not-registered' };
    }
  };
  const startup = new StartupLaunch({ app, store, platform });
  return { app, store, values, writes, startup, get reads() { return reads; }, setNative: (next) => { native = next; } };
}

test('first installed launch registers CXNotes, and later launches do not register again', () => {
  const f = fixture();
  assert.equal(f.startup.initialise().launchAtStartup, true);
  assert.deepEqual(f.writes, [{ openAtLogin: true }]);
  assert.equal(f.values.launchAtStartupInitialised, true);
  f.startup.initialise();
  assert.equal(f.writes.length, 1);
});

test('an existing false preference is honoured on first configuration', () => {
  const f = fixture({ saved: { launchAtStartup: false } });
  assert.equal(f.startup.initialise().launchAtStartup, false);
  assert.deepEqual(f.writes, []);
  assert.equal(f.values.launchAtStartupInitialised, true);
});

test('an existing native login item is adopted without registering twice', () => {
  const f = fixture({ item: { openAtLogin: true, status: 'enabled' } });
  assert.equal(f.startup.initialise().launchAtStartup, true);
  assert.deepEqual(f.writes, []);
});

test('disabling in System Settings survives app relaunch and is shown in settings', () => {
  const f = fixture();
  f.startup.initialise();
  f.setNative({ openAtLogin: false, status: 'not-registered' });
  assert.equal(f.startup.initialise().launchAtStartup, false);
  assert.equal(f.startup.getSettings().launchAtStartup, false);
  assert.equal(f.writes.length, 1);
});

test('turning startup off unregisters immediately and persists the choice', () => {
  const f = fixture();
  f.startup.initialise();
  assert.equal(f.startup.setEnabled(false).launchAtStartup, false);
  assert.deepEqual(f.writes, [{ openAtLogin: true }, { openAtLogin: false }]);
  assert.equal(f.values.launchAtStartup, false);
  f.startup.initialise();
  assert.equal(f.writes.length, 2);
});

test('pending macOS approval is visible and is not retried on every launch', () => {
  const f = fixture();
  f.app.setLoginItemSettings = (options) => {
    f.writes.push(options);
    f.setNative({ openAtLogin: false, status: 'requires-approval' });
  };
  const state = f.startup.initialise();
  assert.equal(state.launchAtStartup, true);
  assert.equal(state.launchAtStartupStatus, 'requires-approval');
  assert.equal(f.values.launchAtStartupInitialised, true);
  f.startup.initialise();
  assert.equal(f.writes.length, 1);
});

test('a pending registration can be removed without first approving it', () => {
  const f = fixture({ item: { status: 'requires-approval' } });
  assert.equal(f.startup.setEnabled(false).launchAtStartup, false);
  assert.deepEqual(f.writes, [{ openAtLogin: false }]);
});

test('development builds and unsupported platforms never call the login-item APIs', () => {
  for (const options of [{ isPackaged: false }, { platform: 'linux' }, { platform: 'win32' }]) {
    const f = fixture(options);
    assert.equal(f.startup.initialise().launchAtStartupAvailable, false);
    assert.throws(() => f.startup.setEnabled(true), /installed macOS app/);
    assert.equal(f.reads, 0);
    assert.deepEqual(f.writes, []);
    assert.equal(f.values.launchAtStartupInitialised, undefined);
  }
});

test('a silently failed registration does not persist success and can be retried', () => {
  const f = fixture({ fail: true });
  assert.throws(() => f.startup.initialise(), /macOS did not update/);
  assert.equal(f.values.launchAtStartupInitialised, undefined);
  f.app.setLoginItemSettings = () => f.setNative({ openAtLogin: true, status: 'enabled' });
  assert.equal(f.startup.initialise().launchAtStartup, true);
});

test('a failed unregister keeps the previous preference', () => {
  const f = fixture({ item: { openAtLogin: true, status: 'enabled' }, fail: true });
  assert.throws(() => f.startup.setEnabled(false), /macOS did not update/);
  assert.equal(f.values.launchAtStartup, true);
});

test('native API errors are visible without breaking reads of other settings', () => {
  const f = fixture();
  f.app.getLoginItemSettings = () => { throw new Error('service unavailable'); };
  assert.match(f.startup.getSettings().launchAtStartupError, /service unavailable/);
  assert.equal(f.startup.getSettings().launchAtStartupAvailable, false);
  assert.throws(() => f.startup.initialise(), /service unavailable/);
  assert.equal(f.values.launchAtStartupInitialised, undefined);
});

test('invalid toggle values cannot reach the native API', () => {
  const f = fixture();
  for (const value of ['true', 1, null, undefined]) {
    assert.throws(() => f.startup.setEnabled(value), /boolean/);
  }
  assert.equal(f.reads, 0);
  assert.deepEqual(f.writes, []);
});

// Exercise the actual IPC handlers, so a save/reset cannot bypass the native
// registration or orphan a recorder while applying this application setting.
function settingsHandlers(f, { recording = false } = {}) {
  const handlers = {};
  let recorderInitialisations = 0;
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const begin = source.indexOf("ipcMain.handle('settings:update'");
  const end = source.indexOf('// System Information', begin);
  vm.runInNewContext(source.slice(begin, end), {
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    coerceSettings, LLM_PROVIDER_IDS: ['codex', 'claude', 'ollama'],
    store: f.store, startupLaunch: f.startup, LAUNCH_AT_STARTUP_DEFAULT: true,
    meetingDetector: null, calendarSuggester: null, silenceWatcher: null,
    isRecordingActive: () => recording,
    initRecorder: () => { recorderInitialisations++; },
    ipcOk: () => ({ success: true }),
    ipcFail: (err) => ({ success: false, error: err.message }),
    console: { log() {}, warn() {}, error() {} }
  });
  return { handlers, get recorderInitialisations() { return recorderInitialisations; } };
}

test('saving during a recording updates startup without reinitialising the recorder', async () => {
  const f = fixture();
  const ipc = settingsHandlers(f, { recording: true });
  const result = await ipc.handlers['settings:update']({}, { launchAtStartup: true });
  assert.equal(result.success, true);
  assert.equal(result.launchAtStartupStatus, 'enabled');
  assert.deepEqual(f.writes, [{ openAtLogin: true }]);
  assert.equal(ipc.recorderInitialisations, 0);
});

test('an OS failure rejects the save before persisting the settings patch', async () => {
  const f = fixture({ fail: true });
  const ipc = settingsHandlers(f);
  const result = await ipc.handlers['settings:update']({}, { launchAtStartup: true, retentionDays: 30 });
  assert.equal(result.success, false);
  assert.equal(f.values.retentionDays, undefined);
  assert.equal(f.values.launchAtStartupInitialised, undefined);
  assert.equal(ipc.recorderInitialisations, 0);
});

test('an unrelated settings save does not re-enable a login item disabled in macOS', async () => {
  const f = fixture({ saved: { launchAtStartupInitialised: true } });
  const ipc = settingsHandlers(f);
  const result = await ipc.handlers['settings:update']({}, { retentionDays: 30 });
  assert.equal(result.success, true);
  assert.equal(result.launchAtStartup, false);
  assert.deepEqual(f.writes, []);
});

test('reset restores native startup defaults without disrupting an active recording', async () => {
  const f = fixture({ saved: { launchAtStartup: false, launchAtStartupInitialised: true } });
  const ipc = settingsHandlers(f, { recording: true });
  const result = await ipc.handlers['settings:reset']();
  assert.equal(result.success, true);
  assert.deepEqual(f.writes, [{ openAtLogin: true }]);
  assert.equal(f.values.launchAtStartup, true);
  assert.equal(f.values.launchAtStartupInitialised, true);
  assert.equal(ipc.recorderInitialisations, 0);
});

test('development settings saves and resets still work without registering Electron', async () => {
  const f = fixture({ isPackaged: false });
  const ipc = settingsHandlers(f);
  assert.equal((await ipc.handlers['settings:update']({}, { retentionDays: 30 })).success, true);
  assert.equal((await ipc.handlers['settings:reset']()).success, true);
  assert.equal(f.reads, 0);
  assert.deepEqual(f.writes, []);
});
