/**
 * Dismissal Registry
 *
 * Single source of truth for banner-dismiss state, consulted by both the
 * meeting detector (app-detected banners) and the calendar suggester
 * (pre-meeting banners). Without this, a user could dismiss the pre-meeting
 * banner for an event and then have the detector re-fire it the moment
 * Zoom opens, because the two services would have separate dismiss sets.
 *
 * Two kinds of fingerprint live here:
 *   - `app`      e.g. `zoom-1717512345678` — in-memory only, no persistence value
 *                (process PIDs/timestamps are ephemeral and never repeat).
 *   - `calendar` e.g. `cal:<calendarItemIdentifier>:<startTimeISO>` — persisted
 *                with an expiry so dismissals survive an app restart within
 *                the meeting's window.
 *
 * The registry intentionally exposes only `isDismissed` / `dismiss`; callers
 * must NOT maintain their own dismissal sets. Keeping the check centralised
 * here is the whole point.
 */

const STORE_KEY = 'calendarDismissedFingerprints';

class DismissalRegistry {
  /**
   * @param {object} opts
   * @param {object} opts.store - electron-store instance for persistence
   * @param {() => Date} [opts.now] - clock injection for tests
   */
  constructor({ store, now = () => new Date() }) {
    this._store = store;
    this._now = now;

    // App fingerprints: in-memory only, dropped on app quit (Set<string>)
    this._appFingerprints = new Set();

    // Calendar fingerprints: persisted (Map<fingerprint, expiryISO>)
    this._calendarFingerprints = new Map();

    this._loadCalendarFingerprints();
  }

  _loadCalendarFingerprints() {
    const raw = this._store.get(STORE_KEY) || [];
    if (!Array.isArray(raw)) return;

    const now = this._now();
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const { fingerprint, expiry } = entry;
      if (typeof fingerprint !== 'string') continue;
      if (typeof expiry !== 'string') continue;
      const expiryDate = new Date(expiry);
      if (Number.isNaN(expiryDate.getTime())) continue;
      // Prune anything already expired at boot
      if (expiryDate <= now) continue;
      this._calendarFingerprints.set(fingerprint, expiry);
    }
    // Write back the pruned set
    this._persist();
  }

  _persist() {
    const arr = Array.from(this._calendarFingerprints.entries()).map(
      ([fingerprint, expiry]) => ({ fingerprint, expiry })
    );
    this._store.set(STORE_KEY, arr);
  }

  /**
   * Drop calendar entries whose expiry is in the past. Called by the
   * suggester at the start of every poll so disk state stays bounded.
   */
  pruneExpired() {
    const now = this._now();
    let mutated = false;
    for (const [fingerprint, expiry] of this._calendarFingerprints.entries()) {
      const d = new Date(expiry);
      if (Number.isNaN(d.getTime()) || d <= now) {
        this._calendarFingerprints.delete(fingerprint);
        mutated = true;
      }
    }
    if (mutated) this._persist();
  }

  /**
   * Check whether a fingerprint has been dismissed. Calendar fingerprints
   * also respect expiry (an entry past its expiry is treated as not-dismissed
   * and removed lazily).
   *
   * @param {string} fingerprint
   * @returns {boolean}
   */
  isDismissed(fingerprint) {
    if (typeof fingerprint !== 'string' || !fingerprint) return false;
    if (this._appFingerprints.has(fingerprint)) return true;

    const expiry = this._calendarFingerprints.get(fingerprint);
    if (!expiry) return false;

    const d = new Date(expiry);
    if (Number.isNaN(d.getTime()) || d <= this._now()) {
      this._calendarFingerprints.delete(fingerprint);
      this._persist();
      return false;
    }
    return true;
  }

  /**
   * Record a dismissal. Calendar dismissals must supply an expiry (typically
   * the event's endTime); app dismissals do not persist.
   *
   * @param {string} fingerprint
   * @param {object} opts
   * @param {'calendar'|'app'} opts.kind
   * @param {string} [opts.expiry] - ISO timestamp, required for kind=calendar
   */
  dismiss(fingerprint, { kind, expiry } = {}) {
    if (typeof fingerprint !== 'string' || !fingerprint) return;

    if (kind === 'app') {
      this._appFingerprints.add(fingerprint);
      return;
    }

    if (kind === 'calendar') {
      // If no expiry given, default to 24 hours out — better than dropping
      // the dismissal entirely, and pruneExpired will clean it up.
      const safeExpiry = expiry || new Date(this._now().getTime() + 24 * 3600 * 1000).toISOString();
      this._calendarFingerprints.set(fingerprint, safeExpiry);
      this._persist();
      return;
    }

    // No kind supplied — assume app fingerprint (backward-compat shim
    // for any callers that haven't been updated)
    this._appFingerprints.add(fingerprint);
  }
}

module.exports = { DismissalRegistry };
