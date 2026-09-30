'use strict';

/**
 * Vault auto-filing for exported meeting notes.
 *
 * Pure, Electron-free module (mirrors meetingFilter.js / meetingTemplate.js).
 * Decides WHERE in the Obsidian vault an exported note belongs via a tiered
 * flow: deterministic keyword/people scoring → LLM pick from the top scored
 * candidates → Inbox escalation (some evidence, genuinely ambiguous) or the
 * catch-all Meetings folder (no evidence at all). classifyNote() never throws —
 * a null return tells the caller to fall back to the legacy flat export.
 *
 * All fs access goes through an injectable `fsImpl` so tests run against temp
 * directories without touching the real vault.
 */

const fs = require('fs');
const path = require('path');

const { getVaultProfile } = require('./vaultProfile');

// Where notes land when nothing matches at all, and where ambiguous notes are
// escalated for triage.
const CATCH_ALL_REL = 'Meetings';
const INBOX_REL = 'Inbox';

const DEFAULT_LLM_TIMEOUT_MS = 90000;
const DETERMINISTIC_MIN_SCORE = 4;
const DETERMINISTIC_MIN_MARGIN = 2;
const LLM_MIN_CONFIDENCE = 0.6;
const NAME_INDEX_MAX_FILES = 200;
const NAME_OVERLAP_CAP = 2;

/**
 * Built-in routing rules: none. Which keywords and people point at which
 * folder is true of one vault only, so the rules come from the
 * `vaultFilingRules` store setting (see mergeFilingRules) — each
 * `{ id, destination, keywords, people }`, matched whole-token so a short
 * alias can't fire inside a longer word. With no rules, filing falls to
 * auto-discovered folders, the LLM tier, the Inbox and the catch-all.
 */
const DEFAULT_FILING_RULES = Object.freeze([]);

// Tokens too generic to identify a destination. The vault profile's
// `filingStopwords` are added at call time — typically the user's own first
// name, which appears in every meeting AND most filenames and so carries no
// signal.
const TOKEN_STOPWORDS = new Set([
  'and', 'the', 'with', 'for', 'from', 'call', 'calls', 'meeting', 'meetings',
  'note', 'notes', 'sync', 'weekly', 'monthly', 'kickoff', 'debrief', 'client',
  'summary', 'follow', 'check'
]);

/**
 * Whole-token, case-insensitive matcher for a keyword or person name.
 * Multi-word keywords tolerate any whitespace between words.
 */
function keywordRegex(keyword) {
  const escaped = String(keyword)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

/**
 * Break free text into lowercase identifying tokens (≥3 chars, non-numeric,
 * stopwords removed). Used for the attendee-overlap signal.
 */
function tokenise(value) {
  const extraStopwords = getVaultProfile().filingStopwords;
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3
      && !TOKEN_STOPWORDS.has(t)
      && !extraStopwords.includes(t)
      && !/^\d+$/.test(t));
}

/**
 * Validate + normalise one rule; null when malformed.
 */
function normaliseRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (typeof rule.id !== 'string' || !rule.id.trim()) return null;
  if (typeof rule.destination !== 'string' || !rule.destination.trim()) return null;
  const cleanList = (v) => (Array.isArray(v)
    ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toLowerCase())
    : []);
  return {
    id: rule.id.trim(),
    destination: rule.destination.trim(),
    keywords: cleanList(rule.keywords),
    people: cleanList(rule.people)
  };
}

/**
 * Merge user overrides (electron-store `vaultFilingRules`) over the defaults.
 * Overrides win by `id`; unknown ids append; malformed entries are dropped.
 */
function mergeFilingRules(defaults, overrides) {
  const merged = new Map();
  for (const rule of Array.isArray(defaults) ? defaults : []) {
    const clean = normaliseRule(rule);
    if (clean) merged.set(clean.id, clean);
  }
  for (const rule of Array.isArray(overrides) ? overrides : []) {
    const clean = normaliseRule(rule);
    if (clean) merged.set(clean.id, clean);
  }
  return [...merged.values()];
}

/**
 * Build the candidate destination list: every rule destination plus any
 * auto-discovered `<parent>/<name>/<subdir>` folder not already covered by a
 * rule, for each of the vault profile's `discoveryGroups` — so onboarding a
 * new client is just "make the folder", zero code or settings change. Deduped
 * by vault-relative path. Never throws; a missing vault yields an empty list.
 *
 * `groups` defaults to the active profile's; each is
 * `{ parent, subdirs }` with `subdirs` in preferred order (the first that
 * exists wins).
 */
function discoverDestinations({ vaultDir, rules, fsImpl = fs, groups } = {}) {
  const destinations = [];
  const seenRel = new Set();

  const add = (id, rel, keywords, people, source) => {
    const norm = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!norm || seenRel.has(norm.toLowerCase())) return;
    seenRel.add(norm.toLowerCase());
    destinations.push({
      id,
      rel: norm,
      dir: path.join(vaultDir, norm),
      keywords: keywords || [],
      people: people || [],
      source
    });
  };

  try {
    for (const rule of Array.isArray(rules) ? rules : []) {
      add(rule.id, rule.destination, rule.keywords, rule.people, 'rule');
    }

    // Probe each group's subdirs per container, preferred order first.
    const discoveryGroups = Array.isArray(groups) ? groups : getVaultProfile().discoveryGroups;
    for (const group of discoveryGroups) {
      let entries = [];
      try {
        entries = fsImpl.readdirSync(path.join(vaultDir, group.parent), { withFileTypes: true });
      } catch (err) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory || !entry.isDirectory()) continue;
        for (const sub of group.subdirs) {
          const rel = `${group.parent}/${entry.name}/${sub}`;
          let exists = false;
          try {
            exists = fsImpl.existsSync(path.join(vaultDir, rel));
          } catch (err) {
            exists = false;
          }
          if (exists) {
            const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            add(`auto-${slug}`, rel, [entry.name.toLowerCase()], [], 'auto');
            break;
          }
        }
      }
    }
  } catch (err) {
    // Defensive: destination discovery must never take down an export.
  }

  return destinations;
}

/**
 * Index the tokens of existing `.md` filenames per destination (≤200 files).
 * This is the dynamic attendee-overlap signal: people who already have notes
 * filed in a folder pull new notes with the same names towards it.
 */
function buildNameIndex(destinations, fsImpl = fs) {
  const index = {};
  for (const dest of Array.isArray(destinations) ? destinations : []) {
    const tokens = new Set();
    try {
      const names = fsImpl.readdirSync(dest.dir)
        .filter((n) => n.toLowerCase().endsWith('.md'))
        .slice(0, NAME_INDEX_MAX_FILES);
      for (const name of names) {
        for (const token of tokenise(name.replace(/\.md$/i, ''))) tokens.add(token);
      }
    } catch (err) {
      // Missing/unreadable destination → empty index for it.
    }
    index[dest.id] = tokens;
  }
  return index;
}

/**
 * Score every destination against the note's signals. Weights:
 *   keyword in title +3 · keyword in participants/agenda +1.5 ·
 *   rule person in participants +2 · participant token in the destination's
 *   filename index +1 each, capped at +2 (attendee overlap is a scored signal,
 *   never a binary router — names recur across folders).
 * Returns descending by score, each entry carrying `matched` explanations.
 */
function scoreDestinations(signals = {}, destinations = [], nameIndex = {}) {
  const title = String(signals.title || '');
  const secondary = [signals.participants, signals.agenda]
    .filter(Boolean)
    .map(String)
    .join('\n');
  const participants = String(signals.participants || '');
  const participantTokens = tokenise(participants);

  const scored = destinations.map((dest) => {
    let score = 0;
    const matched = [];

    for (const keyword of dest.keywords || []) {
      const re = keywordRegex(keyword);
      if (re.test(title)) {
        score += 3;
        matched.push(`"${keyword}" in title`);
      } else if (secondary && re.test(secondary)) {
        score += 1.5;
        matched.push(`"${keyword}" in participants/agenda`);
      }
    }

    for (const person of dest.people || []) {
      if (participants && keywordRegex(person).test(participants)) {
        score += 2;
        matched.push(`person "${person}"`);
      }
    }

    const index = nameIndex[dest.id];
    if (index && index.size && participantTokens.length) {
      let overlap = 0;
      for (const token of participantTokens) {
        if (index.has(token)) overlap += 1;
      }
      if (overlap > 0) {
        score += Math.min(NAME_OVERLAP_CAP, overlap);
        matched.push(`${overlap} attendee name(s) in existing filenames`);
      }
    }

    return { ...dest, score, matched };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Deterministic tier: route without the LLM only when the top score is strong
 * AND clearly ahead of the runner-up.
 */
function decideDeterministic(scored) {
  const top = Array.isArray(scored) ? scored[0] : null;
  if (!top || top.score < DETERMINISTIC_MIN_SCORE) return null;
  const runnerUp = scored[1] ? scored[1].score : 0;
  if (top.score - runnerUp < DETERMINISTIC_MIN_MARGIN) return null;
  return top;
}

/**
 * Build the strict single-JSON-object prompt for the LLM tier.
 */
function buildFilingPrompt({ title, participants, agenda, notesExcerpt, candidates } = {}) {
  const lines = [
    'You are filing a finished meeting note into an Obsidian vault, organised by client/project.',
    'Choose the single best destination folder for this note from the candidates below,',
    'or "none" if it genuinely belongs to none of them (e.g. a brand-new person or product).',
    '',
    'Candidate destinations:'
  ];
  for (const c of candidates || []) {
    // Ground the model in each destination's domain: its configured keywords
    // and whatever the deterministic scorer already matched for this note.
    const hints = [];
    if (Array.isArray(c.keywords) && c.keywords.length) {
      hints.push(`topics: ${c.keywords.join(', ')}`);
    }
    if (Array.isArray(c.matched) && c.matched.length) {
      hints.push(`matched this note: ${c.matched.join('; ')}`);
    }
    lines.push(`- id: ${c.id} → ${c.rel}${hints.length ? ` (${hints.join(' | ')})` : ''}`);
  }
  lines.push('', 'Meeting note:');
  if (title) lines.push(`Title: ${title}`);
  if (participants) lines.push(`Participants: ${participants}`);
  if (agenda) lines.push(`Agenda: ${agenda}`);
  if (notesExcerpt) {
    lines.push('Excerpt:', '"""', String(notesExcerpt), '"""');
  }
  lines.push(
    '',
    'Respond with ONLY a single JSON object — no code fences, no commentary:',
    '{"destination": "<candidate id or none>", "confidence": <number 0 to 1>, "reason": "<one short sentence>"}'
  );
  return lines.join('\n');
}

/**
 * Find the first balanced top-level {...} block in free text (brace-aware,
 * string-aware) — LLMs love wrapping JSON in prose and fences.
 */
function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Defensively parse the LLM's filing response. Returns
 * { destinationId, confidence, reason } or null on anything off-contract.
 */
function parseFilingResponse(text, candidates) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const withoutFences = text.replace(/```[a-z]*\n?/gi, '');
  const jsonText = extractFirstJsonObject(withoutFences);
  if (!jsonText) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  if (typeof parsed.destination !== 'string') return null;
  const destinationId = parsed.destination.trim().toLowerCase();
  const validIds = new Set((candidates || []).map((c) => String(c.id).toLowerCase()));
  if (destinationId !== 'none' && !validIds.has(destinationId)) return null;

  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) return null;

  return {
    destinationId,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : ''
  };
}

/**
 * Resolve a promise against a timeout; the loser is swallowed (null result)
 * so a hung/failed LLM call can never reject into the caller.
 */
function raceWithTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      }
    );
  });
}

/**
 * Classify a note into a vault destination. The full tier flow:
 *   deterministic → LLM (top-5 candidates + "none") → Inbox escalation when
 *   there's some evidence but no confident pick → catch-all when there's none.
 * Never throws; returns null when classification can't run at all (missing
 * vault, internal error) — the caller falls back to the legacy flat export.
 *
 * @param {object} signals - { title, participants, agenda, notesExcerpt }
 * @param {object} opts - { vaultDir, rules, runLLM, fsImpl, timeoutMs }
 * @returns {Promise<object|null>} { destinationRel, destinationDir, method,
 *   confidence, reason, candidates } — method is one of
 *   'deterministic' | 'llm' | 'catch-all' | 'inbox'
 */
async function classifyNote(signals = {}, opts = {}) {
  try {
    const fsImpl = opts.fsImpl || fs;
    const vaultDir = opts.vaultDir;
    if (!vaultDir || !fsImpl.existsSync(vaultDir)) return null;

    const rules = mergeFilingRules(DEFAULT_FILING_RULES, opts.rules);
    const destinations = discoverDestinations({ vaultDir, rules, fsImpl });
    const nameIndex = buildNameIndex(destinations, fsImpl);
    const scored = scoreDestinations(signals, destinations, nameIndex);

    // Pop-up candidates: the plausible (score > 0) top three.
    const candidates = scored
      .filter((d) => d.score > 0)
      .slice(0, 3)
      .map((d) => ({ id: d.id, rel: d.rel, dir: d.dir, score: d.score }));

    const finish = (rel, method, confidence, reason) => ({
      destinationRel: rel,
      destinationDir: path.join(vaultDir, rel),
      method,
      confidence,
      reason,
      candidates
    });

    const deterministic = decideDeterministic(scored);
    if (deterministic) {
      return finish(
        deterministic.rel,
        'deterministic',
        1,
        `matched ${deterministic.matched.join(', ')}`
      );
    }

    // LLM tier: offer the top five scored candidates plus "none".
    const llmCandidates = scored.slice(0, 5);
    let parsed = null;
    if (typeof opts.runLLM === 'function' && llmCandidates.length) {
      const prompt = buildFilingPrompt({ ...signals, candidates: llmCandidates });
      const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_LLM_TIMEOUT_MS;
      const raw = await raceWithTimeout(opts.runLLM(prompt), timeoutMs);
      if (raw !== null && raw !== undefined) {
        parsed = parseFilingResponse(String(raw), llmCandidates);
      }
    }

    if (parsed && parsed.confidence >= LLM_MIN_CONFIDENCE) {
      if (parsed.destinationId === 'none') {
        return finish(CATCH_ALL_REL, 'catch-all', parsed.confidence, parsed.reason || 'no plausible destination');
      }
      const chosen = llmCandidates.find((d) => String(d.id).toLowerCase() === parsed.destinationId);
      if (chosen) {
        return finish(chosen.rel, 'llm', parsed.confidence, parsed.reason || 'LLM pick');
      }
    }

    // LLM unavailable / timed out / off-contract / unsure. Escalate only when
    // the scoring found SOME evidence — otherwise a genuinely new person or
    // product goes quietly to the catch-all instead of spamming prompts.
    if (scored.length && scored[0].score > 0) {
      return finish(INBOX_REL, 'inbox', 0, 'ambiguous — needs a human call');
    }
    return finish(CATCH_ALL_REL, 'catch-all', 0, 'no matching destination');
  } catch (err) {
    return null;
  }
}

/**
 * Collision-safe filename within a directory: `Name.md` → `Name 2.md` → …
 * (bounded; falls back to a timestamp suffix rather than looping forever).
 */
function resolveCollision(dir, filename, fsImpl = fs) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  if (!fsImpl.existsSync(path.join(dir, filename))) return filename;
  for (let i = 2; i <= 200; i++) {
    const candidate = `${base} ${i}${ext}`;
    if (!fsImpl.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${base} ${Date.now()}${ext}`;
}

module.exports = {
  DEFAULT_FILING_RULES,
  CATCH_ALL_REL,
  INBOX_REL,
  mergeFilingRules,
  discoverDestinations,
  buildNameIndex,
  scoreDestinations,
  decideDeterministic,
  buildFilingPrompt,
  parseFilingResponse,
  classifyNote,
  resolveCollision
};
