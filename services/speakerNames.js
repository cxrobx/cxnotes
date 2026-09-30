'use strict';

const { formatTimestamp } = require('./transcriptMerger');

/**
 * Real speaker names, read off the meeting window's own UI.
 *
 * Otter's speaker labels are not acoustic diarisation — they are the Zoom
 * display names of whoever the meeting was showing. That is why Otter's own
 * transcript of the 2026-08-20 seminar attributes a Fulton County staffer's
 * questions to a different participant for fifteen minutes: it is reading the
 * tile, not the voice. Reading the same tile locally gets the same names for
 * free, with no model, no upload and no per-minute cost.
 *
 * Interpretation lives HERE rather than in the capture helper, because this is
 * where the meeting roster is known and where the heuristics can be tested. The
 * helper samples and writes; nothing it records is a guess.
 *
 * These names are never written INTO the transcript. A confidently wrong name
 * is worse than an honest "Remote": it survives into the note, into the vault,
 * and into whatever gets sent to the other person. They are offered to the
 * summariser as a timeline of who was ON SCREEN, alongside the caveat that the
 * transcript wins any disagreement.
 */

/** UI chrome that is shaped like a name and is not one. */
const UI_STOPWORDS = new Set([
  'mute', 'unmute', 'muted', 'start video', 'stop video', 'participants', 'chat',
  'share screen', 'stop share', 'sharing', 'record', 'recording', 'reactions',
  'apps', 'whiteboards', 'more', 'leave', 'leave meeting', 'end', 'end meeting',
  'view', 'speaker', 'gallery', 'gallery view', 'speaker view', 'you', 'host',
  'co-host', 'cohost', 'meeting', 'zoom', 'zoom meeting', 'google meet', 'teams',
  'microsoft teams', 'present now', 'presenting', 'raise hand', 'lower hand',
  'turn on captions', 'turn off captions', 'captions', 'leave call', 'details',
  'info', 'people', 'activities', 'security', 'invite', 'settings', 'more options',
  'screen sharing', 'stop sharing', 'audio settings', 'video settings', 'breakout rooms',
  'polls', 'live transcript', 'closed caption', 'enter full screen', 'exit full screen',
  'unmute me', 'ask to unmute', 'waiting room', 'admit', 'admit all', 'copy link',
  'add people', 'search', 'home', 'back', 'next', 'done', 'cancel', 'save', 'open'
]);

/** Particles that may appear lowercase inside a real name. */
const NAME_PARTICLES = new Set(['van', 'von', 'der', 'de', 'del', 'della', 'da', 'di', 'du', 'la', 'le', 'bin', 'al', 'mc', 'mac', 'ter', 'ten']);

/** A sample must hold a name this long to become a timeline entry. */
const MIN_SEGMENT_MS = 3000;

/**
 * Parse the helper's `screen_text.csv`.
 *
 * @param {string} csvText
 * @returns {Array<{offsetMs: number, mode: string, lines: string[]}>}
 */
function parseScreenTextCsv(csvText) {
  const rows = [];
  for (const raw of String(csvText || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('offset_ms,')) continue;
    const match = line.match(/^(\d+),([^,]*),"(.*)"$/);
    if (!match) continue;
    rows.push({
      offsetMs: parseInt(match[1], 10),
      mode: match[2],
      lines: match[3].split('|').map(s => s.trim()).filter(Boolean)
    });
  }
  return rows;
}

/**
 * Strip the decoration meeting UIs hang off a display name.
 *
 * @param {string} text
 * @returns {string}
 */
function normaliseName(text) {
  return String(text || '')
    // "Chris Robinson (Host)", "Mary McCarthy (she/her)"
    .replace(/\s*\([^)]*\)\s*$/, '')
    // "Cassius F. Butts, Author" — the role after a comma is not the name
    .replace(/,\s*[^,]{2,40}$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this string shaped like a person's name?
 *
 * Deliberately strict. The cost of a false positive is a wrong name in a
 * meeting note; the cost of a false negative is a name the model does not get,
 * which the transcript may well supply anyway.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeName(text) {
  const name = normaliseName(text);
  if (!name || name.length < 3 || name.length > 40) return false;
  if (UI_STOPWORDS.has(name.toLowerCase())) return false;
  if (/\d/.test(name)) return false;
  if (/[@/\\<>|#*_=+{}[\]]/.test(name)) return false;
  if (/[.!?]$/.test(name)) return false;

  const words = name.split(' ');
  if (words.length < 1 || words.length > 4) return false;

  // A single word is only a name when it is clearly a proper noun, and even
  // then it is weak — "Recording" and "Marketing" pass every other test.
  if (words.length === 1) return false;

  return words.every(word => {
    const bare = word.replace(/[.'’-]/g, '');
    if (!bare) return false;
    if (NAME_PARTICLES.has(word.toLowerCase())) return true;
    if (!/^[A-Z]/.test(word)) return false;
    // Reject SHOUTED words — slide headings, not names.
    return !(bare.length > 2 && bare === bare.toUpperCase());
  });
}

/**
 * Split a user-supplied participants string into names.
 *
 * @param {string} participants
 * @returns {string[]}
 */
function parseRoster(participants) {
  return String(participants || '')
    .split(/[,;\n]/)
    .map(name => normaliseName(name))
    .filter(name => name.length >= 3 && name.split(' ').length <= 5);
}

/**
 * Find the roster entry a captured label refers to.
 *
 * OCR drops and mangles characters, so an exact match is too brittle: match on
 * the surname plus a first-initial agreement, which is what actually survives.
 *
 * @param {string} candidate
 * @param {string[]} roster
 * @returns {string|null} The roster's spelling, which is the trusted one
 */
function matchRoster(candidate, roster) {
  const name = normaliseName(candidate).toLowerCase();
  if (!name) return null;

  for (const entry of roster || []) {
    const known = entry.toLowerCase();
    if (known === name) return entry;

    const knownWords = known.split(' ').filter(Boolean);
    const nameWords = name.split(' ').filter(Boolean);
    if (!knownWords.length || !nameWords.length) continue;

    const knownSurname = knownWords[knownWords.length - 1];
    const nameSurname = nameWords[nameWords.length - 1];
    const shorter = knownSurname.length <= nameSurname.length ? knownSurname : nameSurname;
    const longer = shorter === knownSurname ? nameSurname : knownSurname;

    // A truncated or over-read surname ("Butt" for "Butts") is the ordinary OCR
    // failure, so a prefix counts — but only from four characters, below which
    // surnames collide with each other far too easily, and only when the first
    // initials also agree.
    if (shorter.length >= 4 && longer.startsWith(shorter)) {
      if (knownWords[0][0] === nameWords[0][0]) return entry;
    }
  }
  return null;
}

/**
 * Pick the most likely on-screen speaker name from one sample.
 *
 * @param {string[]} lines
 * @param {string[]} roster
 * @returns {{name: string, source: string}|null}
 */
function bestNameInSample(lines, roster = []) {
  const candidates = (lines || []).map(normaliseName).filter(looksLikeName);
  if (!candidates.length) return null;

  // A roster hit is worth more than any positional guess.
  for (const candidate of candidates) {
    const matched = matchRoster(candidate, roster);
    if (matched) return { name: matched, source: 'roster' };
  }

  // Otherwise the first name-shaped label. Meeting UIs put the active
  // speaker's name at the bottom-left of the main tile, and OCR reading order
  // is top-to-bottom, so this is a guess and is labelled as one.
  return { name: candidates[0], source: 'screen' };
}

/**
 * Turn samples into contiguous "who was on screen" ranges.
 *
 * @param {Array<{offsetMs: number, lines: string[]}>} samples
 * @param {{roster?: string[], minSegmentMs?: number, endMs?: number}} [options]
 * @returns {Array<{fromMs: number, toMs: number, name: string, source: string}>}
 */
function buildSpeakerTimeline(samples, options = {}) {
  const roster = options.roster || [];
  const minSegment = options.minSegmentMs ?? MIN_SEGMENT_MS;
  const ordered = [...(samples || [])]
    .filter(s => s && Number.isFinite(s.offsetMs))
    .sort((a, b) => a.offsetMs - b.offsetMs);

  const segments = [];
  for (const sample of ordered) {
    const best = bestNameInSample(sample.lines, roster);
    if (!best) continue;
    const last = segments[segments.length - 1];
    if (last && last.name === best.name) {
      last.toMs = sample.offsetMs;
      // A roster confirmation anywhere in the run upgrades the whole run.
      if (best.source === 'roster') last.source = 'roster';
      continue;
    }
    if (last) last.toMs = Math.max(last.toMs, sample.offsetMs);
    segments.push({ fromMs: sample.offsetMs, toMs: sample.offsetMs, name: best.name, source: best.source });
  }

  if (segments.length && Number.isFinite(options.endMs)) {
    segments[segments.length - 1].toMs = Math.max(segments[segments.length - 1].toMs, options.endMs);
  }

  // A name that flickered for one sample is OCR noise, not a speaker turn.
  return segments.filter(seg => seg.toMs - seg.fromMs >= minSegment);
}

/**
 * Render the speaker timeline for the summariser prompt.
 *
 * Empty string when there is nothing to say, so a session without it produces
 * a prompt identical to one from before the feature.
 *
 * @param {Array} timeline
 * @param {{systemLabel?: string, maxSegments?: number}} [options]
 * @returns {string}
 */
function renderSpeakerBlock(timeline, options = {}) {
  const list = Array.isArray(timeline) ? timeline : [];
  if (!list.length) return '';

  const systemLabel = options.systemLabel || 'Remote';
  const maxSegments = options.maxSegments || 60;
  const shown = list.slice(0, maxSegments);

  let block = `\n\nNames shown on screen by the meeting app while "${systemLabel}" was speaking, `
    + 'timestamped on the same clock as the transcript:\n\n';
  block += shown
    .map(seg => `[${formatTimestamp(seg.fromMs)} - ${formatTimestamp(seg.toMs)}] ${seg.name}`
      + (seg.source === 'roster' ? '' : ' (read from screen, unconfirmed)'))
    .join('\n');
  if (list.length > shown.length) {
    block += `\n(+${list.length - shown.length} further name changes not listed)`;
  }
  block += `\n\nThese are the meeting app's own participant labels, read by OCR. They indicate who was being `
    + `SHOWN as the active speaker, which is usually but not always who was talking. Use them to replace `
    + `"${systemLabel}" with real names where the timing and the content agree. Where they conflict with the `
    + `transcript, or where you are unsure, keep "${systemLabel}" rather than guess a name — a wrongly `
    + `attributed quote is worse than an unattributed one.\n`;

  return block;
}

module.exports = {
  parseScreenTextCsv,
  normaliseName,
  looksLikeName,
  parseRoster,
  matchRoster,
  bestNameInSample,
  buildSpeakerTimeline,
  renderSpeakerBlock,
  UI_STOPWORDS,
  MIN_SEGMENT_MS
};
