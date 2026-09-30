const test = require('node:test');
const assert = require('node:assert');

const {
  PARTICIPANT_PREVIEW_LIMIT,
  splitParticipants,
  summariseParticipants
} = require('./panelPresenters');

test('splitParticipants handles the comma-joined string the app stores', () => {
  assert.deepStrictEqual(splitParticipants('Ada, Grace, Alan'), ['Ada', 'Grace', 'Alan']);
});

test('splitParticipants also accepts semicolons and newlines', () => {
  assert.deepStrictEqual(splitParticipants('Ada; Grace\nAlan'), ['Ada', 'Grace', 'Alan']);
});

test('splitParticipants drops empty fragments rather than counting them', () => {
  // A trailing comma is common in pasted invite lists; counting it would make
  // the "+N more" label overstate the meeting by one.
  assert.deepStrictEqual(splitParticipants('Ada, , Grace,'), ['Ada', 'Grace']);
});

test('splitParticipants treats absent values as no participants', () => {
  assert.deepStrictEqual(splitParticipants(''), []);
  assert.deepStrictEqual(splitParticipants(null), []);
  assert.deepStrictEqual(splitParticipants(undefined), []);
});

test('a short list is not truncated and needs no more-button', () => {
  const summary = summariseParticipants('Ada, Grace');
  assert.strictEqual(summary.total, 2);
  assert.strictEqual(summary.hidden, 0);
  assert.strictEqual(summary.truncated, false);
  assert.strictEqual(summary.preview, 'Ada, Grace');
  assert.strictEqual(summary.moreLabel, '');
});

test('a list exactly at the limit is still not truncated', () => {
  const names = Array.from({ length: PARTICIPANT_PREVIEW_LIMIT }, (_, i) => `p${i}`);
  const summary = summariseParticipants(names.join(', '));
  assert.strictEqual(summary.truncated, false);
  assert.strictEqual(summary.preview, names.join(', '));
});

test('a mailing-list invite collapses to the preview plus an honest count', () => {
  const names = Array.from({ length: 200 }, (_, i) => `p${i}`);
  const summary = summariseParticipants(names.join(', '));
  assert.strictEqual(summary.total, 200);
  assert.strictEqual(summary.hidden, 200 - PARTICIPANT_PREVIEW_LIMIT);
  assert.strictEqual(summary.truncated, true);
  assert.strictEqual(summary.moreLabel, `+${200 - PARTICIPANT_PREVIEW_LIMIT} more`);
  assert.strictEqual(summary.preview.split(', ').length, PARTICIPANT_PREVIEW_LIMIT);
  // The expanded state must still be able to show everything.
  assert.strictEqual(summary.full.split(', ').length, 200);
});

test('the limit is a parameter, and a nonsense limit degrades to showing one', () => {
  assert.strictEqual(summariseParticipants('a, b, c, d', 2).preview, 'a, b');
  assert.strictEqual(summariseParticipants('a, b, c, d', 0).preview, 'a');
  assert.strictEqual(summariseParticipants('a, b, c, d', -3).preview, 'a');
  assert.strictEqual(summariseParticipants('a, b, c, d', NaN).hidden, 0);
});
