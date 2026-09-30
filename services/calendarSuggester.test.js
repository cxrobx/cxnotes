'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { CalendarSuggester, MENU_WINDOW_MINUTES, MENU_MAX } = require('./calendarSuggester');

// Minimal fakes for the suggester's collaborators.
function makeStore(overrides = {}) {
  const m = { calendarLeadTimeMinutes: 2, calendarDenylist: [], ...overrides };
  return { get: (k) => m[k] };
}
const registry = { pruneExpired() {}, isDismissed() { return false; } };

function ev(id, startMs) {
  return {
    occurrenceFingerprint: `fp:${id}`,
    title: `Meeting ${id}`,
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(startMs + 30 * 60 * 1000).toISOString(),
    isAllDay: false,
    declinedByMe: false,
    meetingWorthy: true, // pass meetingFilter without needing >=2 attendees
    attendees: [],
  };
}

test('poll widens the window to the 12h menu horizon but only lead-window meetings fire', async () => {
  const NOW = new Date('2026-06-17T12:00:00Z');
  const nowMs = NOW.getTime();
  // Six eligible meetings: one within the 2-min lead window, five more across 12h.
  const events = [
    ev('near', nowMs + 1 * 60 * 1000), // within lead → fires a banner
    ev('a', nowMs + 30 * 60 * 1000),
    ev('b', nowMs + 60 * 60 * 1000),
    ev('c', nowMs + 120 * 60 * 1000),
    ev('d', nowMs + 240 * 60 * 1000),
    ev('e', nowMs + 480 * 60 * 1000), // furthest — dropped by the MENU_MAX cap
  ];

  let capturedWindow = null;
  const fired = [];
  let onUpcomingList = null;

  const source = {
    async ensurePermission() { return 'granted'; },
    async getUpcomingEvents({ windowMinutes }) {
      capturedWindow = windowMinutes;
      const end = nowMs + windowMinutes * 60 * 1000;
      return {
        events: events
          .filter((e) => {
            const s = Date.parse(e.startTime);
            return s >= nowMs && s <= end;
          })
          .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)),
      };
    },
    async getCurrentEvent() { return { event: null }; },
  };

  const suggester = new CalendarSuggester({
    store: makeStore(),
    source,
    dismissalRegistry: registry,
    onSuggestion: (s) => fired.push(s.fingerprint),
    onUpcoming: (list) => { onUpcomingList = list; },
    now: () => NOW,
  });

  // Drive one poll directly (bypass ensurePermission/setInterval).
  suggester._running = true;
  await suggester._poll();

  assert.equal(capturedWindow, MENU_WINDOW_MINUTES, 'poll requests the 12h horizon');
  assert.deepEqual(fired, ['fp:near'], 'widening the window did not change which meetings fire');

  const menu = suggester.getUpcomingMeetings();
  assert.equal(menu.length, MENU_MAX, 'menu is capped at MENU_MAX');
  assert.equal(menu[0].occurrenceFingerprint, 'fp:near', 'soonest-first');
  assert.ok(!menu.some((e) => e.occurrenceFingerprint === 'fp:e'), 'furthest meeting dropped by the cap');
  assert.deepEqual(
    onUpcomingList.map((e) => e.occurrenceFingerprint),
    menu.map((e) => e.occurrenceFingerprint),
    'onUpcoming callback receives the cached list'
  );
});

test('getUpcomingMeetings returns a copy and stop() clears it', async () => {
  const NOW = new Date('2026-06-17T12:00:00Z');
  const source = {
    async ensurePermission() { return 'granted'; },
    async getUpcomingEvents() { return { events: [ev('x', NOW.getTime() + 60 * 60 * 1000)] }; },
    async getCurrentEvent() { return { event: null }; },
  };
  const suggester = new CalendarSuggester({
    store: makeStore(),
    source,
    dismissalRegistry: registry,
    now: () => NOW,
  });
  suggester._running = true;
  await suggester._poll();

  const menu = suggester.getUpcomingMeetings();
  assert.equal(menu.length, 1);
  menu.push('mutation'); // must not affect the cache
  assert.equal(suggester.getUpcomingMeetings().length, 1, 'returned array is a copy');

  suggester.stop();
  assert.deepEqual(suggester.getUpcomingMeetings(), [], 'stop() clears the cached list');
});
