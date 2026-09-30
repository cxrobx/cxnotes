'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  SILENT_TRACK_MARKER,
  buildSilentTrackWarning,
  prependSilentTrackWarning,
  OWN_MIC_MARKER,
  buildOwnMicNotice,
  prependOwnMicNotice
} = require('./silentTrackNotice');

/** A manifest in the shape `processSession` writes after the peak scan. */
function manifest({ systemSilent = false, micSilent = false, micLabel = 'Me' } = {}) {
  return {
    tracks: {
      system: { file: 'system.wav', label: 'Remote', silent: systemSilent },
      mic: { file: 'mic.wav', label: micLabel, silent: micSilent }
    }
  };
}

/** An in-memory fs, so the tests never touch disk. */
function fakeFs(files = {}) {
  return {
    store: files,
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => files[p],
    writeFileSync: (p, content) => { files[p] = content; }
  };
}

test('buildSilentTrackWarning: a healthy capture gets no warning', () => {
  assert.strictEqual(buildSilentTrackWarning(manifest()), null);
});

test('buildSilentTrackWarning: a silent system track names what is missing', () => {
  const warning = buildSilentTrackWarning(manifest({ systemSilent: true }));

  assert.match(warning, /System audio was not captured/);
  assert.match(warning, /Only Me's side of this meeting/);
  assert.match(warning, /one half of the conversation/);
  assert.ok(warning.startsWith(SILENT_TRACK_MARKER), 'carries the idempotence marker');
});

test('buildSilentTrackWarning: uses the configured mic label', () => {
  const warning = buildSilentTrackWarning(manifest({ systemSilent: true, micLabel: 'Chris' }));
  assert.match(warning, /Only Chris's side/);
});

test('buildSilentTrackWarning: two silent tracks do not claim "your side" survived', () => {
  // Both tracks dead means nothing was recorded at all — telling the reader they
  // still have their own half would be its own small lie.
  const warning = buildSilentTrackWarning(manifest({ systemSilent: true, micSilent: true }));

  assert.match(warning, /No audio was captured/);
  assert.match(warning, /should be\n> discarded/);
  assert.doesNotMatch(warning, /side of this meeting/);
});

test('buildSilentTrackWarning: a silent MIC alone is not this warning', () => {
  // The system track is what carries the other participants. A silent mic is a
  // different (and much more obvious) problem.
  assert.strictEqual(buildSilentTrackWarning(manifest({ micSilent: true })), null);
});

test('buildSilentTrackWarning: survives a manifest with no tracks at all', () => {
  assert.strictEqual(buildSilentTrackWarning({}), null);
  assert.strictEqual(buildSilentTrackWarning(null), null);
});

test('prependSilentTrackWarning: puts the warning above the note', () => {
  const fsImpl = fakeFs({ '/notes.md': '# Meeting\n\nSome summary.\n' });
  const written = prependSilentTrackWarning('/notes.md', manifest({ systemSilent: true }), { fsImpl });

  assert.strictEqual(written, true);
  assert.ok(fsImpl.store['/notes.md'].startsWith(SILENT_TRACK_MARKER));
  assert.match(fsImpl.store['/notes.md'], /# Meeting/, 'the original note is preserved');
});

test('prependSilentTrackWarning: is idempotent across reprocessing', () => {
  // `processSession`, `resummariseSession` and a full reprocess all run this.
  // Without the marker a note re-summarised three times carries three warnings.
  const fsImpl = fakeFs({ '/notes.md': '# Meeting\n' });
  const m = manifest({ systemSilent: true });

  assert.strictEqual(prependSilentTrackWarning('/notes.md', m, { fsImpl }), true);
  assert.strictEqual(prependSilentTrackWarning('/notes.md', m, { fsImpl }), false);
  assert.strictEqual(prependSilentTrackWarning('/notes.md', m, { fsImpl }), false);

  const occurrences = fsImpl.store['/notes.md'].split(SILENT_TRACK_MARKER).length - 1;
  assert.strictEqual(occurrences, 1);
});

test('prependSilentTrackWarning: leaves a healthy note untouched', () => {
  const fsImpl = fakeFs({ '/notes.md': '# Meeting\n' });
  assert.strictEqual(prependSilentTrackWarning('/notes.md', manifest(), { fsImpl }), false);
  assert.strictEqual(fsImpl.store['/notes.md'], '# Meeting\n');
});

test('prependSilentTrackWarning: a missing note is not an error', () => {
  const fsImpl = fakeFs({});
  assert.strictEqual(
    prependSilentTrackWarning('/gone.md', manifest({ systemSilent: true }), { fsImpl }),
    false
  );
});

test('prependSilentTrackWarning: a write failure never takes the pipeline down', () => {
  // A note that exists without its warning is far better than no note.
  const fsImpl = fakeFs({ '/notes.md': '# Meeting\n' });
  fsImpl.writeFileSync = () => { throw new Error('read-only volume'); };

  assert.strictEqual(
    prependSilentTrackWarning('/notes.md', manifest({ systemSilent: true }), { fsImpl }),
    false
  );
  assert.strictEqual(fsImpl.store['/notes.md'], '# Meeting\n');
});

// --- own-mic notice (2026-09-25) --------------------------------------------

function withCheck(check) {
  return { ...manifest({ micLabel: 'Chris' }), processing: { transcription: { companionCheck: check } } };
}

test('buildOwnMicNotice: says the mic side was rebuilt, with the reason and offset', () => {
  const notice = buildOwnMicNotice(withCheck({ decision: 'companion+own-mic', reason: 'companion has no mic lines; own mic.wav has speech', offsetSec: 581.9 }));
  assert.ok(notice.startsWith(OWN_MIC_MARKER));
  assert.match(notice, /Chris's side came from CXNotes' own microphone recording/);
  assert.match(notice, /companion has no mic lines/);
  assert.match(notice, /581\.9s/);
});

test('buildOwnMicNotice: nothing when the companion transcript was used, or never considered', () => {
  assert.strictEqual(buildOwnMicNotice(withCheck({ decision: 'companion', reason: 'fine', offsetSec: 1 })), null);
  assert.strictEqual(buildOwnMicNotice(manifest()), null);
});

test('prependOwnMicNotice: writes once, however often the note is re-summarised', () => {
  const files = { '/n.md': '# Notes\n' };
  const fsImpl = {
    existsSync: (p) => p in files,
    readFileSync: (p) => files[p],
    writeFileSync: (p, v) => { files[p] = v; }
  };
  const m = withCheck({ decision: 'own', reason: 'clock could not be matched', offsetSec: null });
  assert.strictEqual(prependOwnMicNotice('/n.md', m, { fsImpl }), true);
  assert.strictEqual(prependOwnMicNotice('/n.md', m, { fsImpl }), false);
  assert.strictEqual(files['/n.md'].split(OWN_MIC_MARKER).length, 2);
  assert.match(files['/n.md'], /# Notes/);
});
