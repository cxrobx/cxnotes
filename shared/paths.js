'use strict';

/**
 * Cross-process path resolution — the ONE module both the Electron app and the
 * standalone MCP server agree on.
 *
 * Why a frozen literal and not `app.getPath('userData')`:
 *   package.json has `name:"cxnotes"` but `productName:"CXNotes"` and no
 *   `app.setName()`, so `app.getPath('userData')` is ambiguous dev-vs-packaged
 *   (Electron resolves the userData folder name from the app name, which differs
 *   between `electron .` and a packaged build). The MCP server isn't an Electron
 *   process at all and has no `app` to ask. So both sides compute the handoff
 *   location from `os.homedir()` + a frozen `CXNotes` literal. No probing,
 *   no boot assertion — just one agreed path.
 *
 * Electron-free on purpose: this module must `require` cleanly from a plain
 * `node` MCP process. It only touches `os`, `path`, and (for the helper
 * existence probe) `fs`.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Frozen literal — DO NOT swap for app.getName()/app.getPath (see header).
const APP_SUPPORT_DIR_NAME = 'CXNotes';

// Absolute path of the installed app's signed calendar-helper. macOS keys the
// Calendar (TCC) grant to the binary's code signature (gotcha #7); the packaged
// app's helper carries the Developer-ID signature the user already granted,
// whereas an ad-hoc dev build is a different file with a different signature.
// The MCP server therefore prefers this binary when it exists.
const INSTALLED_HELPER_PATH =
  '/Applications/CXNotes.app/Contents/Resources/calendar-helper';

/**
 * `~/Library/Application Support/CXNotes` — the app-support root. Frozen.
 */
function getAppSupportRoot() {
  return path.join(os.homedir(), 'Library', 'Application Support', APP_SUPPORT_DIR_NAME);
}

/**
 * The cross-process handoff root: `<appSupport>/handoff`. The MCP server writes
 * prepared meetings here; the Electron app reads + claims them. This filesystem
 * directory is the ONLY channel between the two processes (never electron-store
 * — a second writer would clobber it).
 */
function getHandoffRoot() {
  return path.join(getAppSupportRoot(), 'handoff');
}

/**
 * `<handoff>/prepared` — one JSON file per prepared occurrence.
 */
function getPreparedDir() {
  return path.join(getHandoffRoot(), 'prepared');
}

/**
 * `<handoff>/tmp` — scratch space for atomic tmp+rename writes. Kept under the
 * same handoff root (same filesystem) so `fs.renameSync(tmp → prepared)` is
 * atomic.
 */
function getTmpDir() {
  return path.join(getHandoffRoot(), 'tmp');
}

/**
 * Resolve the `calendar-helper` Swift binary for whoever is calling.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.resourcesPath] - `process.resourcesPath` when the
 *   Electron app is packaged. When provided, it is authoritative (the bundled
 *   helper sits beside the app's resources).
 * @param {string|null} [opts.repoRoot] - repository root, used to locate the
 *   dev build at `native/calendar-helper/.build/release/calendar-helper`.
 *   Defaults to this module's parent directory.
 * @param {boolean} [opts.preferInstalled=false] - when true (the MCP server's
 *   case), prefer the installed app's signed helper if present, because it
 *   carries the granted TCC signature. The Electron app leaves this false so a
 *   dev build keeps using its freshly-rebuilt local helper.
 * @returns {string} absolute path to the helper (existence not guaranteed for
 *   the dev-build fallback — callers should guard with their own existence check)
 */
function resolveCalendarHelperPath({ resourcesPath = null, repoRoot = null, preferInstalled = false } = {}) {
  // 1. Packaged Electron app: the bundled helper beside resources is authoritative.
  if (resourcesPath) {
    return path.join(resourcesPath, 'calendar-helper');
  }

  // 2. MCP server (or any non-packaged consumer that opts in): prefer the
  //    installed signed helper because it owns the granted Calendar permission.
  if (preferInstalled) {
    try {
      if (fs.existsSync(INSTALLED_HELPER_PATH)) return INSTALLED_HELPER_PATH;
    } catch {
      /* fall through to dev build */
    }
  }

  // 3. Dev build fallback.
  const root = repoRoot || path.resolve(__dirname, '..');
  return path.join(root, 'native', 'calendar-helper', '.build', 'release', 'calendar-helper');
}

module.exports = {
  APP_SUPPORT_DIR_NAME,
  INSTALLED_HELPER_PATH,
  getAppSupportRoot,
  getHandoffRoot,
  getPreparedDir,
  getTmpDir,
  resolveCalendarHelperPath,
};
