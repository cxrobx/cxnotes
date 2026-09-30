/**
 * Pre-record popup — collects meeting context before recording starts.
 * Communicates with main process via IPC bridge (preload-prerecord.js).
 */

const api = window.preRecord;

// Pre-fill from last session's context
api.getContext().then(ctx => {
  if (ctx.title) document.getElementById('title').value = ctx.title;
  if (ctx.participants) document.getElementById('participants').value = ctx.participants;
  if (ctx.agenda) document.getElementById('agenda').value = ctx.agenda;
});

// Start recording with context
document.getElementById('btn-start').addEventListener('click', () => {
  const context = {
    title: document.getElementById('title').value.trim(),
    participants: document.getElementById('participants').value.trim(),
    agenda: document.getElementById('agenda').value.trim()
  };
  api.startWithContext(context);
});

// Skip — start recording with no context
document.getElementById('btn-skip').addEventListener('click', () => {
  api.startWithContext({ title: '', participants: '', agenda: '' });
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    document.getElementById('btn-start').click();
  }
  if (e.key === 'Escape') {
    api.cancel();
  }
});
