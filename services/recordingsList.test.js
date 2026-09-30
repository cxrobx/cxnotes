'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  EMPTY_STORAGE_SUMMARY,
  toStorageSummary,
  buildRecordingsList
} = require('./recordingsList');

const REC = '/out/recordings';
const PROC = '/out/processed';

/**
 * A tiny in-memory filesystem. Directories are declared by listing them;
 * everything else is a file with contents and stats.
 */
function fakeFs({ dirs = {}, files = {} } = {}) {
  const isDir = (p) => Object.prototype.hasOwnProperty.call(dirs, p);
  return {
    existsSync: (p) => isDir(p) || Object.prototype.hasOwnProperty.call(files, p),
    readdirSync: (p) => dirs[p] || [],
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p].content;
    },
    statSync: (p) => {
      if (isDir(p)) {
        const meta = files[p] || {};
        return {
          isDirectory: () => true,
          size: 0,
          birthtime: meta.birthtime || new Date(0),
          mtime: meta.mtime || new Date(0)
        };
      }
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      const f = files[p];
      return {
        isDirectory: () => false,
        size: f.size || 0,
        birthtime: f.birthtime || new Date(0),
        mtime: f.mtime || new Date(0)
      };
    }
  };
}

const deps = (fsImpl, over = {}) => ({
  fsImpl,
  isPoisoned: () => false,
  hasReusableTranscript: () => true,
  ...over
});

const j = (...p) => path.join(...p);

/* ── storage summary ─────────────────────────────────────────── */

test('toStorageSummary renames the counts the renderer reads', () => {
  // fileManager counts in the singular; the settings UI reads the plural.
  const out = toStorageSummary({
    totalSize: 100, totalSizeFormatted: '100 Bytes',
    audioSize: 80, audioSizeFormatted: '80 Bytes',
    generatedSize: 20, generatedSizeFormatted: '20 Bytes',
    recordingCount: 3, transcriptCount: 2, notesCount: 1
  });

  assert.strictEqual(out.recordingsCount, 3);
  assert.strictEqual(out.transcriptsCount, 2);
  assert.strictEqual(out.notesCount, 1);
  assert.ok(!('recordingCount' in out), 'the singular names must not leak through');
});

test('the empty summary has every key the populated one has', () => {
  const populated = toStorageSummary({
    totalSize: 0, totalSizeFormatted: '', audioSize: 0, audioSizeFormatted: '',
    generatedSize: 0, generatedSizeFormatted: '', recordingCount: 0,
    transcriptCount: 0, notesCount: 0
  });

  assert.deepStrictEqual(Object.keys(EMPTY_STORAGE_SUMMARY).sort(), Object.keys(populated).sort());
});

/* ── nothing to list ─────────────────────────────────────────── */

test('no recordings directory yields an empty list, not a throw', () => {
  const list = buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fakeFs()));
  assert.deepStrictEqual(list, []);
});

test('an empty recordings directory yields an empty list', () => {
  const fs = fakeFs({ dirs: { [REC]: [] } });
  assert.deepStrictEqual(buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs)), []);
});

/* ── loose single-track recordings ───────────────────────────── */

test('a loose wav becomes a single-track row', () => {
  const fs = fakeFs({
    dirs: { [REC]: ['meeting.wav'] },
    files: { [j(REC, 'meeting.wav')]: { size: 4096, birthtime: new Date('2026-08-01') } }
  });

  const [row] = buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs));

  assert.strictEqual(row.filename, 'meeting.wav');
  assert.strictEqual(row.isDualTrack, false);
  assert.strictEqual(row.size, 4096);
  assert.strictEqual(row.transcribed, false);
  assert.strictEqual(row.summarised, false);
});

test('a loose wav reports its processed artefacts when they exist', () => {
  const fs = fakeFs({
    dirs: { [REC]: ['meeting.wav'] },
    files: {
      [j(REC, 'meeting.wav')]: { size: 10 },
      [j(PROC, 'meeting_transcript.txt')]: { content: 'x' },
      [j(PROC, 'meeting_notes.md')]: { content: '# n' }
    }
  });

  const [row] = buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs));

  assert.strictEqual(row.transcribed, true);
  assert.strictEqual(row.summarised, true);
});

test('non-wav clutter in recordings/ is ignored', () => {
  const fs = fakeFs({
    dirs: { [REC]: ['notes.txt', '.DS_Store'] },
    files: { [j(REC, 'notes.txt')]: { size: 1 }, [j(REC, '.DS_Store')]: { size: 1 } }
  });

  assert.deepStrictEqual(buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs)), []);
});

/* ── dual-track sessions ─────────────────────────────────────── */

const SESSION = '2026-08-01_10-00-00_session';
const SDIR = j(REC, SESSION);
const ODIR = j(PROC, `${SESSION}`);

function sessionFs(extra = {}) {
  return fakeFs({
    dirs: { [REC]: [SESSION], [SDIR]: [] },
    files: {
      [j(SDIR, 'manifest.json')]: { content: JSON.stringify({ sessionId: '2026-08-01_10-00-00' }) },
      [j(SDIR, 'system.wav')]: { size: 1000 },
      [j(SDIR, 'mic.wav')]: { size: 500 },
      ...extra
    }
  });
}

test('a session sums only its audio tracks, not its manifest', () => {
  const [row] = buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(sessionFs()));

  assert.strictEqual(row.isDualTrack, true);
  assert.strictEqual(row.size, 1500, 'system.wav + mic.wav only');
});

test('a session with only a system track still sizes correctly', () => {
  const fs = fakeFs({
    dirs: { [REC]: [SESSION], [SDIR]: [] },
    files: {
      [j(SDIR, 'manifest.json')]: { content: JSON.stringify({ sessionId: 'x' }) },
      [j(SDIR, 'system.wav')]: { size: 700 }
    }
  });

  const [row] = buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs));
  assert.strictEqual(row.size, 700);
});

test('a session without a manifest is skipped entirely', () => {
  const fs = fakeFs({ dirs: { [REC]: [SESSION], [SDIR]: [] }, files: {} });

  assert.deepStrictEqual(buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs)), []);
});

test('a truncated manifest drops that row without taking the list down', () => {
  // A manifest killed mid-write must not make every other recording unlistable.
  const fs = fakeFs({
    dirs: { [REC]: [SESSION, 'other.wav'], [SDIR]: [] },
    files: {
      [j(SDIR, 'manifest.json')]: { content: '{"sessionId": "x"' },
      [j(REC, 'other.wav')]: { size: 20 }
    }
  });

  const list = buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs));

  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].filename, 'other.wav');
});

test('a directory that is not a session is ignored', () => {
  const fs = fakeFs({ dirs: { [REC]: ['scratch'], [j(REC, 'scratch')]: [] } });

  assert.deepStrictEqual(buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs)), []);
});

test('a session reports transcription and summary state from processed/', () => {
  const fs = sessionFs({
    [j(ODIR, 'merged_transcript.txt')]: { content: 'talk' },
    [j(ODIR, 'notes.md')]: { content: '# notes' }
  });

  const [row] = buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs));

  assert.strictEqual(row.transcribed, true);
  assert.strictEqual(row.summarised, true);
});

test('a processing error from the manifest is surfaced', () => {
  const fs = fakeFs({
    dirs: { [REC]: [SESSION], [SDIR]: [] },
    files: {
      [j(SDIR, 'manifest.json')]: {
        content: JSON.stringify({ sessionId: 'x', processing: { error: 'whisper died' } })
      }
    }
  });

  const [row] = buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs));
  assert.strictEqual(row.processingError, 'whisper died');
});

/* ── the poisoned-note badge (gotcha #12) ────────────────────── */

test('a poisoned note is flagged even though it looks summarised', () => {
  const fs = sessionFs({ [j(ODIR, 'notes.md')]: { content: "You've hit your session limit" } });

  const [row] = buildRecordingsList(
    { recordingsDir: REC, processedDir: PROC },
    deps(fs, { isPoisoned: (p) => p.endsWith('notes.md') })
  );

  assert.strictEqual(row.summarised, true, 'the file exists, so it reads as summarised');
  assert.strictEqual(row.summaryFailed, true, 'but it is a provider notice, not a summary');
});

test('isPoisoned is asked about the notes file specifically', () => {
  const asked = [];
  const fs = sessionFs({ [j(ODIR, 'notes.md')]: { content: '# real' } });

  buildRecordingsList(
    { recordingsDir: REC, processedDir: PROC },
    deps(fs, { isPoisoned: (p) => { asked.push(p); return false; } })
  );

  assert.deepStrictEqual(asked, [j(ODIR, 'notes.md')]);
});

test('canResummarise follows whether a transcript survives', () => {
  const yes = buildRecordingsList({ recordingsDir: REC, processedDir: PROC },
    deps(sessionFs(), { hasReusableTranscript: () => true }));
  const no = buildRecordingsList({ recordingsDir: REC, processedDir: PROC },
    deps(sessionFs(), { hasReusableTranscript: () => false }));

  assert.strictEqual(yes[0].canResummarise, true);
  assert.strictEqual(no[0].canResummarise, false, 'no transcript, no cheap repair');
});

/* ── ordering ────────────────────────────────────────────────── */

test('rows come back newest first', () => {
  const fs = fakeFs({
    dirs: { [REC]: ['old.wav', 'new.wav', 'mid.wav'] },
    files: {
      [j(REC, 'old.wav')]: { size: 1, birthtime: new Date('2026-01-01') },
      [j(REC, 'new.wav')]: { size: 1, birthtime: new Date('2026-08-01') },
      [j(REC, 'mid.wav')]: { size: 1, birthtime: new Date('2026-04-01') }
    }
  });

  const names = buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs))
    .map((r) => r.filename);

  assert.deepStrictEqual(names, ['new.wav', 'mid.wav', 'old.wav']);
});

test('sessions and loose wavs are sorted together, not grouped', () => {
  const fs = fakeFs({
    dirs: { [REC]: [SESSION, 'later.wav'], [SDIR]: [] },
    files: {
      [j(SDIR, 'manifest.json')]: { content: JSON.stringify({ sessionId: 'x' }) },
      [SDIR]: { birthtime: new Date('2026-01-01') },
      [j(REC, 'later.wav')]: { size: 1, birthtime: new Date('2026-08-01') }
    }
  });

  const names = buildRecordingsList({ recordingsDir: REC, processedDir: PROC }, deps(fs))
    .map((r) => r.filename);

  assert.deepStrictEqual(names, ['later.wav', SESSION]);
});
