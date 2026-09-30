'use strict';

/**
 * Attendee Merge — complete a mail-derived roster from the OS calendar.
 *
 * THE BLIND SPOT THIS CLOSES
 *
 * The cxmail source derives events from `text/calendar` parts on messages in
 * the mailbox. For an invitation the user RECEIVES that is a `METHOD:REQUEST`,
 * which carries every attendee, and the roster is complete. For an invitation
 * the user SENDS, it is not: the calendar server mails the REQUEST to the
 * invitees, not back to the organiser, and the only calendar messages that ever
 * arrive are `METHOD:REPLY`s — which, per RFC 5546, carry ONLY the responder's
 * own ATTENDEE line.
 *
 * So on a meeting the user organised, a mail-derived roster is exactly "the
 * people who RSVP'd". Everyone invited who never replied is invisible, and the
 * person least likely to reply is the busy principal — the one whose presence
 * the notes most need to record. On 2026-08-21 that produced a client meeting
 * summarised as attended by the two people who accepted, while the dominant
 * voice on the recording belonged to someone who never responded to the invite.
 *
 * This is NOT a defect in the mail source, and no parsing improvement fixes it:
 * there is no message in the mailbox that contains the missing names. EventKit
 * has them, because it syncs the event object itself rather than inferring it
 * from mail, so it holds the server's canonical attendee list along with each
 * person's live RSVP status. This module joins the two.
 *
 * THE SAFETY POSTURE
 *
 * Additive only. The OS calendar can ADD an attendee the mailbox never saw; it
 * never removes or overrides one. An ambiguous match — two candidate events at
 * the same time with the same title — enriches nothing, because attaching the
 * wrong roster to a meeting is worse than an incomplete one, and the resulting
 * note would be confidently wrong rather than merely thin.
 *
 * Pure functions, no I/O: the caller owns fetching and permission.
 *
 * British English throughout (invariant #4): "organiser", "normalise".
 */

/** Two occurrences count as the same meeting if they start this close together. */
const DEFAULT_TOLERANCE_MS = 2 * 60 * 1000;

/** Calendar clients prefix replies and updates; the underlying meeting is the same. */
const TITLE_CRUFT = /^(?:accepted|declined|tentative|updated invitation|invitation|cancelled|canceled|re|fwd)\s*[:-]\s*/i;

/**
 * Reduce a title to something comparable across two calendar stacks: case,
 * punctuation and dash flavour all differ between an ICS body and EventKit.
 */
function normaliseTitle(title) {
  let out = String(title || '').trim();
  // Clients stack prefixes ("Updated invitation: Accepted: ..."), so strip to fixpoint.
  let previous;
  do {
    previous = out;
    out = out.replace(TITLE_CRUFT, '').trim();
  } while (out !== previous && out);

  return out
    .toLowerCase()
    // Em/en dashes and their spacing survive one stack and not the other.
    .replace(/[‐-―−]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Milliseconds for an event's start, or NaN when it has no usable one. */
function startMs(event) {
  if (!event || !event.startTime) return NaN;
  return Date.parse(event.startTime);
}

/**
 * The one candidate that is unambiguously the same occurrence, or null.
 *
 * Null on no match AND on more than one — a tie means we cannot tell which
 * roster belongs to this meeting, and a wrong roster is the failure mode this
 * whole module exists to avoid.
 */
function findMatch(event, candidates, options = {}) {
  const tolerance = Number.isFinite(options.toleranceMs) ? options.toleranceMs : DEFAULT_TOLERANCE_MS;
  const title = normaliseTitle(event && event.title);
  const start = startMs(event);
  if (!title || !Number.isFinite(start)) return null;

  const matches = (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    const candidateStart = startMs(candidate);
    if (!Number.isFinite(candidateStart)) return false;
    if (Math.abs(candidateStart - start) > tolerance) return false;
    return normaliseTitle(candidate && candidate.title) === title;
  });

  return matches.length === 1 ? matches[0] : null;
}

/** The key an attendee dedupes on: email where there is one, else the name. */
function attendeeKey(attendee) {
  if (!attendee) return '';
  const email = String(attendee.email || '').trim().toLowerCase();
  if (email) return email;
  const name = String(attendee.name || '').trim().toLowerCase();
  return name ? `name:${name}` : '';
}

/**
 * Combine two records of the same person, field by field, best value wins.
 *
 * `isCurrentUser` is the one that matters most: a mail-derived attendee can
 * never know it is the user (the ICS does not say), so it is always false
 * there, and losing a true from the OS side would put the user in their own
 * participant list.
 */
function mergeAttendeeEntry(existing, incoming) {
  return {
    name: String(existing.name || '').trim() || String(incoming.name || '').trim() || '',
    email: String(existing.email || '').trim() || String(incoming.email || '').trim() || '',
    role: String(existing.role || '').trim() || String(incoming.role || '').trim() || '',
    status: pickStatus(existing.status, incoming.status),
    isCurrentUser: Boolean(existing.isCurrentUser) || Boolean(incoming.isCurrentUser),
  };
}

/** A real RSVP beats "unknown"; otherwise the first one stands. */
function pickStatus(existing, incoming) {
  const a = String(existing || '').trim();
  const b = String(incoming || '').trim();
  if (a && a.toLowerCase() !== 'unknown') return a;
  if (b && b.toLowerCase() !== 'unknown') return b;
  return a || b || 'unknown';
}

/**
 * Union two attendee lists. Primary order is preserved and primary entries come
 * first; anyone only the secondary knows about is appended.
 */
function mergeAttendees(primary, secondary) {
  const order = [];
  const byKey = new Map();

  for (const list of [primary, secondary]) {
    for (const attendee of Array.isArray(list) ? list : []) {
      const key = attendeeKey(attendee);
      if (!key) continue;
      if (byKey.has(key)) {
        byKey.set(key, mergeAttendeeEntry(byKey.get(key), attendee));
      } else {
        byKey.set(key, mergeAttendeeEntry(attendee, {}));
        order.push(key);
      }
    }
  }

  return order.map((key) => byKey.get(key));
}

/**
 * Return `event` with its attendee list completed from `candidates`, or the
 * very same object when there is nothing to add.
 *
 * Identity matters to the caller: an untouched event is returned by reference,
 * so a poll that enriches nothing allocates nothing.
 */
function enrichEvent(event, candidates, options = {}) {
  if (!event || typeof event !== 'object') return event;
  const match = findMatch(event, candidates, options);
  if (!match) return event;

  const merged = mergeAttendees(event.attendees, match.attendees);
  if (merged.length === (Array.isArray(event.attendees) ? event.attendees.length : 0)) {
    return event;
  }
  return { ...event, attendees: merged, attendeesCompletedFrom: options.sourceLabel || 'macos' };
}

/** enrichEvent across a list. */
function enrichEvents(events, candidates, options = {}) {
  if (!Array.isArray(events) || !events.length) return events;
  return events.map((event) => enrichEvent(event, candidates, options));
}

module.exports = {
  normaliseTitle,
  findMatch,
  mergeAttendees,
  enrichEvent,
  enrichEvents,
  DEFAULT_TOLERANCE_MS,
};
