/**
 * Calendar source selector.
 *
 * `createCalendarSource` builds the active source: cxmail (primary) with the
 * macOS EventKit source as automatic fallback, chosen by the `calendarSource`
 * setting. cxmail catches meetings EventKit can't see — unaccepted `.ics` invites
 * and meetings detected from email bodies — while the fallback guarantees every
 * user keeps the original behaviour when cxmail isn't installed.
 */

const { MacOSCalendarSource } = require('./macOSCalendarSource');
const { GmailCalendarSource } = require('./gmailCalendarSource');
const { CxmailCalendarSource } = require('./cxmailCalendarSource');
const { FallbackCalendarSource } = require('./fallbackCalendarSource');

/**
 * Build the active calendar source. Always returns a source — the suggester
 * decides whether to actually poll based on `calendarSuggestionsEnabled`.
 *
 * @param {object} store - electron-store instance
 * @param {object} deps - injection bag
 * @param {string} deps.helperPath - macOS calendar-helper path
 * @param {Function} deps.spawn - child_process.spawn
 * @param {Function} deps.registerProcess - main.js's registerProcess
 * @returns {object} the FallbackCalendarSource
 */
function createCalendarSource(store, { helperPath, spawn, registerProcess }) {
  const macos = new MacOSCalendarSource({ helperPath, spawn, registerProcess });
  const cxmail = new CxmailCalendarSource({
    spawn,
    registerProcess,
    getMinConfidence: () => store.get('cxmailCalendarMinConfidence'),
  });
  return new FallbackCalendarSource({
    cxmail,
    macos,
    getMode: () => store.get('calendarSource'),
    onPick: (label, mode) => console.log(`[calendar] source → ${label} (mode=${mode})`),
  });
}

module.exports = {
  createCalendarSource,
  MacOSCalendarSource,
  GmailCalendarSource,
  CxmailCalendarSource,
  FallbackCalendarSource
};
