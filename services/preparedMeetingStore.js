'use strict';

/**
 * Prepared-meeting store — the filesystem handoff between the standalone MCP
 * server (writer) and the Electron app (reader/claimer).
 *
 * Shape: a directory of one JSON file per prepared occurrence under
 * `<handoff>/prepared`. The MCP server stages files; the app reads + claims them
 * when a matching call is detected. This is the ONLY cross-process channel
 * (never electron-store — a second writer would clobber it).
 *
 * Authoritative applied-state is the FILENAME SUFFIX, not an in-body `status`:
 *   <base>.json        — live (preparable / claimable)
 *   <base>.applied     — claimed by the app (atomic rename winner)
 *   <base>.cancelled   — cancelled by the MCP server
 * The atomic `rename(.json → .applied)` makes claiming race-safe: exactly one
 * caller wins; the ENOENT loser falls back gracefully.
 *
 * Defensive by construction: no method throws. Reads use per-record try/catch so
 * a single corrupt file can never crash an app poll.
 *
 * Record schema (owned here):
 *   { schemaVersion, occurrenceFingerprint, eventId, title, startTime, endTime,
 *     template (opaque rendered context/markdown), source ('mcp'|'auto'),
 *     createdAt, expiresAt (= endTime + grace) }
 */

const fs = require('fs');
const path = require('path');
const { getPreparedDir, getTmpDir } = require('../shared/paths');

const SCHEMA_VERSION = 1;
// Grace window after a meeting ends before its prepared file is eligible for
// pruning — covers meetings that run long / start late.
const DEFAULT_GRACE_MS = 60 * 60 * 1000; // 1 hour
// Corrupt (unparseable) files older than this are swept by pruneExpired so the
// directory can't accumulate junk we can't read an expiry from.
const CORRUPT_SWEEP_MS = 24 * 60 * 60 * 1000; // 24 hours

const LIVE_EXT = '.json';
const APPLIED_EXT = '.applied';
const CANCELLED_EXT = '.cancelled';

// Monotonic-ish counter for tmp filename uniqueness within a process.
let tmpCounter = 0;

/**
 * Deterministic, filesystem-safe base name for a fingerprint. The fingerprint
 * (`cal:<calItemId>:<ISO start>`) maps to a stable filename so getByFingerprint
 * / claim / cancel can locate the file without scanning.
 */
function fingerprintToBase(fingerprint) {
  return 'cal_' + String(fingerprint == null ? '' : fingerprint)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

class PreparedMeetingStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.preparedDir] - override the prepared dir (tests)
   * @param {string} [opts.tmpDir] - override the tmp dir (tests)
   */
  constructor({ preparedDir = null, tmpDir = null } = {}) {
    this._preparedDir = preparedDir || getPreparedDir();
    this._tmpDir = tmpDir || getTmpDir();
  }

  _ensureDirs() {
    try {
      fs.mkdirSync(this._preparedDir, { recursive: true });
      fs.mkdirSync(this._tmpDir, { recursive: true });
    } catch {
      /* best effort — surfaced by the write that follows */
    }
  }

  _livePath(fp) {
    return path.join(this._preparedDir, fingerprintToBase(fp) + LIVE_EXT);
  }
  _appliedPath(fp) {
    return path.join(this._preparedDir, fingerprintToBase(fp) + APPLIED_EXT);
  }
  _cancelledPath(fp) {
    return path.join(this._preparedDir, fingerprintToBase(fp) + CANCELLED_EXT);
  }

  /**
   * Normalise + complete a record. Computes expiresAt from endTime + grace when
   * not supplied. Returns null when there's no usable fingerprint.
   */
  _normalise(record) {
    if (!record || typeof record !== 'object') return null;
    const fp = record.occurrenceFingerprint;
    if (typeof fp !== 'string' || !fp) return null;

    const createdAt = record.createdAt || new Date().toISOString();
    let expiresAt = record.expiresAt;
    if (!expiresAt) {
      const endMs = Date.parse(record.endTime);
      expiresAt = Number.isFinite(endMs)
        ? new Date(endMs + DEFAULT_GRACE_MS).toISOString()
        : new Date(Date.now() + DEFAULT_GRACE_MS).toISOString();
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      occurrenceFingerprint: fp,
      eventId: record.eventId || null,
      title: typeof record.title === 'string' ? record.title : '',
      startTime: record.startTime || null,
      endTime: record.endTime || null,
      template: record.template == null ? null : record.template,
      source: record.source === 'auto' ? 'auto' : 'mcp',
      createdAt,
      expiresAt,
    };
  }

  // ---- Write / stage API (MCP server) -------------------------------------

  /**
   * Stage a prepared meeting. Atomic tmp+rename so the app never reads a
   * half-written file. Overwrites any existing live file for the same
   * occurrence (re-preparing is idempotent).
   *
   * @returns {{ ok: boolean, record?: object, path?: string, error?: string }}
   */
  prepare(record) {
    const normalised = this._normalise(record);
    if (!normalised) return { ok: false, error: 'invalid-record: occurrenceFingerprint required' };

    this._ensureDirs();
    const dest = this._livePath(normalised.occurrenceFingerprint);
    const tmp = path.join(
      this._tmpDir,
      `${fingerprintToBase(normalised.occurrenceFingerprint)}.${process.pid}.${tmpCounter++}.tmp`
    );

    try {
      fs.writeFileSync(tmp, JSON.stringify(normalised, null, 2), 'utf8');
      fs.renameSync(tmp, dest);
      return { ok: true, record: normalised, path: dest };
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, error: err.message };
    }
  }

  /**
   * List all LIVE prepared records (skips corrupt files, never throws).
   * @returns {object[]}
   */
  list() {
    let entries;
    try {
      entries = fs.readdirSync(this._preparedDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of entries) {
      if (!name.endsWith(LIVE_EXT)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this._preparedDir, name), 'utf8'));
        if (rec && typeof rec === 'object') out.push(rec);
      } catch {
        /* corrupt file — skip */
      }
    }
    return out;
  }

  /**
   * Cancel a live prepared meeting: rename `.json → .cancelled`.
   * @returns {{ ok: boolean, reason?: string, error?: string }}
   */
  cancel(fingerprint) {
    try {
      fs.renameSync(this._livePath(fingerprint), this._cancelledPath(fingerprint));
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.code === 'ENOENT' ? 'not-found' : 'error', error: err.message };
    }
  }

  // ---- Read / claim API (Electron app) ------------------------------------

  /**
   * Read the LIVE record for a fingerprint, or null when absent/corrupt. Pure
   * read — does not claim. Never throws.
   * @returns {object|null}
   */
  getByFingerprint(fingerprint) {
    if (typeof fingerprint !== 'string' || !fingerprint) return null;
    try {
      const rec = JSON.parse(fs.readFileSync(this._livePath(fingerprint), 'utf8'));
      return rec && typeof rec === 'object' ? rec : null;
    } catch {
      return null;
    }
  }

  /**
   * Atomically claim a prepared meeting: rename `.json → .applied`. The rename
   * is the synchronisation point — exactly one caller wins; a concurrent (or
   * already-claimed) caller gets ENOENT and `ok:false, reason:'not-found'`.
   *
   * @returns {{ ok: boolean, record?: object|null, reason?: string, error?: string }}
   */
  claim(fingerprint) {
    if (typeof fingerprint !== 'string' || !fingerprint) {
      return { ok: false, reason: 'invalid' };
    }
    const live = this._livePath(fingerprint);
    const applied = this._appliedPath(fingerprint);

    // Read the body BEFORE the rename so we can return it. If unparseable we
    // still claim (so it isn't reprocessed) and return record:null.
    let record = null;
    try {
      record = JSON.parse(fs.readFileSync(live, 'utf8'));
    } catch {
      record = null;
    }

    try {
      fs.renameSync(live, applied);
    } catch (err) {
      return { ok: false, reason: err.code === 'ENOENT' ? 'not-found' : 'error', error: err.message };
    }
    return { ok: true, record };
  }

  // ---- Maintenance --------------------------------------------------------

  /**
   * Remove expired files (live, applied, or cancelled) whose `expiresAt` has
   * passed, plus corrupt files older than the corrupt-sweep window. Never throws.
   *
   * @param {Date|number} [now=Date.now()] - clock injection for tests
   * @returns {number} count removed
   */
  pruneExpired(now = Date.now()) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    let entries;
    try {
      entries = fs.readdirSync(this._preparedDir);
    } catch {
      return 0;
    }

    let removed = 0;
    for (const name of entries) {
      if (!(name.endsWith(LIVE_EXT) || name.endsWith(APPLIED_EXT) || name.endsWith(CANCELLED_EXT))) {
        continue;
      }
      const full = path.join(this._preparedDir, name);
      let expired = false;
      try {
        const rec = JSON.parse(fs.readFileSync(full, 'utf8'));
        const expMs = Date.parse(rec && rec.expiresAt);
        expired = Number.isFinite(expMs) && expMs < nowMs;
      } catch {
        // Corrupt/unparseable: sweep if the file is old enough.
        try {
          const ageMs = nowMs - fs.statSync(full).mtimeMs;
          expired = ageMs > CORRUPT_SWEEP_MS;
        } catch {
          expired = false;
        }
      }
      if (expired) {
        try {
          fs.unlinkSync(full);
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
    return removed;
  }
}

module.exports = {
  PreparedMeetingStore,
  SCHEMA_VERSION,
  DEFAULT_GRACE_MS,
  fingerprintToBase,
};
