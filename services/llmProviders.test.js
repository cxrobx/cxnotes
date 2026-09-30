'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  PROVIDERS,
  PROVIDER_IDS,
  AUTO_ORDER,
  normalisePreference,
  resolveProviderOrder,
  describeNoProviderAvailable,
  resolveModel,
  readStoredLlmOptions,
} = require('./llmProviders');

const ALL = { codex: true, claude: true, ollama: true };
const NONE = { codex: false, claude: false, ollama: false };

/* ── the regression that matters most ─────────────────────────────────────── */

test('auto reproduces the pre-setting behaviour: Codex first, then Claude', () => {
  // This is the whole safety property of adding the setting — an existing
  // install must not silently change provider on upgrade.
  assert.deepStrictEqual(
    resolveProviderOrder('auto', { codex: true, claude: true, ollama: false }),
    ['codex', 'claude']
  );
  assert.deepStrictEqual(AUTO_ORDER.slice(0, 2), ['codex', 'claude']);
});

test('auto with only Claude installed goes straight to Claude', () => {
  // The "user has no Codex subscription" case, which already worked and must
  // keep working without any configuration.
  assert.deepStrictEqual(
    resolveProviderOrder('auto', { codex: false, claude: true, ollama: false }),
    ['claude']
  );
});

test('auto filters to what is installed, preserving order', () => {
  assert.deepStrictEqual(resolveProviderOrder('auto', ALL), ['codex', 'claude', 'ollama']);
  assert.deepStrictEqual(resolveProviderOrder('auto', NONE), []);
  assert.deepStrictEqual(
    resolveProviderOrder('auto', { codex: false, claude: false, ollama: true }),
    ['ollama']
  );
});

/* ── preference ordering ──────────────────────────────────────────────────── */

test('a named preference goes first, others remain as fallback', () => {
  assert.deepStrictEqual(resolveProviderOrder('claude', ALL), ['claude', 'codex', 'ollama']);
  assert.deepStrictEqual(resolveProviderOrder('ollama', ALL), ['ollama', 'codex', 'claude']);
});

test('a preferred-but-missing provider is skipped, not fatal', () => {
  assert.deepStrictEqual(
    resolveProviderOrder('codex', { codex: false, claude: true, ollama: false }),
    ['claude']
  );
});

test('strict returns the preference alone — the privacy guarantee', () => {
  // Someone who picks the local provider deliberately must never have the
  // transcript escalate to a cloud CLI behind their back.
  assert.deepStrictEqual(resolveProviderOrder('ollama', ALL, { strict: true }), ['ollama']);
  assert.deepStrictEqual(resolveProviderOrder('claude', ALL, { strict: true }), ['claude']);
});

test('strict with the preferred provider missing yields nothing, never a substitute', () => {
  assert.deepStrictEqual(
    resolveProviderOrder('ollama', { codex: true, claude: true, ollama: false }, { strict: true }),
    []
  );
});

test('strict auto is meaningless and behaves as non-strict', () => {
  assert.deepStrictEqual(resolveProviderOrder('auto', ALL, { strict: true }), AUTO_ORDER.slice());
});

/* ── tolerating a hand-edited or future config ────────────────────────────── */

test('an unknown preference degrades to auto rather than breaking summarisation', () => {
  for (const bad of ['gpt4', '', null, undefined, 42, {}, 'AUTO ']) {
    assert.strictEqual(normalisePreference(bad), 'auto', `for ${JSON.stringify(bad)}`);
  }
  assert.deepStrictEqual(resolveProviderOrder('nonsense', ALL), AUTO_ORDER.slice());
});

test('preference matching is case-insensitive and trimmed', () => {
  assert.strictEqual(normalisePreference(' Claude '), 'claude');
  assert.strictEqual(normalisePreference('OLLAMA'), 'ollama');
});

test('missing availability entries count as unavailable', () => {
  assert.deepStrictEqual(resolveProviderOrder('auto', {}), []);
  assert.deepStrictEqual(resolveProviderOrder('auto', { claude: true }), ['claude']);
});

/* ── models ───────────────────────────────────────────────────────────────── */

test('resolveModel falls back to the pinned default', () => {
  assert.strictEqual(resolveModel('codex'), PROVIDERS.codex.defaultModel);
  assert.strictEqual(resolveModel('claude', {}), PROVIDERS.claude.defaultModel);
  assert.strictEqual(resolveModel('ollama', { ollama: '   ' }), PROVIDERS.ollama.defaultModel);
});

test('resolveModel honours an override', () => {
  assert.strictEqual(resolveModel('claude', { claude: 'claude-sonnet-5' }), 'claude-sonnet-5');
  // An override for one provider must not leak into another.
  assert.strictEqual(resolveModel('codex', { claude: 'claude-sonnet-5' }), PROVIDERS.codex.defaultModel);
});

test('resolveModel on an unknown provider is null, not a crash', () => {
  assert.strictEqual(resolveModel('nope'), null);
});

/* ── the message a fresh user is most likely to hit ───────────────────────── */

test('no-provider error names every provider and how to install it', () => {
  const msg = describeNoProviderAvailable('auto', NONE);
  for (const id of PROVIDER_IDS) {
    assert.ok(msg.includes(PROVIDERS[id].label), `names ${id}`);
    assert.ok(msg.includes(PROVIDERS[id].install), `tells you how to install ${id}`);
  }
  // Recording/transcription still work — say so, or it reads as total failure.
  assert.match(msg, /transcription still work/i);
});

test('Codex install hint is the OpenAI package, not an @anthropic-ai one', () => {
  // The old message said `npm install -g @anthropic-ai/codex`, which 404s.
  assert.strictEqual(PROVIDERS.codex.install, 'npm install -g @openai/codex');
  assert.ok(!describeNoProviderAvailable('auto', NONE).includes('@anthropic-ai/codex'));
});

test('strict + missing provider explains the three ways out', () => {
  const msg = describeNoProviderAvailable('ollama', NONE, { strict: true });
  assert.match(msg, /Ollama only/);
  assert.match(msg, /brew install ollama/);
  assert.match(msg, /Settings/);
  assert.match(msg, /Only use the selected provider/);
});

/* ── provider metadata ────────────────────────────────────────────────────── */

test('exactly one provider is local, and it is the one with no subscription', () => {
  const local = PROVIDER_IDS.filter((id) => PROVIDERS[id].kind === 'local');
  assert.deepStrictEqual(local, ['ollama']);
});

test('every provider declares the fields the UI and runner rely on', () => {
  for (const id of PROVIDER_IDS) {
    const p = PROVIDERS[id];
    for (const field of ['id', 'label', 'bin', 'kind', 'defaultModel', 'install']) {
      assert.ok(p[field], `${id} is missing ${field}`);
    }
    assert.strictEqual(p.id, id);
  }
});

test('AUTO_ORDER covers every provider — a new one cannot be silently unreachable', () => {
  assert.deepStrictEqual([...AUTO_ORDER].sort(), [...PROVIDER_IDS].sort());
});

/* ── the store reader the standalone scripts use ──────────────────────────── */

function fakeFs(files) {
  return {
    readFileSync(p) {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
  };
}

const CONFIG = '/home/Library/Application Support/CXNotes/config.json';

test('readStoredLlmOptions reads what the app saved', () => {
  const opts = readStoredLlmOptions({
    home: '/home',
    storeDirNames: ['CXNotes'],
    fsImpl: fakeFs({
      [CONFIG]: JSON.stringify({
        llmProvider: 'ollama',
        llmProviderStrict: true,
        llmModels: { ollama: 'mistral' },
      }),
    }),
  });
  assert.deepStrictEqual(opts, { provider: 'ollama', strict: true, models: { ollama: 'mistral' } });
});

test('readStoredLlmOptions defaults when the key was never set', () => {
  const opts = readStoredLlmOptions({
    home: '/home',
    storeDirNames: ['CXNotes'],
    fsImpl: fakeFs({ [CONFIG]: JSON.stringify({ retentionDays: 7 }) }),
  });
  assert.deepStrictEqual(opts, { provider: 'auto', strict: false, models: {} });
});

test('readStoredLlmOptions survives a missing or corrupt config', () => {
  const missing = readStoredLlmOptions({ home: '/home', storeDirNames: ['CXNotes'], fsImpl: fakeFs({}) });
  assert.deepStrictEqual(missing, { provider: 'auto', strict: false, models: {} });

  const corrupt = readStoredLlmOptions({
    home: '/home',
    storeDirNames: ['CXNotes'],
    fsImpl: fakeFs({ [CONFIG]: '{not json' }),
  });
  assert.deepStrictEqual(corrupt, { provider: 'auto', strict: false, models: {} });
});

test('readStoredLlmOptions normalises a hand-edited provider value', () => {
  const opts = readStoredLlmOptions({
    home: '/home',
    storeDirNames: ['CXNotes'],
    fsImpl: fakeFs({ [CONFIG]: JSON.stringify({ llmProvider: 'gpt-9', llmModels: 'nope' }) }),
  });
  assert.strictEqual(opts.provider, 'auto');
  assert.deepStrictEqual(opts.models, {});
});
