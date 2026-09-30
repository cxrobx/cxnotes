'use strict';

/**
 * Disk housekeeping for the output directory.
 *
 * Three jobs, and only three: lay out the working directories, report what is
 * using space, and expire old audio. Listing and deleting individual recordings
 * is `main.js`'s business — it answers `files:list` and `files:delete` from the
 * session manifests, which carry far more than a filename.
 *
 * The retention rule is deliberately narrow. Audio is the only thing that is
 * ever removed automatically, because audio is the only thing that is both
 * large and reproducible-into-something-smaller. Transcripts, notes, manifests
 * and markers are small and are the actual product of a meeting, so nothing
 * here may touch them — see the extension guard in `expiredAudioUnder`.
 */

const fs = require('fs');
const path = require('path');

/** Everything the app expects to exist under the output directory. */
const WORKING_DIRECTORIES = ['recordings', 'processed', 'temp'];

/** Days of audio kept when the caller does not say otherwise. */
const DEFAULT_RETENTION_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The one extension retention is allowed to delete. */
const AUDIO_EXTENSION = '.wav';

/** A recording session is a directory whose name carries this suffix. */
const SESSION_SUFFIX = '_session';

const BYTE_UNITS = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

/**
 * Yield every file beneath `dir`, depth first.
 *
 * A generator rather than a visitor callback so callers can accumulate with
 * plain `for...of` and stay readable. Unreadable directories are skipped with a
 * warning instead of thrown: housekeeping runs unattended on a timer, and one
 * permission-denied folder must not abort the sweep for everything else.
 *
 * @param {string} dir
 * @returns {Generator<string>} absolute paths of files
 */
function* walkFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Could not read ${dir}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Size in bytes, or null if the file cannot be read right now. */
function sizeOf(filepath) {
  try {
    return fs.statSync(filepath).size;
  } catch {
    return null;
  }
}

/**
 * Deliberately case-sensitive.
 *
 * The recorder only ever writes lowercase `.wav`, so matching `.WAV` too would
 * widen the set of files retention deletes without widening the set it created
 * — and the only files that would newly qualify are ones the user put there
 * themselves. Whatever this function admits, `cleanupOldRecordings` eventually
 * unlinks; that is reason enough to keep it strict.
 */
function isAudio(filepath) {
  return path.extname(filepath) === AUDIO_EXTENSION;
}

/**
 * Create the working directories under `baseDir` if they are not already there.
 *
 * Idempotent, and safe to call on every launch and after the output directory
 * is changed in settings.
 *
 * @param {string} baseDir
 */
function ensureDirectoryStructure(baseDir) {
  for (const name of WORKING_DIRECTORIES) {
    const dir = path.join(baseDir, name);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
}

/**
 * Every audio file under `recordingsDir` older than the cutoff.
 *
 * Split out from the deletion itself so the decision of *what* expires is one
 * readable predicate: it is audio, and it is older than the cutoff. Nothing
 * else can end up in the returned list.
 *
 * @param {string} recordingsDir
 * @param {number} cutoffMs - epoch ms; files modified before this have expired
 * @returns {string[]} absolute paths
 */
function expiredAudioUnder(recordingsDir, cutoffMs) {
  const expired = [];

  for (const filepath of walkFiles(recordingsDir)) {
    if (!isAudio(filepath)) continue;

    let modifiedMs;
    try {
      modifiedMs = fs.statSync(filepath).mtimeMs;
    } catch (err) {
      console.error(`Could not stat ${filepath}: ${err.message}`);
      continue;
    }

    if (modifiedMs < cutoffMs) expired.push(filepath);
  }

  return expired;
}

/**
 * Delete audio older than the retention period.
 *
 * Only `.wav` files, and only beneath `recordings/`. Transcripts, notes,
 * manifests and markers are never removed, and `processed/` is never walked at
 * all.
 *
 * @param {string} baseDir
 * @param {number} [retentionDays=7]
 * @returns {string[]} deleted files, relative to `recordings/`
 */
function cleanupOldRecordings(baseDir, retentionDays = DEFAULT_RETENTION_DAYS) {
  const recordingsDir = path.join(baseDir, 'recordings');
  if (!fs.existsSync(recordingsDir)) return [];

  const cutoffMs = Date.now() - retentionDays * MS_PER_DAY;
  const deleted = [];

  for (const filepath of expiredAudioUnder(recordingsDir, cutoffMs)) {
    try {
      fs.unlinkSync(filepath);
      deleted.push(path.relative(recordingsDir, filepath));
      console.log(`Deleted old recording: ${filepath}`);
    } catch (err) {
      console.error(`Could not delete ${filepath}: ${err.message}`);
    }
  }

  return deleted;
}

/**
 * Running totals for a storage report.
 *
 * Kept as a small object with explicit `add` calls rather than a pile of
 * `let` counters, so the two very different traversals below cannot disagree
 * about which bucket a byte belongs in.
 */
function newTally() {
  return {
    totalSize: 0,
    audioSize: 0,
    generatedSize: 0,
    recordingCount: 0,
    transcriptCount: 0,
    notesCount: 0
  };
}

/** Audio bytes: counted towards the total and towards audio. */
function tallyAudio(tally, bytes) {
  tally.totalSize += bytes;
  tally.audioSize += bytes;
}

/** Bytes inside a session that are not audio: counted only towards the total. */
function tallySessionExtra(tally, bytes) {
  tally.totalSize += bytes;
}

/** Generated output: counted towards the total and towards generated. */
function tallyGenerated(tally, bytes) {
  tally.totalSize += bytes;
  tally.generatedSize += bytes;
}

function isTranscriptName(filename) {
  return filename.endsWith('_transcript.txt') || filename === 'merged_transcript.txt';
}

function isNotesName(filename) {
  return filename.endsWith('_notes.md') || filename === 'notes.md';
}

/**
 * Walk `recordings/`.
 *
 * Two shapes live side by side here: a single-track capture is a loose `.wav`,
 * and a dual-track capture is a `*_session` directory holding both tracks plus
 * its manifest. Both count as one recording.
 *
 * Note the deliberate asymmetry at the top level — a loose file that is not a
 * `.wav` is skipped entirely rather than sized. Anything the app itself writes
 * lands either in a session directory or in `processed/`, so a stray file at
 * this level is not ours to report on.
 */
function tallyRecordings(tally, recordingsDir) {
  let entries;
  try {
    entries = fs.readdirSync(recordingsDir, { withFileTypes: true });
  } catch (err) {
    console.error(`Could not read ${recordingsDir}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    const full = path.join(recordingsDir, entry.name);

    if (entry.isFile()) {
      if (!isAudio(entry.name)) continue;
      const bytes = sizeOf(full);
      if (bytes === null) continue;
      tallyAudio(tally, bytes);
      tally.recordingCount += 1;
      continue;
    }

    if (!entry.isDirectory()) continue;

    if (entry.name.endsWith(SESSION_SUFFIX)) tally.recordingCount += 1;

    for (const filepath of walkFiles(full)) {
      const bytes = sizeOf(filepath);
      if (bytes === null) continue;
      if (isAudio(filepath)) tallyAudio(tally, bytes);
      else tallySessionExtra(tally, bytes);
    }
  }
}

/** Walk `processed/` — everything in here is generated output. */
function tallyProcessed(tally, processedDir) {
  for (const filepath of walkFiles(processedDir)) {
    const bytes = sizeOf(filepath);
    if (bytes === null) continue;

    tallyGenerated(tally, bytes);

    const filename = path.basename(filepath);
    if (isTranscriptName(filename)) tally.transcriptCount += 1;
    else if (isNotesName(filename)) tally.notesCount += 1;
  }
}

/**
 * Disk usage and file counts for the settings window's storage pane.
 *
 * @param {string} baseDir
 * @returns {{
 *   totalSize: number, totalSizeFormatted: string,
 *   audioSize: number, audioSizeFormatted: string,
 *   generatedSize: number, generatedSizeFormatted: string,
 *   recordingCount: number, transcriptCount: number, notesCount: number
 * }}
 */
function getStorageStats(baseDir) {
  const tally = newTally();

  const recordingsDir = path.join(baseDir, 'recordings');
  if (fs.existsSync(recordingsDir)) tallyRecordings(tally, recordingsDir);

  const processedDir = path.join(baseDir, 'processed');
  if (fs.existsSync(processedDir)) tallyProcessed(tally, processedDir);

  // Each size is followed by its formatted twin. Spelled out rather than
  // spread, because the key order is observable through JSON.stringify and
  // there is no reason for a refactor to change it.
  return {
    totalSize: tally.totalSize,
    totalSizeFormatted: formatBytes(tally.totalSize),
    audioSize: tally.audioSize,
    audioSizeFormatted: formatBytes(tally.audioSize),
    generatedSize: tally.generatedSize,
    generatedSizeFormatted: formatBytes(tally.generatedSize),
    recordingCount: tally.recordingCount,
    transcriptCount: tally.transcriptCount,
    notesCount: tally.notesCount
  };
}

/**
 * Render a byte count for display, to two decimal places.
 *
 * The unit index is clamped to the largest unit we name, so an absurd input
 * reads as a large number of terabytes rather than "1.2 undefined".
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!bytes) return `0 ${BYTE_UNITS[0]}`;

  const magnitude = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = Math.min(magnitude, BYTE_UNITS.length - 1);
  const scaled = bytes / Math.pow(1024, unit);

  return `${Math.round(scaled * 100) / 100} ${BYTE_UNITS[unit]}`;
}

module.exports = {
  ensureDirectoryStructure,
  cleanupOldRecordings,
  getStorageStats
};
