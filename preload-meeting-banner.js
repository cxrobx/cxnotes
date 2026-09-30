/**
 * Preload script for the meeting detection banner.
 * Minimal API — get the detection context, take notes, or dismiss.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetingBanner', {
  getContext: () => ipcRenderer.invoke('meeting:getContext'),
  takeNotes: () => ipcRenderer.invoke('meeting:takeNotes'),
  confirmRecord: () => ipcRenderer.invoke('meeting:confirmRecord'),
  dismiss: () => ipcRenderer.invoke('meeting:dismiss')
});
