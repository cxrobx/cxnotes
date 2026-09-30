'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { FallbackCalendarSource } = require('./fallbackCalendarSource');

function stub(label, available = true) {
  return {
    isAvailable: () => available,
    ensurePermission: async () => `perm-${label}`,
    getUpcomingEvents: async () => ({ events: [label] }),
    getCurrentEvent: async () => ({ event: label }),
  };
}

function make({ mode = 'auto', cxmailAvailable = true, onPick } = {}) {
  const cxmail = stub('cxmail', cxmailAvailable);
  const macos = stub('macos', true);
  const src = new FallbackCalendarSource({ cxmail, macos, getMode: () => mode, onPick });
  return { src, cxmail, macos };
}

test("mode 'macos' always uses EventKit", async () => {
  const { src } = make({ mode: 'macos', cxmailAvailable: true });
  assert.equal(await src.ensurePermission(), 'perm-macos');
  assert.deepEqual(await src.getUpcomingEvents({}), { events: ['macos'] });
  assert.equal(src.getActiveLabel(), 'macos');
});

test("mode 'cxmail' forces cxmail even when unavailable", async () => {
  const { src } = make({ mode: 'cxmail', cxmailAvailable: false });
  assert.equal(await src.ensurePermission(), 'perm-cxmail');
  assert.equal(src.getActiveLabel(), 'cxmail');
});

test("mode 'auto' picks cxmail when its DB is available", async () => {
  const { src } = make({ mode: 'auto', cxmailAvailable: true });
  assert.equal(await src.ensurePermission(), 'perm-cxmail');
  assert.deepEqual(await src.getCurrentEvent(), { event: 'cxmail' });
});

test("mode 'auto' falls back to EventKit when cxmail is not installed", async () => {
  const { src } = make({ mode: 'auto', cxmailAvailable: false });
  assert.equal(await src.ensurePermission(), 'perm-macos');
  assert.deepEqual(await src.getUpcomingEvents({}), { events: ['macos'] });
  assert.equal(src.getActiveLabel(), 'macos');
});

test('delegating before any pick lazily picks (auto default)', async () => {
  const { src } = make({ mode: 'auto', cxmailAvailable: true });
  // No ensurePermission() first — getUpcomingEvents must still resolve a source.
  assert.deepEqual(await src.getUpcomingEvents({}), { events: ['cxmail'] });
});

test('onPick fires on source change with label + mode', async () => {
  const picks = [];
  const { src } = make({ mode: 'auto', cxmailAvailable: true, onPick: (l, m) => picks.push([l, m]) });
  await src.ensurePermission();
  assert.deepEqual(picks, [['cxmail', 'auto']]);
});

test('constructor requires both sources', () => {
  assert.throws(() => new FallbackCalendarSource({ macos: stub('m') }), /cxmail source required/);
  assert.throws(() => new FallbackCalendarSource({ cxmail: stub('c') }), /macos source required/);
});

/* ── attendee completion from EventKit (see ./attendeeMerge) ──── */

const EVENT = { title: 'NXT sync', startTime: '2026-08-21T14:00:00.000Z' };
const person = (email, isCurrentUser = false) => ({ name: '', email, role: '', status: 'unknown', isCurrentUser });

/**
 * A pair of sources shaped like the real ones: cxmail sees only the responder,
 * EventKit sees the whole invite list.
 */
function makeCompleting({ macosPermission = 'granted', macosThrows = false, mode = 'auto' } = {}) {
  let macosCalls = 0;
  const cxmail = {
    isAvailable: () => true,
    ensurePermission: async () => 'granted',
    getUpcomingEvents: async () => ({ events: [{ ...EVENT, attendees: [person('evan@ibexco06.example')] }] }),
    getCurrentEvent: async () => ({ event: { ...EVENT, attendees: [person('evan@ibexco06.example')] } }),
  };
  const macos = {
    isAvailable: () => true,
    ensurePermission: async () => macosPermission,
    getUpcomingEvents: async () => {
      macosCalls += 1;
      if (macosThrows) throw new Error('helper died');
      return { events: [{ ...EVENT, attendees: [person('evan@ibexco06.example'), person('tony@nxtcompany.example')] }] };
    },
    getCurrentEvent: async () => {
      macosCalls += 1;
      if (macosThrows) throw new Error('helper died');
      return { event: { ...EVENT, attendees: [person('evan@ibexco06.example'), person('tony@nxtcompany.example')] } };
    },
  };
  let clock = 1000;
  const src = new FallbackCalendarSource({
    cxmail,
    macos,
    getMode: () => mode,
    now: () => clock,
    rosterCacheTtlMs: 60000,
  });
  return { src, macosCalls: () => macosCalls, advance: (ms) => { clock += ms; } };
}

test('cxmail mode completes its roster from EventKit once permission is granted', async () => {
  const { src } = makeCompleting();
  await src.ensurePermission();

  const { events } = await src.getUpcomingEvents({ windowMinutes: 30 });
  assert.deepEqual(events[0].attendees.map((a) => a.email), ['evan@ibexco06.example', 'tony@nxtcompany.example']);

  const { event } = await src.getCurrentEvent();
  assert.ok(event.attendees.some((a) => a.email === 'tony@nxtcompany.example'));
});

test('a denied EventKit permission costs the completion and nothing else', async () => {
  const { src, macosCalls } = makeCompleting({ macosPermission: 'denied' });
  assert.equal(await src.ensurePermission(), 'granted', "cxmail's own answer must survive");

  const { events } = await src.getUpcomingEvents({ windowMinutes: 30 });
  assert.deepEqual(events[0].attendees.map((a) => a.email), ['evan@ibexco06.example']);
  assert.equal(macosCalls(), 0, 'no helper spawn when it cannot help');
});

test('a thrown EventKit helper degrades to the un-enriched roster', async () => {
  const { src } = makeCompleting({ macosThrows: true });
  await src.ensurePermission();

  const { events } = await src.getUpcomingEvents({ windowMinutes: 30 });
  assert.deepEqual(events[0].attendees.map((a) => a.email), ['evan@ibexco06.example']);
});

test('the roster is cached, so polling does not spawn the helper every tick', async () => {
  const { src, macosCalls, advance } = makeCompleting();
  await src.ensurePermission();

  await src.getUpcomingEvents({ windowMinutes: 30 });
  await src.getUpcomingEvents({ windowMinutes: 30 });
  await src.getUpcomingEvents({ windowMinutes: 30 });
  assert.equal(macosCalls(), 1);

  advance(60001);
  await src.getUpcomingEvents({ windowMinutes: 30 });
  assert.equal(macosCalls(), 2, 'and it does refresh once the TTL lapses');
});

test('a different window is a different cache entry', async () => {
  const { src, macosCalls } = makeCompleting();
  await src.ensurePermission();

  await src.getUpcomingEvents({ windowMinutes: 30 });
  await src.getUpcomingEvents({ windowMinutes: 120 });
  assert.equal(macosCalls(), 2);
});

test('macOS mode never double-queries itself for completion', async () => {
  const { src, macosCalls } = makeCompleting({ mode: 'macos' });
  await src.ensurePermission();
  await src.getUpcomingEvents({ windowMinutes: 30 });

  // One call: the real fetch. Completion is meaningless when EventKit IS the source.
  assert.equal(macosCalls(), 1);
});

test('an empty cxmail result skips the completion path entirely', async () => {
  const { src, macosCalls } = makeCompleting();
  await src.ensurePermission();
  src._cxmail.getUpcomingEvents = async () => ({ events: [] });

  assert.deepEqual(await src.getUpcomingEvents({ windowMinutes: 30 }), { events: [] });
  assert.equal(macosCalls(), 0);
});
