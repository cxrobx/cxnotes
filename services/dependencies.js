'use strict';

const path = require('node:path');

/**
 * The judgement calls inside the dependency check, separated from the probing.
 *
 * `main.js` still does the actual looking — resolving binaries, asking
 * ScreenCaptureKit for permission, enumerating microphones. What lives here is
 * everything that decides what those findings *mean*: whether the app can
 * record at all, what to tell the user, and what the summary lines say.
 *
 * That split is what makes this testable. The probing needs a real Mac with
 * real permissions; the reasoning is where the bugs actually are, and it is
 * pure.
 */

/** Order the summary and the dialog both list dependencies in. */
const DEPENDENCY_ROWS = [
  ['sox', 'sox (audio recording)'],
  ['transcription', 'Transcription (Parakeet / whisper.cpp)'],
  ['codex', 'AI Summarisation (Codex/Claude)'],
  ['mic', 'Microphone (dual-track)']
];

/**
 * Whether transcription works at all, and through which backend.
 *
 * Parakeet (via uv) is the DEFAULT transcriber; whisper.cpp is only the
 * automatic fallback (services/transcriber.js). The check used to count
 * whisper alone, so a machine transcribing happily through Parakeet was
 * greeted with a "Setup Required" dialog on every launch — the 2026-08-19
 * install feedback. Either backend present means transcription works.
 *
 * @param {{parakeet: boolean, whisper: boolean}} status
 * @returns {{ok: boolean, detail: string}}
 */
function resolveTranscription({ parakeet, whisper }) {
  const ok = Boolean(parakeet || whisper);
  let detail;
  if (parakeet && whisper) detail = 'Parakeet, whisper.cpp fallback ready';
  else if (parakeet) detail = 'Parakeet';
  else if (whisper) detail = 'whisper.cpp only — uv missing, so no Parakeet';
  else detail = 'no backend';
  return { ok, detail };
}

/**
 * Can system audio be captured?
 *
 * One route: ScreenCaptureKit. The sox+BlackHole fallback was removed because
 * it could not fail loudly — BlackHole carries audio only when system output is
 * routed into it, so an unrouted fallback reported itself ready and then
 * recorded silence. Reporting "not available" is the honest answer, and unlike
 * a silent recording it is fixable before the meeting rather than after.
 *
 * The two negative cases are distinguished because the fixes are different:
 * an ungranted permission is two clicks, an unavailable SCK is a build or an
 * OS-version problem.
 *
 * @param {{sckAvailable: boolean, sckPermitted: boolean|null}} probe
 * @returns {{ok: boolean, method: 'sck'|null, reason: string}}
 */
function resolveSystemAudio({ sckAvailable, sckPermitted }) {
  if (sckAvailable && sckPermitted) {
    return { ok: true, method: 'sck', reason: 'ScreenCaptureKit available and permitted' };
  }
  if (sckAvailable && sckPermitted === false) {
    return { ok: false, method: null, reason: 'Screen Recording permission not granted' };
  }
  return { ok: false, method: null, reason: 'ScreenCaptureKit unavailable (requires macOS 13+)' };
}

/**
 * Whether a microphone is required at all, and whether one is present.
 *
 * System-only mode has no microphone to be missing, so reporting one as absent
 * would be a permanent false alarm for anyone who records that way.
 *
 * @param {{mode: string, configuredDevice: ?string, deviceVerifies: boolean, defaultDevice: ?object}} probe
 * @returns {{ok: boolean, required: boolean, detail: string}}
 */
function resolveMicrophone({ mode, configuredDevice, deviceVerifies, defaultDevice }) {
  if (mode !== 'dual') {
    return { ok: true, required: false, detail: 'not needed in system-only mode' };
  }
  if (configuredDevice) {
    return {
      ok: Boolean(deviceVerifies),
      required: true,
      detail: `Mic device "${configuredDevice}": ${deviceVerifies ? 'available' : 'not found'}`
    };
  }
  return {
    ok: Boolean(defaultDevice),
    required: true,
    detail: `Default mic: ${defaultDevice ? defaultDevice.name : 'none found'}`
  };
}

/** The `OK` / `MISSING` block printed to the console after every check. */
function summariseToConsole(status) {
  const transcription = resolveTranscription(status);
  return [
    '=== Dependency Check Summary ===',
    `sox:           ${status.sox ? 'OK' : 'MISSING'}`,
    `system audio:  ${status.systemAudio ? 'OK' : 'MISSING'}`,
    `transcription: ${transcription.ok ? `OK (${transcription.detail})` : 'MISSING'}`,
    `ai summary:    ${status.codex ? 'OK' : 'MISSING'}`,
    `mic:           ${status.mic ? 'OK' : 'MISSING'}`,
    '================================'
  ].join('\n');
}

/**
 * The dialog shown by "Check Dependencies".
 *
 * Returns a descriptor rather than showing anything, so the wording and the
 * button logic can be tested without an Electron dialog.
 *
 * The distinction that matters: setup installs sox and a transcriber but
 * CANNOT install an AI CLI, since those are separate paid subscriptions.
 * Offering "Run Setup" when the only gap is a summariser would send the user
 * through a script that cannot fix their problem.
 *
 * @param {object} status
 * @param {string} providerInstallLines - one install command per provider
 * @returns {{type: string, title: string, message: string, detail: string, buttons: string[], canRunSetup: boolean, allReady: boolean}}
 */
function describeDependencyStatus(status, providerInstallLines) {
  const transcription = resolveTranscription(status);
  const rowStatus = { ...status, transcription: transcription.ok };

  const rows = DEPENDENCY_ROWS
    .map(([key, label]) => `${rowStatus[key] ? 'OK' : 'MISSING'} ${label}`)
    .join('\n');

  const allReady = DEPENDENCY_ROWS.every(([key]) => Boolean(rowStatus[key]));
  const canRunSetup = !status.sox || !transcription.ok;

  let advice;
  if (allReady) {
    advice = 'All dependencies installed!';
  } else {
    // One line per missing item, each naming ITS fix. The old single generic
    // "run setup.sh" block sent people through a script that could not fix
    // their actual gap.
    const fixes = [];
    if (!status.sox) fixes.push('sox: brew install sox');
    if (!transcription.ok) {
      fixes.push('Transcription: brew install uv (Parakeet), or Run Setup for the whisper.cpp fallback');
    }
    if (!status.codex) fixes.push(`AI summarisation needs one of these CLIs:\n${providerInstallLines}`);
    if (!status.mic) fixes.push('Microphone: none found — plug one in or pick a device in Settings > Recording');
    advice = fixes.join('\n\n');
  }

  return {
    type: allReady ? 'info' : 'warning',
    title: 'Dependency Status',
    message: 'CXNotes Dependencies',
    detail: `Dependencies Status:\n\n${rows}\n\n${advice}`,
    buttons: canRunSetup ? ['Run Setup', 'OK'] : ['OK'],
    canRunSetup,
    allReady
  };
}

/**
 * The shell command that runs setup on THIS install.
 *
 * A packaged app cannot run the repo's setup.sh: its `__dirname` points inside
 * app.asar — a packed archive FILE, not a directory — so `cd` into it fails
 * before the script is even looked for, and the repo checkout the script
 * assumes (git clone + cmake build of whisper.cpp) does not exist on a user's
 * machine anyway. The packaged app therefore ships `setup-packaged.sh` via
 * extraResources — a real file on disk, signed with the bundle — and runs it
 * with `bash`, which needs no execute bit and so never writes into the signed
 * bundle. Verified broken 2026-08-19 on another Mac: every "Run Setup" button
 * in a packaged build opened Terminal onto a failing `cd`.
 *
 * The dev branch is byte-identical to the pre-fix behaviour on purpose.
 *
 * @param {{isPackaged: boolean, repoDir: string, resourcesPath: string}} opts
 * @returns {string}
 */
function resolveSetupCommand({ isPackaged, repoDir, resourcesPath }) {
  if (isPackaged) {
    return `bash "${path.join(resourcesPath, 'setup-packaged.sh')}"`;
  }
  return `cd "${repoDir}" && chmod +x setup.sh && ./setup.sh`;
}

/**
 * The AppleScript that opens Terminal and runs the setup command.
 *
 * Setup runs in Terminal rather than in a hidden subprocess because it is
 * interactive — it streams long installs the user should watch.
 *
 * Known limitation, preserved rather than silently changed: the command is
 * interpolated into a shell string inside AppleScript inside `osascript -e`,
 * so a path containing a single quote breaks the command. CXNotes lives in
 * /Applications or a developer's project directory, so this has never bitten;
 * fixing it properly means passing the command as an argv rather than by
 * interpolation.
 *
 * @param {string} shellCommand
 * @returns {string}
 */
function buildSetupTerminalScript(shellCommand) {
  const quoted = String(shellCommand).replace(/"/g, '\\"');
  return `
      tell application "Terminal"
        activate
        do script "${quoted}"
      end tell
    `;
}

/** What to show when Terminal could not be opened at all. */
function setupFallbackMessage(shellCommand) {
  return `Failed to open Terminal.\n\nPlease run manually:\n${shellCommand}`;
}

module.exports = {
  DEPENDENCY_ROWS,
  resolveSystemAudio,
  resolveMicrophone,
  resolveTranscription,
  summariseToConsole,
  describeDependencyStatus,
  resolveSetupCommand,
  buildSetupTerminalScript,
  setupFallbackMessage
};
