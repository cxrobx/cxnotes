'use strict';

/**
 * Preload script — the only bridge between the settings window and the main
 * process.
 *
 * Runs with Node access before the renderer's page loads, and hands the page a
 * fixed set of functions through `contextBridge`. The renderer never sees
 * `require`, `ipcRenderer`, or anything else from Electron: it gets
 * `window.meetingRecorder` and nothing more.
 *
 * SELF-CONTAINED ON PURPOSE — do not split this file up. The settings window is
 * created with `sandbox: true` (main.js), and a sandboxed preload may only
 * `require('electron')` and Node built-ins; requiring a sibling file of our own
 * fails at load with "module not found", which takes the ENTIRE bridge with it.
 * The window then renders perfectly and every control is dead, because
 * `window.meetingRecorder` is undefined. That is not a hypothetical: this file
 * was briefly split into utils/preloadApi.js and it broke exactly that way,
 * while unit tests and a plain-node require both still passed — neither
 * exercises the sandbox. Verified by loading the real window in Electron.
 *
 * The surface below is a table rather than forty hand-written closures so it
 * can be reviewed in one place, and it is exported at the bottom so
 * preload.test.js can exercise it against a stubbed ipcRenderer.
 */

const { contextBridge, ipcRenderer } = require('electron');
/**
 * The renderer-facing bridge surface, expressed as data.
 *
 * `preload.js` is the only consumer: it hands this module Electron's
 * `ipcRenderer` and exposes whatever comes back. Holding the surface as a table
 * rather than as forty hand-written arrow functions buys two things the
 * hand-written form could not:
 *
 *   1. The whole API is reviewable on one screen, and adding a call is a
 *      one-line data edit rather than a copied-and-adjusted closure.
 *   2. It is testable without Electron. A preload script that calls
 *      `contextBridge.exposeInMainWorld` at require time cannot be loaded by
 *      `node --test` at all, which is precisely why this surface — the entire
 *      contract between the settings window and the main process — had no
 *      coverage.
 *
 * The channel strings are the contract with `ipcMain.handle` in `main.js`.
 * `preloadApi.test.js` asserts every one of them has a handler, so a typo fails
 * the suite instead of surfacing as a rejected promise at runtime.
 */

/** The single global the renderer reads (`renderer/app.js` → `window.meetingRecorder`). */
const BRIDGE_KEY = 'meetingRecorder';

/**
 * Request channels — the renderer asks, main answers, the call returns a Promise.
 *
 * `name: [channel]` takes no payload; `name: [channel, 'payloadName']` takes
 * exactly one. The payload name is documentation, but the *arity* it implies is
 * load-bearing: a spread forwarder would send a stray `undefined` on every
 * no-payload call, so the two shapes are built differently below.
 */
const REQUEST_CHANNELS = Object.freeze({
  // Recording controls
  startRecording: ['recording:start'],
  stopRecording: ['recording:stop'],
  getRecordingStatus: ['recording:status'],

  // Stored recordings on disk
  listRecordings: ['files:list'],
  getStorageStats: ['files:stats'],
  deleteRecording: ['files:delete', 'filename'],
  cleanupOldRecordings: ['files:cleanup'],
  openFile: ['files:open', 'filepath'],

  // Transcription and note generation
  transcribeRecording: ['process:transcribe', 'wavPath'],
  generateNotes: ['process:summarise', 'transcriptPath'],
  processRecording: ['process:full', 'wavPath'],
  reprocessSession: ['session:reprocess', 'sessionDir'],
  // Notes only, reusing the transcript already on disk — the cheap repair for a
  // summary poisoned by a provider refusal (gotcha #12). Re-running whisper over
  // a long meeting to fix a ~45s step is the thing this avoids.
  resummariseSession: ['session:resummarise', 'sessionDir'],
  getProcessingStatus: ['processing:status'],

  // Audio configuration
  listInputDevices: ['audio:listInputDevices'],
  runPreflight: ['audio:preflight'],

  // Settings
  getSettings: ['settings:get'],
  updateSettings: ['settings:update', 'settings'],
  // Live glass preview while the transparency slider is dragged. Deliberately
  // separate from updateSettings: a drag emits a value per frame and none of
  // them are a decision — only the one you let go on is, and that one is saved.
  previewGlass: ['glass:preview', 'transparency'],
  resetSettings: ['settings:reset'],

  // Calendar access
  getCalendarPermissionState: ['calendar:getPermissionState'],
  requestCalendarPermission: ['calendar:requestPermission'],
  openCalendarPrivacySettings: ['calendar:openPrivacySettings'],

  // Host system
  checkDependencies: ['system:dependencies'],
  getVersion: ['system:version'],
  openOutputDirectory: ['system:openOutputDir'],
  chooseOutputDirectory: ['system:chooseOutputDir'],
  chooseVaultDirectory: ['system:chooseVaultDir'],
  detectVaultDirectory: ['system:detectVaultDir'],
  requestScreenCapturePermission: ['system:requestScreenCapturePermission'],
  confirmAction: ['dialog:confirm', 'options']
});

/**
 * Push channels — main pushes, the renderer subscribes. Each subscriber receives
 * the payload alone; Electron's `IpcRendererEvent` is swallowed here so no
 * renderer code ever holds a handle on `sender`.
 *
 * `error` and `notification` are exposed but nothing in `main.js` currently
 * sends them. They are kept because removing them is a renderer-facing API
 * change, not a cleanup; `preloadApi.test.js` records which are live so that a
 * *live* one losing its sender is caught, while these two stay quiet.
 */
const EVENT_CHANNELS = Object.freeze({
  onRecordingUpdate: 'recording:update',
  onRecordingLevels: 'recording:levels',
  onProcessingProgress: 'processing:progress',
  onProcessingComplete: 'processing:complete',
  onError: 'error',
  onNotification: 'notification',
  onRecordingsChanged: 'recordings:changed',
  onCompanionModeStatus: 'companion-mode-status'
});

/**
 * Build one request function. Split on arity rather than spreading `...args`
 * because `invoke(channel, undefined)` and `invoke(channel)` are not the same
 * message, and the no-payload channels are the majority.
 */
function requestFn(ipcRenderer, channel, takesPayload) {
  if (takesPayload) return (payload) => ipcRenderer.invoke(channel, payload);
  return () => ipcRenderer.invoke(channel);
}

/** Build one subscribe function, dropping the Electron event argument. */
function eventFn(ipcRenderer, channel) {
  return (callback) => {
    ipcRenderer.on(channel, (_event, data) => callback(data));
  };
}

/**
 * Assemble the object handed to `contextBridge`.
 *
 * Takes `ipcRenderer` as a parameter rather than requiring `electron` so the
 * whole surface can be exercised against a stub — the same shape as the other
 * pure modules here (`services/glass.js`, `services/vaultLocator.js`).
 */
function buildRendererApi(ipcRenderer) {
  const api = {};

  for (const [name, [channel, payload]] of Object.entries(REQUEST_CHANNELS)) {
    api[name] = requestFn(ipcRenderer, channel, Boolean(payload));
  }

  for (const [name, channel] of Object.entries(EVENT_CHANNELS)) {
    api[name] = eventFn(ipcRenderer, channel);
  }

  // Unsubscribing needs the caller's own channel and function reference, so it
  // cannot be generated from either table.
  api.removeListener = (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  };

  return api;
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, buildRendererApi(ipcRenderer));

// Exported for preload.test.js, which loads this file with `electron` stubbed.
// Assigned after the bridge is up, so this can never delay exposing it.
module.exports = {
  BRIDGE_KEY,
  REQUEST_CHANNELS,
  EVENT_CHANNELS,
  buildRendererApi
};
