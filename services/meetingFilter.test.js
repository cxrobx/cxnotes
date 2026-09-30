'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { passesMeetingFilter, DEFAULT_DENYLIST } = require('./meetingFilter');

function makeEvent(overrides = {}) {
  return {
    title: overrides.title ?? 'Project Kickoff',
    isAllDay: overrides.isAllDay ?? false,
    declinedByMe: overrides.declinedByMe ?? false,
    attendees: overrides.attendees ?? [
      { name: 'Bob', isCurrentUser: false },
      { name: 'Chris', isCurrentUser: true },
    ],
  };
}

// Parity with the cases in scripts/test-calendar-suggestions.js → suite_Suggester_Filters

test('passes: 2+ attendees, not all-day, not declined, title not denied', () => {
  assert.equal(passesMeetingFilter(makeEvent(), { denylist: ['Lunch', 'Focus'] }), true);
});

test('drops: fewer than 2 attendees', () => {
  assert.equal(
    passesMeetingFilter(makeEvent({ attendees: [{ name: 'Me', isCurrentUser: true }] })),
    false
  );
});

test('drops: all-day', () => {
  assert.equal(passesMeetingFilter(makeEvent({ isAllDay: true })), false);
});

test('drops: declined by me', () => {
  assert.equal(passesMeetingFilter(makeEvent({ declinedByMe: true })), false);
});

test('drops: denylist substring match (case-insensitive)', () => {
  assert.equal(passesMeetingFilter(makeEvent({ title: 'Lunch with Bob' }), { denylist: ['Lunch', 'Focus'] }), false);
  assert.equal(passesMeetingFilter(makeEvent({ title: 'FOCUS Friday' }), { denylist: ['Lunch', 'Focus'] }), false);
});

test('passes: empty/absent denylist applies no title filtering', () => {
  assert.equal(passesMeetingFilter(makeEvent({ title: 'Lunch with Bob' })), true);
  assert.equal(passesMeetingFilter(makeEvent({ title: 'Lunch with Bob' }), { denylist: [] }), true);
});

test('drops: non-object / null events', () => {
  assert.equal(passesMeetingFilter(null), false);
  assert.equal(passesMeetingFilter(undefined), false);
  assert.equal(passesMeetingFilter('nope'), false);
});

test('denylist ignores non-string / blank patterns', () => {
  assert.equal(passesMeetingFilter(makeEvent({ title: 'Standup' }), { denylist: [null, '', '   ', 42] }), true);
});

test('DEFAULT_DENYLIST is the shipped default', () => {
  assert.deepEqual([...DEFAULT_DENYLIST], ['Lunch', 'Gym', 'Focus', 'Block', 'OOO', 'Holiday']);
});

// meetingWorthy bypass — cxmail rows have no attendee list but are still meetings

test('meetingWorthy: passes with zero attendees (cxmail detected event)', () => {
  const ev = { title: 'NXT Zoom Meeting', isAllDay: false, declinedByMe: false, attendees: [], meetingWorthy: true };
  assert.equal(passesMeetingFilter(ev), true);
});

test('meetingWorthy: still subject to all-day, declined, and denylist rules', () => {
  const base = { title: 'Sync', isAllDay: false, declinedByMe: false, attendees: [], meetingWorthy: true };
  assert.equal(passesMeetingFilter({ ...base, isAllDay: true }), false);
  assert.equal(passesMeetingFilter({ ...base, declinedByMe: true }), false);
  assert.equal(passesMeetingFilter({ ...base, title: 'Lunch break' }, { denylist: ['Lunch'] }), false);
});

test('without meetingWorthy, the >=2-attendee rule still applies (EventKit path unchanged)', () => {
  const ev = { title: 'Sync', isAllDay: false, declinedByMe: false, attendees: [] };
  assert.equal(passesMeetingFilter(ev), false);
});
