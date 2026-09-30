'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const {
  CxmailCalendarSource,
  parseIcsAttendees,
  parseCxmailDate,
  resolveEventTime,
  cleanTitle,
  cleanDescription,
  isDateOnly,
} = require('./cxmailCalendarSource');

// A fake child_process.spawn that emits canned sqlite3 output then exits.
function fakeSpawn({ code = 0, stdout = '', stderr = '', captureSql } = {}) {
  return (bin, args) => {
    if (captureSql) captureSql(args[args.length - 1], args, bin);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('exit', code);
    });
    return child;
  };
}

function makeSource({
  code = 0,
  rows = null,
  stdout = null,
  stderr = '',
  captureSql,
  available = true,
  minConfidence = 0.7,
  now,
} = {}) {
  const out = stdout != null ? stdout : rows != null ? JSON.stringify(rows) : '';
  return new CxmailCalendarSource({
    spawn: fakeSpawn({ code, stdout: out, stderr, captureSql }),
    registerProcess: () => {},
    fileExists: () => available,
    getMinConfidence: () => minConfidence,
    now: now ? () => now : undefined,
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('isDateOnly: bare date vs datetime', () => {
  assert.equal(isDateOnly('2026-06-17'), true);
  assert.equal(isDateOnly('2026-06-17T14:00:00Z'), false);
  assert.equal(isDateOnly('2026-06-17T14:00:00'), false);
});

test('parseCxmailDate: Z is UTC, junk is null', () => {
  assert.equal(parseCxmailDate('2026-06-17T14:00:00Z').toISOString(), '2026-06-17T14:00:00.000Z');
  assert.equal(parseCxmailDate('nonsense'), null);
  assert.equal(parseCxmailDate(''), null);
  assert.equal(parseCxmailDate(null), null);
});

test('parseIcsAttendees: extracts CN + mailto + PARTSTAT, unfolds, drops empties', () => {
  const ics = [
    'BEGIN:VEVENT',
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Bob',
    ' bee:mailto:bob@example.com', // folded continuation of the line above
    'ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Chris:mailto:chris@example.com',
    'SUMMARY:Sync',
    'END:VEVENT',
  ].join('\r\n');
  const att = parseIcsAttendees(ics);
  assert.equal(att.length, 2);
  assert.equal(att[0].email, 'bob@example.com');
  assert.equal(att[0].status, 'accepted');
  assert.equal(att[1].name, 'Chris');
  assert.equal(att[1].status, 'needs-action');
  assert.deepEqual(parseIcsAttendees(null), []);
  assert.deepEqual(parseIcsAttendees(''), []);
});

// ---------------------------------------------------------------------------
// getUpcomingEvents — mapping + window
// ---------------------------------------------------------------------------

const NOW = new Date('2026-06-17T13:30:00Z');

const ROWS = [
  {
    id: 58,
    summary: 'NXT / Synergy Catalyst Advisors Zoom Meeting',
    description: 'https://us02web.zoom.us/j/88316438982',
    location: '',
    dtstart: '2026-06-17T14:00:00Z',
    dtend: null, // detected events never have an end
    organizer_name: '',
    organizer_email: '',
    status: '',
    method: null,
    rsvp_status: 'needs-action',
    source: 'detected',
    confidence: 0.95,
    raw_ics: null,
  },
  {
    id: 31,
    summary: 'Therapy Session',
    description: '',
    location: '',
    dtstart: '2026-06-17T14:30:00Z',
    dtend: '2026-06-17T15:00:00Z',
    organizer_name: 'Aaron',
    organizer_email: 'aaron@example.com',
    status: 'CONFIRMED',
    method: 'REQUEST',
    rsvp_status: 'needs-action',
    source: 'ics',
    confidence: null,
    raw_ics: 'ATTENDEE;CN=Bob:mailto:bob@x.com\r\nATTENDEE;CN=Chris:mailto:chris@x.com',
  },
  {
    id: 99,
    summary: 'Far future',
    dtstart: '2026-06-20T10:00:00Z', // outside a 120-min window
    dtend: null,
    rsvp_status: 'needs-action',
    source: 'ics',
    confidence: null,
    raw_ics: null,
  },
];

test('getUpcomingEvents: maps rows, applies window, synthesises end, flags meetingWorthy', async () => {
  const src = makeSource({ rows: ROWS, now: NOW });
  const { events, error } = await src.getUpcomingEvents({ windowMinutes: 120 });
  assert.equal(error, undefined);
  assert.equal(events.length, 2, 'far-future row dropped by the JS window');

  const detected = events[0];
  assert.equal(detected.id, 'cxmail-58');
  // Fingerprint is now per-dedup-group. Row 58 has no event_uid → falls back to
  // `summary|startMinute`, then `:<winnerStartISO>`. Compute, don't hardcode.
  const startMs = Date.parse('2026-06-17T14:00:00Z');
  const expectedKey = `nxt / synergy catalyst advisors zoom meeting|${Math.floor(startMs / 60000)}`;
  assert.equal(detected.occurrenceFingerprint, `cxmail:${expectedKey}:2026-06-17T14:00:00.000Z`);
  assert.equal(detected.startTime, '2026-06-17T14:00:00.000Z');
  assert.equal(detected.endTime, '2026-06-17T15:00:00.000Z', 'null dtend → start + 60m');
  assert.equal(detected.meetingWorthy, true);
  assert.equal(detected.cxmailSource, 'detected');
  assert.equal(detected.confidence, 0.95);
  assert.deepEqual(detected.attendees, []);

  const ics = events[1];
  assert.equal(ics.id, 'cxmail-31');
  assert.equal(ics.endTime, '2026-06-17T15:00:00.000Z', 'real dtend preserved');
  assert.equal(ics.attendees.length, 2, 'attendees parsed from raw_ics');
  assert.equal(ics.organizer.email, 'aaron@example.com');
});

test('getUpcomingEvents: declined invite is mapped declinedByMe (filter drops it later)', async () => {
  const src = makeSource({
    rows: [{ ...ROWS[1], rsvp_status: 'declined' }],
    now: NOW,
  });
  const { events } = await src.getUpcomingEvents({ windowMinutes: 120 });
  assert.equal(events[0].declinedByMe, true);
});

// ---------------------------------------------------------------------------
// Eligibility SQL
// ---------------------------------------------------------------------------

test('eligibility SQL: dismissed + CANCEL guard + inlined confidence threshold', async () => {
  let sql = '';
  const src = makeSource({ rows: [], minConfidence: 0.8, captureSql: (s) => (sql = s) });
  await src.getUpcomingEvents({ windowMinutes: 60 });
  assert.match(sql, /dismissed = 0/);
  assert.match(sql, /upper\(method\) != 'CANCEL'/);
  assert.match(sql, /source = 'detected' AND confidence >= 0\.8/);
});

test('confidence threshold is clamped to [0,1] and defaults on NaN', async () => {
  let sqlHigh = '';
  await makeSource({ rows: [], minConfidence: 5, captureSql: (s) => (sqlHigh = s) }).getUpcomingEvents({
    windowMinutes: 60,
  });
  assert.match(sqlHigh, /confidence >= 1/);

  let sqlNaN = '';
  await makeSource({ rows: [], minConfidence: NaN, captureSql: (s) => (sqlNaN = s) }).getUpcomingEvents({
    windowMinutes: 60,
  });
  assert.match(sqlNaN, /confidence >= 0\.7/);
});

// ---------------------------------------------------------------------------
// getCurrentEvent
// ---------------------------------------------------------------------------

test('getCurrentEvent: returns the event whose span contains now', async () => {
  const src = makeSource({ rows: ROWS, now: new Date('2026-06-17T14:15:00Z') });
  const { event } = await src.getCurrentEvent();
  assert.ok(event, 'an in-progress event is returned');
  assert.equal(event.id, 'cxmail-58'); // 14:00 → 15:00 span contains 14:15
});

test('getCurrentEvent: null when nothing spans now', async () => {
  const src = makeSource({ rows: ROWS, now: new Date('2026-06-17T20:00:00Z') });
  const { event } = await src.getCurrentEvent();
  assert.equal(event, null);
});

// ---------------------------------------------------------------------------
// Availability + error handling (never throws)
// ---------------------------------------------------------------------------

test('unavailable: ensurePermission denied, queries short-circuit without spawning', async () => {
  let spawned = false;
  const src = new CxmailCalendarSource({
    spawn: () => {
      spawned = true;
      throw new Error('should not spawn');
    },
    registerProcess: () => {},
    fileExists: () => false,
    getMinConfidence: () => 0.7,
  });
  assert.equal(await src.ensurePermission(), 'denied');
  assert.deepEqual(await src.getUpcomingEvents({ windowMinutes: 60 }), {
    events: [],
    error: 'cxmail-unavailable',
  });
  assert.deepEqual(await src.getCurrentEvent(), { event: null, error: 'cxmail-unavailable' });
  assert.equal(spawned, false);
});

test('available: ensurePermission granted', async () => {
  assert.equal(await makeSource({ rows: [] }).ensurePermission(), 'granted');
});

test('sqlite non-zero exit surfaces a typed error, never throws', async () => {
  const src = makeSource({ code: 1, stderr: 'database is locked', stdout: '' });
  const res = await src.getUpcomingEvents({ windowMinutes: 60 });
  assert.deepEqual(res.events, []);
  assert.match(res.error, /^sqlite-exit-1/);
});

test('malformed JSON surfaces a parse error', async () => {
  const src = makeSource({ code: 0, stdout: 'not json at all' });
  const res = await src.getUpcomingEvents({ windowMinutes: 60 });
  assert.match(res.error, /^parse-failed/);
});

test('empty stdout (zero rows) → empty events, no error', async () => {
  const src = makeSource({ code: 0, stdout: '' });
  assert.deepEqual(await src.getUpcomingEvents({ windowMinutes: 60 }), { events: [] });
});

test('constructor requires spawn + registerProcess', () => {
  assert.throws(() => new CxmailCalendarSource({ registerProcess: () => {} }), /spawn required/);
  assert.throws(() => new CxmailCalendarSource({ spawn: () => {} }), /registerProcess required/);
});

// ---------------------------------------------------------------------------
// Date-shape paths — the behaviours the spec exists to guarantee (floating-local,
// date-only/all-day, malformed/<=-start dtend). Code was verified correct by
// review; these lock it in. TZ-agnostic (expectations computed, never hardcoded).
// ---------------------------------------------------------------------------

test('parseCxmailDate: floating (no Z) is LOCAL, distinct from explicit UTC', () => {
  const floating = parseCxmailDate('2026-06-19T10:00:00');
  assert.equal(floating.toISOString(), new Date('2026-06-19T10:00:00').toISOString());
  // In any non-UTC zone the floating value differs from the Z value (skip under UTC CI).
  if (new Date('2026-06-19T10:00:00').getTimezoneOffset() !== 0) {
    assert.notEqual(floating.toISOString(), parseCxmailDate('2026-06-19T10:00:00Z').toISOString());
  }
});

test('getUpcomingEvents: floating-local dtstart mapped via local interpretation', async () => {
  const floating = '2026-06-17T23:00:00'; // no Z → local
  const expectedStart = new Date(floating);
  const now = new Date(expectedStart.getTime() - 30 * 60 * 1000); // 30m before, absolute
  const src = makeSource({
    rows: [{ id: 7, summary: 'Floating', dtstart: floating, dtend: null, source: 'ics', confidence: null, rsvp_status: 'needs-action', raw_ics: null }],
    now,
  });
  const { events } = await src.getUpcomingEvents({ windowMinutes: 60 });
  assert.equal(events.length, 1);
  assert.equal(events[0].startTime, expectedStart.toISOString());
  assert.equal(events[0].endTime, new Date(expectedStart.getTime() + 60 * 60 * 1000).toISOString());
});

test('getUpcomingEvents: date-only dtstart → isAllDay + synthesised 60m end', async () => {
  // date-only parses as UTC midnight; place "now" just before so it lands in window
  const src = makeSource({
    rows: [{ id: 8, summary: 'All day', dtstart: '2026-06-18', dtend: null, source: 'ics', confidence: null, rsvp_status: 'needs-action', raw_ics: null }],
    now: new Date('2026-06-17T23:45:00Z'),
  });
  const { events } = await src.getUpcomingEvents({ windowMinutes: 60 });
  assert.equal(events.length, 1);
  assert.equal(events[0].isAllDay, true);
  assert.equal(events[0].startTime, '2026-06-18T00:00:00.000Z');
  assert.equal(events[0].endTime, '2026-06-18T01:00:00.000Z');
});

test('dtend synthesised when null, malformed, or <= start', async () => {
  const base = { id: 9, summary: 'X', dtstart: '2026-06-17T14:00:00Z', source: 'detected', confidence: 0.95, rsvp_status: 'needs-action', raw_ics: null };
  const now = new Date('2026-06-17T13:45:00Z');
  for (const bad of [null, 'garbage', '2026-06-17T13:00:00Z' /* before start */]) {
    const src = makeSource({ rows: [{ ...base, dtend: bad }], now });
    const { events } = await src.getUpcomingEvents({ windowMinutes: 60 });
    assert.equal(events[0].endTime, '2026-06-17T15:00:00.000Z', `dtend=${bad} → start+60m`);
  }
});

// ---------------------------------------------------------------------------
// Never-throw across spawn-throw / child-error / timeout, and injection neutralisation
// ---------------------------------------------------------------------------

test('spawn() throwing synchronously → spawn-failed, never throws', async () => {
  const src = new CxmailCalendarSource({
    spawn: () => { throw new Error('boom'); },
    registerProcess: () => {},
    fileExists: () => true,
    getMinConfidence: () => 0.7,
  });
  assert.match((await src.getUpcomingEvents({ windowMinutes: 60 })).error, /^spawn-failed/);
});

test("child 'error' event → spawn-error, never throws", async () => {
  const spawn = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    setImmediate(() => c.emit('error', new Error('nope')));
    return c;
  };
  const src = new CxmailCalendarSource({ spawn, registerProcess: () => {}, fileExists: () => true, getMinConfidence: () => 0.7 });
  assert.match((await src.getUpcomingEvents({ windowMinutes: 60 })).error, /^spawn-error/);
});

test('timeout path → error:timeout, child killed', async () => {
  let killed = false;
  const spawn = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.kill = () => { killed = true; };
    return c; // never emits exit
  };
  const src = new CxmailCalendarSource({ spawn, registerProcess: () => {}, fileExists: () => true, getMinConfidence: () => 0.7, timeoutMs: 20 });
  const res = await src.getUpcomingEvents({ windowMinutes: 60 });
  assert.equal(res.error, 'timeout');
  assert.equal(killed, true);
});

test('injection-shaped confidence is neutralised to a bare clamped number in the SQL', async () => {
  let sql = '';
  const src = makeSource({ rows: [], minConfidence: '0.7; DROP TABLE calendar_events;--', captureSql: (s) => (sql = s) });
  await src.getUpcomingEvents({ windowMinutes: 60 });
  assert.doesNotMatch(sql, /DROP TABLE|UNION|--/i);
  assert.match(sql, /confidence >= 0\.7/);
});

test('COLUMNS selects event_uid + created_at (needed for dedup + winner selection)', async () => {
  let sql = '';
  await makeSource({ rows: [], captureSql: (s) => (sql = s) }).getUpcomingEvents({ windowMinutes: 60 });
  assert.match(sql, /\bevent_uid\b/);
  assert.match(sql, /\bcreated_at\b/);
});

// ---------------------------------------------------------------------------
// Normalisation: dedup / reschedule / RSVP-union / cleaning / room exclusion / TZID
// (ported from meeting-copilot). The same invite arrives per-mailbox; RSVP replies
// are separate METHOD:REPLY rows — collapse to one clean, attendee-complete event.
// ---------------------------------------------------------------------------

const AT = (name, email) => `ATTENDEE;CN=${name}:mailto:${email}`;

test('dedup: same event_uid across mailboxes → one event, attendees unioned, UID fingerprint', async () => {
  const rows = [
    {
      id: 10, event_uid: 'g@google.com', account_id: 'acctA',
      summary: 'Sync', dtstart: '2026-06-17T14:00:00Z', dtend: '2026-06-17T14:30:00Z',
      method: 'REQUEST', rsvp_status: 'needs-action', source: 'ics', confidence: null,
      created_at: '2026-06-01T00:00:00Z', raw_ics: AT('Alice', 'alice@x.com'),
    },
    {
      id: 11, event_uid: 'g@google.com', account_id: 'acctB',
      summary: 'Accepted: Sync', dtstart: '2026-06-17T14:00:00Z', dtend: '2026-06-17T14:30:00Z',
      method: 'REPLY', rsvp_status: 'accepted', source: 'ics', confidence: null,
      created_at: '2026-06-02T00:00:00Z', raw_ics: AT('Bob', 'bob@x.com'),
    },
  ];
  const { events } = await makeSource({ rows, now: NOW }).getUpcomingEvents({ windowMinutes: 720 });
  assert.equal(events.length, 1, 'the two mailbox rows collapse to one meeting');
  const ev = events[0];
  assert.equal(ev.title, 'Sync', 'Accepted: prefix stripped from the winner summary');
  assert.equal(ev.occurrenceFingerprint, 'cxmail:g@google.com:2026-06-17T14:00:00.000Z');
  assert.deepEqual(
    ev.attendees.map((a) => a.email).sort(),
    ['alice@x.com', 'bob@x.com'],
    'attendees unioned across REQUEST + REPLY rows'
  );
});

test('reschedule: newer created_at wins for time + title', async () => {
  const rows = [
    {
      id: 20, event_uid: 'r@google.com', account_id: 'acctA',
      summary: 'Standup', dtstart: '2026-06-17T14:00:00Z', dtend: '2026-06-17T14:15:00Z',
      method: 'REQUEST', rsvp_status: 'needs-action', source: 'ics', confidence: null,
      created_at: '2026-06-01T00:00:00Z', raw_ics: null,
    },
    {
      id: 21, event_uid: 'r@google.com', account_id: 'acctA',
      summary: 'Standup (moved)', dtstart: '2026-06-17T15:00:00Z', dtend: '2026-06-17T15:15:00Z',
      method: 'REQUEST', rsvp_status: 'needs-action', source: 'ics', confidence: null,
      created_at: '2026-06-10T00:00:00Z', raw_ics: null,
    },
  ];
  const { events } = await makeSource({ rows, now: NOW }).getUpcomingEvents({ windowMinutes: 720 });
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Standup (moved)');
  assert.equal(events[0].startTime, '2026-06-17T15:00:00.000Z', 'winner time used');
  assert.equal(events[0].endTime, '2026-06-17T15:15:00.000Z');
});

test('RSVP-reply union: two REPLY rows (Accepted:-prefixed) → one event, attendees unioned, title cleaned', async () => {
  const rows = [
    {
      id: 30, event_uid: 'p@google.com', account_id: 'acctA',
      summary: 'Accepted: Planning', dtstart: '2026-06-17T16:00:00Z', dtend: null,
      method: 'REPLY', rsvp_status: 'accepted', source: 'ics', confidence: null,
      created_at: '2026-06-05T00:00:00Z', raw_ics: AT('Carol', 'carol@x.com'),
    },
    {
      id: 31, event_uid: 'p@google.com', account_id: 'acctB',
      summary: 'Accepted: Planning', dtstart: '2026-06-17T16:00:00Z', dtend: null,
      method: 'REPLY', rsvp_status: 'accepted', source: 'ics', confidence: null,
      created_at: '2026-06-06T00:00:00Z', raw_ics: AT('Dave', 'dave@x.com'),
    },
  ];
  const { events } = await makeSource({ rows, now: NOW }).getUpcomingEvents({ windowMinutes: 720 });
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Planning');
  assert.deepEqual(events[0].attendees.map((a) => a.email).sort(), ['carol@x.com', 'dave@x.com']);
});

test('null-UID detected rows do NOT collapse: distinct summaries stay distinct', async () => {
  const base = {
    dtend: null, method: null, rsvp_status: 'needs-action', source: 'detected',
    confidence: 0.95, created_at: '2026-06-17T00:00:00Z', raw_ics: null, event_uid: null,
  };
  const rows = [
    { ...base, id: 40, summary: 'Zoom with NXT', dtstart: '2026-06-17T14:00:00Z' },
    { ...base, id: 41, summary: 'Zoom with Synergy', dtstart: '2026-06-17T14:30:00Z' },
  ];
  const { events } = await makeSource({ rows, now: NOW }).getUpcomingEvents({ windowMinutes: 720 });
  assert.equal(events.length, 2, 'different summaries → different dedup keys');
});

test('cleanTitle: strips RSVP prefixes; empty → Untitled meeting', () => {
  assert.equal(cleanTitle('Accepted: Weekly Sync'), 'Weekly Sync');
  assert.equal(cleanTitle('Declined: 1:1'), '1:1');
  assert.equal(cleanTitle('Tentatively accepted: Review'), 'Review');
  assert.equal(cleanTitle('Plain Title'), 'Plain Title');
  assert.equal(cleanTitle('   '), 'Untitled meeting');
  assert.equal(cleanTitle(null), 'Untitled meeting');
});

test('cleanDescription: removes the -::~:~::- block and bare-marker lines', () => {
  const desc = [
    'Discuss the roadmap.',
    '-::~:~::~:~:~:~:~:~:~:~:~:~:~::-',
    'Join with Google Meet: https://meet.google.com/abc',
    '-::~:~::~:~:~:~:~:~:~:~:~:~:~::-',
  ].join('\n');
  const out = cleanDescription(desc);
  assert.match(out, /Discuss the roadmap\./);
  assert.doesNotMatch(out, /-::~/, 'marker chars gone');
  assert.doesNotMatch(out, /meet\.google\.com/, 'boilerplate between the markers removed');

  // Truncated / unterminated marker (cxmail stores only the first physical ICS line).
  assert.equal(cleanDescription('Agenda here\n-::~:~::~:~:~:~:~:~'), 'Agenda here');
  assert.equal(cleanDescription(''), '');
  assert.equal(cleanDescription(null), '');
});

test('parseIcsAttendees: conference rooms (CUTYPE=ROOM/RESOURCE) are dropped', () => {
  const ics = [
    'ATTENDEE;CN=Alice:mailto:alice@x.com',
    'ATTENDEE;CUTYPE=ROOM;CN=Big Conf Room:mailto:room-big@resource.calendar.google.com',
    'ATTENDEE;CUTYPE=RESOURCE;CN=Projector:mailto:proj@resource.calendar.google.com',
  ].join('\r\n');
  const att = parseIcsAttendees(ics);
  assert.equal(att.length, 1, 'only the human attendee survives');
  assert.equal(att[0].email, 'alice@x.com');
});

test('parseIcsAttendees: falls back to the email local-part when there is no CN', () => {
  const att = parseIcsAttendees('ATTENDEE;PARTSTAT=ACCEPTED:mailto:dana@example.com');
  assert.equal(att.length, 1);
  assert.equal(att[0].name, 'dana', 'name derived from the email local-part');
  assert.equal(att[0].email, 'dana@example.com');
});

test('resolveEventTime: floating dtstart + TZID resolves to the correct absolute instant', () => {
  const ics = 'DTSTART;TZID=America/Chicago:20260617T093000';
  const resolved = resolveEventTime('2026-06-17T09:30:00', ics, 'DTSTART');
  assert.ok(resolved instanceof Date && !Number.isNaN(resolved.getTime()));

  // TZ-agnostic: the instant must read back as 09:30 in America/Chicago, rather
  // than hardcoding the DST-dependent UTC offset.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = {};
  for (const p of dtf.formatToParts(resolved)) if (p.type !== 'literal') parts[p.type] = p.value;
  assert.equal(`${parts.hour}:${parts.minute}`, '09:30');

  // And it must NOT equal the naive "treat floating as UTC" reading.
  assert.notEqual(resolved.toISOString(), '2026-06-17T09:30:00.000Z');
});

test('resolveEventTime: Z is UTC; floating without TZID is machine-local', () => {
  assert.equal(
    resolveEventTime('2026-06-17T14:00:00Z', null, 'DTSTART').toISOString(),
    '2026-06-17T14:00:00.000Z'
  );
  const floating = resolveEventTime('2026-06-19T10:00:00', null, 'DTSTART');
  assert.equal(floating.toISOString(), new Date('2026-06-19T10:00:00').toISOString());
  assert.equal(resolveEventTime('nonsense', null, 'DTSTART'), null);
});

test('CANCELLED status / CANCEL method rows are excluded from normalisation', async () => {
  const rows = [
    {
      id: 50, event_uid: 'c@google.com', summary: 'Cancelled meeting',
      dtstart: '2026-06-17T14:00:00Z', dtend: '2026-06-17T14:30:00Z',
      status: 'CANCELLED', method: 'REQUEST', rsvp_status: 'needs-action',
      source: 'ics', confidence: null, created_at: '2026-06-01T00:00:00Z', raw_ics: null,
    },
    {
      id: 51, event_uid: 'c2@google.com', summary: 'Withdrawn',
      dtstart: '2026-06-17T14:00:00Z', dtend: '2026-06-17T14:30:00Z',
      status: 'CONFIRMED', method: 'CANCEL', rsvp_status: 'needs-action',
      source: 'ics', confidence: null, created_at: '2026-06-01T00:00:00Z', raw_ics: null,
    },
  ];
  const { events } = await makeSource({ rows, now: NOW }).getUpcomingEvents({ windowMinutes: 720 });
  assert.equal(events.length, 0);
});
