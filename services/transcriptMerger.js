const fs = require('fs');
const path = require('path');

/**
 * Parse a whisper.cpp CSV transcript file
 *
 * Whisper CSV format: start,end,text
 * Times are in milliseconds.
 *
 * @param {string} csvPath - Path to CSV transcript file
 * @returns {Array<{start: number, end: number, text: string}>} Parsed entries
 */
function parseCsvTranscript(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV transcript not found: ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip header row
    if (i === 0 && (line.toLowerCase().startsWith('start') || line.toLowerCase().startsWith('"start'))) {
      continue;
    }

    // Skip empty lines
    if (!line) continue;

    // Parse CSV line: split on first two commas, then strip surrounding quotes from text
    const firstComma = line.indexOf(',');
    const secondComma = line.indexOf(',', firstComma + 1);
    if (firstComma === -1 || secondComma === -1) continue;

    const startStr = line.slice(0, firstComma).trim();
    const endStr = line.slice(firstComma + 1, secondComma).trim();
    let text = line.slice(secondComma + 1).trim();

    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end)) continue;

    // Strip surrounding quotes if present
    if (text.startsWith('"') && text.endsWith('"')) {
      text = text.slice(1, -1);
    }
    text = text.trim();

    if (text) {
      entries.push({ start, end, text });
    }
  }

  return entries;
}

/**
 * Format milliseconds to [HH:MM:SS] timestamp
 *
 * @param {number} ms - Time in milliseconds
 * @returns {string} Formatted timestamp
 */
function formatTimestamp(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/* ── mic-bleed suppression ───────────────────────────────────────
 * An open speaker (or an AirPods mic sitting next to one) puts the REMOTE
 * side's audio into the mic track too, so whisper transcribes the same words
 * twice and the merge emits every line under both labels. That is not a
 * cosmetic duplicate: the summariser reads it as Chris having SAID the remote
 * side's words, which is why a bled session files with no commitments
 * attributed to him — the two tracks contradict each other and it trusts
 * neither. Seen end-to-end on 2026-08-20 (Fulton County seminar, AirPods).
 *
 * The mic copy is the spurious one: system audio is captured ahead of the
 * output device and never contains Chris's own voice
 * (`excludesCurrentProcessAudio`), so an overlapping near-identical pair can
 * only be the mic hearing the room.
 */

/** Interval slop when pairing a mic entry against a system entry, in ms. */
const BLEED_TIME_TOLERANCE_MS = 1500;

/** Dice coefficient above which two utterances are "the same words". */
const BLEED_SIMILARITY_THRESHOLD = 0.75;

/** Below this many tokens, fuzzy matching is unsafe — require exact equality. */
const BLEED_SHORT_UTTERANCE_TOKENS = 4;

/**
 * Fraction of the mic track that must match strictly before the relaxed pass is
 * allowed to run. A clean session sits near zero; the bled 2026-08-20 seminar
 * sat at 0.78, so the margin either side of this is wide.
 */
const BLEED_SESSION_THRESHOLD = 0.3;

/** Containment above which a mic fragment is the system track, once bled. */
const BLEED_CONTAINMENT_THRESHOLD = 0.8;

/** Half-width of the neighbourhood used to decide "the bleed is dense here". */
const BLEED_REGION_WINDOW_MS = 30_000;

/** Strict matches needed inside that neighbourhood to call it a bleed region. */
const BLEED_REGION_MIN_MATCHES = 2;

/**
 * Reduce an utterance to comparable tokens: lowercase, punctuation stripped,
 * whitespace collapsed. Whisper transcribes the two tracks independently, so
 * the same speech lands with different filler and punctuation on each.
 *
 * @param {string} text
 * @returns {string[]} Lowercase word tokens
 */
function tokeniseForBleed(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Dice coefficient over the two token SETS: 2|A∩B| / (|A|+|B|).
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} 0..1, where 1 is the same set of words
 */
function tokenSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) {
    if (setB.has(token)) shared += 1;
  }
  return (2 * shared) / (setA.size + setB.size);
}

/**
 * Do two [start, end] intervals overlap, allowing a slop either side?
 *
 * @param {{start: number, end: number}} a
 * @param {{start: number, end: number}} b
 * @param {number} toleranceMs
 * @returns {boolean}
 */
function intervalsNear(a, b, toleranceMs) {
  return a.start - toleranceMs <= b.end && b.start - toleranceMs <= a.end;
}

/**
 * Are these two utterances the same speech heard on both tracks?
 *
 * Short utterances ("Yes.", "Okay") match each other far too easily, and two
 * people genuinely saying "yes" at once is ordinary — so anything under
 * BLEED_SHORT_UTTERANCE_TOKENS must match exactly, not merely closely.
 *
 * @param {string[]} micTokens
 * @param {string[]} systemTokens
 * @returns {boolean}
 */
function isSameUtterance(micTokens, systemTokens) {
  const shortest = Math.min(micTokens.length, systemTokens.length);
  if (shortest < BLEED_SHORT_UTTERANCE_TOKENS) {
    return micTokens.join(' ') === systemTokens.join(' ');
  }
  return tokenSimilarity(micTokens, systemTokens) >= BLEED_SIMILARITY_THRESHOLD;
}

/**
 * Fraction of the mic entry's vocabulary that also appears in the system audio
 * playing at the same moment. Deliberately ASYMMETRIC: whisper segments the two
 * tracks independently, so a bled mic line is routinely a fragment of a longer
 * system line ("Yeah, you may be better at it." inside "Yeah, you may be better
 * at it, but don't underestimate the power of teamwork"). Symmetric similarity
 * scores that pair at 0.67 and lets it through; containment scores it 1.0.
 *
 * @param {string[]} micTokens
 * @param {Set<string>} windowTokens - Every token the system track carried nearby
 * @returns {number} 0..1
 */
function tokenContainment(micTokens, windowTokens) {
  if (!micTokens.length || !windowTokens.size) return 0;
  const unique = new Set(micTokens);
  let shared = 0;
  for (const token of unique) {
    if (windowTokens.has(token)) shared += 1;
  }
  return shared / unique.size;
}

/**
 * Index of system entries, queried by the mic interval they overlap.
 *
 * @param {Array<{start: number, end: number, text: string}>} systemEntries
 * @returns {(micEntry: {start: number, end: number}) => {tokenSets: string[][], windowTokens: Set<string>, texts: string[]}}
 */
function makeSystemWindowLookup(systemEntries) {
  const tokenSets = systemEntries.map(item => tokeniseForBleed(item.text));
  let cursor = 0;

  return function windowFor(micEntry) {
    while (
      cursor < systemEntries.length &&
      systemEntries[cursor].end < micEntry.start - BLEED_TIME_TOLERANCE_MS
    ) {
      cursor += 1;
    }

    const sets = [];
    const texts = [];
    const windowTokens = new Set();
    for (let i = cursor; i < systemEntries.length; i++) {
      const candidate = systemEntries[i];
      if (candidate.start - BLEED_TIME_TOLERANCE_MS > micEntry.end) break;
      if (!intervalsNear(micEntry, candidate, BLEED_TIME_TOLERANCE_MS)) continue;
      sets.push(tokenSets[i]);
      texts.push(tokenSets[i].join(' '));
      for (const token of tokenSets[i]) windowTokens.add(token);
    }
    return { tokenSets: sets, windowTokens, texts };
  };
}

/**
 * Is this moment inside a stretch where the mic is demonstrably echoing the
 * room? Built from the STRICT pass's own matches, so it is evidence rather than
 * assumption — and it is what separates the two ways a mic entry can sit on top
 * of system audio. On 2026-08-20 the mic carried a genuine second meeting from
 * 19:13 to 32:44: real speech, overlapping the seminar, but with no strict
 * matches anywhere near it. That gap is the signal that protects it.
 *
 * @param {Array<{start: number, end: number}>} matched - Strictly-matched entries, sorted
 * @param {{start: number, end: number}} entry
 * @returns {boolean}
 */
function insideBleedRegion(matched, entry) {
  let nearby = 0;
  for (const item of matched) {
    if (item.end < entry.start - BLEED_REGION_WINDOW_MS) continue;
    if (item.start > entry.end + BLEED_REGION_WINDOW_MS) break;
    nearby += 1;
    if (nearby >= BLEED_REGION_MIN_MATCHES) return true;
  }
  return false;
}

/**
 * Drop mic entries that are the system track bleeding into the microphone.
 *
 * Two passes, because the safe rule and the effective rule are different rules.
 *
 * 1. STRICT — pair a mic entry against a single overlapping system entry and
 *    require near-identical wording. Safe enough to run on every session, but
 *    it only catches the lines whisper happened to segment the same way on
 *    both tracks. On the 2026-08-20 seminar that was 412 of 528 mic entries.
 * 2. RELAXED — only if the strict pass proved the track is compromised
 *    (BLEED_SESSION_THRESHOLD of the mic track matched), fall back to
 *    containment against everything the system played at that moment, which
 *    catches the differently-segmented remainder.
 *
 * Gating the relaxed pass on the strict pass's own verdict is what keeps a
 * CLEAN session safe: containment alone would eventually eat a genuine short
 * reply built from common words, but on a clean track the relaxed pass never
 * runs at all. The system track is never dropped — when both carry the same
 * words, the mic is the copy.
 *
 * @param {Array<{start: number, end: number, text: string, speaker: string}>} entries
 * @param {string} micLabel - Label identifying mic-track entries
 * @param {string} systemLabel - Label identifying system-track entries
 * @returns {{entries: Array, suppressed: number, strictMatches: number, micTotal: number, bleedRatio: number, relaxed: boolean}}
 */
function suppressMicBleed(entries, micLabel, systemLabel) {
  const idle = { entries, suppressed: 0, strictMatches: 0, micTotal: 0, bleedRatio: 0, relaxed: false };
  if (micLabel === systemLabel) return idle;

  const systemEntries = entries.filter(entry => entry.speaker === systemLabel);
  const micEntries = entries.filter(entry => entry.speaker === micLabel);
  if (!systemEntries.length || !micEntries.length) {
    return { ...idle, micTotal: micEntries.length };
  }

  // Pass 1 — strict pairing.
  const strictWindow = makeSystemWindowLookup(systemEntries);
  const bled = new Set();
  for (const entry of micEntries) {
    const { tokenSets } = strictWindow(entry);
    const micTokens = tokeniseForBleed(entry.text);
    if (tokenSets.some(systemTokens => isSameUtterance(micTokens, systemTokens))) {
      bled.add(entry);
    }
  }

  const strictMatches = bled.size;
  const bleedRatio = strictMatches / micEntries.length;
  const relaxed = bleedRatio >= BLEED_SESSION_THRESHOLD;

  // Pass 2 — only once the track is known to be compromised.
  if (relaxed) {
    const matched = micEntries.filter(entry => bled.has(entry));
    const relaxedWindow = makeSystemWindowLookup(systemEntries);
    for (const entry of micEntries) {
      if (bled.has(entry)) {
        relaxedWindow(entry); // keep the cursor advancing in lockstep
        continue;
      }
      const { windowTokens } = relaxedWindow(entry);
      const micTokens = tokeniseForBleed(entry.text);
      if (!micTokens.length) continue;

      if (tokenContainment(micTokens, windowTokens) >= BLEED_CONTAINMENT_THRESHOLD) {
        bled.add(entry);
        continue;
      }

      // A fragment this small carries no evidence of its own — "Alright, Jamie"
      // against the system's "All right, Jamie" scores 0.5 on containment
      // purely because whisper rendered one word differently on each track.
      // Inside a dense bleed region the surrounding evidence decides it; in a
      // gap (a genuine second conversation) nothing here fires.
      if (
        micTokens.length < BLEED_SHORT_UTTERANCE_TOKENS &&
        insideBleedRegion(matched, entry)
      ) {
        bled.add(entry);
      }
    }
  }

  return {
    entries: entries.filter(entry => !bled.has(entry)),
    suppressed: bled.size,
    strictMatches,
    micTotal: micEntries.length,
    bleedRatio,
    relaxed
  };
}

/**
 * Merge two speaker transcripts into a single speaker-labeled transcript
 *
 * @param {string|null} systemCsvPath - Path to system audio CSV transcript (or null)
 * @param {string|null} micCsvPath - Path to mic audio CSV transcript (or null)
 * @param {string} outputPath - Path to write merged transcript
 * @param {string} [systemLabel='Remote'] - Label for system audio speaker
 * @param {string} [micLabel='Me'] - Label for mic audio speaker
 * @param {{suppressBleed?: boolean}} [options] - `suppressBleed` (default true)
 *   drops mic entries that are the system track bleeding into the microphone
 * @returns {string} Path to merged transcript file
 */
function mergeTranscripts(systemCsvPath, micCsvPath, outputPath, systemLabel = 'Remote', micLabel = 'Me', options = {}) {
  const { suppressBleed = true } = options;
  const entries = [];

  // Parse system transcript
  if (systemCsvPath && fs.existsSync(systemCsvPath)) {
    const systemEntries = parseCsvTranscript(systemCsvPath);
    for (const entry of systemEntries) {
      entries.push({ ...entry, speaker: systemLabel });
    }
  }

  // Parse mic transcript
  if (micCsvPath && fs.existsSync(micCsvPath)) {
    const micEntries = parseCsvTranscript(micCsvPath);
    for (const entry of micEntries) {
      entries.push({ ...entry, speaker: micLabel });
    }
  }

  // Both tracks empty — surface as an error so callers don't feed a placeholder to the LLM
  if (entries.length === 0) {
    throw new Error('Transcript merge produced no entries — both tracks were empty or unparseable');
  }

  // Sort by start timestamp
  entries.sort((a, b) => a.start - b.start);

  // Drop the mic's copy of the remote side before anything reads the merge
  let merged = entries;
  if (suppressBleed) {
    const result = suppressMicBleed(entries, micLabel, systemLabel);
    merged = result.entries;
    if (result.suppressed > 0) {
      const mode = result.relaxed ? 'compromised track' : 'isolated matches';
      console.log(
        `Mic bleed suppressed (${mode}): ${result.suppressed} of ${result.micTotal} ` +
        `"${micLabel}" entries were the "${systemLabel}" track heard on the mic ` +
        `(strict pass matched ${(result.bleedRatio * 100).toFixed(0)}%)`
      );
    }
  }

  // Format output
  const lines = merged.map(entry => {
    const startStr = formatTimestamp(entry.start);
    const endStr = formatTimestamp(entry.end);
    return `[${startStr} - ${endStr}] ${entry.speaker}: ${entry.text}`;
  });

  const output = lines.join('\n') + '\n';
  fs.writeFileSync(outputPath, output, 'utf-8');

  console.log(`Merged transcript written: ${outputPath} (${merged.length} entries)`);
  return outputPath;
}

module.exports = {
  parseCsvTranscript,
  mergeTranscripts,
  formatTimestamp,
  suppressMicBleed,
  tokeniseForBleed,
  tokenSimilarity,
  BLEED_TIME_TOLERANCE_MS,
  BLEED_SIMILARITY_THRESHOLD,
  BLEED_SHORT_UTTERANCE_TOKENS,
  BLEED_SESSION_THRESHOLD,
  BLEED_CONTAINMENT_THRESHOLD,
  BLEED_REGION_WINDOW_MS,
  BLEED_REGION_MIN_MATCHES
};
