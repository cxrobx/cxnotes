'use strict';

/**
 * Meeting eligibility filter — the single predicate that decides whether a
 * calendar event is worth surfacing / preparing.
 *
 * Extracted verbatim from CalendarSuggester._passesFilters so the suggester
 * (which fires banners) and the MCP server (which tags events `preparable`)
 * apply EXACTLY the same rules and can never drift.
 *
 * Rules (applied in order — any failure drops the event):
 *   1. >= 2 attendees  — UNLESS the event is flagged `meetingWorthy` (see below)
 *   2. not isAllDay
 *   3. not declined by the current user
 *   4. title does not match any denylist pattern (case-insensitive substring)
 *
 * The >=2-attendee rule is an EventKit heuristic for dropping personal
 * time-blocks. Sources that establish meeting-worthiness another way — cxmail,
 * whose rows are `.ics` invites or high-confidence detected meetings and carry no
 * attendee list — set `event.meetingWorthy: true` and skip rule 1. All other
 * rules (and the denylist) still apply to them.
 */

// The electron-store default denylist. Exported so non-store consumers (the MCP
// server) can opt into the same default the app ships with.
const DEFAULT_DENYLIST = Object.freeze(['Lunch', 'Gym', 'Focus', 'Block', 'OOO', 'Holiday']);

/**
 * @param {object} event - a calendar event (see calendar-helper JSON shape)
 * @param {object} [opts]
 * @param {string[]} [opts.denylist=[]] - case-insensitive title-substring denylist
 * @returns {boolean} true when the event passes every rule
 */
function passesMeetingFilter(event, { denylist = [] } = {}) {
  if (!event || typeof event !== 'object') return false;
  if (event.isAllDay) return false;
  if (event.declinedByMe) return false;

  // Rule 1 — skipped for sources that establish meeting-worthiness without an
  // attendee list (cxmail). EventKit events have no meetingWorthy flag, so this
  // path is unchanged for them.
  if (!event.meetingWorthy) {
    const attendees = Array.isArray(event.attendees) ? event.attendees : [];
    if (attendees.length < 2) return false;
  }

  if (Array.isArray(denylist) && denylist.length > 0) {
    const title = (event.title || '').toLowerCase();
    for (const pattern of denylist) {
      if (typeof pattern !== 'string' || !pattern.trim()) continue;
      if (title.includes(pattern.trim().toLowerCase())) return false;
    }
  }

  return true;
}

module.exports = { passesMeetingFilter, DEFAULT_DENYLIST };
