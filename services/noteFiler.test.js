'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_FILING_RULES: BUILT_IN_FILING_RULES,
  CATCH_ALL_REL,
  INBOX_REL,
  mergeFilingRules,
  discoverDestinations,
  buildNameIndex,
  scoreDestinations,
  decideDeterministic,
  buildFilingPrompt,
  parseFilingResponse,
  classifyNote: classifyNoteWithRules,
  resolveCollision
} = require('./noteFiler');
const { setVaultProfile } = require('./vaultProfile');
const { FIXTURE_PROFILE, FIXTURE_FILING_RULES } = require('./vaultProfile.fixture');

// The app ships no rules and no profile; these tests run as a configured
// install would, with the fixture's rules standing in for the stored ones.
setVaultProfile(FIXTURE_PROFILE);
const DEFAULT_FILING_RULES = FIXTURE_FILING_RULES;
const classifyNote = (signals, opts = {}) => classifyNoteWithRules(signals, {
  ...opts,
  rules: mergeFilingRules(FIXTURE_FILING_RULES, opts.rules)
});

/**
 * Build a throwaway vault mirroring the real CX layout.
 */
function makeVault() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4c-vault-'));
  const dirs = [
    'Inbox',
    'Meetings',
    'Projects/CXVentures/Clients/QRS/Meetings',
    'Projects/CXVentures/Clients/ACM/Meetings',
    'Projects/CXVentures/Clients/IBX/Meetings',
    'Projects/CXVentures/Clients/NXT/Meetings',
    'Projects/CXVentures/Ventures/Artist Advisory/Calls',
    'Projects/CXVentures/Ventures/BuildersBuddy/Calls',
    'Areas/Music/Production Calls'
  ];
  for (const d of dirs) fs.mkdirSync(path.join(vaultDir, d), { recursive: true });
  return vaultDir;
}

function destinations(vaultDir, overrides) {
  return discoverDestinations({
    vaultDir,
    rules: mergeFilingRules(DEFAULT_FILING_RULES, overrides)
  });
}

// ---------------------------------------------------------------------------
// mergeFilingRules
// ---------------------------------------------------------------------------

test('mergeFilingRules: overrides win by id, new ids append, malformed dropped', () => {
  const merged = mergeFilingRules(DEFAULT_FILING_RULES, [
    { id: 'nxt', destination: 'Somewhere/Else', keywords: ['nxt'], people: [] },
    { id: 'newco', destination: 'Projects/NewCo', keywords: ['newco'] },
    { id: '', destination: 'Bad' },
    { destination: 'No id' },
    'not-an-object',
    { id: 'no-dest' }
  ]);

  const nxt = merged.find((r) => r.id === 'nxt');
  assert.equal(nxt.destination, 'Somewhere/Else');
  assert.ok(merged.find((r) => r.id === 'newco'));
  assert.equal(merged.filter((r) => !r.id || !r.destination).length, 0);
  assert.equal(merged.length, DEFAULT_FILING_RULES.length + 1);
});

test('mergeFilingRules: lowercases keywords/people, drops non-string entries', () => {
  const merged = mergeFilingRules([], [
    { id: 'a', destination: 'A', keywords: ['Foo ', 42, '  Bar'], people: ['Tony', null] }
  ]);
  assert.deepEqual(merged[0].keywords, ['foo', 'bar']);
  assert.deepEqual(merged[0].people, ['tony']);
});

// ---------------------------------------------------------------------------
// discoverDestinations
// ---------------------------------------------------------------------------

test('discoverDestinations: rules + auto-discovered folders, deduped by rel', () => {
  const vaultDir = makeVault();
  // A NEW client with only a folder — no rule, no settings.
  fs.mkdirSync(path.join(vaultDir, 'Projects/CXVentures/Clients/NewCo/Meetings'), { recursive: true });

  const dests = destinations(vaultDir);
  const rels = dests.map((d) => d.rel);

  assert.ok(rels.includes('Projects/CXVentures/Clients/NXT/Meetings'));
  assert.ok(rels.includes('Projects/CXVentures/Clients/NewCo/Meetings'), 'new client auto-discovered');
  // NXT is covered by a rule — no duplicate auto entry for the same rel.
  assert.equal(rels.filter((r) => r === 'Projects/CXVentures/Clients/NXT/Meetings').length, 1);

  const newco = dests.find((d) => d.rel.includes('NewCo'));
  assert.equal(newco.source, 'auto');
  assert.deepEqual(newco.keywords, ['newco']);
});

test('discoverDestinations: never throws on a missing vault', () => {
  const dests = discoverDestinations({
    vaultDir: '/nonexistent/vault/path',
    rules: mergeFilingRules(DEFAULT_FILING_RULES, [])
  });
  // Rule destinations still listed (dirs may not exist yet — mkdir at export).
  assert.ok(dests.length >= DEFAULT_FILING_RULES.length - 1);
});

// ---------------------------------------------------------------------------
// buildNameIndex + scoring
// ---------------------------------------------------------------------------

test('buildNameIndex: tokens from existing filenames; missing dir = empty set', () => {
  const vaultDir = makeVault();
  fs.writeFileSync(
    path.join(vaultDir, 'Projects/CXVentures/Clients/NXT/Meetings/05.15.26 tony northbay catchup.md'),
    'x'
  );
  const dests = destinations(vaultDir);
  const index = buildNameIndex(dests);
  const nxt = dests.find((d) => d.id === 'nxt');
  assert.ok(index[nxt.id].has('tony'));
  assert.ok(index[nxt.id].has('catchup'));
  assert.ok(!index[nxt.id].has('26'), 'date fragments dropped');

  const missing = buildNameIndex([{ id: 'gone', dir: path.join(vaultDir, 'not/here') }]);
  assert.equal(missing.gone.size, 0);
});

test('scoreDestinations: keyword in title +3, in participants/agenda +1.5, person +2', () => {
  const vaultDir = makeVault();
  const dests = destinations(vaultDir);
  const scored = scoreDestinations(
    { title: 'NXT Northbay Sync', participants: 'Chris, Tony, Sean', agenda: '' },
    dests,
    {}
  );
  const nxt = scored.find((d) => d.id === 'nxt');
  // nxt +3 (title) + northbay +3 (title) + tony +2 (person) = 8
  assert.equal(nxt.score, 8);
  assert.equal(scored[0].id, 'nxt');
});

test('scoreDestinations: short aliases match whole-token only', () => {
  const vaultDir = makeVault();
  const dests = destinations(vaultDir);
  // "aa" must not fire inside "AAA Insurance"; "bb" not inside "hubbub".
  const scored = scoreDestinations(
    { title: 'AAA Insurance hubbub review', participants: '', agenda: '' },
    dests,
    {}
  );
  assert.equal(scored.find((d) => d.id === 'artist-advisory').score, 0);
  assert.equal(scored.find((d) => d.id === 'buildersbuddy').score, 0);
});

test('scoreDestinations: attendee-overlap capped at +2 and never routes alone', () => {
  const vaultDir = makeVault();
  const dests = destinations(vaultDir);
  const nxt = dests.find((d) => d.id === 'nxt');
  const index = { [nxt.id]: new Set(['sean', 'evan', 'lewis']) };
  const scored = scoreDestinations(
    { title: 'Untitled catch-up', participants: 'Sean, Evan Lewis', agenda: '' },
    dests,
    index
  );
  const top = scored.find((d) => d.id === 'nxt');
  assert.equal(top.score, 2, 'three overlapping names capped at +2');
  assert.equal(decideDeterministic(scored), null, 'overlap alone cannot route deterministically');
});

test('decideDeterministic: needs score ≥4 AND margin ≥2', () => {
  assert.equal(decideDeterministic([]), null);
  assert.equal(decideDeterministic([{ score: 3.5 }]), null, 'below threshold');
  assert.equal(decideDeterministic([{ score: 5 }, { score: 4 }]), null, 'margin too small');
  const top = { id: 'nxt', score: 6, matched: [] };
  assert.equal(decideDeterministic([top, { score: 2 }]), top);
  assert.equal(decideDeterministic([top]), top, 'single candidate margin vs 0');
});

// ---------------------------------------------------------------------------
// prompt + parse
// ---------------------------------------------------------------------------

test('buildFilingPrompt: lists candidate ids and demands a single JSON object', () => {
  const prompt = buildFilingPrompt({
    title: 'Weekly sync',
    participants: 'Chris, Tony',
    agenda: 'Roadmap',
    notesExcerpt: 'We discussed things.',
    candidates: [
      { id: 'nxt', rel: 'Projects/CXVentures/Clients/NXT/Meetings' },
      { id: 'qrs', rel: 'Projects/CXVentures/Clients/QRS/Meetings' }
    ]
  });
  assert.match(prompt, /id: nxt/);
  assert.match(prompt, /id: qrs/);
  assert.match(prompt, /"none"/);
  assert.match(prompt, /ONLY a single JSON object/);
  assert.match(prompt, /Weekly sync/);
});

test('parseFilingResponse: strict contract — fences stripped, id validated, confidence clamped', () => {
  const candidates = [{ id: 'nxt' }, { id: 'qrs' }];

  const ok = parseFilingResponse('```json\n{"destination": "nxt", "confidence": 0.9, "reason": "client"}\n```', candidates);
  assert.deepEqual(ok, { destinationId: 'nxt', confidence: 0.9, reason: 'client' });

  const prose = parseFilingResponse('Sure! Here you go: {"destination": "none", "confidence": 1.7, "reason": "new"} hope that helps', candidates);
  assert.equal(prose.destinationId, 'none');
  assert.equal(prose.confidence, 1, 'clamped to 1');

  assert.equal(parseFilingResponse('{"destination": "unknown-id", "confidence": 0.9}', candidates), null);
  assert.equal(parseFilingResponse('{"destination": "nxt"}', candidates), null, 'missing confidence');
  assert.equal(parseFilingResponse('{"destination": "nxt", "confidence": "high"}', candidates), null);
  assert.equal(parseFilingResponse('no json here at all', candidates), null);
  assert.equal(parseFilingResponse('', candidates), null);
  assert.equal(parseFilingResponse(null, candidates), null);
  assert.equal(parseFilingResponse('{"broken": ', candidates), null);
});

test('parseFilingResponse: brace-aware extraction survives braces inside strings', () => {
  const res = parseFilingResponse(
    '{"destination": "nxt", "confidence": 0.8, "reason": "matches {client} folder"}',
    [{ id: 'nxt' }]
  );
  assert.equal(res.reason, 'matches {client} folder');
});

// ---------------------------------------------------------------------------
// classifyNote — the tier flow
// ---------------------------------------------------------------------------

test('classifyNote: deterministic path files without calling the LLM', async () => {
  const vaultDir = makeVault();
  let llmCalls = 0;
  const result = await classifyNote(
    { title: 'NXT Northbay Sync', participants: 'Chris, Tony, Sean' },
    { vaultDir, runLLM: async () => { llmCalls += 1; return '{}'; } }
  );
  assert.equal(result.method, 'deterministic');
  assert.equal(result.destinationRel, 'Projects/CXVentures/Clients/NXT/Meetings');
  assert.equal(result.destinationDir, path.join(vaultDir, 'Projects/CXVentures/Clients/NXT/Meetings'));
  assert.equal(result.confidence, 1);
  assert.equal(llmCalls, 0, 'deterministic tier skips the LLM entirely');
  assert.ok(result.candidates.length >= 1);
});

test('classifyNote: ambiguous note → LLM picks a valid candidate', async () => {
  const vaultDir = makeVault();
  let sawPrompt = null;
  const result = await classifyNote(
    { title: 'Catch-up on the audit', participants: 'Chris, Tony', agenda: 'audit follow-ups' },
    {
      vaultDir,
      runLLM: async (prompt) => {
        sawPrompt = prompt;
        return '{"destination": "nxt", "confidence": 0.85, "reason": "Tony is the NXT counterpart"}';
      }
    }
  );
  assert.equal(result.method, 'llm');
  assert.equal(result.destinationRel, 'Projects/CXVentures/Clients/NXT/Meetings');
  assert.equal(result.confidence, 0.85);
  assert.match(sawPrompt, /id: nxt/, 'LLM saw the scored candidates');
});

test('classifyNote: LLM says none with high confidence → catch-all', async () => {
  const vaultDir = makeVault();
  const result = await classifyNote(
    { title: 'Chat with Tony about nothing in particular', participants: 'Chris, Tony' },
    { vaultDir, runLLM: async () => '{"destination": "none", "confidence": 0.9, "reason": "new topic"}' }
  );
  assert.equal(result.method, 'catch-all');
  assert.equal(result.destinationRel, CATCH_ALL_REL);
});

test('classifyNote: LLM garbage + some evidence → Inbox escalation', async () => {
  const vaultDir = makeVault();
  const result = await classifyNote(
    { title: 'Quick chat', participants: 'Chris, Tony' }, // tony person = +2 evidence
    { vaultDir, runLLM: async () => 'I am not JSON, sorry!' }
  );
  assert.equal(result.method, 'inbox');
  assert.equal(result.destinationRel, INBOX_REL);
  assert.ok(result.candidates.length >= 1, 'pop-up has candidates to offer');
});

test('classifyNote: LLM low confidence + some evidence → Inbox escalation', async () => {
  const vaultDir = makeVault();
  const result = await classifyNote(
    { title: 'Quick chat', participants: 'Chris, Tony' },
    { vaultDir, runLLM: async () => '{"destination": "nxt", "confidence": 0.3, "reason": "maybe"}' }
  );
  assert.equal(result.method, 'inbox');
});

test('classifyNote: never-resolving LLM times out (timeoutMs) → Inbox with evidence', async () => {
  const vaultDir = makeVault();
  const result = await classifyNote(
    { title: 'Quick chat', participants: 'Chris, Tony' },
    { vaultDir, runLLM: () => new Promise(() => {}), timeoutMs: 10 }
  );
  assert.equal(result.method, 'inbox');
});

test('classifyNote: LLM throws + zero evidence → catch-all, no escalation spam', async () => {
  const vaultDir = makeVault();
  const result = await classifyNote(
    { title: 'Coffee with Priya from Vertex Labs', participants: 'Chris, Priya' },
    { vaultDir, runLLM: async () => { throw new Error('CLI missing'); } }
  );
  assert.equal(result.method, 'catch-all');
  assert.equal(result.destinationRel, CATCH_ALL_REL);
});

test('classifyNote: no runLLM at all behaves like LLM-unavailable', async () => {
  const vaultDir = makeVault();
  const withEvidence = await classifyNote(
    { title: 'Quick chat', participants: 'Chris, Tony' },
    { vaultDir }
  );
  assert.equal(withEvidence.method, 'inbox');

  const noEvidence = await classifyNote(
    { title: 'Coffee with Priya', participants: 'Chris, Priya' },
    { vaultDir }
  );
  assert.equal(noEvidence.method, 'catch-all');
});

test('classifyNote: missing vault → null (caller falls back to flat export)', async () => {
  const result = await classifyNote(
    { title: 'NXT sync' },
    { vaultDir: '/definitely/not/a/vault' }
  );
  assert.equal(result, null);
});

test('classifyNote: store overrides reroute a rule', async () => {
  const vaultDir = makeVault();
  fs.mkdirSync(path.join(vaultDir, 'Custom/NXT Notes'), { recursive: true });
  const result = await classifyNote(
    { title: 'NXT Northbay Sync', participants: 'Chris, Tony' },
    {
      vaultDir,
      rules: [{ id: 'nxt', destination: 'Custom/NXT Notes', keywords: ['nxt', 'northbay'], people: ['tony'] }]
    }
  );
  assert.equal(result.method, 'deterministic');
  assert.equal(result.destinationRel, 'Custom/NXT Notes');
});

// ---------------------------------------------------------------------------
// resolveCollision
// ---------------------------------------------------------------------------

test('resolveCollision: free name passes through; conflicts get " 2", " 3", …', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4c-coll-'));
  assert.equal(resolveCollision(dir, 'Note.md'), 'Note.md');

  fs.writeFileSync(path.join(dir, 'Note.md'), 'x');
  assert.equal(resolveCollision(dir, 'Note.md'), 'Note 2.md');

  fs.writeFileSync(path.join(dir, 'Note 2.md'), 'x');
  assert.equal(resolveCollision(dir, 'Note.md'), 'Note 3.md');
});

test('no built-in rules: an unconfigured install routes nothing by keyword', async () => {
  assert.equal(BUILT_IN_FILING_RULES.length, 0);
  const vaultDir = makeVault();
  setVaultProfile(null);
  let result;
  try {
    result = await classifyNoteWithRules(
      { title: 'NXT Northbay Sync', participants: 'Chris, Tony' },
      { vaultDir, runLLM: async () => '{}' }
    );
  } finally {
    setVaultProfile(FIXTURE_PROFILE);
  }
  assert.equal(result.method, 'catch-all');
  assert.equal(result.destinationRel, CATCH_ALL_REL);
});

test('discoverDestinations: discovery folders come from the profile, none by default', () => {
  const vaultDir = makeVault();
  const auto = (dests) => dests.filter((d) => d.source === 'auto').map((d) => d.rel);
  assert.deepEqual(auto(discoverDestinations({ vaultDir, rules: [], groups: [] })), []);
  assert.ok(auto(discoverDestinations({ vaultDir, rules: [] }))
    .includes('Projects/CXVentures/Clients/NXT/Meetings'));
});
