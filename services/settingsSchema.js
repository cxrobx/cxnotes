'use strict';

const { normalisePreference } = require('./llmProviders');
const { normaliseTransparency } = require('./glass');
const { normaliseVaultPath } = require('./vaultLocator');

/**
 * What `settings:update` is allowed to write, and what it does to each value on
 * the way in.
 *
 * The handler used to be twenty-four hand-written `if (x !== undefined)` blocks,
 * each repeating its own validation. Expressing it as a table makes two things
 * true that were not before: the whole accepted surface is readable in one
 * place, and the validation can be tested without Electron or a store.
 *
 * The governing rule is that a rejected value leaves the stored one alone.
 * Silently writing a bad value is worse than ignoring the update — a corrupt
 * `windowTransparency` paints every window invisible, and an unknown
 * `llmProvider` would have the UI showing a choice the resolver quietly
 * ignores.
 */

/** Silence auto-stop is offered between these, in minutes. */
const SILENCE_MIN_MINUTES = 1;
const SILENCE_MAX_MINUTES = 60;
const SILENCE_DEFAULT_MINUTES = 5;

/** Calendar banners can lead a meeting by at most this many minutes. */
const MAX_CALENDAR_LEAD_MINUTES = 15;

/** The calendar sources `createCalendarSource` knows how to build. */
const CALENDAR_SOURCES = ['auto', 'cxmail', 'macos'];

const accept = (value) => ({ ok: true, value });
const reject = { ok: false };

/** Anything at all — used where the renderer is the only writer and any value is legal. */
const anyValue = (v) => accept(v);

const booleanOnly = (v) => (typeof v === 'boolean' ? accept(v) : reject);

const oneOf = (allowed) => (v) => (allowed.includes(v) ? accept(v) : reject);

const numberInRange = (min, max) => (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? accept(n) : reject;
};

/** Trimmed non-empty strings only; anything else in the array is dropped. */
const stringArray = (v) => {
  if (!Array.isArray(v)) return reject;
  return accept(v.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean));
};

const arrayOnly = (v) => (Array.isArray(v) ? accept(v) : reject);

/**
 * Minutes of silence before the auto-stop prompt.
 *
 * Always accepts, because a nonsensical value should land on the default rather
 * than leave the previous one in place — this one has a safe answer, unlike the
 * validated fields above.
 */
function clampSilenceMinutes(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return SILENCE_DEFAULT_MINUTES;
  return Math.max(SILENCE_MIN_MINUTES, Math.min(SILENCE_MAX_MINUTES, n));
}

/**
 * Per-provider model overrides.
 *
 * A blank override is stored as ABSENT, so "cleared" and "never set" are one
 * state — both mean "use the pinned default", and a stored empty string would
 * defeat resolveModel (invariant #19).
 */
const modelOverrides = (providerIds) => (v) => {
  if (!v || typeof v !== 'object') return reject;
  const models = {};
  for (const id of providerIds) {
    const value = String(v[id] || '').trim();
    if (value) models[id] = value;
  }
  return accept(models);
};

/**
 * Build the key → coercer table.
 *
 * `providerIds` is a parameter rather than an import so the table can be tested
 * against a known provider set.
 */
function buildSettingCoercers(providerIds) {
  return {
    // Free-form: the renderer is the only writer and any value is legal.
    outputDirectory: anyValue,
    retentionDays: anyValue,
    autoProcess: anyValue,
    recordingMode: anyValue,
    micDevice: anyValue,
    systemLabel: anyValue,
    micLabel: anyValue,
    meetingContext: anyValue,
    meetingDetectionEnabled: anyValue,
    calendarSuggestionsEnabled: anyValue,

    // Validated: a bad value must leave the stored one untouched.
    calendarAutoTemplateEnabled: booleanOnly,
    silenceAutoStopEnabled: booleanOnly,
    vaultAutoFilingEnabled: booleanOnly,
    // Off by default. Slide capture points a camera at one window, and a
    // feature that records the screen is one the user turns ON, never one they
    // discover was already on.
    slideCaptureEnabled: booleanOnly,
    // Off by default, and switching it on asks macOS for System Audio
    // Recording — so it is only ever on because the user turned it on.
    callCaptureEnabled: booleanOnly,
    llmProviderStrict: booleanOnly,
    calendarLeadTimeMinutes: numberInRange(0, MAX_CALENDAR_LEAD_MINUTES),
    cxmailCalendarMinConfidence: numberInRange(0, 1),
    calendarSource: oneOf(CALENDAR_SOURCES),
    calendarDenylist: stringArray,
    // Entry validation happens later in mergeFilingRules, where a malformed
    // rule is dropped rather than being fatal.
    vaultFilingRules: arrayOnly,
    llmModels: modelOverrides(providerIds),

    // Normalised: always accepted, but never stored as given.
    silenceAutoStopMinutes: (v) => accept(clampSilenceMinutes(v)),
    // Normalised on the way IN as well as out, so an unknown id can never be
    // persisted and have the UI show a choice the resolver ignores.
    llmProvider: (v) => accept(normalisePreference(v)),
    // Likewise: a corrupt entry must not survive a round trip and paint every
    // window invisible.
    windowTransparency: (v) => accept(normaliseTransparency(v)),
    // Stored expanded and resolved so every consumer compares the same absolute
    // string. Empty stays '' rather than being deleted — that is the user
    // saying "no vault", and it must not re-trigger detection (invariant #17).
    vaultDirectory: (v) => accept(normaliseVaultPath(v) || '')
  };
}

/**
 * Decide what a settings patch should actually write.
 *
 * @param {object} patch - the renderer's partial settings object
 * @param {string[]} providerIds - known LLM provider ids
 * @returns {{accepted: object, rejected: string[], unknown: string[]}}
 */
function coerceSettings(patch, providerIds) {
  const coercers = buildSettingCoercers(providerIds);
  const accepted = {};
  const rejected = [];
  const unknown = [];

  for (const [key, raw] of Object.entries(patch || {})) {
    if (raw === undefined) continue;

    const coerce = coercers[key];
    if (!coerce) {
      unknown.push(key);
      continue;
    }

    const result = coerce(raw);
    if (result.ok) accepted[key] = result.value;
    else rejected.push(key);
  }

  return { accepted, rejected, unknown };
}

module.exports = {
  SILENCE_MIN_MINUTES,
  SILENCE_MAX_MINUTES,
  SILENCE_DEFAULT_MINUTES,
  MAX_CALENDAR_LEAD_MINUTES,
  CALENDAR_SOURCES,
  clampSilenceMinutes,
  buildSettingCoercers,
  coerceSettings
};
