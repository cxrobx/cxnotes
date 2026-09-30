'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  estimateOffset, findMicGaps, offsetWindow, decideCompanionPath, regionsFromFrameLevels
} = require('./companionCoverage');

// A two-person call on the companion clock: the other side's turns, and the
// gaps between them where the mic owner speaks. Irregular on purpose, so only
// one offset lines them up.
const THEIR_TURNS = [
  [0, 38], [47, 61], [70, 96], [104, 117], [127, 160], [168, 181], [190, 222], [231, 240]
];
const OWN_TURNS_COMPANION = [[39.5, 45], [62.5, 68.5], [97, 102.5], [118, 125.5], [161.5, 166.5], [182, 188.5], [223, 229.5]];

const meetingSegments = THEIR_TURNS.map(([a, b]) => ({ source: 'meeting', timestamp: a, duration: b - a }));
const ownRegionsAt = (offset) => OWN_TURNS_COMPANION.map(([a, b]) => ({ start: a - offset, end: b - offset }));

test('estimateOffset: finds the one offset where own turns fall between theirs', () => {
  const fit = estimateOffset({
    ownRegions: ownRegionsAt(30),
    companionMeetingTurns: meetingSegments.map((s) => ({ start: s.timestamp, end: s.timestamp + s.duration })),
    minOffset: 0, maxOffset: 90
  });
  assert.strictEqual(fit.accepted, true, fit.reason);
  assert.ok(Math.abs(fit.offsetSec - 30) <= 1, `offset ${fit.offsetSec}`);
});

test('estimateOffset: refuses a fit where own speech lands on their turns wherever it goes', () => {
  // Own speech is continuous talk-over: no offset keeps it out of their turns.
  const own = [];
  for (let t = 0; t < 200; t += 8) own.push({ start: t, end: t + 7 });
  const fit = estimateOffset({
    ownRegions: own,
    companionMeetingTurns: meetingSegments.map((s) => ({ start: s.timestamp, end: s.timestamp + s.duration })),
    minOffset: 0, maxOffset: 60
  });
  assert.strictEqual(fit.accepted, false);
  assert.match(fit.reason, /poor fit|ambiguous/);
});

test('estimateOffset: refuses an ambiguous fit (a periodic call fits at several offsets)', () => {
  const theirs = [];
  const own = [];
  for (let t = 0; t < 400; t += 20) { theirs.push({ start: t, end: t + 14 }); own.push({ start: t + 15, end: t + 19 }); }
  const fit = estimateOffset({ ownRegions: own, companionMeetingTurns: theirs, minOffset: -30, maxOffset: 30 });
  assert.strictEqual(fit.accepted, false);
  assert.match(fit.reason, /ambiguous/);
});

test('estimateOffset: too little own speech is not fitted at all', () => {
  const fit = estimateOffset({
    ownRegions: [{ start: 1, end: 5 }],
    companionMeetingTurns: meetingSegments.map((s) => ({ start: s.timestamp, end: s.timestamp + s.duration })),
    minOffset: 0, maxOffset: 10
  });
  assert.strictEqual(fit.accepted, false);
  assert.match(fit.reason, /too little own speech/);
});

test('offsetWindow: a trailing-only trim gives an exact prior; an old two-ended trim a range', () => {
  const companionStartedAt = '2026-09-25T14:01:16.555Z';
  const recordingStartTime = '2026-09-25T14:10:14.979Z';
  const exact = offsetWindow({ companionStartedAt, recordingStartTime, micTrim: { trimmed: true, edge: 'trailing', leadingSec: 0, savedBytes: 999 } });
  assert.strictEqual(exact.priorExact, true);
  assert.ok(Math.abs(exact.prior - 538.424) < 0.01);
  // The 09-25 manifest: 102.9 s trimmed from both ends, split unknown.
  const old = offsetWindow({ companionStartedAt, recordingStartTime, micTrim: { trimmed: true, savedBytes: 3291970 } });
  assert.strictEqual(old.priorExact, false);
  assert.ok(old.minOffset < 538.424 && old.maxOffset > 538.424 + 102.8);
  // No companion start: a wide blind scan.
  assert.strictEqual(offsetWindow({ recordingStartTime }).priorExact, false);
});

test('decideCompanionPath: the 09-25 shape — no companion mic lines, own mic has speech → companion+own-mic', () => {
  const d = decideCompanionPath({
    segments: meetingSegments,
    micSilent: false,
    ownRegions: ownRegionsAt(30),
    window: { minOffset: 0, maxOffset: 90, priorExact: false }
  });
  assert.strictEqual(d.decision, 'companion+own-mic', d.reason);
  assert.ok(Math.abs(d.offsetSec - 30) <= 1);
  assert.strictEqual(d.companionMicLines, 0);
});

test('decideCompanionPath: no companion mic lines and no clock match → own full transcription', () => {
  const own = [];
  for (let t = 0; t < 200; t += 8) own.push({ start: t, end: t + 7 });
  const d = decideCompanionPath({
    segments: meetingSegments, micSilent: false, ownRegions: own,
    window: { minOffset: 0, maxOffset: 60, priorExact: false }
  });
  assert.strictEqual(d.decision, 'own', d.reason);
});

test('decideCompanionPath: a companion that carries the mic side is trusted', () => {
  const micLines = OWN_TURNS_COMPANION.map(([a, b]) => ({ source: 'mic', timestamp: a, duration: b - a }));
  const d = decideCompanionPath({
    segments: [...meetingSegments, ...micLines], micSilent: false, ownRegions: ownRegionsAt(30),
    window: { minOffset: 25, maxOffset: 35, priorExact: true }
  });
  assert.strictEqual(d.decision, 'companion', d.reason);
});

test('decideCompanionPath: a silent own mic never overrides the companion', () => {
  const d = decideCompanionPath({ segments: meetingSegments, micSilent: true, ownRegions: [], window: { minOffset: 0, maxOffset: 1, priorExact: true } });
  assert.strictEqual(d.decision, 'companion');
});

test('findMicGaps: a minute-plus with no companion mic line but own speech is a gap', () => {
  // Companion mic lines only in the first 60 s; own speech continues to 200 s.
  const lines = [{ start: 5, end: 10 }, { start: 30, end: 36 }, { start: 50, end: 55 }];
  const own = [];
  for (let t = 5; t < 200; t += 20) own.push({ start: t, end: t + 6 });
  const { gaps, uncoveredSpeechSec } = findMicGaps({ companionMicLines: lines, ownRegions: own, offsetSec: 0, spanEnd: 200 });
  assert.strictEqual(gaps.length, 1);
  assert.ok(gaps[0].start >= 55 && gaps[0].end >= 200);
  assert.ok(uncoveredSpeechSec >= 10);
});

test('findMicGaps: short pauses between covered lines are not gaps', () => {
  const lines = [];
  const own = [];
  for (let t = 0; t < 300; t += 40) { lines.push({ start: t, end: t + 6 }); own.push({ start: t, end: t + 6 }); }
  assert.strictEqual(findMicGaps({ companionMicLines: lines, ownRegions: own, offsetSec: 0, spanEnd: 300 }).gaps.length, 0);
});

test('regionsFromFrameLevels: speech above the room floor becomes regions; the floor does not', () => {
  const db = new Float64Array(1000).fill(-60);
  for (let i = 100; i < 300; i++) db[i] = -30; // 6 s at 30 ms frames
  for (let i = 500; i < 520; i++) db[i] = -30; // 0.6 s
  const regions = regionsFromFrameLevels(db, 0.03);
  assert.strictEqual(regions.length, 2);
  assert.ok(Math.abs(regions[0].start - 3) < 0.05 && Math.abs(regions[0].end - 9) < 0.05);
});
