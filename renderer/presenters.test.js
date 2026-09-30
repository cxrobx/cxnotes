'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  escapeHtml,
  formatFileSize,
  isRowProcessing,
  recordingBadges,
  recordingActions,
  renderRecordingItem,
  TOAST_KINDS,
  toastKind,
  renderToast
} = require('./presenters');

const kinds = (list) => list.map((b) => b.kind);

const REC = {
  filename: '2026-08-01_10-00-00_session',
  filepath: '/out/recordings/2026-08-01_10-00-00_session',
  size: 1048576,
  created: '2026-08-01T10:00:00Z',
  isDualTrack: true,
  transcribed: true,
  summarised: true,
  canResummarise: true,
  summaryFailed: null,
  processingError: null
};

/* ── escaping ────────────────────────────────────────────────── */

test('escapeHtml neutralises every character that can break out of markup', () => {
  assert.strictEqual(
    escapeHtml(`<img src=x onerror="alert('x')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;'
  );
});

test('escapeHtml turns null and undefined into an empty string', () => {
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
});

test('escapeHtml escapes the ampersand first, so entities are not double-built', () => {
  assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
});

/* ── file sizes ──────────────────────────────────────────────── */

test('formatFileSize scales through the units', () => {
  assert.strictEqual(formatFileSize(0), '0 B');
  assert.strictEqual(formatFileSize(512), '512 B');
  assert.strictEqual(formatFileSize(1024), '1 KB');
  assert.strictEqual(formatFileSize(1048576), '1 MB');
  assert.strictEqual(formatFileSize(1073741824), '1 GB');
});

test('formatFileSize keeps two decimal places', () => {
  assert.strictEqual(formatFileSize(1536), '1.5 KB');
  assert.strictEqual(formatFileSize(1234567), '1.18 MB');
});

test('formatFileSize clamps rather than printing an undefined unit', () => {
  // A petabyte-scale number is implausible, but "1.2 undefined" in the UI is
  // worse than an over-large GB figure.
  assert.match(formatFileSize(1024 ** 5), / GB$/);
});

/* ── which row is processing ─────────────────────────────────── */

test('nothing is processing when no path is set', () => {
  assert.strictEqual(isRowProcessing(REC, null), false);
});

test('an exact filepath match marks the row as processing', () => {
  assert.strictEqual(isRowProcessing(REC, REC.filepath), true);
});

test('a path inside the session also matches, via the filename', () => {
  // Progress events can carry a file inside the session directory rather than
  // the directory itself.
  assert.strictEqual(
    isRowProcessing(REC, '/out/recordings/2026-08-01_10-00-00_session/system.wav'),
    true
  );
});

test('an unrelated path does not mark the row', () => {
  assert.strictEqual(isRowProcessing(REC, '/out/recordings/2026-07-04_09-00-00_session'), false);
});

/* ── badges ──────────────────────────────────────────────────── */

test('a healthy session shows transcribed and summarised', () => {
  assert.deepStrictEqual(
    kinds(recordingBadges(REC, { isProcessing: false })),
    ['transcribed', 'summarised']
  );
});

test('dual-track is never announced as a badge', () => {
  // Dual is the default, so a badge for it appeared on every row and told the
  // reader nothing while crowding out the ones that matter.
  for (const isDualTrack of [true, false]) {
    const badges = recordingBadges({ ...REC, isDualTrack }, { isProcessing: false });
    assert.ok(!kinds(badges).includes('dual'), `isDualTrack=${isDualTrack}`);
  }
});

test('an untranscribed recording is badged as such', () => {
  const badges = recordingBadges({ ...REC, transcribed: false, summarised: false }, { isProcessing: false });
  assert.deepStrictEqual(kinds(badges), ['untranscribed']);
});

test('processing replaces the transcription badge rather than adding to it', () => {
  const badges = recordingBadges(REC, { isProcessing: true });

  assert.ok(kinds(badges).includes('processing'));
  assert.ok(!kinds(badges).includes('transcribed'), 'one status badge at a time');
});

test('a poisoned summary is NOT shown as Summarised', () => {
  // This is the whole point of the badge: a provider limit notice written as
  // the summary reads as finished work everywhere else, which is exactly how
  // the original incident stayed invisible (gotcha #12).
  const badges = recordingBadges(
    { ...REC, summaryFailed: "You've hit your session limit" },
    { isProcessing: false }
  );

  assert.ok(kinds(badges).includes('summary-failed'));
  assert.ok(!kinds(badges).includes('summarised'), 'a poisoned note must not read as done');
});

test('a processing error badge carries the message as its title', () => {
  const badges = recordingBadges({ ...REC, processingError: 'whisper exited 1' }, { isProcessing: false });
  const err = badges.find((b) => b.kind === 'error');

  assert.strictEqual(err.title, 'whisper exited 1');
});

/* ── actions ─────────────────────────────────────────────────── */

test('a transcribed session offers open, resummarise, reprocess and delete', () => {
  assert.deepStrictEqual(
    kinds(recordingActions(REC, 0)),
    ['open', 'resummarise', 'reprocess', 'delete']
  );
});

test('an untranscribed recording gains the process button', () => {
  assert.ok(kinds(recordingActions({ ...REC, transcribed: false }, 0)).includes('process'));
});

test('reprocess is offered for any session, not only failed ones', () => {
  // The failure that prompted this feature left NO error behind, so gating
  // reprocess on one made the broken note unrecoverable from the UI.
  const healthy = recordingActions(REC, 0);
  assert.ok(kinds(healthy).includes('reprocess'));
});

test('resummarise appears only when a transcript survives to reuse', () => {
  const without = recordingActions({ ...REC, canResummarise: false }, 0);
  assert.ok(!kinds(without).includes('resummarise'));
  assert.ok(kinds(without).includes('reprocess'), 'the full reprocess is still available');
});

test('a single-track recording gets neither session-only action', () => {
  const single = kinds(recordingActions({ ...REC, isDualTrack: false }, 0));
  assert.ok(!single.includes('reprocess'));
  assert.ok(!single.includes('resummarise'));
});

test('action ids are indexed so the click handlers can find them', () => {
  const ids = recordingActions(REC, 7).map((a) => a.id);
  assert.deepStrictEqual(ids, ['open-7', 'resummarise-7', 'reprocess-7', 'delete-7']);
});

test('delete is the only destructive action', () => {
  const dangerous = recordingActions(REC, 0).filter((a) => a.danger).map((a) => a.kind);
  assert.deepStrictEqual(dangerous, ['delete']);
});

/* ── the rendered row ────────────────────────────────────────── */

test('the rendered row carries the filepath and filename', () => {
  const html = renderRecordingItem(REC, { index: 0 });

  assert.match(html, /data-filepath="\/out\/recordings\/2026-08-01_10-00-00_session"/);
  assert.match(html, /2026-08-01_10-00-00_session<\/div>/);
  assert.match(html, /1 MB/);
});

test('a processing row gets the is-processing class', () => {
  const html = renderRecordingItem(REC, { index: 0, currentProcessingPath: REC.filepath });

  assert.match(html, /class="recording-item is-processing"/);
  assert.match(html, /badge-spinner/);
});

test('an idle row has no processing class', () => {
  assert.match(renderRecordingItem(REC, { index: 0 }), /class="recording-item"/);
});

test('a hostile filename cannot inject markup into the row', () => {
  const html = renderRecordingItem(
    { ...REC, filename: '<script>alert(1)</script>', filepath: '/x/"><b>' },
    { index: 0 }
  );

  assert.ok(!html.includes('<script>alert(1)</script>'), 'the filename must be escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('data-filepath="/x/"><b>"'), 'the path must not break the attribute');
});

test('a provider notice in summaryFailed cannot break out of the title attribute', () => {
  const html = renderRecordingItem(
    { ...REC, summaryFailed: 'limit " onmouseover="alert(1)' },
    { index: 0 }
  );

  assert.ok(!html.includes('onmouseover="alert(1)"'));
  assert.match(html, /&quot; onmouseover=&quot;/);
});

test('every action button appears in the markup with its id', () => {
  const html = renderRecordingItem(REC, { index: 3 });

  for (const id of ['open-3', 'resummarise-3', 'reprocess-3', 'delete-3']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should be rendered`);
  }
});

/* ── toasts ──────────────────────────────────────────────────── */

test('every toast kind has an icon, a title and a duration', () => {
  for (const [name, kind] of Object.entries(TOAST_KINDS)) {
    assert.ok(kind.icon, `${name} needs an icon`);
    assert.ok(kind.title, `${name} needs a title`);
    assert.ok(kind.duration > 0, `${name} needs a duration`);
  }
});

test('errors linger longer than every other kind', () => {
  // An error is the one toast you may need to read twice, or copy out of.
  for (const [name, kind] of Object.entries(TOAST_KINDS)) {
    if (name === 'error') continue;
    assert.ok(TOAST_KINDS.error.duration > kind.duration, `error should outlast ${name}`);
  }
});

test('an unknown toast kind falls back to info rather than rendering undefined', () => {
  assert.strictEqual(toastKind('banana'), TOAST_KINDS.info);
  assert.doesNotMatch(renderToast('hi', 'banana'), /undefined/);
});

test('a toast renders its icon, title and message', () => {
  const html = renderToast('Saved your settings', 'success');

  assert.match(html, /class="toast-title">Success</);
  assert.match(html, /class="toast-message">Saved your settings</);
  assert.match(html, /toast-close/);
});

test('a toast message is escaped', () => {
  // Toasts carry error text, which carries file paths and raw provider output.
  const html = renderToast('<img src=x onerror="alert(1)">', 'error');

  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x/);
});

test('a silent system track gets its own badge — nothing else on the row catches it', () => {
  // The failure that made this necessary: the recording transcribed, summarised
  // and filed without a single error, so every other badge on the row read as
  // success while the note held one side of a conversation (gotcha #15).
  const badges = recordingBadges({ ...REC, systemSilent: true }, { isProcessing: false });

  assert.deepStrictEqual(kinds(badges), ['transcribed', 'summarised', 'system-silent']);
  const silent = badges.find((b) => b.kind === 'system-silent');
  assert.strictEqual(silent.cls, 'badge-error', 'it is an error, not a warning');
  assert.match(silent.title, /only has your side/i);
});

test('a healthy recording carries no silent badge', () => {
  const badges = recordingBadges({ ...REC, systemSilent: false }, { isProcessing: false });
  assert.ok(!kinds(badges).includes('system-silent'));
});

test('a silent track and a poisoned summary are reported independently', () => {
  // Different causes, different fixes: one is re-summarise, the other is
  // unrecoverable. Collapsing them into one badge would suggest the wrong one.
  const badges = recordingBadges(
    { ...REC, systemSilent: true, summaryFailed: 'session limit reached' },
    { isProcessing: false }
  );

  assert.ok(kinds(badges).includes('system-silent'));
  assert.ok(kinds(badges).includes('summary-failed'));
  assert.ok(!kinds(badges).includes('summarised'));
});
