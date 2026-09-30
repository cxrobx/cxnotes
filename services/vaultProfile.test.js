'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  normaliseProfile,
  setVaultProfile,
  getVaultProfile,
  selfNameSet,
  readStoredProfile,
} = require('./vaultProfile');
const { buildObsidianFilename, stripSelf } = require('./summariser');

test('normaliseProfile: anything malformed becomes an empty profile', () => {
  const empty = {
    selfNames: [], filingStopwords: [], categoryByDestination: [],
    categoryByContent: [], discoveryGroups: [],
  };
  for (const raw of [undefined, null, 'x', 42, [], {}]) {
    assert.deepEqual(normaliseProfile(raw), empty);
  }
  assert.deepEqual(normaliseProfile({ selfNames: 'alex', categoryByContent: {} }), empty);
});

test('normaliseProfile: cleans entries and drops the malformed ones', () => {
  const profile = normaliseProfile({
    selfNames: [' Alex ', 'Alex Doe', 7, ''],
    filingStopwords: ['ALEX'],
    categoryByDestination: [
      { folder: '/Projects/Acme/Meetings/', code: ' ACM ' },
      { folder: 'Projects/NoCode' },
      'nope',
    ],
    categoryByContent: [
      { code: 'BD', keywords: ['Biz Dev', ''] },
      { code: 'EMPTY', keywords: [] },
    ],
    discoveryGroups: [
      { parent: 'Projects/Clients/', subdirs: ['Meetings', 'Calls'] },
      { parent: 'Projects/NoSubdirs', subdirs: [] },
    ],
  });
  assert.deepEqual(profile, {
    selfNames: ['alex', 'alex doe'],
    filingStopwords: ['alex'],
    categoryByDestination: [['Projects/Acme/Meetings', 'ACM']],
    categoryByContent: [['BD', ['biz dev']]],
    discoveryGroups: [{ parent: 'Projects/Clients', subdirs: ['Meetings', 'Calls'] }],
  });
});

test('normaliseProfile: is idempotent, so a read profile can be set as-is', () => {
  const once = normaliseProfile({
    selfNames: ['Alex'],
    categoryByDestination: [{ folder: 'Projects/Acme/Meetings', code: 'ACM' }],
    categoryByContent: [{ code: 'BD', keywords: ['biz dev'] }],
    discoveryGroups: [{ parent: 'Projects/Clients', subdirs: ['Meetings'] }],
  });
  assert.deepEqual(normaliseProfile(once), once);
  assert.deepEqual(setVaultProfile(once), once);
  setVaultProfile(null);
});

test('selfNameSet: "me" and "self" are always the user', () => {
  assert.deepEqual([...selfNameSet(normaliseProfile(null))], ['me', 'self']);
  assert.ok(selfNameSet(normaliseProfile({ selfNames: ['Alex'] })).has('alex'));
});

test('an empty profile names a note with no category and drops nobody by name', () => {
  setVaultProfile(null);
  assert.deepEqual(stripSelf('Alex Doe, Sam'), ['Alex', 'Sam']);
  assert.equal(
    buildObsidianFilename('/x/notes.md', {
      title: 'Acme kickoff',
      participants: 'Me, Sam',
      subdirectory: 'Projects/Acme/Meetings',
      startTime: '2026-09-08T15:00:00',
    }),
    'Sam 09.08.26.md'
  );

  setVaultProfile({
    selfNames: ['alex'],
    categoryByDestination: [{ folder: 'Projects/Acme/Meetings', code: 'ACM' }],
  });
  assert.equal(getVaultProfile().selfNames[0], 'alex');
  assert.equal(
    buildObsidianFilename('/x/notes.md', {
      title: 'Planning',
      participants: 'Alex, Sam',
      subdirectory: 'Projects/Acme/Meetings',
      startTime: '2026-09-08T15:00:00',
    }),
    'ACM Sam 09.08.26.md'
  );
  setVaultProfile(null);
});

test('readStoredProfile: reads the app config, and never throws without one', () => {
  const files = {
    '/home/Library/Application Support/cxnotes/config.json': JSON.stringify({
      vaultProfile: { selfNames: ['Alex'] },
      vaultFilingRules: [{ id: 'acme', destination: 'Projects/Acme/Meetings', keywords: ['acme'] }],
    }),
  };
  const fsImpl = {
    readFileSync: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    },
  };
  const stored = readStoredProfile({ home: '/home', fsImpl, storeDirNames: ['cxnotes'] });
  assert.deepEqual(stored.profile.selfNames, ['alex']);
  assert.equal(stored.filingRules.length, 1);

  const none = readStoredProfile({ home: '/nowhere', fsImpl, storeDirNames: ['cxnotes'] });
  assert.deepEqual(none.profile.selfNames, []);
  assert.deepEqual(none.filingRules, []);
});
