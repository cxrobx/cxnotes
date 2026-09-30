'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureDirectoryStructure,
  cleanupOldRecordings,
  getStorageStats
} = require('./fileManager');

/**
 * These run against a real temporary directory rather than an injected `fs`.
 *
 * `cleanupOldRecordings` unlinks files on a timer, and the promise it has to
 * keep — never delete a transcript or a set of notes — is a promise about real
 * filesystem behaviour: extensions, recursion into session directories, and
 * mtimes. A stubbed `fs` would let a rewrite pass while deleting the wrong
 * thing on disk, which is the single failure this module cannot be allowed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function makeBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-filemanager-'));
  return base;
}

function write(filepath, contents = 'x', ageDays = 0) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, contents);
  if (ageDays > 0) {
    const when = new Date(Date.now() - ageDays * DAY_MS);
    fs.utimesSync(filepath, when, when);
  }
  return filepath;
}

function withBase(fn) {
  const base = makeBase();
  try {
    return fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/* ── ensureDirectoryStructure ────────────────────────────────── */

test('ensureDirectoryStructure creates the three working directories', () => {
  withBase((base) => {
    ensureDirectoryStructure(base);
    for (const name of ['recordings', 'processed', 'temp']) {
      assert.ok(
        fs.statSync(path.join(base, name)).isDirectory(),
        `${name}/ should exist`
      );
    }
  });
});

test('ensureDirectoryStructure is safe to call again and keeps existing files', () => {
  withBase((base) => {
    ensureDirectoryStructure(base);
    const keep = write(path.join(base, 'recordings', 'keep.wav'));

    ensureDirectoryStructure(base);

    assert.ok(fs.existsSync(keep), 'a second call must not clear anything');
  });
});

test('ensureDirectoryStructure builds missing parents in one go', () => {
  withBase((base) => {
    const nested = path.join(base, 'a', 'b', 'c');
    ensureDirectoryStructure(nested);
    assert.ok(fs.statSync(path.join(nested, 'recordings')).isDirectory());
  });
});

/* ── cleanupOldRecordings: what it must delete ───────────────── */

test('cleanupOldRecordings deletes a wav past the retention window', () => {
  withBase((base) => {
    const old = write(path.join(base, 'recordings', 'old.wav'), 'x', 30);

    const deleted = cleanupOldRecordings(base, 7);

    assert.deepStrictEqual(deleted, ['old.wav']);
    assert.ok(!fs.existsSync(old), 'the expired recording should be gone');
  });
});

test('cleanupOldRecordings recurses into session directories', () => {
  withBase((base) => {
    const inSession = write(
      path.join(base, 'recordings', '2026-01-01_10-00-00_session', 'system.wav'),
      'x',
      30
    );

    const deleted = cleanupOldRecordings(base, 7);

    assert.ok(!fs.existsSync(inSession), 'wavs inside a session dir expire too');
    assert.deepStrictEqual(
      deleted,
      [path.join('2026-01-01_10-00-00_session', 'system.wav')],
      'deleted names are relative to recordings/'
    );
  });
});

/* ── cleanupOldRecordings: what it must NEVER delete ─────────── */

test('cleanupOldRecordings never deletes transcripts, notes or manifests', () => {
  withBase((base) => {
    const dir = path.join(base, 'recordings', '2026-01-01_10-00-00_session');
    const survivors = [
      write(path.join(dir, 'manifest.json'), '{}', 400),
      write(path.join(dir, 'notes.md'), '# notes', 400),
      write(path.join(dir, 'merged_transcript.txt'), 'talk', 400),
      write(path.join(dir, 'markers.json'), '[]', 400),
      write(path.join(dir, 'meeting-skeleton.md'), '# skeleton', 400)
    ];
    write(path.join(dir, 'system.wav'), 'x', 400);

    const deleted = cleanupOldRecordings(base, 7);

    for (const f of survivors) {
      assert.ok(fs.existsSync(f), `${path.basename(f)} must survive retention`);
    }
    assert.strictEqual(deleted.length, 1, 'only the wav should have gone');
  });
});

test('cleanupOldRecordings keeps a wav that is still inside the window', () => {
  withBase((base) => {
    const fresh = write(path.join(base, 'recordings', 'fresh.wav'), 'x', 2);

    const deleted = cleanupOldRecordings(base, 7);

    assert.ok(fs.existsSync(fresh), 'a 2-day-old wav is not expired at 7 days');
    assert.deepStrictEqual(deleted, []);
  });
});

test('cleanupOldRecordings leaves the processed/ tree completely alone', () => {
  withBase((base) => {
    const note = write(path.join(base, 'processed', 'x', 'notes.md'), '# n', 400);
    // A stray wav under processed/ is still not this function's business: it
    // only ever walks recordings/.
    const stray = write(path.join(base, 'processed', 'x', 'copy.wav'), 'x', 400);

    cleanupOldRecordings(base, 7);

    assert.ok(fs.existsSync(note));
    assert.ok(fs.existsSync(stray), 'cleanup is scoped to recordings/');
  });
});

test('cleanupOldRecordings honours the retention boundary', () => {
  withBase((base) => {
    write(path.join(base, 'recordings', 'just-inside.wav'), 'x', 6);
    write(path.join(base, 'recordings', 'just-outside.wav'), 'x', 8);

    const deleted = cleanupOldRecordings(base, 7);

    assert.deepStrictEqual(deleted, ['just-outside.wav']);
  });
});

test('cleanupOldRecordings defaults to a 7-day window', () => {
  withBase((base) => {
    write(path.join(base, 'recordings', 'day3.wav'), 'x', 3);
    write(path.join(base, 'recordings', 'day10.wav'), 'x', 10);

    const deleted = cleanupOldRecordings(base);

    assert.deepStrictEqual(deleted, ['day10.wav']);
  });
});

test('cleanupOldRecordings returns an empty list when there is no recordings dir', () => {
  withBase((base) => {
    assert.deepStrictEqual(cleanupOldRecordings(base, 7), []);
  });
});

test('cleanupOldRecordings ignores a wav-like name that is not a wav', () => {
  withBase((base) => {
    const decoy = write(path.join(base, 'recordings', 'system.wav.bak'), 'x', 400);

    const deleted = cleanupOldRecordings(base, 7);

    assert.ok(fs.existsSync(decoy), 'suffix match must be on the real extension');
    assert.deepStrictEqual(deleted, []);
  });
});

test('cleanupOldRecordings does not delete an uppercase .WAV', () => {
  withBase((base) => {
    const shouty = write(path.join(base, 'recordings', 'AUDIO.WAV'), 'x', 400);

    const deleted = cleanupOldRecordings(base, 7);

    // The recorder only ever writes lowercase, so anything uppercase was put
    // there by the user. Matching it would widen a delete, never a create.
    assert.ok(fs.existsSync(shouty), 'retention is case-sensitive on purpose');
    assert.deepStrictEqual(deleted, []);
  });
});

/* ── getStorageStats ─────────────────────────────────────────── */

test('getStorageStats counts loose wavs as recordings and as audio', () => {
  withBase((base) => {
    write(path.join(base, 'recordings', 'a.wav'), 'a'.repeat(100));
    write(path.join(base, 'recordings', 'b.wav'), 'b'.repeat(50));

    const stats = getStorageStats(base);

    assert.strictEqual(stats.recordingCount, 2);
    assert.strictEqual(stats.audioSize, 150);
    assert.strictEqual(stats.totalSize, 150);
  });
});

test('getStorageStats counts a session directory as one recording', () => {
  withBase((base) => {
    const dir = path.join(base, 'recordings', '2026-01-01_10-00-00_session');
    write(path.join(dir, 'system.wav'), 'x'.repeat(80));
    write(path.join(dir, 'mic.wav'), 'y'.repeat(20));
    write(path.join(dir, 'manifest.json'), '{}');

    const stats = getStorageStats(base);

    assert.strictEqual(stats.recordingCount, 1, 'the session is one recording');
    assert.strictEqual(stats.audioSize, 100, 'only wavs count as audio');
    assert.strictEqual(stats.totalSize, 102, 'the manifest still costs disk');
  });
});

test('getStorageStats sizes a non-session directory without counting it', () => {
  withBase((base) => {
    write(path.join(base, 'recordings', 'scratch', 'thing.wav'), 'z'.repeat(10));

    const stats = getStorageStats(base);

    assert.strictEqual(stats.recordingCount, 0, 'only *_session dirs are recordings');
    assert.strictEqual(stats.audioSize, 10, 'its bytes are still on the disk');
  });
});

test('getStorageStats separates generated output from audio', () => {
  withBase((base) => {
    write(path.join(base, 'recordings', 'a.wav'), 'a'.repeat(64));
    write(path.join(base, 'processed', 's', 'notes.md'), '#'.repeat(8));

    const stats = getStorageStats(base);

    assert.strictEqual(stats.audioSize, 64);
    assert.strictEqual(stats.generatedSize, 8);
    assert.strictEqual(stats.totalSize, 72);
  });
});

test('getStorageStats recognises both transcript and notes naming schemes', () => {
  withBase((base) => {
    const dir = path.join(base, 'processed', 'session');
    write(path.join(dir, 'merged_transcript.txt'), 't');
    write(path.join(dir, 'system_transcript.txt'), 't');
    write(path.join(dir, 'notes.md'), 'n');
    write(path.join(dir, 'meeting_notes.md'), 'n');
    write(path.join(dir, 'unrelated.log'), 'l');

    const stats = getStorageStats(base);

    assert.strictEqual(stats.transcriptCount, 2);
    assert.strictEqual(stats.notesCount, 2);
  });
});

test('getStorageStats ignores a loose non-wav sitting in recordings/', () => {
  withBase((base) => {
    write(path.join(base, 'recordings', 'stray.txt'), 'x'.repeat(500));

    const stats = getStorageStats(base);

    // Long-standing behaviour, pinned here so a rewrite cannot change it by
    // accident: at the top level of recordings/ only wavs and directories are
    // looked at, so a stray file's bytes go unreported.
    assert.strictEqual(stats.totalSize, 0);
    assert.strictEqual(stats.recordingCount, 0);
  });
});

test('getStorageStats reports zeroes rather than throwing on an empty base', () => {
  withBase((base) => {
    const stats = getStorageStats(base);

    assert.strictEqual(stats.totalSize, 0);
    assert.strictEqual(stats.recordingCount, 0);
    assert.strictEqual(stats.transcriptCount, 0);
    assert.strictEqual(stats.notesCount, 0);
    assert.strictEqual(stats.totalSizeFormatted, '0 Bytes');
  });
});

test('getStorageStats formats every size it reports', () => {
  withBase((base) => {
    write(path.join(base, 'recordings', 'a.wav'), 'a'.repeat(2048));

    const stats = getStorageStats(base);

    assert.strictEqual(stats.audioSizeFormatted, '2 KB');
    assert.strictEqual(stats.totalSizeFormatted, '2 KB');
    assert.strictEqual(stats.generatedSizeFormatted, '0 Bytes');
  });
});
