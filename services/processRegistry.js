'use strict';

/**
 * Every child process the app has spawned, and how they are torn down at quit.
 *
 * The whole reason this exists is invariant #3: a child that outlives the app
 * is not a tidy-up problem, it is a correctness problem. An orphaned `sox` keeps
 * the microphone open, so the *next* recording gets a device that is already
 * held and captures silence — a failure that shows up a meeting later, with no
 * error anywhere, and looks like a bug in the recorder (gotcha #4).
 *
 * Pure and Electron-free: it takes anything with `kill()`, `on('exit')` and
 * `killed`/`exitCode`, so the teardown sequence can be tested with fakes instead
 * of by quitting a real app and inspecting the process table afterwards.
 */

/** How long a child gets to honour SIGTERM before it is killed outright. */
const DEFAULT_GRACE_MS = 2000;

/** How often to re-check whether the stragglers have gone. */
const POLL_MS = 50;

class ProcessRegistry {
  /**
   * @param {{graceMs?: number, setTimeout?: Function, clearTimeout?: Function, now?: Function}} [opts]
   */
  constructor({
    graceMs = DEFAULT_GRACE_MS,
    setTimeout: setTimeoutImpl = setTimeout,
    now = Date.now
  } = {}) {
    this.graceMs = graceMs;
    this._setTimeout = setTimeoutImpl;
    this._now = now;
    this._live = new Set();
  }

  /** How many children are still believed to be running. */
  get size() {
    return this._live.size;
  }

  /**
   * Track a child so quitting cannot leave it behind.
   *
   * Self-removing: a process that exits on its own drops out of the set, so a
   * long session does not accumulate dead handles and shutdown does not signal
   * corpses.
   *
   * @param {object} proc - a ChildProcess, or anything with kill/on
   * @returns {object} the same process, for chaining at the spawn site
   */
  register(proc) {
    if (!proc) return proc;

    this._live.add(proc);
    if (typeof proc.on === 'function') {
      proc.on('exit', () => this._live.delete(proc));
    }
    return proc;
  }

  /** Forget a process without signalling it. */
  forget(proc) {
    this._live.delete(proc);
  }

  /**
   * Has this process gone?
   *
   * Deliberately does NOT consult `proc.killed`. In Node that flag means "a
   * signal was successfully SENT", not "the process died" — so a child that
   * ignores SIGTERM still reports `killed === true`, and trusting it made the
   * SIGKILL escalation dead code. Caught by the real-process test below, never
   * by the fakes.
   *
   * `exitCode` and `signalCode` are both null while a child is alive, and one
   * of them is set once it is not.
   */
  static hasExited(proc) {
    if (!proc) return true;
    const exited = proc.exitCode !== null && proc.exitCode !== undefined;
    const signalled = proc.signalCode !== null && proc.signalCode !== undefined;
    return exited || signalled;
  }

  /**
   * Send one signal to every live child.
   *
   * A throwing `kill` is swallowed per-process: the usual cause is that the
   * child already exited, and one dead handle must never stop the rest of the
   * set being signalled.
   *
   * @param {string} signal
   * @returns {number} how many were signalled without throwing
   */
  signalAll(signal) {
    let delivered = 0;
    // Snapshot first — the exit handler mutates the set as children die.
    for (const proc of [...this._live]) {
      try {
        proc.kill(signal);
        delivered += 1;
      } catch {
        // Already gone. Nothing to do, and nothing worth logging at quit time.
      }
    }
    return delivered;
  }

  /**
   * Ask politely, then insist.
   *
   * SIGTERM lets a child finalise — the ScreenCaptureKit helper writes its WAV
   * header on the way out, and killing it outright leaves a file every player
   * reads as zero-length. So the grace period is not politeness for its own
   * sake; it is what makes the last recording playable.
   *
   * Anything still alive when the grace runs out is killed, because the
   * alternative is an orphan holding the microphone.
   *
   * Always resolves. A shutdown path that can hang is worse than one that kills
   * something a moment early.
   *
   * @param {{graceMs?: number}} [opts]
   * @returns {Promise<{termed: number, killed: number, waitedMs: number}>}
   */
  async shutdown({ graceMs = this.graceMs } = {}) {
    const startedAt = this._now();
    const termed = this.signalAll('SIGTERM');

    if (this._live.size === 0) {
      return { termed, killed: 0, waitedMs: 0 };
    }

    await this._waitForExit(graceMs);

    const survivors = [...this._live].filter((p) => !ProcessRegistry.hasExited(p));
    let killed = 0;
    for (const proc of survivors) {
      try {
        proc.kill('SIGKILL');
        killed += 1;
      } catch {
        // Raced us to the exit. Fine.
      }
      this._live.delete(proc);
    }

    return { termed, killed, waitedMs: this._now() - startedAt };
  }

  /** Poll until everything has exited, or the grace period runs out. */
  _waitForExit(graceMs) {
    return new Promise((resolve) => {
      const deadline = this._now() + graceMs;

      const check = () => {
        const allGone = [...this._live].every((p) => ProcessRegistry.hasExited(p));
        if (allGone || this._now() >= deadline) {
          resolve();
          return;
        }
        this._setTimeout(check, POLL_MS);
      };

      check();
    });
  }
}

module.exports = { ProcessRegistry, DEFAULT_GRACE_MS, POLL_MS };
