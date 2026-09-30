'use strict';

/**
 * The tray menu, as data.
 *
 * Pure and Electron-free: this returns a plain template array that `main.js`
 * hands to `Menu.buildFromTemplate`. Keeping the *shape* of the menu separate
 * from the act of building it is what makes it testable at all — which matters
 * more here than it looks, because the menu is the app's primary control
 * surface and its correctness is entirely in conditionals. Which items exist,
 * what they are labelled, and whether they are enabled all depend on recording
 * state, dependency state, and what the calendar poll last returned.
 *
 * Every action is injected rather than imported, so this module cannot start a
 * recording or open a window by itself. That keeps invariant #15's rule intact
 * from the other direction: the menu is a view, and every click routes back
 * through the single guarded path in main.js.
 */

/** How close a meeting must be to be flagged as imminent. */
const UPCOMING_SOON_MS = 10 * 60 * 1000;

/** Longest meeting title shown before ellipsis. */
const UPCOMING_TITLE_MAX = 32;

/** Most upcoming meetings listed at once. */
const UPCOMING_LIMIT = 5;

/**
 * Render elapsed time the way the tray shows it: `M:SS`, or `H:MM:SS` once a
 * meeting passes the hour.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * One row per upcoming meeting, under a disabled header.
 *
 * @param {Array<{title?: string, startTime?: string}>} meetings
 * @param {{nowMs: number, onPick: Function}} opts
 * @returns {Array<object>} menu items, empty when there is nothing to show
 */
function buildUpcomingItems(meetings, { nowMs, onPick }) {
  if (!meetings || meetings.length === 0) return [];

  const items = [
    { type: 'separator' },
    { label: 'Upcoming on your calendar', enabled: false }
  ];

  for (const meeting of meetings.slice(0, UPCOMING_LIMIT)) {
    const start = new Date(meeting.startTime);
    const known = !Number.isNaN(start.getTime());
    const soon = known && start.getTime() - nowMs <= UPCOMING_SOON_MS;

    const time = known
      ? start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '';
    const prefix = time ? `${soon ? '🟢' : '⏱'} ${time} · ` : `${soon ? '🟢' : '⏱'} `;

    let title = (meeting.title || 'Untitled meeting').trim();
    if (title.length > UPCOMING_TITLE_MAX) {
      title = `${title.slice(0, UPCOMING_TITLE_MAX - 1).trimEnd()}…`;
    }

    items.push({
      label: `${prefix}${title}${soon ? '  (soon)' : ''}`,
      click: () => onPick(meeting)
    });
  }

  return items;
}

/**
 * The line under the start/stop item that says what the app is doing.
 *
 * Always disabled — it is a readout, not a control.
 */
function statusItem({ isRecording, modeLabel, durationMs, canRecord }) {
  if (isRecording) {
    return { label: `Recording (${modeLabel}): ${formatDuration(durationMs)}`, enabled: false };
  }
  return {
    label: canRecord ? `Ready (${modeLabel})` : 'Dependencies missing',
    enabled: false
  };
}

/**
 * Build the whole tray menu template.
 *
 * @param {object} state
 * @param {boolean} state.isRecording
 * @param {boolean} state.isDualMode
 * @param {boolean} state.canRecord      - system audio is available
 * @param {number}  [state.durationMs]   - elapsed recording time
 * @param {Array}   [state.upcoming]     - meetings from the calendar poll
 * @param {number}  [state.nowMs]
 * @param {string}  [state.markerAccelerator]
 * @param {object} actions - one function per clickable item
 * @returns {Array<object>} a Menu.buildFromTemplate template
 */
function buildTrayMenuTemplate(state, actions) {
  const {
    isRecording,
    isDualMode,
    canRecord,
    durationMs = 0,
    upcoming = [],
    nowMs = 0,
    markerAccelerator
  } = state;

  const modeLabel = isDualMode ? 'Dual Track' : 'System Only';

  return [
    {
      label: isRecording ? '⏹  Stop Recording' : '⏺  Start Recording',
      click: isRecording ? actions.stopRecording : actions.startRecording,
      // Stopping must never be blocked by a dependency check — a recording in
      // progress has to be stoppable even if the environment has since broken.
      enabled: isRecording || canRecord
    },

    ...(isRecording
      ? [{ label: '⚑  Drop Marker', accelerator: markerAccelerator, click: actions.dropMarker }]
      : []),

    statusItem({ isRecording, modeLabel, durationMs, canRecord }),

    // Only offered when idle: starting a calendar meeting mid-recording would
    // mean silently abandoning the one already running.
    ...(isRecording ? [] : buildUpcomingItems(upcoming, { nowMs, onPick: actions.startFromUpcoming })),

    { type: 'separator' },
    { label: 'Open Panel', click: actions.showPanel },
    { label: 'Settings...', click: actions.openSettings },

    { type: 'separator' },
    { label: 'Open Recordings Folder', click: actions.openRecordingsFolder },
    { label: 'View Processed Notes', click: actions.openProcessedFolder },

    { type: 'separator' },
    { label: 'Refresh Dependencies', click: actions.refreshDependencies },
    { label: 'Check Dependencies', click: actions.showDependencyStatus },
    { label: 'Run Setup Script', click: actions.runSetupScript },

    { type: 'separator' },
    { label: 'Storage Stats', click: actions.showStorageStats },
    { label: 'Cleanup Old Recordings', click: actions.runCleanup },

    { type: 'separator' },
    { label: 'Quit', click: actions.quit }
  ];
}

module.exports = {
  UPCOMING_SOON_MS,
  UPCOMING_TITLE_MAX,
  UPCOMING_LIMIT,
  formatDuration,
  buildUpcomingItems,
  buildTrayMenuTemplate
};
