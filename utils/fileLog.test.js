'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFileLog, installFileLog } = require('./fileLog');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-log-'));
}

test('fileLog: lines are timestamped with their level', () => {
  const dir = tempDir();
  const log = createFileLog({ dir, now: () => new Date('2026-09-25T14:10:14.979Z') });
  log.write('info', ['[Recording] stop requested: reason=%s', 'silence-auto-stop']);
  log.close();
  const text = fs.readFileSync(path.join(dir, 'cxnotes.log'), 'utf-8');
  assert.strictEqual(text, '2026-09-25T14:10:14.979Z INFO  [Recording] stop requested: reason=silence-auto-stop\n');
});

test('fileLog: rotates by size and keeps only N files', () => {
  const dir = tempDir();
  const log = createFileLog({ dir, maxBytes: 200, keep: 2 });
  for (let i = 0; i < 40; i++) log.write('info', [`line ${i} ${'x'.repeat(40)}`]);
  log.close();
  const files = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(files, ['cxnotes.log', 'cxnotes.log.1', 'cxnotes.log.2']);
  assert.ok(fs.statSync(path.join(dir, 'cxnotes.log.1')).size >= 200);
  // The newest line is in the live file.
  assert.match(fs.readFileSync(path.join(dir, 'cxnotes.log'), 'utf-8') + fs.readFileSync(path.join(dir, 'cxnotes.log.1'), 'utf-8'), /line 39 /);
});

test('fileLog: transcript text from whisper stdout never reaches the file', () => {
  const dir = tempDir();
  const log = createFileLog({ dir });
  assert.strictEqual(log.write('info', ['whisper stdout: [00:00.000 --> 00:02.000] something said']), false);
  log.write('info', ['kept']);
  log.close();
  const text = fs.readFileSync(path.join(dir, 'cxnotes.log'), 'utf-8');
  assert.doesNotMatch(text, /something said/);
  assert.match(text, /kept/);
});

test('fileLog: an unwritable location disables the log instead of throwing', () => {
  const blocker = path.join(tempDir(), 'a-file');
  fs.writeFileSync(blocker, '');
  const log = createFileLog({ dir: path.join(blocker, 'logs') }); // a dir under a file
  const origWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.strictEqual(log.write('error', ['boom']), false);
    assert.strictEqual(log.write('error', ['again']), false);
  } finally {
    process.stderr.write = origWrite;
  }
});

test('installFileLog: tees console calls and still prints them', () => {
  const dir = tempDir();
  const printed = [];
  const fakeConsole = {
    log: (...a) => printed.push(['log', a.join(' ')]),
    info: (...a) => printed.push(['info', a.join(' ')]),
    warn: (...a) => printed.push(['warn', a.join(' ')]),
    error: (...a) => printed.push(['error', a.join(' ')])
  };
  const handle = installFileLog({ dir, consoleImpl: fakeConsole });
  assert.strictEqual(installFileLog({ dir, consoleImpl: fakeConsole }), handle, 'idempotent');
  fakeConsole.log('hello', 1);
  fakeConsole.error(new Error('bad thing'));
  handle.uninstall();
  fakeConsole.log('after');
  const text = fs.readFileSync(path.join(dir, 'cxnotes.log'), 'utf-8');
  assert.match(text, /INFO  hello 1/);
  assert.match(text, /ERROR Error: bad thing/);
  assert.doesNotMatch(text, /after/);
  assert.strictEqual(printed.length, 3);
});
