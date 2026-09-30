'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PreparedMeetingStore, fingerprintToBase } = require('./preparedMeetingStore');

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n4c-prepared-'));
  const preparedDir = path.join(root, 'prepared');
  const tmpDir = path.join(root, 'tmp');
  return { store: new PreparedMeetingStore({ preparedDir, tmpDir }), root, preparedDir, tmpDir };
}

function makeRecord(overrides = {}) {
  return {
    occurrenceFingerprint: overrides.occurrenceFingerprint || 'cal:ABC123:2026-06-17T15:00:00Z',
    eventId: overrides.eventId || 'evt-1',
    title: overrides.title ?? 'Project Kickoff',
    startTime: overrides.startTime ?? '2026-06-17T15:00:00Z',
    endTime: overrides.endTime ?? '2026-06-17T15:30:00Z',
    template: overrides.template ?? { markdown: '# Project Kickoff' },
    source: overrides.source || 'mcp',
    ...overrides,
  };
}

test('prepare → getByFingerprint round-trip; normalises schemaVersion + expiresAt', () => {
  const { store } = makeStore();
  const rec = makeRecord();
  const res = store.prepare(rec);
  assert.equal(res.ok, true);
  assert.equal(res.record.schemaVersion, 1);
  assert.ok(res.record.expiresAt, 'expiresAt computed');
  // expiresAt = endTime + grace (1h)
  assert.ok(Date.parse(res.record.expiresAt) > Date.parse(rec.endTime));

  const got = store.getByFingerprint(rec.occurrenceFingerprint);
  assert.equal(got.occurrenceFingerprint, rec.occurrenceFingerprint);
  assert.deepEqual(got.template, { markdown: '# Project Kickoff' });
});

test('prepare: rejects record without fingerprint, never throws', () => {
  const { store } = makeStore();
  const res = store.prepare({ title: 'no fp' });
  assert.equal(res.ok, false);
  assert.match(res.error, /occurrenceFingerprint/);
});

test('list: returns live records, skips corrupt files', () => {
  const { store, preparedDir } = makeStore();
  store.prepare(makeRecord({ occurrenceFingerprint: 'cal:A:1' }));
  store.prepare(makeRecord({ occurrenceFingerprint: 'cal:B:2' }));
  // Drop a corrupt .json file
  fs.writeFileSync(path.join(preparedDir, 'cal_corrupt.json'), '{not valid', 'utf8');

  const list = store.list();
  assert.equal(list.length, 2, 'corrupt file skipped, 2 valid returned');
  const fps = list.map((r) => r.occurrenceFingerprint).sort();
  assert.deepEqual(fps, ['cal:A:1', 'cal:B:2']);
});

test('claim: atomic rename .json → .applied; live read now null', () => {
  const { store, preparedDir } = makeStore();
  const rec = makeRecord();
  store.prepare(rec);

  const claimed = store.claim(rec.occurrenceFingerprint);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.record.occurrenceFingerprint, rec.occurrenceFingerprint);

  const base = fingerprintToBase(rec.occurrenceFingerprint);
  assert.ok(fs.existsSync(path.join(preparedDir, base + '.applied')), '.applied file present');
  assert.ok(!fs.existsSync(path.join(preparedDir, base + '.json')), '.json gone');
  assert.equal(store.getByFingerprint(rec.occurrenceFingerprint), null, 'live read null after claim');
});

test('claim: second claimer loses with ENOENT → not-found (no throw)', () => {
  const { store } = makeStore();
  const rec = makeRecord();
  store.prepare(rec);

  const first = store.claim(rec.occurrenceFingerprint);
  const second = store.claim(rec.occurrenceFingerprint);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'not-found');
});

test('claim: unknown fingerprint → not-found', () => {
  const { store } = makeStore();
  const res = store.claim('cal:never:prepared');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-found');
});

test('cancel: renames live → .cancelled; getByFingerprint null', () => {
  const { store, preparedDir } = makeStore();
  const rec = makeRecord();
  store.prepare(rec);

  const res = store.cancel(rec.occurrenceFingerprint);
  assert.equal(res.ok, true);
  const base = fingerprintToBase(rec.occurrenceFingerprint);
  assert.ok(fs.existsSync(path.join(preparedDir, base + '.cancelled')));
  assert.equal(store.getByFingerprint(rec.occurrenceFingerprint), null);
  // cancelling a non-existent one is graceful
  assert.equal(store.cancel('cal:missing:x').reason, 'not-found');
});

test('pruneExpired: removes past-expiry records, keeps live ones', () => {
  const { store } = makeStore();
  const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  store.prepare(makeRecord({ occurrenceFingerprint: 'cal:old:1', endTime: past, expiresAt: past }));
  store.prepare(makeRecord({ occurrenceFingerprint: 'cal:new:2', endTime: future, expiresAt: future }));

  const removed = store.pruneExpired(Date.now());
  assert.equal(removed, 1);
  assert.equal(store.getByFingerprint('cal:old:1'), null);
  assert.ok(store.getByFingerprint('cal:new:2'));
});

test('fingerprintToBase: filesystem-safe + deterministic', () => {
  const a = fingerprintToBase('cal:ABC123:2026-06-17T15:00:00Z');
  const b = fingerprintToBase('cal:ABC123:2026-06-17T15:00:00Z');
  assert.equal(a, b);
  assert.match(a, /^cal_[A-Za-z0-9_]+$/);
  assert.ok(!a.includes(':'));
  assert.ok(!a.includes('/'));
});
