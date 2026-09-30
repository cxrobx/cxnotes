'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  findWhisperBinary,
  findWhisperModel,
  verifyInstallation,
  whisperTimeoutMs,
  whisperArgs,
  parseWhisperProgress
} = require('./transcriber');
const { getAppSupportRoot } = require('../shared/paths');

/**
 * Where the module actually looks for the installed model.
 *
 * Derived from shared/paths.js rather than built from the injected HOME,
 * because getModelsDir() resolves against the real Application Support root
 * (invariant #12 keeps that path frozen and shared with the MCP server) and is
 * deliberately not parameterised.
 */
const APP_MODEL = path.join(getAppSupportRoot(), 'models', 'ggml-base.en.bin');

/**
 * Covers the discovery layer — which whisper binary and model get picked, in
 * what order, and what the user is told when neither is there.
 *
 * Ordering is the whole point of these lists, and it is exactly what silently
 * broke once before: repo-relative candidates resolve against `process.cwd()`,
 * which is `/` for a Dock-launched app, so they matched only on the machine
 * that built the app (gotcha #14, invariant #20). Pinning the order is what
 * stops that regressing.
 */

const HOME = '/Users/tester';

/** An fs stand-in where only the listed absolute paths exist. */
function fsWith(...existing) {
  const set = new Set(existing.map((p) => path.resolve(p)));
  return { existsSync: (p) => set.has(path.resolve(p)) };
}

const NOTHING = { existsSync: () => false };

/* ── the binary ──────────────────────────────────────────────── */

test('findWhisperBinary returns an absolute path to the binary it found', () => {
  const found = findWhisperBinary({
    fsImpl: fsWith('/opt/homebrew/bin/whisper-cpp'),
    home: HOME
  });

  assert.strictEqual(found, '/opt/homebrew/bin/whisper-cpp');
  assert.ok(path.isAbsolute(found));
});

test('findWhisperBinary accepts either Homebrew name, on either architecture', () => {
  for (const candidate of [
    '/opt/homebrew/bin/whisper-cpp',
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cpp',
    '/usr/local/bin/whisper-cli'
  ]) {
    assert.strictEqual(
      findWhisperBinary({ fsImpl: fsWith(candidate), home: HOME }),
      candidate
    );
  }
});

test('findWhisperBinary prefers Homebrew over a repo-relative dev build', () => {
  // The dev candidates resolve against cwd, so they must never win over a real
  // installed binary — that ordering is what makes a packaged app work.
  const devBuild = path.resolve('./whisper.cpp/build/bin/whisper-cli');
  const found = findWhisperBinary({
    fsImpl: fsWith('/opt/homebrew/bin/whisper-cpp', devBuild),
    home: HOME
  });

  assert.strictEqual(found, '/opt/homebrew/bin/whisper-cpp');
});

test('findWhisperBinary still finds a dev build when nothing is installed', () => {
  const devBuild = path.resolve('./whisper.cpp/build/bin/whisper-cli');

  assert.strictEqual(findWhisperBinary({ fsImpl: fsWith(devBuild), home: HOME }), devBuild);
});

test('findWhisperBinary explains how to install rather than just failing', () => {
  assert.throws(
    () => findWhisperBinary({ fsImpl: NOTHING, home: HOME }),
    (err) => {
      assert.match(err.message, /whisper\.cpp not found/);
      assert.match(err.message, /brew install whisper-cpp/, 'gives the one-line fix');
      assert.match(err.message, /setup\.sh/, 'and the from-source route');
      return true;
    }
  );
});

test('findWhisperBinary survives an unset HOME', () => {
  // A Dock-launched app has a minimal environment; joining onto an undefined
  // home used to be a TypeError rather than a miss.
  assert.throws(
    () => findWhisperBinary({ fsImpl: NOTHING, home: undefined }),
    /whisper\.cpp not found/
  );
});

/* ── the model ───────────────────────────────────────────────── */

test('findWhisperModel prefers VoiceInk large-v3-turbo over our base.en', () => {
  const voiceink = path.join(
    HOME,
    'Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/ggml-large-v3-turbo.bin'
  );
  assert.strictEqual(
    findWhisperModel({ fsImpl: fsWith(voiceink, APP_MODEL), home: HOME }),
    voiceink,
    'a larger local model beats base.en when it is already on the machine'
  );
});

test('findWhisperModel falls back to the app model directory', () => {
  // Invariant #20: this is the one location reachable from both a dev run and
  // a packaged app, and it is where setup.sh puts the model.
  assert.strictEqual(findWhisperModel({ fsImpl: fsWith(APP_MODEL), home: HOME }), APP_MODEL);
});

test('findWhisperModel prefers the app model directory over a repo copy', () => {
  const repo = path.resolve('./models/ggml-base.en.bin');

  assert.strictEqual(
    findWhisperModel({ fsImpl: fsWith(APP_MODEL, repo), home: HOME }),
    APP_MODEL
  );
});

test('findWhisperModel points at setup.sh and names the exact target path', () => {
  assert.throws(
    () => findWhisperModel({ fsImpl: NOTHING, home: HOME }),
    (err) => {
      assert.match(err.message, /Whisper model not found/);
      assert.match(err.message, /setup\.sh/);
      assert.match(err.message, /ggml-base\.en\.bin/, 'names the file');
      assert.match(err.message, /download-ggml-model\.sh base\.en/, 'gives the manual route');
      return true;
    }
  );
});

/* ── the dependency report ───────────────────────────────────── */

test('verifyInstallation reports both paths when everything is present', () => {
  const bin = '/opt/homebrew/bin/whisper-cpp';
  const result = verifyInstallation({ fsImpl: fsWith(bin, APP_MODEL), home: HOME });

  assert.deepStrictEqual(result, {
    installed: true,
    binaryPath: bin,
    modelPath: APP_MODEL,
    error: null
  });
});

test('verifyInstallation blames the binary when the binary is what is missing', () => {
  const result = verifyInstallation({ fsImpl: fsWith(APP_MODEL), home: HOME });

  assert.strictEqual(result.installed, false);
  assert.strictEqual(result.binaryPath, null);
  assert.match(result.error, /whisper\.cpp not found/);
  assert.strictEqual(result.modelPath, null, 'stops at the first failure');
});

test('verifyInstallation blames the model when only the model is missing', () => {
  const bin = '/opt/homebrew/bin/whisper-cpp';

  const result = verifyInstallation({ fsImpl: fsWith(bin), home: HOME });

  assert.strictEqual(result.installed, false);
  assert.strictEqual(result.binaryPath, bin, 'the binary it did find is still reported');
  assert.match(result.error, /Whisper model not found/);
});

test('verifyInstallation never throws, whatever is missing', () => {
  const result = verifyInstallation({ fsImpl: NOTHING, home: HOME });

  assert.strictEqual(result.installed, false);
  assert.ok(typeof result.error === 'string' && result.error.length > 0);
});

/* ── the whisper command line ────────────────────────────────── */

const MB = 1024 * 1024;

test('whisperTimeoutMs never drops below the five-minute floor', () => {
  // A tiny file still needs time for model load and startup.
  assert.strictEqual(whisperTimeoutMs(0), 5 * 60 * 1000);
  assert.strictEqual(whisperTimeoutMs(1 * MB), 10 * 60 * 1000);
});

test('whisperTimeoutMs scales with file size', () => {
  // Transcription time tracks audio length almost linearly, so a fixed ceiling
  // either kills long meetings or lets a wedged process hang for hours.
  assert.strictEqual(whisperTimeoutMs(20 * MB), 10 * 60 * 1000);
  assert.strictEqual(whisperTimeoutMs(21 * MB), 20 * 60 * 1000);
  assert.strictEqual(whisperTimeoutMs(100 * MB), 50 * 60 * 1000);
});

test('whisperTimeoutMs is generous for a long meeting', () => {
  // A 90-minute dual-track session is ~170 MB per track.
  assert.ok(whisperTimeoutMs(170 * MB) >= 85 * 60 * 1000);
});

test('whisperArgs passes the model, input and output prefix', () => {
  const args = whisperArgs({ modelPath: '/m.bin', wavPath: '/a.wav', prefix: '/out/sys', outputCsv: false });

  assert.deepStrictEqual(args, [
    '-m', '/m.bin', '-f', '/a.wav', '-otxt', '-of', '/out/sys',
    '--print-progress', '--language', 'en', '--threads', '4', '--processors', '2'
  ]);
});

test('whisperArgs adds CSV output only when asked', () => {
  // -ocsv is what makes dual-track merging possible: the merger needs per-line
  // timings, which the plain text output does not carry.
  assert.ok(!whisperArgs({ modelPath: 'm', wavPath: 'a', prefix: 'p', outputCsv: false }).includes('-ocsv'));
  assert.ok(whisperArgs({ modelPath: 'm', wavPath: 'a', prefix: 'p', outputCsv: true }).includes('-ocsv'));
});

test('whisperArgs always asks for progress, so the UI can move', () => {
  assert.ok(whisperArgs({ modelPath: 'm', wavPath: 'a', prefix: 'p' }).includes('--print-progress'));
});

/* ── progress parsing ────────────────────────────────────────── */

test('parseWhisperProgress returns null before whisper says anything', () => {
  assert.strictEqual(parseWhisperProgress(''), null);
  assert.strictEqual(parseWhisperProgress('whisper_init_state: loading model'), null);
});

test('parseWhisperProgress reads the latest percentage, not the first', () => {
  // stderr accumulates, so the buffer holds every progress line ever printed.
  const stderr = 'progress =  10%\nprogress =  45%\nprogress = 100%\n';
  assert.strictEqual(parseWhisperProgress(stderr), 100);
});

test('parseWhisperProgress tolerates the spacing whisper actually emits', () => {
  assert.strictEqual(parseWhisperProgress('progress =  5%'), 5);
  assert.strictEqual(parseWhisperProgress('progress=75%'), 75);
  assert.strictEqual(parseWhisperProgress('  progress =   100%  '), 100);
});

test('parseWhisperProgress ignores unrelated stderr chatter', () => {
  assert.strictEqual(parseWhisperProgress('ggml_metal_init: allocating\nsystem_info: n_threads = 4'), null);
});
