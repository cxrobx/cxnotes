'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { formatTimestamp } = require('./transcriptMerger');

/**
 * Text read off captured slides, and how it reaches the summariser.
 *
 * OCR runs at PROCESSING time, next to transcription, not during the meeting —
 * reading text is not time-critical and Vision has no business competing with
 * a live capture for the CPU.
 *
 * The governing rule for everything below: slide text is CONTEXT, never
 * quotation. Vision reading a compressed screen capture mangles exactly the
 * things a meeting note most wants to be right — surnames, phone numbers,
 * dollar figures — so the prompt says so explicitly, and the keyframe itself
 * is kept beside the note so the real thing is one click away.
 */

/** Slides beyond this many are summarised as a count rather than listed. */
const MAX_SLIDES_IN_PROMPT = 40;

/** Characters of OCR text carried per slide. */
const MAX_CHARS_PER_SLIDE = 600;

/**
 * OCR every keyframe in a slides directory.
 *
 * @param {string} binaryPath - The sck-slide-capture helper
 * @param {string} slidesDir
 * @param {{execFileSync?: Function, existsSync?: Function}} [deps]
 * @returns {{slides: Array<{file: string, offsetMs: number, text: string, lines: string[]}>, error: string|null}}
 */
function runSlideOcr(binaryPath, slidesDir, deps = {}) {
  const _exec = deps.execFileSync || execFileSync;
  const _exists = deps.existsSync || fs.existsSync;

  if (!binaryPath || !_exists(binaryPath)) {
    return { slides: [], error: 'the sck-slide-capture helper was not found' };
  }
  if (!slidesDir || !_exists(slidesDir)) {
    return { slides: [], error: null };
  }

  try {
    const stdout = _exec(binaryPath, ['--ocr', slidesDir], {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout);
    const slides = Array.isArray(parsed.slides) ? parsed.slides : [];
    return { slides, error: null };
  } catch (err) {
    // OCR failing costs slide TEXT, not slides and not the note.
    return { slides: [], error: err.message };
  }
}

/**
 * Collapse OCR lines into a compact single-line summary of a slide.
 *
 * @param {{lines?: string[], text?: string}} slide
 * @param {number} [limit]
 * @returns {string}
 */
function condenseSlide(slide, limit = MAX_CHARS_PER_SLIDE) {
  const lines = Array.isArray(slide.lines) && slide.lines.length
    ? slide.lines
    : String(slide.text || '').split('\n');

  const cleaned = lines
    .map(line => String(line).trim())
    .filter(Boolean)
    // Single stray characters are OCR noise from window chrome, not content.
    .filter(line => line.length > 1);

  const joined = cleaned.join(' · ');
  if (joined.length <= limit) return joined;
  return `${joined.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Render slide text for the summariser prompt.
 *
 * Returns '' when there is nothing to say, so a session with no slides
 * produces a byte-identical prompt to one from before this feature — the same
 * contract `renderMarkersBlock` holds.
 *
 * @param {Array} slides - OCR results, in capture order
 * @param {{maxSlides?: number, maxCharsPerSlide?: number}} [options]
 * @returns {string}
 */
function renderSlidesBlock(slides, options = {}) {
  const list = Array.isArray(slides) ? slides.filter(s => s && Number.isFinite(s.offsetMs)) : [];
  if (!list.length) return '';

  const maxSlides = options.maxSlides || MAX_SLIDES_IN_PROMPT;
  const limit = options.maxCharsPerSlide || MAX_CHARS_PER_SLIDE;

  const ordered = [...list].sort((a, b) => a.offsetMs - b.offsetMs);
  const shown = ordered.slice(0, maxSlides);

  const rows = shown
    .map(slide => {
      const body = condenseSlide(slide, limit);
      return body ? `[${formatTimestamp(slide.offsetMs)}] ${body}` : '';
    })
    .filter(Boolean);

  if (!rows.length) return '';

  let block = '\n\nSlides shown on screen during the meeting, timestamped on the same clock as the transcript:\n\n';
  block += rows.join('\n');
  if (ordered.length > shown.length) {
    block += `\n(+${ordered.length - shown.length} further slides not listed)`;
  }
  block += '\n\nThis text was read off screenshots by OCR, so treat it as context rather than quotation — '
    + 'names, figures and punctuation may be misread. Use it to know WHAT was on screen and WHEN, and to '
    + 'align the discussion to the slide being shown. Where a slide and the transcript disagree, the '
    + 'transcript is the better source. Never present OCR text as a verbatim quote.\n';

  return block;
}

/**
 * Attach to each transcript entry the slide that was on screen at the time.
 *
 * A slide stays "in effect" from the moment it appears until the next one
 * does, which is what makes a keyframe timeline usable for alignment at all.
 *
 * @param {Array<{start: number}>} entries - Transcript entries with ms offsets
 * @param {Array<{offsetMs: number, file: string}>} slides
 * @returns {Array} The entries, each with a `slide` field (or null)
 */
function bindSlidesToTranscript(entries, slides) {
  const list = Array.isArray(slides)
    ? [...slides].filter(s => s && Number.isFinite(s.offsetMs)).sort((a, b) => a.offsetMs - b.offsetMs)
    : [];
  if (!list.length) {
    return (entries || []).map(entry => ({ ...entry, slide: null }));
  }

  let cursor = -1;
  return (entries || []).map(entry => {
    while (cursor + 1 < list.length && list[cursor + 1].offsetMs <= entry.start) {
      cursor += 1;
    }
    return { ...entry, slide: cursor >= 0 ? list[cursor] : null };
  });
}

/**
 * Write the OCR results beside the keyframes, as the durable record.
 *
 * @param {string} slidesDir
 * @param {Array} slides
 * @param {{writeFileSync?: Function}} [deps]
 * @returns {string|null} The path written, or null
 */
function writeSlidesJson(slidesDir, slides, deps = {}) {
  const _write = deps.writeFileSync || fs.writeFileSync;
  if (!slidesDir || !Array.isArray(slides) || !slides.length) return null;
  const target = path.join(slidesDir, 'slides.json');
  try {
    _write(target, JSON.stringify({ slides }, null, 2), 'utf-8');
    return target;
  } catch {
    return null;
  }
}

module.exports = {
  runSlideOcr,
  renderSlidesBlock,
  condenseSlide,
  bindSlidesToTranscript,
  writeSlidesJson,
  MAX_SLIDES_IN_PROMPT,
  MAX_CHARS_PER_SLIDE
};
