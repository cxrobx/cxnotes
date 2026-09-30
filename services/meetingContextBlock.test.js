'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { renderContextBlock } = require('./meetingContextBlock');

/* ── the empty contract, shared with markers/slides/speakerNames ── */

test('renderContextBlock is empty with no context at all', () => {
  assert.strictEqual(renderContextBlock(), '');
  assert.strictEqual(renderContextBlock({}), '');
  assert.strictEqual(renderContextBlock(null), '');
  assert.strictEqual(renderContextBlock({ title: '', participants: '', agenda: '' }), '');
  assert.strictEqual(renderContextBlock({ title: '   ' }), '');
});

test('renderContextBlock survives a non-object context', () => {
  assert.strictEqual(renderContextBlock('nonsense'), '');
  assert.strictEqual(renderContextBlock(42), '');
});

/* ── the guard this module exists for ────────────────────────── */

test('an invite list is labelled Invited, never Participants', () => {
  const block = renderContextBlock({ participants: 'Evan Lewis, Dominic Sawyer' });

  // The section heading the model must fill in is "## Participants". An exact
  // word match on the context line is what invites a straight copy.
  assert.match(block, /- Invited \(from the invitation, NOT an attendance record\): Evan Lewis, Dominic Sawyer/);
  assert.doesNotMatch(block, /^- Participants:/m);
});

test('the block tells the model to build Participants from the transcript', () => {
  const block = renderContextBlock({ participants: 'Tony, Evan' });

  assert.match(block, /SPELLING REFERENCE/);
  assert.match(block, /from the TRANSCRIPT, not from the invited list/);
  assert.match(block, /Do not list an invited person as present/);
});

test('the block names the real track label for unidentified speakers', () => {
  const block = renderContextBlock({ participants: 'Tony, Evan' }, { systemLabel: 'Audience' });
  assert.match(block, /keep "Audience" rather than/);

  // Falls back rather than emitting an empty pair of quotes.
  assert.match(renderContextBlock({ participants: 'Tony' }), /keep "Remote" rather than/);
});

test('the block says an invite list is more often incomplete than wrong', () => {
  // The 2026-08-21 failure was an ABSENT attendee (never RSVP'd), not a
  // misspelled one. A model told only "do not over-list" would still refuse a
  // name the transcript supplies but the roster omits.
  const block = renderContextBlock({ participants: 'Evan Lewis, Dominic Sawyer' });
  assert.match(block, /If the transcript names someone who is not on the invited list, use that name/);
});

/* ── the other two fields are unchanged in spirit ─────────────── */

test('title and agenda render without dragging in the participant guidance', () => {
  const block = renderContextBlock({ title: 'NXT Sync', agenda: 'Publishing and access' });

  assert.match(block, /- Meeting title: NXT Sync/);
  assert.match(block, /- Agenda\/notes: Publishing and access/);
  assert.match(block, /Reference the agenda topics/);
  assert.doesNotMatch(block, /SPELLING REFERENCE/);
  assert.doesNotMatch(block, /Invited/);
});

test('no agenda means no agenda instruction', () => {
  const block = renderContextBlock({ title: 'NXT Sync' });
  assert.match(block, /- Meeting title: NXT Sync/);
  assert.doesNotMatch(block, /Reference the agenda topics/);
});

test('every field renders together', () => {
  const block = renderContextBlock(
    { title: 'NXT Sync', participants: 'Evan Lewis', agenda: 'Access and next steps' },
    { systemLabel: 'Audience' }
  );

  assert.match(block, /- Meeting title: NXT Sync/);
  assert.match(block, /- Invited .*: Evan Lewis/);
  assert.match(block, /- Agenda\/notes: Access and next steps/);
  assert.match(block, /known before the meeting started/);
});

test('whitespace-only fields are dropped, not rendered blank', () => {
  const block = renderContextBlock({ title: 'NXT Sync', participants: '   ', agenda: '' });
  assert.doesNotMatch(block, /Invited/);
  assert.doesNotMatch(block, /Agenda\/notes/);
});

test('the block warns that a one-off unmatched name is probably a mis-transcription', () => {
  // The regression the first version of this block caused: told only "do not
  // over-list", the model listed "Charlie" (a mis-heard greeting) and "Sagan"
  // ("say again") as attendees. Safer than inventing attendance, still wrong.
  const block = renderContextBlock({ participants: 'Evan Lewis, Dominic Sawyer' });

  assert.match(block, /appears exactly once, matches nobody on the invited list/);
  assert.match(block, /prefer the invited spelling/);
});
