/**
 * Preload script for the vault-filing "where should this note go?" prompt.
 * Minimal API — get context, choose a destination, or dismiss (the note is
 * already safe in Inbox/, so every path out of this window is non-destructive).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('filingPrompt', {
  getContext: () => ipcRenderer.invoke('filing:getContext'),           // { noteTitle, candidates: [{id, label, rel}] }
  choose: (destinationId) => ipcRenderer.invoke('filing:choose', destinationId),
  dismiss: () => ipcRenderer.invoke('filing:dismiss')
});
