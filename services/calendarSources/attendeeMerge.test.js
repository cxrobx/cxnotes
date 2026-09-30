'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  normaliseTitle,
  findMatch,
  mergeAttendees,
  enrichEvent,
  enrichEvents,
} = require('./attendeeMerge');

const who = (email, extra = {}) => ({
  name: extra.name || '',
  email,
  role: extra.role || '',
  status: extra.status || 'unknown',
  isCurrentUser: Boolean(extra.isCurrentUser),
});

/* ── normaliseTitle ──────────────────────────────────────────── */

test('normaliseTitle survives the dash flavour differing between stacks', () => {
  // The real 2026-08-21 case: an em dash in the ICS, a hyphen in EventKit.
  assert.strictEqual(
    normaliseTitle('NXT Training Academy Studio — Access and Next Steps'),
    normaliseTitle('NXT Training Academy Studio - Access and Next Steps')
  );
});

test('normaliseTitle strips stacked calendar prefixes', () => {
  assert.strictEqual(normaliseTitle('Accepted: Weekly sync'), 'weekly sync');
  assert.strictEqual(normaliseTitle('Updated invitation: Accepted: Weekly sync'), 'weekly sync');
  assert.strictEqual(normaliseTitle('Cancelled: Weekly sync'), 'weekly sync');
});

test('normaliseTitle does not collapse genuinely different meetings', () => {
  assert.notStrictEqual(normaliseTitle('NXT sync'), normaliseTitle('QRS sync'));
});

/* ── findMatch: ambiguity must never enrich ──────────────────── */

const base = { title: 'NXT sync', startTime: '2026-08-21T14:00:00.000Z' };

test('findMatch tolerates a small start-time skew between stacks', () => {
  const candidate = { title: 'NXT sync', startTime: '2026-08-21T14:00:30.000Z' };
  assert.strictEqual(findMatch(base, [candidate]), candidate);
});

test('findMatch rejects a candidate outside the tolerance', () => {
  const candidate = { title: 'NXT sync', startTime: '2026-08-21T14:30:00.000Z' };
  assert.strictEqual(findMatch(base, [candidate]), null);
});

test('findMatch returns null when two candidates tie', () => {
  // Attaching the wrong roster is worse than attaching none.
  const a = { title: 'NXT sync', startTime: '2026-08-21T14:00:00.000Z', attendees: [who('a@x.com')] };
  const b = { title: 'NXT sync', startTime: '2026-08-21T14:00:00.000Z', attendees: [who('b@x.com')] };
  assert.strictEqual(findMatch(base, [a, b]), null);
});

test('findMatch needs both a title and a parseable start', () => {
  assert.strictEqual(findMatch({ title: '', startTime: base.startTime }, [base]), null);
  assert.strictEqual(findMatch({ title: 'NXT sync', startTime: 'not-a-date' }, [base]), null);
  assert.strictEqual(findMatch(base, []), null);
  assert.strictEqual(findMatch(base, null), null);
});

/* ── mergeAttendees ──────────────────────────────────────────── */

test('mergeAttendees appends people the primary never saw, primary first', () => {
  const merged = mergeAttendees(
    [who('evan@ibexco06.example', { name: 'Evan Lewis', status: 'accepted' })],
    [who('tony@nxtcompany.example', { name: 'Tony Richards', status: 'pending' })]
  );
  assert.deepStrictEqual(merged.map((a) => a.email), ['evan@ibexco06.example', 'tony@nxtcompany.example']);
});

test('mergeAttendees never lets the user end up in their own participant list', () => {
  // An ICS-derived attendee can never know it is the user, so isCurrentUser is
  // always false there. Losing EventKit's `true` would list Chris as a guest.
  const merged = mergeAttendees(
    [who('chris@example.org')],
    [who('chris@example.org', { isCurrentUser: true })]
  );
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].isCurrentUser, true);
});

test('mergeAttendees dedupes case-insensitively on email', () => {
  const merged = mergeAttendees([who('Evan@Ibexco06.example')], [who('evan@ibexco06.example')]);
  assert.strictEqual(merged.length, 1);
});

test('mergeAttendees fills a blank name and a real RSVP from the other side', () => {
  const merged = mergeAttendees(
    [who('tony@nxtcompany.example', { name: '' })],
    [who('tony@nxtcompany.example', { name: 'Tony Richards', status: 'pending', role: 'required' })]
  );
  assert.strictEqual(merged[0].name, 'Tony Richards');
  assert.strictEqual(merged[0].status, 'pending');
  assert.strictEqual(merged[0].role, 'required');
});

test('mergeAttendees falls back to a name key when there is no email', () => {
  const merged = mergeAttendees([who('', { name: 'Victor' })], [who('', { name: 'Victor' })]);
  assert.strictEqual(merged.length, 1);
});

test('mergeAttendees drops entries that identify nobody', () => {
  assert.deepStrictEqual(mergeAttendees([who('', { name: '' })], []), []);
  assert.deepStrictEqual(mergeAttendees(null, undefined), []);
});

/* ── enrichEvent: the whole point, on the real shape ─────────── */

test('enrichEvent recovers the invitees who never RSVPd', () => {
  const fromMail = {
    title: 'NXT Training Academy Studio — Access and Next Steps',
    startTime: '2026-08-21T14:00:00.000Z',
    attendees: [
      who('evan@ibexco06.example', { name: 'Evan Lewis', status: 'accepted' }),
      who('dominic@acmecatalystadvisors.example', { name: 'Dominic Sawyer', status: 'accepted' }),
    ],
  };
  const fromEventKit = {
    title: 'NXT Training Academy Studio - Access and Next Steps',
    startTime: '2026-08-21T14:00:30.000Z',
    attendees: [
      who('chris@example.org', { isCurrentUser: true }),
      who('tony@nxtcompany.example', { name: 'Tony Richards', status: 'pending' }),
      who('victor@nxtcompany.example', { name: 'Victor', status: 'pending' }),
      who('evan@ibexco06.example', { name: 'Evan Lewis', status: 'accepted' }),
    ],
  };

  const out = enrichEvent(fromMail, [fromEventKit]);
  const emails = out.attendees.map((a) => a.email);

  assert.ok(emails.includes('tony@nxtcompany.example'), 'the non-responder must be recovered');
  assert.ok(emails.includes('victor@nxtcompany.example'));
  assert.strictEqual(emails.length, 5);
  assert.strictEqual(out.attendeesCompletedFrom, 'macos');
});

test('enrichEvent returns the SAME object when there is nothing to add', () => {
  const event = { ...base, attendees: [who('evan@ibexco06.example')] };
  const candidate = { ...base, attendees: [who('evan@ibexco06.example')] };
  assert.strictEqual(enrichEvent(event, [candidate]), event);
});

test('enrichEvent leaves an unmatched event untouched', () => {
  const event = { ...base, attendees: [who('evan@ibexco06.example')] };
  assert.strictEqual(enrichEvent(event, [{ title: 'Other', startTime: base.startTime }]), event);
  assert.strictEqual(enrichEvent(event, []), event);
});

test('enrichEvent never removes an attendee the OS calendar has forgotten', () => {
  const event = { ...base, attendees: [who('gone@x.com'), who('evan@ibexco06.example')] };
  const out = enrichEvent(event, [{ ...base, attendees: [who('evan@ibexco06.example'), who('new@x.com')] }]);
  assert.ok(out.attendees.some((a) => a.email === 'gone@x.com'));
});

test('enrichEvent survives junk input', () => {
  assert.strictEqual(enrichEvent(null, []), null);
  assert.strictEqual(enrichEvent(undefined, []), undefined);
});

test('enrichEvents maps and leaves an empty list alone', () => {
  const events = [{ ...base, attendees: [who('a@x.com')] }];
  assert.strictEqual(enrichEvents([], []).length, 0);
  assert.strictEqual(enrichEvents(events, [])[0], events[0]);
});
