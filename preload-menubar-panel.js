/**
 * Preload script for the menu-bar panel — the popover that hangs off the tray
 * icon on left-click (right-click still opens the classic context menu).
 *
 * The panel is a VIEW over main-process state: it never owns recording state,
 * it asks for a snapshot (`getState`) and then receives pushed updates
 * (`onState`) while it is open. Every action routes through the same guarded
 * paths the tray and settings window already use.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menubarPanel', {
  // Snapshot: { recording, upcoming, recentNotes, deps, mode, markers, ... }
  getState: () => ipcRenderer.invoke('panel:getState'),

  // Actions
  startRecording: () => ipcRenderer.invoke('panel:startRecording'),
  stopRecording: () => ipcRenderer.invoke('panel:stopRecording'),
  recordUpcoming: (fingerprint) => ipcRenderer.invoke('panel:recordUpcoming', fingerprint),
  addMarker: (label) => ipcRenderer.invoke('panel:addMarker', label),
  openSettings: () => ipcRenderer.invoke('panel:openSettings'),
  openPath: (target) => ipcRenderer.invoke('panel:openPath', target),
  resummarise: (sessionDir) => ipcRenderer.invoke('panel:resummarise', sessionDir),
  // Right-click a note row → the menu MODEL (main decides what is enabled;
  // the panel draws it, and swaps in each item's Option-key variant while
  // Option is held), then one call per action chosen.
  noteMenu: (payload) => ipcRenderer.invoke('panel:noteMenu', payload),
  noteAction: (payload) => ipcRenderer.invoke('panel:noteAction', payload),
  close: () => ipcRenderer.invoke('panel:close'),
  quit: () => ipcRenderer.invoke('panel:quit'),

  // Fit the window to the rendered content height (main clamps it)
  resize: (height) => ipcRenderer.invoke('panel:resize', height),

  // Pushed state (levels/timer/markers) while the panel is open
  onState: (callback) => {
    ipcRenderer.on('panel:state', (event, data) => callback(data));
  }
});
