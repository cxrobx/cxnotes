'use strict';

/**
 * cxmail Calendar Source
 *
 * Reads meeting events out of cxmail's local SQLite store
 * (`~/Library/Application Support/com.cxmail.app/cxmail.db`) so CXNotes can
 * surface meetings that never made it onto the macOS Calendar — e.g. an `.ics`
 * invite still sitting unanswered in the inbox, or a Zoom link cxmail *detected*
 * in an email body. The EventKit source (macOSCalendarSource) only sees events
 * already committed to Calendar, so it misses exactly these.
 *
 * Read-only and decoupled: we spawn the always-present `/usr/bin/sqlite3` CLI in
 * `-readonly -json` mode (no native Node dependency; mirrors how
 * macOSCalendarSource spawns its Swift helper) and never write. cxmail itself
 * opens read-only connections the same way, and WAL means our reads never block
 * its writes. Every spawned child is routed through `registerProcess` so it
 * joins the app's cleanup-on-quit invariant.
 *
 * Same interface as macOSCalendarSource so CalendarSuggester can poll either:
 *   - isAvailable()        → sync bool (DB + sqlite3 present) — the auto-fallback gate
 *   - ensurePermission()   → 'granted' | 'denied'  (no TCC prompt; availability IS the gate)
 *   - getUpcomingEvents()  → { events } | { events: [], error }
 *   - getCurrentEvent()    → { event } | { event: null, error }
 *
 * Eligibility (the SQL WHERE clause) differs from the EventKit filter on purpose:
 * cxmail rows carry no attendee list, so meeting-worthiness is established by the
 * row's provenance instead — an `.ics` invite, or a `detected` event at/above a
 * confidence threshold — and the mapped events carry `meetingWorthy: true` so the
 * shared meetingFilter skips its >=2-attendee gate (which cxmail rows can't meet).
 *
 * NORMALISATION (ported from meeting-copilot's server/src/calendar/cxmail.ts):
 * cxmail stores ONE row per (invite × mailbox), so the same Google invite lands
 * several times (once per account) and RSVP replies come back as separate
 * METHOD:REPLY rows. Rather than mapping one event per row, we
 * fetch → resolve times → group by event UID → emit one clean event per meeting:
 *   - dedup the same invite across mailboxes by `event_uid` (null-UID `detected`
 *     rows fall back to a `summary|startMinute` key so they don't all collapse);
 *   - "newest `created_at` wins" for reschedules (time + title from the winner);
 *   - union attendees across REQUEST + RSVP-reply rows (a REPLY lists only the
 *     responder — often the sole trace of a meeting the user organised);
 *   - strip "Accepted:/Declined:" title prefixes and Google-Meet description
 *     boilerplate; exclude conference rooms from the attendee list;
 *   - resolve cxmail's mixed timestamps (UTC `Z` vs. floating wall-time via the
 *     ICS `TZID`, DST-correct).
 *
 * Errors never throw — missing DB, sqlite failure, or JSON parse failure surface
 * as typed results so the suggester loop degrades gracefully.
 *
 * British English throughout (invariant #4): "organiser", "normalise".
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// cxmail's bundle id is com.cxmail.app (its tauri.conf.json identifier). Frozen
// foreign-app path — overridable via the constructor for tests.
const CXMAIL_DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'com.cxmail.app',
  'cxmail.db'
);

const SQLITE_BIN = '/usr/bin/sqlite3';
const QUERY_TIMEOUT_MS = 5000;
const DEFAULT_MEETING_MINUTES = 60; // detected events have no dtend — synthesise this span
const DEFAULT_MIN_CONFIDENCE = 0.7;
const MAX_NOTES_CHARS = 2000; // cap the description we carry into the skeleton

// The columns we map. Kept as one frozen list so both queries select identically.
// `event_uid` drives cross-mailbox dedup; `created_at` picks the winning row.
const COLUMNS =
  'id, event_uid, summary, description, location, dtstart, dtend, organizer_name, organizer_email, ' +
  'status, method, rsvp_status, source, confidence, raw_ics, created_at';

/** A bare date (YYYY-MM-DD, no time) is an all-day event. */
function isDateOnly(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

/**
 * Parse a cxmail dtstart/dtend WITHOUT any TZID awareness. cxmail stores either a
 * UTC value with a trailing `Z`, or a floating `YYYY-MM-DDTHH:MM:SS` (local
 * wall-clock). JS `new Date` parses a no-offset datetime as LOCAL and a
 * Z-suffixed one as UTC — both correct here. Returns null for unparseable input.
 * This is the fallback path used by `resolveEventTime` when there's no TZID
 * (detected rows, all-day dates), and it stays exported so its behaviour is
 * pinned by unit tests.
 */
function parseCxmailDate(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Pull a component's TZID from a raw ICS body, e.g. `DTSTART;TZID=America/Chicago:...`.
 * Returns the IANA zone id or null.
 */
function extractTzid(rawIcs, prop) {
  if (typeof rawIcs !== 'string' || !rawIcs) return null;
  // Unfold RFC 5545 line folding first so the property line is intact.
  const unfolded = rawIcs.replace(/\r?\n[ \t]/g, '');
  const line = new RegExp(`^${prop}([^:\\r\\n]*):`, 'm').exec(unfolded);
  if (!line) return null;
  const tz = /TZID=([^;:]+)/i.exec(line[1]);
  return tz ? tz[1].trim() : null;
}

/**
 * Convert a wall-clock time in an IANA zone to epoch ms (two-pass so DST offsets
 * are corrected). Returns null for an unknown TZID.
 * @param {number[]} wall - [year, month(1-based), day, hour, minute, second]
 */
function zonedWallTimeToUtc(wall, timeZone) {
  try {
    const wantedUtc = Date.UTC(wall[0], wall[1] - 1, wall[2], wall[3], wall[4], wall[5]);
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    let ts = wantedUtc;
    for (let i = 0; i < 2; i++) {
      const parts = {};
      for (const p of dtf.formatToParts(ts)) {
        if (p.type !== 'literal') parts[p.type] = Number(p.value);
      }
      const rendered = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second
      );
      ts += wantedUtc - rendered;
      if (rendered === wantedUtc) break;
    }
    return ts;
  } catch {
    return null; // unknown TZID
  }
}

/**
 * Resolve a cxmail dtstart/dtend into an absolute `Date` (or null). cxmail stores
 * three shapes and we handle each:
 *   1. UTC:      `2026-06-17T14:00:00Z`          → Date.UTC(...)
 *   2. floating: `2026-06-17T09:30:00` + a `DTSTART;TZID=…` in raw_ics
 *                → DST-correct zoned conversion
 *   3. everything else (floating with no TZID, all-day dates, junk)
 *                → the existing machine-local `parseCxmailDate`
 * @param {string} value - the dtstart/dtend text
 * @param {string|null} rawIcs - the row's raw ICS (for TZID lookup)
 * @param {'DTSTART'|'DTEND'} prop - which ICS property to read the TZID from
 */
function resolveEventTime(value, rawIcs, prop) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z?)/.exec(v);
  if (!m) {
    // Date-only or non-standard — defer to the machine-local parser.
    return parseCxmailDate(v);
  }
  const [, y, mo, d, h, mi, s, z] = m;
  const wall = [Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s)];
  if (z === 'Z') {
    return new Date(Date.UTC(wall[0], wall[1] - 1, wall[2], wall[3], wall[4], wall[5]));
  }
  const tzid = extractTzid(rawIcs, prop);
  if (tzid) {
    const ms = zonedWallTimeToUtc(wall, tzid);
    if (ms !== null) return new Date(ms);
  }
  // Floating with no zone info — machine-local wall time (same as parseCxmailDate).
  return parseCxmailDate(v);
}

/**
 * Strip the RSVP-reply prefixes Google puts on METHOD:REPLY summaries
 * ("Accepted: …", "Declined: …"). An empty result → 'Untitled meeting'.
 */
function cleanTitle(summary) {
  const t = (typeof summary === 'string' ? summary : '').trim();
  const cleaned = t
    .replace(/^(Accepted|Declined|Tentatively accepted|Tentative|Updated invitation)\s*:\s*/i, '')
    .trim();
  return cleaned || 'Untitled meeting';
}

/**
 * Strip Google Calendar's "-::~:~:: … ::~:~::-" boilerplate block from a
 * description, then drop any line that is nothing but marker characters (cxmail
 * sometimes stores only the first physical ICS line, leaving an unterminated
 * marker). Length-capped so a huge invite body can't bloat the skeleton.
 */
function cleanDescription(description) {
  if (typeof description !== 'string' || !description) return '';
  const markerRe = /-::~[:~]*::-/g;
  const markers = [...description.matchAll(markerRe)];
  let cleaned = description;
  if (markers.length >= 2) {
    const first = markers[0].index;
    const last = markers[markers.length - 1];
    cleaned = description.slice(0, first) + description.slice(last.index + last[0].length);
  }
  cleaned = cleaned
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => {
      const bare = line.replace(/\s/g, '');
      return !(bare && /^[-:~]+$/.test(bare));
    })
    .join('\n')
    .trim();
  return cleaned.length > MAX_NOTES_CHARS ? cleaned.slice(0, MAX_NOTES_CHARS) + '…' : cleaned;
}

/**
 * Best-effort attendee extraction from an `.ics` body. cxmail's row has no
 * attendee column, but the raw ICS does for invites. Detected events have no
 * raw_ics → []. Conference rooms/resources (`CUTYPE=RESOURCE|ROOM`) are skipped —
 * they're not people. The display name falls back to the email local-part when
 * there's no usable CN (Google frequently omits it). We can't know isCurrentUser
 * from the ICS alone, so it stays false (harmless for the skeleton — everyone
 * shows as a participant).
 */
function parseIcsAttendees(rawIcs) {
  if (typeof rawIcs !== 'string' || !rawIcs) return [];
  // Unfold RFC 5545 line folding (CRLF + leading space/tab continuation).
  const unfolded = rawIcs.replace(/\r?\n[ \t]/g, '');
  const attendees = [];
  for (const line of unfolded.split(/\r?\n/)) {
    if (!/^ATTENDEE[;:]/i.test(line)) continue;
    // Conference rooms / resources are not people — skip them.
    if (/CUTYPE=(RESOURCE|ROOM)/i.test(line)) continue;
    const cn = /CN=([^;:]+)/i.exec(line);
    const mail = /mailto:([^\s;:>]+)/i.exec(line);
    const partstat = /PARTSTAT=([^;:]+)/i.exec(line);
    const email = mail ? mail[1].trim() : '';
    let name = cn ? cn[1].replace(/^"|"$/g, '').trim() : '';
    // Fall back to the email local-part when there's no usable display name.
    if ((!name || name === email) && email.includes('@')) name = email.split('@')[0];
    if (!name && !email) continue;
    attendees.push({
      name,
      email,
      role: '',
      status: partstat ? partstat[1].toLowerCase() : 'unknown',
      isCurrentUser: false,
    });
  }
  return attendees;
}

class CxmailCalendarSource {
  /**
   * @param {object} opts
   * @param {Function} opts.spawn - child_process.spawn (injected for tests)
   * @param {Function} opts.registerProcess - main.js's registerProcess (injected)
   * @param {() => number} [opts.getMinConfidence] - live confidence threshold for detected events
   * @param {string} [opts.dbPath] - cxmail SQLite path (override for tests)
   * @param {string} [opts.sqliteBin] - sqlite3 CLI path (override for tests)
   * @param {(p: string) => boolean} [opts.fileExists] - existence probe (injected for tests)
   * @param {number} [opts.defaultMinutes] - synthesised span when dtend is absent
   * @param {number} [opts.timeoutMs]
   * @param {() => Date} [opts.now] - clock injection for tests
   */
  constructor({
    spawn,
    registerProcess,
    getMinConfidence,
    dbPath = CXMAIL_DB_PATH,
    sqliteBin = SQLITE_BIN,
    fileExists,
    defaultMinutes = DEFAULT_MEETING_MINUTES,
    timeoutMs = QUERY_TIMEOUT_MS,
    now = () => new Date(),
  } = {}) {
    if (typeof spawn !== 'function') throw new Error('CxmailCalendarSource: spawn required');
    if (typeof registerProcess !== 'function') {
      throw new Error('CxmailCalendarSource: registerProcess required');
    }
    this._spawn = spawn;
    this._registerProcess = registerProcess;
    this._getMinConfidence = typeof getMinConfidence === 'function' ? getMinConfidence : () => DEFAULT_MIN_CONFIDENCE;
    this._dbPath = dbPath;
    this._sqliteBin = sqliteBin;
    this._fileExists =
      typeof fileExists === 'function'
        ? fileExists
        : (p) => {
            try {
              return fs.existsSync(p);
            } catch {
              return false;
            }
          };
    this._defaultMinutes = defaultMinutes;
    this._timeoutMs = timeoutMs;
    this._now = now;
  }

  /** Sync availability gate used by the auto-fallback selector. */
  isAvailable() {
    return this._fileExists(this._dbPath) && this._fileExists(this._sqliteBin);
  }

  /** No TCC prompt for cxmail — availability of its DB is the whole gate. */
  async ensurePermission() {
    return this.isAvailable() ? 'granted' : 'denied';
  }

  /** Clamp the live confidence threshold to [0, 1], falling back to the default. */
  _minConfidence() {
    const n = Number(this._getMinConfidence());
    if (!Number.isFinite(n)) return DEFAULT_MIN_CONFIDENCE;
    return Math.min(1, Math.max(0, n));
  }

  /**
   * The provenance/eligibility WHERE clause: not dismissed, not a cancellation,
   * and either an `.ics` invite or a `detected` event at/above the threshold.
   * The threshold is a number we control — safe to inline (sqlite3 CLI has no
   * easy bind-param path through argv).
   */
  _eligibilityClause() {
    const minConf = this._minConfidence();
    return (
      "dismissed = 0 AND (method IS NULL OR upper(method) != 'CANCEL') " +
      `AND (source = 'ics' OR (source = 'detected' AND confidence >= ${minConf}))`
    );
  }

  /**
   * Spawn `sqlite3 -readonly -json <db> <sql>`. Resolves to { rows } or { error }.
   * Never throws.
   */
  async _runQuery(sql) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this._spawn(this._sqliteBin, ['-readonly', '-json', this._dbPath, sql], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ error: `spawn-failed: ${err.message}` });
        return;
      }

      this._registerProcess(child);

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => finish({ error: `spawn-error: ${err.message}` }));
      child.on('exit', (code) => {
        if (code !== 0) {
          finish({ error: `sqlite-exit-${code == null ? -1 : code}: ${stderr.trim()}` });
          return;
        }
        const text = stdout.trim();
        // sqlite3 -json prints NOTHING for a zero-row result.
        if (!text) {
          finish({ rows: [] });
          return;
        }
        try {
          const parsed = JSON.parse(text);
          finish({ rows: Array.isArray(parsed) ? parsed : [] });
        } catch (err) {
          finish({ error: `parse-failed: ${err.message}` });
        }
      });

      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        finish({ error: 'timeout' });
      }, this._timeoutMs);
    });
  }

  /**
   * The dedup key for a row. A real invite UID collapses the same meeting across
   * mailboxes/reschedules; a null-UID `detected` row (all of them) falls back to
   * `summary|startMinute` so distinct detected meetings don't collapse into one.
   */
  _dedupKey(row, startMs) {
    return (
      row.event_uid ||
      `${(row.summary || '').trim().toLowerCase()}|${Math.floor(startMs / 60000)}`
    );
  }

  /**
   * Turn raw cxmail rows into ONE clean event per meeting:
   *   1. resolve times (TZID-aware) + drop cancellations / unparseable rows,
   *   2. group by dedup key,
   *   3. emit a single event per group (winner for time/title/rsvp; all rows for
   *      the attendee union + newest-with-value fallback on description/location/
   *      organiser).
   */
  _normalizeRows(rows) {
    if (!Array.isArray(rows)) return [];

    // 1. Resolve + filter
    const resolved = [];
    for (const row of rows) {
      const status = String(row.status || '').toUpperCase();
      const method = String(row.method || '').toUpperCase();
      if (status === 'CANCELLED' || method === 'CANCEL') continue;
      const start = resolveEventTime(row.dtstart, row.raw_ics, 'DTSTART');
      if (!start) continue;
      const end = resolveEventTime(row.dtend, row.raw_ics, 'DTEND');
      resolved.push({ row, start, end });
    }

    // 2. Group by dedup key; newest created_at wins the "best"/winner slot.
    const groups = new Map();
    for (const r of resolved) {
      const key = this._dedupKey(r.row, r.start.getTime());
      const g = groups.get(key);
      if (!g) {
        groups.set(key, { key, winner: r, all: [r] });
      } else {
        g.all.push(r);
        if (String(r.row.created_at || '') > String(g.winner.row.created_at || '')) {
          g.winner = r;
        }
      }
    }

    // 3. Emit one event per group
    const events = [];
    for (const g of groups.values()) events.push(this._buildEvent(g));
    return events;
  }

  /** Build the CXNotes event shape for one dedup group. */
  _buildEvent({ key, winner, all }) {
    const winnerRow = winner.row;
    const startDate = winner.start;
    const allDay = isDateOnly(winnerRow.dtstart);

    let endDate = winner.end;
    if (!endDate || endDate <= startDate) {
      endDate = new Date(startDate.getTime() + this._defaultMinutes * 60 * 1000);
    }

    // Newest-first view for the per-field "newest row that HAS the value" fallback
    // — RSVP replies carry no description/location/organiser, so we skip them.
    const newestFirst = [...all].sort((a, b) =>
      String(b.row.created_at || '').localeCompare(String(a.row.created_at || ''))
    );
    const pick = (getter) => {
      for (const r of newestFirst) {
        const v = getter(r.row);
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return '';
    };

    // Attendee union across every row in the group (a REPLY lists only the
    // responder), room-excluded + deduped by email (or name when email-less).
    const attendees = [];
    const seen = new Set();
    for (const r of all) {
      for (const a of parseIcsAttendees(r.row.raw_ics)) {
        const dedup = a.email ? a.email.toLowerCase() : `name:${a.name.toLowerCase()}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        attendees.push(a);
      }
    }

    const startISO = startDate.toISOString();
    return {
      id: `cxmail-${winnerRow.id}`,
      // Per-group (not per-row): dedup means one event per UID-group, so the
      // fingerprint keys on the dedup key + the winner's resolved start.
      occurrenceFingerprint: `cxmail:${key}:${startISO}`,
      title: cleanTitle(winnerRow.summary),
      startTime: startISO,
      endTime: endDate.toISOString(),
      isAllDay: allDay,
      calendarTitle: 'cxmail',
      organizer: {
        name: pick((r) => r.organizer_name) || '',
        email: pick((r) => r.organizer_email) || '',
      },
      attendees,
      notes: cleanDescription(pick((r) => r.description)),
      location: pick((r) => r.location) || '',
      declinedByMe: String(winnerRow.rsvp_status || '').toLowerCase() === 'declined',
      // Provenance flag: lets the shared meetingFilter skip its attendee-count gate.
      meetingWorthy: true,
      cxmailSource: winnerRow.source,
      confidence: typeof winnerRow.confidence === 'number' ? winnerRow.confidence : null,
    };
  }

  /**
   * Events that START within the next `windowMinutes`. We pull a coarse candidate
   * set in SQL (lower bound `now - 1 day` to tolerate UTC-vs-floating skew),
   * normalise/dedup in JS, and apply the precise window in JS where date parsing
   * is timezone-correct.
   */
  async getUpcomingEvents({ windowMinutes }) {
    if (!this.isAvailable()) return { events: [], error: 'cxmail-unavailable' };

    const sql =
      `SELECT ${COLUMNS} FROM calendar_events ` +
      `WHERE ${this._eligibilityClause()} ` +
      "AND datetime(dtstart) >= datetime('now', '-1 day') " +
      'ORDER BY dtstart ASC LIMIT 100;';

    const res = await this._runQuery(sql);
    if (res.error) return { events: [], error: res.error };

    const now = this._now();
    const windowEnd = new Date(now.getTime() + windowMinutes * 60 * 1000);
    const events = [];
    for (const ev of this._normalizeRows(res.rows)) {
      const start = new Date(ev.startTime);
      if (start >= now && start <= windowEnd) events.push(ev);
    }
    events.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    return { events };
  }

  /** The event whose [start, end) span contains now, or null. */
  async getCurrentEvent() {
    if (!this.isAvailable()) return { event: null, error: 'cxmail-unavailable' };

    const sql =
      `SELECT ${COLUMNS} FROM calendar_events ` +
      `WHERE ${this._eligibilityClause()} ` +
      "AND datetime(dtstart) >= datetime('now', '-1 day') " +
      "AND datetime(dtstart) <= datetime('now', '+1 day') " +
      'ORDER BY dtstart ASC LIMIT 100;';

    const res = await this._runQuery(sql);
    if (res.error) return { event: null, error: res.error };

    const now = this._now();
    const events = this._normalizeRows(res.rows).sort(
      (a, b) => new Date(a.startTime) - new Date(b.startTime)
    );
    for (const ev of events) {
      if (ev.isAllDay) continue;
      const start = new Date(ev.startTime);
      const end = new Date(ev.endTime);
      if (start <= now && end > now) return { event: ev };
    }
    return { event: null };
  }
}

module.exports = {
  CxmailCalendarSource,
  CXMAIL_DB_PATH,
  SQLITE_BIN,
  DEFAULT_MIN_CONFIDENCE,
  // Exported for unit tests of the pure helpers.
  parseIcsAttendees,
  parseCxmailDate,
  resolveEventTime,
  cleanTitle,
  cleanDescription,
  isDateOnly,
};
