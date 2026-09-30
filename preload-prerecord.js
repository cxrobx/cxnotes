/**
 * Preload script for the pre-record popup window.
 * Minimal API — just context get/set and start/cancel.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('preRecord', {
  getContext: () => ipcRenderer.invoke('prerecord:getContext'),
  startWithContext: (context) => ipcRenderer.invoke('prerecord:start', context),
  cancel: () => ipcRenderer.invoke('prerecord:cancel')
});
