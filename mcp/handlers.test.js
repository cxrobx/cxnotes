'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createHandlers, TOOLS } = require('./handlers');
const { PreparedMeetingStore } = require('../services/preparedMeetingStore');
const { MacOSCalendarSource } = require('../services/calendarSources');
const { getPreparedDir } = require('../shared/paths');

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n4c-mcp-'));
  return new PreparedMeetingStore({
    preparedDir: path.join(root, 'prepared'),
    tmpDir: path.join(root, 'tmp'),
  });
}

function makeEvent(overrides = {}) {
  return {
    id: overrides.id || 'evt-1',
    occurrenceFingerprint: overrides.occurrenceFingerprint || 'cal:ABC123:2026-06-17T15:00:00Z',
    title: overrides.title ?? 'Project Kickoff',
    startTime: overrides.startTime ?? '2026-06-17T15:00:00Z',
    endTime: overrides.endTime ?? '2026-06-17T15:30:00Z',
    isAllDay: overrides.isAllDay ?? false,
    organizer: { name: 'Alice', email: 'alice@example.com' },
    attendees: overrides.attendees ?? [
      { name: 'Bob', email: 'bob@example.com', isCurrentUser: false },
      { name: 'Chris', email: 'chris@example.com', isCurrentUser: true },
    ],
    notes: overrides.notes ?? 'Agenda: align on Q3',
    location: overrides.location ?? 'https://zoom.us/j/123',
    declinedByMe: overrides.declinedByMe ?? false,
  };
}

function happySource(events, current = null) {
  return {
    ensurePermission: async () => 'granted',
    getUpcomingEvents: async () => ({ events }),
    getCurrentEvent: async () => ({ event: current }),
  };
}

// A real MacOSCalendarSource backed by a fake spawn that exits with `code`.
function sourceWithExit(code, stdout = '') {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('exit', code);
    });
    return child;
  };
  return new MacOSCalendarSource({ helperPath: '/fake/calendar-helper', spawn, registerProcess: () => {} });
}

// ---------------------------------------------------------------------------
// Schema sanity
// ---------------------------------------------------------------------------

test('schema sanity: 7 tools, each with name/description/object inputSchema', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'cancel_prepared_meeting',
    'check_calendar_permission',
    'get_current_meeting',
    'list_prepared_meetings',
    'list_upcoming_meetings',
    'prepare_meeting',
    'render_meeting_template',
  ]);
  for (const t of TOOLS) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.equal(t.inputSchema.type, 'object');
  }
  const { tools } = createHandlers({ source: null, preparedStore: tempStore() });
  assert.equal(tools, TOOLS);
});

// ---------------------------------------------------------------------------
// Permission mapping through the real source (fake exit codes 2/3)
// ---------------------------------------------------------------------------

test('fake-helper exit 2 → PERMISSION error with fix (never silent empty list)', async () => {
  const { call } = createHandlers({ source: sourceWithExit(2), preparedStore: tempStore() });
  const res = await call('list_upcoming_meetings', {});
  assert.equal(res.error, 'permission');
  assert.equal(res.state, 'denied');
  assert.match(res.fix, /mcp:check|Privacy/);
});

test('fake-helper exit 3 → not-determined permission error', async () => {
  const { call } = createHandlers({ source: sourceWithExit(3), preparedStore: tempStore() });
  const res = await call('get_current_meeting', {});
  assert.equal(res.error, 'permission');
  assert.equal(res.state, 'not-determined');
});

test('check_calendar_permission reports granted state without error', async () => {
  const { call } = createHandlers({ source: sourceWithExit(0), preparedStore: tempStore() });
  const res = await call('check_calendar_permission', {});
  assert.equal(res.state, 'granted');
  assert.ok(!res.error);
});

// ---------------------------------------------------------------------------
// helper-missing degradation
// ---------------------------------------------------------------------------

test('source missing: calendar tools report helper-missing; prepared-store tools still work', async () => {
  const store = tempStore();
  const { call } = createHandlers({ source: null, preparedStore: store });

  const up = await call('list_upcoming_meetings', {});
  assert.equal(up.error, 'helper-missing');
  assert.equal(up.fix, 'npm run build:calendar');

  const listed = await call('list_prepared_meetings', {});
  assert.equal(listed.error, undefined);
  assert.equal(listed.count, 0);
});

// ---------------------------------------------------------------------------
// list_upcoming_meetings tags preparable
// ---------------------------------------------------------------------------

test('list_upcoming_meetings tags preparable + carries addressing keys', async () => {
  const solo = makeEvent({ id: 'solo', occurrenceFingerprint: 'cal:solo:1', attendees: [{ name: 'Me', isCurrentUser: true }] });
  const real = makeEvent();
  const { call } = createHandlers({ source: happySource([real, solo]), preparedStore: tempStore() });
  const res = await call('list_upcoming_meetings', { windowMinutes: 120 });
  assert.equal(res.count, 2);
  const byFp = Object.fromEntries(res.meetings.map((m) => [m.occurrenceFingerprint, m]));
  assert.equal(byFp['cal:ABC123:2026-06-17T15:00:00Z'].preparable, true);
  assert.equal(byFp['cal:solo:1'].preparable, false);
  assert.equal(byFp['cal:ABC123:2026-06-17T15:00:00Z'].joinUrl, 'https://zoom.us/j/123');
});

// ---------------------------------------------------------------------------
// Handoff round-trip: prepare → list → render → cancel
// ---------------------------------------------------------------------------

test('handoff round-trip: prepare → list → cancel via fingerprint', async () => {
  const store = tempStore();
  const event = makeEvent();
  const { call } = createHandlers({ source: happySource([event]), preparedStore: store });

  const prepared = await call('prepare_meeting', { fingerprint: event.occurrenceFingerprint });
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.fingerprint, event.occurrenceFingerprint);

  // The app side reads it straight from the store
  const onDisk = store.getByFingerprint(event.occurrenceFingerprint);
  assert.ok(onDisk);
  assert.equal(onDisk.source, 'mcp');
  assert.ok(onDisk.template.markdown.includes('# Project Kickoff'));

  const listed = await call('list_prepared_meetings', {});
  assert.equal(listed.count, 1);
  assert.equal(listed.prepared[0].occurrenceFingerprint, event.occurrenceFingerprint);

  const cancelled = await call('cancel_prepared_meeting', { fingerprint: event.occurrenceFingerprint });
  assert.equal(cancelled.cancelled, true);
  assert.equal(store.getByFingerprint(event.occurrenceFingerprint), null);
});

test('prepare_meeting: overrides replace title/agenda in the staged template', async () => {
  const store = tempStore();
  const event = makeEvent();
  const { call } = createHandlers({ source: happySource([event]), preparedStore: store });

  await call('prepare_meeting', {
    eventId: 'evt-1',
    overrides: { title: 'Renamed Sync', agenda: 'Custom agenda' },
  });
  const onDisk = store.getByFingerprint(event.occurrenceFingerprint);
  assert.equal(onDisk.title, 'Renamed Sync');
  assert.ok(onDisk.template.markdown.includes('Renamed Sync'));
  assert.ok(onDisk.template.markdown.includes('Custom agenda'));
});

test('render_meeting_template: returns context + markdown without staging', async () => {
  const store = tempStore();
  const event = makeEvent();
  const { call } = createHandlers({ source: happySource([event]), preparedStore: store });

  const res = await call('render_meeting_template', { fingerprint: event.occurrenceFingerprint });
  assert.equal(res.context.occurrenceFingerprint, event.occurrenceFingerprint);
  assert.ok(res.markdown.includes('## Agenda'));
  // Nothing staged
  assert.equal(store.list().length, 0);
});

test('prepare_meeting: unknown fingerprint → event-not-found', async () => {
  const { call } = createHandlers({ source: happySource([makeEvent()]), preparedStore: tempStore() });
  const res = await call('prepare_meeting', { fingerprint: 'cal:nope:1' });
  assert.equal(res.error, 'event-not-found');
});

test('unknown tool name → unknown-tool error', async () => {
  const { call } = createHandlers({ source: null, preparedStore: tempStore() });
  const res = await call('nope', {});
  assert.equal(res.error, 'unknown-tool');
});

// ---------------------------------------------------------------------------
// Path agreement: default store and shared/paths resolve the same prepared dir
// ---------------------------------------------------------------------------

test('path agreement: default PreparedMeetingStore uses shared getPreparedDir()', () => {
  const store = new PreparedMeetingStore();
  assert.equal(store._preparedDir, getPreparedDir());
});
