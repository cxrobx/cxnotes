'use strict';

/**
 * Does Meeting Copilot's shared transcript actually carry the mic side?
 *
 * Companion mode trusted the shared transcript whenever it had any segments.
 * On 2026-09-25 Meeting Copilot's mic died 28 s into a call, its transcript held
 * only the other side, and CXNotes filed that — while its own mic.wav held every
 * word Chris said. This module decides, from the audio CXNotes recorded itself,
 * whether the companion's mic side can be trusted, and if not, where CXNotes'
 * own mic transcription sits on the companion's clock.
 *
 * Two clocks meet here:
 *   - companion seconds: relative to Meeting Copilot's session start
 *   - own seconds:       offsets inside CXNotes' mic.wav
 * `companion = own + offsetSec`. The prior for the offset comes from the two
 * start times; it is then CHECKED by fit (own speech turns should fall in the
 * gaps between the other side's turns), and a poor or ambiguous fit is refused
 * rather than guessed.
 *
 * Pure apart from `speechRegionsFromWav`, which reads a file.
 */

const fs = require('fs');

const SAMPLE_RATE = 16000;
const HEADER_BYTES = 44;
const FRAME_SEC = 0.03;

/** Own speech this long or longer counts as a turn for the fit. */
const OWN_TURN_MIN_SEC = 3;
/** Companion meeting lines this long or longer count as a turn for the fit. */
const COMPANION_TURN_MIN_SEC = 4;
/** A companion stretch this long with no mic line is a gap worth checking. */
const GAP_MIN_SEC = 60;
/** Own speech inside such a gap that makes the companion's mic side untrustworthy. */
const GAP_SPEECH_MIN_SEC = 10;
/** Fit acceptance: own turns may overlap the other side's turns at most this much. */
const MAX_OVERLAP_RATIO = 0.3;
/** Fit acceptance (wide scans): best must beat the typical offset by this factor. */
const SHARPNESS = 0.6;
/** Enough own speech to fit against at all. */
const MIN_FIT_TURNS = 4;
const MIN_FIT_SECONDS = 20;

/**
 * Speech regions in a 16 kHz mono PCM16 WAV, from frame energy.
 *
 * Threshold is relative to the track's own noise floor (20th percentile of
 * frame level + 12 dB), so a quiet built-in mic and a hot headset both work.
 * Regions closer than 0.8 s merge; a region is capped at 25 s so a long
 * monologue still yields several turns.
 *
 * @param {string} wavPath
 * @param {{fsImpl?: object}} [deps]
 * @returns {Array<{start:number,end:number}>|null} seconds; null if unreadable
 */
function speechRegionsFromWav(wavPath, { fsImpl = fs } = {}) {
  // Streamed in chunks: a two-hour track is ~230 MB, and this runs in the
  // Electron main process.
  const frameSamples = Math.round(FRAME_SEC * SAMPLE_RATE);
  const frameBytes = frameSamples * 2;
  const chunkBytes = frameBytes * 2000; // ~60 s per read
  let fd;
  try {
    fd = fsImpl.openSync(wavPath, 'r');
    const size = fsImpl.fstatSync(fd).size;
    if (size <= HEADER_BYTES) return [];
    const frames = Math.floor((size - HEADER_BYTES) / frameBytes);
    const db = new Float64Array(frames);
    const buf = Buffer.alloc(chunkBytes);
    let f = 0;
    let offset = HEADER_BYTES;
    while (f < frames) {
      const want = Math.min(chunkBytes, (frames - f) * frameBytes);
      const read = fsImpl.readSync(fd, buf, 0, want, offset);
      if (read <= 0) break;
      offset += read;
      for (let base = 0; base + frameBytes <= read && f < frames; base += frameBytes, f++) {
        let sum = 0;
        for (let i = 0; i < frameSamples; i++) {
          const v = buf.readInt16LE(base + i * 2) / 32768;
          sum += v * v;
        }
        db[f] = 20 * Math.log10(Math.sqrt(sum / frameSamples) + 1e-9);
      }
    }
    return regionsFromFrameLevels(db.subarray(0, f), FRAME_SEC);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** The region-building half of `speechRegionsFromWav`, separated for tests. */
function regionsFromFrameLevels(db, frameSec = FRAME_SEC) {
  if (db.length === 0) return [];
  const sorted = Array.from(db).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  const threshold = floor + 12;
  const raw = [];
  for (let i = 0; i < db.length;) {
    if (db[i] > threshold) {
      let j = i;
      while (j < db.length && db[j] > threshold) j++;
      raw.push([i, j]);
      i = j;
    } else {
      i++;
    }
  }
  const merged = [];
  for (const [a, b] of raw) {
    const last = merged[merged.length - 1];
    if (last && (a - last[1]) * frameSec < 0.8 && (b - last[0]) * frameSec < 25) last[1] = b;
    else merged.push([a, b]);
  }
  return merged
    .filter(([a, b]) => (b - a) * frameSec >= 0.3)
    .map(([a, b]) => ({ start: a * frameSec, end: b * frameSec }));
}

function overlapSeconds(turns, others, offset) {
  let total = 0;
  for (const t of turns) {
    const s = t.start + offset;
    const e = t.end + offset;
    for (const o of others) {
      const d = Math.min(e, o.end) - Math.max(s, o.start);
      if (d > 0) total += d;
    }
  }
  return total;
}

/**
 * Find where own speech sits on the companion clock, and say whether to trust it.
 *
 * @param {object} p
 * @param {Array<{start,end}>} p.ownRegions - own mic speech, own seconds
 * @param {Array<{start,end}>} p.companionMeetingTurns - other side's lines, companion seconds
 * @param {number} p.minOffset - scan range (companion = own + offset)
 * @param {number} p.maxOffset
 * @param {boolean} [p.priorExact] - the range is a narrow window around a known prior
 * @param {number} [p.step=0.5]
 * @returns {{accepted:boolean, reason:string, offsetSec:number|null, overlapSec?:number, ownTurnSec?:number, ratio?:number, sharpness?:number}}
 */
function estimateOffset({ ownRegions, companionMeetingTurns, minOffset, maxOffset, priorExact = false, step = 0.5 }) {
  const own = ownRegions.filter((r) => r.end - r.start > OWN_TURN_MIN_SEC);
  const theirs = companionMeetingTurns.filter((r) => r.end - r.start >= COMPANION_TURN_MIN_SEC);
  const ownTurnSec = own.reduce((n, r) => n + (r.end - r.start), 0);
  if (own.length < MIN_FIT_TURNS || ownTurnSec < MIN_FIT_SECONDS) {
    return { accepted: false, reason: 'too little own speech to fit', offsetSec: null, ownTurnSec };
  }
  if (theirs.length < MIN_FIT_TURNS) {
    return { accepted: false, reason: 'too few companion turns to fit', offsetSec: null, ownTurnSec };
  }

  const scores = [];
  for (let o = minOffset; o <= maxOffset + 1e-9; o += step) {
    scores.push({ offset: Math.round(o * 1000) / 1000, overlap: overlapSeconds(own, theirs, o) });
  }
  let best = scores[0];
  for (const s of scores) if (s.overlap < best.overlap) best = s;
  const ratio = best.overlap / ownTurnSec;
  const result = {
    offsetSec: best.offset,
    overlapSec: Math.round(best.overlap * 10) / 10,
    ownTurnSec: Math.round(ownTurnSec * 10) / 10,
    ratio: Math.round(ratio * 1000) / 1000,
  };

  if (ratio > MAX_OVERLAP_RATIO) {
    return { ...result, accepted: false, reason: `poor fit: ${Math.round(ratio * 100)}% of own speech lands on the other side's turns` };
  }
  if (!priorExact) {
    const overlaps = scores.map((s) => s.overlap).sort((a, b) => a - b);
    const median = overlaps[Math.floor(overlaps.length / 2)];
    const sharpness = median > 0 ? best.overlap / median : 1;
    result.sharpness = Math.round(sharpness * 1000) / 1000;
    if (sharpness > SHARPNESS) {
      return { ...result, accepted: false, reason: 'ambiguous fit: the best offset is barely better than a typical one' };
    }
    const rival = scores
      .filter((s) => Math.abs(s.offset - best.offset) > 5)
      .reduce((m, s) => Math.min(m, s.overlap), Infinity);
    if (rival <= best.overlap * 1.1 + 1) {
      return { ...result, accepted: false, reason: 'ambiguous fit: another offset fits as well' };
    }
  }
  return { ...result, accepted: true, reason: 'fit' };
}

/**
 * Own speech the companion never transcribed: stretches of at least
 * `GAP_MIN_SEC` on the companion clock with no mic line, and how much own
 * speech falls inside them.
 *
 * @returns {{uncoveredSpeechSec:number, gaps:Array<{start,end,speechSec}>}}
 */
function findMicGaps({ companionMicLines, ownRegions, offsetSec, spanEnd }) {
  const lines = [...companionMicLines].sort((a, b) => a.start - b.start);
  const own = ownRegions.map((r) => ({ start: r.start + offsetSec, end: r.end + offsetSec }));
  const end = Math.max(spanEnd || 0, ...own.map((r) => r.end), ...lines.map((l) => l.end));
  const holes = [];
  let cursor = Math.min(0, ...own.map((r) => r.start));
  for (const l of lines) {
    if (l.start > cursor) holes.push({ start: cursor, end: l.start });
    cursor = Math.max(cursor, l.end);
  }
  if (end > cursor) holes.push({ start: cursor, end });

  const gaps = [];
  let uncoveredSpeechSec = 0;
  for (const h of holes) {
    if (h.end - h.start < GAP_MIN_SEC) continue;
    let speechSec = 0;
    for (const r of own) {
      const d = Math.min(r.end, h.end) - Math.max(r.start, h.start);
      if (d > 0) speechSec += d;
    }
    if (speechSec >= GAP_SPEECH_MIN_SEC) {
      gaps.push({ start: h.start, end: h.end, speechSec: Math.round(speechSec * 10) / 10 });
      uncoveredSpeechSec += speechSec;
    }
  }
  return { uncoveredSpeechSec: Math.round(uncoveredSpeechSec * 10) / 10, gaps };
}

/**
 * Companion segments (`{source, timestamp, duration}`, companion seconds) as intervals.
 */
function segmentIntervals(segments, source) {
  return segments
    .filter((s) => s.source === source)
    .map((s) => ({ start: s.timestamp, end: s.timestamp + (s.duration || 10) }));
}

/**
 * Where on the companion clock sample 0 of mic.wav sits, and how sure that is.
 *
 * @param {object} p
 * @param {string} [p.companionStartedAt] - ISO, Meeting Copilot's session start
 * @param {string} p.recordingStartTime - ISO, manifest.startTime
 * @param {object} [p.micTrim] - manifest.tracks.mic.silenceTrimmed
 * @returns {{minOffset:number, maxOffset:number, priorExact:boolean, prior:number|null}}
 */
function offsetWindow({ companionStartedAt, recordingStartTime, micTrim }) {
  const companionMs = Date.parse(companionStartedAt || '');
  const recMs = Date.parse(recordingStartTime || '');
  if (!Number.isFinite(companionMs) || !Number.isFinite(recMs)) {
    return { minOffset: -600, maxOffset: 600, priorExact: false, prior: null };
  }
  const base = (recMs - companionMs) / 1000;
  const trimmed = micTrim && micTrim.trimmed;
  if (!trimmed || micTrim.edge === 'trailing') {
    const prior = base + (trimmed ? micTrim.leadingSec || 0 : 0);
    return { minOffset: prior - 5, maxOffset: prior + 5, priorExact: true, prior };
  }
  // A session trimmed before 2026-09-25: some unknown share of savedBytes came
  // off the head, so the head trim is anywhere from none of it to all of it.
  const savedSec = (micTrim.savedBytes || 0) / (SAMPLE_RATE * 2);
  return { minOffset: base - 5, maxOffset: base + savedSec + 5, priorExact: false, prior: null };
}

/**
 * Decide how to build the transcript from a companion's segments.
 *
 * @param {object} p
 * @param {Array} p.segments - companion segments
 * @param {boolean} p.micSilent - own mic.wav holds nothing (measureWavPeak)
 * @param {Array<{start,end}>|null} p.ownRegions - own mic speech (own seconds)
 * @param {object} p.window - from `offsetWindow`
 * @returns {{decision:'companion'|'companion+own-mic'|'own', reason:string, offsetSec:number|null, fit?:object, companionMicLines:number, ownSpeechSec:number, uncoveredSpeechSec?:number}}
 */
function decideCompanionPath({ segments, micSilent, ownRegions, window }) {
  const micLines = segmentIntervals(segments, 'mic');
  const meetingTurns = segmentIntervals(segments, 'meeting');
  const ownSpeechSec = (ownRegions || []).reduce((n, r) => n + (r.end - r.start), 0);
  const base = { companionMicLines: micLines.length, ownSpeechSec: Math.round(ownSpeechSec * 10) / 10, offsetSec: null };

  if (micSilent || !ownRegions) {
    return { ...base, decision: 'companion', reason: micSilent ? 'own mic.wav is silent' : 'own mic.wav unreadable' };
  }
  if (ownSpeechSec < GAP_SPEECH_MIN_SEC) {
    return { ...base, decision: 'companion', reason: 'little own speech to compare' };
  }

  const fit = estimateOffset({ ownRegions, companionMeetingTurns: meetingTurns, ...window });

  if (micLines.length === 0) {
    return fit.accepted
      ? { ...base, decision: 'companion+own-mic', reason: 'companion has no mic lines; own mic.wav has speech', offsetSec: fit.offsetSec, fit }
      : { ...base, decision: 'own', reason: `companion has no mic lines, and its clock could not be matched (${fit.reason})`, fit };
  }

  if (!fit.accepted) {
    // Without a clock we cannot look for gaps; judge on totals instead.
    const companionMicSec = micLines.reduce((n, l) => n + (l.end - l.start), 0);
    if (companionMicSec < ownSpeechSec * 0.5) {
      return { ...base, decision: 'own', reason: `companion mic side covers ${Math.round(companionMicSec)}s of ~${Math.round(ownSpeechSec)}s own speech, and its clock could not be matched (${fit.reason})`, fit };
    }
    return { ...base, decision: 'companion', reason: `companion mic side looks complete by total; clock not matched (${fit.reason})`, fit };
  }

  const spanEnd = Math.max(0, ...segments.map((s) => s.timestamp + (s.duration || 10)));
  const { uncoveredSpeechSec, gaps } = findMicGaps({ companionMicLines: micLines, ownRegions, offsetSec: fit.offsetSec, spanEnd });
  if (gaps.length > 0) {
    return { ...base, decision: 'companion+own-mic', reason: `companion mic side has ${gaps.length} gap(s) holding ${uncoveredSpeechSec}s of own speech`, offsetSec: fit.offsetSec, fit, uncoveredSpeechSec };
  }
  return { ...base, decision: 'companion', reason: 'companion mic side covers own speech', offsetSec: fit.offsetSec, fit, uncoveredSpeechSec };
}

module.exports = {
  speechRegionsFromWav,
  regionsFromFrameLevels,
  estimateOffset,
  findMicGaps,
  offsetWindow,
  decideCompanionPath,
  segmentIntervals,
  GAP_MIN_SEC,
  GAP_SPEECH_MIN_SEC,
  MAX_OVERLAP_RATIO,
};
