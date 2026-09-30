'use strict';

/**
 * A durable, rotated log file for the main process.
 *
 * Until 2026-09-25 CXNotes logged only to the console, which nothing keeps: a
 * recording that stopped, restarted or never started left no account of why
 * once the app had moved on. Every `console.log/info/warn/error` in the main
 * process is now also appended here, timestamped, so the next "what happened
 * to that recording?" has an answer.
 *
 * `~/Library/Logs/CXNotes/cxnotes.log`, size-rotated to `.1` … `.N`. Written
 * synchronously (an append on an open descriptor), so the lines before a crash
 * are on disk. Never throws: a log that cannot be written disables itself and
 * says so once on the console, and the app carries on.
 *
 * Transcript text must not land here (invariant #5 keeps it local, but a log
 * is the file people attach to bug reports). The one path that prints it —
 * whisper's stdout echo — is filtered by `SKIP_PATTERNS`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const DEFAULT_DIR = path.join(os.homedir(), 'Library', 'Logs', 'CXNotes');
const DEFAULT_NAME = 'cxnotes.log';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;

/** Lines that carry transcript text: kept on the console, never in the file. */
const SKIP_PATTERNS = [/^whisper stdout:/];

/**
 * @param {object} [opts]
 * @param {string} [opts.dir]
 * @param {string} [opts.name]
 * @param {number} [opts.maxBytes] - rotate once the file passes this size
 * @param {number} [opts.keep] - rotated files kept (`.1` newest)
 * @param {object} [opts.fsImpl]
 * @param {() => Date} [opts.now]
 */
function createFileLog({
  dir = DEFAULT_DIR, name = DEFAULT_NAME, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP,
  fsImpl = fs, now = () => new Date()
} = {}) {
  const file = path.join(dir, name);
  let fd = null;
  let size = 0;
  let disabled = false;

  function open() {
    fsImpl.mkdirSync(dir, { recursive: true });
    fd = fsImpl.openSync(file, 'a');
    size = fsImpl.fstatSync(fd).size;
  }

  function rotate() {
    try { fsImpl.closeSync(fd); } catch { /* ignore */ }
    fd = null;
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fsImpl.existsSync(from)) fsImpl.renameSync(from, `${file}.${i + 1}`);
    }
    if (fsImpl.existsSync(file)) fsImpl.renameSync(file, `${file}.1`);
    const oldest = `${file}.${keep + 1}`;
    if (fsImpl.existsSync(oldest)) fsImpl.unlinkSync(oldest);
    open();
  }

  /**
   * @param {string} level
   * @param {Array} args - console arguments
   * @returns {boolean} whether the line was written
   */
  function write(level, args) {
    if (disabled) return false;
    let text;
    try {
      text = util.format(...args);
    } catch {
      text = String(args[0]);
    }
    if (SKIP_PATTERNS.some((re) => re.test(text))) return false;
    try {
      if (fd === null) open();
      const line = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`;
      const buf = Buffer.from(line, 'utf-8');
      fsImpl.writeSync(fd, buf);
      size += buf.length;
      if (size >= maxBytes) rotate();
      return true;
    } catch (err) {
      disabled = true;
      try { if (fd !== null) fsImpl.closeSync(fd); } catch { /* ignore */ }
      fd = null;
      process.stderr.write(`[fileLog] disabled — could not write ${file}: ${err.message}\n`);
      return false;
    }
  }

  function close() {
    if (fd !== null) {
      try { fsImpl.closeSync(fd); } catch { /* ignore */ }
      fd = null;
    }
  }

  return { file, write, close };
}

/**
 * Tee `console.log/info/warn/error` into a file log. Idempotent.
 *
 * @param {object} [opts] - as `createFileLog`, plus `consoleImpl`
 * @returns {{file:string, uninstall:() => void}}
 */
function installFileLog(opts = {}) {
  const target = opts.consoleImpl || console;
  if (target.__cxnotesFileLog) return target.__cxnotesFileLog;
  const log = createFileLog(opts);
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error']) {
    originals[level] = target[level];
    target[level] = (...args) => {
      originals[level].apply(target, args);
      log.write(level === 'log' ? 'info' : level, args);
    };
  }
  const handle = {
    file: log.file,
    uninstall() {
      for (const level of Object.keys(originals)) target[level] = originals[level];
      log.close();
      delete target.__cxnotesFileLog;
    }
  };
  target.__cxnotesFileLog = handle;
  return handle;
}

module.exports = { createFileLog, installFileLog, DEFAULT_DIR, SKIP_PATTERNS };
