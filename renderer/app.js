/**
 * CXNotes - Renderer Process
 *
 * Behaviour for the settings window.
 * Talks to the main process only through the preload bridge.
 */

// API is exposed via preload.js
const api = window.meetingRecorder;

// State
let currentSettings = {};
let lastDeps = null; // Last dependency-check result, for the focus re-check below
let recordings = [];
let currentProcessingPath = null; // Path of the recording/session currently being processed
let manualProcessingActive = false; // True when user explicitly clicked Process/Reprocess (show overlay)

/* ── Initialization ──────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  console.log('Settings window ready.');

  // Load initial data
  await loadSettings();
  await loadDependencies();
  await loadMicDevices();
  await loadRecordings();
  await loadStorageStats();
  await loadVersion();

  // Setup event listeners
  setupEventListeners();

  // Setup IPC event listeners
  setupIPCListeners();

  // Setup keyboard shortcuts
  setupKeyboardShortcuts();

  // Check if a recording is already in progress
  await checkRecordingStatus();

  // Check if processing is already in progress (catch up with background work)
  await checkProcessingStatus();
});

/**
 * Explain the currently-selected vault folder underneath the field.
 *
 * Three distinct states, because they need three different responses from the
 * user: no vault at all (fine — notes stay local), a folder that isn't an
 * Obsidian vault (allowed, but Obsidian won't open the notes), and a healthy
 * vault. Missing/not-yet-created is only a warning: `exportNotesToObsidian`
 * creates the directory on first export.
 *
 * @param {{path: string|null, exists: boolean, isObsidianVault: boolean}|null} status
 */
function renderVaultStatus(status) {
  const el = document.getElementById('vault-status');
  if (!el) return;

  el.classList.remove('is-warning');
  if (!status || !status.path) {
    el.textContent = 'No vault set — notes are saved in the recordings folder only.';
    return;
  }
  if (!status.exists) {
    el.textContent = 'That folder does not exist yet — it will be created on the first export.';
    el.classList.add('is-warning');
    return;
  }
  if (!status.isObsidianVault) {
    el.textContent = 'No .obsidian folder here — notes will export, but Obsidian will not open them.';
    el.classList.add('is-warning');
    return;
  }
  el.textContent = 'Obsidian vault detected.';
}

/**
 * Populate the AI-provider select, the strict toggle, and the model overrides.
 *
 * Options are labelled with what is actually installed, so picking a provider
 * you do not have is a visible mistake now rather than a failed summary after
 * the next meeting. The list itself comes from main (services/llmProviders.js)
 * — the renderer never hard-codes provider names.
 */
function renderLlmProviders(settings) {
  const select = document.getElementById('llm-provider');
  const providers = Array.isArray(settings.llmProviders) ? settings.llmProviders : [];
  if (!select) return;

  const autoChain = providers.filter((p) => p.available).map((p) => p.label).join(' → ');
  select.innerHTML = '';

  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = autoChain ? `Automatic (${autoChain})` : 'Automatic (none installed)';
  select.appendChild(auto);

  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.label}${p.available ? '' : ' — not installed'}`;
    select.appendChild(opt);
  }
  select.value = settings.llmProvider || 'auto';

  const strict = document.getElementById('llm-provider-strict');
  if (strict) strict.checked = settings.llmProviderStrict === true;

  // Model overrides: one row per provider, placeholder = its pinned default.
  const rows = document.getElementById('llm-models-rows');
  if (rows) {
    rows.innerHTML = '';
    const models = settings.llmModels || {};
    for (const p of providers) {
      const row = document.createElement('div');
      row.className = 'input-with-button';
      const tag = document.createElement('span');
      tag.className = 'field-note';
      tag.style.minWidth = '64px';
      tag.textContent = p.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.id = `llm-model-${p.id}`;
      input.placeholder = p.defaultModel;
      input.value = models[p.id] || '';
      row.appendChild(tag);
      row.appendChild(input);
      rows.appendChild(row);
    }
  }

  renderLlmProviderStatus(settings);
  select.onchange = () => renderLlmProviderStatus(settings);
  if (strict) strict.onchange = () => renderLlmProviderStatus(settings);
}

/**
 * Explain, in the field note, what the current choice actually means —
 * including the two states worth warning about: a provider that is not
 * installed, and a choice that sends the transcript to an account.
 */
function renderLlmProviderStatus(settings) {
  const el = document.getElementById('llm-provider-status');
  const select = document.getElementById('llm-provider');
  if (!el || !select) return;

  const providers = Array.isArray(settings.llmProviders) ? settings.llmProviders : [];
  const strict = document.getElementById('llm-provider-strict');
  const isStrict = Boolean(strict && strict.checked);
  const choice = select.value;

  el.classList.remove('is-warning');

  if (choice === 'auto') {
    const installed = providers.filter((p) => p.available);
    if (!installed.length) {
      el.textContent = 'No provider installed — recordings still transcribe, but no summary is written.';
      el.classList.add('is-warning');
      return;
    }
    el.textContent = `Tries ${installed.map((p) => p.label).join(', then ')}.`;
    return;
  }

  const provider = providers.find((p) => p.id === choice);
  if (!provider) return;

  if (!provider.available) {
    el.textContent = `${provider.label} is not installed. ${provider.install}`;
    el.classList.add('is-warning');
    return;
  }

  const others = providers.filter((p) => p.id !== choice && p.available).map((p) => p.label);
  const privacy = provider.kind === 'local'
    ? 'Runs on this machine — the transcript never leaves it'
    : 'Sends the transcript to your own account';

  if (isStrict) {
    el.textContent = `${privacy}. No fallback: if ${provider.label} fails, no summary is written.`;
    return;
  }
  el.textContent = others.length
    ? `${privacy}. Falls back to ${others.join(', then ')} if it fails.`
    : `${privacy}. No other provider installed, so there is no fallback.`;
}

/* ── Data Loading ────────────────────────────────────────────── */

async function loadSettings() {
  try {
    currentSettings = await api.getSettings();
    console.log('Settings loaded:', currentSettings);

    // Update UI
    document.getElementById('output-directory').value = currentSettings.outputDirectory;
    document.getElementById('retention-days').value = currentSettings.retentionDays;
    document.getElementById('auto-process').checked = currentSettings.autoProcess;
    document.getElementById('meeting-detection-enabled').checked =
      currentSettings.meetingDetectionEnabled !== false;

    // Silence auto-stop fields
    const silenceToggle = document.getElementById('silence-autostop-enabled');
    if (silenceToggle) silenceToggle.checked = currentSettings.silenceAutoStopEnabled !== false;

    // Vault auto-filing (default true)
    const vaultFilingToggle = document.getElementById('vault-auto-filing-enabled');
    if (vaultFilingToggle) vaultFilingToggle.checked = currentSettings.vaultAutoFilingEnabled !== false;

    // Defaults OFF, so the check is against `=== true` rather than `!== false`
    // like the others — a screen-recording feature must never be on because
    // the setting was absent.
    const slideToggle = document.getElementById('slide-capture-enabled');
    if (slideToggle) slideToggle.checked = currentSettings.slideCaptureEnabled === true;
    const callToggle = document.getElementById('call-capture-enabled');
    if (callToggle) callToggle.checked = currentSettings.callCaptureEnabled === true;

    // AI provider — options are built from what main reports as installed.
    renderLlmProviders(currentSettings);

    // Window transparency. Main normalises this on the way out, so anything
    // non-finite has already become the default before it reaches here.
    const glassSlider = document.getElementById('window-transparency');
    if (glassSlider) {
      const t = Number(currentSettings.windowTransparency);
      glassSlider.value = Number.isFinite(t) ? t : 0.38;
      syncGlassFill(glassSlider);
    }

    // Vault location. An empty string is a real state ("no vault"), not a
    // missing setting, so it renders as the placeholder rather than a default.
    const vaultInput = document.getElementById('vault-directory');
    if (vaultInput) vaultInput.value = currentSettings.vaultDirectory || '';
    renderVaultStatus(currentSettings.vaultStatus);
    const silenceMinutes = document.getElementById('silence-autostop-minutes');
    if (silenceMinutes) {
      const m = Number(currentSettings.silenceAutoStopMinutes);
      silenceMinutes.value = Number.isFinite(m) ? m : 5;
    }

    // Calendar suggestion fields
    const calToggle = document.getElementById('calendar-suggestions-enabled');
    if (calToggle) calToggle.checked = currentSettings.calendarSuggestionsEnabled === true;

    const autoTemplateToggle = document.getElementById('calendar-auto-template-enabled');
    if (autoTemplateToggle) autoTemplateToggle.checked = currentSettings.calendarAutoTemplateEnabled === true;

    const leadInput = document.getElementById('calendar-lead-time');
    if (leadInput) {
      const lead = Number(currentSettings.calendarLeadTimeMinutes);
      leadInput.value = Number.isFinite(lead) ? lead : 2;
    }

    const denylistTextarea = document.getElementById('calendar-denylist');
    if (denylistTextarea) {
      const list = Array.isArray(currentSettings.calendarDenylist) ? currentSettings.calendarDenylist : [];
      denylistTextarea.value = list.join('\n');
    }

    await loadCalendarPermission();

    updateRetentionLabel(currentSettings.retentionDays);

    // Update recording mode toggle
    const mode = currentSettings.recordingMode || 'dual';
    setModeToggle(mode);

    // Update speaker labels
    if (currentSettings.systemLabel) {
      document.getElementById('system-label').value = currentSettings.systemLabel;
    }
    if (currentSettings.micLabel) {
      document.getElementById('mic-label').value = currentSettings.micLabel;
    }

    // Select mic device if saved
    if (currentSettings.micDevice) {
      const micSelect = document.getElementById('mic-device');
      // Will be set after devices load
      micSelect.dataset.savedDevice = currentSettings.micDevice;
    }
  } catch (err) {
    console.error('Could not read settings:', err);
    showError('Could not read your settings');
  }
}

async function loadCalendarPermission() {
  const statusEl = document.getElementById('calendar-permission-status');
  const requestBtn = document.getElementById('btn-calendar-request');
  const privacyBtn = document.getElementById('btn-calendar-privacy');
  if (!statusEl || !requestBtn || !privacyBtn) return;

  try {
    const state = await api.getCalendarPermissionState();
    applyCalendarPermissionState(state);
  } catch (err) {
    console.error('Failed to read calendar permission state:', err);
  }
}

function applyCalendarPermissionState(state) {
  const statusEl = document.getElementById('calendar-permission-status');
  const requestBtn = document.getElementById('btn-calendar-request');
  const privacyBtn = document.getElementById('btn-calendar-privacy');
  if (!statusEl || !requestBtn || !privacyBtn) return;

  let label = 'Status: not determined';
  let showRequest = true;
  let showPrivacy = false;

  if (state === 'granted') {
    label = 'Status: granted';
    showRequest = false;
    showPrivacy = false;
  } else if (state === 'denied') {
    label = 'Status: denied — open System Settings to grant access';
    showRequest = false;
    showPrivacy = true;
  } else {
    label = 'Status: not determined — click to request access';
    showRequest = true;
    showPrivacy = false;
  }

  statusEl.textContent = label;
  requestBtn.style.display = showRequest ? '' : 'none';
  privacyBtn.style.display = showPrivacy ? '' : 'none';
}

async function loadDependencies() {
  try {
    const deps = await api.checkDependencies();
    lastDeps = deps;
    console.log('Dependencies:', deps);

    updateStatusIcon('status-sox', deps.sox);
    // Transcription is OK when EITHER backend is present — Parakeet (via uv,
    // the default) or whisper.cpp (the fallback). The element id keeps its
    // historical name so the pane markup and CSS stay untouched.
    updateStatusIcon('status-whisper', deps.transcription);
    updateStatusIcon('status-codex', deps.codex);
    updateStatusIcon('status-system-audio', deps.systemAudio);
    updateStatusIcon('status-mic', deps.mic);
  } catch (err) {
    console.error('Failed to check dependencies:', err);
  }
}

async function loadMicDevices() {
  const select = document.getElementById('mic-device');
  try {
    const devices = await api.listInputDevices();
    console.log('Input devices:', devices);

    select.innerHTML = '';

    if (devices.length === 0) {
      select.innerHTML = '<option value="">No input devices found</option>';
      return;
    }

    // Filter out virtual/clutter devices
    const hiddenDevices = [
      'muse audio share', 'muse daw bridge', 'muse recording',
      'pro tools aggregate', 'pro tools audio bridge',
      'microsoft teams audio', 'zoomaudiodevice',
      'loopback audio'
    ];
    const visibleDevices = devices.filter(d =>
      !hiddenDevices.some(h => d.name.toLowerCase().includes(h))
    );

    // Add auto-detect option
    const autoOption = document.createElement('option');
    autoOption.value = '';
    autoOption.textContent = 'Auto-detect (default microphone)';
    select.appendChild(autoOption);

    // Add each visible device
    visibleDevices.forEach(device => {
      const option = document.createElement('option');
      option.value = device.name;
      option.textContent = `${device.name} (${device.channels}ch${device.isDefault ? ', default' : ''})`;
      select.appendChild(option);
    });

    // Restore saved selection
    const savedDevice = select.dataset.savedDevice || currentSettings.micDevice;
    if (savedDevice) {
      select.value = savedDevice;
    }
  } catch (err) {
    console.error('Failed to load mic devices:', err);
    select.innerHTML = '<option value="">Failed to load devices</option>';
  }
}

async function loadRecordings() {
  const list = document.getElementById('recordings-list');

  try {
    list.innerHTML = '<div class="loading">Loading recordings...</div>';

    recordings = await api.listRecordings();
    console.log(`Loaded ${recordings.length} recordings`);

    if (recordings.length === 0) {
      list.innerHTML = '<div class="empty-state">Nothing recorded yet.<br>Start one from the menu-bar icon.</div>';
      return;
    }

    // Render recordings
    list.innerHTML = recordings
      .map((rec, index) => renderRecordingItem(rec, { index, currentProcessingPath }))
      .join('');

    // Add event listeners
    recordings.forEach((rec, index) => {
      const deleteBtn = document.getElementById(`delete-${index}`);
      const openBtn = document.getElementById(`open-${index}`);
      const processBtn = document.getElementById(`process-${index}`);
      const reprocessBtn = document.getElementById(`reprocess-${index}`);
      const resummariseBtn = document.getElementById(`resummarise-${index}`);

      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => handleDeleteRecording(rec.filename));
      }

      if (openBtn) {
        openBtn.addEventListener('click', () => handleOpenFile(rec.filepath));
      }

      if (processBtn && !rec.transcribed) {
        processBtn.addEventListener('click', () => handleProcessRecording(rec.filepath));
      }

      if (resummariseBtn) {
        resummariseBtn.addEventListener('click', () => handleResummariseSession(rec.filepath));
      }

      if (reprocessBtn) {
        reprocessBtn.addEventListener('click', () => handleReprocessSession(rec.filepath));
      }
    });
  } catch (err) {
    console.error('Could not list recordings:', err);
    list.innerHTML = `
      <div class="empty-state">
        Failed to load recordings<br>
        <button class="btn btn-secondary" onclick="loadRecordings()">Retry</button>
      </div>
    `;
    showError('Could not list your recordings');
  }
}

async function loadStorageStats() {
  try {
    const stats = await api.getStorageStats();
    console.log('Storage stats:', stats);

    document.getElementById('stat-total-size').textContent = stats.totalSizeFormatted;
    document.getElementById('stat-audio-size').textContent = stats.audioSizeFormatted;
    document.getElementById('stat-generated-size').textContent = stats.generatedSizeFormatted;
    document.getElementById('stat-recordings').textContent = stats.recordingsCount;
    document.getElementById('stat-transcripts').textContent = stats.transcriptsCount;
    document.getElementById('stat-notes').textContent = stats.notesCount;
  } catch (err) {
    console.error('Could not measure storage:', err);
  }
}

async function loadVersion() {
  try {
    const version = await api.getVersion();
    document.getElementById('version').textContent = `v${version}`;
  } catch (err) {
    console.error('Could not read the app version:', err);
  }
}

/* ── UI Rendering ────────────────────────────────────────────── */

function updateStatusIcon(elementId, status) {
  const element = document.getElementById(elementId);
  if (!element) return;

  element.textContent = '';
  element.classList.remove('is-loading', 'is-ready', 'is-error');

  if (status === null || status === undefined) {
    element.classList.add('is-loading');
    element.setAttribute('aria-label', 'Checking');
  } else if (status === true) {
    element.classList.add('is-ready');
    element.setAttribute('aria-label', 'Available');
  } else {
    element.classList.add('is-error');
    element.setAttribute('aria-label', 'Unavailable');
  }
}

function updateRetentionLabel(days) {
  const label = document.getElementById('retention-days-value');
  label.textContent = `${days} day${days !== 1 ? 's' : ''}`;
}

function setModeToggle(mode) {
  const systemBtn = document.getElementById('mode-system');
  const dualBtn = document.getElementById('mode-dual');
  const micSettings = document.getElementById('mic-settings');

  if (mode === 'system') {
    systemBtn.classList.add('active');
    dualBtn.classList.remove('active');
    micSettings.classList.add('hidden');
  } else {
    systemBtn.classList.remove('active');
    dualBtn.classList.add('active');
    micSettings.classList.remove('hidden');
  }
}

/* ── Event Handlers ──────────────────────────────────────────── */

/**
 * Sidebar pane navigation. Panes are all present in the DOM at once (so every
 * loader can keep writing into its elements regardless of which pane is
 * visible) — only their visibility is toggled.
 */
function setupPaneNav() {
  const items = document.querySelectorAll('.nav-item');
  const panes = document.querySelectorAll('.pane');

  items.forEach((item) => {
    item.addEventListener('click', () => {
      const targetId = item.dataset.pane;
      if (!targetId) return;

      items.forEach((el) => el.classList.toggle('active', el === item));
      panes.forEach((pane) => pane.classList.toggle('active', pane.id === targetId));

      // Each pane scrolls from the top rather than inheriting the last position.
      const main = document.querySelector('main');
      if (main) main.scrollTop = 0;
    });
  });
}

/**
 * Paint the filled portion of the transparency track.
 *
 * A CSS custom property consumed by a gradient stop rather than a second
 * positioned element — one style write per frame, and nothing to keep in sync
 * with the thumb's position during a drag.
 */
function syncGlassFill(slider) {
  const pct = Math.round(Number(slider.value) * 100);
  slider.style.setProperty('--fill', `${pct}%`);
}

function setupEventListeners() {
  setupPaneNav();

  // Transparency slider. `input` previews across every open window without
  // writing anything down — a drag emits a value per frame and none of them
  // are a decision. The value is persisted by Save, like every other setting
  // in this window, so there is one consistent rule for what sticks.
  const glassSlider = document.getElementById('window-transparency');
  if (glassSlider) {
    glassSlider.addEventListener('input', (e) => {
      syncGlassFill(e.target);
      // Fire-and-forget: a dropped preview frame during a drag costs nothing,
      // and awaiting it would make the slider chase the IPC round trip.
      if (api.previewGlass) api.previewGlass(Number(e.target.value));
    });
  }

  // Retention days slider
  document.getElementById('retention-days').addEventListener('input', (e) => {
    updateRetentionLabel(e.target.value);
  });

  // Refresh dependencies
  document.getElementById('btn-refresh-deps').addEventListener('click', async () => {
    await loadDependencies();
  });

  // A transient enumeration blip can freeze a red status dot until a manual
  // refresh — re-check when the window regains focus, but only while something
  // is reported missing (the check blocks the main process, so it must not run
  // on every focus).
  window.addEventListener('focus', () => {
    if (lastDeps && Object.values(lastDeps).some((ok) => !ok)) {
      loadDependencies();
    }
  });

  // Refresh recordings list
  document.getElementById('btn-refresh-list').addEventListener('click', async () => {
    await loadRecordings();
  });

  // Cleanup old files
  document.getElementById('btn-cleanup').addEventListener('click', handleCleanup);

  // Open output directory
  document.getElementById('btn-open-output').addEventListener('click', async () => {
    await api.openOutputDirectory();
  });

  // Change output directory
  document.getElementById('btn-change-dir').addEventListener('click', async () => {
    const result = await api.chooseOutputDirectory();
    if (!result) {
      showError('Failed to open folder chooser');
      return;
    }

    if (result.error) {
      showError('Failed to choose folder: ' + result.error);
      return;
    }

    if (!result || result.canceled) {
      return;
    }

    document.getElementById('output-directory').value = result.path;
  });

  // Change vault directory
  document.getElementById('btn-change-vault').addEventListener('click', async () => {
    const result = await api.chooseVaultDirectory();
    if (!result) {
      showError('Failed to open folder chooser');
      return;
    }
    if (result.error) {
      showError('Failed to choose folder: ' + result.error);
      return;
    }
    if (result.canceled) {
      return;
    }

    document.getElementById('vault-directory').value = result.path;
    renderVaultStatus(result.status);
  });

  // Re-run detection. Matters for someone who installed Obsidian AFTER
  // CXNotes: the first-launch detection found nothing and persisted '', so
  // without this the only route back is browsing for the folder by hand.
  document.getElementById('btn-detect-vault').addEventListener('click', async () => {
    const result = await api.detectVaultDirectory();
    if (!result || !result.path) {
      showError('No Obsidian vault found — use Change to pick a folder.');
      return;
    }
    document.getElementById('vault-directory').value = result.path;
    renderVaultStatus(result.status);
  });

  // Clear the vault — an explicit "export nowhere", not a reset to a default.
  document.getElementById('btn-clear-vault').addEventListener('click', () => {
    document.getElementById('vault-directory').value = '';
    renderVaultStatus(null);
  });

  // Reset settings
  document.getElementById('btn-reset-settings').addEventListener('click', handleResetSettings);

  // Save settings
  document.getElementById('btn-save').addEventListener('click', handleSaveSettings);

  // Recording mode toggle
  document.getElementById('mode-system').addEventListener('click', () => {
    setModeToggle('system');
  });
  document.getElementById('mode-dual').addEventListener('click', () => {
    setModeToggle('dual');
  });

  // Refresh mic devices
  document.getElementById('btn-refresh-mics').addEventListener('click', async () => {
    await loadMicDevices();
    showInfo('Mic devices refreshed');
  });

  // Preflight check
  document.getElementById('btn-preflight').addEventListener('click', runPreflightCheck);

  // Calendar permission buttons
  const reqBtn = document.getElementById('btn-calendar-request');
  if (reqBtn) {
    reqBtn.addEventListener('click', async () => {
      try {
        const result = await api.requestCalendarPermission();
        const state = (result && result.state) || 'not-determined';
        applyCalendarPermissionState(state);
        if (state === 'granted') {
          showSuccess('Calendar access granted');
        } else if (state === 'denied') {
          showInfo('Calendar access denied — you can re-enable it in System Settings');
        }
      } catch (err) {
        console.error('Failed to request calendar permission:', err);
        showError('Failed to request calendar permission');
      }
    });
  }
  const privacyBtn = document.getElementById('btn-calendar-privacy');
  if (privacyBtn) {
    privacyBtn.addEventListener('click', async () => {
      try { await api.openCalendarPrivacySettings(); } catch (err) { console.error(err); }
    });
  }
}

let recordingTimerInterval = null;
let recordingStartTime = null;

function setupIPCListeners() {
  // Listen for recording state changes
  api.onRecordingUpdate((data) => {
    const indicator = document.getElementById('recording-indicator');
    const micMeter = document.getElementById('meter-mic');

    if (data.state === 'recording') {
      indicator.classList.remove('hidden');
      micMeter.classList.toggle('hidden', data.mode !== 'dual');
      recordingStartTime = data.startTime;
      startRecordingTimer();
    } else {
      indicator.classList.add('hidden');
      stopRecordingTimer();
    }
  });

  // Listen for audio level updates
  api.onRecordingLevels((levels) => {
    updateMeter('system', levels.system || 0);
    if (levels.mic !== undefined) {
      updateMeter('mic', levels.mic || 0);
    }
  });

  // Listen for processing progress
  api.onProcessingProgress((data) => {
    currentProcessingPath = data.path || null;
    // Only show the full-page overlay if user explicitly triggered processing (not background auto-process)
    if (manualProcessingActive) {
      showProcessingOverlay(data.stage, data.message, data.progress);
    }
    // Always update the inline badge on the recording item
    updateProcessingBadge();
  });

  // Listen for processing complete
  api.onProcessingComplete((data) => {
    currentProcessingPath = null;
    manualProcessingActive = false;
    hideProcessingOverlay();
    // Show error toast if processing failed
    if (data && data.error) {
      showError(`Processing failed: ${data.error.split('\n')[0]}`);
    }
  });

  // Listen for recordings list changes (auto-refresh after processing completes)
  api.onRecordingsChanged(() => {
    loadRecordings();
    loadStorageStats();
  });

  // Listen for errors
  api.onError((data) => {
    console.error('IPC Error:', data);
    showError(data.error);
    hideProcessingOverlay();
  });

  // Listen for notifications
  api.onNotification((data) => {
    console.log('Notification:', data);
    const type = data.type || 'info';
    showToast(data.message, type);
  });

  // Listen for companion mode status
  api.onCompanionModeStatus((data) => {
    const badge = document.getElementById('companion-badge');
    const providerName = document.getElementById('companion-provider-name');
    if (!badge) return;

    if (data.active) {
      if (providerName && data.provider) {
        providerName.textContent = data.provider.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  });
}

function updateMeter(track, level) {
  const fill = document.getElementById(`meter-fill-${track}`);
  if (!fill) return;

  const percent = Math.round(level * 100);
  fill.style.width = `${percent}%`;

  // Colour thresholds: green < 65%, yellow 65-85%, red > 85%
  fill.classList.remove('level-medium', 'level-hot');
  if (percent > 85) {
    fill.classList.add('level-hot');
  } else if (percent > 65) {
    fill.classList.add('level-medium');
  }
}

function startRecordingTimer() {
  stopRecordingTimer();
  const timerEl = document.getElementById('recording-timer');

  recordingTimerInterval = setInterval(() => {
    if (!recordingStartTime) return;
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    timerEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

async function checkRecordingStatus() {
  try {
    const status = await api.getRecordingStatus();
    if (status && status.isRecording) {
      const indicator = document.getElementById('recording-indicator');
      const micMeter = document.getElementById('meter-mic');
      indicator.classList.remove('hidden');
      micMeter.classList.toggle('hidden', status.mode !== 'dual');
      recordingStartTime = status.startTime;
      startRecordingTimer();
    }
  } catch (err) {
    console.error('Failed to check recording status:', err);
  }
}

async function checkProcessingStatus() {
  try {
    const status = await api.getProcessingStatus();
    if (status) {
      currentProcessingPath = status.path;
      // Re-render recordings to show "Processing..." badge (no overlay for background processing)
      await loadRecordings();
    }
  } catch (err) {
    console.error('Failed to check processing status:', err);
  }
}

function stopRecordingTimer() {
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
  recordingStartTime = null;
  const timerEl = document.getElementById('recording-timer');
  if (timerEl) timerEl.textContent = '00:00';
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl + S: Save settings
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      handleSaveSettings();
    }

    // Cmd/Ctrl + R: Refresh recordings
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
      e.preventDefault();
      loadRecordings();
      showInfo('Refreshing recordings...');
    }

    // Cmd/Ctrl + D: Check dependencies
    if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
      e.preventDefault();
      loadDependencies();
      showInfo('Checking dependencies...');
    }

    // Escape: Close any overlays
    if (e.key === 'Escape') {
      const overlay = document.getElementById('processing-overlay');
      if (!overlay.classList.contains('hidden')) {
        e.preventDefault();
      }
    }
  });
}

async function handleSaveSettings() {
  try {
    const activeMode = document.getElementById('mode-dual').classList.contains('active') ? 'dual' : 'system';
    const micDevice = document.getElementById('mic-device').value || null;

    // Calendar settings — collect (best-effort; UI elements always present in v1)
    const calToggle = document.getElementById('calendar-suggestions-enabled');
    const autoTemplateToggle = document.getElementById('calendar-auto-template-enabled');
    const calLead = document.getElementById('calendar-lead-time');
    const calDenylist = document.getElementById('calendar-denylist');
    const calendarSuggestionsEnabled = calToggle ? calToggle.checked : false;
    const calendarAutoTemplateEnabled = autoTemplateToggle ? autoTemplateToggle.checked : false;
    const calendarLeadTimeMinutes = calLead ? Math.max(0, Math.min(15, parseInt(calLead.value, 10) || 0)) : 2;
    const calendarDenylist = calDenylist
      ? calDenylist.value.split('\n').map(s => s.trim()).filter(Boolean)
      : [];

    // Silence auto-stop settings
    const silenceToggle = document.getElementById('silence-autostop-enabled');
    const silenceMinutesInput = document.getElementById('silence-autostop-minutes');
    const silenceAutoStopEnabled = silenceToggle ? silenceToggle.checked : true;
    const silenceAutoStopMinutes = silenceMinutesInput
      ? Math.max(1, Math.min(60, parseInt(silenceMinutesInput.value, 10) || 5))
      : 5;

    // Vault auto-filing
    const vaultFilingToggle = document.getElementById('vault-auto-filing-enabled');
    const vaultAutoFilingEnabled = vaultFilingToggle ? vaultFilingToggle.checked : true;
    const slideToggle = document.getElementById('slide-capture-enabled');
    const slideCaptureEnabled = slideToggle ? slideToggle.checked : false;
    const callToggle = document.getElementById('call-capture-enabled');
    const callCaptureEnabled = callToggle ? callToggle.checked : false;

    // AI provider. Model boxes are read off the rendered rows rather than a
    // fixed list, so adding a provider in llmProviders.js needs no change here.
    const providerSelect = document.getElementById('llm-provider');
    const llmProvider = providerSelect ? providerSelect.value : 'auto';
    const strictToggle = document.getElementById('llm-provider-strict');
    const llmProviderStrict = strictToggle ? strictToggle.checked : false;
    const llmModels = {};
    for (const input of document.querySelectorAll('[id^="llm-model-"]')) {
      const id = input.id.replace('llm-model-', '');
      const value = input.value.trim();
      if (value) llmModels[id] = value;
    }

    // Window transparency. Every drag has already been previewed live across
    // all windows; this is the one value that gets written down.
    const glassSlider = document.getElementById('window-transparency');
    const windowTransparency = glassSlider ? Number(glassSlider.value) : 0.38;

    const newSettings = {
      outputDirectory: document.getElementById('output-directory').value,
      retentionDays: parseInt(document.getElementById('retention-days').value),
      autoProcess: document.getElementById('auto-process').checked,
      meetingDetectionEnabled: document.getElementById('meeting-detection-enabled').checked,
      recordingMode: activeMode,
      micDevice: micDevice,
      systemLabel: document.getElementById('system-label').value || 'Remote',
      micLabel: document.getElementById('mic-label').value || 'Me',
      calendarSuggestionsEnabled,
      calendarAutoTemplateEnabled,
      calendarLeadTimeMinutes,
      calendarDenylist,
      silenceAutoStopEnabled,
      silenceAutoStopMinutes,
      vaultAutoFilingEnabled,
      slideCaptureEnabled,
      callCaptureEnabled,
      llmProvider,
      llmProviderStrict,
      llmModels,
      windowTransparency,
      // Sent verbatim; main normalises (~ expansion + resolve) so the store
      // holds one canonical absolute form. '' means "no vault export".
      vaultDirectory: (document.getElementById('vault-directory') || {}).value || ''
    };

    const result = await api.updateSettings(newSettings);

    if (result.success) {
      // Merge, not replace: newSettings is only the writable subset, so a
      // replace would drop read-only fields main ships alongside it (the
      // provider availability list, the vault status) and the next re-render
      // would have nothing to describe.
      currentSettings = { ...currentSettings, ...newSettings };
      showSuccess('Settings saved');
    } else {
      showError('Could not save your settings: ' + result.error);
    }
  } catch (err) {
    console.error('Could not persist settings:', err);
    showError('Could not save your settings');
  }
}

async function handleResetSettings() {
  const confirmation = await api.confirmAction({
    title: 'Reset Settings',
    message: 'Reset all settings to their defaults?',
    detail: 'This will restore the default output folder, retention period, and recording preferences.',
    confirmLabel: 'Reset',
    cancelLabel: 'Cancel',
    destructive: true
  });

  if (!confirmation.confirmed) {
    return;
  }

  try {
    const result = await api.resetSettings();

    if (result.success) {
      await loadSettings();
      await loadMicDevices();
      showSuccess('Settings restored to defaults');
    } else {
      showError('Could not restore defaults');
    }
  } catch (err) {
    console.error('Could not restore defaults:', err);
    showError('Could not restore defaults');
  }
}

async function handleDeleteRecording(filename) {
  const confirmation = await api.confirmAction({
    title: 'Delete Recording',
    message: `Delete "${filename}"?`,
    detail: 'This will also delete the associated transcripts and notes.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    destructive: true
  });

  if (!confirmation.confirmed) {
    return;
  }

  try {
    const result = await api.deleteRecording(filename);

    if (result.success) {
      showSuccess(`Deleted ${result.deletedFiles.length} file(s)`);
      await loadRecordings();
      await loadStorageStats();
    } else {
      showError('Could not delete that recording: ' + result.error);
    }
  } catch (err) {
    console.error('Could not delete recording:', err);
    showError('Could not delete that recording');
  }
}

async function handleOpenFile(filepath) {
  try {
    await api.openFile(filepath);
  } catch (err) {
    console.error('Could not open that file:', err);
    showError('Could not open that file');
  }
}

async function handleProcessRecording(wavPath) {
  try {
    currentProcessingPath = wavPath;
    manualProcessingActive = true;
    showProcessingOverlay('Processing', 'Starting transcription...', 0);
    updateProcessingBadge();

    const result = await api.processRecording(wavPath);

    currentProcessingPath = null;
    manualProcessingActive = false;
    hideProcessingOverlay();

    if (result.success) {
      showSuccess('Processing complete!');
      await loadRecordings();
    } else {
      showError('Processing failed: ' + result.error);
      await loadRecordings();
    }
  } catch (err) {
    console.error('Processing did not complete:', err);
    currentProcessingPath = null;
    manualProcessingActive = false;
    hideProcessingOverlay();
    showError('Processing failed');
  }
}

/**
 * Regenerate notes from the transcript that already exists — seconds, not the
 * many minutes a full re-transcription of a long meeting costs. This is the
 * right repair for the common failure: transcription worked, the LLM didn't.
 */
async function handleResummariseSession(sessionDir) {
  try {
    currentProcessingPath = sessionDir;
    updateProcessingBadge();

    const result = await api.resummariseSession(sessionDir);

    if (result.success) {
      showInfo('Regenerating notes from the existing transcript…');
      return;
    }

    currentProcessingPath = null;
    updateProcessingBadge();
    hideProcessingOverlay();

    // No transcript to reuse — say so rather than silently starting the
    // expensive job the user didn't ask for.
    if (result.needsFullReprocess) {
      showError('No transcript for this session — use full reprocess (\u{1F504}) instead');
    } else {
      showError('Re-summarise failed: ' + result.error);
    }
  } catch (err) {
    console.error('Failed to re-summarise session:', err);
    currentProcessingPath = null;
    updateProcessingBadge();
    hideProcessingOverlay();
    showError('Re-summarise failed');
  }
}

async function handleReprocessSession(sessionDir) {
  // Full reprocess re-runs whisper over the whole recording — confirm, since
  // the cheap re-summarise sits right next to it and is usually what's wanted.
  const confirmed = confirm(
    'Full reprocess re-transcribes the entire recording and can take many minutes.\n\n' +
    'If only the notes are wrong, use Re-summarise (✨) instead — it reuses the ' +
    'existing transcript and takes seconds.\n\nContinue with a full reprocess?'
  );
  if (!confirmed) return;

  try {
    currentProcessingPath = sessionDir;
    updateProcessingBadge();

    const result = await api.reprocessSession(sessionDir);

    if (result.success) {
      showInfo('Reprocessing started — this may take a while for large files');
    } else {
      currentProcessingPath = null;
      updateProcessingBadge();
      hideProcessingOverlay();
      showError('Reprocessing failed: ' + result.error);
    }
  } catch (err) {
    console.error('Failed to reprocess session:', err);
    currentProcessingPath = null;
    updateProcessingBadge();
    hideProcessingOverlay();
    showError('Reprocessing failed');
  }
}

async function handleCleanup() {
  const retentionDays = parseInt(document.getElementById('retention-days').value);

  const confirmation = await api.confirmAction({
    title: 'Cleanup Old Recordings',
    message: `Delete recordings older than ${retentionDays} days?`,
    detail: 'Transcripts and notes will be preserved.',
    confirmLabel: 'Clean Up',
    cancelLabel: 'Cancel',
    destructive: true
  });

  if (!confirmation.confirmed) {
    return;
  }

  try {
    const result = await api.cleanupOldRecordings();

    if (result.success) {
      showSuccess(`Cleaned up ${result.deletedCount} old recording(s)`);
      await loadRecordings();
      await loadStorageStats();
    } else {
      showError('Cleanup failed: ' + result.error);
    }
  } catch (err) {
    console.error('Cleanup failed:', err);
    showError('Cleanup failed');
  }
}

async function runPreflightCheck() {
  const panel = document.getElementById('preflight-panel');
  const results = document.getElementById('preflight-results');

  panel.classList.remove('hidden');
  results.innerHTML = '<div class="loading">Running preflight checks...</div>';

  try {
    const checks = await api.runPreflight();
    console.log('Preflight results:', checks);

    let html = '';
    for (const check of checks) {
      const icon = check.pass ? '\u2705' : '\u274C';
      html += `<div class="preflight-item ${check.pass ? 'pass' : 'fail'}">
        <span>${icon}</span>
        <div>
          <strong>${check.name}</strong>
          <small>${check.message}</small>
        </div>
      </div>`;
    }

    results.innerHTML = html;
  } catch (err) {
    console.error('Preflight check failed:', err);
    results.innerHTML = '<div class="preflight-item fail"><span>\u274C</span><div><strong>Preflight failed</strong><small>' + err.message + '</small></div></div>';
  }
}

/* ── UI Helpers ──────────────────────────────────────────────── */

function updateProcessingBadge() {
  // Update recording items to reflect current processing state without full re-render
  const items = document.querySelectorAll('.recording-item[data-filepath]');
  items.forEach(item => {
    const filepath = item.dataset.filepath;
    const badges = item.querySelector('.recording-badges');
    if (!badges) return;

    const isProcessing = currentProcessingPath && (
      filepath === currentProcessingPath ||
      (filepath && currentProcessingPath.includes(item.querySelector('.recording-name')?.textContent))
    );

    const existingBadge = badges.querySelector('.badge-processing, .badge-warning');
    if (isProcessing && existingBadge && !existingBadge.classList.contains('badge-processing')) {
      // Swap "Not transcribed" for "Processing..."
      existingBadge.outerHTML = '<span class="badge badge-processing"><span class="badge-spinner"></span>Processing\u2026</span>';
      item.classList.add('is-processing');
    }
  });
}

function showProcessingOverlay(stage, message, progress) {
  const overlay = document.getElementById('processing-overlay');
  const stageEl = document.getElementById('processing-stage');
  const messageEl = document.getElementById('processing-message');
  const progressFill = document.getElementById('progress-fill');
  const progressPercent = document.getElementById('processing-percent');

  stageEl.textContent = stage;
  messageEl.textContent = message;
  progressFill.style.width = `${progress}%`;
  progressPercent.textContent = `${progress}%`;

  overlay.classList.remove('hidden');
}

function hideProcessingOverlay() {
  const overlay = document.getElementById('processing-overlay');
  overlay.classList.add('hidden');
}

/** How long a toast waits after being asked to leave, matching the CSS. */
const TOAST_EXIT_MS = 300;

/**
 * Show a toast. Dismissed by its close button or by timing out, whichever
 * comes first — both routes go through removeToast so a toast cannot be
 * removed twice or left behind.
 */
function showToast(message, type = 'info', duration) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = renderToast(message, type);

  document.getElementById('toast-container').appendChild(toast);

  const dismiss = () => removeToast(toast);
  toast.querySelector('.toast-close').addEventListener('click', dismiss);
  setTimeout(dismiss, duration === undefined ? toastKind(type).duration : duration);
}

function removeToast(toast) {
  toast.classList.add('hiding');
  setTimeout(() => toast.remove(), TOAST_EXIT_MS);
}

function showSuccess(message) {
  showToast(message, 'success');
}

function showError(message) {
  showToast(message, 'error');
}

function showWarning(message) {
  showToast(message, 'warning');
}

function showInfo(message) {
  showToast(message, 'info');
}

