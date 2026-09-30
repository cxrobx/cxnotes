/**
 * Calendar Suggester
 *
 * Polls the configured calendar source every 60s and emits a suggestion when
 * an upcoming event enters the user-configured lead-time window. Also caches
 * the "currently-in-progress" event so the meeting detector can enrich its
 * existing banner without spawning the helper on every poll.
 *
 * Filter rules (applied in order — any failure drops the event):
 *   1. >= 2 attendees
 *   2. not isAllDay
 *   3. not declined by the current user
 *   4. title does not match any pattern in `calendarDenylist`
 *      (case-insensitive substring match)
 *
 * Fingerprint format (stable across CalDAV resyncs):
 *   cal:<calendarItemIdentifier>:<startTimeISO>
 *
 * Dismissals are owned by `DismissalRegistry` — the suggester never keeps its
 * own dismiss state. That way, dismissing a pre-meeting banner ALSO suppresses
 * the detector banner for the same occurrence (and vice versa).
 */

const { passesMeetingFilter } = require('./meetingFilter');

const POLL_INTERVAL_MS = 60_000;
const ON_DEMAND_REFRESH_TIMEOUT_MS = 500;
const CURRENT_CACHE_FRESH_MS = POLL_INTERVAL_MS; // cache is good for the length of a poll cycle

// The tray "Upcoming on your calendar" section is derived from the SAME poll as
// the banner (no extra sqlite spawns): we widen the lookahead to this horizon
// and cache the filtered, deduped list. Banner timing is untouched — the fire
// loop still re-gates each event on `msUntilStart <= leadMs`.
const MENU_WINDOW_MINUTES = 720; // 12h
const MENU_MAX = 5; // most meetings we surface in the tray at once

class CalendarSuggester {
  /**
   * @param {object} opts
   * @param {object} opts.store - electron-store instance
   * @param {object} opts.source - calendar source instance (has getUpcomingEvents/getCurrentEvent)
   * @param {object} opts.dismissalRegistry - shared DismissalRegistry instance
   * @param {(suggestion: object) => void} [opts.onSuggestion] - banner-fire callback
   * @param {(meetings: object[]) => void} [opts.onUpcoming] - tray-menu list callback
   * @param {() => Date} [opts.now] - clock injection for tests
   */
  constructor({ store, source, dismissalRegistry, onSuggestion, onUpcoming, now = () => new Date() }) {
    this._store = store;
    this._source = source;
    this._registry = dismissalRegistry;
    this._onSuggestion = onSuggestion || null;
    this._onUpcoming = onUpcoming || null;
    this._now = now;

    this._running = false;
    this._interval = null;

    // Filtered, deduped list of near-term meetings for the tray menu (derived
    // from the same poll as the banner). Cleared on stop().
    this._cachedUpcomingMeetings = [];

    // Pre-meeting fingerprints we've already fired a banner for, in-memory
    // (the persistent dismissal lives in the registry; this set is just to
    // avoid re-firing during the same app session if the user neither
    // dismissed nor took notes).
    this._firedFingerprints = new Set();

    // Cached "currently in progress" event for the detector enricher.
    // { event, computedAt: Date }
    this._cachedCurrentEvent = { event: null, computedAt: null };

    // The most recent permission state we observed, surfaced via getPermissionState().
    this._permissionState = 'not-determined';
  }

  start() {
    if (this._running) return;
    this._running = true;
    // Permission must be granted before we enter the poll loop. If denied or
    // not-determined, self-disable instead of looping helper invocations
    // against a state the user has to fix from System Settings.
    this._startAsync().catch(() => {
      this._running = false;
    });
  }

  async _startAsync() {
    // Calling ensurePermission on the macOS source triggers the TCC prompt
    // the first time, then returns the resolved state. This is exactly what
    // we want when the user has just flipped the suggestions toggle on.
    const state = await this._source.ensurePermission();
    this._permissionState = state;
    if (state !== 'granted') {
      this._running = false;
      return;
    }
    if (!this._running) return; // stop() called while we awaited permission
    this._interval = setInterval(() => {
      this._poll().catch(() => { /* never crash the app on suggester errors */ });
    }, POLL_INTERVAL_MS);
    // Fire once immediately so the first suggestion isn't delayed by 60s
    this._poll().catch(() => {});
  }

  stop() {
    this._running = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._firedFingerprints.clear();
    this._cachedCurrentEvent = { event: null, computedAt: null };
    this._cachedUpcomingMeetings = [];
  }

  onSuggestion(cb) {
    this._onSuggestion = cb;
  }

  onUpcoming(cb) {
    this._onUpcoming = cb;
  }

  /**
   * The tray-menu list computed by the last poll: filtered (meetingFilter),
   * deduped (by the source), within the 12h horizon, not yet ended, capped at
   * MENU_MAX. Sorted soonest-first. Returns a copy so callers can't mutate it.
   */
  getUpcomingMeetings() {
    return this._cachedUpcomingMeetings.slice();
  }

  /**
   * The underlying source. Exposed so `main.js` can route the
   * `calendar:requestPermission` IPC through the same source instance the
   * suggester polls — important because EventKit permission is keyed by
   * the binary signature, and we want both pathways to hit the same helper.
   */
  getSource() {
    return this._source;
  }

  /**
   * Last observed permission state. UI uses this to render the status row.
   */
  getPermissionState() {
    return this._permissionState;
  }

  /**
   * Cache-first read used by the meeting detector enricher. Returns the
   * currently-in-progress event if (a) we polled recently AND (b) the cached
   * window still contains now. Returns null otherwise; caller can call
   * `refreshCurrentEvent()` to do an on-demand spawn.
   */
  getCurrentMeetingEventSync() {
    const { event, computedAt } = this._cachedCurrentEvent;
    if (!event || !computedAt) return null;

    const now = this._now();
    const ageMs = now.getTime() - computedAt.getTime();
    if (ageMs > CURRENT_CACHE_FRESH_MS) return null;

    const start = new Date(event.startTime);
    const end = new Date(event.endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    if (now < start || now >= end) return null;
    return event;
  }

  /**
   * On-demand spawn of the helper's `current` subcommand. Bounded so a slow
   * helper never blocks banner creation. On timeout or error returns null —
   * the detector then falls back to the un-enriched payload.
   */
  async refreshCurrentEvent() {
    if (!this._running) return null;

    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ event: null, error: 'timeout' }), ON_DEMAND_REFRESH_TIMEOUT_MS);
    });

    let result;
    try {
      result = await Promise.race([this._source.getCurrentEvent(), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    if (!result || result.error) return null;
    const event = result.event;
    if (!event) return null;

    // Update the cache so subsequent sync reads stay fast
    this._cachedCurrentEvent = { event, computedAt: this._now() };
    return event;
  }

  _passesFilters(event) {
    // The eligibility predicate lives in services/meetingFilter so the MCP
    // server's `preparable` flag and this suggester can never drift.
    return passesMeetingFilter(event, { denylist: this._store.get('calendarDenylist') || [] });
  }

  async _poll() {
    if (!this._running) return;

    // Bound the lookahead window. We pull the WIDER of "a little more than the
    // lead time" and the tray-menu horizon (12h), so one poll feeds both the
    // banner and the "Upcoming on your calendar" menu with no extra spawns. The
    // banner fire loop below re-gates each event on the lead time, so widening
    // the window can never change WHICH meetings fire a banner — only what the
    // menu can list.
    const leadTimeMinutes = Number(this._store.get('calendarLeadTimeMinutes'));
    const safeLead = Number.isFinite(leadTimeMinutes) && leadTimeMinutes >= 0 && leadTimeMinutes <= 120
      ? leadTimeMinutes
      : 2;
    const windowMinutes = Math.max(safeLead + 1, MENU_WINDOW_MINUTES);

    // Prune the registry once per poll so disk state stays bounded
    this._registry.pruneExpired();

    // Run upcoming + current in parallel — both feed the cache, only upcoming fires banners
    const [upcomingResult, currentResult] = await Promise.all([
      this._source.getUpcomingEvents({ windowMinutes }),
      this._source.getCurrentEvent()
    ]);

    // Update permission-state telemetry from whichever call ran first
    if (upcomingResult && upcomingResult.error === 'permission-denied') {
      this._permissionState = 'denied';
    } else if (upcomingResult && upcomingResult.error === 'not-determined') {
      this._permissionState = 'not-determined';
    } else {
      this._permissionState = 'granted';
    }

    // Refresh the current-event cache (null is a valid answer here)
    if (currentResult && !currentResult.error) {
      this._cachedCurrentEvent = {
        event: currentResult.event || null,
        computedAt: this._now()
      };
    }

    if (!upcomingResult || upcomingResult.error || !Array.isArray(upcomingResult.events)) {
      return;
    }

    const now = this._now();
    const leadMs = safeLead * 60 * 1000;

    for (const event of upcomingResult.events) {
      const fingerprint = event.occurrenceFingerprint;
      if (typeof fingerprint !== 'string' || !fingerprint) continue;

      if (this._firedFingerprints.has(fingerprint)) continue;
      if (this._registry.isDismissed(fingerprint)) continue;
      if (!this._passesFilters(event)) continue;

      const start = new Date(event.startTime);
      if (Number.isNaN(start.getTime())) continue;

      const msUntilStart = start.getTime() - now.getTime();
      // Fire if we're inside the lead window (or already overlapping the start)
      if (msUntilStart > leadMs) continue;

      // Eligibility tail: don't fire for a meeting that already ended
      const end = new Date(event.endTime);
      if (Number.isFinite(end.getTime()) && end <= now) continue;

      this._firedFingerprints.add(fingerprint);

      if (this._onSuggestion) {
        try {
          this._onSuggestion({
            source: 'calendar',
            fingerprint,
            event
          });
        } catch (_err) {
          // Callback errors must not kill the suggester loop
        }
      }
    }

    // Derive the tray-menu list from the same poll: eligible meetings within the
    // 12h horizon that haven't ended yet, soonest-first, capped at MENU_MAX.
    const menuHorizon = now.getTime() + MENU_WINDOW_MINUTES * 60 * 1000;
    const menuList = upcomingResult.events
      .filter((event) => this._passesFilters(event))
      .filter((event) => {
        const start = new Date(event.startTime);
        if (Number.isNaN(start.getTime())) return false;
        if (start.getTime() > menuHorizon) return false;
        const end = new Date(event.endTime);
        if (Number.isFinite(end.getTime()) && end <= now) return false; // already ended
        return true;
      })
      .slice(0, MENU_MAX);

    this._cachedUpcomingMeetings = menuList;
    if (this._onUpcoming) {
      try {
        this._onUpcoming(menuList);
      } catch (_err) {
        // Callback errors must not kill the suggester loop
      }
    }
  }
}

module.exports = { CalendarSuggester, POLL_INTERVAL_MS, MENU_WINDOW_MINUTES, MENU_MAX };
