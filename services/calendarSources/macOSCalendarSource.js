/**
 * macOS Calendar Source
 *
 * Spawns the bundled `calendar-helper` Swift binary to query EventKit.
 * Three operations:
 *   - ensurePermission()    → 'granted' | 'denied' | 'not-determined'
 *   - getUpcomingEvents()   → CalendarEvent[]
 *   - getCurrentEvent()     → CalendarEvent | null
 *
 * Helper invocations are short-lived and stdout-only. Every spawned child is
 * routed through the injected `registerProcess` so it participates in the
 * app's existing cleanup-on-quit invariant. The injected `spawn` keeps the
 * source unit-testable without touching child_process directly.
 *
 * Errors from the helper (missing binary, permission denied, JSON parse
 * failure) surface as typed results — never thrown — so the suggester loop
 * can degrade gracefully instead of crashing.
 */

const ExitCode = Object.freeze({
  Success: 0,
  Error: 1,
  PermissionDenied: 2,
  NotDetermined: 3
});

const HELPER_INVOCATION_TIMEOUT_MS = 5000;

class MacOSCalendarSource {
  /**
   * @param {object} opts
   * @param {string} opts.helperPath - absolute path to the calendar-helper binary
   * @param {Function} opts.spawn - child_process.spawn (injected for tests)
   * @param {Function} opts.registerProcess - main.js's registerProcess (injected)
   */
  constructor({ helperPath, spawn, registerProcess }) {
    if (!helperPath) throw new Error('macOSCalendarSource: helperPath required');
    if (typeof spawn !== 'function') throw new Error('macOSCalendarSource: spawn required');
    if (typeof registerProcess !== 'function') throw new Error('macOSCalendarSource: registerProcess required');

    this._helperPath = helperPath;
    this._spawn = spawn;
    this._registerProcess = registerProcess;
  }

  /**
   * Run the helper with the given args. Resolves to { code, stdout, stderr }.
   * Never throws — caller decides what to do with non-zero exit codes.
   */
  async _runHelper(args, { timeoutMs = HELPER_INVOCATION_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this._spawn(this._helperPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: `spawn-failed: ${err.message}` });
        return;
      }

      this._registerProcess(child);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => finish({ code: -1, stdout, stderr: stderr + `\nspawn-error: ${err.message}` }));
      child.on('exit', (code) => finish({ code: code == null ? -1 : code, stdout, stderr }));

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch (_e) { /* ignore */ }
        finish({ code: -1, stdout, stderr: stderr + '\ntimeout' });
      }, timeoutMs);
    });
  }

  /**
   * Trigger the macOS Calendar permission prompt if needed, and report the
   * resulting state. Idempotent — re-running once granted is a fast no-op.
   *
   * @returns {Promise<'granted'|'denied'|'not-determined'>}
   */
  async ensurePermission() {
    const result = await this._runHelper(['request-access']);
    if (result.code === ExitCode.Success) return 'granted';
    if (result.code === ExitCode.PermissionDenied) return 'denied';
    if (result.code === ExitCode.NotDetermined) return 'not-determined';
    // Anything else is an error — surface as denied so the caller doesn't loop forever
    return 'denied';
  }

  /**
   * @param {object} opts
   * @param {number} opts.windowMinutes
   * @returns {Promise<{ events: object[], error?: string }>}
   */
  async getUpcomingEvents({ windowMinutes }) {
    const result = await this._runHelper(['upcoming', '--window-minutes', String(windowMinutes)]);
    if (result.code === ExitCode.PermissionDenied) return { events: [], error: 'permission-denied' };
    if (result.code === ExitCode.NotDetermined) return { events: [], error: 'not-determined' };
    if (result.code !== ExitCode.Success) return { events: [], error: `helper-exit-${result.code}` };

    try {
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed)) return { events: [], error: 'unexpected-shape' };
      return { events: parsed };
    } catch (err) {
      return { events: [], error: `parse-failed: ${err.message}` };
    }
  }

  /**
   * @returns {Promise<{ event: object | null, error?: string }>}
   */
  async getCurrentEvent() {
    const result = await this._runHelper(['current']);
    if (result.code === ExitCode.PermissionDenied) return { event: null, error: 'permission-denied' };
    if (result.code === ExitCode.NotDetermined) return { event: null, error: 'not-determined' };
    if (result.code !== ExitCode.Success) return { event: null, error: `helper-exit-${result.code}` };

    const stdout = result.stdout.trim();
    if (!stdout || stdout === 'null') return { event: null };

    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object') return { event: parsed };
      return { event: null };
    } catch (err) {
      return { event: null, error: `parse-failed: ${err.message}` };
    }
  }
}

module.exports = { MacOSCalendarSource };
