'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Saying on the note itself that half the conversation is missing.
 *
 * This is the last line of defence and the only one that survives everything
 * else. The menu-bar warning is gone, the notification has been dismissed, and
 * what remains is a markdown file sitting in a client folder that reads like a
 * complete record of a meeting. All three lost meetings ended exactly there —
 * transcribed, summarised, badged, filed, and wrong.
 *
 * Written deterministically rather than asked of the summariser, because an LLM
 * handed a one-sided transcript has no way to know a second side was ever meant
 * to exist. It will write a confident, coherent summary of a monologue, and
 * that is precisely the artefact this exists to contradict.
 *
 * Pure apart from an injected `fs`, matching `services/markers.js`.
 */

/**
 * Marker proving a warning has already been written.
 *
 * Both `processSession` and `resummariseSession` run this path, and a full
 * reprocess runs it again — without a marker, a note re-summarised three times
 * carries three identical warnings.
 */
const SILENT_TRACK_MARKER = '<!-- cxnotes:silent-track -->';

/**
 * Should this session's note carry a warning, and what should it say?
 *
 * @param {object} manifest
 * @returns {string|null} The block to prepend, or null if the capture was fine
 */
function buildSilentTrackWarning(manifest) {
  const tracks = (manifest && manifest.tracks) || {};
  if (!tracks.system || !tracks.system.silent) return null;

  // A dual-track session where BOTH tracks are silent recorded nothing at all;
  // there is no "only your side" to claim, and saying so would be its own
  // small lie in a note that is already worthless.
  const micAlsoSilent = Boolean(tracks.mic && tracks.mic.silent);
  const micLabel = (tracks.mic && tracks.mic.label) || 'your';

  const body = micAlsoSilent
    ? [
      '> [!warning] No audio was captured',
      '> Neither the system audio nor the microphone recorded anything. Any',
      '> summary below is derived from an empty transcript and should be',
      '> discarded.'
    ]
    : [
      '> [!warning] System audio was not captured',
      `> Only ${micLabel}'s side of this meeting is in this transcript. Everything`,
      '> the other participants said is missing — treat any summary below as a',
      '> record of one half of the conversation.'
    ];

  return [SILENT_TRACK_MARKER, ...body, '', ''].join('\n');
}

/**
 * Prepend the warning to a note, once.
 *
 * Never throws. A note that exists without its warning is far better than no
 * note, so every failure leaves the file exactly as it was.
 *
 * @param {string} notesPath
 * @param {object} manifest
 * @param {{fsImpl?: object}} [deps]
 * @returns {boolean} whether a warning was written this call
 */
function prependSilentTrackWarning(notesPath, manifest, { fsImpl = fs } = {}) {
  try {
    const warning = buildSilentTrackWarning(manifest);
    if (!warning) return false;
    if (!fsImpl.existsSync(notesPath)) return false;

    const existing = fsImpl.readFileSync(notesPath, 'utf-8');
    if (existing.includes(SILENT_TRACK_MARKER)) return false;

    fsImpl.writeFileSync(notesPath, warning + existing, 'utf-8');
    console.warn(`Note flagged: system track was silent (${path.basename(notesPath)})`);
    return true;
  } catch (err) {
    console.warn(`Could not flag a silent-track note: ${err.message}`);
    return false;
  }
}

/** Marker proving the own-mic notice has already been written. */
const OWN_MIC_MARKER = '<!-- cxnotes:own-mic -->';

/**
 * Say on the note when the mic side did NOT come from the companion transcript.
 *
 * Deterministic for the same reason as the silent-track warning: the note is
 * the one artefact that survives, and a reader should be able to tell a
 * transcript Meeting Copilot heard live from one CXNotes rebuilt afterwards.
 *
 * @param {object} manifest
 * @returns {string|null}
 */
function buildOwnMicNotice(manifest) {
  const check = manifest && manifest.processing && manifest.processing.transcription
    && manifest.processing.transcription.companionCheck;
  if (!check || check.decision === 'companion') return null;
  const micLabel = (manifest.tracks && manifest.tracks.mic && manifest.tracks.mic.label) || 'your';
  const body = check.decision === 'companion+own-mic'
    ? [
      `> [!info] ${micLabel}'s side came from CXNotes' own microphone recording`,
      `> Meeting Copilot's live transcript was missing it (${check.reason}), so`,
      `> CXNotes transcribed its own mic track and lined it up with the other`,
      `> side (offset ${check.offsetSec}s). Timing between speakers may be off by a`,
      '> second or two.'
    ]
    : [
      "> [!info] Transcribed from CXNotes' own recording",
      `> Meeting Copilot's live transcript was not used (${check.reason}).`
    ];
  return [OWN_MIC_MARKER, ...body, '', ''].join('\n');
}

/**
 * Prepend the own-mic notice to a note, once. Never throws.
 */
function prependOwnMicNotice(notesPath, manifest, { fsImpl = fs } = {}) {
  try {
    const notice = buildOwnMicNotice(manifest);
    if (!notice) return false;
    if (!fsImpl.existsSync(notesPath)) return false;
    const existing = fsImpl.readFileSync(notesPath, 'utf-8');
    if (existing.includes(OWN_MIC_MARKER)) return false;
    fsImpl.writeFileSync(notesPath, notice + existing, 'utf-8');
    console.log(`Note flagged: mic side rebuilt from CXNotes' own recording (${path.basename(notesPath)})`);
    return true;
  } catch (err) {
    console.warn(`Could not add the own-mic notice: ${err.message}`);
    return false;
  }
}

module.exports = {
  SILENT_TRACK_MARKER,
  OWN_MIC_MARKER,
  buildSilentTrackWarning,
  prependSilentTrackWarning,
  buildOwnMicNotice,
  prependOwnMicNotice
};
