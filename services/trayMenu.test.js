'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  UPCOMING_SOON_MS,
  UPCOMING_TITLE_MAX,
  UPCOMING_LIMIT,
  formatDuration,
  buildUpcomingItems,
  buildTrayMenuTemplate
} = require('./trayMenu');

/** Every action, recorded rather than performed. */
function spyActions() {
  const called = [];
  const names = [
    'startRecording', 'stopRecording', 'dropMarker', 'startFromUpcoming',
    'showPanel', 'openSettings', 'openRecordingsFolder', 'openProcessedFolder',
    'refreshDependencies', 'showDependencyStatus', 'runSetupScript',
    'showStorageStats', 'runCleanup', 'quit'
  ];
  const actions = { called };
  for (const n of names) actions[n] = (...args) => called.push([n, ...args]);
  return actions;
}

const IDLE = { isRecording: false, isDualMode: true, canRecord: true };
const labelsOf = (t) => t.filter((i) => i.label).map((i) => i.label);
const find = (t, re) => t.find((i) => i.label && re.test(i.label));

/* ── formatDuration ──────────────────────────────────────────── */

test('formatDuration uses M:SS below an hour', () => {
  assert.strictEqual(formatDuration(0), '0:00');
  assert.strictEqual(formatDuration(9000), '0:09');
  assert.strictEqual(formatDuration(65000), '1:05');
  assert.strictEqual(formatDuration(1476000), '24:36');
});

test('formatDuration grows to H:MM:SS past an hour', () => {
  assert.strictEqual(formatDuration(3600000), '1:00:00');
  assert.strictEqual(formatDuration(3661000), '1:01:01');
  assert.strictEqual(formatDuration(45296000), '12:34:56');
});

test('formatDuration never renders negative time', () => {
  // Clock adjustments mid-recording can make an elapsed figure go backwards;
  // "-1:-3" in the menu bar would look like a crash.
  assert.strictEqual(formatDuration(-5000), '0:00');
});

/* ── the start/stop control ──────────────────────────────────── */

test('idle offers Start, recording offers Stop', () => {
  const idle = buildTrayMenuTemplate(IDLE, spyActions());
  const live = buildTrayMenuTemplate({ ...IDLE, isRecording: true }, spyActions());

  assert.match(idle[0].label, /Start Recording/);
  assert.match(live[0].label, /Stop Recording/);
});

test('the first item routes to the matching action', () => {
  const a = spyActions();
  buildTrayMenuTemplate(IDLE, a)[0].click();
  assert.deepStrictEqual(a.called, [['startRecording']]);

  const b = spyActions();
  buildTrayMenuTemplate({ ...IDLE, isRecording: true }, b)[0].click();
  assert.deepStrictEqual(b.called, [['stopRecording']]);
});

test('Start is disabled when system audio is unavailable', () => {
  const t = buildTrayMenuTemplate({ ...IDLE, canRecord: false }, spyActions());
  assert.strictEqual(t[0].enabled, false);
});

test('Stop stays enabled even when dependencies have broken', () => {
  // A recording already in progress must always be stoppable; gating it on a
  // dependency check is how you end up unable to save a live meeting.
  const t = buildTrayMenuTemplate({ ...IDLE, isRecording: true, canRecord: false }, spyActions());
  assert.strictEqual(t[0].enabled, true);
});

/* ── the marker item ─────────────────────────────────────────── */

test('Drop Marker appears only while recording, with its accelerator', () => {
  const idle = buildTrayMenuTemplate(IDLE, spyActions());
  assert.strictEqual(find(idle, /Drop Marker/), undefined);

  const live = buildTrayMenuTemplate(
    { ...IDLE, isRecording: true, markerAccelerator: 'CommandOrControl+Shift+M' },
    spyActions()
  );
  const marker = find(live, /Drop Marker/);
  assert.ok(marker, 'marker item must exist while recording');
  assert.strictEqual(marker.accelerator, 'CommandOrControl+Shift+M');
});

/* ── the status readout ──────────────────────────────────────── */

test('the status line reports mode and elapsed time while recording', () => {
  const t = buildTrayMenuTemplate(
    { ...IDLE, isRecording: true, durationMs: 1476000 },
    spyActions()
  );
  const status = find(t, /^Recording/);

  assert.strictEqual(status.label, 'Recording (Dual Track): 24:36');
  assert.strictEqual(status.enabled, false, 'a readout, not a control');
});

test('the status line distinguishes ready from broken when idle', () => {
  assert.strictEqual(find(buildTrayMenuTemplate(IDLE, spyActions()), /Ready/).label, 'Ready (Dual Track)');
  assert.strictEqual(
    find(buildTrayMenuTemplate({ ...IDLE, isDualMode: false }, spyActions()), /Ready/).label,
    'Ready (System Only)'
  );
  assert.ok(find(buildTrayMenuTemplate({ ...IDLE, canRecord: false }, spyActions()), /Dependencies missing/));
});

/* ── upcoming meetings ───────────────────────────────────────── */

const NOW = Date.parse('2026-08-07T15:00:00Z');
const meetingAt = (offsetMin, title = 'Standup') => ({
  title,
  startTime: new Date(NOW + offsetMin * 60000).toISOString()
});

test('upcoming meetings are listed under a disabled header', () => {
  const t = buildTrayMenuTemplate(
    { ...IDLE, nowMs: NOW, upcoming: [meetingAt(60, 'Design review')] },
    spyActions()
  );

  const header = find(t, /Upcoming on your calendar/);
  assert.ok(header);
  assert.strictEqual(header.enabled, false);
  assert.ok(find(t, /Design review/));
});

test('a meeting inside the soon window is flagged', () => {
  const soon = buildTrayMenuTemplate(
    { ...IDLE, nowMs: NOW, upcoming: [meetingAt(5)] }, spyActions()
  );
  const later = buildTrayMenuTemplate(
    { ...IDLE, nowMs: NOW, upcoming: [meetingAt(120)] }, spyActions()
  );

  assert.match(find(soon, /Standup/).label, /🟢/);
  assert.match(find(soon, /Standup/).label, /\(soon\)/);
  assert.match(find(later, /Standup/).label, /⏱/);
  assert.doesNotMatch(find(later, /Standup/).label, /\(soon\)/);
});

test('the soon boundary is exactly UPCOMING_SOON_MS', () => {
  const at = (ms) => buildTrayMenuTemplate(
    { ...IDLE, nowMs: NOW, upcoming: [{ title: 'X', startTime: new Date(NOW + ms).toISOString() }] },
    spyActions()
  );
  assert.match(find(at(UPCOMING_SOON_MS), /X/).label, /🟢/, 'exactly at the boundary counts as soon');
  assert.match(find(at(UPCOMING_SOON_MS + 1000), /X/).label, /⏱/);
});

test('a long meeting title is truncated with an ellipsis', () => {
  const long = 'Quarterly planning and roadmap alignment across every team';
  const t = buildTrayMenuTemplate({ ...IDLE, nowMs: NOW, upcoming: [meetingAt(60, long)] }, spyActions());
  const item = t.find((i) => i.label && i.label.includes('…'));

  assert.ok(item, 'a long title should be shortened');
  assert.ok(item.label.length < long.length + 20);
});

test('an unparseable start time still renders a clickable row', () => {
  const t = buildTrayMenuTemplate(
    { ...IDLE, nowMs: NOW, upcoming: [{ title: 'Mystery', startTime: 'not-a-date' }] },
    spyActions()
  );
  const item = find(t, /Mystery/);

  assert.ok(item, 'a bad date must not drop the meeting');
  assert.match(item.label, /⏱ Mystery/, 'no time shown, but still listed');
});

test('the upcoming list is capped', () => {
  const many = Array.from({ length: 12 }, (_, i) => meetingAt(60 + i, `Meeting ${i}`));
  const items = buildUpcomingItems(many, { nowMs: NOW, onPick: () => {} });

  // Two rows of chrome (separator + header) plus the capped meetings.
  assert.strictEqual(items.length, 2 + UPCOMING_LIMIT);
});

test('clicking a meeting passes that meeting back', () => {
  const a = spyActions();
  const meeting = meetingAt(60, 'Design review');
  const t = buildTrayMenuTemplate({ ...IDLE, nowMs: NOW, upcoming: [meeting] }, a);

  find(t, /Design review/).click();

  assert.deepStrictEqual(a.called, [['startFromUpcoming', meeting]]);
});

test('upcoming meetings are hidden while recording', () => {
  // Starting a calendar meeting mid-recording would silently abandon the one
  // already running.
  const t = buildTrayMenuTemplate(
    { ...IDLE, isRecording: true, nowMs: NOW, upcoming: [meetingAt(5)] },
    spyActions()
  );
  assert.strictEqual(find(t, /Upcoming on your calendar/), undefined);
});

test('no upcoming meetings means no header and no separator for it', () => {
  const t = buildTrayMenuTemplate({ ...IDLE, upcoming: [] }, spyActions());
  assert.strictEqual(find(t, /Upcoming/), undefined);
  assert.deepStrictEqual(buildUpcomingItems([], { nowMs: NOW, onPick: () => {} }), []);
});

/* ── the rest of the menu ────────────────────────────────────── */

test('every remaining entry is present and in order', () => {
  const labels = labelsOf(buildTrayMenuTemplate(IDLE, spyActions()));

  assert.deepStrictEqual(labels, [
    '⏺  Start Recording',
    'Ready (Dual Track)',
    'Open Panel',
    'Settings...',
    'Open Recordings Folder',
    'View Processed Notes',
    'Refresh Dependencies',
    'Check Dependencies',
    'Run Setup Script',
    'Storage Stats',
    'Cleanup Old Recordings',
    'Quit'
  ]);
});

test('every clickable item routes to its own action, and none fire early', () => {
  const a = spyActions();
  const t = buildTrayMenuTemplate(IDLE, a);

  assert.deepStrictEqual(a.called, [], 'building the menu must not perform anything');

  for (const item of t) if (item.click) item.click();

  assert.deepStrictEqual(a.called.map((c) => c[0]), [
    'startRecording', 'showPanel', 'openSettings', 'openRecordingsFolder',
    'openProcessedFolder', 'refreshDependencies', 'showDependencyStatus',
    'runSetupScript', 'showStorageStats', 'runCleanup', 'quit'
  ]);
});

test('the menu is grouped into sections by separators', () => {
  const t = buildTrayMenuTemplate(IDLE, spyActions());
  assert.strictEqual(t.filter((i) => i.type === 'separator').length, 5);
});
