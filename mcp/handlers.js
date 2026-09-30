'use strict';

/**
 * MCP tool handlers for the standalone cxnotes-calendar server.
 *
 * Pure of the SDK: handlers return plain objects (server.js wraps them in the
 * MCP content envelope and flips `isError` when a result carries an `error`).
 * That keeps handlers fully unit-testable with a fake calendar source + a temp
 * prepared store.
 *
 * Both the template render here and the in-app apply path build from the SAME
 * services/meetingTemplate module, so a prepared meeting and the recording the
 * app starts can never describe the meeting differently.
 *
 * Tools:
 *   check_calendar_permission   — report the TCC state (never isError)
 *   list_upcoming_meetings      — events in a window, each tagged `preparable`
 *   get_current_meeting         — the in-progress meeting (or null)
 *   render_meeting_template     — context + skeleton markdown for one occurrence
 *   prepare_meeting             — stage a templated meeting for the app to claim
 *   list_prepared_meetings      — what's staged (works with no calendar access)
 *   cancel_prepared_meeting     — un-stage one (works with no calendar access)
 *
 * Permission / helper failures surface as { error, message, fix } so an agent
 * gets actionable guidance — never a silent empty list.
 */

const { buildMeetingContext, renderSkeletonMarkdown } = require('../services/meetingTemplate');
const { passesMeetingFilter } = require('../services/meetingFilter');

// Lookahead used when resolving an event by fingerprint/eventId for
// render/prepare (a meeting could be up to a day out).
const FIND_WINDOW_MINUTES = 1440;

const PERMISSION_FIX =
  'Run `npm run mcp:check` and grant Calendar access when prompted, or open ' +
  'System Settings → Privacy & Security → Calendars and enable the CXNotes ' +
  'helper. macOS keys the grant to the helper’s code signature, so the installed ' +
  'app’s signed helper is preferred when present.';

const HELPER_MISSING_FIX = 'npm run build:calendar';

function permissionError(state) {
  return {
    error: 'permission',
    state,
    message: 'Calendar access is not granted to the CXNotes calendar-helper.',
    fix: PERMISSION_FIX,
  };
}

function helperMissingError() {
  return {
    error: 'helper-missing',
    message: 'The calendar-helper binary is not built or not found.',
    fix: HELPER_MISSING_FIX,
  };
}

function mapSourceError(error) {
  if (error === 'permission-denied') return permissionError('denied');
  if (error === 'not-determined') return permissionError('not-determined');
  return { error: 'source', message: `Calendar helper error: ${error}` };
}

/**
 * Compact, agent-friendly view of an event. Includes the addressing keys
 * (occurrenceFingerprint, eventId) so a follow-up prepare/render is one call.
 */
function summariseEvent(ev) {
  const ctx = buildMeetingContext(ev) || {};
  return {
    title: ctx.title || '',
    occurrenceFingerprint: ctx.occurrenceFingerprint,
    eventId: ctx.eventId,
    startTime: ctx.startTime,
    endTime: ctx.endTime,
    attendeeCount: Array.isArray(ctx.attendees) ? ctx.attendees.length : 0,
    location: ctx.location || '',
    joinUrl: ctx.joinUrl || null,
  };
}

const TOOLS = [
  {
    name: 'check_calendar_permission',
    description:
      'Report whether the CXNotes calendar-helper has macOS Calendar (EventKit) access. ' +
      'Returns state: granted | denied | not-determined. Running this also triggers the TCC ' +
      'prompt the first time if the helper can surface it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_upcoming_meetings',
    description:
      'List calendar meetings starting within the given window. Each meeting is tagged ' +
      '`preparable` (true when it is a real multi-person, non-all-day, non-declined meeting). ' +
      'Use the returned occurrenceFingerprint with prepare_meeting / render_meeting_template.',
    inputSchema: {
      type: 'object',
      properties: {
        windowMinutes: {
          type: 'number',
          description: 'Lookahead window in minutes (default 120).',
          minimum: 1,
          maximum: 10080,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_current_meeting',
    description: 'Return the calendar meeting currently in progress, or null when none is active.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'render_meeting_template',
    description:
      'Render the structured note skeleton (YAML frontmatter + Agenda + Attendees + scaffolded ' +
      'sections) and the full meeting context for one occurrence, WITHOUT staging it. Identify the ' +
      'meeting by fingerprint or eventId.',
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string', description: 'occurrenceFingerprint (cal:<id>:<ISO start>)' },
        eventId: { type: 'string', description: 'calendar event id' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'prepare_meeting',
    description:
      'Stage a fully-templated meeting so the CXNotes app can start recording it with one ' +
      'click (zero typing) when you join the call. Writes to the filesystem handoff; works even ' +
      'when the app is closed. Identify the meeting by fingerprint or eventId. Optional overrides ' +
      'can replace the title or agenda.',
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string', description: 'occurrenceFingerprint (cal:<id>:<ISO start>)' },
        eventId: { type: 'string', description: 'calendar event id' },
        overrides: {
          type: 'object',
          description: 'Optional field overrides applied to the template.',
          properties: {
            title: { type: 'string' },
            agenda: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_prepared_meetings',
    description:
      'List meetings already staged in the handoff directory (live, not yet claimed by the app). ' +
      'Works without Calendar access.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cancel_prepared_meeting',
    description: 'Un-stage a prepared meeting by fingerprint. Works without Calendar access.',
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string', description: 'occurrenceFingerprint to cancel' },
      },
      required: ['fingerprint'],
      additionalProperties: false,
    },
  },
];

/**
 * @param {object} deps
 * @param {object|null} deps.source - calendar source (null when helper missing)
 * @param {object} deps.preparedStore - PreparedMeetingStore instance
 * @param {Error} [deps.sourceError] - the HELPER_MISSING error, if construction failed
 * @returns {{ tools: object[], call: (name: string, args: object) => Promise<object> }}
 */
function createHandlers({ source, preparedStore, sourceError = null }) {
  // Resolve an event by fingerprint or eventId across the upcoming window + the
  // current meeting. Returns { event } or { error: <shaped error> }.
  async function findEvent({ fingerprint, eventId, windowMinutes = FIND_WINDOW_MINUTES }) {
    if (!source) return { error: helperMissingError() };
    if (!fingerprint && !eventId) {
      return { error: { error: 'bad-args', message: 'Provide a fingerprint or an eventId.' } };
    }
    const [up, cur] = await Promise.all([
      source.getUpcomingEvents({ windowMinutes }),
      source.getCurrentEvent(),
    ]);
    if (up && up.error) return { error: mapSourceError(up.error) };

    const pool = Array.isArray(up && up.events) ? up.events.slice() : [];
    if (cur && cur.event) pool.push(cur.event);

    const match = pool.find(
      (ev) =>
        (fingerprint && ev.occurrenceFingerprint === fingerprint) ||
        (eventId && ev.id === eventId)
    );
    if (!match) {
      return {
        error: {
          error: 'event-not-found',
          message: `No meeting matching ${fingerprint || eventId} found within ${windowMinutes} minutes.`,
        },
      };
    }
    return { event: match };
  }

  const handlers = {
    check_calendar_permission: async () => {
      if (!source) return helperMissingError();
      const state = await source.ensurePermission();
      const out = { state };
      if (state !== 'granted') out.fix = PERMISSION_FIX;
      return out;
    },

    list_upcoming_meetings: async (args = {}) => {
      if (!source) return helperMissingError();
      const windowMinutes = Number.isFinite(args.windowMinutes) ? args.windowMinutes : 120;
      const result = await source.getUpcomingEvents({ windowMinutes });
      if (result && result.error) return mapSourceError(result.error);
      const meetings = (result.events || []).map((ev) => ({
        ...summariseEvent(ev),
        // Structural eligibility only (multi-person, not all-day, not declined).
        // The app's title denylist is a user-pref the MCP can't know, so it isn't
        // applied to this hint.
        preparable: passesMeetingFilter(ev, { denylist: [] }),
      }));
      return { windowMinutes, count: meetings.length, meetings };
    },

    get_current_meeting: async () => {
      if (!source) return helperMissingError();
      const result = await source.getCurrentEvent();
      if (result && result.error) return mapSourceError(result.error);
      return { meeting: result.event ? summariseEvent(result.event) : null };
    },

    render_meeting_template: async (args = {}) => {
      const found = await findEvent({ fingerprint: args.fingerprint, eventId: args.eventId });
      if (found.error) return found.error;
      const context = buildMeetingContext(found.event);
      return { context, markdown: renderSkeletonMarkdown(context) };
    },

    prepare_meeting: async (args = {}) => {
      const found = await findEvent({ fingerprint: args.fingerprint, eventId: args.eventId });
      if (found.error) return found.error;

      const context = buildMeetingContext(found.event);
      if (args.overrides && typeof args.overrides === 'object') {
        if (typeof args.overrides.title === 'string') context.title = args.overrides.title;
        if (typeof args.overrides.agenda === 'string') context.agenda = args.overrides.agenda;
      }
      const markdown = renderSkeletonMarkdown(context);

      const res = preparedStore.prepare({
        occurrenceFingerprint: context.occurrenceFingerprint,
        eventId: context.eventId,
        title: context.title,
        startTime: context.startTime,
        endTime: context.endTime,
        template: { context, markdown },
        source: 'mcp',
      });
      if (!res.ok) return { error: 'prepare-failed', message: res.error };
      return {
        prepared: true,
        fingerprint: res.record.occurrenceFingerprint,
        title: res.record.title,
        expiresAt: res.record.expiresAt,
        path: res.path,
      };
    },

    list_prepared_meetings: async () => {
      const prepared = preparedStore.list().map((r) => ({
        occurrenceFingerprint: r.occurrenceFingerprint,
        title: r.title,
        startTime: r.startTime,
        endTime: r.endTime,
        source: r.source,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      }));
      return { count: prepared.length, prepared };
    },

    cancel_prepared_meeting: async (args = {}) => {
      if (!args.fingerprint) return { error: 'bad-args', message: 'fingerprint is required.' };
      const res = preparedStore.cancel(args.fingerprint);
      if (!res.ok) return { error: 'cancel-failed', reason: res.reason, message: res.error };
      return { cancelled: true, fingerprint: args.fingerprint };
    },
  };

  async function call(name, args) {
    const handler = handlers[name];
    if (!handler) return { error: 'unknown-tool', message: `No such tool: ${name}` };
    try {
      return await handler(args || {});
    } catch (err) {
      return { error: 'handler-exception', message: err.message };
    }
  }

  return { tools: TOOLS, call };
}

module.exports = { createHandlers, TOOLS, summariseEvent, FIND_WINDOW_MINUTES };
