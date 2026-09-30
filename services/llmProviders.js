/**
 * LLM provider registry and preference resolution.
 *
 * Pure and Electron-free (same shape as meetingFilter.js / vaultLocator.js /
 * glass.js) so the app, the standalone scripts, and the tests all share ONE
 * definition of what a provider is and which order they are tried in.
 *
 * The spawn details (argv, env, post-processing) deliberately live in
 * summariser.js, which already owns child_process — this module knows only
 * metadata and ordering, which is the part worth testing.
 */

/**
 * Known providers.
 *
 * `kind` is the honest privacy statement, not decoration: `subscription`
 * providers send the transcript to a third party under the user's own account;
 * `local` never leaves the machine. The UI shows this, and it is why
 * `strict` exists (see resolveProviderOrder).
 *
 * `defaultModel` — pinned so summary quality does not drift with a CLI upgrade.
 * Both CLIs run against a minimal/isolated config, so without an explicit model
 * flag each silently falls back to whatever its own default happens to be.
 * A user override is honoured; empty means "use this".
 */
const PROVIDERS = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    kind: 'subscription',
    defaultModel: 'gpt-5.5',
    // Install hint. Codex is OpenAI's — it is NOT published under @anthropic-ai.
    install: 'npm install -g @openai/codex',
  }),
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude',
    bin: 'claude',
    kind: 'subscription',
    defaultModel: 'claude-opus-5',
    install: 'npm install -g @anthropic-ai/claude-code',
  }),
  ollama: Object.freeze({
    id: 'ollama',
    label: 'Ollama',
    bin: 'ollama',
    kind: 'local',
    defaultModel: 'llama3.2',
    install: 'brew install ollama && ollama pull llama3.2',
  }),
});

/**
 * The order `auto` tries providers in.
 *
 * Codex before Claude preserves the behaviour that shipped before this setting
 * existed — an existing install must not silently change provider on upgrade.
 * Ollama is last because it is the "no subscription at all" safety net, not a
 * quality choice: it is a small local model summarising a whole meeting.
 */
const AUTO_ORDER = Object.freeze(['codex', 'claude', 'ollama']);

const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

/** `auto` plus every concrete id — the valid values of the `llmProvider` setting. */
const PREFERENCE_VALUES = Object.freeze(['auto', ...PROVIDER_IDS]);

function isKnownProvider(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/**
 * Normalise a stored preference, tolerating anything.
 *
 * A settings file edited by hand (or written by an older/newer build) must not
 * be able to stop summarisation — an unrecognised value degrades to 'auto'.
 */
function normalisePreference(value) {
  const id = String(value || '').trim().toLowerCase();
  return PREFERENCE_VALUES.includes(id) ? id : 'auto';
}

/**
 * Decide which providers to try, in order.
 *
 * @param {string} preference - 'auto' or a provider id
 * @param {object} available - { codex: bool, claude: bool, ollama: bool }
 * @param {object} [opts]
 * @param {boolean} [opts.strict=false] - Use ONLY the preferred provider.
 *   Off by default so a transient failure still falls back (the graceful
 *   behaviour). On, it is the only way to guarantee a transcript never reaches
 *   a provider the user did not choose — which is the whole point for someone
 *   who picked the local one deliberately (invariant #5). A strict preference
 *   of 'auto' is meaningless and is treated as non-strict.
 * @returns {string[]} Provider ids to attempt, best first. May be empty.
 */
function resolveProviderOrder(preference, available = {}, opts = {}) {
  const pref = normalisePreference(preference);
  const can = (id) => Boolean(available[id]);

  if (pref === 'auto') {
    return AUTO_ORDER.filter(can);
  }

  if (opts.strict) {
    return can(pref) ? [pref] : [];
  }

  // Preferred first, then the rest in auto order as fallback.
  return [pref, ...AUTO_ORDER.filter((id) => id !== pref)].filter(can);
}

/**
 * Build the error shown when nothing can run.
 *
 * Names what was actually looked for, so a user who has none installed — or who
 * pinned one and then removed it — gets an actionable message instead of a
 * generic failure. This is the text a fresh cloner is most likely to hit.
 */
function describeNoProviderAvailable(preference, available = {}, opts = {}) {
  const pref = normalisePreference(preference);

  if (opts.strict && pref !== 'auto' && !available[pref]) {
    const p = PROVIDERS[pref];
    return (
      `CXNotes is set to use ${p.label} only, but the "${p.bin}" command was not found.\n` +
      `Install it (${p.install}), pick a different provider in Settings, ` +
      'or turn off "Only use the selected provider".'
    );
  }

  const lines = PROVIDER_IDS.map((id) => `  ${PROVIDERS[id].label.padEnd(7)} ${PROVIDERS[id].install}`);
  return (
    'No AI summarisation provider found.\n' +
    'Recording and transcription still work — only the summary needs one of:\n' +
    lines.join('\n')
  );
}

/**
 * Resolve the model for a provider: user override, else the pinned default.
 *
 * @param {string} id - Provider id
 * @param {object} [overrides] - { codex: 'gpt-5.5', ... }; blank = use default
 */
function resolveModel(id, overrides = {}) {
  if (!isKnownProvider(id)) return null;
  const override = String((overrides || {})[id] || '').trim();
  return override || PROVIDERS[id].defaultModel;
}

/**
 * Read the provider preference the APP saved, for the standalone scripts.
 *
 * `summarise-only.js` and `scripts/file-root-notes.js` run outside Electron, so
 * they cannot use electron-store — they read its config.json the same way
 * vaultLocator's `readStoredVaultSetting` does, reusing its STORE_DIR_NAMES so
 * the two cannot drift if the app is ever renamed again. A script must not
 * quietly use a different provider than the app the user configured.
 *
 * Every failure path returns the defaults rather than throwing: a script that
 * cannot read a preference should still summarise.
 *
 * @param {object} [deps] - { home, fsImpl, storeDirNames } for injection
 * @returns {{provider: string, strict: boolean, models: object}}
 */
function readStoredLlmOptions({ home, fsImpl, storeDirNames } = {}) {
  const os = require('os');
  const fs = fsImpl || require('fs');
  const path = require('path');
  const dirs = storeDirNames || require('./vaultLocator').STORE_DIR_NAMES;
  const homeDir = home || os.homedir();

  for (const dirName of dirs) {
    const configPath = path.join(homeDir, 'Library', 'Application Support', dirName, 'config.json');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(parsed, 'llmProvider')) continue;

    return {
      provider: normalisePreference(parsed.llmProvider),
      strict: parsed.llmProviderStrict === true,
      models: (parsed.llmModels && typeof parsed.llmModels === 'object') ? parsed.llmModels : {},
    };
  }

  return { provider: 'auto', strict: false, models: {} };
}

module.exports = {
  PROVIDERS,
  PROVIDER_IDS,
  PREFERENCE_VALUES,
  AUTO_ORDER,
  isKnownProvider,
  normalisePreference,
  resolveProviderOrder,
  describeNoProviderAvailable,
  resolveModel,
  readStoredLlmOptions,
};
