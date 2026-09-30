'use strict';

/**
 * Budget and parity for the always-loaded instruction files.
 *
 * Claude Code loads `CLAUDE.md` and every `.claude/rules/*.md` into every
 * session, and warns once ALL loaded instruction files — the user's own
 * `~/CLAUDE.md` included (~65k) — pass 150k chars. On 2026-09-25 this repo
 * alone was 164k: the rules files had absorbed their own incident write-ups,
 * and CLAUDE.md's "one-liner" learnings had become essays. The fix split each
 * into a short always-loaded digest and a full on-demand reference in `docs/`.
 * This test holds both halves of that split:
 *
 *   - budget: each always-loaded file stays under its cap, so the next
 *     write-up lands in `docs/` instead of drifting back into every session;
 *   - parity: every numbered invariant and gotcha exists in BOTH the digest
 *     and the full reference, so neither side can silently lose an entry, and
 *     code comments citing `invariant #N` / `gotcha #N` keep resolving.
 *
 * `CLAUDE.md` is gitignored, so its check skips on a checkout without one.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Caps in chars (JS string length, the unit the warning reports). Set with
// headroom over the 2026-09-25 sizes (≈6k / ≈18k / ≈13k); raising one is a
// decision to spend every session's context, not a fix for a failing test.
const BUDGETS = {
  'CLAUDE.md': 8000,
  '.claude/rules/architecture.md': 24000,
  '.claude/rules/gotchas.md': 18000,
};

// The numbered list under `## Critical Invariants` only — both files have other
// numbered lists (flows, tiers) that are not invariants.
function invariantNumbers(md) {
  const start = md.indexOf('\n## Critical Invariants');
  assert.ok(start >= 0, 'no "## Critical Invariants" section');
  const rest = md.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  return [...section.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
}

// Full reference headings are `### N. Title` (one legacy `## #N: Title`);
// digest entries are `**#N — …` or `**#N (label) — …`. Sorted, duplicates
// kept: two gotchas share #20 on purpose.
function fullGotchaNumbers(md) {
  return [...md.matchAll(/^(?:### (\d+)\. |## #(\d+): )/gm)]
    .map((m) => Number(m[1] || m[2]))
    .sort((a, b) => a - b);
}
function digestGotchaNumbers(md) {
  return [...md.matchAll(/^\*\*#(\d+)(?: \([^)]*\))? — /gm)]
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

for (const [rel, cap] of Object.entries(BUDGETS)) {
  test(`${rel} stays within its always-loaded budget (${cap} chars)`, (t) => {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      t.skip(`${rel} not present on this checkout`);
      return;
    }
    const size = read(rel).length;
    assert.ok(
      size <= cap,
      `${rel} is ${size} chars, over its ${cap} cap. Move detail to docs/ ` +
        '(docs/architecture.md, docs/gotchas.md, docs/learnings.md) and keep a short entry here.'
    );
  });
}

test('every invariant is numbered 1..N with no gaps, in the digest and the full reference alike', () => {
  const digest = invariantNumbers(read('.claude/rules/architecture.md'));
  const full = invariantNumbers(read('docs/architecture.md'));
  const expected = Array.from({ length: full.length }, (_, i) => i + 1);
  assert.deepStrictEqual(full, expected, 'docs/architecture.md invariants are not 1..N in order');
  assert.deepStrictEqual(digest, full, 'the digest and docs/architecture.md list different invariants');
});

test('every gotcha in the full reference has a digest entry, and vice versa', () => {
  const full = fullGotchaNumbers(read('docs/gotchas.md'));
  const digest = digestGotchaNumbers(read('.claude/rules/gotchas.md'));
  assert.ok(full.length > 0, 'parsed no gotchas from docs/gotchas.md');
  assert.deepStrictEqual(digest, full, 'the digest and docs/gotchas.md list different gotchas');
});

test('the parsers see what a reader sees (guards the regexes above)', () => {
  const fixture = '# T\n\n## Critical Invariants\n\n1. **A** x\n   1. **not an invariant** nested\n2. **B** y\n\n## Key flows\n\n1. **Flow** z\n';
  assert.deepStrictEqual(invariantNumbers(fixture), [1, 2]);
  assert.deepStrictEqual(
    fullGotchaNumbers('### 2. Two\n## #20: Frames\n### 20. Names\ntext ### 9. not a heading\n'),
    [2, 20, 20]
  );
  assert.deepStrictEqual(
    digestGotchaNumbers('**#5 — Five.**\n**#20 (SCK frames) — A.**\n**#20 (speaker names) — B.**\nsee **#7 — inline\n'),
    [5, 20, 20]
  );
});
