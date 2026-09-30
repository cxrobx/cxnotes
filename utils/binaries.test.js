'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  STATIC_SEARCH_DIRS,
  searchDirs,
  resolveBinary,
  resolveBinaryCached,
  requireBinary,
  clearBinaryCache,
} = require('./binaries');

/** The PATH a macOS app launched from Finder/Dock/Spotlight actually gets. */
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** A developer's terminal PATH, which is what masks the bug. */
const DEV_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

/** fs stub: only the listed absolute paths exist and are executable. */
function fakeFs(executables, dirs = {}) {
  const set = new Set(executables);
  return {
    accessSync(p) {
      if (!set.has(p)) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
    },
    readdirSync(p) {
      if (!Object.prototype.hasOwnProperty.call(dirs, p)) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return dirs[p];
    },
  };
}

/* ── the regression this module exists for ────────────────────────────────── */

test('finds Homebrew sox even when PATH is the bare GUI PATH', () => {
  // This is the whole bug: `which sox` fails here, so the app reported sox
  // missing (and spawn ENOENT'd) on every Mac except the one that built it.
  const resolved = resolveBinary('sox', {
    env: { PATH: GUI_PATH },
    home: '/Users/x',
    fsImpl: fakeFs(['/opt/homebrew/bin/sox']),
  });
  assert.strictEqual(resolved, '/opt/homebrew/bin/sox');
});

test('finds the npm-global CLIs a Dock-launched app cannot see', () => {
  // codex/claude/ollama live in Homebrew or an nvm version dir — never on the
  // GUI PATH — which made summarisation report "no provider installed".
  const fsImpl = fakeFs(
    ['/Users/x/.nvm/versions/node/v24.11.1/bin/claude', '/usr/local/bin/ollama'],
    { '/Users/x/.nvm/versions/node': ['v20.9.0', 'v24.11.1'] }
  );
  const opts = { env: { PATH: GUI_PATH }, home: '/Users/x', fsImpl };
  assert.strictEqual(resolveBinary('claude', opts), '/Users/x/.nvm/versions/node/v24.11.1/bin/claude');
  assert.strictEqual(resolveBinary('ollama', opts), '/usr/local/bin/ollama');
});

test('newest nvm version wins', () => {
  const fsImpl = fakeFs(
    [
      '/Users/x/.nvm/versions/node/v20.9.0/bin/codex',
      '/Users/x/.nvm/versions/node/v24.11.1/bin/codex',
    ],
    { '/Users/x/.nvm/versions/node': ['v20.9.0', 'v24.11.1', 'v8.1.0'] }
  );
  assert.strictEqual(
    resolveBinary('codex', { env: { PATH: '' }, home: '/Users/x', fsImpl }),
    '/Users/x/.nvm/versions/node/v24.11.1/bin/codex'
  );
});

test('a genuinely absent binary still resolves to null', () => {
  // The fallbacks must not manufacture a false positive — "not installed" has
  // to stay reachable, or the install instructions never show.
  assert.strictEqual(
    resolveBinary('sox', { env: { PATH: GUI_PATH }, home: '/Users/x', fsImpl: fakeFs([]) }),
    null
  );
});

/* ── ordering ─────────────────────────────────────────────────────────────── */

test('$PATH wins over the static fallbacks', () => {
  // A developer pointing PATH at a custom build must still get their build.
  const fsImpl = fakeFs(['/Users/x/custom/bin/sox', '/opt/homebrew/bin/sox']);
  assert.strictEqual(
    resolveBinary('sox', { env: { PATH: '/Users/x/custom/bin' }, home: '/Users/x', fsImpl }),
    '/Users/x/custom/bin/sox'
  );
});

test('among the FALLBACKS, Homebrew beats the system dirs', () => {
  // Deliberate precedence: $PATH is honoured first (a developer pointing PATH
  // at a custom build must get it), and only then the static list. So with an
  // empty PATH — the case this module exists for — Homebrew wins.
  const fsImpl = fakeFs(['/usr/bin/sox', '/opt/homebrew/bin/sox']);
  assert.strictEqual(
    resolveBinary('sox', { env: { PATH: '' }, home: '/Users/x', fsImpl }),
    '/opt/homebrew/bin/sox'
  );
  assert.ok(
    STATIC_SEARCH_DIRS.indexOf('/opt/homebrew/bin') < STATIC_SEARCH_DIRS.indexOf('/usr/bin'),
    'Homebrew must be listed before the system dirs'
  );
});

test('a system dir already on $PATH is matched there first', () => {
  // Consequence of honouring $PATH first, asserted so the ordering is a
  // decision on record rather than an accident. Harmless in practice: macOS
  // ships no sox/codex/claude/ollama in /usr/bin for this to shadow.
  const fsImpl = fakeFs(['/usr/bin/sox', '/opt/homebrew/bin/sox']);
  assert.strictEqual(
    resolveBinary('sox', { env: { PATH: GUI_PATH }, home: '/Users/x', fsImpl }),
    '/usr/bin/sox'
  );
});

test('extraDirs beat everything', () => {
  const fsImpl = fakeFs(['/bundled/sox', '/opt/homebrew/bin/sox']);
  assert.strictEqual(
    resolveBinary('sox', { env: { PATH: DEV_PATH }, home: '/Users/x', fsImpl, extraDirs: ['/bundled'] }),
    '/bundled/sox'
  );
});

test('searchDirs never repeats a directory', () => {
  // /usr/bin appears in both the GUI PATH and the static list.
  const dirs = searchDirs({ env: { PATH: GUI_PATH }, home: '/Users/x', fsImpl: fakeFs([]) });
  assert.strictEqual(dirs.length, new Set(dirs).size);
});

/* ── executability + absolute paths ───────────────────────────────────────── */

test('a non-executable file of the right name is not a match', () => {
  const fsImpl = {
    accessSync() { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
    readdirSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
  };
  assert.strictEqual(resolveBinary('sox', { env: { PATH: DEV_PATH }, home: '/Users/x', fsImpl }), null);
});

test('an absolute path is verified, not searched for', () => {
  const fsImpl = fakeFs(['/opt/custom/sox']);
  assert.strictEqual(resolveBinary('/opt/custom/sox', { fsImpl }), '/opt/custom/sox');
  assert.strictEqual(resolveBinary('/nope/sox', { fsImpl }), null);
});

test('empty and nullish names are null, not a crash', () => {
  const fsImpl = fakeFs([]);
  for (const n of ['', null, undefined]) {
    assert.strictEqual(resolveBinary(n, { fsImpl }), null);
  }
});

/* ── caching ──────────────────────────────────────────────────────────────── */

test('the cache can be cleared, so installing a missing tool takes effect', () => {
  clearBinaryCache();
  let present = [];
  const fsImpl = {
    accessSync(p) { if (!present.includes(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } },
    readdirSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
  };
  const opts = { env: { PATH: GUI_PATH }, home: '/Users/x', fsImpl };

  assert.strictEqual(resolveBinaryCached('sox', opts), null);
  present = ['/opt/homebrew/bin/sox'];           // user runs `brew install sox`
  assert.strictEqual(resolveBinaryCached('sox', opts), null, 'still cached');
  clearBinaryCache();
  assert.strictEqual(resolveBinaryCached('sox', opts), '/opt/homebrew/bin/sox');
  clearBinaryCache();
});

/* ── the error a user actually sees ───────────────────────────────────────── */

test('requireBinary names the tool and how to install it', () => {
  clearBinaryCache();
  try {
    requireBinary('sox', {
      env: { PATH: GUI_PATH },
      home: '/Users/x',
      fsImpl: fakeFs([]),
      installHint: 'brew install sox',
    });
    assert.fail('should have thrown');
  } catch (err) {
    // "spawn sox ENOENT" tells a user nothing — they don't know sox exists.
    assert.match(err.message, /"sox" was not found/);
    assert.match(err.message, /brew install sox/);
    assert.doesNotMatch(err.message, /ENOENT/);
  }
  clearBinaryCache();
});

test('requireBinary returns the path when it is there', () => {
  clearBinaryCache();
  const resolved = requireBinary('sox', {
    env: { PATH: GUI_PATH },
    home: '/Users/x',
    fsImpl: fakeFs(['/opt/homebrew/bin/sox']),
  });
  assert.strictEqual(resolved, '/opt/homebrew/bin/sox');
  clearBinaryCache();
});
