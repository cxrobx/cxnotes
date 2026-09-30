'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normaliseVaultPath,
  looksLikeObsidianVault,
  listObsidianVaults,
  detectVaultDirectory,
  readStoredVaultSetting,
  readConfiguredVaultDirectory,
  resolveVaultDirectoryForScript,
  describeVault,
  isInsideVault
} = require('./vaultLocator');

/**
 * A throwaway home directory. Every test drives the real fs against this fake
 * `home` rather than mocking, so the path arithmetic (which is the whole point
 * of the module) is exercised for real.
 */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'n4c-home-'));
  return home;
}

function writeObsidianRegistry(home, json) {
  const dir = path.join(home, 'Library', 'Application Support', 'obsidian');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'obsidian.json'), typeof json === 'string' ? json : JSON.stringify(json));
}

function writeStoreConfig(home, dirName, config) {
  const dir = path.join(home, 'Library', 'Application Support', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
}

function makeVaultDir(home, name, { obsidian = true } = {}) {
  const dir = path.join(home, 'Documents', name);
  fs.mkdirSync(dir, { recursive: true });
  if (obsidian) fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
  return dir;
}

/* ── normaliseVaultPath ─────────────────────────────────────────────────── */

test('normaliseVaultPath: expands a leading ~ and resolves', () => {
  const home = '/Users/someone';
  assert.equal(normaliseVaultPath('~/Notes', home), '/Users/someone/Notes');
  assert.equal(normaliseVaultPath('~', home), '/Users/someone');
  assert.equal(normaliseVaultPath('  ~/Notes  ', home), '/Users/someone/Notes');
  assert.equal(normaliseVaultPath('/tmp/Vault/', home), '/tmp/Vault');
});

test('normaliseVaultPath: "not configured" always collapses to null', () => {
  // The empty string is the user deliberately clearing the field, and it must
  // read identically to "never set" for every downstream guard.
  assert.equal(normaliseVaultPath('', '/h'), null);
  assert.equal(normaliseVaultPath('   ', '/h'), null);
  assert.equal(normaliseVaultPath(null, '/h'), null);
  assert.equal(normaliseVaultPath(undefined, '/h'), null);
  assert.equal(normaliseVaultPath(42, '/h'), null);
});

test('normaliseVaultPath: a bare ~ inside the path is NOT expanded', () => {
  // Only a leading `~` is a home reference; `~` is a legal filename character.
  assert.equal(normaliseVaultPath('/tmp/a~b', '/h'), '/tmp/a~b');
});

/* ── looksLikeObsidianVault ─────────────────────────────────────────────── */

test('looksLikeObsidianVault: keys off the .obsidian marker directory', () => {
  const home = makeHome();
  const vault = makeVaultDir(home, 'Vault');
  const plain = makeVaultDir(home, 'Plain', { obsidian: false });

  assert.equal(looksLikeObsidianVault(vault), true);
  assert.equal(looksLikeObsidianVault(plain), false);
  assert.equal(looksLikeObsidianVault(null), false);
  assert.equal(looksLikeObsidianVault(path.join(home, 'nope')), false);
});

/* ── listObsidianVaults ─────────────────────────────────────────────────── */

test('listObsidianVaults: open vault first, then most recent', () => {
  const home = makeHome();
  const oldest = makeVaultDir(home, 'Oldest');
  const newest = makeVaultDir(home, 'Newest');
  const openOne = makeVaultDir(home, 'Open');
  writeObsidianRegistry(home, {
    vaults: {
      a: { path: oldest, ts: 100 },
      b: { path: newest, ts: 900 },
      c: { path: openOne, ts: 500, open: true }
    }
  });

  const vaults = listObsidianVaults({ home });
  assert.deepEqual(vaults.map((v) => v.path), [openOne, newest, oldest]);
});

test('listObsidianVaults: drops registry entries whose folder is gone', () => {
  // Obsidian never prunes this file, so a deleted vault lingers forever.
  const home = makeHome();
  const alive = makeVaultDir(home, 'Alive');
  writeObsidianRegistry(home, {
    vaults: {
      a: { path: path.join(home, 'Documents', 'Deleted'), ts: 999, open: true },
      b: { path: alive, ts: 1 }
    }
  });

  assert.deepEqual(listObsidianVaults({ home }).map((v) => v.path), [alive]);
});

test('listObsidianVaults: missing or corrupt registry is an empty list, never a throw', () => {
  const home = makeHome();
  assert.deepEqual(listObsidianVaults({ home }), []);

  writeObsidianRegistry(home, '{ not json');
  assert.deepEqual(listObsidianVaults({ home }), []);

  writeObsidianRegistry(home, { icon: 'icon.png' });
  assert.deepEqual(listObsidianVaults({ home }), []);
});

/* ── detectVaultDirectory ───────────────────────────────────────────────── */

test('detectVaultDirectory: an existing preferred path wins over the registry', () => {
  // This is the upgrade path: an install that has always exported to the legacy
  // folder must not silently switch vaults the first time it boots this build.
  const home = makeHome();
  const legacy = makeVaultDir(home, 'CX', { obsidian: false });
  const other = makeVaultDir(home, 'Other');
  writeObsidianRegistry(home, { vaults: { a: { path: other, ts: 5, open: true } } });

  assert.equal(detectVaultDirectory({ home, preferPaths: [legacy] }), legacy);
});

test('detectVaultDirectory: falls through to Obsidian when the preferred path is absent', () => {
  const home = makeHome();
  const other = makeVaultDir(home, 'Other');
  writeObsidianRegistry(home, { vaults: { a: { path: other, ts: 5, open: true } } });

  const detected = detectVaultDirectory({
    home,
    preferPaths: [path.join(home, 'Documents', 'CX')]
  });
  assert.equal(detected, other);
});

test('detectVaultDirectory: null when there is nothing to find', () => {
  const home = makeHome();
  assert.equal(detectVaultDirectory({ home, preferPaths: [path.join(home, 'nope')] }), null);
});

/* ── readConfiguredVaultDirectory ───────────────────────────────────────── */

test('readConfiguredVaultDirectory: reads the packaged config, expanding ~', () => {
  const home = makeHome();
  writeStoreConfig(home, 'CXNotes', { vaultDirectory: '~/Documents/Mine' });
  assert.equal(readConfiguredVaultDirectory({ home }), path.join(home, 'Documents', 'Mine'));
});

test('readConfiguredVaultDirectory: also finds the lowercase dev-run config folder', () => {
  // A default macOS volume is case-INSENSITIVE, so `CXNotes` and `cxnotes` are
  // one directory and this probe is belt-and-braces; it only does real work on
  // a case-sensitive volume, where the two installs genuinely diverge.
  const home = makeHome();
  writeStoreConfig(home, 'cxnotes', { vaultDirectory: '/tmp/DevVault' });
  assert.equal(readConfiguredVaultDirectory({ home }), '/tmp/DevVault');
});

test('readConfiguredVaultDirectory: an explicit empty value means "no vault"', () => {
  // The user cleared the field on purpose — resolve to null (export off) rather
  // than re-detecting a vault they just removed.
  const home = makeHome();
  writeStoreConfig(home, 'CXNotes', { vaultDirectory: '' });
  assert.equal(readConfiguredVaultDirectory({ home }), null);
});

test('readStoredVaultSetting: separates "never set" from "cleared on purpose"', () => {
  const unset = makeHome();
  assert.deepEqual(readStoredVaultSetting({ home: unset }), { present: false, path: null });

  const cleared = makeHome();
  writeStoreConfig(cleared, 'CXNotes', { vaultDirectory: '' });
  assert.deepEqual(readStoredVaultSetting({ home: cleared }), { present: true, path: null });
});

test('resolveVaultDirectoryForScript: a deliberately cleared vault stays off', () => {
  // Turning vault export off in the app must also turn it off for the CLI
  // scripts — otherwise a sweep detects a vault the user just removed and
  // starts moving notes into it.
  const home = makeHome();
  const detected = makeVaultDir(home, 'Detected');
  writeObsidianRegistry(home, { vaults: { a: { path: detected, ts: 5, open: true } } });
  writeStoreConfig(home, 'CXNotes', { vaultDirectory: '' });
  assert.equal(resolveVaultDirectoryForScript({ home }), null);
});

test('readConfiguredVaultDirectory: absent key / missing / corrupt config → null', () => {
  const home = makeHome();
  assert.equal(readConfiguredVaultDirectory({ home }), null);

  writeStoreConfig(home, 'CXNotes', { retentionDays: 7 });
  assert.equal(readConfiguredVaultDirectory({ home }), null);

  fs.writeFileSync(
    path.join(home, 'Library', 'Application Support', 'CXNotes', 'config.json'),
    '{ nope'
  );
  assert.equal(readConfiguredVaultDirectory({ home }), null);
});

/* ── resolveVaultDirectoryForScript ─────────────────────────────────────── */

test('resolveVaultDirectoryForScript: --vault override beats everything', () => {
  const home = makeHome();
  writeStoreConfig(home, 'CXNotes', { vaultDirectory: '/tmp/Configured' });
  assert.equal(
    resolveVaultDirectoryForScript({ overridePath: '~/Documents/Explicit', home }),
    path.join(home, 'Documents', 'Explicit')
  );
});

test('resolveVaultDirectoryForScript: config, then detection, then null', () => {
  const home = makeHome();
  const detected = makeVaultDir(home, 'Detected');
  writeObsidianRegistry(home, { vaults: { a: { path: detected, ts: 5, open: true } } });

  assert.equal(resolveVaultDirectoryForScript({ home }), detected);

  writeStoreConfig(home, 'CXNotes', { vaultDirectory: '/tmp/Configured' });
  assert.equal(resolveVaultDirectoryForScript({ home }), '/tmp/Configured');

  assert.equal(resolveVaultDirectoryForScript({ home: makeHome() }), null);
});

/* ── describeVault ──────────────────────────────────────────────────────── */

test('describeVault: reports configured / exists / isObsidianVault separately', () => {
  const home = makeHome();
  const vault = makeVaultDir(home, 'Vault');
  const plain = makeVaultDir(home, 'Plain', { obsidian: false });

  assert.deepEqual(describeVault(null), {
    path: null, configured: false, exists: false, isObsidianVault: false
  });
  assert.deepEqual(describeVault(path.join(home, 'gone')), {
    path: path.join(home, 'gone'), configured: true, exists: false, isObsidianVault: false
  });
  assert.deepEqual(describeVault(plain), {
    path: plain, configured: true, exists: true, isObsidianVault: false
  });
  assert.deepEqual(describeVault(vault), {
    path: vault, configured: true, exists: true, isObsidianVault: true
  });
});

// ---------------------------------------------------------------------------
// isInsideVault — symlinked vault FOLDERS, which realpath silently defeats
// ---------------------------------------------------------------------------

const realFs = require('fs');
const realOs = require('os');

/**
 * A vault laid out the way this one actually is: an ordinary folder, plus a
 * folder that is a symlink to somewhere entirely outside the vault.
 */
function withSymlinkedVault(fn) {
  const root = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'cxnotes-vault-'));
  try {
    const vault = path.join(root, 'CX');
    const outside = path.join(root, 'elsewhere', 'NXT');
    realFs.mkdirSync(path.join(vault, 'Meetings'), { recursive: true });
    realFs.mkdirSync(outside, { recursive: true });

    // `Clients/NXT` inside the vault is a symlink out to `elsewhere/NXT`.
    realFs.mkdirSync(path.join(vault, 'Clients'), { recursive: true });
    realFs.symlinkSync(outside, path.join(vault, 'Clients', 'NXT'));

    const linkedNote = path.join(vault, 'Clients', 'NXT', 'CALL Tony 08.14.26.md');
    realFs.writeFileSync(linkedNote, '# note');

    const plainNote = path.join(vault, 'Meetings', 'CALL Someone 08.14.26.md');
    realFs.writeFileSync(plainNote, '# note');

    return fn({ root, vault, outside, linkedNote, plainNote });
  } finally {
    realFs.rmSync(root, { recursive: true, force: true });
  }
}

test('isInsideVault: a note in a SYMLINKED vault folder is inside the vault', () => {
  // THE BUG. Resolving symlinks on both sides sent this note to its real home
  // outside the vault, so it was judged "loose" and opened in TextEdit — even
  // though Obsidian opens it perfectly well.
  withSymlinkedVault(({ vault, linkedNote }) => {
    assert.strictEqual(isInsideVault(vault, linkedNote), true);
  });
});

test('isInsideVault: an ordinary note in the vault is still inside it', () => {
  withSymlinkedVault(({ vault, plainNote }) => {
    assert.strictEqual(isInsideVault(vault, plainNote), true);
  });
});

test('isInsideVault: a vault reached THROUGH a symlink still works', () => {
  // The mirror-image case, and the reason the realpath comparison is kept as a
  // fallback rather than deleted: here the two paths only agree once resolved.
  withSymlinkedVault(({ root, vault, plainNote }) => {
    const vaultLink = path.join(root, 'VaultLink');
    realFs.symlinkSync(vault, vaultLink);

    assert.strictEqual(isInsideVault(vaultLink, plainNote), true);
  });
});

test('isInsideVault: a note genuinely outside the vault is outside it', () => {
  withSymlinkedVault(({ vault, root }) => {
    const loose = path.join(root, 'loose.md');
    realFs.writeFileSync(loose, '# note');
    assert.strictEqual(isInsideVault(vault, loose), false);
  });
});

test('isInsideVault: a sibling directory sharing the vault name prefix is NOT inside', () => {
  // `~/Documents/CX-archive` starts with `~/Documents/CX`; containment has to be
  // tested on a path-segment boundary or the archive counts as the vault.
  withSymlinkedVault(({ root, vault }) => {
    const sibling = path.join(root, 'CX-archive');
    realFs.mkdirSync(sibling, { recursive: true });
    const note = path.join(sibling, 'note.md');
    realFs.writeFileSync(note, '# note');

    assert.strictEqual(isInsideVault(vault, note), false);
  });
});

test('isInsideVault: no configured vault means nothing is inside it', () => {
  // Null is a first-class state (invariant #17), not an error.
  assert.strictEqual(isInsideVault(null, '/anywhere/note.md'), false);
  assert.strictEqual(isInsideVault('', '/anywhere/note.md'), false);
});

test('isInsideVault: the vault directory itself counts as inside', () => {
  withSymlinkedVault(({ vault }) => {
    assert.strictEqual(isInsideVault(vault, vault), true);
  });
});
