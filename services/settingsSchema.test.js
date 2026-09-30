'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  SILENCE_DEFAULT_MINUTES,
  CALENDAR_SOURCES,
  clampSilenceMinutes,
  coerceSettings
} = require('./settingsSchema');

const IDS = ['codex', 'claude', 'ollama'];
const coerce = (patch) => coerceSettings(patch, IDS);

/* ── the governing rule ──────────────────────────────────────── */

test('an unknown key is neither written nor treated as a rejection', () => {
  const { accepted, unknown, rejected } = coerce({ somethingElse: 1 });

  assert.deepStrictEqual(accepted, {});
  assert.deepStrictEqual(unknown, ['somethingElse']);
  assert.deepStrictEqual(rejected, []);
});

test('an explicit undefined is skipped rather than written', () => {
  // The renderer sends a full object with holes; a hole means "unchanged".
  const { accepted } = coerce({ retentionDays: undefined, autoProcess: true });

  assert.deepStrictEqual(accepted, { autoProcess: true });
});

test('a rejected value leaves the stored one alone', () => {
  // This is the whole point: silently writing a bad value is worse than
  // ignoring the update.
  const { accepted, rejected } = coerce({ calendarSource: 'carrier-pigeon' });

  assert.deepStrictEqual(accepted, {});
  assert.deepStrictEqual(rejected, ['calendarSource']);
});

test('one bad key does not discard the good keys beside it', () => {
  const { accepted, rejected } = coerce({
    autoProcess: true,
    calendarLeadTimeMinutes: 999,
    micLabel: 'Me'
  });

  assert.deepStrictEqual(accepted, { autoProcess: true, micLabel: 'Me' });
  assert.deepStrictEqual(rejected, ['calendarLeadTimeMinutes']);
});

/* ── booleans ────────────────────────────────────────────────── */

test('boolean settings accept only real booleans', () => {
  for (const key of [
    'calendarAutoTemplateEnabled', 'silenceAutoStopEnabled',
    'vaultAutoFilingEnabled', 'llmProviderStrict'
  ]) {
    assert.deepStrictEqual(coerce({ [key]: true }).accepted, { [key]: true }, key);
    assert.deepStrictEqual(coerce({ [key]: false }).accepted, { [key]: false }, key);
    assert.deepStrictEqual(coerce({ [key]: 'true' }).rejected, [key], `${key} must reject a string`);
    assert.deepStrictEqual(coerce({ [key]: 1 }).rejected, [key], `${key} must reject a number`);
  }
});

/* ── numeric ranges ──────────────────────────────────────────── */

test('calendar lead time is accepted only within 0..15 minutes', () => {
  for (const good of [0, 5, 15, '10']) {
    assert.strictEqual(coerce({ calendarLeadTimeMinutes: good }).accepted.calendarLeadTimeMinutes, Number(good));
  }
  for (const bad of [-1, 16, 'soon', NaN, Infinity]) {
    assert.deepStrictEqual(coerce({ calendarLeadTimeMinutes: bad }).rejected, ['calendarLeadTimeMinutes'], String(bad));
  }
});

test('cxmail confidence is accepted only within 0..1', () => {
  assert.strictEqual(coerce({ cxmailCalendarMinConfidence: 0.7 }).accepted.cxmailCalendarMinConfidence, 0.7);
  assert.strictEqual(coerce({ cxmailCalendarMinConfidence: 0 }).accepted.cxmailCalendarMinConfidence, 0);
  assert.strictEqual(coerce({ cxmailCalendarMinConfidence: 1 }).accepted.cxmailCalendarMinConfidence, 1);
  assert.deepStrictEqual(coerce({ cxmailCalendarMinConfidence: 1.5 }).rejected, ['cxmailCalendarMinConfidence']);
});

/* ── silence minutes: clamped, never rejected ────────────────── */

test('silence minutes clamps into 1..60', () => {
  assert.strictEqual(clampSilenceMinutes(0), 1);
  assert.strictEqual(clampSilenceMinutes(1), 1);
  assert.strictEqual(clampSilenceMinutes(30), 30);
  assert.strictEqual(clampSilenceMinutes(60), 60);
  assert.strictEqual(clampSilenceMinutes(999), 60);
  assert.strictEqual(clampSilenceMinutes(-5), 1);
});

test('silence minutes rounds rather than truncating', () => {
  assert.strictEqual(clampSilenceMinutes(4.6), 5);
  assert.strictEqual(clampSilenceMinutes('7.2'), 7);
});

test('an unusable silence value lands on the default instead of being rejected', () => {
  // Unlike the validated fields, this one has a safe answer, so it is always
  // written rather than leaving a stale value behind.
  assert.strictEqual(clampSilenceMinutes('nonsense'), SILENCE_DEFAULT_MINUTES);
  assert.strictEqual(clampSilenceMinutes(undefined), SILENCE_DEFAULT_MINUTES);
  assert.strictEqual(coerce({ silenceAutoStopMinutes: 'nonsense' }).rejected.length, 0);
  assert.strictEqual(coerce({ silenceAutoStopMinutes: 'nonsense' }).accepted.silenceAutoStopMinutes, SILENCE_DEFAULT_MINUTES);
});

/* ── enums and arrays ────────────────────────────────────────── */

test('every calendar source the app can build is accepted', () => {
  for (const src of CALENDAR_SOURCES) {
    assert.strictEqual(coerce({ calendarSource: src }).accepted.calendarSource, src);
  }
});

test('the calendar denylist keeps only trimmed non-empty strings', () => {
  const { accepted } = coerce({ calendarDenylist: ['  Lunch ', '', 'Gym', 42, null, '   '] });

  assert.deepStrictEqual(accepted.calendarDenylist, ['Lunch', 'Gym']);
});

test('a non-array denylist is rejected outright', () => {
  assert.deepStrictEqual(coerce({ calendarDenylist: 'Lunch' }).rejected, ['calendarDenylist']);
});

test('filing rules must be an array, but entries are not validated here', () => {
  // mergeFilingRules drops malformed entries at classification time, where a
  // bad rule is non-fatal.
  const rules = [{ id: 'qrs' }, 'nonsense'];
  assert.deepStrictEqual(coerce({ vaultFilingRules: rules }).accepted.vaultFilingRules, rules);
  assert.deepStrictEqual(coerce({ vaultFilingRules: {} }).rejected, ['vaultFilingRules']);
});

/* ── model overrides ─────────────────────────────────────────── */

test('a blank model override is stored as absent, not as an empty string', () => {
  // "Cleared" and "never set" must be one state — both mean "use the pinned
  // default", and a stored '' would defeat resolveModel (invariant #19).
  const { accepted } = coerce({ llmModels: { codex: 'gpt-5.5', claude: '   ', ollama: '' } });

  assert.deepStrictEqual(accepted.llmModels, { codex: 'gpt-5.5' });
});

test('model overrides for unknown providers are dropped', () => {
  const { accepted } = coerce({ llmModels: { codex: 'gpt-5.5', notAProvider: 'x' } });

  assert.deepStrictEqual(accepted.llmModels, { codex: 'gpt-5.5' });
});

test('a non-object llmModels is rejected', () => {
  assert.deepStrictEqual(coerce({ llmModels: 'gpt-5.5' }).rejected, ['llmModels']);
  assert.deepStrictEqual(coerce({ llmModels: null }).rejected, ['llmModels']);
});

/* ── normalised-on-the-way-in fields ─────────────────────────── */

test('an unknown provider id is normalised rather than persisted', () => {
  // Persisting it would leave the UI showing a choice the resolver ignores.
  const { accepted, rejected } = coerce({ llmProvider: 'not-a-provider' });

  assert.strictEqual(rejected.length, 0);
  assert.strictEqual(accepted.llmProvider, 'auto');
});

test('a known provider id passes through', () => {
  assert.strictEqual(coerce({ llmProvider: 'claude' }).accepted.llmProvider, 'claude');
});

test('transparency is normalised on the way in, so a corrupt value cannot round-trip', () => {
  assert.strictEqual(coerce({ windowTransparency: 0.5 }).accepted.windowTransparency, 0.5);
  assert.strictEqual(coerce({ windowTransparency: 99 }).accepted.windowTransparency, 1);
  assert.strictEqual(coerce({ windowTransparency: -3 }).accepted.windowTransparency, 0);
});

test('an empty vault directory is stored as empty string, not dropped', () => {
  // That is the user saying "no vault"; it must not re-trigger detection
  // (invariant #17).
  const { accepted } = coerce({ vaultDirectory: '' });

  assert.ok('vaultDirectory' in accepted);
  assert.strictEqual(accepted.vaultDirectory, '');
});

test('a vault directory is stored expanded and resolved', () => {
  const { accepted } = coerce({ vaultDirectory: '~/Documents/CX' });

  assert.ok(accepted.vaultDirectory.startsWith('/'), 'must be absolute');
  assert.ok(!accepted.vaultDirectory.includes('~'), 'tilde must be expanded');
});

/* ── the whole accepted surface ──────────────────────────────── */

test('the accepted key set has not drifted', () => {
  const everyKey = {
    outputDirectory: '/tmp', retentionDays: 7, autoProcess: true, recordingMode: 'dual',
    micDevice: 'Mic', systemLabel: 'Remote', micLabel: 'Me', meetingContext: {},
    meetingDetectionEnabled: true, calendarSuggestionsEnabled: true,
    calendarAutoTemplateEnabled: true, silenceAutoStopEnabled: true,
    vaultAutoFilingEnabled: true, llmProviderStrict: false,
    calendarLeadTimeMinutes: 5, cxmailCalendarMinConfidence: 0.7,
    calendarSource: 'auto', calendarDenylist: [], vaultFilingRules: [],
    llmModels: {}, silenceAutoStopMinutes: 5, llmProvider: 'auto',
    windowTransparency: 0.38, vaultDirectory: '',
    slideCaptureEnabled: false, callCaptureEnabled: false
  };

  const { accepted, rejected, unknown } = coerce(everyKey);

  assert.deepStrictEqual(rejected, [], 'every key above should be valid');
  assert.deepStrictEqual(unknown, [], 'every key above should be known');
  assert.strictEqual(Object.keys(accepted).length, 26);
});
