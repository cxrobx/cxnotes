'use strict';

/**
 * Fallback Calendar Source
 *
 * Wraps the cxmail source (primary) and the macOS EventKit source (fallback) and
 * picks one per the `calendarSource` setting:
 *   'auto'   (default) — cxmail when its DB is present + readable, else macOS.
 *   'cxmail'           — force cxmail (no fallback).
 *   'macos'            — force the original EventKit source.
 *
 * The whole point: every user gets the original EventKit behaviour for free when
 * cxmail isn't installed — no configuration required.
 *
 * The mode + availability are re-read on each `ensurePermission()` (which the
 * suggester calls on every `start()`), so flipping the setting takes effect on the
 * next start without reconstructing anything. `getUpcomingEvents` /
 * `getCurrentEvent` delegate to whichever source was active as of the last pick.
 */

const { enrichEvents, enrichEvent } = require('./attendeeMerge');

const MODE_AUTO = 'auto';
const MODE_CXMAIL = 'cxmail';
const MODE_MACOS = 'macos';

/**
 * How long a fetched EventKit roster stays good for. The suggester polls on a
 * timer, and each enrichment is a process spawn, so without this the join costs
 * a `calendar-helper` launch per poll. Attendee lists change on the scale of
 * days; a minute of staleness is free.
 */
const ROSTER_CACHE_TTL_MS = 60 * 1000;

class FallbackCalendarSource {
  /**
   * @param {object} opts
   * @param {object} opts.cxmail - CxmailCalendarSource (must expose isAvailable())
   * @param {object} opts.macos - MacOSCalendarSource
   * @param {() => string} [opts.getMode] - live read of the calendarSource setting
   * @param {(label: string, mode: string) => void} [opts.onPick] - diagnostics hook
   */
  constructor({ cxmail, macos, getMode, onPick, now, rosterCacheTtlMs } = {}) {
    if (!cxmail) throw new Error('FallbackCalendarSource: cxmail source required');
    if (!macos) throw new Error('FallbackCalendarSource: macos source required');
    this._cxmail = cxmail;
    this._macos = macos;
    this._getMode = typeof getMode === 'function' ? getMode : () => MODE_AUTO;
    this._onPick = typeof onPick === 'function' ? onPick : null;
    this._active = null;

    // Attendee completion (see ./attendeeMerge). Only meaningful while cxmail is
    // active — in macOS mode the rosters are already EventKit's.
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._rosterCacheTtlMs = Number.isFinite(rosterCacheTtlMs) ? rosterCacheTtlMs : ROSTER_CACHE_TTL_MS;
    this._macosPermission = null;
    this._rosterCache = new Map();
  }

  /** Decide (and remember) the active source from the current mode + availability. */
  _pick() {
    const mode = this._getMode() || MODE_AUTO;
    let active;
    let label;
    if (mode === MODE_MACOS) {
      active = this._macos;
      label = 'macos';
    } else if (mode === MODE_CXMAIL) {
      active = this._cxmail;
      label = 'cxmail';
    } else {
      const cxmailReady =
        typeof this._cxmail.isAvailable === 'function' && this._cxmail.isAvailable();
      active = cxmailReady ? this._cxmail : this._macos;
      label = cxmailReady ? 'cxmail' : 'macos';
    }

    if (active !== this._active && this._onPick) {
      try {
        this._onPick(label, mode);
      } catch {
        /* diagnostics must never throw */
      }
    }
    this._active = active;
    return active;
  }

  _activeOrPick() {
    return this._active || this._pick();
  }

  async ensurePermission() {
    const active = this._pick();
    const result = await active.ensurePermission();

    // While cxmail is active, ALSO settle the EventKit permission, because
    // cxmail cannot see a non-responder on a meeting the user organised and
    // EventKit can (see ./attendeeMerge). Asking here rather than lazily puts
    // the one-time system dialog at app start, next to the calendar polling the
    // user has already opted into, instead of in front of them when they press
    // Record.
    //
    // Strictly best-effort: a denied or broken EventKit costs us the completion
    // and nothing else, so its result never becomes cxmail's answer.
    if (active === this._cxmail) {
      try {
        this._macosPermission = await this._macos.ensurePermission();
      } catch {
        this._macosPermission = 'denied';
      }
    }

    return result;
  }

  async getUpcomingEvents(opts) {
    const active = this._activeOrPick();
    const result = await active.getUpcomingEvents(opts);
    if (active !== this._cxmail || !result || !Array.isArray(result.events) || !result.events.length) {
      return result;
    }

    const windowMinutes = (opts && opts.windowMinutes) || 0;
    const roster = await this._macosRoster(`upcoming:${windowMinutes}`, async () => {
      const macosResult = await this._macos.getUpcomingEvents({ windowMinutes });
      return (macosResult && Array.isArray(macosResult.events)) ? macosResult.events : [];
    });
    if (!roster.length) return result;

    return { ...result, events: enrichEvents(result.events, roster) };
  }

  async getCurrentEvent() {
    const active = this._activeOrPick();
    const result = await active.getCurrentEvent();
    if (active !== this._cxmail || !result || !result.event) return result;

    const roster = await this._macosRoster('current', async () => {
      const macosResult = await this._macos.getCurrentEvent();
      return (macosResult && macosResult.event) ? [macosResult.event] : [];
    });
    if (!roster.length) return result;

    return { ...result, event: enrichEvent(result.event, roster) };
  }

  /**
   * EventKit events for `key`, from cache when fresh. Returns [] whenever
   * completion is unavailable for any reason — no permission, a helper failure,
   * a thrown spawn — so every caller degrades to the un-enriched roster rather
   * than to an error.
   */
  async _macosRoster(key, fetch) {
    if (this._macosPermission !== 'granted') return [];

    const cached = this._rosterCache.get(key);
    const nowMs = this._now();
    if (cached && nowMs - cached.atMs < this._rosterCacheTtlMs) return cached.events;

    let events = [];
    try {
      events = await fetch();
    } catch {
      events = [];
    }
    this._rosterCache.set(key, { events, atMs: nowMs });
    return events;
  }

  /** Which concrete source is active ('cxmail' | 'macos' | null) — for diagnostics. */
  getActiveLabel() {
    if (this._active === this._cxmail) return 'cxmail';
    if (this._active === this._macos) return 'macos';
    return null;
  }
}

module.exports = { FallbackCalendarSource, MODE_AUTO, MODE_CXMAIL, MODE_MACOS };
