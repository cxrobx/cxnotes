'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildNoteMenuItems, NOTE_MENU_ACTIONS } = require('./noteMenu');

const ALL = {
  notePath: '/vault/Meetings/Note.md',
  transcriptPath: '/rec/processed/s/merged_transcript.txt',
  sessionDir: '/rec/recordings/s'
};

const idsOf = (items) => items.filter((i) => i.id).map((i) => i.id);
const byId = (items, id) => items.find((i) => i.id === id);
/** Every id a click could dispatch: the items AND their Option-key variants. */
const allActionIds = (items) => items
  .filter((i) => i.id)
  .flatMap((i) => (i.alt ? [i.id, i.alt.id] : [i.id]));

test('every item is present regardless of what exists', () => {
  // A menu that hides items rather than disabling them teaches the user the
  // feature is missing, not that this note lacks the file.
  const full = buildNoteMenuItems(ALL);
  const empty = buildNoteMenuItems({});
  assert.deepStrictEqual(idsOf(full), idsOf(empty));
  assert.deepStrictEqual(idsOf(full), ['open', 'revealNote', 'revealTranscript', 'delete']);
});

test('each item is gated on its OWN path, not on the others', () => {
  const onlyTranscript = buildNoteMenuItems({ transcriptPath: ALL.transcriptPath });
  assert.strictEqual(byId(onlyTranscript, 'revealTranscript').enabled, true);
  assert.strictEqual(byId(onlyTranscript, 'open').enabled, false);
  assert.strictEqual(byId(onlyTranscript, 'revealNote').enabled, false);
  assert.strictEqual(byId(onlyTranscript, 'delete').enabled, false);

  // The common real case: a session whose manifest names a transcript under an
  // older output directory. The note opens; the transcript must not.
  const staleTranscript = buildNoteMenuItems({ ...ALL, transcriptPath: null });
  assert.strictEqual(byId(staleTranscript, 'open').enabled, true);
  assert.strictEqual(byId(staleTranscript, 'revealTranscript').enabled, false);
  assert.strictEqual(byId(staleTranscript, 'delete').enabled, true);
});

test('an empty-string path is not a path', () => {
  // main passes '' through from the row dataset when the attribute is absent.
  const items = buildNoteMenuItems({ notePath: '', transcriptPath: '', sessionDir: '' });
  for (const item of items.filter((i) => i.id)) {
    assert.strictEqual(item.enabled, false, `${item.id} should be disabled`);
  }
});

test('called with no argument at all it still returns a menu', () => {
  const items = buildNoteMenuItems();
  assert.strictEqual(items.length, 5);
  assert.ok(items.every((i) => i.type === 'separator' || i.enabled === false));
});

test('delete is the only danger item, and it sits after a separator', () => {
  const items = buildNoteMenuItems(ALL);
  assert.deepStrictEqual(items.filter((i) => i.danger).map((i) => i.id), ['delete']);
  const sepIndex = items.findIndex((i) => i.type === 'separator');
  assert.ok(sepIndex > 0 && sepIndex < items.length - 1);
  assert.strictEqual(items[sepIndex + 1].id, 'delete');
});

test('delete is labelled with an ellipsis — it asks before destroying', () => {
  assert.match(byId(buildNoteMenuItems(ALL), 'delete').label, /…$/);
});

test('the two Reveals name what they reveal', () => {
  // "Reveal in Finder" next to "Reveal Transcript in Finder" is ambiguous.
  const items = buildNoteMenuItems(ALL);
  assert.strictEqual(byId(items, 'revealNote').label, 'Reveal Note in Finder');
  assert.strictEqual(byId(items, 'revealTranscript').label, 'Reveal Transcript in Finder');
});

test('the two Reveals carry a Copy Path as their Option-key variant, nothing else does', () => {
  // Finder's gesture: hold Option and "Copy" reads "Copy as Pathname". Here it
  // is each Reveal that turns into copying the path it would have revealed.
  const items = buildNoteMenuItems(ALL);
  assert.deepStrictEqual(byId(items, 'revealNote').alt, { id: 'copyNotePath', label: 'Copy Note Path' });
  assert.deepStrictEqual(
    byId(items, 'revealTranscript').alt,
    { id: 'copyTranscriptPath', label: 'Copy Transcript Path' }
  );
  // Open has no useful path variant, and Delete must never gain an
  // Option-key form — a modifier that skips the confirmation is Finder's
  // "Delete Immediately", and nothing here is that recoverable.
  assert.strictEqual(byId(items, 'open').alt, undefined);
  assert.strictEqual(byId(items, 'delete').alt, undefined);
});

test('an Option-key variant carries no enabled flag of its own — it inherits the parent gate', () => {
  // One gate, so "reveal is disabled but copy is enabled" cannot exist: a
  // path that is not on disk is not worth copying either.
  for (const item of buildNoteMenuItems({}).filter((i) => i.alt)) {
    assert.deepStrictEqual(Object.keys(item.alt).sort(), ['id', 'label']);
  }
});

test('NOTE_MENU_ACTIONS covers every id the builder can emit, Option variants included', () => {
  // Guards the dispatcher: an id added here without a matching action would be
  // a menu entry that silently does nothing when clicked. The alt ids are the
  // easy ones to forget, since they are not top-level entries.
  assert.deepStrictEqual([...NOTE_MENU_ACTIONS].sort(), allActionIds(buildNoteMenuItems(ALL)).sort());
});

test('the action list is frozen', () => {
  assert.ok(Object.isFrozen(NOTE_MENU_ACTIONS));
});
