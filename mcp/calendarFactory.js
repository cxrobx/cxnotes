'use strict';

/**
 * Builds the MacOSCalendarSource the MCP server uses, with a process-lifecycle
 * shim that mirrors the app's invariant #3 (all spawned children are tracked and
 * SIGTERM'd on shutdown). The MCP server is a long-lived stdio process, so a
 * helper left running after Ctrl-C would be an orphan (gotcha #4 territory).
 *
 * Helper resolution prefers the installed app's signed binary (Phase 0 finding:
 * a headless dev helper returns "denied" because macOS keys the Calendar grant
 * to the code signature — gotcha #7; the packaged app's Developer-ID helper owns
 * the granted permission).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { MacOSCalendarSource } = require('../services/calendarSources');
const { resolveCalendarHelperPath } = require('../shared/paths');

function helperExists(helperPath) {
  try {
    return fs.existsSync(helperPath);
  } catch {
    return false;
  }
}

// Guard so repeated createCalendarSource() calls don't stack signal handlers.
let signalsWired = false;

/**
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {boolean} [opts.wireSignals=true] - register SIGINT/SIGTERM cleanup
 *   (disable in tests)
 * @returns {{ source: MacOSCalendarSource, helperPath: string, killAll: Function }}
 * @throws {Error} code 'HELPER_MISSING' when the helper binary is absent
 */
function createCalendarSource({ repoRoot = null, wireSignals = true } = {}) {
  const helperPath = resolveCalendarHelperPath({
    repoRoot: repoRoot || path.resolve(__dirname, '..'),
    preferInstalled: true,
  });

  if (!helperExists(helperPath)) {
    const err = new Error(
      `calendar-helper not found at ${helperPath}. Build it with: npm run build:calendar`
    );
    err.code = 'HELPER_MISSING';
    err.helperPath = helperPath;
    err.fix = 'npm run build:calendar';
    throw err;
  }

  // Track live helper children and tear them down on shutdown (invariant #3).
  const liveChildren = new Set();
  const registerProcess = (child) => {
    liveChildren.add(child);
    child.on('exit', () => liveChildren.delete(child));
  };
  const killAll = () => {
    for (const child of liveChildren) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
  };

  if (wireSignals && !signalsWired) {
    signalsWired = true;
    process.once('exit', killAll);
    process.once('SIGINT', () => { killAll(); process.exit(0); });
    process.once('SIGTERM', () => { killAll(); process.exit(0); });
  }

  const source = new MacOSCalendarSource({ helperPath, spawn, registerProcess });
  return { source, helperPath, killAll };
}

module.exports = { createCalendarSource, helperExists };
