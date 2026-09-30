/**
 * Pure presentation helpers for the menu-bar panel.
 *
 * Loaded as a plain <script> before the panel's inline script — this renderer
 * has no bundler, so these are ordinary globals there. The `module.exports` at
 * the bottom is what lets `node --test` load the same file, which is the whole
 * reason this is a separate file rather than more inline script: the panel is
 * otherwise self-contained and therefore untestable.
 *
 * Nothing here touches the DOM or IPC.
 */

/**
 * How many attendees the collapsed line shows before it stops.
 *
 * Six is the largest number that still fits the popover's 396px width in about
 * two lines at 11px, which is the point of the collapse: the line is context,
 * not the content. A calendar invite to a mailing list carries hundreds of
 * addresses (a real one carried ~200, which rendered ~90 lines and pushed the
 * Stop button off the bottom of the window).
 */
const PARTICIPANT_PREVIEW_LIMIT = 6;

/**
 * Split a participants string into individual names.
 *
 * The app stores participants as one comma-joined string (`meetingContext`),
 * but a calendar description or a hand-typed pre-record entry can use
 * semicolons or newlines, so all three separate. Empty fragments are dropped —
 * a trailing comma is common and would otherwise render as a phantom attendee
 * in the count.
 */
function splitParticipants(value) {
  return String(value == null ? '' : value)
    .split(/[,;\n]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Describe a participants string for the panel: what to show collapsed, what
 * the "more" affordance should say, and the full list for the expanded state.
 *
 * `hidden` is deliberately the count of names NOT shown rather than the total,
 * because that is what the button reads out ("+194 more") and deriving it at
 * the call site is how the two drift apart.
 */
function summariseParticipants(value, limit = PARTICIPANT_PREVIEW_LIMIT) {
  const names = splitParticipants(value);
  const cap = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : PARTICIPANT_PREVIEW_LIMIT);
  const shown = names.slice(0, cap);
  const hidden = Math.max(0, names.length - shown.length);

  return {
    total: names.length,
    hidden,
    truncated: hidden > 0,
    preview: shown.join(', '),
    full: names.join(', '),
    moreLabel: hidden > 0 ? `+${hidden} more` : ''
  };
}

// Available to node --test; a no-op in the renderer, which has no `module`.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PARTICIPANT_PREVIEW_LIMIT,
    splitParticipants,
    summariseParticipants
  };
}
