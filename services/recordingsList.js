'use strict';

const path = require('path');

/**
 * What the Recordings pane and the menu-bar panel are shown.
 *
 * Two shapes live side by side under `recordings/`: a dual-track capture is a
 * `*_session` directory with a manifest, and a single-track capture is a loose
 * `.wav`. Both become one row, and each row has to answer whether it has been
 * transcribed, whether it has been summarised, whether that summary is real,
 * and whether it can be cheaply repaired.
 *
 * Pure apart from an injected `fs`, because the interesting part is the
 * bookkeeping rather than the reading — in particular `summaryFailed`, which is
 * what stops a note poisoned by a provider refusal from sitting in the list
 * looking finished (gotcha #12).
 */

/** A dual-track capture is a directory whose name ends in this. */
const SESSION_SUFFIX = '_session';

/** Zeroes, for when the storage scan itself fails. */
const EMPTY_STORAGE_SUMMARY = Object.freeze({
  totalSize: 0,
  totalSizeFormatted: '0 B',
  audioSize: 0,
  audioSizeFormatted: '0 B',
  generatedSize: 0,
  generatedSizeFormatted: '0 B',
  recordingsCount: 0,
  transcriptsCount: 0,
  notesCount: 0
});

/**
 * Rename the storage figures for the renderer.
 *
 * `fileManager` counts in the singular (`recordingCount`); the settings UI
 * reads the plural. Kept as an explicit mapping rather than a spread so the
 * rename is visible and cannot drift silently.
 */
function toStorageSummary(stats) {
  return {
    totalSize: stats.totalSize,
    totalSizeFormatted: stats.totalSizeFormatted,
    audioSize: stats.audioSize,
    audioSizeFormatted: stats.audioSizeFormatted,
    generatedSize: stats.generatedSize,
    generatedSizeFormatted: stats.generatedSizeFormatted,
    recordingsCount: stats.recordingCount,
    transcriptsCount: stats.transcriptCount,
    notesCount: stats.notesCount
  };
}

/** Total bytes of whichever audio tracks a session actually produced. */
function sessionAudioBytes(sessionDir, fsImpl) {
  let total = 0;
  for (const track of ['system.wav', 'mic.wav']) {
    const file = path.join(sessionDir, track);
    if (!fsImpl.existsSync(file)) continue;
    try {
      total += fsImpl.statSync(file).size;
    } catch {
      // A track that vanished mid-scan contributes nothing rather than
      // aborting the whole listing.
    }
  }
  return total;
}

/** One row for a dual-track session, or null if it has no readable manifest. */
function describeSession(entry, sessionDir, stats, ctx) {
  const { fsImpl, processedDir, isPoisoned, hasReusableTranscript } = ctx;

  const manifestPath = path.join(sessionDir, 'manifest.json');
  if (!fsImpl.existsSync(manifestPath)) return null;

  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf-8'));
  } catch {
    // A truncated manifest (killed mid-write) must not take the list down with
    // it — the other recordings are still perfectly listable.
    return null;
  }

  const outDir = path.join(processedDir, `${manifest.sessionId}${SESSION_SUFFIX}`);
  const notesPath = path.join(outDir, 'notes.md');

  return {
    filename: entry,
    filepath: sessionDir,
    size: sessionAudioBytes(sessionDir, fsImpl),
    created: stats.birthtime,
    modified: stats.mtime,
    isDualTrack: true,
    transcribed: fsImpl.existsSync(path.join(outDir, 'merged_transcript.txt')),
    summarised: fsImpl.existsSync(notesPath),
    processingError: (manifest.processing && manifest.processing.error) || null,
    // Looks summarised, isn't: a provider limit or auth notice written as if it
    // were the summary. Surfaced so the row can offer a re-summarise.
    summaryFailed: isPoisoned(notesPath),
    // Recorded, transcribed and summarised — from one side of the conversation.
    // Nothing failed, so no other flag on this row catches it (gotcha #15).
    systemSilent: Boolean(manifest.tracks && manifest.tracks.system && manifest.tracks.system.silent),
    // The cheap repair is only possible when a transcript survives.
    canResummarise: Boolean(hasReusableTranscript(sessionDir)),
    manifest
  };
}

/** One row for a loose single-track wav. */
function describeLooseRecording(entry, filepath, stats, ctx) {
  const { fsImpl, processedDir } = ctx;
  const base = path.basename(entry, '.wav');

  return {
    filename: entry,
    filepath,
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    isDualTrack: false,
    transcribed: fsImpl.existsSync(path.join(processedDir, `${base}_transcript.txt`)),
    summarised: fsImpl.existsSync(path.join(processedDir, `${base}_notes.md`))
  };
}

/**
 * Build the recordings list, newest first.
 *
 * @param {{recordingsDir: string, processedDir: string}} dirs
 * @param {{fsImpl: object, isPoisoned: Function, hasReusableTranscript: Function}} deps
 * @returns {Array<object>} empty when there is no recordings directory yet
 */
function buildRecordingsList({ recordingsDir, processedDir }, deps) {
  const { fsImpl } = deps;
  if (!fsImpl.existsSync(recordingsDir)) return [];

  const ctx = { ...deps, processedDir };
  const rows = [];

  for (const entry of fsImpl.readdirSync(recordingsDir)) {
    const fullPath = path.join(recordingsDir, entry);

    let stats;
    try {
      stats = fsImpl.statSync(fullPath);
    } catch {
      continue; // deleted between readdir and stat
    }

    if (stats.isDirectory()) {
      if (!entry.endsWith(SESSION_SUFFIX)) continue;
      const row = describeSession(entry, fullPath, stats, ctx);
      if (row) rows.push(row);
      continue;
    }

    if (entry.endsWith('.wav')) {
      rows.push(describeLooseRecording(entry, fullPath, stats, ctx));
    }
  }

  return rows.sort((a, b) => b.created - a.created);
}

module.exports = {
  SESSION_SUFFIX,
  EMPTY_STORAGE_SUMMARY,
  toStorageSummary,
  buildRecordingsList
};
