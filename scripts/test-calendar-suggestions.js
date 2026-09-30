#!/usr/bin/env node
/**
 * Functional tests for the calendar-suggestions feature.
 *
 * Run with: node scripts/test-calendar-suggestions.js
 *
 * Covers everything that doesn't require the user clicking through the
 * macOS Calendar permission prompt:
 *   - DismissalRegistry: persistence, pruning, app vs calendar kinds
 *   - CalendarSuggester: filter rules, fingerprint dedup, lead-time gate,
 *     cache + on-demand refresh, source-error handling
 *   - MeetingDetector enricher path: timeout fallback, registry dedup
 *   - main.js helpers: buildPreRecordSeedFromEvent, buildAgendaFromNotes
 *   - Real Swift helper: request-access exit codes, JSON shape
 */

const path = require('path');
const repoRoot = path.resolve(__dirname, '..');

const { DismissalRegistry } = require(path.join(repoRoot, 'services/dismissalRegistry'));
const { CalendarSuggester } = require(path.join(repoRoot, 'services/calendarSuggester'));
const { MeetingDetector } = require(path.join(repoRoot, 'services/meetingDetector'));
const { MacOSCalendarSource } = require(path.join(repoRoot, 'services/calendarSources'));

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ': ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function makeStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get: (k) => m.get(k),
    set: (k, v) => m.set(k, v),
    _dump: () => Object.fromEntries(m.entries())
  };
}

function makeEvent(overrides = {}) {
  const start = overrides.startTime || new Date(Date.now() + 60_000).toISOString();
  const end = overrides.endTime || new Date(Date.now() + 30 * 60_000).toISOString();
  const id = overrides.id || 'cal-id-' + Math.random().toString(36).slice(2, 8);
  return {
    id,
    occurrenceFingerprint: overrides.occurrenceFingerprint || `cal:${id}:${start}`,
    title: overrides.title ?? 'Project Kickoff',
    startTime: start,
    endTime: end,
    isAllDay: overrides.isAllDay ?? false,
    calendarTitle: 'Work',
    organizer: { name: 'Alice', email: 'alice@example.com' },
    attendees: overrides.attendees ?? [
      { name: 'Bob', email: 'bob@example.com', role: 'required', status: 'accepted', isCurrentUser: false },
      { name: 'Chris', email: 'chris@example.com', role: 'required', status: 'accepted', isCurrentUser: true }
    ],
    notes: overrides.notes ?? 'Agenda: align on Q3',
    location: overrides.location ?? '',
    declinedByMe: overrides.declinedByMe ?? false
  };
}

// Wait helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =============================================================================
async function suite_DismissalRegistry() {
  console.log('\n[DismissalRegistry]');

  // Persistence + roundtrip
  {
    const store = makeStore({ calendarDismissedFingerprints: [] });
    const reg = new DismissalRegistry({ store });
    const fp = 'cal:abc:2026-05-14T15:00:00Z';
    const expiry = new Date(Date.now() + 60_000).toISOString();

    assert('not dismissed by default', reg.isDismissed(fp) === false);
    reg.dismiss(fp, { kind: 'calendar', expiry });
    assert('dismissed after dismiss()', reg.isDismissed(fp) === true);

    const persisted = store.get('calendarDismissedFingerprints');
    assert('persisted to store as array', Array.isArray(persisted) && persisted.length === 1);
    assert('persisted entry shape',
      persisted[0].fingerprint === fp && persisted[0].expiry === expiry);
  }

  // App fingerprints are not persisted
  {
    const store = makeStore({ calendarDismissedFingerprints: [] });
    const reg = new DismissalRegistry({ store });
    reg.dismiss('zoom-12345', { kind: 'app' });
    assert('app dismissal in-memory', reg.isDismissed('zoom-12345') === true);
    const persisted = store.get('calendarDismissedFingerprints');
    assert('app dismissal not persisted',
      Array.isArray(persisted) && persisted.length === 0);
  }

  // Boot-time pruning of expired entries
  {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const store = makeStore({
      calendarDismissedFingerprints: [
        { fingerprint: 'cal:past:x', expiry: past },
        { fingerprint: 'cal:future:y', expiry: future }
      ]
    });
    const reg = new DismissalRegistry({ store });
    assert('past entry pruned at boot', reg.isDismissed('cal:past:x') === false);
    assert('future entry retained at boot', reg.isDismissed('cal:future:y') === true);
  }

  // Lazy prune on isDismissed when expiry passes
  {
    const store = makeStore({ calendarDismissedFingerprints: [] });
    let nowMs = Date.now();
    const reg = new DismissalRegistry({ store, now: () => new Date(nowMs) });
    const expiry = new Date(nowMs + 1000).toISOString();
    reg.dismiss('cal:soon:t', { kind: 'calendar', expiry });
    assert('dismissed while inside window', reg.isDismissed('cal:soon:t') === true);
    nowMs += 5000;
    assert('lazy-pruned past expiry', reg.isDismissed('cal:soon:t') === false);
  }

  // Corrupt data tolerated
  {
    const store = makeStore({
      calendarDismissedFingerprints: [
        null,
        { fingerprint: 123, expiry: 'x' },
        { fingerprint: 'cal:ok', expiry: 'not a date' },
        'not an object'
      ]
    });
    const reg = new DismissalRegistry({ store });
    assert('corrupt data doesn\'t throw', reg.isDismissed('anything') === false);
  }
}

// =============================================================================
async function suite_Suggester_Filters() {
  console.log('\n[CalendarSuggester filters]');

  function makeFakeSource(upcoming, current = null) {
    return {
      getUpcomingEvents: async () => ({ events: upcoming }),
      getCurrentEvent: async () => ({ event: current }),
      ensurePermission: async () => 'granted'
    };
  }

  async function runOnePoll(events, storeOverrides = {}) {
    const fired = [];
    const store = makeStore({
      calendarLeadTimeMinutes: 2,
      calendarDenylist: ['Lunch', 'Focus'],
      calendarDismissedFingerprints: [],
      ...storeOverrides
    });
    const reg = new DismissalRegistry({ store });
    const sg = new CalendarSuggester({
      store,
      source: makeFakeSource(events),
      dismissalRegistry: reg,
      onSuggestion: (s) => fired.push(s)
    });
    // Avoid the setInterval: drive _poll directly
    sg._running = true;
    await sg._poll();
    sg._running = false;
    return { fired, store, reg };
  }

  // Solo event (1 attendee) → dropped
  {
    const e = makeEvent({
      attendees: [{ name: 'Me', email: 'me@x.com', isCurrentUser: true, status: 'accepted', role: 'required' }],
      startTime: new Date(Date.now() + 30_000).toISOString()
    });
    const { fired } = await runOnePoll([e]);
    assert('solo event dropped (<2 attendees)', fired.length === 0);
  }

  // All-day → dropped
  {
    const e = makeEvent({ isAllDay: true, startTime: new Date(Date.now() + 30_000).toISOString() });
    const { fired } = await runOnePoll([e]);
    assert('all-day event dropped', fired.length === 0);
  }

  // Declined by me → dropped
  {
    const e = makeEvent({ declinedByMe: true, startTime: new Date(Date.now() + 30_000).toISOString() });
    const { fired } = await runOnePoll([e]);
    assert('declined event dropped', fired.length === 0);
  }

  // Denylist substring match (case-insensitive) → dropped
  {
    const e = makeEvent({ title: 'Lunch with Bob', startTime: new Date(Date.now() + 30_000).toISOString() });
    const { fired } = await runOnePoll([e]);
    assert('denylist match drops event', fired.length === 0);
  }
  {
    const e = makeEvent({ title: 'FOCUS Friday', startTime: new Date(Date.now() + 30_000).toISOString() });
    const { fired } = await runOnePoll([e]);
    assert('denylist case-insensitive', fired.length === 0);
  }

  // Outside lead-time window → not fired (yet)
  {
    const e = makeEvent({ startTime: new Date(Date.now() + 10 * 60_000).toISOString() });
    const { fired } = await runOnePoll([e]); // default lead=2
    assert('outside lead-time window: no fire', fired.length === 0);
  }

  // Inside lead-time window → fired
  {
    const e = makeEvent({ startTime: new Date(Date.now() + 60_000).toISOString() });
    const { fired } = await runOnePoll([e]);
    assert('inside lead-time window: fired once', fired.length === 1);
    assert('payload has source=calendar', fired[0]?.source === 'calendar');
    assert('payload has fingerprint', typeof fired[0]?.fingerprint === 'string' && fired[0].fingerprint.startsWith('cal:'));
  }

  // Already-ended event → not fired
  {
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    const ended = new Date(Date.now() - 30 * 60_000).toISOString();
    const e = makeEvent({ startTime: past, endTime: ended });
    const { fired } = await runOnePoll([e]);
    assert('already-ended event not fired', fired.length === 0);
  }
}

// =============================================================================
async function suite_Suggester_Dedup() {
  console.log('\n[CalendarSuggester dedup + dismiss]');

  function fakeSource(upcoming) {
    return {
      getUpcomingEvents: async () => ({ events: upcoming }),
      getCurrentEvent: async () => ({ event: null }),
      ensurePermission: async () => 'granted'
    };
  }

  // Same fingerprint across two polls → fires only once
  {
    const store = makeStore({
      calendarLeadTimeMinutes: 5,
      calendarDenylist: [],
      calendarDismissedFingerprints: []
    });
    const reg = new DismissalRegistry({ store });
    const fired = [];
    const e = makeEvent({ startTime: new Date(Date.now() + 60_000).toISOString() });
    const sg = new CalendarSuggester({
      store,
      source: fakeSource([e]),
      dismissalRegistry: reg,
      onSuggestion: (s) => fired.push(s)
    });
    sg._running = true;
    await sg._poll();
    await sg._poll();
    sg._running = false;
    assert('fingerprint dedup across polls', fired.length === 1);
  }

  // Dismissed in registry → never fires, even if it's the first poll
  {
    const e = makeEvent({ startTime: new Date(Date.now() + 60_000).toISOString() });
    const store = makeStore({
      calendarLeadTimeMinutes: 5,
      calendarDenylist: [],
      calendarDismissedFingerprints: [{ fingerprint: e.occurrenceFingerprint, expiry: e.endTime }]
    });
    const reg = new DismissalRegistry({ store });
    const fired = [];
    const sg = new CalendarSuggester({
      store,
      source: fakeSource([e]),
      dismissalRegistry: reg,
      onSuggestion: (s) => fired.push(s)
    });
    sg._running = true;
    await sg._poll();
    sg._running = false;
    assert('dismissed-at-boot suppresses fire', fired.length === 0);
  }
}

// =============================================================================
async function suite_Suggester_CurrentCache() {
  console.log('\n[CalendarSuggester current-event cache]');

  let upcomingCalls = 0;
  let currentCalls = 0;
  const inProgress = makeEvent({
    startTime: new Date(Date.now() - 60_000).toISOString(),
    endTime: new Date(Date.now() + 30 * 60_000).toISOString()
  });

  const source = {
    getUpcomingEvents: async () => { upcomingCalls++; return { events: [] }; },
    getCurrentEvent: async () => { currentCalls++; return { event: inProgress }; },
    ensurePermission: async () => 'granted'
  };

  const store = makeStore({
    calendarLeadTimeMinutes: 2,
    calendarDenylist: [],
    calendarDismissedFingerprints: []
  });
  const reg = new DismissalRegistry({ store });
  const sg = new CalendarSuggester({ store, source, dismissalRegistry: reg });
  sg._running = true;

  // Before any poll, sync cache empty
  assert('sync cache empty before poll', sg.getCurrentMeetingEventSync() === null);

  await sg._poll();
  assert('current called once during poll', currentCalls === 1);
  assert('sync cache hit after fresh poll',
    sg.getCurrentMeetingEventSync()?.occurrenceFingerprint === inProgress.occurrenceFingerprint);

  // On-demand refresh — should call current again
  const refreshed = await sg.refreshCurrentEvent();
  assert('refresh returns event', refreshed?.occurrenceFingerprint === inProgress.occurrenceFingerprint);
  assert('refresh spawned current call', currentCalls === 2);

  // Slow source → timeout fallback returns null
  const slowSource = {
    getUpcomingEvents: async () => ({ events: [] }),
    getCurrentEvent: () => new Promise((r) => setTimeout(() => r({ event: inProgress }), 2000)),
    ensurePermission: async () => 'granted'
  };
  const sg2 = new CalendarSuggester({ store, source: slowSource, dismissalRegistry: reg });
  sg2._running = true;
  const t0 = Date.now();
  const ev = await sg2.refreshCurrentEvent();
  const dt = Date.now() - t0;
  assert('slow refresh returns null', ev === null);
  assert(`slow refresh bounded ~500ms (got ${dt}ms)`, dt < 900);

  sg._running = false;
  sg2._running = false;
}

// =============================================================================
async function suite_Suggester_SourceErrors() {
  console.log('\n[CalendarSuggester source-error handling]');

  // permission-denied → permission state denied, no fires
  {
    const source = {
      getUpcomingEvents: async () => ({ events: [], error: 'permission-denied' }),
      getCurrentEvent: async () => ({ event: null, error: 'permission-denied' }),
      ensurePermission: async () => 'denied'
    };
    const store = makeStore({
      calendarLeadTimeMinutes: 2,
      calendarDenylist: [],
      calendarDismissedFingerprints: []
    });
    const reg = new DismissalRegistry({ store });
    const fired = [];
    const sg = new CalendarSuggester({ store, source, dismissalRegistry: reg, onSuggestion: (s) => fired.push(s) });
    sg._running = true;
    await sg._poll();
    sg._running = false;
    assert('denied: no fires', fired.length === 0);
    assert('denied: permission state propagated', sg.getPermissionState() === 'denied');
  }

  // parse-failed → no crash, no fires
  {
    const source = {
      getUpcomingEvents: async () => ({ events: [], error: 'parse-failed: ...' }),
      getCurrentEvent: async () => ({ event: null, error: 'parse-failed: ...' }),
      ensurePermission: async () => 'granted'
    };
    const store = makeStore({
      calendarLeadTimeMinutes: 2,
      calendarDenylist: [],
      calendarDismissedFingerprints: []
    });
    const reg = new DismissalRegistry({ store });
    const fired = [];
    const sg = new CalendarSuggester({ store, source, dismissalRegistry: reg, onSuggestion: (s) => fired.push(s) });
    sg._running = true;
    let crashed = false;
    try { await sg._poll(); } catch { crashed = true; }
    sg._running = false;
    assert('parse error doesn\'t crash poll', !crashed);
    assert('parse error: no fires', fired.length === 0);
  }
}

// =============================================================================
async function suite_DetectorEnricher() {
  console.log('\n[MeetingDetector enricher path]');

  // Enricher returns event → fingerprint = calendar occurrence fingerprint
  {
    const event = makeEvent({
      startTime: new Date(Date.now() - 60_000).toISOString(),
      endTime: new Date(Date.now() + 30 * 60_000).toISOString()
    });
    const store = makeStore({ calendarDismissedFingerprints: [] });
    const reg = new DismissalRegistry({ store });
    const enricher = async () => event;
    const det = new MeetingDetector({ dismissalRegistry: reg, enricher });

    // Stub the detection sub-checks
    det._detectZoom = async () => true;
    det._detectFaceTime = async () => false;
    det._detectMeet = async () => false;

    const fires = [];
    det.onMeetingDetected((d) => fires.push(d));
    det._running = true;
    await det._poll();
    det._running = false;

    assert('enricher hit: 1 fire', fires.length === 1);
    assert('enricher hit: canonical fingerprint = calendar fp',
      fires[0]?.fingerprint === event.occurrenceFingerprint);
    assert('enricher hit: appFingerprint also present',
      typeof fires[0]?.appFingerprint === 'string' && fires[0].appFingerprint.startsWith('zoom-'));
    assert('enricher hit: calendarEvent attached',
      fires[0]?.calendarEvent?.occurrenceFingerprint === event.occurrenceFingerprint);
  }

  // Enricher returns null → falls back to app fingerprint
  {
    const store = makeStore({ calendarDismissedFingerprints: [] });
    const reg = new DismissalRegistry({ store });
    const det = new MeetingDetector({ dismissalRegistry: reg, enricher: async () => null });
    det._detectZoom = async () => true;
    det._detectFaceTime = async () => false;
    det._detectMeet = async () => false;
    const fires = [];
    det.onMeetingDetected((d) => fires.push(d));
    det._running = true;
    await det._poll();
    det._running = false;
    assert('enricher miss: fingerprint is app-style',
      fires[0]?.fingerprint?.startsWith('zoom-') === true);
    assert('enricher miss: no calendarEvent', fires[0]?.calendarEvent == null);
  }

  // Enricher timeout (>500ms) → fallback path
  {
    const store = makeStore({ calendarDismissedFingerprints: [] });
    const reg = new DismissalRegistry({ store });
    const slowEnricher = () => new Promise((r) => setTimeout(() => r(makeEvent()), 1500));
    const det = new MeetingDetector({ dismissalRegistry: reg, enricher: slowEnricher });
    det._detectZoom = async () => true;
    det._detectFaceTime = async () => false;
    det._detectMeet = async () => false;
    const fires = [];
    det.onMeetingDetected((d) => fires.push(d));
    det._running = true;
    const t0 = Date.now();
    await det._poll();
    const dt = Date.now() - t0;
    det._running = false;
    assert('slow enricher: still fires', fires.length === 1);
    assert(`slow enricher: timeout-bounded poll (${dt}ms < 900ms)`, dt < 900);
    assert('slow enricher: falls back to app fingerprint',
      fires[0]?.fingerprint?.startsWith('zoom-') === true);
  }

  // Dismissed-by-calendar-fingerprint suppresses detector banner
  {
    const event = makeEvent({
      startTime: new Date(Date.now() - 60_000).toISOString(),
      endTime: new Date(Date.now() + 30 * 60_000).toISOString()
    });
    const store = makeStore({
      calendarDismissedFingerprints: [{ fingerprint: event.occurrenceFingerprint, expiry: event.endTime }]
    });
    const reg = new DismissalRegistry({ store });
    const det = new MeetingDetector({ dismissalRegistry: reg, enricher: async () => event });
    det._detectZoom = async () => true;
    det._detectFaceTime = async () => false;
    det._detectMeet = async () => false;
    const fires = [];
    det.onMeetingDetected((d) => fires.push(d));
    det._running = true;
    await det._poll();
    det._running = false;
    assert('shared dismiss: detector suppressed by calendar dismissal', fires.length === 0);
  }
}

// =============================================================================
async function suite_PreRecordSeed() {
  console.log('\n[Pre-record seed building]');

  // These helpers were lifted out of main.js into services/meetingTemplate.js
  // (shared with the standalone MCP server). Exercise the REAL exports here.
  const {
    buildAgendaFromNotes,
    attendeeDisplayName,
    buildPreRecordSeedFromEvent
  } = require(path.join(repoRoot, 'services/meetingTemplate'));

  assert('meetingTemplate exports buildPreRecordSeedFromEvent',
    typeof buildPreRecordSeedFromEvent === 'function');
  assert('meetingTemplate exports buildAgendaFromNotes',
    typeof buildAgendaFromNotes === 'function');
  assert('meetingTemplate exports attendeeDisplayName',
    typeof attendeeDisplayName === 'function');

  // Title + participants + simple agenda
  {
    const seed = buildPreRecordSeedFromEvent(makeEvent({
      title: 'Project Kickoff',
      notes: 'Agenda: align on Q3'
    }));
    assert('title pulled', seed.title === 'Project Kickoff');
    assert('participants excludes self', seed.participants === 'Bob');
    assert('agenda pulled', seed.agenda === 'Agenda: align on Q3');
  }

  // Email-fallback when name missing
  {
    const seed = buildPreRecordSeedFromEvent(makeEvent({
      attendees: [
        { name: '', email: 'alice@example.com', isCurrentUser: false },
        { name: '', email: 'me@x.com', isCurrentUser: true }
      ]
    }));
    assert('email local-part fallback', seed.participants === 'alice');
  }

  // Multiple participants joined with comma
  {
    const seed = buildPreRecordSeedFromEvent(makeEvent({
      attendees: [
        { name: 'Bob', email: '', isCurrentUser: false },
        { name: 'Charlie', email: '', isCurrentUser: false },
        { name: 'Dana', email: '', isCurrentUser: false },
        { name: 'Me', email: '', isCurrentUser: true }
      ]
    }));
    assert('multiple participants joined', seed.participants === 'Bob, Charlie, Dana');
  }

  // Notes with Zoom link / URLs stripped
  {
    const notes = `Agenda: align on Q3

Join Zoom Meeting
https://zoom.us/j/123456789?pwd=abc
Meeting ID: 123 456 7890
Passcode: 9876`;
    const seed = buildPreRecordSeedFromEvent(makeEvent({ notes }));
    assert('zoom link stripped', !seed.agenda.includes('zoom.us'));
    assert('meeting id stripped', !/Meeting ID/i.test(seed.agenda));
    assert('passcode stripped', !/Passcode/i.test(seed.agenda));
    assert('agenda content retained', seed.agenda.includes('Agenda: align on Q3'));
  }

  // 500-char cap
  {
    const long = 'x'.repeat(2000);
    const seed = buildPreRecordSeedFromEvent(makeEvent({ notes: long }));
    assert('agenda capped at 500 chars', seed.agenda.length === 500);
  }

  // Null event returns null
  {
    assert('null event → null seed', buildPreRecordSeedFromEvent(null) === null);
  }
}

// =============================================================================
async function suite_SourceSpawnMocking() {
  console.log('\n[macOSCalendarSource with mocked spawn]');

  const { EventEmitter } = require('events');

  function makeFakeChild({ exitCode, stdout = '', stderr = '', delayMs = 0 }) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('exit', exitCode);
    }, delayMs);
    return child;
  }

  // Success path: well-formed upcoming output
  {
    const ev = makeEvent();
    const stdout = JSON.stringify([ev]);
    const fakeSpawn = () => makeFakeChild({ exitCode: 0, stdout });
    const registered = [];
    const source = new MacOSCalendarSource({
      helperPath: '/fake/calendar-helper',
      spawn: fakeSpawn,
      registerProcess: (p) => registered.push(p)
    });
    const result = await source.getUpcomingEvents({ windowMinutes: 5 });
    assert('upcoming success: parses JSON', Array.isArray(result.events) && result.events.length === 1);
    assert('upcoming success: registered child', registered.length === 1);
    assert('upcoming success: no error', !result.error);
  }

  // Exit code 2 → permission-denied
  {
    const fakeSpawn = () => makeFakeChild({ exitCode: 2, stderr: 'denied' });
    const source = new MacOSCalendarSource({
      helperPath: '/fake/calendar-helper',
      spawn: fakeSpawn,
      registerProcess: () => {}
    });
    const result = await source.getUpcomingEvents({ windowMinutes: 5 });
    assert('exit 2 → permission-denied', result.error === 'permission-denied');
  }

  // Exit code 3 → not-determined
  {
    const fakeSpawn = () => makeFakeChild({ exitCode: 3 });
    const source = new MacOSCalendarSource({
      helperPath: '/fake/calendar-helper',
      spawn: fakeSpawn,
      registerProcess: () => {}
    });
    const result = await source.getCurrentEvent();
    assert('exit 3 → not-determined', result.error === 'not-determined');
  }

  // Malformed JSON → parse error reported
  {
    const fakeSpawn = () => makeFakeChild({ exitCode: 0, stdout: '{not valid' });
    const source = new MacOSCalendarSource({
      helperPath: '/fake/calendar-helper',
      spawn: fakeSpawn,
      registerProcess: () => {}
    });
    const result = await source.getUpcomingEvents({ windowMinutes: 5 });
    assert('malformed JSON: parse-failed error', /^parse-failed/.test(result.error || ''));
    assert('malformed JSON: empty events', result.events.length === 0);
  }

  // Null current event (literal "null") parses as null without error
  {
    const fakeSpawn = () => makeFakeChild({ exitCode: 0, stdout: 'null\n' });
    const source = new MacOSCalendarSource({
      helperPath: '/fake/calendar-helper',
      spawn: fakeSpawn,
      registerProcess: () => {}
    });
    const result = await source.getCurrentEvent();
    assert('current null: no error', !result.error);
    assert('current null: event = null', result.event === null);
  }

  // Spawn throws synchronously → typed result
  {
    const source = new MacOSCalendarSource({
      helperPath: '/fake/calendar-helper',
      spawn: () => { throw new Error('ENOENT'); },
      registerProcess: () => {}
    });
    const result = await source.getCurrentEvent();
    assert('spawn-failed: helper-exit-(-1)', result.error?.startsWith('helper-exit-'));
  }
}

// =============================================================================
async function suite_PermissionGate() {
  console.log('\n[CalendarSuggester permission gate (Codex P2 fix)]');

  // Denied source → start() should NOT enter the poll loop
  {
    let upcomingCalls = 0;
    const source = {
      ensurePermission: async () => 'denied',
      getUpcomingEvents: async () => { upcomingCalls++; return { events: [] }; },
      getCurrentEvent: async () => ({ event: null })
    };
    const store = makeStore({
      calendarLeadTimeMinutes: 2,
      calendarDenylist: [],
      calendarDismissedFingerprints: []
    });
    const reg = new DismissalRegistry({ store });
    const sg = new CalendarSuggester({ store, source, dismissalRegistry: reg });
    sg.start();
    // Give the async setup a beat to resolve
    await sleep(50);
    assert('denied: no upcoming polls fired', upcomingCalls === 0);
    assert('denied: _running flipped back to false', sg._running === false);
    assert('denied: permission state recorded', sg.getPermissionState() === 'denied');
  }

  // Not-determined source → same behaviour
  {
    let upcomingCalls = 0;
    const source = {
      ensurePermission: async () => 'not-determined',
      getUpcomingEvents: async () => { upcomingCalls++; return { events: [] }; },
      getCurrentEvent: async () => ({ event: null })
    };
    const store = makeStore({
      calendarLeadTimeMinutes: 2,
      calendarDenylist: [],
      calendarDismissedFingerprints: []
    });
    const reg = new DismissalRegistry({ store });
    const sg = new CalendarSuggester({ store, source, dismissalRegistry: reg });
    sg.start();
    await sleep(50);
    assert('not-determined: no upcoming polls fired', upcomingCalls === 0);
    assert('not-determined: _running flipped back to false', sg._running === false);
  }

  // Granted source → DOES enter the poll loop and fires immediately
  {
    let upcomingCalls = 0;
    const source = {
      ensurePermission: async () => 'granted',
      getUpcomingEvents: async () => { upcomingCalls++; return { events: [] }; },
      getCurrentEvent: async () => ({ event: null })
    };
    const store = makeStore({
      calendarLeadTimeMinutes: 2,
      calendarDenylist: [],
      calendarDismissedFingerprints: []
    });
    const reg = new DismissalRegistry({ store });
    const sg = new CalendarSuggester({ store, source, dismissalRegistry: reg });
    sg.start();
    await sleep(50);
    assert('granted: initial poll fired', upcomingCalls >= 1);
    assert('granted: _running stays true', sg._running === true);
    sg.stop();
  }

  // Race: stop() while ensurePermission is still pending → no poll
  {
    let upcomingCalls = 0;
    const source = {
      ensurePermission: () => new Promise((r) => setTimeout(() => r('granted'), 100)),
      getUpcomingEvents: async () => { upcomingCalls++; return { events: [] }; },
      getCurrentEvent: async () => ({ event: null })
    };
    const store = makeStore({
      calendarLeadTimeMinutes: 2,
      calendarDenylist: [],
      calendarDismissedFingerprints: []
    });
    const reg = new DismissalRegistry({ store });
    const sg = new CalendarSuggester({ store, source, dismissalRegistry: reg });
    sg.start();
    sg.stop(); // before ensurePermission resolves
    await sleep(200);
    assert('stop-during-setup: no poll fired', upcomingCalls === 0);
  }
}

// =============================================================================
async function suite_HelperPlistEmbedded() {
  console.log('\n[Helper Info.plist binding (Codex P1 fix)]');

  const fs = require('fs');
  const { execSync } = require('child_process');
  const helperPath = path.join(repoRoot, 'native', 'calendar-helper', '.build', 'release', 'calendar-helper');
  if (!fs.existsSync(helperPath)) {
    console.log('  ⚠ skipping: helper not built');
    return;
  }
  let plistOutput = '';
  try {
    plistOutput = execSync(`otool -P "${helperPath}"`, { encoding: 'utf8' });
  } catch (err) {
    assert('otool -P succeeds on helper', false, err.message);
    return;
  }
  assert('helper has __TEXT,__info_plist section',
    /__TEXT,__info_plist/.test(plistOutput));
  assert('embedded plist contains NSCalendarsUsageDescription',
    plistOutput.includes('NSCalendarsUsageDescription'));
  assert('embedded plist contains NSCalendarsFullAccessUsageDescription',
    plistOutput.includes('NSCalendarsFullAccessUsageDescription'));
  assert('embedded plist references calendar-helper bundle id',
    plistOutput.includes('com.christopherrobinson.calendar-helper'));
}

// =============================================================================
async function suite_RealHelper() {
  console.log('\n[Real Swift helper smoke]');

  const helperPath = path.join(repoRoot, 'native', 'calendar-helper', '.build', 'release', 'calendar-helper');
  const fs = require('fs');
  if (!fs.existsSync(helperPath)) {
    console.log(`  ⚠ skipping: helper not built at ${helperPath}`);
    return;
  }
  const { spawn: childSpawn } = require('child_process');
  const source = new MacOSCalendarSource({
    helperPath,
    spawn: childSpawn,
    registerProcess: () => {}
  });

  // request-access: should return a recognised state
  const permState = await source.ensurePermission();
  assert(`real ensurePermission returns recognised state (${permState})`,
    ['granted', 'denied', 'not-determined'].includes(permState));

  // upcoming should return either events array (if granted) or an error
  const r = await source.getUpcomingEvents({ windowMinutes: 60 });
  assert('real upcoming: returns events array or error',
    Array.isArray(r.events));
  if (r.error) {
    assert(`real upcoming error is recognised (${r.error})`,
      ['permission-denied', 'not-determined'].includes(r.error) || r.error.startsWith('parse-failed') || r.error.startsWith('helper-exit-'));
  }

  // current should return event-or-null shape
  const c = await source.getCurrentEvent();
  assert('real current: returns recognised shape',
    (c.event === null || typeof c.event === 'object') || typeof c.error === 'string');
}

// =============================================================================
(async () => {
  await suite_DismissalRegistry();
  await suite_Suggester_Filters();
  await suite_Suggester_Dedup();
  await suite_Suggester_CurrentCache();
  await suite_Suggester_SourceErrors();
  await suite_DetectorEnricher();
  await suite_PreRecordSeed();
  await suite_SourceSpawnMocking();
  await suite_PermissionGate();
  await suite_HelperPlistEmbedded();
  await suite_RealHelper();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('\nTest runner crashed:', err);
  process.exit(2);
});
