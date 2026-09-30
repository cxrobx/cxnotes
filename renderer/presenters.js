/**
 * Pure presentation helpers for the settings window.
 *
 * Loaded as a plain <script> before app.js — this renderer has no bundler, so
 * these are ordinary globals there. The `module.exports` at the bottom is what
 * lets `node --test` load the same file and check it, which is the whole reason
 * this is a separate file: everything here builds a string, and string-building
 * is exactly the kind of code that is easy to test and easy to get quietly
 * wrong.
 *
 * Nothing in here touches the DOM, IPC, or module state. Anything a presenter
 * needs is passed in.
 */

/**
 * Escape a value for interpolation into HTML.
 *
 * Load-bearing rather than decorative: `processingError` and `summaryFailed`
 * carry provider output and file paths straight into a `title` attribute, and
 * a stray quote there would break out of the attribute.
 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Byte units used in the settings window (shorter than the tray's). */
const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

/**
 * Human-readable file size, to two decimal places.
 *
 * The unit index is clamped, so an implausible size reads as a large number of
 * gigabytes rather than `1.2 undefined`.
 */
function formatFileSize(bytes) {
  if (!bytes) return `0 ${FILE_SIZE_UNITS[0]}`;

  const magnitude = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = Math.min(Math.max(magnitude, 0), FILE_SIZE_UNITS.length - 1);

  return `${Math.round((bytes / Math.pow(1024, unit)) * 100) / 100} ${FILE_SIZE_UNITS[unit]}`;
}

/**
 * Is this row the one currently being processed?
 *
 * The path match is deliberately loose in one direction: a session is
 * identified by its directory, but progress events can carry a path to a file
 * inside it, so a filename containment check backs up the exact match.
 */
function isRowProcessing(rec, currentProcessingPath) {
  if (!currentProcessingPath) return false;
  if (rec.filepath === currentProcessingPath) return true;
  return Boolean(rec.filepath && rec.filename && currentProcessingPath.includes(rec.filename));
}

/** `<span class="badge …">` helper. */
function badge(cls, text, title) {
  const attr = title === undefined ? '' : ` title="${escapeHtml(title)}"`;
  return `<span class="badge ${cls}"${attr}>${text}</span>`;
}

/**
 * Every badge a row should carry, in display order.
 *
 * Returned as data so the set can be asserted without parsing HTML. The rule
 * worth stating: a poisoned summary is NOT shown as "Summarised" — it would
 * otherwise read as finished work, which is exactly how the original incident
 * stayed invisible (gotcha #12).
 */
function recordingBadges(rec, { isProcessing }) {
  const badges = [];

  // No "Dual Track" badge. Dual is the default, so effectively every row had
  // one and it distinguished nothing — it just crowded out the badges that DO
  // carry information. `isDualTrack` still decides which action buttons a row
  // offers (see recordingActions), it simply is not worth saying out loud.

  if (isProcessing) {
    badges.push({ kind: 'processing', cls: 'badge-processing', text: 'Processing…' });
  } else if (rec.transcribed) {
    badges.push({ kind: 'transcribed', cls: 'badge-success', text: 'Transcribed' });
  } else {
    badges.push({ kind: 'untranscribed', cls: 'badge-warning', text: 'Not transcribed' });
  }

  if (rec.summarised && !rec.summaryFailed) {
    badges.push({ kind: 'summarised', cls: 'badge-success', text: 'Summarised' });
  }
  if (rec.summaryFailed) {
    badges.push({ kind: 'summary-failed', cls: 'badge-error', text: 'Summary failed', title: rec.summaryFailed });
  }
  // A silent system track fails nothing: it transcribes, summarises and files
  // like any other recording, so without its own badge the row is indis-
  // tinguishable from a complete one — which is how three of them went unnoticed.
  if (rec.systemSilent) {
    badges.push({
      kind: 'system-silent',
      cls: 'badge-error',
      text: 'No system audio',
      title: 'The system track recorded digital silence — this note only has your side of the conversation.'
    });
  }
  if (rec.processingError) {
    badges.push({ kind: 'error', cls: 'badge-error', text: 'Failed', title: rec.processingError });
  }

  return badges;
}

/**
 * Which action buttons a row offers.
 *
 * Reprocess is offered for ANY session, not only a failed one — the failure
 * that prompted the feature left no error behind, so gating on one made the
 * broken note unrecoverable from the UI. Re-summarise appears only when a
 * transcript survives to summarise from.
 */
function recordingActions(rec, index) {
  const actions = [{ kind: 'open', id: `open-${index}`, title: 'Open file', glyph: '&#x1F4C2;' }];

  if (!rec.transcribed) {
    actions.push({ kind: 'process', id: `process-${index}`, title: 'Process recording', glyph: '&#x2699;&#xFE0F;' });
  }
  if (rec.isDualTrack && rec.canResummarise) {
    actions.push({
      kind: 'resummarise',
      id: `resummarise-${index}`,
      title: 'Regenerate notes from the existing transcript (fast)',
      glyph: '&#x2728;'
    });
  }
  if (rec.isDualTrack) {
    actions.push({
      kind: 'reprocess',
      id: `reprocess-${index}`,
      title: 'Full reprocess: re-transcribe and re-summarise (slow)',
      glyph: '&#x1F504;'
    });
  }
  actions.push({ kind: 'delete', id: `delete-${index}`, title: 'Delete', glyph: '&#x1F5D1;&#xFE0F;', danger: true });

  return actions;
}

/**
 * One row of the recordings list.
 *
 * @param {object} rec - a row from the files:list IPC
 * @param {{index: number, currentProcessingPath: ?string}} ctx
 * @returns {string} HTML
 */
function renderRecordingItem(rec, { index, currentProcessingPath = null } = {}) {
  const isProcessing = isRowProcessing(rec, currentProcessingPath);
  const created = new Date(rec.created);

  const badgesHtml = recordingBadges(rec, { isProcessing })
    .map((b) => badge(b.cls, b.kind === 'processing' ? '<span class="badge-spinner"></span>Processing…' : b.text, b.title))
    .join('\n        ');

  const actionsHtml = recordingActions(rec, index)
    .map((a) => `<button class="icon-btn${a.danger ? ' danger' : ''}" id="${a.id}" title="${escapeHtml(a.title)}">${a.glyph}</button>`)
    .join('\n        ');

  return `
    <div class="recording-item${isProcessing ? ' is-processing' : ''}" data-filepath="${escapeHtml(rec.filepath || '')}">
      <div class="recording-info">
        <div class="recording-name">${escapeHtml(rec.filename)}</div>
        <div class="recording-meta">
          <span>${created.toLocaleDateString()} ${created.toLocaleTimeString()}</span>
          <span>${formatFileSize(rec.size)}</span>
        </div>
      </div>
      <div class="recording-badges">
        ${badgesHtml}
      </div>
      <div class="recording-actions">
        ${actionsHtml}
      </div>
    </div>
  `;
}

/**
 * Toast kinds: how each severity looks and how long it lingers.
 *
 * Errors stay longer than everything else because they are the one kind you
 * may need to read twice, or copy out of.
 */
const TOAST_KINDS = {
  success: { icon: '\u2705', title: 'Success', duration: 4000 },
  error: { icon: '\u274C', title: 'Error', duration: 6000 },
  warning: { icon: '\u26A0\uFE0F', title: 'Warning', duration: 4000 },
  info: { icon: '\u2139\uFE0F', title: 'Info', duration: 4000 }
};

/** Fall back to `info` rather than rendering `undefined` for an unknown kind. */
function toastKind(type) {
  return TOAST_KINDS[type] || TOAST_KINDS.info;
}

/**
 * Markup for one toast.
 *
 * The message is escaped: toasts carry error text, which carries file paths and
 * raw provider output, and neither is safe to drop into innerHTML unfiltered.
 */
function renderToast(message, type) {
  const kind = toastKind(type);
  return `
    <span class="toast-icon">${kind.icon}</span>
    <div class="toast-content">
      <div class="toast-title">${kind.title}</div>
      <div class="toast-message">${escapeHtml(message)}</div>
    </div>
    <button class="toast-close">&times;</button>
  `;
}

// Available to node --test; a no-op in the renderer, which has no `module`.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FILE_SIZE_UNITS,
    escapeHtml,
    formatFileSize,
    isRowProcessing,
    recordingBadges,
    recordingActions,
    renderRecordingItem,
    TOAST_KINDS,
    toastKind,
    renderToast
  };
}
