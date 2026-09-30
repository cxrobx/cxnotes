const { app, Tray, Menu, BrowserWindow, screen, shell, nativeImage, Notification, dialog, ipcMain, globalShortcut, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');
const { execSync } = require('child_process');

// Durable log: every console line from here on is also appended to
// ~/Library/Logs/CXNotes/cxnotes.log (rotated). Installed first so nothing that
// happens during start-up, a recording or a crash is lost with the console.
const { installFileLog } = require('./utils/fileLog');
installFileLog();

// Suppress EPIPE errors on stdout/stderr when launched from Finder (no terminal attached)
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// Ensure homebrew paths are available (packaged .app has minimal PATH)
const EXTRA_PATHS = [
  '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
  path.join(os.homedir(), '.nvm/versions/node/v24.11.1/bin'),  // nvm-installed globals (codex)
  path.join(os.homedir(), '.local/bin'),                        // claude CLI
];
const missingPaths = EXTRA_PATHS.filter(p => !(process.env.PATH || '').includes(p));
if (missingPaths.length) {
  process.env.PATH = missingPaths.join(':') + ':' + (process.env.PATH || '');
}
console.log('PATH:', process.env.PATH);

const { Recorder, DualTrackRecorder } = require('./services/recorder');
const { SlideCaptureSession, resolveSlideBinaryPath, resolveAudioSourceBundle, SLIDES_DIRNAME } = require('./services/slideCapture');
const { CallCaptureSession, resolveCallBinaryPath } = require('./services/callCapture');
const { runSlideOcr, writeSlidesJson } = require('./services/slideText');
const { parseScreenTextCsv, buildSpeakerTimeline, parseRoster } = require('./services/speakerNames');
const { LevelMonitor } = require('./services/levelMonitor');
const { SilenceWatcher, computeTrackHealth, DEFAULT_STALL_TIMEOUT_MS } = require('./services/silenceWatcher');
const { SignalWatcher, DEFAULT_ESCALATION_MS } = require('./services/signalWatcher');
const { verifyCapture, PROBE_AMPLITUDE_LIVE } = require('./services/probeRunner');
const { prependSilentTrackWarning, prependOwnMicNotice } = require('./services/silentTrackNotice');
const { transcribe, transcribeSession, findUv, verifyInstallation: verifyWhisper } = require('./services/transcriber');
const { generateNotes, generateSessionNotes, exportNotesToObsidian, isCodexAvailable, isClaudeAvailable, providerAvailability, runLLM, detectProviderFailure, restampCategoryForDestination } = require('./services/summariser');
const { PROVIDERS: LLM_PROVIDERS, PROVIDER_IDS: LLM_PROVIDER_IDS, normalisePreference } = require('./services/llmProviders');
const { classifyNote, resolveCollision } = require('./services/noteFiler');
const { setVaultProfile } = require('./services/vaultProfile');
const { ensureDirectoryStructure, cleanupOldRecordings, getStorageStats } = require('./services/fileManager');
const { buildTrayMenuTemplate, formatDuration } = require('./services/trayMenu');
const { buildNoteMenuItems, NOTE_MENU_ACTIONS } = require('./services/noteMenu');
const {
  resolveSystemAudio,
  resolveMicrophone,
  summariseToConsole,
  describeDependencyStatus,
  resolveSetupCommand,
  buildSetupTerminalScript,
  setupFallbackMessage
} = require('./services/dependencies');
const {
  buildRecordingsList,
  toStorageSummary,
  EMPTY_STORAGE_SUMMARY
} = require('./services/recordingsList');
const { coerceSettings, clampSilenceMinutes } = require('./services/settingsSchema');
const { ProcessRegistry } = require('./services/processRegistry');
const { listInputDevices, findDefaultMicrophone, verifyInputDevice, checkSckAvailable } = require('./utils/audioDevices');
const { resolveBinaryCached, clearBinaryCache } = require('./utils/binaries');
const { trimSilence, measureWavPeak } = require('./utils/audioProcessing');
const { checkForProvider } = require('./services/companionTranscript');
const { MeetingDetector } = require('./services/meetingDetector');
const { DismissalRegistry } = require('./services/dismissalRegistry');
const { CalendarSuggester } = require('./services/calendarSuggester');
const { createCalendarSource } = require('./services/calendarSources');
const { resolveCalendarHelperPath } = require('./shared/paths');
const {
  buildPreRecordSeedFromEvent,
  buildMeetingContext,
  renderSkeletonMarkdown
} = require('./services/meetingTemplate');
const { PreparedMeetingStore } = require('./services/preparedMeetingStore');
const {
  createMarker,
  addMarker,
  writeMarkers,
  readMarkers,
  renderMarkersMarkdown
} = require('./services/markers');
const { spawn: childSpawn } = require('child_process');
const {
  normaliseVaultPath,
  detectVaultDirectory,
  describeVault,
  isInsideVault: vaultIsInside
} = require('./services/vaultLocator');
const {
  TRANSPARENCY_DEFAULT,
  normaliseTransparency,
  glassStyleText
} = require('./services/glass');

/**
 * Where this app used to export, unconditionally. Kept ONLY as a migration
 * hint: an existing install whose notes have always landed here must keep
 * landing here after the upgrade, rather than silently jumping to whichever
 * vault Obsidian happens to have open.
 */
const LEGACY_VAULT_DIRECTORY = path.join(app.getPath('documents'), 'CX');

// Persistent config store
const store = new Store({
  defaults: {
    outputDirectory: path.join(app.getPath('documents'), 'CXNotesRecordings'),
    retentionDays: 7,
    autoProcess: true,
    recordingMode: 'dual',
    micDevice: null,
    systemLabel: 'Remote',
    micLabel: 'Me',
    meetingContext: {
      title: '',
      participants: '',
      agenda: ''
    },
    useSharedTranscript: true,
    meetingDetectionEnabled: true,
    calendarSuggestionsEnabled: false,
    calendarAutoTemplateEnabled: false,
    calendarLeadTimeMinutes: 2,
    calendarDenylist: ['Lunch', 'Gym', 'Focus', 'Block', 'OOO', 'Holiday'],
    // Calendar source: 'auto' prefers cxmail's email-derived calendar (catches
    // unaccepted invites + detected meetings the Mac Calendar never sees) and
    // falls back to macOS EventKit when cxmail isn't installed. 'cxmail'/'macos'
    // force one. cxmailCalendarMinConfidence gates cxmail's `detected` events.
    calendarSource: 'auto',
    cxmailCalendarMinConfidence: 0.7,
    calendarDismissedFingerprints: [],
    silenceAutoStopEnabled: true,
    silenceAutoStopMinutes: 5,
    // Vault auto-filing: route exported notes into the matching project folder
    // (deterministic keywords → LLM fallback → Inbox escalation). The routing
    // rules are vaultFilingRules; vaultProfile holds the rest of what is
    // personal to one vault (own names, category codes, discovery folders —
    // see services/vaultProfile.js). Both are empty until the user fills them.
    vaultAutoFilingEnabled: true,
    slideCaptureEnabled: false,
    // Off by default: turning it on is also the moment macOS is asked for
    // System Audio Recording, which must happen outside a meeting (inv #26).
    callCaptureEnabled: false,
    vaultFilingRules: [],
    vaultProfile: {},
    // App used for markdown that lives OUTSIDE the vault (a session's raw
    // notes.md). Obsidian can only open files inside a vault, so loose notes
    // go here instead. Any app name `open -a` accepts works.
    plainTextEditor: 'TextEdit',
    // Which AI CLI writes the summary and picks the vault folder.
    // 'auto' (default) = the pre-setting behaviour: Codex → Claude → Ollama,
    // whichever is installed. A named provider goes first and the others stay
    // as fallback; llmProviderStrict removes the fallback, which is the only
    // way to guarantee a transcript reaches nothing but the chosen provider
    // (the reason someone picks the local one). Valid ids live in
    // services/llmProviders.js — an unrecognised value degrades to 'auto'
    // rather than breaking summarisation.
    llmProvider: 'auto',
    llmProviderStrict: false,
    // Per-provider model override; blank = the pinned default for that
    // provider. Exists because the pinned models assume a plan that not every
    // user has.
    llmModels: {},
    // How much of the desktop shows through the windows. One dial; three pane
    // alphas derived from it in services/glass.js. A dial rather than a fixed
    // design choice because the useful amount depends entirely on the wallpaper
    // behind the window, which is not ours to guess.
    windowTransparency: TRANSPARENCY_DEFAULT
  }
});

// The vault profile is read once at start-up; the pure filing and naming
// modules take it from services/vaultProfile.js, never from a literal.
setVaultProfile(store.get('vaultProfile'));

/**
 * ============================================
 * Window glass
 * ============================================
 *
 * Every window sits on a native `NSVisualEffectView`, requested with Electron's
 * `vibrancy` option. That is the half CSS cannot do: `backdrop-filter` blurs an
 * element's backdrop *root*, which for anything inside the page is the page, so
 * on a transparent window it blurs a transparent nothing — correctly applied,
 * to zero pixels. Without the material a translucent pane shows the desktop
 * through it perfectly SHARP, which is why every surface here used to be
 * near-opaque.
 *
 * Three things have to agree or it looks like one of the other two is broken:
 * the window asks for a material (`GLASS.popover` / `GLASS.window` below), the
 * document paints no background of its own, and each pane paints its own tint
 * through `--alpha-*`. Tint with no material is a flat panel with a legible
 * desktop behind it; material with no tint is an unreadable smear.
 *
 * `visualEffectState: 'active'` rather than the default: these windows are
 * mostly looked at *from* another app — the panel hangs off the menu bar while
 * you work, the banner appears over a meeting — and "follows window state"
 * drops the blur to flat grey at exactly that moment.
 */
const GLASS = {
  // Small floating surfaces that sit ON something (tray panel, banners,
  // prompts). `popover` is the material AppKit uses for exactly this.
  popover: { vibrancy: 'popover', visualEffectState: 'active' },
  // Full windows, where `under-window` is the material AppKit uses for a
  // whole-window background. `popover` reads flat across a 940pt window.
  window: { vibrancy: 'under-window', visualEffectState: 'active' }
};

function currentTransparency() {
  return normaliseTransparency(store.get('windowTransparency'));
}

/**
 * Stamp the three pane alphas onto a window's document element.
 *
 * As an INLINE style, not a stylesheet: an inline style beats every selector,
 * so it cannot lose to the `:root` fallbacks each renderer declares — and those
 * fallbacks stay meaningful as the values the very first paint uses, before
 * this has had a chance to run. Every renderer's fallback is fully opaque,
 * because a window that flashes as bare vibrancy with floating text is worse
 * than one that flashes solid.
 *
 * Failures are swallowed: a window closing mid-push is routine, and glass is
 * decoration — it must never be able to take a window down with it.
 */
function applyGlass(win) {
  if (!win || win.isDestroyed()) return;
  const style = glassStyleText(currentTransparency());
  win.webContents
    .executeJavaScript(`document.documentElement.style.cssText = ${JSON.stringify(style)};`, true)
    .catch(() => {});
}

/**
 * Wire a window to the glass, now and after every load.
 *
 * The `did-finish-load` hook is what makes this survive a reload — the settings
 * window clears its cache and reloads, and a one-shot push at creation would
 * leave it opaque afterwards with no obvious cause.
 */
function attachGlass(win) {
  if (!win || win.isDestroyed()) return win;
  win.webContents.on('did-finish-load', () => applyGlass(win));
  if (!win.webContents.isLoading()) applyGlass(win);
  return win;
}

/** Push the current dial to every open window — the slider's live preview. */
function broadcastGlass() {
  for (const win of BrowserWindow.getAllWindows()) applyGlass(win);
}

/**
 * The Obsidian vault to export notes into, or null when there isn't one.
 *
 * `vaultDirectory` is deliberately NOT in the store defaults: `store.has()` is
 * what separates "this install has never been asked" from "the user cleared
 * the field on purpose". The first read resolves and persists the answer once —
 *
 *   1. the legacy `~/Documents/CX`, if it still exists (upgrade continuity),
 *   2. else the vault Obsidian itself has open / used most recently,
 *   3. else `''` — a first-class state meaning "no vault". Notes are still
 *      transcribed, summarised and kept in the recordings folder; only the
 *      export step is skipped.
 *
 * Persisting the empty string is deliberate: it records that detection already
 * ran and found nothing, so we don't re-scan on every call, and the settings
 * window shows an explicit "not set" with a Choose… button.
 *
 * @returns {string|null} absolute path, or null when no vault is configured
 */
function getVaultDirectory() {
  if (!store.has('vaultDirectory')) {
    const detected = detectVaultDirectory({ preferPaths: [LEGACY_VAULT_DIRECTORY] });
    store.set('vaultDirectory', detected || '');
    console.log(
      detected
        ? `Vault directory detected: ${detected}`
        : 'No Obsidian vault found — notes stay in the recordings folder until one is set.'
    );
    return detected;
  }
  return normaliseVaultPath(store.get('vaultDirectory'));
}

/**
 * The user's LLM provider preference, in the shape `runLLM` expects.
 *
 * Read fresh at every call rather than captured once, so changing the provider
 * in Settings takes effect on the very next summary without a restart. Every
 * path that reaches an LLM — summarise, re-summarise, reprocess, and the vault
 * filer — goes through here, so there is one answer to "which provider is this
 * app using".
 */
function llmOptions() {
  return {
    provider: store.get('llmProvider'),
    strict: store.get('llmProviderStrict') === true,
    models: store.get('llmModels') || {}
  };
}

/**
 * `runLLM` bound to the current preference, for injection into noteFiler.
 * noteFiler calls it as `runLLM(prompt)`, so the options have to be closed over.
 */
function filingRunLLM(prompt) {
  return runLLM(prompt, undefined, llmOptions());
}

/**
 * Every provider with its live availability, for the settings UI.
 *
 * `available` is a `which <bin>` probe, so it means installed — not
 * authenticated and not in quota. The UI says "installed", never "ready".
 */
/**
 * Install instructions for every provider, from the registry.
 *
 * Never hand-written: the old dialogs hard-coded
 * `npm install -g @anthropic-ai/codex`, which 404s — Codex is OpenAI's — and
 * they still offered only the two paid CLIs after Ollama was added. Both are
 * the failure invariant #19 exists to prevent, so the text is derived.
 */
function providerInstallLines(indent = '  ') {
  return LLM_PROVIDER_IDS
    .map((id) => `${indent}${LLM_PROVIDERS[id].label}: ${LLM_PROVIDERS[id].install}`)
    .join('\n');
}

function describeProviders() {
  const available = providerAvailability();
  return LLM_PROVIDER_IDS.map((id) => ({
    id,
    label: LLM_PROVIDERS[id].label,
    kind: LLM_PROVIDERS[id].kind,
    defaultModel: LLM_PROVIDERS[id].defaultModel,
    install: LLM_PROVIDERS[id].install,
    available: available[id]
  }));
}

let tray = null;
let settingsWindow = null;
let preRecordWindow = null;
let meetingBannerWindow = null;
let meetingBannerTimer = null;
let meetingDetector = null;
let calendarSuggester = null;
let dismissalRegistry = null;
let preparedMeetingStore = null; // filesystem handoff with the standalone MCP server
let cachedUpcomingMeetings = []; // tray "Upcoming on your calendar" list, fed by the suggester poll
let currentDetection = null; // { app, displayName, fingerprint, calendarEvent?, bannerMode }
let pendingPreRecordContext = null; // seeded from currentDetection.calendarEvent when "Take notes" is clicked
let recorder = null;
let dualRecorder = null;
let currentRecordingPath = null;
let statusUpdateInterval = null;
let levelMonitor = null;
let trayIcon = null;
let latestLevels = { system: 0, mic: 0 };
let silenceWatcher = null;          // SilenceWatcher (or null when disabled)
let silencePromptWindow = null;     // frameless "still recording?" banner
let silenceGraceTimer = null;       // authoritative grace timer before auto-stop
let stopInProgress = false;         // in-flight guard for the single stop path
let filingPromptWindow = null;      // frameless "where should this note go?" banner
let filingPromptTimer = null;       // auto-hide timer for the filing prompt
let pendingFilingEscalation = null; // { exportedPath, candidates, manifestPath, noteTitle }
let menubarPanelWindow = null;      // tray-anchored popover (left-click)
let panelClosedAt = 0;              // guards the blur-then-click reopen race
let panelPushTimer = null;          // throttle for pushing live state into the panel
let trayContextMenu = null;         // built menu, popped up on right-click only
let activeMarkers = [];             // live markers for the current recording
let latestTrackHealth = {};         // per-track live/unknown/ended from the last poll
let signalWatcher = null;           // SignalWatcher — is the audio actually audio?
let systemSignalDead = false;       // latched: system capture has proven silent
let deadSignalVerdicts = 0;         // how many times it has been judged dead this session
let trackGrowth = {};               // per-track growth state feeding computeTrackHealth
let captureVerification = null;     // probe verdict for this recording (see verifyCaptureAtStart)
let probeInFlight = false;          // one probe at a time — they play a sound into a live meeting

// Track processing state so the renderer can catch up
let processingState = null; // { path, stage, progress, message }

// Track active processes for cleanup
const childProcesses = new ProcessRegistry();

// Track dependency status
let dependenciesStatus = {
  sox: false,
  whisper: false,
  codex: false,
  mic: false,
  systemAudio: false,
  lastChecked: null
};

/**
 * Export generated notes to the configured Obsidian vault.
 *
 * With no vault configured this is a no-op returning null — `exportNotesToObsidian`
 * already treats a falsy vaultDir that way, and every caller stores the result
 * as a nullable `obsidianExport`, so "no vault" needs no special casing upstream.
 */
function exportNotesToVault(notesPath, options = {}) {
  return exportNotesToObsidian(notesPath, getVaultDirectory(), options);
}

/**
 * First ~1500 chars of the generated notes — classification signal for the
 * LLM tier without shipping a whole transcript-sized document.
 */
function readNotesExcerpt(notesPath) {
  try {
    return fs.readFileSync(notesPath, 'utf-8').slice(0, 1500);
  } catch (err) {
    return '';
  }
}

/**
 * Classify a finished note into its vault destination, then export there.
 *
 * Tier flow lives in services/noteFiler.js (deterministic → LLM → Inbox/
 * catch-all). This wrapper owns the app-side policy: reprocess with a recorded
 * export path or the toggle off → the legacy flat export unchanged; an Inbox
 * placement pops the triage prompt; ANY throw falls back to the flat export so
 * notes are never lost to the filing feature.
 *
 * @param {string} notesPath
 * @param {object} [options] - exportNotesToVault options plus
 *   { agenda, manifestPath } used only for classification/escalation.
 * @returns {Promise<{obsidianPath: string|null, filing: object|null}>}
 */
async function fileAndExportNotes(notesPath, options = {}) {
  const vaultDir = getVaultDirectory();
  // No vault means nowhere to file TO: classification would scan a directory
  // that doesn't exist and every candidate would score zero. Short-circuit to
  // the plain export, which is itself a no-op without a vault.
  if (!vaultDir || options.existingPath || store.get('vaultAutoFilingEnabled') === false) {
    return { obsidianPath: exportNotesToVault(notesPath, options), filing: null };
  }

  try {
    const filing = await classifyNote(
      {
        title: options.title,
        participants: options.participants,
        agenda: options.agenda,
        notesExcerpt: readNotesExcerpt(notesPath)
      },
      {
        vaultDir,
        rules: store.get('vaultFilingRules'),
        runLLM: filingRunLLM
      }
    );

    if (!filing) {
      return { obsidianPath: exportNotesToVault(notesPath, options), filing: null };
    }

    const obsidianPath = exportNotesToVault(notesPath, {
      ...options,
      subdirectory: filing.destinationRel
    });
    console.log(`Vault filing: ${filing.method} → ${filing.destinationRel} (${filing.reason})`);

    if (filing.method === 'inbox') {
      // Own try/catch: the note is already exported to Inbox/ at this point —
      // a pop-up failure must not fall through to the outer catch and produce
      // a SECOND flat-root copy of the same note.
      try {
        showFilingPrompt({
          exportedPath: obsidianPath,
          candidates: filing.candidates,
          manifestPath: options.manifestPath || null,
          noteTitle: options.title || path.basename(obsidianPath, '.md')
        });
      } catch (promptErr) {
        console.error('Filing prompt failed (note is safe in Inbox):', promptErr);
      }
    }

    return { obsidianPath, filing };
  } catch (err) {
    console.error('Vault auto-filing failed, falling back to flat export:', err);
    return { obsidianPath: exportNotesToVault(notesPath, options), filing: null };
  }
}

/**
 * Manifest-friendly summary of a filing decision.
 */
function buildVaultFilingRecord(filing) {
  return {
    method: filing.method,
    destination: filing.destinationRel,
    confidence: filing.confidence,
    reason: filing.reason,
    decidedAt: new Date().toISOString()
  };
}

/**
 * Build a readable note title for flat transcript/note files.
 */
function buildSingleTrackNoteTitle(filepath) {
  return path.basename(filepath, path.extname(filepath))
    .replace(/_transcript$/i, '')
    .replace(/_notes$/i, '')
    .trim() || 'Meeting summary';
}

/**
 * Use meeting context when available, otherwise fall back to a generic title.
 */
function buildSessionNoteTitle(manifest) {
  return (manifest.meetingContext && manifest.meetingContext.title) || 'Meeting summary';
}

/**
 * Best-effort capture of when a single-track artefact was created.
 */
function getFileStartTime(filepath) {
  try {
    return fs.statSync(filepath).birthtime.toISOString();
  } catch (err) {
    return null;
  }
}

/**
 * Resolve path to the sck-audio-capture binary
 */
function getSckBinaryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'sck-audio-capture');
  }
  return path.join(__dirname, 'native', 'sck-audio-capture', '.build', 'release', 'sck-audio-capture');
}

/**
 * Resolve path to the sck-slide-capture binary.
 *
 * A separate helper from the audio one on purpose — see the note at the top of
 * `services/slideCapture.js`. Slides must never be in a position to take the
 * audio capture down with them.
 */
function getSlideBinaryPath() {
  return resolveSlideBinaryPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir: __dirname
  });
}

/**
 * Build the slide capture for a session, or null when it is switched off.
 *
 * The source hint is read at RECORDING START rather than cached: which
 * application is making the meeting noise is only knowable now, and it is the
 * single input that decides what the helper is allowed to look at.
 */
function createSlideCapture() {
  if (!store.get('slideCaptureEnabled')) return { session: null, options: {} };

  let assertions = null;
  try {
    assertions = execSync('pmset -g assertions', { encoding: 'utf-8', timeout: 3000 });
  } catch {
    // No assertions is a weaker hint, not a failure — the helper still refuses
    // to capture anything it cannot name.
  }

  const { sourceBundle, why } = resolveAudioSourceBundle({ assertions });
  console.log(`Slide capture: source hint — ${why}${sourceBundle ? ` (${sourceBundle})` : ''}`);

  return {
    session: new SlideCaptureSession(getSlideBinaryPath()),
    options: sourceBundle ? { sourceBundle } : {}
  };
}

/**
 * Resolve path to the call-audio-tap binary — a separate helper again, so
 * call audio can never take the system or mic capture down with it.
 */
function getCallBinaryPath() {
  return resolveCallBinaryPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir: __dirname
  });
}

/**
 * Build the call-audio capture for a session, or null when it is switched off.
 * The helper is registered so quitting drains it (invariants #3/#21).
 */
function createCallCapture() {
  if (!store.get('callCaptureEnabled')) return null;
  return new CallCaptureSession(getCallBinaryPath(), { onSpawn: registerProcess });
}

/**
 * Ask macOS for System Audio Recording now, while nothing is being recorded.
 *
 * The first-ever tap blocks for about a minute on the prompt (measured in the
 * T206 spike), so this must never be left to the first call. A denied grant
 * cannot be read back — it just records silence — so the result is only ever
 * "asked", and the helper's `silent-tap` warning covers a refusal later.
 */
function requestCallAudioAccess() {
  const binary = getCallBinaryPath();
  if (!fs.existsSync(binary)) {
    console.warn('Call audio: helper not built — cannot request System Audio Recording');
    return;
  }
  const proc = childSpawn(binary, ['--request-access'], { stdio: ['ignore', 'pipe', 'pipe'] });
  registerProcess(proc);
  const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 180000);
  proc.stdout.on('data', (chunk) => console.log(`[call-audio-tap] ${chunk.toString().trim()}`));
  proc.on('error', (err) => console.warn(`Call audio access request failed: ${err.message}`));
  proc.on('exit', () => clearTimeout(timer));
}

/**
 * Resolve path to the calendar-helper binary. Delegates to the Electron-free
 * shared resolver so the MCP server and the app agree on path logic. Passes
 * `process.resourcesPath` only when packaged (authoritative); a dev build keeps
 * using its freshly-rebuilt local helper.
 */
function getCalendarHelperPath() {
  return resolveCalendarHelperPath({
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    repoRoot: __dirname
  });
}

// buildAgendaFromNotes / attendeeDisplayName / buildPreRecordSeedFromEvent now
// live in services/meetingTemplate.js (shared with the MCP server). Imported at
// the top of this file.

/**
 * ============================================
 * Opening notes: Obsidian where it can, a plain editor where it can't
 * ============================================
 */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);

/**
 * Is this file inside the configured vault?
 *
 * The comparison itself lives in `services/vaultLocator.js` (pure, injectable
 * fs) so it can be tested against a real symlinked folder; this only supplies
 * the resolved vault directory, which may legitimately be null (invariant #17).
 */
function isInsideVault(filePath) {
  return vaultIsInside(getVaultDirectory(), filePath);
}

/**
 * Open a file the way it deserves.
 *
 * - **Markdown inside the vault** → Obsidian, addressed by `obsidian://open`
 *   with an absolute path. Using the URI rather than the system default means
 *   this keeps working whichever app owns `.md` system-wide.
 * - **Markdown outside the vault** (a session's raw `notes.md`, a merged
 *   transcript) → a plain text editor. Obsidian can only open files that live
 *   in a vault; handed a loose note it offers to create a vault inside the
 *   recordings folder, which is never what anyone wants.
 * - **Anything else** (`.wav`, `.csv`) → the system default, unchanged.
 *
 * @param {string} filePath
 * @returns {Promise<{success: boolean, via?: string, error?: string}>}
 */
async function openArtefact(filePath) {
  if (!filePath) return { success: false, error: 'No path given' };

  const isMarkdown = MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  if (!isMarkdown) {
    const err = await shell.openPath(filePath);
    return err ? { success: false, error: err } : { success: true, via: 'system' };
  }

  if (isInsideVault(filePath)) {
    try {
      await shell.openExternal(`obsidian://open?path=${encodeURIComponent(filePath)}`);
      return { success: true, via: 'obsidian' };
    } catch (err) {
      console.warn(`Obsidian URI failed, falling back to the system handler: ${err.message}`);
      const fallbackErr = await shell.openPath(filePath);
      return fallbackErr
        ? { success: false, error: fallbackErr }
        : { success: true, via: 'system' };
    }
  }

  return openInPlainEditor(filePath);
}

/**
 * Open a loose markdown file in the configured plain editor. Falls back to the
 * system default if that app is missing, so this can never be a dead end.
 */
function openInPlainEditor(filePath) {
  const editor = store.get('plainTextEditor') || 'TextEdit';

  return new Promise((resolve) => {
    const proc = childSpawn('/usr/bin/open', ['-a', editor, filePath], { stdio: 'ignore' });
    registerProcess(proc);

    proc.on('error', async () => {
      const err = await shell.openPath(filePath);
      resolve(err ? { success: false, error: err } : { success: true, via: 'system' });
    });

    proc.on('exit', async (code) => {
      if (code === 0) {
        resolve({ success: true, via: `editor:${editor}` });
        return;
      }
      console.warn(`"${editor}" could not open ${filePath} (exit ${code}) — using the system handler`);
      const err = await shell.openPath(filePath);
      resolve(err ? { success: false, error: err } : { success: true, via: 'system' });
    });
  });
}

/**
 * Track a child process so quitting cannot leave it orphaned.
 */
function registerProcess(proc) {
  return childProcesses.register(proc);
}

/**
 * Probe the host for everything recording and processing need.
 */
function checkDependencies() {
  console.log('\n=== Checking Dependencies ===');

  const status = {
    sox: false,
    parakeet: false,
    whisper: false,
    transcription: false,
    codex: false,
    mic: false,
    lastChecked: Date.now()
  };

  // Check sox. NOT `which sox` — a Dock-launched app has no Homebrew on its
  // PATH, so that reports "missing" on every Mac except the one that built the
  // app (see utils/binaries.js).
  console.log('Checking sox...');
  const soxPath = resolveBinaryCached('sox');
  if (soxPath) {
    console.log(`sox found at: ${soxPath}`);
    status.sox = true;
  } else {
    console.log('sox not found (searched PATH, Homebrew and /usr/local/bin)');
  }

  // Check Parakeet — the DEFAULT transcriber (services/transcriber.js runs it
  // via uvx; whisper.cpp is only the automatic fallback). Counting whisper
  // alone made every Parakeet-only machine look broken: transcription worked
  // fine, yet first launch greeted the user with a "Setup Required" dialog.
  console.log('\nChecking Parakeet (uv)...');
  const uvPath = findUv();
  status.parakeet = Boolean(uvPath);
  console.log(uvPath
    ? `uvx found at: ${uvPath}`
    : 'uvx not found — Parakeet unavailable, whisper.cpp would be the only transcriber');

  // Check whisper.cpp (the fallback backend)
  console.log('\nChecking whisper.cpp...');
  try {
    const whisperCheck = verifyWhisper();
    status.whisper = whisperCheck.installed;

    if (whisperCheck.installed) {
      console.log(`whisper binary found at: ${whisperCheck.binaryPath}`);
      console.log(`whisper model found at: ${whisperCheck.modelPath}`);
    } else {
      console.log(`whisper.cpp not found: ${whisperCheck.error}`);
    }
  } catch (err) {
    console.log('whisper.cpp check failed:', err.message);
    status.whisper = false;
  }

  // Either backend present means transcription works.
  status.transcription = status.parakeet || status.whisper;

  // Check system audio capture (ScreenCaptureKit — the only route)
  console.log('\nChecking system audio capture...');
  const sckStatus = checkSckAvailable(getSckBinaryPath());

  const audio = resolveSystemAudio({
    sckAvailable: sckStatus.available,
    sckPermitted: sckStatus.permitted
  });
  status.systemAudio = audio.ok;
  console.log(`System audio: ${audio.reason}`);

  // Check microphone availability
  console.log('\nChecking microphone...');
  const mode = store.get('recordingMode');
  const configuredDevice = mode === 'dual' ? store.get('micDevice') : null;
  const mic = resolveMicrophone({
    mode,
    configuredDevice,
    deviceVerifies: configuredDevice ? verifyInputDevice(configuredDevice) : false,
    defaultDevice: mode === 'dual' && !configuredDevice ? findDefaultMicrophone() : null
  });
  status.mic = mic.ok;
  console.log(mic.detail);

  // Check AI summarisation (Codex or Claude CLI)
  console.log('\nChecking AI summarisation...');
  const codexOk = isCodexAvailable();
  const claudeOk = isClaudeAvailable();
  status.codex = codexOk || claudeOk;
  const provider = codexOk ? 'Codex' : claudeOk ? 'Claude' : 'none';
  console.log(`AI summarisation: ${status.codex ? `available (${provider})` : 'not found'}`);

  console.log(`\n${summariseToConsole(status)}\n`);

  dependenciesStatus = status;
  return status;
}

/**
 * Surface a message through Notification Centre.
 */
function showNotification(title, body, isError = false) {
  if (Notification.isSupported()) {
    new Notification({
      title: title,
      body: body,
      silent: false
    }).show();
  } else if (isError) {
    dialog.showErrorBox(title, body);
  }
}

/**
 * Resolve the mic device name to use
 */
function resolveMicDevice() {
  const savedDevice = store.get('micDevice');
  if (savedDevice) {
    if (verifyInputDevice(savedDevice)) {
      return savedDevice;
    }
    console.warn(`Saved mic device "${savedDevice}" not available (disconnected?), falling back to default`);
  }

  const defaultMic = findDefaultMicrophone();
  if (defaultMic) {
    console.log(`Using default microphone: ${defaultMic.name}`);
    return defaultMic.name;
  }

  return null;
}

/**
 * Initialize recorder instances
 */
function initRecorder() {
  const outputDir = store.get('outputDirectory');
  ensureDirectoryStructure(outputDir);

  const sckBinaryPath = getSckBinaryPath();

  // Always create single-track recorder as fallback
  recorder = new Recorder(outputDir, sckBinaryPath);
  console.log(`Recorder ready, writing to ${outputDir}`);

  // Create dual-track recorder if mode is dual
  const mode = store.get('recordingMode');
  if (mode === 'dual') {
    const micDevice = resolveMicDevice();
    if (micDevice) {
      const systemLabel = store.get('systemLabel');
      const micLabel = store.get('micLabel');
      const meetingContext = store.get('meetingContext') || {};
      const slides = createSlideCapture();
      dualRecorder = new DualTrackRecorder(
        outputDir, micDevice, systemLabel, micLabel, sckBinaryPath, meetingContext,
        slides.session, slides.options, createCallCapture()
      );
      console.log(`DualTrackRecorder initialized with mic: ${micDevice}`);
    } else {
      console.warn('No mic device available - dual mode will fall back to system-only');
      dualRecorder = null;
    }
  } else {
    dualRecorder = null;
  }
}

/**
 * Put the status item in the menu bar and wire its clicks.
 */
function createTray() {
  // Pencil glyph (SF Symbol render, black + alpha, 18px with an @2x sibling).
  // Template mode lets macOS tint it for light/dark menu bars + highlight state.
  const iconPath = path.join(__dirname, 'assets', 'trayIconTemplate.png');
  trayIcon = nativeImage.createFromPath(iconPath);
  trayIcon.setTemplateImage(true);

  tray = new Tray(trayIcon);
  tray.setToolTip('CXNotes');

  // Left-click opens the menu-bar panel; right-click keeps the classic context
  // menu (every existing tray action still lives there). setContextMenu() is
  // deliberately NOT used — it would swallow the left-click.
  tray.on('click', () => toggleMenubarPanel());
  tray.on('right-click', () => {
    closeMenubarPanel();
    if (trayContextMenu) tray.popUpContextMenu(trayContextMenu);
  });

  updateTrayMenu();
}

/**
 * ============================================
 * Menu-bar panel (tray-anchored popover)
 * ============================================
 *
 * A frameless, transparent window pinned under the tray icon. It is a VIEW:
 * it never owns recording state, it reads a snapshot and receives pushed
 * updates, and every action routes through the same guarded paths the tray and
 * settings window already use (`startRecordingWithContext`, `stopRecording`,
 * `startFromUpcoming`).
 */
const PANEL_WIDTH = 396;
const PANEL_DEFAULT_HEIGHT = 460;
const PANEL_MIN_HEIGHT = 200;
const PANEL_MAX_HEIGHT = 760;
const PANEL_PUSH_INTERVAL_MS = 250;

/**
 * Position the panel under the tray icon.
 *
 * `tray.getBounds()` is NOT trustworthy: with an auto-hidden menu bar (or
 * before the item has been placed) macOS hands back an off-screen origin —
 * observed as x = -9294 on a single-display Mac. Anchoring to that puts the
 * panel in a corner of the desktop with nothing above it. So the bounds are
 * validated against the actual displays first, and anything that does not land
 * on a real screen falls back to the top-right of the active display, where
 * menu-bar extras live. Both axes are then clamped into the work area, so a
 * tall panel is pushed up rather than run off the bottom.
 */
function panelAnchorFor(width, height) {
  const displays = screen.getAllDisplays();
  const bounds = tray ? tray.getBounds() : null;

  const centre = bounds && bounds.width > 0
    ? { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
    : null;

  const hostDisplay = centre && displays.find((d) =>
    centre.x >= d.bounds.x && centre.x < d.bounds.x + d.bounds.width &&
    centre.y >= d.bounds.y && centre.y < d.bounds.y + d.bounds.height
  );

  const display = hostDisplay || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const work = display.workArea;

  let x;
  let y;
  if (hostDisplay) {
    x = Math.round(bounds.x + bounds.width / 2 - width / 2);
    y = Math.round(bounds.y + bounds.height);
  } else {
    x = work.x + work.width - width - 8;
    y = work.y;
  }

  const maxX = Math.max(work.x + 4, work.x + work.width - width - 4);
  const maxY = Math.max(work.y, work.y + work.height - height - 4);
  return {
    x: Math.max(work.x + 4, Math.min(x, maxX)),
    y: Math.max(work.y, Math.min(y, maxY))
  };
}

function positionMenubarPanel(win) {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getBounds();
  const { x, y } = panelAnchorFor(width, height);
  win.setBounds({ x, y, width, height });
}

function createMenubarPanel() {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_DEFAULT_HEIGHT,
    frame: false,
    transparent: true,
    ...GLASS.popover,
    // The window IS the popover now. It used to be a rectangle with the card
    // drawn 8px inside it, so the card could own its radius and shadow — but
    // the vibrancy material fills the window's whole rect, so that margin would
    // frame the card in a blurred slab. macOS rounds and shadows the window
    // itself instead, and clips the material to those corners.
    roundedCorners: true,
    hasShadow: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-menubar-panel.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'menubar-panel.html'));
  attachGlass(win);
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Click-away dismissal, the macOS popover convention.
  // The note context menu is drawn INSIDE this window now, so it cannot take
  // focus away and there is nothing left to suppress here — a blur really does
  // mean the user looked elsewhere.
  win.on('blur', () => {
    closeMenubarPanel();
  });
  win.on('closed', () => {
    if (menubarPanelWindow === win) menubarPanelWindow = null;
  });

  return win;
}

function showMenubarPanel() {
  if (!menubarPanelWindow || menubarPanelWindow.isDestroyed()) {
    menubarPanelWindow = createMenubarPanel();
    menubarPanelWindow.once('ready-to-show', () => {
      if (menubarPanelWindow && !menubarPanelWindow.isDestroyed()) {
        positionMenubarPanel(menubarPanelWindow);
        menubarPanelWindow.show();
        menubarPanelWindow.focus();
      }
    });
    return;
  }

  positionMenubarPanel(menubarPanelWindow);
  menubarPanelWindow.show();
  menubarPanelWindow.focus();
  pushPanelState();
}

function closeMenubarPanel() {
  if (menubarPanelWindow && !menubarPanelWindow.isDestroyed()) {
    menubarPanelWindow.close();
    panelClosedAt = Date.now();
  }
  menubarPanelWindow = null;
}

/**
 * Clicking the tray while the panel is open fires 'blur' FIRST (which closes
 * it), so by the time the click handler runs there is no window left and a
 * naive toggle would immediately re-open — the panel would never close by
 * clicking the icon. Ignoring a toggle that lands right after a close makes
 * the second click behave the way every other status item does.
 */
const PANEL_REOPEN_GUARD_MS = 350;

function toggleMenubarPanel() {
  if (menubarPanelWindow && !menubarPanelWindow.isDestroyed() && menubarPanelWindow.isVisible()) {
    closeMenubarPanel();
    return;
  }
  if (Date.now() - panelClosedAt < PANEL_REOPEN_GUARD_MS) return;
  showMenubarPanel();
}

function isPanelOpen() {
  return !!(menubarPanelWindow && !menubarPanelWindow.isDestroyed() && menubarPanelWindow.isVisible());
}

/**
 * Push a fresh snapshot into an open panel. Throttled — the level monitor polls
 * every 150ms and the panel only needs ~4 updates a second to look live.
 */
function pushPanelState({ throttle = false } = {}) {
  if (!isPanelOpen()) return;
  if (throttle) {
    if (panelPushTimer) return;
    panelPushTimer = setTimeout(() => {
      panelPushTimer = null;
      if (isPanelOpen()) menubarPanelWindow.webContents.send('panel:state', buildPanelState());
    }, PANEL_PUSH_INTERVAL_MS);
    return;
  }
  menubarPanelWindow.webContents.send('panel:state', buildPanelState());
}

/**
 * The panel's entire data contract, assembled from live main-process state.
 * Everything here is real — there is no placeholder content in the panel.
 */
function buildPanelState() {
  const mode = store.get('recordingMode');
  const useDual = mode === 'dual' && dualRecorder;
  const activeRecorder = useDual && dualRecorder.isRecording ? dualRecorder : recorder;
  const isRecording = !!(activeRecorder && activeRecorder.isRecording);

  const state = {
    mode: useDual ? 'dual' : 'system',
    deps: dependenciesStatus,
    calendarSource: store.get('calendarSource') || 'auto',
    recording: null,
    upcoming: [],
    recentNotes: [],
    markers: activeMarkers
  };

  if (isRecording) {
    const status = activeRecorder.getStatus();
    const ctx = store.get('meetingContext') || {};
    const recordingIsDual = activeRecorder === dualRecorder;

    const tracks = [];
    // `health` is about whether the FILE is growing; `signal` is about whether
    // what it contains is audio. They are independent, and the pair that lost
    // three meetings is health:'live' with signal:'silent' — a file growing
    // perfectly, full of zeroes.
    if (recordingIsDual) {
      tracks.push({
        id: 'system',
        label: store.get('systemLabel') || 'Remote',
        level: latestLevels.system || 0,
        health: latestTrackHealth.system || 'live',
        signal: systemSignalDead ? 'silent' : 'ok'
      });
      tracks.push({
        id: 'mic',
        label: store.get('micLabel') || 'Me',
        level: latestLevels.mic || 0,
        health: latestTrackHealth.mic || 'live',
        signal: 'ok'
      });
    } else {
      tracks.push({
        id: 'system',
        label: store.get('systemLabel') || 'System',
        level: latestLevels.system || 0,
        health: latestTrackHealth.system || 'live',
        signal: systemSignalDead ? 'silent' : 'ok'
      });
    }

    state.recording = {
      active: true,
      mode: recordingIsDual ? 'dual' : 'system',
      durationMs: status.duration,
      title: ctx.title || '',
      participants: ctx.participants || '',
      tracks,
      systemSignalDead,
      // What the probe knows, kept separate from what the watcher inferred.
      // 'probing' while the first verdict is still being reached, then the
      // verdict itself — so the panel can say "verified" rather than only ever
      // being able to report trouble.
      capture: captureVerification
        ? { verdict: captureVerification.verdict, confidence: captureVerification.confidence || null }
        : null,
      silence: {
        enabled: !!store.get('silenceAutoStopEnabled'),
        minutes: clampSilenceMinutes(store.get('silenceAutoStopMinutes')),
        prompting: !!(silencePromptWindow && !silencePromptWindow.isDestroyed())
      }
    };
  } else {
    state.upcoming = buildPanelUpcoming();
    state.recentNotes = buildPanelRecentNotes();
  }

  return state;
}

/**
 * Map the suggester's cached events into the panel's shape. Same list the tray
 * "Upcoming on your calendar" menu renders, so the two can never disagree.
 */
function buildPanelUpcoming() {
  return cachedUpcomingMeetings.slice(0, 4).map((ev) => {
    const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
    // The FULL list, not a slice. Truncation is the panel's decision now
    // (renderer/panelPresenters.js) — cutting it here silently showed three
    // names as if they were everyone, and left the panel unable to say how
    // many it was hiding or to expand the rest.
    const names = attendees
      .map((a) => (a && (a.name || a.email)) || '')
      .filter(Boolean);
    const who = names.length ? names.join(', ') : (ev.organizerName || '');
    const agendaCount = ev.notes
      ? ev.notes.split('\n').filter((line) => line.trim()).length
      : 0;

    return {
      fingerprint: ev.occurrenceFingerprint || '',
      title: ev.title || 'Untitled meeting',
      startTime: ev.startTime,
      who,
      sourceLabel: ev.source === 'detected' ? 'found in email' : (ev.source === 'ics' ? 'invite' : ''),
      hasTemplate: !!store.get('calendarAutoTemplateEnabled'),
      agendaCount: Math.min(agendaCount, 9)
    };
  });
}

/**
 * The last few exported notes, read from session manifests. `vaultFiling`
 * (written by fileAndExportNotes) tells us where each note landed and whether
 * it is still sitting in Inbox waiting to be triaged.
 */
const PANEL_RECENT_NOTES_LIMIT = 4;

/**
 * Only notes smaller than this are even checked for a provider failure
 * notice — see detectPoisonedNote.
 */
const POISONED_NOTE_MAX_BYTES = 2048;

function buildPanelRecentNotes() {
  try {
    const recordingsDir = path.join(store.get('outputDirectory'), 'recordings');
    if (!fs.existsSync(recordingsDir)) return [];

    const sessions = fs.readdirSync(recordingsDir)
      .filter((entry) => entry.endsWith('_session'))
      .sort()
      .reverse()
      .slice(0, 12);

    const notes = [];
    for (const entry of sessions) {
      if (notes.length >= PANEL_RECENT_NOTES_LIMIT) break;
      try {
        const manifestPath = path.join(recordingsDir, entry, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const exported = manifest.processing && manifest.processing.obsidianExport;
        if (!exported) continue;

        const filing = (manifest.processing && manifest.processing.vaultFiling) || null;
        const destination = filing && filing.destination ? filing.destination : 'vault root';

        const summarisation = manifest.processing && manifest.processing.summarisation;
        const sessionDir = path.join(recordingsDir, entry);
        const summaryFailed = summarisation ? detectPoisonedNote(summarisation) : null;

        notes.push({
          title: (manifest.meetingContext && manifest.meetingContext.title)
            || path.basename(exported, '.md'),
          path: exported,
          // The panel offers re-summarise, which needs the session, not the note.
          sessionDir,
          destination,
          needsTriage: !!(filing && filing.method === 'inbox'),
          summaryFailed,
          // Only offer Retry when the cheap path can actually run — a dead
          // button that always errors is worse than no button.
          canResummarise: !!summaryFailed && !!reusableTranscriptFor(sessionDir),
          when: formatRelativeDay(manifest.startTime)
        });
      } catch {
        // A single unreadable manifest must not blank the whole list.
      }
    }
    return notes;
  } catch (err) {
    console.warn('Panel recent-notes lookup failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * "2h ago" / "yesterday" / "Mon" — compact recency for the panel.
 */
function formatRelativeDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/**
 * ============================================
 * Live markers
 * ============================================
 *
 * A marker timestamps "this mattered" without leaving the call. They persist to
 * <sessionDir>/markers.json as they are dropped (a crash keeps them), get
 * folded into the manifest at stop, and are handed to the summariser as anchor
 * points. Pure logic lives in services/markers.js.
 */

/**
 * The session directory of the CURRENT recording, or null in system-only mode
 * (a flat .wav has nowhere to put a sidecar — same gate as the skeleton,
 * invariant #13).
 */
function activeSessionDir() {
  return dualRecorder && dualRecorder.isRecording ? dualRecorder.sessionDir : null;
}

/**
 * Drop a marker on the running recording.
 *
 * @param {string} [label]
 * @returns {{ok: boolean, reason?: string, marker?: object, markers?: Array}}
 */
function dropMarker(label) {
  if (!isRecordingActive()) {
    return { ok: false, reason: 'not-recording' };
  }

  const activeRecorder = dualRecorder && dualRecorder.isRecording ? dualRecorder : recorder;
  const marker = createMarker(label, { startTime: activeRecorder.startTime });
  activeMarkers = addMarker(activeMarkers, marker);

  // Best-effort persistence — a failed write must never interrupt capture.
  const sessionDir = activeSessionDir();
  if (sessionDir) {
    writeMarkers(sessionDir, activeMarkers);
  }

  console.log(`Marker dropped at ${marker.offset}: ${marker.label}`);
  pushPanelState();
  return { ok: true, marker, markers: activeMarkers };
}

/**
 * Register the global "drop a marker" shortcut for the duration of a recording.
 * Registration can fail when another app owns the combination — that is a
 * degraded feature, never a failed recording, so it only warns.
 */
const MARKER_SHORTCUT = 'CommandOrControl+Shift+M';

function registerMarkerShortcut() {
  try {
    if (globalShortcut.isRegistered(MARKER_SHORTCUT)) return;
    const ok = globalShortcut.register(MARKER_SHORTCUT, () => {
      const result = dropMarker();
      if (result.ok) {
        showNotification('Marker dropped', `${result.marker.offset} — flagged for the summary`);
      }
    });
    if (!ok) console.warn(`Could not register ${MARKER_SHORTCUT} (in use by another app)`);
  } catch (err) {
    console.warn('Marker shortcut registration failed (non-fatal):', err.message);
  }
}

function unregisterMarkerShortcut() {
  try {
    globalShortcut.unregister(MARKER_SHORTCUT);
  } catch {
    // Nothing to do — the shortcut simply was not held.
  }
}

/**
 * Focus the settings window, opening it first if it is not already up.
 */
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 940,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    title: 'CXNotes',
    titleBarStyle: 'hiddenInset',
    hasShadow: true,
    // Fully transparent, NOT the old '#1c1a17'. An opaque backgroundColor paints
    // straight over the visual-effect view, so the blur would be present,
    // correctly configured, and completely invisible. The warm charcoal moved
    // into the panes, where it composites through --alpha-* instead.
    backgroundColor: '#00000000',
    ...GLASS.window,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    },
    show: false
  });

  settingsWindow.webContents.session.clearCache();
  settingsWindow.loadFile('renderer/index.html');
  attachGlass(settingsWindow);

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

/**
 * Rebuild the tray menu for the current state.
 */
/**
 * Reveal one of the output subdirectories, creating the structure first so the
 * Finder never opens on a path that does not exist yet.
 */
function openOutputSubdirectory(name) {
  const outputDir = store.get('outputDirectory');
  ensureDirectoryStructure(outputDir);
  shell.openPath(path.join(outputDir, name));
}

function updateTrayMenu() {
  const mode = store.get('recordingMode');
  const isDualMode = mode === 'dual' && Boolean(dualRecorder);
  const activeRecorder = isDualMode ? dualRecorder : recorder;
  const isRecording = Boolean(activeRecorder && activeRecorder.isRecording);
  const status = activeRecorder ? activeRecorder.getStatus() : null;

  const menuTemplate = buildTrayMenuTemplate(
    {
      isRecording,
      isDualMode,
      canRecord: dependenciesStatus.systemAudio,
      durationMs: status ? status.duration : 0,
      // Hidden while recording by the builder, so the cache can be passed
      // unconditionally.
      upcoming: cachedUpcomingMeetings,
      nowMs: Date.now(),
      markerAccelerator: MARKER_SHORTCUT
    },
    {
      startRecording: handleStartRecording,
      stopRecording: handleStopRecording,
      dropMarker: () => dropMarker(),
      startFromUpcoming: (meeting) => startFromUpcoming(meeting),
      showPanel: () => showMenubarPanel(),
      openSettings: openSettingsWindow,
      openRecordingsFolder: () => openOutputSubdirectory('recordings'),
      openProcessedFolder: () => openOutputSubdirectory('processed'),
      refreshDependencies: () => {
        checkDependencies();
        setTimeout(() => {
          showNotification('Dependency check finished', 'Details are in the console.');
        }, 500);
      },
      showDependencyStatus,
      runSetupScript,
      showStorageStats,
      runCleanup,
      quit: () => app.quit()
    }
  );

  trayContextMenu = Menu.buildFromTemplate(menuTemplate);

  // Keep the menu-bar title in step with the recording state (the live timer).
  updateTrayTitle(isRecording ? status : null);

  // A tray refresh means recording state may have changed — the panel mirrors it.
  pushPanelState({ throttle: true });
}

/**
 * The menu-bar title beside the tray icon.
 *
 * Idle: empty (just the glyph). Recording: `⏺ 24:36` plus the per-track level
 * blocks, so the elapsed time is readable at a glance without opening anything
 * and the level bars still expose a dead track (gotchas #5/#6) in place.
 *
 * @param {object|null} status - recorder getStatus() while recording, else null
 */
function updateTrayTitle(status) {
  if (!tray) return;
  if (!status) {
    tray.setTitle('');
    return;
  }

  const elapsed = formatDuration(status.duration);

  // A dead system capture replaces the whole title rather than decorating it.
  // The level blocks were already there during all three lost meetings and none
  // of them were noticed — a bar sitting at zero looks like a quiet moment. Text
  // that says what is wrong cannot be read as a quiet moment.
  if (systemSignalDead) {
    tray.setTitle(`⚠️ NO SYSTEM AUDIO · ${elapsed}`);
    return;
  }

  const sysBar = levelToBar(latestLevels.system || 0);
  const isDualRecording = !!(dualRecorder && dualRecorder.isRecording);
  const bars = isDualRecording ? `${sysBar}${levelToBar(latestLevels.mic || 0)}` : sysBar;

  tray.setTitle(`⏺ ${elapsed} ${bars}`);
}


/**
 * Start a recording from a tray "Upcoming" click. The menu-bar analog of the
 * 1-click confirm banner (ipcMain 'meeting:confirmRecord'): build the rich
 * context, record the dismissal through the SAME registry (invariant #8) so the
 * pre-meeting banner won't re-fire for this occurrence, best-effort claim any
 * MCP-prepared meeting, then start with the title/attendees/agenda prefilled.
 */
function startFromUpcoming(ev) {
  if (!ev || isRecordingActive()) return;

  const richCtx = buildMeetingContext(ev);
  if (!richCtx) return;

  // Same single dismissal registry (invariant #8) so this occurrence won't
  // re-fire a banner the moment the call app is detected.
  recordDismissal({ fingerprint: ev.occurrenceFingerprint, calendarEvent: ev });

  // Claim any meeting the MCP server pre-staged for this occurrence (best-effort;
  // absence is fine — the in-app path works with no prepared file).
  if (preparedMeetingStore && richCtx.occurrenceFingerprint) {
    const claimed = preparedMeetingStore.claim(richCtx.occurrenceFingerprint);
    if (claimed.ok) {
      console.log(`Claimed prepared meeting: ${richCtx.occurrenceFingerprint}`);
    }
  }

  // Drop the menu list so it can't show stale items mid-record; it repopulates
  // on the next poll after the recording stops.
  cachedUpcomingMeetings = [];
  closeMeetingBanner(false);
  startRecordingWithContext(richCtx, 'calendar-upcoming');
}

/**
 * Begin a recording from the tray.
 */
function handleStartRecording() {
  showPreRecordPopup();
}

/**
 * Show pre-record popup for meeting context, then start recording
 */
function showPreRecordPopup() {
  if (preRecordWindow && !preRecordWindow.isDestroyed()) {
    preRecordWindow.focus();
    return;
  }

  preRecordWindow = new BrowserWindow({
    width: 460,
    height: 470,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#00000000', // see the settings window — opaque hides the material
    ...GLASS.window,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-prerecord.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  preRecordWindow.loadFile(path.join(__dirname, 'renderer', 'pre-record.html'));
  attachGlass(preRecordWindow);
  preRecordWindow.once('ready-to-show', () => {
    preRecordWindow.show();
    preRecordWindow.focus();
  });
  preRecordWindow.on('closed', () => { preRecordWindow = null; });
}

/**
 * Show the meeting-detection banner near the top of the primary display.
 * Auto-dismisses after MEETING_BANNER_AUTO_HIDE_MS, or on user action.
 */
const MEETING_BANNER_WIDTH = 460;
const MEETING_BANNER_HEIGHT = 84;
// Give the pre-meeting prompt a real window to catch it — 4 min (was 30s). With
// the default 2-min lead time it now lives from ~2 min before start to ~2 min
// after, rather than vanishing before you look up. If it still times out, the
// tray "Upcoming on your calendar" menu keeps the meeting one click away until
// it ends (that list is not gated on the banner's dismissal).
const MEETING_BANNER_AUTO_HIDE_MS = 4 * 60 * 1000;

function createMeetingBanner(detection) {
  // If a banner is already up for a different meeting, replace it
  if (meetingBannerWindow && !meetingBannerWindow.isDestroyed()) {
    meetingBannerWindow.close();
  }

  currentDetection = detection;

  const display = screen.getPrimaryDisplay();
  const { x: workX, y: workY, width: workWidth } = display.workArea;
  const x = Math.round(workX + (workWidth - MEETING_BANNER_WIDTH) / 2);
  const y = workY + 8;

  meetingBannerWindow = new BrowserWindow({
    width: MEETING_BANNER_WIDTH,
    height: MEETING_BANNER_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    ...GLASS.popover,
    roundedCorners: true,
    hasShadow: true,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-meeting-banner.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  meetingBannerWindow.loadFile(path.join(__dirname, 'renderer', 'meeting-banner.html'));
  attachGlass(meetingBannerWindow);
  meetingBannerWindow.setAlwaysOnTop(true, 'floating');

  meetingBannerWindow.once('ready-to-show', () => {
    if (meetingBannerWindow && !meetingBannerWindow.isDestroyed()) {
      meetingBannerWindow.show();
    }
  });

  meetingBannerWindow.on('closed', () => {
    meetingBannerWindow = null;
    if (meetingBannerTimer) {
      clearTimeout(meetingBannerTimer);
      meetingBannerTimer = null;
    }
  });

  // Auto-hide after MEETING_BANNER_AUTO_HIDE_MS unless the user acts sooner
  meetingBannerTimer = setTimeout(() => {
    meetingBannerTimer = null;
    if (meetingBannerWindow && !meetingBannerWindow.isDestroyed()) {
      // Auto-dismissed: mark the fingerprint as seen so we don't re-prompt for the same meeting
      recordDismissal(currentDetection);
      meetingBannerWindow.close();
    }
  }, MEETING_BANNER_AUTO_HIDE_MS);
}

function recordDismissal(detection) {
  if (!detection || !dismissalRegistry) return;
  const fp = detection.fingerprint;
  if (!fp) return;
  if (detection.calendarEvent && detection.calendarEvent.endTime) {
    dismissalRegistry.dismiss(fp, { kind: 'calendar', expiry: detection.calendarEvent.endTime });
  } else {
    dismissalRegistry.dismiss(fp, { kind: 'app' });
  }
}

function closeMeetingBanner(dismiss) {
  if (meetingBannerTimer) {
    clearTimeout(meetingBannerTimer);
    meetingBannerTimer = null;
  }
  if (dismiss) {
    recordDismissal(currentDetection);
  }
  if (meetingBannerWindow && !meetingBannerWindow.isDestroyed()) {
    meetingBannerWindow.close();
  }
}

/**
 * Is any recording currently active?
 */
function isRecordingActive() {
  return (recorder && recorder.isRecording) || (dualRecorder && dualRecorder.isRecording);
}

/**
 * Start the meeting detector if the user has it enabled and no recording is in progress.
 * Called from app ready, after recording stops, and on settings toggle.
 */
function startMeetingDetectorIfEnabled() {
  if (!store.get('meetingDetectionEnabled')) return;
  if (isRecordingActive()) return;
  if (!meetingDetector) return;
  meetingDetector.start();
}

/**
 * Start the calendar suggester if the user has it enabled and no recording
 * is in progress. Mirrors startMeetingDetectorIfEnabled().
 */
function startCalendarSuggesterIfEnabled() {
  if (!store.get('calendarSuggestionsEnabled')) return;
  if (isRecordingActive()) return;
  if (!calendarSuggester) return;
  calendarSuggester.start();
}

/**
 * Decide which banner UX to show for a (possibly enriched) detection.
 *   'confirm' — a calendar event is present AND the user opted into
 *               auto-templating: a 1-click "Record [Title]?" button that starts
 *               recording immediately with the templated context (zero typing).
 *   'suggest' — today's flow, fully preserved: a "Take notes" button that opens
 *               the pre-record popup for the user to confirm/edit fields.
 * Never auto-starts without a calendar event or without the opt-in.
 */
function decideBannerMode(calendarEvent) {
  return (calendarEvent && store.get('calendarAutoTemplateEnabled')) ? 'confirm' : 'suggest';
}

/**
 * Initialize the meeting detector and calendar suggester. Called once during
 * app ready. The detector gets an enricher callback that reads the
 * suggester's cached "current" event with an on-demand refresh fallback.
 */
function initMeetingAndCalendar() {
  dismissalRegistry = new DismissalRegistry({ store });

  // The read/claim side of the cross-process handoff. The standalone MCP server
  // stages prepared meetings into the same directory (shared/paths.js); the app
  // only ever reads + claims (never writes), so the two can't clobber each other.
  preparedMeetingStore = new PreparedMeetingStore();

  // Always construct the suggester so settings:update can start/stop it later
  // even if the feature was off at boot. The source itself is cheap to hold
  // (no background work until `start()`); permission isn't checked until the
  // first helper invocation.
  const calendarSource = createCalendarSource(store, {
    helperPath: getCalendarHelperPath(),
    spawn: childSpawn,
    registerProcess
  });

  calendarSuggester = new CalendarSuggester({
    store,
    source: calendarSource,
    dismissalRegistry,
    onSuggestion: (suggestion) => {
      if (isRecordingActive()) return;
      console.log(`Calendar suggestion: ${suggestion.event.title} (${suggestion.fingerprint})`);
      createMeetingBanner({
        app: 'calendar',
        displayName: suggestion.event.title || 'Upcoming meeting',
        fingerprint: suggestion.fingerprint,
        calendarEvent: suggestion.event,
        bannerMode: decideBannerMode(suggestion.event)
      });
    },
    // The tray "Upcoming on your calendar" section is fed by the same poll.
    // Ignore updates mid-recording (the section is hidden then anyway).
    onUpcoming: (list) => {
      if (isRecordingActive()) return;
      cachedUpcomingMeetings = Array.isArray(list) ? list : [];
      updateTrayMenu();
      // An open panel shows the same list — refresh it in place.
      pushPanelState({ throttle: true });
    }
  });

  // Meeting detector enricher: cache-first read with on-demand fallback.
  // Returns the calendar event for the meeting currently in progress, or null.
  const enricher = async () => {
    if (!calendarSuggester) return null;
    const cached = calendarSuggester.getCurrentMeetingEventSync();
    if (cached) return cached;
    return calendarSuggester.refreshCurrentEvent();
  };

  meetingDetector = new MeetingDetector({ dismissalRegistry, enricher });
  meetingDetector.onMeetingDetected((detection) => {
    // Defensive: if a recording started between polls, don't show the banner
    if (isRecordingActive()) return;
    console.log(`Meeting detected: ${detection.displayName} (${detection.fingerprint})`);
    detection.bannerMode = decideBannerMode(detection.calendarEvent);
    createMeetingBanner(detection);
  });

  if (store.get('meetingDetectionEnabled')) {
    meetingDetector.start();
  }
  startCalendarSuggesterIfEnabled();
}

/**
 * Write the structured note skeleton beside a dual-track session. The human
 * jots live notes into `meeting-skeleton.md`; the AI summary still lands in
 * `notes.md` (they never collide). Non-fatal: a skeleton-write failure must
 * never abort a recording that has already started.
 */
function writeMeetingSkeleton(sessionDir, meetingContext) {
  if (!sessionDir) return;
  try {
    const md = renderSkeletonMarkdown(meetingContext || {});
    const skeletonPath = path.join(sessionDir, 'meeting-skeleton.md');
    fs.writeFileSync(skeletonPath, md, 'utf-8');
    console.log(`Meeting skeleton written: ${skeletonPath}`);
  } catch (err) {
    console.warn(`Failed to write meeting skeleton (non-fatal): ${err.message}`);
  }
}

/**
 * Append the dropped markers to the human-facing skeleton note, under their own
 * heading. Idempotent: a reprocess replaces the existing block rather than
 * stacking a second copy. Non-fatal — the markers already reached the manifest.
 */
const SKELETON_MARKERS_HEADING = '## Flagged Moments';

function appendMarkersToSkeleton(sessionDir, markers) {
  if (!sessionDir || !markers || !markers.length) return;
  try {
    const skeletonPath = path.join(sessionDir, 'meeting-skeleton.md');
    if (!fs.existsSync(skeletonPath)) return;

    const existing = fs.readFileSync(skeletonPath, 'utf-8');
    const block = `${SKELETON_MARKERS_HEADING}\n\n${renderMarkersMarkdown(markers)}\n`;
    const headingIndex = existing.indexOf(SKELETON_MARKERS_HEADING);
    const next = headingIndex === -1
      ? `${existing.trimEnd()}\n\n${block}`
      : `${existing.slice(0, headingIndex)}${block}`;

    fs.writeFileSync(skeletonPath, next, 'utf-8');
  } catch (err) {
    console.warn(`Failed to add markers to skeleton (non-fatal): ${err.message}`);
  }
}

/**
 * Actually start the recording after context is collected. `meetingContext` may
 * be the bare flat {title, participants, agenda} (manual / pre-record popup) or
 * the rich superset from buildMeetingContext (1-click calendar confirm). Only
 * the flat subset is persisted to the store + manifest (invariant #2); the rich
 * context drives the skeleton render.
 */
function startRecordingWithContext(meetingContext, trigger = 'unspecified') {
  console.log(`[Recording] start requested: trigger=${trigger}, mode=${store.get('recordingMode')}, mic="${store.get('micDevice') || 'default'}", title="${(meetingContext && meetingContext.title) || ''}"`);
  // Persist only the flat subset for the recorder/summariser contract — the
  // manifest stays flat, the summariser is unchanged. Rich fields (attendees,
  // organiser, joinUrl) live in the skeleton, not the store.
  store.set('meetingContext', {
    title: (meetingContext && meetingContext.title) || '',
    participants: (meetingContext && meetingContext.participants) || '',
    agenda: (meetingContext && meetingContext.agenda) || ''
  });

  // Reinitialize recorder so it picks up the new context
  initRecorder();

  // Suspend meeting detection and calendar suggestions — no polling or banners during a recording
  if (meetingDetector) meetingDetector.stop();
  if (calendarSuggester) calendarSuggester.stop();
  cachedUpcomingMeetings = []; // no stale "Upcoming" items while recording
  closeMeetingBanner(false);

  const mode = store.get('recordingMode');
  const useDual = mode === 'dual' && dualRecorder;

  // Markers belong to one recording — never let the previous session's bleed in.
  activeMarkers = [];

  try {
    if (useDual) {
      // Dual-track mode.
      //
      // The recorder can restart its own system capture without being asked —
      // the helper now exits non-zero when its stream dies under it, and that is
      // handled inside the recorder. When it happens, the capture is writing to
      // a NEW file, so the level monitor has to follow it or the track reads as
      // permanently stalled for the rest of the meeting.
      dualRecorder.onSystemPartChange = retargetSystemTrack;

      const result = dualRecorder.start((warning) => {
        console.warn(warning);
      });
      console.log(`Dual recording started in: ${result.sessionDir}`);
      // Only dual-track mode has a session dir — write the skeleton there.
      writeMeetingSkeleton(result.sessionDir, meetingContext);
    } else {
      // System-only mode
      const result = recorder.start((warning) => {
        console.warn(warning);
      });
      currentRecordingPath = result.filepath;
      console.log(`Recording started: ${currentRecordingPath}`);
      // System-only mode returns a flat .wav with no session dir → no skeleton.
      console.log('System-only recording — skipping meeting skeleton (no session directory)');
    }

    statusUpdateInterval = setInterval(() => {
      const activeRecorder = useDual ? dualRecorder : recorder;
      if (!activeRecorder.isRecording) {
        clearInterval(statusUpdateInterval);
        statusUpdateInterval = null;
      } else {
        updateTrayMenu();
      }
    }, 1000);

    updateTrayMenu();

    // Start audio level monitoring
    startLevelMonitor(useDual);

    // Hold the global "drop a marker" shortcut only while recording, so the
    // combination is free for other apps the rest of the time.
    registerMarkerShortcut();
    pushPanelState();

    // Prove the capture is real before the meeting gets going.
    //
    // Deliberately not awaited: it waits several seconds for ScreenCaptureKit to
    // start delivering frames, and blocking the start on that would delay the
    // microphone — the one track that has never failed. The recording runs
    // normally throughout and the verdict lands a few seconds in, which is still
    // early enough to do something about it and vastly earlier than after the
    // meeting, which is when all four losses were found.
    verifyCaptureAtStart().catch((err) => {
      console.error('Capture verification failed to run:', err.message);
    });

    // Check for companion transcript provider
    let companionProvider = null;
    if (store.get('useSharedTranscript') !== false) {
      companionProvider = checkForProvider();
      if (companionProvider) {
        console.log(`[Companion] Detected provider: ${companionProvider.app}`);
      }
    }

    // Notify settings window that recording started
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('recording:update', {
        state: 'recording',
        mode: useDual ? 'dual' : 'system',
        startTime: Date.now()
      });
      if (companionProvider) {
        settingsWindow.webContents.send('companion-mode-status', {
          active: true,
          provider: companionProvider.app
        });
      }
    }

  } catch (err) {
    console.error('Recording did not start:', err);

    // Recording failed — resume meeting detection and calendar suggestions
    startMeetingDetectorIfEnabled();
    startCalendarSuggesterIfEnabled();

    const errorMessage = err.message.split('\n')[0];
    showNotification('Cannot Start Recording', errorMessage, true);

    if (err.message.includes('sox')) {
      setTimeout(() => {
        const response = dialog.showMessageBoxSync({
          type: 'error',
          title: 'Dependencies Missing',
          message: 'sox is missing',
          detail: 'Recording the microphone needs sox.\n\nRun the setup script now?',
          buttons: ['Run Setup', 'Install Manually', 'Cancel'],
          defaultId: 0
        });

        if (response === 0) {
          runSetupScript();
        } else if (response === 1) {
          // Homebrew's own formula page: the canonical place to get sox, and
          // it stays correct without us maintaining install instructions.
          shell.openExternal('https://formulae.brew.sh/formula/sox');
        }
      }, 100);
    }
  }
}

/**
 * The single, idempotent stop path.
 *
 * Every stop trigger — the tray menu, the `recording:stop` IPC, the silence
 * prompt's "Stop & save" button, and the grace-timer auto-stop — routes through
 * here. The in-flight guard makes a "user clicks Stop just as the grace timer
 * fires" race harmless: the second caller no-ops.
 *
 * @returns {Promise<object>} normalised result:
 *   - `{ success:false, skipped:true }`           — nothing to stop / already stopping
 *   - `{ success:true, mode:'dual', sessionDir, duration, systemSize, micSize }`
 *   - `{ success:true, mode:'system', filepath, duration, size }`
 *   - `{ success:false, error }`                  — stop threw
 */
async function stopRecording(reason = 'unspecified') {
  console.log(`[Recording] stop requested: reason=${reason}${stopInProgress ? ' (already stopping — ignored)' : ''}${!stopInProgress && !isRecordingActive() ? ' (nothing recording — ignored)' : ''}`);
  if (stopInProgress) {
    return { success: false, skipped: true };
  }
  if (!isRecordingActive()) {
    // Nothing to stop; still tear down any orphaned prompt/timer.
    closeSilencePrompt({ cancelTimer: true });
    return { success: false, skipped: true };
  }

  stopInProgress = true;

  const mode = store.get('recordingMode');
  const useDual = mode === 'dual' && dualRecorder && dualRecorder.isRecording;
  // Captured BEFORE the stop: dualRecorder.sessionDir survives, but reading it
  // after the await leaves the marker flush racing the recorder's own teardown.
  const markerSessionDir = useDual ? dualRecorder.sessionDir : null;

  try {
    // stopLevelMonitor() also tears down the silence watcher + any open prompt.
    stopLevelMonitor();
    unregisterMarkerShortcut();

    // Kick off the stop FIRST — both Recorder.stop() and DualTrackRecorder.stop()
    // flip isRecording=false synchronously before returning the promise. That
    // synchronous flip must happen before the resume calls, otherwise
    // isRecordingActive() is still true and they silently no-op (leaving
    // detection + suggestions off until the user toggles the setting).
    const stopPromise = useDual ? dualRecorder.stop() : recorder.stop();

    startMeetingDetectorIfEnabled();
    startCalendarSuggesterIfEnabled();

    // Clear interval and update tray immediately
    if (statusUpdateInterval) {
      clearInterval(statusUpdateInterval);
      statusUpdateInterval = null;
    }
    if (tray) tray.setToolTip('CXNotes');
    updateTrayMenu();

    // Flush markers to the session before processing reads the manifest.
    if (markerSessionDir && activeMarkers.length) {
      writeMarkers(markerSessionDir, activeMarkers);
      console.log(`Persisted ${activeMarkers.length} marker(s) to ${markerSessionDir}`);
    }

    // Notify settings window immediately
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('recording:update', { state: 'stopped' });
      settingsWindow.webContents.send('companion-mode-status', { active: false });
    }
    pushPanelState();

    // Now await the actual stop result for logging and auto-processing
    const result = await stopPromise;
    const autoProcess = store.get('autoProcess');

    if (useDual) {
      console.log(`Dual recording stopped: ${result.sessionDir}`);
      console.log(`Duration: ${formatDuration(result.duration)}`);
      console.log(`System: ${(result.systemSize / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`Mic: ${(result.micSize / (1024 * 1024)).toFixed(2)} MB`);

      if (autoProcess) {
        processSession(result.sessionDir, result.duration).catch(err => {
          console.error('Auto-processing session failed:', err);
          showNotification('Processing Error', `Failed: ${err.message.split('\n')[0]}`, true);
          if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.webContents.send('processing:complete', { error: err.message });
          }
        });
      }

      return {
        success: true,
        mode: 'dual',
        sessionDir: result.sessionDir,
        duration: result.duration,
        systemSize: result.systemSize,
        micSize: result.micSize
      };
    } else {
      console.log(`Recording stopped: ${result.filepath}`);
      console.log(`Duration: ${formatDuration(result.duration)}`);
      console.log(`Size: ${(result.size / (1024 * 1024)).toFixed(2)} MB`);

      if (autoProcess) {
        processRecording(result.filepath, result.duration).catch(err => {
          console.error('Auto-processing recording failed:', err);
          showNotification('Processing Error', `Failed: ${err.message.split('\n')[0]}`, true);
        });
      }

      return {
        success: true,
        mode: 'system',
        filepath: result.filepath,
        duration: result.duration,
        size: result.size
      };
    }
  } catch (err) {
    console.error('Recording did not stop cleanly:', err);

    // Ensure UI is updated even on error
    if (statusUpdateInterval) {
      clearInterval(statusUpdateInterval);
      statusUpdateInterval = null;
    }
    updateTrayMenu();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('recording:update', { state: 'stopped' });
      settingsWindow.webContents.send('companion-mode-status', { active: false });
    }
    showNotification('Recording Error', `Failed to stop: ${err.message}`, true);
    return ipcFail(err);
  } finally {
    stopInProgress = false;
  }
}

/**
 * Tray "Stop Recording" handler — thin wrapper over the one stop path.
 */
async function handleStopRecording() {
  await stopRecording('tray-menu');
}

/**
 * Convert a 0-1 level to a block character for menu bar display
 */
const LEVEL_BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function levelToBar(level) {
  const idx = Math.min(LEVEL_BLOCKS.length - 1, Math.round(level * (LEVEL_BLOCKS.length - 1)));
  return LEVEL_BLOCKS[idx];
}

/**
 * Read a file's size in bytes, or null if unreadable (missing/locked). The sole
 * impure dependency injected into `computeTrackHealth` — kept here so the shared
 * health logic stays free of `fs`.
 */
function statSizeOrNull(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

/**
 * Start polling WAV files for audio levels and sending to the settings window + tray
 */
function startLevelMonitor(isDual) {
  stopLevelMonitor();

  // Arm the prolonged-silence auto-stop watcher if enabled. It owns no timers;
  // it is driven by the level-monitor poll below.
  if (store.get('silenceAutoStopEnabled')) {
    const minutes = clampSilenceMinutes(store.get('silenceAutoStopMinutes'));
    silenceWatcher = new SilenceWatcher({
      requiredSilenceMs: minutes * 60000,
      mode: isDual ? 'dual' : 'system',
      onTrigger: showSilencePrompt,
      onResume: () => closeSilencePrompt({ cancelTimer: true, resetWatcher: true })
    });
  }

  // Per-track growth state from the previous poll, used to classify each track
  // as live / unknown / ended (see `classifyTrackGrowth`). A brief stall is
  // "unknown" (transient, pauses the watcher — hazard #4/#5); a long stall is
  // "ended" (dead capture, excluded from the silence test). Reset per session so
  // growth state never leaks across recordings, and per TRACK whenever a track
  // is repointed at a new file (see `retargetSystemTrack`).
  trackGrowth = {};

  // Is the audio actually audio? Nothing else asks — every other check measures
  // file growth, and a zero-filled WAV grows exactly like speech does. Only
  // armed for dual-track, which is the only mode where a second track can
  // corroborate that something audible is happening (see services/signalWatcher).
  systemSignalDead = false;
  deadSignalVerdicts = 0;
  captureVerification = null;
  signalWatcher = new SignalWatcher({
    mode: isDual ? 'dual' : 'system',
    onDead: (verdict) => handleDeadSystemSignal(verdict)
  });

  levelMonitor = new LevelMonitor((levels, peaks) => {
    // Store latest levels for tray menu display
    latestLevels = levels;

    if (signalWatcher) signalWatcher.update(peaks);

    // Send to settings window
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('recording:levels', levels);
    }

    // Menu-bar title: elapsed timer + the level blocks (see updateTrayTitle).
    const activeRecorder = isDual ? dualRecorder : recorder;
    if (activeRecorder && activeRecorder.isRecording) {
      updateTrayTitle(activeRecorder.getStatus());
    }

    // Per-track health (live / unknown / ended) is computed every poll for the
    // silence watcher; the panel reads the same map so a stalled capture is
    // visible in the menu bar WHILE it happens (gotchas #5/#6), not afterwards.
    // Computed even when the watcher is disabled — the panel still shows it.
    if (levelMonitor) {
      latestTrackHealth = computeTrackHealth({
        tracks: levelMonitor.tracks,
        trackGrowth,
        now: Date.now(),
        stallMs: DEFAULT_STALL_TIMEOUT_MS,
        readSize: statSizeOrNull,
      });

      // Feed the silence watcher with the per-poll levels + that health map. A
      // single stalled track no longer poisons the whole decision — silence is
      // judged over the live tracks only.
      if (silenceWatcher) {
        silenceWatcher.update(levels, { trackHealth: latestTrackHealth });
      }
    }

    pushPanelState({ throttle: true });
  });

  if (isDual && dualRecorder) {
    levelMonitor.addTrack('system', dualRecorder.systemFile);
    levelMonitor.addTrack('mic', dualRecorder.micFile);
  } else if (recorder && recorder.currentFile) {
    levelMonitor.addTrack('system', recorder.currentFile);
  }

  levelMonitor.start();
}

/**
 * Stop the audio level monitor
 */
function stopLevelMonitor() {
  if (levelMonitor) {
    levelMonitor.stop();
    levelMonitor = null;
  }
  if (tray) {
    tray.setTitle('');
  }
  latestTrackHealth = {};
  trackGrowth = {};
  signalWatcher = null;
  systemSignalDead = false;
  deadSignalVerdicts = 0;
  captureVerification = null;
  // A stop from ANY trigger tears down an open silence prompt + grace timer.
  // resetWatcher:false because we null the watcher outright below.
  closeSilencePrompt({ cancelTimer: true, resetWatcher: false });
  silenceWatcher = null;
}

/**
 * Follow the system track onto the new file a restart just created.
 *
 * All three pieces of per-track state have to move together, and each one is a
 * live bug on its own if it is left behind:
 *
 *   - the level monitor still reads the DEAD file, so levels and peaks freeze;
 *   - `trackGrowth` still holds the old file's size, and the replacement starts
 *     at a 44-byte header — so `size > lastSize` is false on every poll and a
 *     perfectly healthy capture is classified `unknown`, then `ended` after
 *     120s. The panel would show a red "stalled" chip on a working track and
 *     the silence watcher would exclude it from its decision;
 *   - the signal watcher still carries the dead capture's silence, so it fires
 *     again within two polls and burns the session's whole restart budget.
 *
 * Shared by both restart triggers — the exit-code path inside the recorder and
 * the `SignalWatcher` verdict — so the two cannot drift.
 */
function retargetSystemTrack(file) {
  if (levelMonitor) levelMonitor.retargetTrack('system', file);
  delete trackGrowth.system;
  delete latestTrackHealth.system;
  if (signalWatcher) signalWatcher.rearm({ requiredDeadMs: DEFAULT_ESCALATION_MS });
  systemSignalDead = false;
  pushPanelState();
}

/**
 * The system capture has proven it is recording nothing. Say so, everywhere,
 * and try once to fix it.
 *
 * This is the moment the whole feature exists for. Three meetings were lost to
 * a system track of pure zeroes, and in every case the app reported unqualified
 * success — right up to filing the half-a-conversation note in the correct
 * client folder. So the response is deliberately hard to miss while it is still
 * fixable: the menu bar stops showing a timer and starts showing a warning, a
 * notification fires, and the panel turns red.
 *
 * The restart is an in-place retry of the SAME capture method, never a switch
 * to another one (invariant #1), and it leaves `mic.wav` completely untouched.
 */
/**
 * ============================================
 * Capture verification — proving the capture, not inferring it
 * ============================================
 *
 * Everything else in this file waits to SEE whether audio turns up and reasons
 * about the silence. This plays a known sound and looks for it, which turns the
 * one genuinely ambiguous reading — a system track holding nothing — into a fact.
 * See `services/probeRunner.js` for why a probe only decides when the capture is
 * quiet, and `services/captureProbe.js` for the measurements behind the design.
 */

/**
 * How long to wait for ScreenCaptureKit to start delivering frames.
 *
 * Measured startup latency is 1.7-3 s, and probing before the stream is up would
 * read as a dead capture — the worst possible false alarm, fired at the exact
 * moment the user is deciding whether to trust this feature. Generous on
 * purpose; the wait ends the moment frames appear, so the cost is only paid when
 * something really is slow. A stream that never starts at all is already
 * `watchSckStartup`'s job, not this one's.
 */
const CAPTURE_STREAM_WAIT_MS = 9000;
const CAPTURE_STREAM_POLL_MS = 200;

/** The file the system capture is writing RIGHT NOW (parts move after a restart). */
function activeSystemCaptureFile() {
  if (dualRecorder && dualRecorder.isRecording) {
    const parts = dualRecorder.systemParts;
    if (Array.isArray(parts) && parts.length) return parts[parts.length - 1].file;
    return dualRecorder.systemFile;
  }
  if (recorder && recorder.isRecording) return recorder.currentFile;
  return null;
}

/**
 * Wait until the capture helper is actually writing frames.
 *
 * Growth past the header is the right signal here even though growth is exactly
 * the check gotcha #16 condemns — because the question is different. "Is this
 * audio?" cannot be answered by growth. "Has the stream started?" can, and a
 * zero-filled stream that has started is precisely what we want to probe.
 */
function waitForCaptureStream(filePath, { timeoutMs = CAPTURE_STREAM_WAIT_MS, pollMs = CAPTURE_STREAM_POLL_MS } = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (!isRecordingActive()) return resolve(false);
      let size = 0;
      try { size = fs.statSync(filePath).size; } catch { /* not there yet */ }
      if (size > 44) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/**
 * Play the signature into the live capture and return the verdict.
 *
 * Serialised behind `probeInFlight` because a probe makes an audible sound in
 * somebody's meeting; two overlapping ones would also interleave their samples
 * and could mask each other into a false "dead".
 */
async function probeSystemCapture({ amplitude } = {}) {
  const filePath = activeSystemCaptureFile();
  if (!filePath || probeInFlight || !isRecordingActive()) return null;

  probeInFlight = true;
  try {
    return await verifyCapture({ filePath, amplitude, registerProcess });
  } catch (err) {
    // A probe that throws must never take a recording with it. No result means
    // no verdict, which leaves the passive watcher exactly as it was.
    console.error('Capture probe failed:', err.message);
    return null;
  } finally {
    probeInFlight = false;
  }
}

/**
 * Verify the capture immediately after a recording starts.
 *
 * This is the whole point of the feature. Every system-audio loss on record —
 * Jul 7, Aug 13, Aug 14 — was dead from the first second and produced a
 * full-length track of exact zeros that was transcribed, summarised and filed as
 * a complete meeting. Each was discoverable in about two seconds by playing a
 * sound and listening for it, and instead was discovered afterwards, if at all.
 *
 * Unlike the passive watcher this runs in BOTH modes. The reason single-track
 * gets no live protection is that a verdict there has nothing to corroborate
 * against (gotcha #16) — but a probe needs no corroboration, because we are the
 * thing making the sound. That closes the documented coverage gap for the one
 * question that matters most, at the one moment it is cheapest to answer.
 */
async function verifyCaptureAtStart() {
  const filePath = activeSystemCaptureFile();
  if (!filePath) return;

  captureVerification = { verdict: 'probing' };
  pushPanelState();

  const streaming = await waitForCaptureStream(filePath);
  if (!isRecordingActive()) return;

  if (!streaming) {
    // No frames at all is a different failure with its own handler; saying
    // nothing here keeps one problem to one message.
    captureVerification = { verdict: 'inconclusive', confidence: 'stream-never-started' };
    pushPanelState();
    return;
  }

  let result = await probeSystemCapture();
  if (!result || !isRecordingActive()) return;

  // One confirming probe before we are willing to say "dead".
  //
  // Waiting for the file to grow past its header proves the stream has STARTED,
  // not that it has begun delivering audio, and those are not quite the same
  // instant. Measured here the gap is comfortable — frames appear at ~605 ms and
  // the probe lands a second later, 5 runs out of 5 — but that was a machine
  // doing nothing else, and the consequence of getting it wrong is the single
  // worst outcome this feature has: an alarming, wrong dialog in the first
  // seconds of a real meeting, which teaches the user to distrust every later
  // warning including the true ones. A second probe costs about three seconds
  // and only ever runs on the path that is already going to interrupt someone.
  if (result.verdict === 'dead') {
    console.warn('First probe found nothing — confirming before raising the alarm.');
    const confirmation = await probeSystemCapture();
    if (!isRecordingActive()) return;
    if (confirmation && confirmation.verdict !== 'dead') {
      console.log(`Confirming probe disagreed (${confirmation.verdict}) — treating the capture as healthy.`);
      result = confirmation;
    }
  }

  captureVerification = result;

  if (result.verdict === 'alive') {
    console.log(`Capture verified at start (${result.confidence}, peak ${result.peak}).`);
    pushPanelState();
    return;
  }

  if (result.verdict === 'inconclusive') {
    console.warn(`Capture verification inconclusive: ${result.reason}`);
    pushPanelState();
    return;
  }

  // Proven dead, twice, seconds into the recording, with the meeting still ahead.
  console.error(`SYSTEM CAPTURE DEAD AT START: ${result.reason}`);
  systemSignalDead = true;
  deadSignalVerdicts += 1;
  if (dualRecorder && dualRecorder.isRecording && dualRecorder.manifest) {
    dualRecorder.manifest.tracks.system.status = 'silent';
  }

  const status = isRecordingActive()
    ? (dualRecorder && dualRecorder.isRecording ? dualRecorder.getStatus() : recorder.getStatus())
    : null;
  if (status) updateTrayTitle(status);
  pushPanelState();

  showNotification(
    'System audio is NOT being recorded',
    'A test tone was played and nothing was captured. Only your microphone is being recorded.',
    true
  );
  showDeadCaptureDialog(result);
}

/**
 * The one interruption this feature is allowed to make.
 *
 * Deliberately NOT a retry prompt. Of the causes ever observed, the per-app
 * filter is fixed and the rest — a wedged `coreaudiod`, an ARK/ACE hijack — are
 * system-level and survive restarting our own helper, so offering "try again"
 * would mostly spend the user's attention to repeat the same failure. The one
 * incident that was ever actually resolved was resolved by restarting Core Audio
 * (gotcha #5, Cause B), so that is what this leads with.
 *
 * It does not stop the recording, and does not offer to. The microphone track is
 * still good and a meeting in progress is not the moment to throw it away —
 * half a conversation recorded knowingly beats none recorded helpfully.
 */
function showDeadCaptureDialog(result) {
  dialog.showMessageBox({
    type: 'error',
    title: 'System audio is not being captured',
    message: 'Only your microphone is being recorded.',
    detail:
      'CXNotes played a test tone through your speakers and ScreenCaptureKit recorded '
      + 'digital silence, so the other side of this meeting is not being captured.\n\n'
      + 'This is almost always Core Audio being wedged. The fix that has worked before, '
      + 'in Terminal:\n\n    sudo killall coreaudiod\n\n'
      + 'Audio will glitch for a second and every app carries on. Then stop and restart '
      + 'this recording.\n\n'
      + 'If that does not help, check System Settings > Privacy & Security > Screen '
      + `Recording, and that your output device is working.\n\n(${result.reason})`,
    buttons: ['Keep Recording Anyway', 'Stop Recording'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }).then(({ response }) => {
    if (response === 1) stopRecording('capture-check-dialog');
  }).catch(() => { /* a dialog we cannot show must not break the recording */ });
}

function handleDeadSystemSignal(verdict) {
  // A SignalWatcher verdict is now a SUSPICION, not a conclusion. It is reached
  // by inference — no system samples while the mic had some — and its own doc
  // comment concedes how loose that is. Before spending a restart or the user's
  // attention on it, ask the capture directly.
  console.warn(
    `Suspected dead system capture: ${verdict.reason} `
    + `(after ${Math.round(verdict.elapsedMs / 1000)}s) — probing to confirm.`
  );
  confirmDeadSystemSignal(verdict).catch((err) => {
    console.error('Dead-signal confirmation failed:', err.message);
  });
}

/**
 * Turn a suspicion into a fact, then act on the fact.
 *
 * Three outcomes, and the middle one is the reason this exists:
 *
 *   - **The probe comes back.** The capture is healthy and the silence was
 *     innocent — nothing was playing, the call had not connected. Previously
 *     this case cost a restart and a permanent amber warning; now it costs one
 *     quiet tone and is dismissed. This matters more than it sounds: false
 *     alarms are what teach people to ignore the real one.
 *   - **The probe does not come back, into a silent capture.** Proof. Not the
 *     weak circumstantial case the passive watcher can build, but a sound we
 *     played that never arrived — so this warns loudly on the FIRST verdict
 *     rather than waiting out a second five-minute window to earn the right.
 *   - **No usable verdict** (the probe could not play, or the capture was too
 *     loud to read). Fall through to exactly the old behaviour: quiet first,
 *     loud on the second. Losing the probe must never leave us worse off than
 *     before it existed.
 */
async function confirmDeadSystemSignal(verdict) {
  const result = await probeSystemCapture({ amplitude: PROBE_AMPLITUDE_LIVE });
  captureVerification = result || captureVerification;

  if (result && result.verdict === 'alive') {
    console.log(`Probe cleared the suspicion (${result.confidence}) — capture is healthy.`);
    systemSignalDead = false;
    if (signalWatcher) signalWatcher.rearm({ requiredDeadMs: DEFAULT_ESCALATION_MS });
    pushPanelState();
    return;
  }

  const proven = Boolean(result && result.verdict === 'dead');

  systemSignalDead = true;
  deadSignalVerdicts += 1;
  console.warn(proven
    ? 'Probe CONFIRMED the system capture is recording nothing.'
    : 'Probe reached no verdict — falling back to the inferred one.');

  if (dualRecorder && dualRecorder.isRecording && dualRecorder.manifest) {
    dualRecorder.manifest.tracks.system.status = 'silent';
  }

  // Proof earns an immediate interruption; inference still has to earn it.
  //
  // Without a probe the commonest innocent cause — starting before the call
  // connects — is indistinguishable from the failure, so the first inferred
  // verdict only raises the ambient warnings (menu-bar title, panel banner),
  // which cost nothing and clear themselves when audio arrives. A proven
  // verdict has no innocent reading left: we played a sound into the capture
  // and the capture recorded silence.
  if (proven || deadSignalVerdicts > 1) {
    showNotification(
      'No system audio',
      proven
        ? 'A test tone was played and nothing was captured. Only your microphone is recording.'
        : 'The other side of this meeting is still not being recorded. Your microphone is fine.',
      true
    );
  }

  const status = dualRecorder && dualRecorder.isRecording ? dualRecorder.getStatus() : null;
  if (status) updateTrayTitle(status);
  pushPanelState();

  if (!(dualRecorder && dualRecorder.isRecording)) return;

  dualRecorder
    .restartSystemCapture('no audio since the recording began', (warning) => console.warn(warning))
    .then((result2) => {
      if (result2.restarted) retargetSystemTrack(result2.file);
    })
    .catch((err) => console.error('System capture restart failed:', err.message));
}

/**
 * ============================================
 * Prolonged-silence auto-stop prompt
 * ============================================
 */
const SILENCE_PROMPT_WIDTH = 460;
const SILENCE_PROMPT_HEIGHT = 92;
const SILENCE_GRACE_MS = 60000;

/**
 * Show the "No audio detected — still recording?" prompt. Fired by the
 * SilenceWatcher's onTrigger. Starts the authoritative grace timer that
 * auto-stops the recording if the user ignores the prompt.
 */
function showSilencePrompt() {
  // Guard: no point prompting if nothing is recording, and never stack prompts.
  if (!isRecordingActive()) return;
  if (silencePromptWindow && !silencePromptWindow.isDestroyed()) return;
  console.warn(`[Silence] no audio for ${clampSilenceMinutes(store.get('silenceAutoStopMinutes'))} min — prompt shown; auto-stop in ${SILENCE_GRACE_MS / 1000}s unless answered`);

  const display = screen.getPrimaryDisplay();
  const { x: workX, y: workY, width: workWidth } = display.workArea;
  const x = Math.round(workX + (workWidth - SILENCE_PROMPT_WIDTH) / 2);
  const y = workY + 8;

  silencePromptWindow = new BrowserWindow({
    width: SILENCE_PROMPT_WIDTH,
    height: SILENCE_PROMPT_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    ...GLASS.popover,
    roundedCorners: true,
    hasShadow: true,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-silence-prompt.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  silencePromptWindow.loadFile(path.join(__dirname, 'renderer', 'silence-prompt.html'));
  attachGlass(silencePromptWindow);
  silencePromptWindow.setAlwaysOnTop(true, 'floating');

  silencePromptWindow.once('ready-to-show', () => {
    if (silencePromptWindow && !silencePromptWindow.isDestroyed()) {
      silencePromptWindow.show();
    }
  });

  silencePromptWindow.on('closed', () => {
    silencePromptWindow = null;
    if (silenceGraceTimer) {
      clearTimeout(silenceGraceTimer);
      silenceGraceTimer = null;
    }
  });

  // Authoritative grace timer. The renderer countdown is cosmetic only — this
  // is what actually fires the auto-stop. The stopRecording() in-flight guard
  // covers the race with a user click.
  silenceGraceTimer = setTimeout(() => {
    silenceGraceTimer = null;
    console.warn(`[Silence] no answer to the silence prompt in ${SILENCE_GRACE_MS / 1000}s — auto-stopping`);
    stopRecording('silence-auto-stop');
  }, SILENCE_GRACE_MS);
}

/**
 * The single dismissal path for the silence prompt (hazard #5). Every way the
 * prompt goes away routes through here.
 *
 * @param {object} opts
 * @param {boolean} [opts.cancelTimer=false] - clear the grace timer.
 * @param {boolean} [opts.resetWatcher=false] - re-arm the watcher for the next
 *   silent window (used when the recording continues).
 */
function closeSilencePrompt({ cancelTimer = false, resetWatcher = false } = {}) {
  if (cancelTimer && silenceGraceTimer) {
    clearTimeout(silenceGraceTimer);
    silenceGraceTimer = null;
  }
  if (silencePromptWindow && !silencePromptWindow.isDestroyed()) {
    silencePromptWindow.close();
  }
  if (resetWatcher && silenceWatcher) {
    silenceWatcher.reset();
  }
}

/**
 * ============================================
 * Vault filing triage prompt
 * ============================================
 */
const FILING_PROMPT_WIDTH = 460;
const FILING_PROMPT_AUTO_HIDE_MS = 4 * 60 * 1000;

/**
 * Show the "Where should this note go?" banner after an ambiguous note was
 * filed to Inbox/. Offers the top candidates as one-click moves. A newer
 * escalation replaces an open prompt — the earlier note is already safe in
 * Inbox, so nothing is lost by re-targeting the window.
 *
 * @param {object} escalation - { exportedPath, candidates, manifestPath, noteTitle }
 */
function showFilingPrompt(escalation) {
  pendingFilingEscalation = escalation;
  closeFilingPrompt({ keepPending: true });

  const candidateRows = Math.min(3, (escalation.candidates || []).length);
  const height = 72 + (candidateRows + 1) * 36 + 12;

  const display = screen.getPrimaryDisplay();
  const { x: workX, y: workY, width: workWidth } = display.workArea;
  const x = Math.round(workX + (workWidth - FILING_PROMPT_WIDTH) / 2);
  const y = workY + 8;

  const win = new BrowserWindow({
    width: FILING_PROMPT_WIDTH,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    ...GLASS.popover,
    roundedCorners: true,
    hasShadow: true,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-filing-prompt.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  filingPromptWindow = win;

  win.loadFile(path.join(__dirname, 'renderer', 'filing-prompt.html'));
  attachGlass(win);
  win.setAlwaysOnTop(true, 'floating');

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show();
    }
  });

  win.on('closed', () => {
    // Guard: when a newer escalation replaced this window, the module-level
    // refs already point at the NEW window/timer — a stale 'closed' from the
    // old window must not clobber them (zombie prompt + dead auto-hide).
    if (filingPromptWindow === win) {
      filingPromptWindow = null;
      if (filingPromptTimer) {
        clearTimeout(filingPromptTimer);
        filingPromptTimer = null;
      }
    }
  });

  // Auto-hide: dismissing changes nothing — the note stays in Inbox/ where
  // Chris can still triage it by hand.
  filingPromptTimer = setTimeout(() => {
    filingPromptTimer = null;
    closeFilingPrompt();
  }, FILING_PROMPT_AUTO_HIDE_MS);
}

/**
 * Tear down the filing prompt. keepPending is used when a newer escalation is
 * about to re-open the window with fresh context.
 */
function closeFilingPrompt({ keepPending = false } = {}) {
  if (filingPromptTimer) {
    clearTimeout(filingPromptTimer);
    filingPromptTimer = null;
  }
  if (filingPromptWindow && !filingPromptWindow.isDestroyed()) {
    filingPromptWindow.close();
  }
  filingPromptWindow = null;
  if (!keepPending) {
    pendingFilingEscalation = null;
  }
}

/**
 * Broadcast processing progress to the settings window and update global state
 */
function broadcastProgress(processingPath, stage, progress, message) {
  processingState = { path: processingPath, stage, progress, message };
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('processing:progress', { path: processingPath, stage, progress, message });
  }
}

/**
 * Mark processing as complete, notify renderer and refresh recordings list
 */
function broadcastComplete(error) {
  const completedPath = processingState ? processingState.path : null;
  processingState = null;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('processing:complete', error ? { error } : undefined);
    // Tell the renderer to refresh its recordings list
    settingsWindow.webContents.send('recordings:changed', { completedPath });
  }
}

/**
 * Process a single-track recording: transcribe audio and generate meeting notes
 */
async function processRecording(wavPath, duration) {
  const outputDir = store.get('outputDirectory');

  try {
    // Step 0: Trim silence from recording
    tray.setToolTip('Trimming silence...');
    console.log(`Trimming silence from: ${wavPath}`);
    broadcastProgress(wavPath, 'Trimming', 0, 'Trimming silence from recording...');

    const trimResult = await trimSilence(wavPath, { registerProcess });
    if (trimResult.trimmed) {
      console.log(`Silence trimmed: saved ${(trimResult.savedBytes / 1024).toFixed(0)} KB`);
    } else if (trimResult.allSilence) {
      console.warn('Recording appears to be all silence');
    }

    // Step 1: Transcribe
    tray.setToolTip('Transcribing audio...');
    console.log(`Transcribing ${wavPath}`);

    const transcriptPath = await transcribe(wavPath, outputDir, (progress) => {
      tray.setToolTip(`Transcribing: ${progress}%`);
      broadcastProgress(wavPath, 'Transcribing', progress, `Processing audio: ${progress}%`);
    });

    console.log(`Transcription complete: ${transcriptPath}`);

    tray.setToolTip('Generating notes...');
    console.log(`Summarising ${transcriptPath}`);
    broadcastProgress(wavPath, 'Summarising', 0, 'Generating notes...');

    let lastNoteUpdate = 0;
    const notesPath = await generateNotes(transcriptPath, (progress) => {
      const now = Date.now();
      if (now - lastNoteUpdate < 500) return; // Throttle to 2 updates/sec
      lastNoteUpdate = now;

      tray.setToolTip(`Generating notes... (${progress}%)`);
      broadcastProgress(wavPath, 'Summarising', Math.min(95, progress), `Generating notes... (${progress}%)`);
    }, llmOptions());

    const { obsidianPath } = await fileAndExportNotes(notesPath, {
      title: buildSingleTrackNoteTitle(transcriptPath),
      startTime: getFileStartTime(wavPath)
    });

    console.log(`Note generation complete: ${notesPath}`);
    console.log(`Obsidian note exported: ${obsidianPath}`);

    tray.setToolTip('CXNotes');
    broadcastComplete();

    showNotification('Processing Complete', 'Meeting notes generated successfully!');

  } catch (err) {
    console.error('Processing failed:', err);
    tray.setToolTip('CXNotes');
    broadcastComplete(err.message);
    showNotification('Processing Error', `Failed: ${err.message.split('\n')[0]}`, true);
  }
}

/**
 * Process a dual-track session: transcribe both tracks, merge, generate speaker-aware notes
 */
async function processSession(sessionDir, duration) {
  const outputDir = store.get('outputDirectory');

  try {
    // Read manifest
    const manifestPath = path.join(sessionDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    // Step 0: Trim silence from both tracks
    tray.setToolTip('Trimming silence...');
    console.log(`Trimming silence from session tracks: ${sessionDir}`);
    broadcastProgress(sessionDir, 'Trimming', 0, 'Trimming silence from audio tracks...');

    const systemFile = path.join(sessionDir, manifest.tracks.system.file);
    const micFile = path.join(sessionDir, manifest.tracks.mic.file);
    const trimOpts = { registerProcess };

    // A stitched session must NOT be trimmed — neither track.
    //
    // `trimSilence` used to cut leading silence from each file independently,
    // shifting that file's offsets relative to the other's; since 2026-09-25 it
    // trims the tail only (gotcha #23), which removes the general wrinkle. The
    // skip below stays as belt and braces for the case where it mattered most:
    // the reason a capture gets restarted is usually that its first part
    // recorded nothing, so the stitched track opens with however many minutes of
    // zeroes part one contributed. Trimming would shear exactly that off the
    // front while `mic.wav` keeps it, and since `transcriptMerger` orders on
    // each file's own offsets, every word would be attributed minutes away from
    // when it was said — undoing the padding invariant #22 exists to get right.
    //
    // Skipping BOTH rather than only the system track: trimming the mic's head
    // breaks the same relationship from the other side. A few megabytes is not
    // worth a scrambled transcript.
    const wasStitched = Array.isArray(manifest.tracks.system.parts)
      && manifest.tracks.system.parts.length > 1;
    if (wasStitched) {
      console.log('Session was stitched from capture parts — skipping silence trim to preserve cross-track alignment');
    }

    const skipTrim = Promise.resolve({ trimmed: false, reason: 'stitched' });
    const [systemTrim, micTrim] = await Promise.all([
      wasStitched ? skipTrim : trimSilence(systemFile, trimOpts),
      wasStitched ? skipTrim : trimSilence(micFile, trimOpts)
    ]);

    // Log trim results
    if (systemTrim.trimmed) {
      console.log(`System track: trimmed ${(systemTrim.savedBytes / 1024).toFixed(0)} KB silence`);
      manifest.tracks.system.silenceTrimmed = systemTrim;
    }
    if (micTrim.trimmed) {
      console.log(`Mic track: trimmed ${(micTrim.savedBytes / 1024).toFixed(0)} KB silence`);
      manifest.tracks.mic.silenceTrimmed = micTrim;
    }
    // The definitive silence check, over every sample rather than a proxy.
    //
    // `trimSilence` already inferred all-silence from how small sox made its
    // output and then did nothing with it but `console.warn` — the detection
    // existed and reached no one, which is a large part of why three silent
    // recordings were filed as successes. Promoted here into the manifest, where
    // the badge, the panel and the note header all read from.
    const systemPeak = measureWavPeak(systemFile);
    const micPeak = measureWavPeak(micFile);

    manifest.tracks.system.silent = systemPeak ? systemPeak.silent : false;
    manifest.tracks.system.peak = systemPeak ? systemPeak.peak : null;
    manifest.tracks.mic.silent = micPeak ? micPeak.silent : false;
    manifest.tracks.mic.peak = micPeak ? micPeak.peak : null;

    if (manifest.tracks.system.silent) {
      console.warn(`System track is digitally silent (${systemPeak.samples} samples, peak 0)`);
    }
    if (manifest.tracks.mic.silent) {
      console.warn(`Mic track is digitally silent (${micPeak.samples} samples, peak 0)`);
    }
    if (systemTrim.allSilence) console.warn('System track appears to be all silence');
    if (micTrim.allSilence) console.warn('Mic track appears to be all silence');

    // Update manifest with trim stats
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Step 1: Transcribe both tracks
    tray.setToolTip('Transcribing dual tracks...');
    console.log(`Starting session transcription for: ${sessionDir}`);

    const transcripts = await transcribeSession(sessionDir, outputDir, (progress) => {
      tray.setToolTip(`Transcribing: ${progress}%`);
      broadcastProgress(sessionDir, 'Transcribing', progress, `Processing dual tracks: ${progress}%`);
    }, { useSharedTranscript: store.get('useSharedTranscript') });

    console.log(`Transcription complete. Merged: ${transcripts.mergedTranscript}`);

    // Step 2: Generate speaker-aware notes + file into the vault
    const { notesPath, obsidianPath } = await summariseAndFileSession(
      sessionDir,
      transcripts.mergedTranscript
    );

    console.log(`Note generation complete: ${notesPath}`);
    console.log(`Obsidian note exported: ${obsidianPath}`);

    tray.setToolTip('CXNotes');
    broadcastComplete();

    showNotification('Processing Complete', 'Speaker-aware meeting notes generated!');

  } catch (err) {
    console.error('Session processing failed:', err);
    tray.setToolTip('CXNotes');
    broadcastComplete(err.message);
    showNotification('Processing Error', `Failed: ${err.message.split('\n')[0]}`, true);
    recordProcessingFailure(sessionDir, err);
  }
}

/**
 * Slide text for a session: cached if it has been read before, OCR'd if not.
 *
 * Returns [] for every session without slides, which keeps the summariser
 * prompt identical to what it was before slides existed.
 *
 * @param {string} sessionDir
 * @returns {Array}
 */
function readOrRunSlideOcr(sessionDir) {
  const slidesDir = path.join(sessionDir, SLIDES_DIRNAME);
  if (!fs.existsSync(slidesDir)) return [];

  const cached = path.join(slidesDir, 'slides.json');
  if (fs.existsSync(cached)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cached, 'utf-8'));
      if (Array.isArray(parsed.slides) && parsed.slides.length) {
        console.log(`Session has ${parsed.slides.length} slide keyframe(s) already read`);
        return parsed.slides;
      }
    } catch {
      // Unreadable cache — fall through and OCR again.
    }
  }

  const { slides, error } = runSlideOcr(getSlideBinaryPath(), slidesDir);
  if (error) {
    // Costs slide TEXT, not the slides and not the note.
    console.warn(`Slide OCR failed: ${error}`);
    return [];
  }
  if (slides.length) {
    writeSlidesJson(slidesDir, slides);
    console.log(`Read text off ${slides.length} slide keyframe(s)`);
  }
  return slides;
}

/**
 * The on-screen speaker timeline for a session, if one was sampled.
 *
 * The roster comes from the meeting context the user (or the calendar) already
 * supplied, and it is what turns a shaky OCR label into a name worth using —
 * a surname plus a matching first initial is enough to trust the ROSTER's
 * spelling over what the screen appeared to say.
 *
 * @param {string} sessionDir
 * @param {object} manifest
 * @returns {Array}
 */
function readSpeakerTimeline(sessionDir, manifest) {
  const csvPath = path.join(sessionDir, SLIDES_DIRNAME, 'screen_text.csv');
  if (!fs.existsSync(csvPath)) return [];

  try {
    const samples = parseScreenTextCsv(fs.readFileSync(csvPath, 'utf-8'));
    if (!samples.length) return [];
    const roster = parseRoster((manifest.meetingContext || {}).participants);
    const timeline = buildSpeakerTimeline(samples, { roster, endMs: manifest.duration });
    if (timeline.length) {
      console.log(`Session has ${timeline.length} on-screen speaker name change(s)`);
    }
    return timeline;
  } catch (err) {
    console.warn(`Could not read the speaker timeline: ${err.message}`);
    return [];
  }
}

/**
 * Summarise a session's merged transcript and file the note into the vault.
 *
 * Shared by the full pipeline (`processSession`) and the cheap re-summarise
 * path (`resummariseSession`) so the two can never disagree about markers,
 * manifest bookkeeping, or vault filing — the same reason invariant #9 keeps
 * a single stop path. The manifest is read fresh from disk because
 * `transcribeSession` updates it behind our back.
 *
 * @param {string} sessionDir - Session directory holding manifest.json
 * @param {string} mergedTranscriptPath - Merged transcript to summarise
 * @returns {Promise<{notesPath: string, obsidianPath: string}>}
 */
async function summariseAndFileSession(sessionDir, mergedTranscriptPath) {
  const manifestPath = path.join(sessionDir, 'manifest.json');

  tray.setToolTip('Generating speaker-aware notes...');
  console.log('Starting note generation from merged transcript');
  broadcastProgress(sessionDir, 'Summarising', 0, 'Generating speaker-aware notes...');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  // Fold any live markers into the manifest so the summariser gets them as
  // anchor points. Read from disk rather than memory so a reprocess of an
  // older session picks up its markers too (invariant #16).
  const sessionMarkers = readMarkers(sessionDir);
  if (sessionMarkers.length) {
    manifest.markers = sessionMarkers;
    console.log(`Session has ${sessionMarkers.length} live marker(s)`);
    appendMarkersToSkeleton(sessionDir, sessionMarkers);
  }

  // Read the text off any captured slides. Cached in slides.json, so the cheap
  // re-summarise path does not pay for OCR twice, and a session captured
  // before this existed still gets its slides read on a reprocess.
  manifest.slideText = readOrRunSlideOcr(sessionDir);
  manifest.speakerTimeline = readSpeakerTimeline(sessionDir, manifest);

  let lastSummaryUpdate = 0;
  const notesPath = await generateSessionNotes(mergedTranscriptPath, manifest, (progress) => {
    const now = Date.now();
    if (now - lastSummaryUpdate < 500) return; // Throttle to 2 updates/sec
    lastSummaryUpdate = now;

    tray.setToolTip(`Generating notes... (${progress}%)`);
    broadcastProgress(sessionDir, 'Summarising', Math.min(95, progress), `Generating notes... (${progress}%)`);
  }, llmOptions());

  if (!manifest.processing) {
    manifest.processing = {};
  }

  // Say on the note itself that half the conversation is missing.
  //
  // This is the last line of defence and the one that survives everything else:
  // the tray warning is gone, the notification has been dismissed, and what is
  // left is a note in a client folder that reads like a complete record of a
  // meeting. All three lost meetings looked exactly like that. Written
  // deterministically rather than asked of the LLM, because a summariser handed
  // a one-sided transcript has no way to know a second side was ever meant to
  // exist — it will write a confident summary of a monologue.
  prependSilentTrackWarning(notesPath, manifest);
  // And when the mic side was rebuilt from CXNotes' own recording because the
  // companion transcript lacked it (services/companionCoverage.js).
  prependOwnMicNotice(notesPath, manifest);

  const { obsidianPath, filing } = await fileAndExportNotes(notesPath, {
    title: buildSessionNoteTitle(manifest),
    participants: manifest.meetingContext?.participants,
    agenda: manifest.meetingContext?.agenda,
    startTime: manifest.startTime,
    existingPath: manifest.processing.obsidianExport,
    manifestPath
  });

  // Update manifest with summarisation path
  manifest.processing.summarisation = notesPath;
  manifest.processing.obsidianExport = obsidianPath;
  if (filing) {
    manifest.processing.vaultFiling = buildVaultFilingRecord(filing);
  }
  // A successful run clears any prior failure so the session stops being
  // flagged in the recordings list.
  delete manifest.processing.error;
  delete manifest.processing.failedAt;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  return { notesPath, obsidianPath };
}

/**
 * Everything on disk that belongs to one session, for display and deletion.
 *
 * Resolved from the manifest rather than guessed from the directory name,
 * because the processed directory is keyed on `manifest.sessionId` and the
 * vault note may have been filed anywhere (or renamed by a collision suffix).
 *
 * @param {string} sessionDir - Session directory under recordings/
 * @returns {{sessionDir: string, processedDir: string|null, vaultNote: string|null, title: string}|null}
 */
function collectSessionArtefacts(sessionDir) {
  try {
    if (!sessionDir || !fs.existsSync(sessionDir)) return null;

    const manifestPath = path.join(sessionDir, 'manifest.json');
    let manifest = {};
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }

    const sessionId = manifest.sessionId || path.basename(sessionDir).replace(/_session$/, '');
    const processedDir = path.join(
      store.get('outputDirectory'),
      'processed',
      `${sessionId}_session`
    );

    const exported = manifest.processing && manifest.processing.obsidianExport;

    return {
      sessionDir,
      processedDir: fs.existsSync(processedDir) ? processedDir : null,
      vaultNote: exported && fs.existsSync(exported) ? exported : null,
      title: (manifest.meetingContext && manifest.meetingContext.title)
        || path.basename(sessionDir)
    };
  } catch (err) {
    console.warn('Failed to collect session artefacts:', err.message);
    return null;
  }
}

/**
 * Delete a session and its exported vault note — to the Trash, not `rm`.
 *
 * The panel's delete is a right-click in a small popover, far easier to hit by
 * accident than the settings-window button, so every path here is recoverable
 * from the Finder. Each item is trashed independently: one failure (a note the
 * user already moved in Obsidian, a permissions blip) must not strand the rest.
 *
 * @param {object} artefacts - From collectSessionArtefacts()
 * @returns {Promise<{trashed: string[], failed: string[]}>}
 */
async function trashSessionArtefacts(artefacts) {
  console.log(`[Delete] user trashed a session from the menu-bar panel: ${artefacts.sessionDir || artefacts.processedDir || '(unknown)'}`);
  const trashed = [];
  const failed = [];

  const targets = [
    artefacts.sessionDir,
    artefacts.processedDir,
    artefacts.vaultNote
  ].filter(Boolean);

  for (const target of targets) {
    try {
      await shell.trashItem(target);
      trashed.push(target);
      console.log(`Moved to Trash: ${target}`);
    } catch (err) {
      failed.push(target);
      console.error(`Failed to trash ${target}: ${err.message}`);
    }
  }

  return { trashed, failed };
}

/**
 * Confirm, then trash a session + its vault note.
 *
 * The dialog names the exact vault path: the note lives in the user's Obsidian
 * vault, so "delete" must never be a surprise about which file leaves it.
 *
 * @param {string} sessionDir - Session directory under recordings/
 */
async function confirmAndDeleteSession(sessionDir) {
  const artefacts = collectSessionArtefacts(sessionDir);
  if (!artefacts) {
    dialog.showMessageBox({
      type: 'error',
      message: 'Session not found',
      detail: 'It may already have been deleted.',
      buttons: ['OK']
    });
    return;
  }

  const vaultDirForDisplay = getVaultDirectory();
  const vaultRelative = artefacts.vaultNote
    ? (vaultDirForDisplay
        ? path.relative(vaultDirForDisplay, artefacts.vaultNote)
        : artefacts.vaultNote)
    : null;

  const detailLines = [
    `• Session: ${path.basename(artefacts.sessionDir)}`,
    '   (audio, transcript, notes)'
  ];
  if (vaultRelative) {
    detailLines.push(`• Vault note: ${vaultRelative}`);
  }
  detailLines.push('', 'Both are moved to the Trash, so this can be undone.');

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: `Delete "${artefacts.title}"?`,
    detail: detailLines.join('\n'),
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0
  });

  if (response !== 1) return;

  const { trashed, failed } = await trashSessionArtefacts(artefacts);

  if (failed.length) {
    showNotification(
      'Delete Incomplete',
      `Moved ${trashed.length} item(s) to Trash; ${failed.length} could not be deleted.`,
      true
    );
  } else {
    showNotification('Deleted', `"${artefacts.title}" moved to the Trash.`);
  }

  // Both surfaces read from disk, so refresh whatever is currently showing.
  // Deliberately NOT broadcastComplete() — nothing finished processing, and
  // that would also fire the renderer's processing-complete handling.
  if (isPanelOpen()) pushPanelState();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('recordings:changed', { completedPath: null });
  }
}

/**
 * Resolve a session's reusable merged transcript, or null when there isn't
 * one worth reusing.
 *
 * An EMPTY transcript counts as "none": transcription itself failed, so
 * re-summarising would just throw "Merged transcript is empty" and look like
 * the LLM's fault. Callers escalate to a full reprocess instead.
 *
 * @param {string} sessionDir - Session directory
 * @returns {string|null} Path to a non-empty merged transcript, or null
 */
/**
 * The merged transcript on disk, or null. Note the manifest records an ABSOLUTE
 * path written at processing time, so a session recorded under an older output
 * directory can name a file that no longer exists — the existence check is the
 * whole point, not a formality.
 *
 * @param {string} sessionDir - Recording session directory
 * @returns {string|null} Path to merged_transcript.txt, or null
 */
function mergedTranscriptFor(sessionDir) {
  try {
    const manifestPath = path.join(sessionDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const merged = manifest.processing
      && manifest.processing.transcription
      && manifest.processing.transcription.merged;

    if (!merged || !fs.existsSync(merged)) return null;
    return merged;
  } catch {
    return null;
  }
}

function reusableTranscriptFor(sessionDir) {
  // Same file, one extra gate: re-summarising from an EMPTY transcript would
  // hand the provider nothing and call the result a summary. Revealing that
  // same empty file in Finder is still useful, which is why the size check
  // lives here rather than in mergedTranscriptFor.
  const merged = mergedTranscriptFor(sessionDir);
  if (!merged) return null;
  try {
    return fs.statSync(merged).size === 0 ? null : merged;
  } catch {
    return null;
  }
}

/**
 * Notes written BEFORE the provider-failure guard landed can still hold a
 * limit/auth notice instead of a summary — they look perfectly processed
 * (notes.md exists, no manifest error) which is exactly why they went
 * unnoticed. Reading only the head keeps this cheap enough for list render.
 *
 * @param {string} notesPath - Path to a notes.md
 * @returns {string|null} Failure message, or null if the note looks real
 */
function detectPoisonedNote(notesPath) {
  try {
    if (!fs.existsSync(notesPath)) return null;

    // A failure notice is short by definition; a real note is far longer.
    const { size } = fs.statSync(notesPath);
    if (size > POISONED_NOTE_MAX_BYTES) return null;

    return detectProviderFailure(fs.readFileSync(notesPath, 'utf-8'), 'The AI provider');
  } catch {
    // An unreadable note must never break the recordings list.
    return null;
  }
}

/**
 * Regenerate notes from a session's EXISTING transcript.
 *
 * The expensive part of processing is whisper, not the LLM — when only
 * summarisation failed (a provider usage limit, a timeout), re-transcribing
 * 1h+ of audio to fix a 45s step is pure waste. Callers must have verified
 * the merged transcript exists; `session:resummarise` does that and falls
 * back to a full reprocess when it doesn't.
 *
 * @param {string} sessionDir - Session directory
 * @param {string} mergedTranscriptPath - Existing merged transcript
 */
async function resummariseSession(sessionDir, mergedTranscriptPath) {
  try {
    console.log(`Re-summarising from existing transcript: ${mergedTranscriptPath}`);
    const { notesPath, obsidianPath } = await summariseAndFileSession(sessionDir, mergedTranscriptPath);

    console.log(`Note regeneration complete: ${notesPath}`);
    console.log(`Obsidian note exported: ${obsidianPath}`);

    tray.setToolTip('CXNotes');
    broadcastComplete();

    showNotification('Notes Regenerated', 'Meeting notes rebuilt from the existing transcript.');
  } catch (err) {
    console.error('Re-summarisation failed:', err);
    tray.setToolTip('CXNotes');
    broadcastComplete(err.message);
    showNotification('Re-summarise Failed', `Failed: ${err.message.split('\n')[0]}`, true);
    recordProcessingFailure(sessionDir, err);
  }
}

/**
 * Log a processing error to the session manifest so failed sessions are
 * identifiable in the recordings list (and the reprocess buttons light up).
 *
 * @param {string} sessionDir - Session directory
 * @param {Error} err - The failure
 */
function recordProcessingFailure(sessionDir, err) {
  try {
    const manifestPath = path.join(sessionDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!manifest.processing) manifest.processing = {};
    manifest.processing.error = err.message;
    manifest.processing.failedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log('Processing error logged to manifest');
  } catch (manifestErr) {
    console.error('Failed to write error to manifest:', manifestErr);
  }
}

/**
 * Report what the recordings folder is costing in disk.
 */
function showStorageStats() {
  const stats = getStorageStats(store.get('outputDirectory'));

  console.log('Storage Statistics:');
  console.log(`Total Size: ${stats.totalSizeFormatted}`);
  console.log(`Audio: ${stats.audioSizeFormatted}`);
  console.log(`AI Output: ${stats.generatedSizeFormatted}`);
  console.log(`Recordings: ${stats.recordingCount}`);
  console.log(`Transcripts: ${stats.transcriptCount}`);
  console.log(`Notes: ${stats.notesCount}`);

  showNotification(
    'Storage Stats',
    `Total: ${stats.totalSizeFormatted}\nAudio: ${stats.audioSizeFormatted}\nAI Output: ${stats.generatedSizeFormatted}`
  );
}

/**
 * Expire audio past the retention window.
 */
function runCleanup() {
  const deleted = cleanupOldRecordings(
    store.get('outputDirectory'),
    store.get('retentionDays')
  );

  console.log(`Cleanup complete. Deleted ${deleted.length} old recordings.`);

  if (deleted.length > 0) {
    console.log('Deleted files:', deleted);
  }
}

/**
 * Report what is installed, and offer to fix what is not.
 */
function showDependencyStatus() {
  const status = checkDependencies();
  const descriptor = describeDependencyStatus(status, providerInstallLines());

  dialog.showMessageBox({
    type: descriptor.type,
    title: descriptor.title,
    message: descriptor.message,
    detail: descriptor.detail,
    buttons: descriptor.buttons
  }).then((result) => {
    if (result.response === 0 && descriptor.canRunSetup) runSetupScript();
  });

  updateTrayMenu();
}

/**
 * Hand setup to Terminal, where the user can watch and answer it.
 *
 * Which script runs depends on the install: a dev checkout gets the repo's
 * setup.sh exactly as before; a packaged app gets the bundled
 * setup-packaged.sh, because inside a package `__dirname` points into
 * app.asar — an archive file `cd` cannot enter — and the repo the dev script
 * assumes does not exist on a user's machine (see resolveSetupCommand).
 */
function runSetupScript() {
  const setupCommand = resolveSetupCommand({
    isPackaged: app.isPackaged,
    repoDir: __dirname,
    resourcesPath: process.resourcesPath
  });
  const fallback = () => dialog.showErrorBox('Cannot Run Setup', setupFallbackMessage(setupCommand));

  try {
    const appleScript = buildSetupTerminalScript(setupCommand);
    require('child_process').exec(`osascript -e '${appleScript}'`, (err) => {
      if (err) {
        console.error('Could not hand setup to Terminal:', err);
        fallback();
        return;
      }
      showNotification(
        'Setup Started',
        'The setup script is running in Terminal. Follow the instructions there.'
      );
    });
  } catch (err) {
    console.error('Could not launch setup:', err);
    fallback();
  }
}

/**
 * ============================================
 * IPC Handlers
 * ============================================
 */

// Pre-record popup
/**
 * The shape every IPC handler resolves with.
 *
 * `success` is the only field the renderer ever branches on, and it was being
 * spelled out by hand at 42 return sites — 17 of them reconstructing the same
 * `{ success: false, error: err.message }` inside a catch. Naming the two
 * outcomes keeps the convention greppable and stops a handler inventing a
 * different failure shape that the renderer would read as a success.
 */
function ipcOk(payload) {
  return payload ? { success: true, ...payload } : { success: true };
}

/**
 * @param {Error} err - always an Error at every call site (all are in catch blocks)
 * @returns {{success: false, error: string}}
 */
function ipcFail(err) {
  return { success: false, error: err.message };
}

ipcMain.handle('prerecord:getContext', async () => {
  // Prefer the calendar-derived seed if one was staged by "Take notes" on an
  // enriched banner. Otherwise fall back to the saved meetingContext.
  if (pendingPreRecordContext) {
    return pendingPreRecordContext;
  }
  return store.get('meetingContext') || { title: '', participants: '', agenda: '' };
});

ipcMain.handle('prerecord:start', async (event, context) => {
  // Close the popup
  if (preRecordWindow && !preRecordWindow.isDestroyed()) {
    preRecordWindow.close();
  }
  // Start recording with the provided context
  startRecordingWithContext(context || {}, 'manual');
  // Stale-context safety: clear the staged seed so the next manual recording
  // does not inherit calendar context from this one.
  pendingPreRecordContext = null;
  return ipcOk();
});

ipcMain.handle('prerecord:cancel', async () => {
  if (preRecordWindow && !preRecordWindow.isDestroyed()) {
    preRecordWindow.close();
  }
  pendingPreRecordContext = null;
  return ipcOk();
});

// Meeting detection banner
ipcMain.handle('meeting:getContext', async () => {
  return currentDetection || null;
});

ipcMain.handle('meeting:takeNotes', async () => {
  // Stage the calendar-derived seed for the pre-record popup BEFORE opening it,
  // so prerecord:getContext returns the enriched values on first read.
  if (currentDetection && currentDetection.calendarEvent) {
    pendingPreRecordContext = buildPreRecordSeedFromEvent(currentDetection.calendarEvent);
  } else {
    pendingPreRecordContext = null;
  }
  // Mark dismissed so we don't re-fire for this meeting after the pre-record popup closes
  recordDismissal(currentDetection);
  closeMeetingBanner(false);
  showPreRecordPopup();
  return ipcOk();
});

// 1-click confirm: start recording immediately with the fully-templated context
// from the calendar event — zero typing. Only reachable from a 'confirm' banner,
// which itself requires both a calendar event and the auto-template opt-in.
ipcMain.handle('meeting:confirmRecord', async () => {
  const detection = currentDetection;
  if (!detection || !detection.calendarEvent) {
    // Defensive: the Record button is only shown in confirm mode, but if we
    // somehow get here without an event, fall back to the take-notes popup
    // rather than starting a context-less recording.
    closeMeetingBanner(false);
    showPreRecordPopup();
    return { success: false, error: 'no-calendar-event' };
  }

  // Build the rich, fully-templated context from the live calendar event.
  const richCtx = buildMeetingContext(detection.calendarEvent);

  // Same single dismissal registry (invariant #8) so this occurrence won't
  // re-fire a banner the moment the call app is detected.
  recordDismissal(detection);

  // Claim any meeting the MCP server pre-staged for this occurrence: a best-
  // effort atomic state transition (.json → .applied) so it isn't reprocessed.
  // Absence is fine — the in-app path works with no prepared file at all.
  if (preparedMeetingStore && richCtx && richCtx.occurrenceFingerprint) {
    const claimed = preparedMeetingStore.claim(richCtx.occurrenceFingerprint);
    if (claimed.ok) {
      console.log(`Claimed prepared meeting: ${richCtx.occurrenceFingerprint}`);
    }
  }

  closeMeetingBanner(false);
  startRecordingWithContext(richCtx, 'meeting-banner-confirm');
  return ipcOk();
});

ipcMain.handle('meeting:dismiss', async () => {
  closeMeetingBanner(true);
  return ipcOk();
});

// Prolonged-silence auto-stop prompt
ipcMain.handle('silence:getContext', async () => {
  return {
    minutes: clampSilenceMinutes(store.get('silenceAutoStopMinutes')),
    graceSeconds: SILENCE_GRACE_MS / 1000
  };
});

ipcMain.handle('silence:keepRecording', async () => {
  console.log('[Silence] user chose to keep recording');
  // ✕ and "Keep recording" share this: cancel the auto-stop, re-arm the watcher.
  closeSilencePrompt({ cancelTimer: true, resetWatcher: true });
  return ipcOk();
});

ipcMain.handle('silence:stopNow', async () => {
  // Cancel the timer first so it can't race the explicit stop, then stop.
  closeSilencePrompt({ cancelTimer: true });
  await stopRecording('silence-prompt-stop-now');
  return ipcOk();
});

// Vault filing triage prompt
ipcMain.handle('filing:getContext', async () => {
  if (!pendingFilingEscalation) return null;
  return {
    noteTitle: pendingFilingEscalation.noteTitle,
    candidates: (pendingFilingEscalation.candidates || []).slice(0, 3).map((c) => ({
      id: c.id,
      rel: c.rel,
      // Compact label: the last two path segments, e.g. "Acme / Meetings"
      label: c.rel.split('/').slice(-2).join(' / ')
    }))
  };
});

ipcMain.handle('filing:choose', async (event, destinationId) => {
  const escalation = pendingFilingEscalation;
  if (!escalation) {
    closeFilingPrompt();
    return { success: false, error: 'no pending escalation' };
  }

  // "Leave in Inbox" — the note is already there; nothing to move.
  if (destinationId === 'inbox') {
    closeFilingPrompt();
    return ipcOk();
  }

  try {
    const candidate = (escalation.candidates || []).find((c) => c.id === destinationId);
    if (!candidate) {
      return { success: false, error: `unknown destination: ${destinationId}` };
    }

    // `candidate.dir` is absolute and always present for auto-discovered
    // destinations; the join is the fallback for rule-derived ones. An
    // escalation cannot exist without a vault (nothing would have been filed
    // to Inbox), so a missing vault here means it was cleared mid-prompt.
    const vaultDir = getVaultDirectory();
    const targetDir = candidate.dir || (vaultDir ? path.join(vaultDir, candidate.rel) : null);
    if (!targetDir) {
      return { success: false, error: 'No vault directory is configured' };
    }
    fs.mkdirSync(targetDir, { recursive: true });

    // The category code is a function of the FOLDER, so a note that moves
    // folders must be renamed too — otherwise a note filed to Inbox as
    // `BD Dominic 06.17.26.md` keeps saying BD forever once it lands in a
    // client's folder, and the convention stops being re-derivable.
    const restamped = restampCategoryForDestination(
      path.basename(escalation.exportedPath),
      candidate.rel
    );
    const filename = resolveCollision(targetDir, restamped);
    const newPath = path.join(targetDir, filename);
    try {
      fs.renameSync(escalation.exportedPath, newPath);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.copyFileSync(escalation.exportedPath, newPath);
      fs.unlinkSync(escalation.exportedPath);
    }

    // Best-effort manifest update so reprocessing overwrites the moved note.
    if (escalation.manifestPath) {
      try {
        const manifest = JSON.parse(fs.readFileSync(escalation.manifestPath, 'utf-8'));
        if (!manifest.processing) manifest.processing = {};
        manifest.processing.obsidianExport = newPath;
        manifest.processing.vaultFiling = {
          ...(manifest.processing.vaultFiling || {}),
          method: 'manual',
          destination: candidate.rel,
          decidedAt: new Date().toISOString()
        };
        fs.writeFileSync(escalation.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      } catch (manifestErr) {
        console.error('filing:choose — manifest update failed (note moved fine):', manifestErr);
      }
    }

    console.log(`Vault filing: manual → ${candidate.rel} (${path.basename(newPath)})`);
    closeFilingPrompt();
    return { success: true, newPath };
  } catch (err) {
    // The note stays safely in Inbox/; keep the prompt open for another pick.
    console.error('IPC filing:choose failed:', err);
    return ipcFail(err);
  }
});

ipcMain.handle('filing:dismiss', async () => {
  // Note stays in Inbox/ for manual triage.
  closeFilingPrompt();
  return ipcOk();
});

// Calendar suggestions
// ============================================
// Menu-bar panel
// ============================================

ipcMain.handle('panel:getState', async () => buildPanelState());

ipcMain.handle('panel:startRecording', async () => {
  closeMenubarPanel();
  // Same entry point as the tray: the pre-record popup collects context first.
  handleStartRecording();
  return ipcOk();
});

ipcMain.handle('panel:stopRecording', async () => {
  const result = await stopRecording('menubar-panel');
  pushPanelState();
  return { success: !!result.success, skipped: result.skipped };
});

ipcMain.handle('panel:recordUpcoming', async (event, fingerprint) => {
  const meeting = cachedUpcomingMeetings.find(
    (ev) => ev.occurrenceFingerprint === fingerprint
  ) || (fingerprint ? null : cachedUpcomingMeetings[0]);

  if (!meeting) return { success: false, error: 'Meeting no longer available' };

  closeMenubarPanel();
  // startFromUpcoming mirrors the 1-click confirm banner exactly (context +
  // dismissal + prepared-meeting claim), so the panel can never diverge.
  startFromUpcoming(meeting);
  return ipcOk();
});

ipcMain.handle('panel:addMarker', async (event, label) => dropMarker(label));

ipcMain.handle('panel:openSettings', async () => {
  closeMenubarPanel();
  openSettingsWindow();
  return ipcOk();
});

ipcMain.handle('panel:openPath', async (event, target) => {
  try {
    if (target === 'recordings') {
      const recordingsPath = path.join(store.get('outputDirectory'), 'recordings');
      ensureDirectoryStructure(store.get('outputDirectory'));
      await shell.openPath(recordingsPath);
    } else if (target === 'vault') {
      const vaultDir = getVaultDirectory();
      if (!vaultDir) {
        return { success: false, error: 'No vault folder is set' };
      }
      await shell.openPath(vaultDir);
    } else if (target && fs.existsSync(target)) {
      await openArtefact(target);
    } else {
      return { success: false, error: 'Not found' };
    }
    closeMenubarPanel();
    return ipcOk();
  } catch (err) {
    console.error('panel:openPath failed:', err);
    return ipcFail(err);
  }
});

/**
 * Re-summarise from the panel's recent-notes list — where a bad note is
 * actually noticed. The panel stays a pure view (invariant #15): it holds no
 * state and this delegates to the same resummariseSession() the settings
 * window reaches through `session:resummarise`.
 */
ipcMain.handle('panel:resummarise', async (event, sessionDir) => {
  try {
    if (!sessionDir || !fs.existsSync(sessionDir)) {
      return { success: false, error: 'Session not found' };
    }

    const merged = reusableTranscriptFor(sessionDir);
    if (!merged) {
      return { success: false, error: 'No transcript — reprocess from Settings' };
    }

    closeMenubarPanel();
    resummariseSession(sessionDir, merged).catch(err => {
      console.error('Re-summarisation failed:', err);
    });

    return ipcOk();
  } catch (err) {
    console.error('panel:resummarise failed:', err);
    return ipcFail(err);
  }
});

/**
 * Right-click menu for a note row in the panel — the MODEL, not the menu.
 *
 * This used to pop a real `NSMenu` from main. It is now drawn by the renderer
 * so it can carry the app's own glass instead of the system's chrome, which
 * Electron gives no way to restyle. What did NOT move is the decision about
 * what the menu contains: every item is enabled or disabled on whether a file
 * is still on disk, and main is the only side that can see the disk. The panel
 * receives a list and draws it (invariant #15).
 *
 * Note each path is existence-checked HERE and passed on only if real, so a
 * disabled item and a missing file can never disagree.
 */
ipcMain.handle('panel:noteMenu', async (event, payload) => {
  try {
    const { sessionDir, notePath } = payload || {};
    const liveSession = !!(sessionDir && fs.existsSync(sessionDir)) ? sessionDir : null;

    return {
      ...ipcOk(),
      items: buildNoteMenuItems({
        notePath: !!(notePath && fs.existsSync(notePath)) ? notePath : null,
        transcriptPath: liveSession ? mergedTranscriptFor(liveSession) : null,
        sessionDir: liveSession
      })
    };
  } catch (err) {
    console.error('panel:noteMenu failed:', err);
    return ipcFail(err);
  }
});

/**
 * Perform one note-menu action.
 *
 * Every branch re-resolves its own path rather than trusting one the renderer
 * sends back: the menu may have been open for a while, and `delete` in
 * particular must never act on a path this process has not just checked.
 */
ipcMain.handle('panel:noteAction', async (event, payload) => {
  try {
    const { action, sessionDir, notePath } = payload || {};
    if (!NOTE_MENU_ACTIONS.includes(action)) {
      return ipcFail(new Error(`Unknown note action: ${action}`));
    }

    // Close first in every case. The delete branch raises a native confirm
    // dialog, and a popover that closes the instant the dialog takes focus
    // would yank the menu out from under the question being asked.
    closeMenubarPanel();

    if (action === 'delete') {
      const dir = sessionDir && fs.existsSync(sessionDir) ? sessionDir : null;
      if (!dir) return ipcFail(new Error('Session not found'));
      confirmAndDeleteSession(dir).catch((err) => console.error('Delete failed:', err));
      return ipcOk();
    }

    if (action === 'revealTranscript' || action === 'copyTranscriptPath') {
      const transcript = sessionDir && fs.existsSync(sessionDir)
        ? mergedTranscriptFor(sessionDir)
        : null;
      if (!transcript) return ipcFail(new Error('Transcript not found'));
      // The Option-key variant: Finder's "Copy as Pathname". Plain text, the
      // absolute POSIX path — what a terminal or an Obsidian link wants.
      if (action === 'copyTranscriptPath') clipboard.writeText(transcript);
      else shell.showItemInFolder(transcript);
      return ipcOk();
    }

    if (!notePath || !fs.existsSync(notePath)) return ipcFail(new Error('Note not found'));

    if (action === 'copyNotePath') {
      clipboard.writeText(notePath);
      return ipcOk();
    }

    if (action === 'revealNote') {
      shell.showItemInFolder(notePath);
      return ipcOk();
    }

    // 'open'
    openArtefact(notePath).catch((err) => console.error('Open note failed:', err));
    return ipcOk();
  } catch (err) {
    console.error('panel:noteAction failed:', err);
    return ipcFail(err);
  }
});

ipcMain.handle('panel:resize', async (event, height) => {
  if (!menubarPanelWindow || menubarPanelWindow.isDestroyed()) return { success: false };
  const clamped = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, Math.round(height) || PANEL_DEFAULT_HEIGHT));
  const bounds = menubarPanelWindow.getBounds();
  if (bounds.height !== clamped) {
    menubarPanelWindow.setBounds({ ...bounds, height: clamped });
    positionMenubarPanel(menubarPanelWindow);
  }
  return ipcOk();
});

ipcMain.handle('panel:close', async () => {
  closeMenubarPanel();
  return ipcOk();
});

ipcMain.handle('panel:quit', async () => {
  closeMenubarPanel();
  app.quit();
  return ipcOk();
});

ipcMain.handle('calendar:getPermissionState', async () => {
  if (!calendarSuggester) return 'not-determined';
  return calendarSuggester.getPermissionState();
});

ipcMain.handle('calendar:requestPermission', async () => {
  if (!calendarSuggester) return { state: 'not-determined' };
  try {
    const source = calendarSuggester.getSource();
    const state = await source.ensurePermission();
    return { state };
  } catch (err) {
    return { state: 'denied', error: err.message };
  }
});

ipcMain.handle('calendar:openPrivacySettings', async () => {
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars');
  return ipcOk();
});

// Recording Controls
ipcMain.handle('recording:start', async () => {
  try {
    // Suspend meeting detection and calendar suggestions for the duration of the recording
    if (meetingDetector) meetingDetector.stop();
    if (calendarSuggester) calendarSuggester.stop();
    closeMeetingBanner(false);

    const mode = store.get('recordingMode');
    const useDual = mode === 'dual' && dualRecorder;

    if (useDual) {
      const result = dualRecorder.start((warning) => { console.warn(warning); });
      tray.setToolTip('CXNotes • Recording');
      updateTrayMenu();
      startLevelMonitor(true);
      return { success: true, sessionDir: result.sessionDir };
    } else {
      const result = recorder.start((warning) => { console.warn(warning); });
      currentRecordingPath = result.filepath;
      tray.setToolTip('CXNotes • Recording');
      updateTrayMenu();
      startLevelMonitor(false);
      return { success: true, filepath: result.filepath };
    }
  } catch (err) {
    console.error('IPC recording:start failed:', err);
    // Recording didn't start — resume detection and calendar suggestions
    startMeetingDetectorIfEnabled();
    startCalendarSuggesterIfEnabled();
    return ipcFail(err);
  }
});

ipcMain.handle('recording:stop', async () => {
  // The single guarded stop path owns interval cleanup, detection/suggester
  // resume, tray, renderer notifications, and auto-processing. This handler only
  // shapes the result for the renderer's invoke() caller.
  const result = await stopRecording('settings-window');

  if (!result.success) {
    return { success: false, error: result.error, skipped: result.skipped };
  }

  if (result.mode === 'dual') {
    return {
      success: true,
      sessionDir: result.sessionDir,
      duration: result.duration,
      systemSize: result.systemSize,
      micSize: result.micSize
    };
  }

  return {
    success: true,
    filepath: result.filepath,
    duration: result.duration,
    size: result.size
  };
});

ipcMain.handle('recording:status', async () => {
  const mode = store.get('recordingMode');
  const useDual = mode === 'dual' && dualRecorder;

  if (useDual && dualRecorder.isRecording) {
    const status = dualRecorder.getStatus();
    return {
      isRecording: true,
      mode: 'dual',
      duration: status.duration,
      startTime: dualRecorder.startTime,
      tracks: status.tracks
    };
  }

  if (recorder && recorder.isRecording) {
    const status = recorder.getStatus();
    return {
      isRecording: true,
      mode: 'system',
      duration: status.duration,
      startTime: recorder.startTime
    };
  }

  return { isRecording: false };
});

ipcMain.handle('processing:status', async () => {
  return processingState; // null if idle, { path, stage, progress, message } if active
});

// Session Reprocessing
ipcMain.handle('session:reprocess', async (event, sessionDir) => {
  try {
    if (!fs.existsSync(sessionDir)) {
      return { success: false, error: 'Session directory not found' };
    }

    const manifestPath = path.join(sessionDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { success: false, error: 'Session manifest not found' };
    }

    // Clear previous error from manifest before retrying
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (manifest.processing) {
      delete manifest.processing.error;
      delete manifest.processing.failedAt;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    }

    // Run processing (fire-and-forget with error handling)
    processSession(sessionDir, null).catch(err => {
      console.error('Reprocessing failed:', err);
    });

    return ipcOk();
  } catch (err) {
    console.error('IPC session:reprocess failed:', err);
    return ipcFail(err);
  }
});

/**
 * Regenerate notes only — reuses the existing transcript, skipping whisper.
 *
 * Returns `needsFullReprocess` rather than silently escalating, so the caller
 * can tell the user why the cheap path is unavailable instead of kicking off
 * a surprise hour-long job.
 */
ipcMain.handle('session:resummarise', async (event, sessionDir) => {
  try {
    if (!fs.existsSync(sessionDir)) {
      return { success: false, error: 'Session directory not found' };
    }

    const manifestPath = path.join(sessionDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { success: false, error: 'Session manifest not found' };
    }

    const merged = reusableTranscriptFor(sessionDir);
    if (!merged) {
      return {
        success: false,
        needsFullReprocess: true,
        error: 'No usable transcript for this session — a full reprocess is required.'
      };
    }

    resummariseSession(sessionDir, merged).catch(err => {
      console.error('Re-summarisation failed:', err);
    });

    return ipcOk();
  } catch (err) {
    console.error('IPC session:resummarise failed:', err);
    return ipcFail(err);
  }
});

// Audio Configuration
ipcMain.handle('audio:listInputDevices', async () => {
  return listInputDevices();
});

ipcMain.handle('audio:preflight', async () => {
  const checks = [];
  const mode = store.get('recordingMode');

  // Check sox (see the note in checkDependencies — never `which`)
  const soxOk = Boolean(resolveBinaryCached('sox'));
  checks.push(soxOk
    ? { name: 'sox', pass: true, message: 'sox is installed and available' }
    : { name: 'sox', pass: false, message: 'sox not found. Install with: brew install sox' });

  // Check system audio capture (ScreenCaptureKit — the only route)
  const sckPath = getSckBinaryPath();
  const sckCheck = checkSckAvailable(sckPath);

  if (sckCheck.available && sckCheck.permitted) {
    checks.push({ name: 'System Audio', pass: true, message: 'ScreenCaptureKit — system audio capture ready' });
  } else if (sckCheck.available && sckCheck.permitted === false) {
    checks.push({ name: 'System Audio', pass: false, message: 'Screen Recording permission required. Open System Settings > Privacy & Security > Screen Recording.' });
  } else if (!sckPath) {
    checks.push({ name: 'System Audio', pass: false, message: 'sck-audio-capture helper not found. Build it with: npm run build:native' });
  } else {
    checks.push({ name: 'System Audio', pass: false, message: `ScreenCaptureKit unavailable: ${sckCheck.reason || 'unknown'}. Requires macOS 13 or later.` });
  }

  // Check mic (if dual mode)
  if (mode === 'dual') {
    const micDevice = resolveMicDevice();
    if (micDevice) {
      checks.push({ name: 'Microphone', pass: true, message: `Mic device: ${micDevice}` });
    } else {
      checks.push({ name: 'Microphone', pass: false, message: 'No microphone detected. Check System Preferences > Sound.' });
    }
  }

  // Check transcription — Parakeet (via uv) is the default backend, whisper.cpp
  // only the fallback, so either one passing means transcription works.
  const preflightUv = findUv();
  const whisperCheck = verifyWhisper();
  const transcriptionOk = Boolean(preflightUv) || whisperCheck.installed;
  let transcriptionMessage;
  if (preflightUv) {
    transcriptionMessage = whisperCheck.installed
      ? 'Parakeet ready (whisper.cpp fallback also available)'
      : 'Parakeet ready (via uv)';
  } else if (whisperCheck.installed) {
    transcriptionMessage = 'whisper.cpp binary and model found (uv missing, so no Parakeet)';
  } else {
    transcriptionMessage = whisperCheck.error || 'No transcriber found. Install uv (brew install uv) or whisper.cpp';
  }
  checks.push({
    name: 'Transcription',
    pass: transcriptionOk,
    message: transcriptionMessage
  });

  // Check AI summarisation (Codex or Claude CLI)
  const preflightCodex = isCodexAvailable();
  const preflightClaude = isClaudeAvailable();
  const aiOk = preflightCodex || preflightClaude;
  const aiProvider = preflightCodex ? 'Codex CLI' : 'Claude CLI';
  checks.push({
    name: 'AI Summarisation',
    pass: aiOk,
    message: aiOk
      ? `${aiProvider} available for note generation`
      : 'No AI provider found. Install Codex CLI or Claude CLI'
  });

  return checks;
});

// File Management
ipcMain.handle('files:list', async () => {
  try {
    const outputDir = store.get('outputDirectory');
    return buildRecordingsList(
      {
        recordingsDir: path.join(outputDir, 'recordings'),
        processedDir: path.join(outputDir, 'processed')
      },
      {
        fsImpl: fs,
        isPoisoned: detectPoisonedNote,
        hasReusableTranscript: reusableTranscriptFor
      }
    );
  } catch (err) {
    console.error('IPC files:list failed:', err);
    return [];
  }
});

ipcMain.handle('files:stats', async () => {
  try {
    return toStorageSummary(getStorageStats(store.get('outputDirectory')));
  } catch (err) {
    console.error('IPC files:stats failed:', err);
    return { ...EMPTY_STORAGE_SUMMARY };
  }
});

ipcMain.handle('files:delete', async (event, filename) => {
  try {
    const recordingsDir = path.join(store.get('outputDirectory'), 'recordings');
    const processedDir = path.join(store.get('outputDirectory'), 'processed');
    const deletedFiles = [];

    console.log(`[Delete] user deleted from the recordings list: ${filename}`);
    if (filename.endsWith('_session')) {
      // Delete session directory
      const sessionPath = path.join(recordingsDir, filename);
      if (fs.existsSync(sessionPath)) {
        // Read manifest for session ID
        const manifestPath = path.join(sessionPath, 'manifest.json');
        let sessionId = filename.replace('_session', '');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          sessionId = manifest.sessionId;
        }

        fs.rmSync(sessionPath, { recursive: true, force: true });
        deletedFiles.push(filename);

        // Delete processed session dir
        const sessionProcessedDir = path.join(processedDir, `${sessionId}_session`);
        if (fs.existsSync(sessionProcessedDir)) {
          fs.rmSync(sessionProcessedDir, { recursive: true, force: true });
          deletedFiles.push(`${sessionId}_session (processed)`);
        }
      }
    } else {
      // Delete single WAV file
      const basename = path.basename(filename, '.wav');

      const wavPath = path.join(recordingsDir, filename);
      if (fs.existsSync(wavPath)) {
        fs.unlinkSync(wavPath);
        deletedFiles.push(filename);
      }

      const transcriptPath = path.join(processedDir, `${basename}_transcript.txt`);
      if (fs.existsSync(transcriptPath)) {
        fs.unlinkSync(transcriptPath);
        deletedFiles.push(`${basename}_transcript.txt`);
      }

      const notesPath = path.join(processedDir, `${basename}_notes.md`);
      if (fs.existsSync(notesPath)) {
        fs.unlinkSync(notesPath);
        deletedFiles.push(`${basename}_notes.md`);
      }
    }

    return { success: true, deletedFiles };
  } catch (err) {
    console.error('IPC files:delete failed:', err);
    return ipcFail(err);
  }
});

ipcMain.handle('files:cleanup', async () => {
  try {
    const deleted = cleanupOldRecordings(
      store.get('outputDirectory'),
      store.get('retentionDays')
    );

    return {
      success: true,
      deletedCount: deleted.length,
      deletedFiles: deleted,
      freedSpace: 0
    };
  } catch (err) {
    console.error('IPC files:cleanup failed:', err);
    return ipcFail(err);
  }
});

ipcMain.handle('files:open', async (event, filepath) => {
  try {
    // Markdown routes to Obsidian (in-vault) or a plain editor (outside it);
    // audio and transcripts keep the system default. See openArtefact().
    return await openArtefact(filepath);
  } catch (err) {
    console.error('IPC files:open failed:', err);
    return ipcFail(err);
  }
});

// Processing
ipcMain.handle('process:transcribe', async (event, wavPath) => {
  try {
    const outputDir = store.get('outputDirectory');
    const transcriptPath = await transcribe(wavPath, outputDir, (progress) => {
      broadcastProgress(wavPath, 'Transcribing', progress, `Processing audio: ${progress}%`);
    });

    return { success: true, transcriptPath };
  } catch (err) {
    console.error('IPC process:transcribe failed:', err);
    return ipcFail(err);
  }
});

ipcMain.handle('process:summarise', async (event, transcriptPath) => {
  try {
    const notesPath = await generateNotes(transcriptPath, (progress) => {
      broadcastProgress(transcriptPath, 'Summarising', Math.min(95, progress), `Generating notes... (${progress}%)`);
    }, llmOptions());

    const { obsidianPath } = await fileAndExportNotes(notesPath, {
      title: buildSingleTrackNoteTitle(transcriptPath),
      startTime: getFileStartTime(transcriptPath)
    });

    return { success: true, notesPath, obsidianPath };
  } catch (err) {
    console.error('IPC process:summarise failed:', err);
    return ipcFail(err);
  }
});

ipcMain.handle('process:full', async (event, wavPathOrSessionDir) => {
  try {
    const outputDir = store.get('outputDirectory');

    // Detect if this is a session directory or a flat WAV file
    if (fs.existsSync(path.join(wavPathOrSessionDir, 'manifest.json'))) {
      // Session directory - use dual-track pipeline. The manifest is read by
      // summariseAndFileSession itself, after transcribeSession updates it.
      const transcripts = await transcribeSession(wavPathOrSessionDir, outputDir, (progress) => {
        broadcastProgress(wavPathOrSessionDir, 'Transcribing', progress, `Processing dual tracks: ${progress}%`);
      });

      // Shared with processSession/resummariseSession — this path used to
      // inline its own copy, which silently skipped the marker folding
      // (invariant #16) and dropped flagged moments from the prompt.
      const { notesPath, obsidianPath } = await summariseAndFileSession(
        wavPathOrSessionDir,
        transcripts.mergedTranscript
      );

      broadcastComplete();

      return { success: true, mergedTranscript: transcripts.mergedTranscript, notesPath, obsidianPath };
    } else {
      // Single WAV file - use original pipeline
      const transcriptPath = await transcribe(wavPathOrSessionDir, outputDir, (progress) => {
        broadcastProgress(wavPathOrSessionDir, 'Transcribing', progress, `Processing audio: ${progress}%`);
      });

      broadcastProgress(wavPathOrSessionDir, 'Summarising', 0, 'Generating notes...');

      const notesPath = await generateNotes(transcriptPath, (progress) => {
        broadcastProgress(wavPathOrSessionDir, 'Summarising', Math.min(95, progress), `Generating notes... (${progress}%)`);
      }, llmOptions());

      const { obsidianPath } = await fileAndExportNotes(notesPath, {
        title: buildSingleTrackNoteTitle(transcriptPath),
        startTime: getFileStartTime(wavPathOrSessionDir)
      });

      broadcastComplete();

      return { success: true, transcriptPath, notesPath, obsidianPath };
    }
  } catch (err) {
    console.error('IPC process:full failed:', err);
    broadcastComplete(err.message);
    return ipcFail(err);
  }
});

// Settings
ipcMain.handle('settings:get', async () => {
  return {
    outputDirectory: store.get('outputDirectory'),
    retentionDays: store.get('retentionDays'),
    autoProcess: store.get('autoProcess'),
    recordingMode: store.get('recordingMode'),
    micDevice: store.get('micDevice'),
    systemLabel: store.get('systemLabel'),
    micLabel: store.get('micLabel'),
    meetingContext: store.get('meetingContext'),
    meetingDetectionEnabled: store.get('meetingDetectionEnabled'),
    calendarSuggestionsEnabled: store.get('calendarSuggestionsEnabled'),
    calendarAutoTemplateEnabled: store.get('calendarAutoTemplateEnabled'),
    calendarLeadTimeMinutes: store.get('calendarLeadTimeMinutes'),
    calendarDenylist: store.get('calendarDenylist'),
    calendarSource: store.get('calendarSource'),
    cxmailCalendarMinConfidence: store.get('cxmailCalendarMinConfidence'),
    silenceAutoStopEnabled: store.get('silenceAutoStopEnabled'),
    silenceAutoStopMinutes: store.get('silenceAutoStopMinutes'),
    vaultAutoFilingEnabled: store.get('vaultAutoFilingEnabled'),
    vaultFilingRules: store.get('vaultFilingRules'),
    // Both must be returned: the settings window saves every toggle it shows,
    // so a key missing here reads as unchecked and is written back as false —
    // which silently switched slide capture off on every save until 2026-09-25.
    slideCaptureEnabled: store.get('slideCaptureEnabled') === true,
    callCaptureEnabled: store.get('callCaptureEnabled') === true,
    llmProvider: normalisePreference(store.get('llmProvider')),
    llmProviderStrict: store.get('llmProviderStrict') === true,
    llmModels: store.get('llmModels') || {},
    // Shipped with the settings so the UI can label each option "installed" /
    // "not found" — choosing a provider you do not have should be a visible
    // mistake at the moment you make it, not a failure after the next meeting.
    llmProviders: describeProviders(),
    windowTransparency: currentTransparency(),
    // getVaultDirectory() (not store.get) so the settings window triggers and
    // then shows the one-time detection, instead of rendering a blank field.
    vaultDirectory: getVaultDirectory() || '',
    vaultStatus: describeVault(getVaultDirectory())
  };
});

/**
 * Preview a dial position on every window WITHOUT persisting it.
 *
 * The slider is judged by looking at the app, not at the number, so the whole
 * point is that the panel and any open banner move with the drag. Writing to
 * the store per frame would be a write per pixel and would leave a half-dragged
 * value behind if the window were closed mid-gesture; the renderer saves once,
 * on release, through `settings:update`.
 */
ipcMain.handle('glass:preview', async (event, transparency) => {
  const t = normaliseTransparency(transparency);
  const style = glassStyleText(t);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents
      .executeJavaScript(`document.documentElement.style.cssText = ${JSON.stringify(style)};`, true)
      .catch(() => {});
  }
  return ipcOk();
});

ipcMain.handle('settings:update', async (event, settings) => {
  try {
    // What may be written, and what each value becomes, is declared in
    // services/settingsSchema.js. A rejected value leaves the stored one alone.
    const { accepted, rejected, unknown } = coerceSettings(settings, LLM_PROVIDER_IDS);
    for (const [key, value] of Object.entries(accepted)) store.set(key, value);
    if (rejected.length) console.warn(`settings:update ignored invalid: ${rejected.join(', ')}`);
    if (unknown.length) console.warn(`settings:update ignored unknown: ${unknown.join(', ')}`);

    const changed = (key) => key in accepted;

    // Side effects. Each one applies a setting to something already running, so
    // the change takes hold without an app restart.
    if (changed('meetingDetectionEnabled') && meetingDetector) {
      if (accepted.meetingDetectionEnabled) {
        startMeetingDetectorIfEnabled();
      } else {
        meetingDetector.stop();
        closeMeetingBanner(false);
      }
    }

    if (changed('calendarSuggestionsEnabled') && calendarSuggester) {
      if (accepted.calendarSuggestionsEnabled) {
        startCalendarSuggesterIfEnabled();
      } else {
        calendarSuggester.stop();
        // Drop the tray "Upcoming" section — no more polls will refresh it.
        cachedUpcomingMeetings = [];
        updateTrayMenu();
      }
    }

    // Bounce the suggester so a new source takes effect immediately. No
    // recorder involvement, so invariant #11 is untouched.
    if (changed('calendarSource')
        && calendarSuggester
        && store.get('calendarSuggestionsEnabled')
        && !isRecordingActive()) {
      calendarSuggester.stop();
      startCalendarSuggesterIfEnabled();
    }

    if (changed('windowTransparency')) broadcastGlass();

    if (changed('callCaptureEnabled') && accepted.callCaptureEnabled) requestCallAudioAccess();

    // Live-apply silence settings to an in-flight watcher; otherwise the new
    // values simply take effect on the next recording.
    if (silenceWatcher) {
      if (changed('silenceAutoStopMinutes')) {
        silenceWatcher.requiredSilenceMs = accepted.silenceAutoStopMinutes * 60000;
      }
      // Disabled mid-recording: tear the watcher and any open prompt down so it
      // cannot fire.
      if (accepted.silenceAutoStopEnabled === false) {
        closeSilencePrompt({ cancelTimer: true });
        silenceWatcher = null;
      }
    }

    // Reinitialising mid-recording would orphan the live capture processes, so
    // it is deferred to the next start (invariant #11). Mode/mic/output/label
    // changes cannot safely apply mid-recording anyway.
    if (!isRecordingActive()) {
      initRecorder();
    } else {
      console.log('settings:update — skipping initRecorder() while a recording is active');
    }

    return ipcOk();
  } catch (err) {
    console.error('IPC settings:update failed:', err);
    return ipcFail(err);
  }
});

ipcMain.handle('settings:reset', async () => {
  try {
    store.clear();
    initRecorder();
    return ipcOk();
  } catch (err) {
    console.error('IPC settings:reset failed:', err);
    return ipcFail(err);
  }
});

// System Information
ipcMain.handle('system:dependencies', async () => {
  const status = checkDependencies();
  return {
    sox: status.sox,
    parakeet: status.parakeet,
    whisper: status.whisper,
    transcription: status.transcription,
    codex: status.codex,
    systemAudio: status.systemAudio,
    mic: status.mic
  };
});

ipcMain.handle('system:version', async () => {
  return app.getVersion();
});

ipcMain.handle('system:chooseOutputDir', async () => {
  try {
    const result = await dialog.showOpenDialog(settingsWindow || undefined, {
      title: 'Choose Output Folder',
      defaultPath: store.get('outputDirectory'),
      buttonLabel: 'Choose Folder',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    return { canceled: false, path: result.filePaths[0] };
  } catch (err) {
    console.error('IPC system:chooseOutputDir failed:', err);
    return { canceled: true, error: err.message };
  }
});

ipcMain.handle('system:chooseVaultDir', async () => {
  try {
    // Default into the current vault when there is one, else the user's
    // Documents folder — where Obsidian itself proposes creating vaults.
    const current = getVaultDirectory();
    const result = await dialog.showOpenDialog(settingsWindow || undefined, {
      title: 'Choose Obsidian Vault Folder',
      defaultPath: current && fs.existsSync(current) ? current : app.getPath('documents'),
      buttonLabel: 'Choose Vault',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    // Report whether the chosen folder actually carries a `.obsidian` marker so
    // the UI can warn without blocking — a plain folder is a legitimate export
    // target, it just isn't a vault Obsidian will open.
    const chosen = result.filePaths[0];
    return { canceled: false, path: chosen, status: describeVault(chosen) };
  } catch (err) {
    console.error('IPC system:chooseVaultDir failed:', err);
    return { canceled: true, error: err.message };
  }
});

/**
 * Vaults Obsidian itself knows about — powers the "Detect" affordance for a
 * user who cleared the field or never had one detected.
 */
ipcMain.handle('system:detectVaultDir', async () => {
  try {
    const detected = detectVaultDirectory({ preferPaths: [LEGACY_VAULT_DIRECTORY] });
    return { path: detected, status: describeVault(detected) };
  } catch (err) {
    console.error('IPC system:detectVaultDir failed:', err);
    return { path: null, status: describeVault(null), error: err.message };
  }
});

ipcMain.handle('dialog:confirm', async (event, options = {}) => {
  try {
    const response = await dialog.showMessageBox(settingsWindow || undefined, {
      type: options.destructive ? 'warning' : 'question',
      buttons: [options.confirmLabel || 'Continue', options.cancelLabel || 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: options.title || 'Confirm',
      message: options.message || 'Are you sure?',
      detail: options.detail || ''
    });

    return { confirmed: response.response === 0 };
  } catch (err) {
    console.error('IPC dialog:confirm failed:', err);
    return { confirmed: false, error: err.message };
  }
});

ipcMain.handle('system:requestScreenCapturePermission', async () => {
  const sckPath = getSckBinaryPath();
  const sckCheck = checkSckAvailable(sckPath);

  if (sckCheck.available && sckCheck.permitted) {
    return { success: true, message: 'Permission already granted' };
  }

  if (!sckCheck.available) {
    return { success: false, message: sckCheck.reason || 'ScreenCaptureKit not available' };
  }

  // Show dialog prompting the user to grant permission
  const response = await dialog.showMessageBox({
    type: 'info',
    title: 'Screen Recording Permission Required',
    message: 'CXNotes needs Screen Recording permission to capture system audio.',
    detail: 'This is the only way CXNotes can record the other side of a call.\n\n' +
            'Click "Open System Settings" to grant permission, then restart the app.',
    buttons: ['Open System Settings', 'Cancel'],
    defaultId: 0
  });

  if (response.response === 0) {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }

  return { success: false, message: 'Permission not yet granted' };
});

ipcMain.handle('system:openOutputDir', async () => {
  try {
    await shell.openPath(store.get('outputDirectory'));
    return ipcOk();
  } catch (err) {
    console.error('IPC system:openOutputDir failed:', err);
    return ipcFail(err);
  }
});

/**
 * App lifecycle: Ready
 */
app.whenReady().then(() => {
  console.log('CXNotes starting...');
  console.log(`Electron version: ${process.versions.electron}`);
  console.log(`Node version: ${process.versions.node}`);
  console.log(`Recording mode: ${store.get('recordingMode')}`);

  // Hide dock icon — menu bar only app
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  // Initialize recorder and tray
  initRecorder();
  createTray();

  // Check dependencies on startup, then refresh tray menu with results
  const deps = checkDependencies();
  updateTrayMenu();

  // Run cleanup on startup
  runCleanup();

  // Start the meeting detector + calendar suggester (each gates on its own setting)
  initMeetingAndCalendar();

  console.log('CXNotes ready. Click the menu bar icon to start recording.');

  // Show welcome message if dependencies are missing. Transcription is judged
  // across BOTH backends — a Parakeet-only machine transcribes fine and must
  // not be nagged about a missing whisper.cpp it will never use.
  if (!deps.sox || !deps.transcription) {
    setTimeout(() => {
      const response = dialog.showMessageBoxSync({
        type: 'info',
        title: 'Welcome to CXNotes',
        message: 'Setup Required',
        detail: 'Some things CXNotes needs are not installed. Run the setup script now?\n\n' +
               'This will install:\n- sox (audio recording)\n- Parakeet via uv (transcription; whisper.cpp as fallback)\n\n' +
               `AI summarisation installs separately — any one of:\n${providerInstallLines('- ')}`,
        buttons: ['Run Setup', 'Check Status', 'Skip'],
        defaultId: 0
      });

      if (response === 0) {
        runSetupScript();
      } else if (response === 1) {
        showDependencyStatus();
      }
    }, 1000);
  }
});

/**
 * Every window closed — stay alive anyway.
 * A menu-bar app outlives its windows, so do not quit here.
 */
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

/**
 * App lifecycle: Before quit
 * Kill every child process we spawned.
 */
let shutdownStarted = false;

app.on('before-quit', (event) => {
  // Second pass, after the async teardown finished — let the quit proceed.
  if (shutdownStarted) return;

  // before-quit is synchronous, so without deferring, the app exits the instant
  // after signalling its children and anything slow to die is orphaned
  // (invariant #3). The recorders below kill their own sox outright, so this is
  // about the helper processes: sqlite3 against cxmail's store, calendar-helper,
  // `open`, and the audio post-processing — a stuck one of those survives the
  // app and there is nothing left to reap it.
  event.preventDefault();
  shutdownStarted = true;

  console.log('App quitting, cleaning up...');

  // Stop the meeting detector and calendar suggester
  if (meetingDetector) meetingDetector.stop();
  if (calendarSuggester) calendarSuggester.stop();
  closeMeetingBanner(false);
  closeMenubarPanel();

  // Release the global marker shortcut back to the system
  unregisterMarkerShortcut();

  // Stop level monitor
  stopLevelMonitor();

  // Stop recording if active
  if (recorder && recorder.isRecording) {
    console.log('Stopping active system recording...');
    recorder.cleanup();
  }

  if (dualRecorder && dualRecorder.isRecording) {
    console.log(`[Recording] stop requested: reason=app-quit — ${dualRecorder.sessionDir || 'session'} is kept on disk, not processed`);
    dualRecorder.cleanup();
  }

  // SIGTERM, wait, then SIGKILL whatever ignored it. The wait is what lets the
  // ScreenCaptureKit helper finalise its WAV header — killed outright it leaves
  // a file every player reads as zero-length.
  childProcesses
    .shutdown()
    .then(({ termed, killed }) => {
      console.log(`Cleaned up ${termed} child process(es), ${killed} needed SIGKILL.`);
    })
    .catch((err) => {
      console.error('Cleanup did not finish cleanly:', err);
    })
    .finally(() => app.quit());
});

/**
 * Refuse to run twice — two recorders would fight over the microphone.
 */
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('CXNotes is already running — leaving the first instance alone.');
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('Second launch attempt — focusing the running instance instead.');
    if (tray) {
      showNotification('CXNotes', 'Already running in menu bar');
    }
  });
}
