/**
 * Preload script for the prolonged-silence "still recording?" prompt.
 * Minimal API — get context, keep recording, or stop now.
 *
 * The authoritative grace timer lives in the main process; the renderer's
 * countdown is cosmetic, so there is no "the timer fired" channel here.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('silencePrompt', {
  getContext: () => ipcRenderer.invoke('silence:getContext'),     // { minutes, graceSeconds }
  keepRecording: () => ipcRenderer.invoke('silence:keepRecording'),
  stopNow: () => ipcRenderer.invoke('silence:stopNow')
});
