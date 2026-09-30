'use strict';

/**
 * Meeting template builder — pure, Electron-free, zero-dependency.
 *
 * Absorbs the three helpers that used to live inline in main.js
 * (buildAgendaFromNotes, attendeeDisplayName, buildPreRecordSeedFromEvent) and
 * adds the calendar-driven "smart templated meeting" surface:
 *
 *   - buildMeetingContext(event)  — the backward-compatible superset. Carries
 *     the flat {title, participants, agenda} the recorder/summariser already
 *     expect (invariant #2) PLUS the rich fields (attendees, organiser, times,
 *     joinUrl) the skeleton renders from.
 *   - renderSkeletonMarkdown(ctx) — a structured note skeleton (YAML frontmatter
 *     + Agenda + Attendees + scaffolded sections) written to
 *     `<sessionDir>/meeting-skeleton.md`. The human jots live notes here; the AI
 *     summary still lands in `notes.md` — they never collide.
 *
 * Both the in-app apply path and the MCP read path build templates from THIS
 * module so they can never drift.
 *
 * British English throughout (invariant #4): "organiser", "summarise".
 */

// Known video-call hosts. Reused for both stripping join boilerplate out of the
// agenda AND extracting the canonical join URL. Kept in sync with the legacy
// regex that buildAgendaFromNotes has always used.
const JOIN_HOSTS = ['zoom.us', 'meet.google.com', 'teams.microsoft.com', 'teams.live.com'];
const JOIN_HOST_RE = /(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com)/i;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/**
 * The scaffolded note sections, mirroring the summariser's fixed dual-track
 * sections (services/summariser.js → generateSessionNotes). Keeping the human's
 * live-notes skeleton aligned with what the AI later produces means the two
 * documents read as one. Agenda + Attendees are rendered separately above these
 * (they come from the calendar invite, not from note-taking).
 */
const SKELETON_SECTIONS = Object.freeze([
  { heading: 'Meeting Purpose', hint: 'Why are we meeting? What outcome do we want?' },
  { heading: 'Key Takeaways', hint: 'The most important outcomes or decisions.' },
  { heading: 'Topics Discussed', hint: 'Points raised, organised by topic.' },
  { heading: 'Action Items', hint: '- [ ] [Owner] Action item' },
  { heading: 'My Commitments', hint: 'Things I agreed to do or follow up on.' },
  { heading: 'Their Commitments', hint: 'Things the other side agreed to do.' },
  { heading: 'Problems / Blockers', hint: 'Issues raised, and by whom.' },
  { heading: 'Solutions / Proposals', hint: 'Solutions discussed, and who proposed them.' },
  { heading: 'Next Steps', hint: 'Agreed next steps and timeline.' },
]);

/**
 * Strip URLs and common meeting-join boilerplate from event notes so the agenda
 * doesn't fill with Zoom/Meet/Teams junk. Cheap regex pass — not a full HTML
 * parse. (Verbatim behaviour of the old main.js helper.)
 */
function buildAgendaFromNotes(notes) {
  if (typeof notes !== 'string' || !notes) return '';
  const cleaned = notes
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^.*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com)\S*.*$/gim, '')
    .replace(/^.*Join Zoom Meeting.*$/gim, '')
    .replace(/^.*Meeting ID:.*$/gim, '')
    .replace(/^.*Passcode:.*$/gim, '')
    .replace(/^.*Join Microsoft Teams.*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.slice(0, 500);
}

/**
 * Convert an attendee record into a display name, falling back to the local-part
 * of the email when no name is set (Google Calendar often returns only emails).
 * Returns null when neither is usable. (Verbatim behaviour of the old helper.)
 */
function attendeeDisplayName(attendee) {
  if (!attendee) return null;
  if (typeof attendee.name === 'string' && attendee.name.trim()) return attendee.name.trim();
  if (typeof attendee.email === 'string' && attendee.email.includes('@')) {
    return attendee.email.split('@')[0];
  }
  return null;
}

/**
 * Map a calendar event into the pre-record popup's seed shape.
 *   title        — event.title
 *   participants — other attendees (current user excluded), joined "Alice, Bob"
 *   agenda       — first 500 chars of event.notes, URLs/boilerplate stripped
 * (Verbatim behaviour of the old main.js helper — kept so the existing pre-record
 * popup path is byte-for-byte unchanged.)
 */
function buildPreRecordSeedFromEvent(event) {
  if (!event) return null;
  const attendees = Array.isArray(event.attendees) ? event.attendees : [];
  const others = attendees
    .filter((a) => !a.isCurrentUser)
    .map(attendeeDisplayName)
    .filter(Boolean);
  return {
    title: typeof event.title === 'string' ? event.title : '',
    participants: others.join(', '),
    agenda: buildAgendaFromNotes(event.notes),
  };
}

/**
 * Pull the canonical video-call join URL from an event: location field first
 * (calendars usually put the link there), then the notes body. Returns the first
 * URL whose host is a known meeting host, or null.
 */
function extractJoinUrl(event) {
  if (!event) return null;
  const sources = [];
  if (typeof event.location === 'string' && event.location) sources.push(event.location);
  if (typeof event.notes === 'string' && event.notes) sources.push(event.notes);

  for (const text of sources) {
    const urls = text.match(URL_RE) || [];
    for (const raw of urls) {
      // Trim trailing punctuation that commonly clings to URLs in prose.
      const url = raw.replace(/[.,;:)]+$/, '');
      if (JOIN_HOST_RE.test(url)) return url;
    }
  }
  return null;
}

/**
 * Normalise an organiser record to `{ name, email }` (both strings, possibly
 * empty), or null when there's nothing usable.
 */
function normaliseOrganizer(organizer) {
  if (!organizer || typeof organizer !== 'object') return null;
  const name = typeof organizer.name === 'string' ? organizer.name.trim() : '';
  const email = typeof organizer.email === 'string' ? organizer.email.trim() : '';
  if (!name && !email) return null;
  return { name, email };
}

/**
 * Normalise an attendee record into the stable shape the skeleton renders from.
 */
function normaliseAttendee(attendee) {
  if (!attendee || typeof attendee !== 'object') return null;
  return {
    name: typeof attendee.name === 'string' ? attendee.name.trim() : '',
    email: typeof attendee.email === 'string' ? attendee.email.trim() : '',
    role: typeof attendee.role === 'string' ? attendee.role : '',
    status: typeof attendee.status === 'string' ? attendee.status : '',
    isCurrentUser: attendee.isCurrentUser === true,
  };
}

/**
 * Build the meeting context — a backward-compatible SUPERSET of the legacy seed.
 *
 * The first three keys ({title, participants, agenda}) are exactly what
 * buildPreRecordSeedFromEvent produced, so anything that consumed the seed keeps
 * working and the manifest stays flat (the recorder copies only those three).
 * The remaining keys are the rich fields the skeleton renders from.
 *
 * @param {object|null} event - a calendar event (see calendar-helper JSON shape)
 * @returns {object|null} the context, or null for a null/absent event
 */
function buildMeetingContext(event) {
  if (!event) return null;
  const seed = buildPreRecordSeedFromEvent(event);
  const attendees = Array.isArray(event.attendees)
    ? event.attendees.map(normaliseAttendee).filter(Boolean)
    : [];

  return {
    // Flat, backward-compatible subset (recorder/summariser contract, invariant #2)
    title: seed.title,
    participants: seed.participants,
    agenda: seed.agenda,
    // Rich superset
    occurrenceFingerprint:
      typeof event.occurrenceFingerprint === 'string' ? event.occurrenceFingerprint : null,
    eventId: typeof event.id === 'string' ? event.id : null,
    startTime: typeof event.startTime === 'string' ? event.startTime : null,
    endTime: typeof event.endTime === 'string' ? event.endTime : null,
    location: typeof event.location === 'string' ? event.location : '',
    joinUrl: extractJoinUrl(event),
    organizer: normaliseOrganizer(event.organizer),
    attendees,
  };
}

/**
 * Render a YAML scalar safely. Untrusted titles must never be able to corrupt
 * frontmatter: collapse newlines (so they can't open a new key), escape the
 * backslash and double-quote, and wrap the whole thing in double quotes. The
 * result is always a single, valid double-quoted YAML scalar.
 */
function yamlScalar(value) {
  const s = String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
  return `"${s}"`;
}

/**
 * Format an attendee line for the Attendees section.
 */
function attendeeLine(attendee) {
  const name = attendeeDisplayName(attendee) || attendee.email || 'Unknown';
  const tags = [];
  if (attendee.isCurrentUser) tags.push('you');
  if (attendee.role && attendee.role.toLowerCase() === 'organizer') tags.push('organiser');
  if (attendee.status && attendee.status.toLowerCase() !== 'unknown' && attendee.status) {
    tags.push(attendee.status.toLowerCase());
  }
  const tagSuffix = tags.length ? ` (${tags.join(', ')})` : '';
  const emailSuffix = attendee.email && attendee.email !== name ? ` — ${attendee.email}` : '';
  return `- ${name}${tagSuffix}${emailSuffix}`;
}

/**
 * Render the structured note skeleton as Markdown.
 *
 * Accepts either a rich context from buildMeetingContext or the bare flat
 * {title, participants, agenda} shape (a manual recording) — missing rich fields
 * are simply omitted. The output is deterministic given a fixed `generatedAt`.
 *
 * @param {object} context - meeting context (rich or flat)
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] - ISO timestamp for the `generated`
 *   frontmatter field. Defaults to now. Pass a fixed value for deterministic tests.
 * @returns {string} Markdown document
 */
function renderSkeletonMarkdown(context, { generatedAt } = {}) {
  const ctx = context || {};
  const stamp = generatedAt || new Date().toISOString();

  // ---- Frontmatter (only keys with values) ----
  const fm = [];
  fm.push(`title: ${yamlScalar(ctx.title || 'Meeting')}`);
  if (ctx.startTime) fm.push(`start: ${yamlScalar(ctx.startTime)}`);
  if (ctx.endTime) fm.push(`end: ${yamlScalar(ctx.endTime)}`);
  if (ctx.location) fm.push(`location: ${yamlScalar(ctx.location)}`);
  if (ctx.joinUrl) fm.push(`join_url: ${yamlScalar(ctx.joinUrl)}`);
  if (ctx.organizer && (ctx.organizer.name || ctx.organizer.email)) {
    const org = [ctx.organizer.name, ctx.organizer.email].filter(Boolean).join(' ');
    fm.push(`organiser: ${yamlScalar(org)}`);
  }
  if (ctx.occurrenceFingerprint) fm.push(`fingerprint: ${yamlScalar(ctx.occurrenceFingerprint)}`);
  fm.push(`generated: ${yamlScalar(stamp)}`);
  fm.push(`source: ${yamlScalar('cxnotes')}`);

  const lines = [];
  lines.push('---');
  lines.push(...fm);
  lines.push('---');
  lines.push('');
  lines.push(`# ${ctx.title || 'Meeting'}`);
  lines.push('');

  // ---- Agenda ----
  lines.push('## Agenda');
  if (ctx.agenda && ctx.agenda.trim()) {
    lines.push(ctx.agenda.trim());
  } else {
    lines.push('_No agenda supplied._');
  }
  lines.push('');

  // ---- Attendees ----
  lines.push('## Attendees');
  const attendees = Array.isArray(ctx.attendees) ? ctx.attendees : [];
  if (attendees.length) {
    for (const a of attendees) lines.push(attendeeLine(a));
  } else if (ctx.participants && ctx.participants.trim()) {
    // Flat/manual context: only a comma-joined participants string is available.
    for (const name of ctx.participants.split(',').map((s) => s.trim()).filter(Boolean)) {
      lines.push(`- ${name}`);
    }
  } else {
    lines.push('_No attendees listed._');
  }
  lines.push('');

  // ---- Scaffolded note sections ----
  for (const section of SKELETON_SECTIONS) {
    lines.push(`## ${section.heading}`);
    lines.push(`_${section.hint}_`);
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

module.exports = {
  JOIN_HOSTS,
  SKELETON_SECTIONS,
  buildAgendaFromNotes,
  attendeeDisplayName,
  buildPreRecordSeedFromEvent,
  extractJoinUrl,
  buildMeetingContext,
  renderSkeletonMarkdown,
};
