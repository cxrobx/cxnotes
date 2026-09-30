'use strict';

/**
 * Live meeting markers.
 *
 * A marker is a timestamp the user drops mid-recording ("they pushed back on
 * price") without breaking away from the call. Markers do three jobs:
 *   1. the menu-bar panel lists them so you can see what you flagged,
 *   2. they persist to `<sessionDir>/markers.json` as the recording runs, so a
 *      crash never loses them, and
 *   3. they are handed to the summariser as anchor points — the LLM is told
 *      these moments mattered, which is the whole reason for dropping them.
 *
 * Pure and Electron-free (fs is injected) so the module is unit-testable and
 * safe to require from anywhere.
 */

const path = require('path');

const MARKERS_FILENAME = 'markers.json';
const DEFAULT_LABEL = 'Marker';
const MAX_LABEL_LENGTH = 120;

/**
 * Format an elapsed-milliseconds offset as mm:ss, or h:mm:ss past an hour.
 * Negative or non-finite offsets clamp to 0 — a marker can never sit before
 * the recording it belongs to.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatOffset(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Normalise a user-supplied label: trim, collapse whitespace, cap the length,
 * and fall back to a generic label when empty (a bare keyboard-shortcut marker
 * carries no text, and "the moment" is still worth recording).
 *
 * @param {string} [label]
 * @returns {string}
 */
function normaliseLabel(label) {
  if (typeof label !== 'string') return DEFAULT_LABEL;
  const collapsed = label.replace(/\s+/g, ' ').trim();
  if (!collapsed) return DEFAULT_LABEL;
  return collapsed.length > MAX_LABEL_LENGTH
    ? `${collapsed.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

/**
 * Build a marker relative to a recording's start.
 *
 * @param {string} [label]
 * @param {object} opts
 * @param {number} opts.startTime - recorder start (epoch ms)
 * @param {number} [opts.now] - defaults to Date.now()
 * @returns {{atMs: number, at: string, offset: string, label: string}}
 */
function createMarker(label, { startTime, now = Date.now() } = {}) {
  const base = Number.isFinite(startTime) ? startTime : now;
  const atMs = Math.max(0, now - base);
  return {
    atMs,
    at: new Date(now).toISOString(),
    offset: formatOffset(atMs),
    label: normaliseLabel(label)
  };
}

/**
 * Append a marker, keeping the list ordered by offset. Returns a NEW array —
 * callers hold the list in module state, and mutation-in-place makes the
 * "did this change?" checks in the panel unreliable.
 *
 * @param {Array<object>} markers
 * @param {object} marker
 * @returns {Array<object>}
 */
function addMarker(markers, marker) {
  const next = Array.isArray(markers) ? markers.slice() : [];
  next.push(marker);
  next.sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
  return next;
}

/**
 * Defensively coerce anything read off disk into a marker list. A corrupt or
 * hand-edited markers.json must degrade to "no markers", never throw into the
 * processing pipeline.
 *
 * @param {string|Buffer} raw
 * @returns {Array<object>}
 */
function parseMarkers(raw) {
  try {
    const parsed = JSON.parse(String(raw));
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.markers;
    if (!Array.isArray(list)) return [];
    return list
      .filter((m) => m && typeof m === 'object')
      .map((m) => {
        const atMs = Number.isFinite(m.atMs) && m.atMs > 0 ? m.atMs : 0;
        return {
          atMs,
          at: typeof m.at === 'string' ? m.at : null,
          offset: typeof m.offset === 'string' ? m.offset : formatOffset(atMs),
          label: normaliseLabel(m.label)
        };
      })
      .sort((a, b) => a.atMs - b.atMs);
  } catch {
    return [];
  }
}

/**
 * Resolve the markers file for a session directory.
 *
 * @param {string} sessionDir
 * @returns {string}
 */
function markersPath(sessionDir) {
  return path.join(sessionDir, MARKERS_FILENAME);
}

/**
 * Write markers beside the session's audio. Best-effort by contract: the caller
 * is mid-recording and a failed write must never interrupt capture, so this
 * returns a boolean rather than throwing.
 *
 * @param {string} sessionDir
 * @param {Array<object>} markers
 * @param {object} [deps]
 * @param {object} [deps.fs] - injected for tests
 * @returns {boolean} true when written
 */
function writeMarkers(sessionDir, markers, { fs = require('fs') } = {}) {
  if (!sessionDir) return false;
  try {
    fs.writeFileSync(markersPath(sessionDir), JSON.stringify(markers || [], null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read markers back from a session directory. Missing file → empty list.
 *
 * @param {string} sessionDir
 * @param {object} [deps]
 * @param {object} [deps.fs]
 * @returns {Array<object>}
 */
function readMarkers(sessionDir, { fs = require('fs') } = {}) {
  if (!sessionDir) return [];
  try {
    return parseMarkers(fs.readFileSync(markersPath(sessionDir), 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Render the summariser prompt block. Empty list → empty string, so the prompt
 * is byte-identical to today's when nobody dropped a marker.
 *
 * @param {Array<object>} markers
 * @param {object} [opts]
 * @param {string} [opts.speakerLabel] - who dropped them ("Me")
 * @returns {string}
 */
function renderMarkersBlock(markers, { speakerLabel = 'the user' } = {}) {
  if (!Array.isArray(markers) || markers.length === 0) return '';
  const lines = markers
    .map((m) => `- ${m.offset || formatOffset(m.atMs)} — ${normaliseLabel(m.label)}`)
    .join('\n');
  return `\n\nLive markers dropped by "${speakerLabel}" while the meeting was happening (offsets from the recording start):\n${lines}\n
Each marker flags a moment the user judged important in real time. Make sure the transcript around every marker is reflected in the notes, and add a "## Flagged Moments" section listing each marker with what was actually said there. Do not invent content for a marker the transcript does not support — say the transcript is unclear instead.\n`;
}

/**
 * Render the markdown list used in the human-facing skeleton note.
 *
 * @param {Array<object>} markers
 * @returns {string}
 */
function renderMarkersMarkdown(markers) {
  if (!Array.isArray(markers) || markers.length === 0) return '';
  return markers
    .map((m) => `- **${m.offset || formatOffset(m.atMs)}** — ${normaliseLabel(m.label)}`)
    .join('\n');
}

module.exports = {
  MARKERS_FILENAME,
  DEFAULT_LABEL,
  MAX_LABEL_LENGTH,
  formatOffset,
  normaliseLabel,
  createMarker,
  addMarker,
  parseMarkers,
  markersPath,
  writeMarkers,
  readMarkers,
  renderMarkersBlock,
  renderMarkersMarkdown
};
