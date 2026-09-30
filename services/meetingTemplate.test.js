'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  SKELETON_SECTIONS,
  buildAgendaFromNotes,
  attendeeDisplayName,
  buildPreRecordSeedFromEvent,
  extractJoinUrl,
  buildMeetingContext,
  renderSkeletonMarkdown,
} = require('./meetingTemplate');

const FIXED_STAMP = '2026-06-17T14:58:00.000Z';

function makeEvent(overrides = {}) {
  return {
    id: overrides.id || 'evt-1',
    occurrenceFingerprint: overrides.occurrenceFingerprint || 'cal:ABC123:2026-06-17T15:00:00Z',
    title: overrides.title ?? 'Project Kickoff',
    startTime: overrides.startTime ?? '2026-06-17T15:00:00Z',
    endTime: overrides.endTime ?? '2026-06-17T15:30:00Z',
    isAllDay: overrides.isAllDay ?? false,
    organizer: overrides.organizer ?? { name: 'Alice', email: 'alice@example.com' },
    attendees: overrides.attendees ?? [
      { name: 'Bob', email: 'bob@example.com', role: 'required', status: 'accepted', isCurrentUser: false },
      { name: 'Chris', email: 'chris@example.com', role: 'required', status: 'accepted', isCurrentUser: true },
    ],
    notes: overrides.notes ?? 'Agenda: align on Q3',
    location: overrides.location ?? '',
    declinedByMe: overrides.declinedByMe ?? false,
  };
}

// ---------------------------------------------------------------------------
// Legacy helper parity (behaviour must be byte-for-byte what main.js had)
// ---------------------------------------------------------------------------

test('buildPreRecordSeedFromEvent: title + participants (self excluded) + agenda', () => {
  const seed = buildPreRecordSeedFromEvent(makeEvent({ title: 'Project Kickoff', notes: 'Agenda: align on Q3' }));
  assert.equal(seed.title, 'Project Kickoff');
  assert.equal(seed.participants, 'Bob');
  assert.equal(seed.agenda, 'Agenda: align on Q3');
});

test('attendeeDisplayName: email-only attendees fall back to local-part', () => {
  assert.equal(attendeeDisplayName({ name: '', email: 'alice@example.com' }), 'alice');
  assert.equal(attendeeDisplayName({ name: 'Bob', email: 'bob@x.com' }), 'Bob');
  assert.equal(attendeeDisplayName({ name: '', email: 'not-an-email' }), null);
  assert.equal(attendeeDisplayName(null), null);
});

test('buildPreRecordSeedFromEvent: email-only attendees → local-part participants', () => {
  const seed = buildPreRecordSeedFromEvent(makeEvent({
    attendees: [
      { name: '', email: 'alice@example.com', isCurrentUser: false },
      { name: '', email: 'me@x.com', isCurrentUser: true },
    ],
  }));
  assert.equal(seed.participants, 'alice');
});

test('buildAgendaFromNotes: strips Zoom boilerplate, keeps agenda; caps at 500', () => {
  const notes = `Agenda: align on Q3\n\nJoin Zoom Meeting\nhttps://zoom.us/j/123?pwd=abc\nMeeting ID: 123 456 7890\nPasscode: 9876`;
  const agenda = buildAgendaFromNotes(notes);
  assert.ok(!agenda.includes('zoom.us'));
  assert.ok(!/Meeting ID/i.test(agenda));
  assert.ok(!/Passcode/i.test(agenda));
  assert.ok(agenda.includes('Agenda: align on Q3'));
  assert.equal(buildAgendaFromNotes('x'.repeat(2000)).length, 500);
});

test('buildAgendaFromNotes: no notes → empty string', () => {
  assert.equal(buildAgendaFromNotes(''), '');
  assert.equal(buildAgendaFromNotes(null), '');
  assert.equal(buildAgendaFromNotes(undefined), '');
});

// ---------------------------------------------------------------------------
// extractJoinUrl
// ---------------------------------------------------------------------------

test('extractJoinUrl: location-first', () => {
  const ev = makeEvent({ location: 'https://zoom.us/j/999', notes: 'https://meet.google.com/abc-defg-hij' });
  assert.equal(extractJoinUrl(ev), 'https://zoom.us/j/999');
});

test('extractJoinUrl: falls through to notes when location has no link', () => {
  const ev = makeEvent({ location: 'Conference Room B', notes: 'Join: https://meet.google.com/abc-defg-hij please' });
  assert.equal(extractJoinUrl(ev), 'https://meet.google.com/abc-defg-hij');
});

test('extractJoinUrl: trailing punctuation trimmed', () => {
  const ev = makeEvent({ location: '', notes: 'Call here (https://teams.microsoft.com/l/meetup-join/xyz).' });
  assert.equal(extractJoinUrl(ev), 'https://teams.microsoft.com/l/meetup-join/xyz');
});

test('extractJoinUrl: no meeting host → null', () => {
  assert.equal(extractJoinUrl(makeEvent({ location: '', notes: 'See https://example.com/doc' })), null);
  assert.equal(extractJoinUrl(null), null);
});

// ---------------------------------------------------------------------------
// buildMeetingContext
// ---------------------------------------------------------------------------

test('buildMeetingContext(null) → null', () => {
  assert.equal(buildMeetingContext(null), null);
  assert.equal(buildMeetingContext(undefined), null);
});

test('buildMeetingContext: superset carries flat keys + rich fields', () => {
  const ctx = buildMeetingContext(makeEvent({ location: 'https://zoom.us/j/555' }));
  // Flat (manifest/summariser contract)
  assert.equal(ctx.title, 'Project Kickoff');
  assert.equal(ctx.participants, 'Bob');
  assert.equal(ctx.agenda, 'Agenda: align on Q3');
  // Rich
  assert.equal(ctx.occurrenceFingerprint, 'cal:ABC123:2026-06-17T15:00:00Z');
  assert.equal(ctx.startTime, '2026-06-17T15:00:00Z');
  assert.equal(ctx.endTime, '2026-06-17T15:30:00Z');
  assert.equal(ctx.joinUrl, 'https://zoom.us/j/555');
  assert.deepEqual(ctx.organizer, { name: 'Alice', email: 'alice@example.com' });
  assert.equal(ctx.attendees.length, 2);
  assert.equal(ctx.attendees[1].isCurrentUser, true);
});

// ---------------------------------------------------------------------------
// renderSkeletonMarkdown
// ---------------------------------------------------------------------------

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'frontmatter block present');
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // strip our double-quoting
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    fm[key] = val;
  }
  return fm;
}

test('renderSkeletonMarkdown: rich event → frontmatter + agenda + attendees + all sections', () => {
  const ctx = buildMeetingContext(makeEvent({ location: 'https://zoom.us/j/555' }));
  const md = renderSkeletonMarkdown(ctx, { generatedAt: FIXED_STAMP });
  const fm = parseFrontmatter(md);

  assert.equal(fm.title, 'Project Kickoff');
  assert.equal(fm.start, '2026-06-17T15:00:00Z');
  assert.equal(fm.join_url, 'https://zoom.us/j/555');
  assert.equal(fm.organiser, 'Alice alice@example.com');
  assert.equal(fm.fingerprint, 'cal:ABC123:2026-06-17T15:00:00Z');
  assert.equal(fm.generated, FIXED_STAMP);
  assert.equal(fm.source, 'cxnotes');

  assert.ok(md.includes('# Project Kickoff'));
  assert.ok(md.includes('## Agenda'));
  assert.ok(md.includes('Agenda: align on Q3'));
  assert.ok(md.includes('## Attendees'));
  assert.ok(md.includes('- Bob'));
  assert.ok(/- Chris \(you/.test(md), 'current user tagged "(you, ...)"');
  // Every scaffolded section heading present
  for (const s of SKELETON_SECTIONS) {
    assert.ok(md.includes(`## ${s.heading}`), `section ${s.heading} present`);
  }
});

test('renderSkeletonMarkdown: deterministic for a fixed generatedAt', () => {
  const ctx = buildMeetingContext(makeEvent());
  const a = renderSkeletonMarkdown(ctx, { generatedAt: FIXED_STAMP });
  const b = renderSkeletonMarkdown(ctx, { generatedAt: FIXED_STAMP });
  assert.equal(a, b);
});

test('renderSkeletonMarkdown: legacy flat {title,participants,agenda} renders cleanly', () => {
  const md = renderSkeletonMarkdown(
    { title: 'Quick Sync', participants: 'Bob, Carol', agenda: 'Status update' },
    { generatedAt: FIXED_STAMP }
  );
  const fm = parseFrontmatter(md);
  assert.equal(fm.title, 'Quick Sync');
  assert.ok(!('join_url' in fm), 'no join_url for flat context');
  assert.ok(!('fingerprint' in fm), 'no fingerprint for flat context');
  assert.ok(md.includes('Status update'));
  assert.ok(md.includes('- Bob'));
  assert.ok(md.includes('- Carol'));
});

test('renderSkeletonMarkdown: no agenda / no attendees → placeholder lines, no crash', () => {
  const md = renderSkeletonMarkdown({ title: 'Empty' }, { generatedAt: FIXED_STAMP });
  assert.ok(md.includes('_No agenda supplied._'));
  assert.ok(md.includes('_No attendees listed._'));
});

test('renderSkeletonMarkdown: YAML-injection title stays a single quoted scalar', () => {
  const ctx = buildMeetingContext(makeEvent({ title: 'Hi"\ntitle: hacked\nattendees: [evil]' }));
  const md = renderSkeletonMarkdown(ctx, { generatedAt: FIXED_STAMP });

  // Exactly one frontmatter block (two --- delimiters before the body)
  const delimiters = md.split('\n').filter((l) => l === '---').length;
  assert.equal(delimiters, 2);

  // The injected newline was neutralised: no top-level `title: hacked` key and
  // no `attendees:` key leaked into the frontmatter.
  const fmBlock = md.match(/^---\n([\s\S]*?)\n---\n/)[1];
  const topLevelTitleLines = fmBlock.split('\n').filter((l) => /^title:/.test(l));
  assert.equal(topLevelTitleLines.length, 1, 'exactly one top-level title key');
  assert.ok(!/^attendees:/m.test(fmBlock), 'no injected attendees key');
  assert.ok(!/^title: hacked/m.test(fmBlock), 'injected title:hacked neutralised');

  // The frontmatter remains structurally parseable.
  const fm = parseFrontmatter(md);
  assert.ok(fm.title.includes('hacked'), 'malicious content survives as inert data inside the scalar');
});
