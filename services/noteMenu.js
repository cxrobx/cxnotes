'use strict';

/**
 * The note context menu, as data.
 *
 * Pure and Electron-free, in the same spirit as `trayMenu.js`: this returns a
 * plain array that main.js hands to the panel and the panel draws. Keeping the
 * *shape* of the menu here is what makes it testable, and the correctness of
 * this menu is entirely in its conditionals — every item is enabled or not
 * depending on whether a file is still on disk.
 *
 * Why the panel draws it instead of macOS. This used to be a real `NSMenu`
 * popped from main, which got three things for free: it escaped the window
 * bounds, it was keyboard-navigable, and it was styled correctly. Electron
 * exposes no styling control over an NSMenu, so matching the app's own glass
 * meant giving that up. The other two are now the renderer's job — it flips
 * and clamps the menu to stay inside the popover, and implements arrow-key
 * navigation — and neither is free, which is the honest cost of the change.
 *
 * The MODEL stays in main because main is the only side that can see the
 * filesystem, and "is this item enabled" is a question about files, not about
 * pixels. The renderer never decides what the menu contains (invariant #15).
 *
 * Option-key variants. Finder swaps "Copy" for "Copy as Pathname" while the
 * Option key is down, and the same gesture is wanted here: hold Option and
 * each Reveal becomes a Copy Path. An `alt` field on an item names that
 * variant. BOTH variants ship in the model, so the renderer only ever picks
 * which of two main-supplied entries to show — it still invents nothing. The
 * alt inherits its parent's `enabled`: a path that cannot be revealed cannot
 * be usefully copied either, and one gate means the two can never disagree.
 */

/**
 * Build the menu model for one note row.
 *
 * Paths are passed in already resolved — this module deliberately cannot touch
 * the filesystem, so a caller must do the existence checks and hand over only
 * paths it has confirmed, or null.
 *
 * @param {Object} paths
 * @param {string|null} paths.notePath - Exported note, if it still exists
 * @param {string|null} paths.transcriptPath - Merged transcript, if it exists
 * @param {string|null} paths.sessionDir - Session directory, if it exists
 * @returns {Array<Object>} Items: {type:'separator'} or
 *   {id, label, enabled, danger?, alt?: {id, label}} — `alt` is the item shown
 *   in its place while the Option key is held; it shares `enabled`.
 */
function buildNoteMenuItems({ notePath, transcriptPath, sessionDir } = {}) {
  return [
    {
      id: 'open',
      label: 'Open Note',
      enabled: !!notePath
    },
    {
      // Named "Note" because a second Reveal sits under it — "Reveal in Finder"
      // beside "Reveal Transcript in Finder" reads as though one of them
      // reveals something unspecified.
      id: 'revealNote',
      label: 'Reveal Note in Finder',
      enabled: !!notePath,
      alt: { id: 'copyNotePath', label: 'Copy Note Path' }
    },
    {
      id: 'revealTranscript',
      label: 'Reveal Transcript in Finder',
      // The transcript lives in processed/<session>/, NOT in the session
      // directory beside the audio, so this lands somewhere genuinely
      // different from the note above. It is disabled far more often than it
      // looks: the manifest records an ABSOLUTE path written at processing
      // time, so every session recorded under an older output directory names
      // a file that is no longer there.
      enabled: !!transcriptPath,
      alt: { id: 'copyTranscriptPath', label: 'Copy Transcript Path' }
    },
    { type: 'separator' },
    {
      id: 'delete',
      // The ellipsis is a promise that this asks first.
      label: 'Delete Recording and Note…',
      enabled: !!sessionDir,
      danger: true
    }
  ];
}

/**
 * The ids `buildNoteMenuItems` can emit — Option-key variants included — for
 * the action dispatcher to check.
 */
const NOTE_MENU_ACTIONS = Object.freeze([
  'open',
  'revealNote', 'copyNotePath',
  'revealTranscript', 'copyTranscriptPath',
  'delete'
]);

module.exports = {
  buildNoteMenuItems,
  NOTE_MENU_ACTIONS
};
