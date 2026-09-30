'use strict';

/**
 * Where is the user's Obsidian vault?
 *
 * The vault location used to be a frozen literal (`~/Documents/CX`), which is
 * correct for exactly one person. This module makes it a resolved value:
 *
 *   1. whatever the user configured (`vaultDirectory` in electron-store), else
 *   2. a one-time detection at first launch — Obsidian's OWN vault registry
 *      first, then any caller-supplied legacy path, else
 *   3. nothing at all, which is a valid state: notes are still generated and
 *      kept in the recordings folder, they just aren't exported anywhere.
 *
 * Pure and Electron-free (mirrors meetingFilter.js / noteFiler.js / paths.js) so
 * the standalone scripts — `summarise-only.js`, `scripts/file-root-notes.js` —
 * resolve the SAME vault the app does without booting Electron. All fs access
 * goes through an injectable `fsImpl`, and the home directory is a parameter, so
 * the tests run entirely inside temp directories.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { APP_SUPPORT_DIR_NAME } = require('../shared/paths');

/**
 * Obsidian records every vault it has ever opened here, as
 * `{"vaults": {"<id>": {"path": "/abs/path", "ts": 1747506901305, "open": true}}}`.
 * Reading it is how we can pick a sensible default for someone who has never
 * heard of `~/Documents/CX`.
 */
const OBSIDIAN_REGISTRY_REL = ['Library', 'Application Support', 'obsidian', 'obsidian.json'];

/**
 * Where electron-store keeps `config.json`. A non-Electron script can't ask
 * `app.getPath('userData')`, so it probes both spellings and takes the first
 * file that actually carries the key.
 *
 * Verified on this machine: the live config is `~/Library/Application
 * Support/cxnotes/config.json` (electron-store follows `package.json` `name`),
 * while `shared/paths.js` pins the handoff root to `CXNotes`
 * (`productName`). On a case-INSENSITIVE volume — the macOS default — those are
 * one directory and the order is irrelevant. On a case-sensitive volume they
 * genuinely diverge, and `CXNotes` may exist holding only the handoff dir with
 * no `config.json`; a probe that can't read/parse a file falls through to the
 * next name, so the lowercase store is still found.
 */
const STORE_DIR_NAMES = Object.freeze([APP_SUPPORT_DIR_NAME, 'cxnotes']);

/** The marker directory every Obsidian vault carries. */
const OBSIDIAN_MARKER_DIR = '.obsidian';

/**
 * Expand a leading `~` and resolve to an absolute path.
 *
 * Typed paths are the whole point of a configurable setting, and people type
 * `~/Notes`. Returns null for anything that isn't a usable non-empty string, so
 * "not configured" has one representation everywhere downstream.
 *
 * @param {*} value
 * @param {string} [home]
 * @returns {string|null}
 */
function normaliseVaultPath(value, home = os.homedir()) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let expanded = trimmed;
  if (expanded === '~') expanded = home;
  else if (expanded.startsWith('~/')) expanded = path.join(home, expanded.slice(2));

  return path.resolve(expanded);
}

/**
 * Does this directory look like an Obsidian vault (i.e. does it hold a
 * `.obsidian` folder)? Advisory only — a plain folder is a perfectly good
 * export target, so this drives UI wording, never a hard gate.
 */
function looksLikeObsidianVault(dir, fsImpl = fs) {
  if (!dir) return false;
  try {
    return fsImpl.existsSync(path.join(dir, OBSIDIAN_MARKER_DIR));
  } catch {
    return false;
  }
}

/**
 * Every vault Obsidian knows about, best candidate first: the currently open
 * one, then most-recently-used. Entries whose directory no longer exists are
 * dropped — Obsidian never prunes this file when a vault is deleted.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @param {object} [opts.fsImpl]
 * @returns {Array<{path: string, ts: number, open: boolean}>}
 */
function listObsidianVaults({ home = os.homedir(), fsImpl = fs } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(path.join(home, ...OBSIDIAN_REGISTRY_REL), 'utf-8');
  } catch {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.vaults || typeof parsed.vaults !== 'object') {
    return [];
  }

  const vaults = [];
  for (const entry of Object.values(parsed.vaults)) {
    if (!entry || typeof entry !== 'object') continue;
    const dir = normaliseVaultPath(entry.path, home);
    if (!dir) continue;
    let exists = false;
    try {
      exists = fsImpl.existsSync(dir);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    vaults.push({
      path: dir,
      ts: Number.isFinite(Number(entry.ts)) ? Number(entry.ts) : 0,
      open: entry.open === true
    });
  }

  vaults.sort((a, b) => (a.open === b.open ? b.ts - a.ts : (a.open ? -1 : 1)));
  return vaults;
}

/**
 * Pick a vault directory for a user who has never configured one.
 *
 * `preferPaths` exists for backwards compatibility: main.js passes the legacy
 * `~/Documents/CX`, so an existing install keeps filing exactly where it always
 * did rather than silently switching to a different vault on upgrade. Nothing
 * in this module knows that path — it is the caller's history, not a default.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @param {object} [opts.fsImpl]
 * @param {string[]} [opts.preferPaths] - checked (in order) before Obsidian's registry
 * @returns {string|null} absolute path, or null when nothing plausible exists
 */
function detectVaultDirectory({ home = os.homedir(), fsImpl = fs, preferPaths = [] } = {}) {
  for (const candidate of Array.isArray(preferPaths) ? preferPaths : []) {
    const dir = normaliseVaultPath(candidate, home);
    if (!dir) continue;
    try {
      if (fsImpl.existsSync(dir)) return dir;
    } catch {
      /* keep looking */
    }
  }

  const vaults = listObsidianVaults({ home, fsImpl });
  return vaults.length ? vaults[0].path : null;
}

/**
 * Read the `vaultDirectory` setting straight out of electron-store's config
 * file, keeping "never configured" and "deliberately cleared" apart.
 *
 * For the standalone scripts only — inside the app, always go through the live
 * `store`. Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @param {object} [opts.fsImpl]
 * @returns {{present: boolean, path: string|null}} `present:false` = the app has
 *   never written the key; `present:true, path:null` = the user emptied it, which
 *   means "no vault export" and must NOT fall through to detection.
 */
function readStoredVaultSetting({ home = os.homedir(), fsImpl = fs } = {}) {
  for (const dirName of STORE_DIR_NAMES) {
    const configPath = path.join(home, 'Library', 'Application Support', dirName, 'config.json');
    let raw;
    try {
      raw = fsImpl.readFileSync(configPath, 'utf-8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(parsed, 'vaultDirectory')) {
      return { present: true, path: normaliseVaultPath(parsed.vaultDirectory, home) };
    }
  }
  return { present: false, path: null };
}

/**
 * The configured vault path, or null when it is unset or cleared. Convenience
 * wrapper for callers that don't care WHY there's no path.
 *
 * @returns {string|null}
 */
function readConfiguredVaultDirectory(opts = {}) {
  return readStoredVaultSetting(opts).path;
}

/**
 * The vault a non-Electron script should use: configured value first, then
 * detection, then null. `overridePath` is a CLI flag (`--vault`) and always wins.
 *
 * @param {object} [opts]
 * @param {string} [opts.overridePath]
 * @param {string} [opts.home]
 * @param {object} [opts.fsImpl]
 * @param {string[]} [opts.preferPaths]
 * @returns {string|null}
 */
function resolveVaultDirectoryForScript({
  overridePath = null,
  home = os.homedir(),
  fsImpl = fs,
  preferPaths = []
} = {}) {
  const override = normaliseVaultPath(overridePath, home);
  if (override) return override;

  // `present` without a path is the user switching vault export OFF in the app.
  // A script must honour that instead of quietly detecting a vault of its own.
  const stored = readStoredVaultSetting({ home, fsImpl });
  if (stored.present) return stored.path;

  return detectVaultDirectory({ home, fsImpl, preferPaths });
}

/**
 * Describe a vault path for the settings UI: is it set, does it exist, does it
 * look like a real Obsidian vault? Purely informational.
 *
 * @param {string|null} vaultDir
 * @param {object} [fsImpl]
 * @returns {{path: string|null, configured: boolean, exists: boolean, isObsidianVault: boolean}}
 */
function describeVault(vaultDir, fsImpl = fs) {
  const dir = normaliseVaultPath(vaultDir);
  if (!dir) {
    return { path: null, configured: false, exists: false, isObsidianVault: false };
  }
  let exists = false;
  try {
    exists = fsImpl.existsSync(dir);
  } catch {
    exists = false;
  }
  return {
    path: dir,
    configured: true,
    exists,
    isObsidianVault: exists && looksLikeObsidianVault(dir, fsImpl)
  };
}

/**
 * Is `filePath` inside `vaultDir`?
 *
 * Logical containment is tested FIRST, and symlink resolution is only the
 * fallback. That order is the whole point, and the obvious order is wrong:
 * vaults commonly contain folders that are themselves symlinks pointing
 * somewhere else entirely (this one has four). Resolving both sides first sends
 * a note filed into one of those to its real location outside the vault, and
 * the note is then judged "loose" — so it opens in a plain text editor instead
 * of Obsidian, even though Obsidian can open it perfectly well.
 *
 * The resolved comparison still earns its place, for the mirror-image case where
 * the vault ROOT is reached through a symlink and the two paths only agree once
 * both are resolved. Trying logical first and resolved second covers both.
 *
 * Containment is tested on a path-segment boundary, because a bare `startsWith`
 * also matches a sibling directory: `~/Documents/CX-archive` starts with
 * `~/Documents/CX`.
 *
 * @param {string|null} vaultDir - Vault root, or null when no vault is configured
 * @param {string} filePath
 * @param {object} [deps]
 * @param {object} [deps.fsImpl=fs]
 * @returns {boolean}
 */
function isInsideVault(vaultDir, filePath, { fsImpl = fs } = {}) {
  // No vault → nothing is inside it.
  if (!vaultDir || !filePath) return false;

  const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);

  try {
    if (contains(path.resolve(vaultDir), path.resolve(filePath))) return true;
  } catch {
    // Fall through to the resolved comparison.
  }

  try {
    return contains(fsImpl.realpathSync(vaultDir), fsImpl.realpathSync(filePath));
  } catch {
    // A path that does not exist cannot be shown to be inside the vault.
    return false;
  }
}

module.exports = {
  isInsideVault,
  OBSIDIAN_REGISTRY_REL,
  OBSIDIAN_MARKER_DIR,
  STORE_DIR_NAMES,
  normaliseVaultPath,
  looksLikeObsidianVault,
  listObsidianVaults,
  detectVaultDirectory,
  readStoredVaultSetting,
  readConfiguredVaultDirectory,
  resolveVaultDirectoryForScript,
  describeVault
};
