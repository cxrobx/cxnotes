'use strict';

/**
 * The vault profile: everything about filing and naming that is true of ONE
 * person's vault and nobody else's — who "me" is, which folders carry which
 * category code, which words earn a code from content, and where client or
 * project folders are auto-discovered.
 *
 * None of it is hard-coded. It lives in the app's settings store under
 * `vaultProfile` (and `vaultFilingRules` for the routing rules), and an empty
 * profile is valid: notes are then named `<Who|Topic> <MM.DD.YY>.md` with no
 * category, and filing falls to the LLM tier, the Inbox and the catch-all.
 *
 * Pure, Electron-free module. The app sets the active profile once at start-up
 * (`setVaultProfile(store.get('vaultProfile'))`); the standalone scripts read
 * the same config.json through `readStoredProfile()`, so a script cannot name
 * or file a note differently from the app the user configured.
 *
 * Shape (every field optional):
 *
 *   {
 *     "selfNames": ["alex", "alex doe"],
 *     "filingStopwords": ["alex"],
 *     "categoryByDestination": [{ "folder": "Projects/Acme/Meetings", "code": "ACM" }],
 *     "categoryByContent": [{ "code": "BD", "keywords": ["biz dev"] }],
 *     "discoveryGroups": [{ "parent": "Projects/Clients", "subdirs": ["Meetings", "Calls"] }]
 *   }
 */

/** Names that mean "the user" in every vault, profile or no profile. */
const BUILT_IN_SELF_NAMES = Object.freeze(['me', 'self']);

const cleanString = (v) => (typeof v === 'string' ? v.trim() : '');

const cleanList = (v, { lower = false } = {}) => (Array.isArray(v)
  ? v.map(cleanString).filter(Boolean).map((s) => (lower ? s.toLowerCase() : s))
  : []);

const cleanFolder = (v) => cleanString(v).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

/**
 * Validate + normalise a stored profile. Never throws: a malformed field
 * becomes empty and a malformed entry is dropped, because a bad setting must
 * not take down an export. Idempotent — an already-normalised profile (whose
 * category tables are pairs) normalises to itself, so `setVaultProfile` can
 * be handed either the stored value or `readStoredProfile().profile`.
 *
 * @param {object} [raw] - the stored `vaultProfile` value
 * @returns {{selfNames: string[], filingStopwords: string[],
 *   categoryByDestination: Array<[string, string]>,
 *   categoryByContent: Array<[string, string[]]>,
 *   discoveryGroups: Array<{parent: string, subdirs: string[]}>}}
 */
function normaliseProfile(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const categoryByDestination = [];
  for (const entry of Array.isArray(src.categoryByDestination) ? src.categoryByDestination : []) {
    if (!entry || typeof entry !== 'object') continue;
    const [rawFolder, rawCode] = Array.isArray(entry) ? entry : [entry.folder, entry.code];
    const folder = cleanFolder(rawFolder);
    const code = cleanString(rawCode);
    if (folder && code) categoryByDestination.push([folder, code]);
  }

  const categoryByContent = [];
  for (const entry of Array.isArray(src.categoryByContent) ? src.categoryByContent : []) {
    if (!entry || typeof entry !== 'object') continue;
    const [rawCode, rawKeywords] = Array.isArray(entry) ? entry : [entry.code, entry.keywords];
    const code = cleanString(rawCode);
    const keywords = cleanList(rawKeywords, { lower: true });
    if (code && keywords.length) categoryByContent.push([code, keywords]);
  }

  const discoveryGroups = [];
  for (const entry of Array.isArray(src.discoveryGroups) ? src.discoveryGroups : []) {
    if (!entry || typeof entry !== 'object') continue;
    const parent = cleanFolder(entry.parent);
    const subdirs = cleanList(entry.subdirs);
    if (parent && subdirs.length) discoveryGroups.push({ parent, subdirs });
  }

  return {
    selfNames: cleanList(src.selfNames, { lower: true }),
    filingStopwords: cleanList(src.filingStopwords, { lower: true }),
    categoryByDestination,
    categoryByContent,
    discoveryGroups,
  };
}

let activeProfile = normaliseProfile(null);

/** Replace the active profile (normalised). Returns what was set. */
function setVaultProfile(raw) {
  activeProfile = normaliseProfile(raw);
  return activeProfile;
}

/** The active profile; empty until something sets one. */
function getVaultProfile() {
  return activeProfile;
}

/** Every lowercase name that means "the user": built-ins plus the profile's. */
function selfNameSet(profile = activeProfile) {
  return new Set([...BUILT_IN_SELF_NAMES, ...profile.selfNames]);
}

/**
 * Read the profile and filing rules the APP saved, for the standalone scripts
 * (same approach as llmProviders' `readStoredLlmOptions`). Every failure path
 * returns an empty profile and no rules rather than throwing.
 *
 * @param {object} [deps] - { home, fsImpl, storeDirNames } for injection
 * @returns {{profile: object, filingRules: Array}}
 */
function readStoredProfile({ home, fsImpl, storeDirNames } = {}) {
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

    return {
      profile: normaliseProfile(parsed.vaultProfile),
      filingRules: Array.isArray(parsed.vaultFilingRules) ? parsed.vaultFilingRules : [],
    };
  }

  return { profile: normaliseProfile(null), filingRules: [] };
}

module.exports = {
  BUILT_IN_SELF_NAMES,
  normaliseProfile,
  setVaultProfile,
  getVaultProfile,
  selfNameSet,
  readStoredProfile,
};
