/**
 * Resolve an external CLI to an ABSOLUTE path, without trusting $PATH.
 *
 * Pure and Electron-free (same shape as meetingFilter.js / vaultLocator.js /
 * llmProviders.js) so main, the services and the tests share one answer to
 * "where is sox".
 *
 * WHY THIS EXISTS — the bug it fixes is invisible on a developer's machine.
 * A macOS app launched from Finder, the Dock or Spotlight inherits launchd's
 * environment, and `launchctl getenv PATH` is unset by default, so the app gets
 * the bare system PATH:
 *
 *     /usr/bin:/bin:/usr/sbin:/sbin
 *
 * Homebrew (`/opt/homebrew/bin`) and every npm-global bin directory are absent
 * from it. So `which sox`, and every `spawn('sox', …)`, FAILS on a packaged app
 * even though sox is installed — and the same is true of `codex`, `claude` and
 * `ollama`, which makes summarisation fail too.
 *
 * It does not reproduce for whoever built the app, because `open -a CXNotes`
 * run from a terminal passes the CALLING shell's environment through — which is
 * exactly how scripts/build-and-install.sh and the ship command launch it. The
 * app therefore inherits a full developer PATH on the machine that built it and
 * a crippled one everywhere else. Verified 2026-08-05: the running instance had
 * `/opt/homebrew/bin` in its env, while `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin
 * which sox` exits 1.
 *
 * The fix is to never depend on PATH: search it when it is useful, then fall
 * back to the handful of places these tools are actually installed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Where CLI tools actually live on macOS, most likely first.
 *
 * `/opt/homebrew/bin` is Apple Silicon Homebrew, `/usr/local/bin` is Intel
 * Homebrew AND the default target of `npm install -g` on a Node installed
 * there, `/opt/local/bin` is MacPorts. The system dirs are last because a
 * Homebrew build should win over an older system copy of the same name.
 */
const STATIC_SEARCH_DIRS = Object.freeze([
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]);

/** Per-user dirs, resolved against a home directory so tests can inject one. */
const USER_SEARCH_DIRS = Object.freeze([
  '.local/bin',
  '.bun/bin',
  '.volta/bin',
  '.deno/bin',
  'bin',
]);

/**
 * npm-global bin dirs under a version manager.
 *
 * nvm puts every Node version in its own tree, so a globally-installed
 * `claude` or `codex` lands in `~/.nvm/versions/node/<version>/bin` — a
 * directory no packaged app will ever have on its PATH. Newest version first,
 * since that is the one the user most recently installed into.
 */
function nvmBinDirs(home, fsImpl) {
  const root = path.join(home, '.nvm', 'versions', 'node');
  let versions;
  try {
    versions = fsImpl.readdirSync(root);
  } catch {
    return [];
  }
  return versions
    .filter((v) => /^v?\d/.test(v))
    .sort(compareVersionsDesc)
    .map((v) => path.join(root, v, 'bin'));
}

/** Sort version-ish directory names newest first ("v24.11.1" > "v20.9.0"). */
function compareVersionsDesc(a, b) {
  const parse = (s) => s.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] || 0) - (x[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Every directory to search, in priority order.
 *
 * $PATH goes FIRST so a developer's deliberate choice (a version manager, a
 * custom build earlier on their PATH) still wins in a terminal-launched dev
 * run. When the app is launched from the Dock that list is nearly empty, and
 * the static fallbacks below are what save it.
 *
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {string} [opts.home]
 * @param {object} [opts.fsImpl=fs]
 * @param {string[]} [opts.extraDirs] - Checked before everything else
 */
function searchDirs({ env = process.env, home = os.homedir(), fsImpl = fs, extraDirs = [] } = {}) {
  const fromPath = String(env.PATH || '')
    .split(':')
    .filter(Boolean);

  const fromHome = USER_SEARCH_DIRS.map((d) => path.join(home, d));

  const seen = new Set();
  return [...extraDirs, ...fromPath, ...STATIC_SEARCH_DIRS, ...fromHome, ...nvmBinDirs(home, fsImpl)]
    .filter((d) => {
      if (!d || seen.has(d)) return false;
      seen.add(d);
      return true;
    });
}

/**
 * Find an executable by name.
 *
 * @param {string} name - Bare command name, e.g. 'sox'
 * @param {object} [opts] - See searchDirs; plus fsImpl for the access check
 * @returns {string|null} Absolute path, or null when it genuinely isn't installed
 */
function resolveBinary(name, opts = {}) {
  if (!name || path.isAbsolute(name)) {
    // An absolute path is already an answer — just confirm it is there.
    return name && exists(name, opts.fsImpl || fs) ? name : null;
  }

  const fsImpl = opts.fsImpl || fs;
  for (const dir of searchDirs(opts)) {
    const candidate = path.join(dir, name);
    if (exists(candidate, fsImpl)) return candidate;
  }
  return null;
}

/** Present and executable. A non-executable file of the right name is not it. */
function exists(candidate, fsImpl) {
  try {
    fsImpl.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cached resolution, for things resolved on a hot path.
 *
 * `spawn('sox')` happens up to five times per recording start; re-walking the
 * filesystem each time would be wasteful. Cleared by `clearBinaryCache()` so a
 * user who installs a missing dependency and re-runs the preflight is not told
 * it is still missing.
 */
const cache = new Map();

function resolveBinaryCached(name, opts = {}) {
  if (cache.has(name)) return cache.get(name);
  const resolved = resolveBinary(name, opts);
  cache.set(name, resolved);
  return resolved;
}

function clearBinaryCache() {
  cache.clear();
}

/**
 * Resolve, or throw an error that names the tool and how to install it.
 *
 * Used at spawn sites, where "spawn sox ENOENT" is a useless thing to show a
 * user who has no idea the app shells out to sox at all.
 */
function requireBinary(name, { installHint = null, ...opts } = {}) {
  const resolved = resolveBinaryCached(name, opts);
  if (resolved) return resolved;
  throw new Error(
    `"${name}" was not found on this Mac.` +
    (installHint ? `\nInstall it with: ${installHint}` : '') +
    '\n(Searched $PATH, Homebrew, /usr/local/bin and the usual npm-global locations.)'
  );
}

module.exports = {
  STATIC_SEARCH_DIRS,
  USER_SEARCH_DIRS,
  searchDirs,
  resolveBinary,
  resolveBinaryCached,
  requireBinary,
  clearBinaryCache,
};
