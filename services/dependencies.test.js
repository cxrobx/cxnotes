'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  resolveSystemAudio,
  resolveMicrophone,
  resolveTranscription,
  summariseToConsole,
  describeDependencyStatus,
  resolveSetupCommand,
  buildSetupTerminalScript,
  setupFallbackMessage
} = require('./dependencies');

const PROVIDER_LINES = '  Codex: npm install -g @openai/codex\n  Claude: npm install -g @anthropic-ai/claude-code';

/* ── system audio ────────────────────────────────────────────── */

test('ScreenCaptureKit permitted is the one route to system audio', () => {
  const r = resolveSystemAudio({ sckAvailable: true, sckPermitted: true });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.method, 'sck');
});

test('SCK available but unpermitted is not a capture route', () => {
  const r = resolveSystemAudio({ sckAvailable: true, sckPermitted: false });

  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.method, null);
});

test('the two failure causes are reported apart, because the fixes differ', () => {
  // Ungranted permission is two clicks; an unavailable SCK is a build or an
  // OS-version problem. The old single message named both and helped with
  // neither.
  const unpermitted = resolveSystemAudio({ sckAvailable: true, sckPermitted: false });
  const unavailable = resolveSystemAudio({ sckAvailable: false, sckPermitted: null });

  assert.match(unpermitted.reason, /permission/i);
  assert.doesNotMatch(unpermitted.reason, /macOS 13/);
  assert.match(unavailable.reason, /macOS 13/);
  assert.doesNotMatch(unavailable.reason, /permission/i);
});

test('no BlackHole input can conjure a capture route', () => {
  // The fallback is gone. A caller still passing the old probe keys must not
  // accidentally resurrect it — silence that reports itself ready is the exact
  // failure this removal exists to prevent.
  const r = resolveSystemAudio({ sckAvailable: false, sckPermitted: null, blackhole: true, sox: true });

  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.method, null);
});

/* ── microphone ──────────────────────────────────────────────── */

test('system-only mode never reports a missing microphone', () => {
  // Otherwise anyone recording system-only sees a permanent false alarm.
  const r = resolveMicrophone({ mode: 'system', configuredDevice: null, deviceVerifies: false, defaultDevice: null });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.required, false);
});

test('a configured mic is judged by whether it verifies', () => {
  const ok = resolveMicrophone({ mode: 'dual', configuredDevice: 'Babyface Pro', deviceVerifies: true });
  const gone = resolveMicrophone({ mode: 'dual', configuredDevice: 'Babyface Pro', deviceVerifies: false });

  assert.strictEqual(ok.ok, true);
  assert.match(ok.detail, /Babyface Pro.*available/);
  assert.strictEqual(gone.ok, false);
  assert.match(gone.detail, /Babyface Pro.*not found/);
});

test('with no configured mic, dual mode falls back to the default device', () => {
  const found = resolveMicrophone({
    mode: 'dual', configuredDevice: null, defaultDevice: { name: 'MacBook Pro Microphone' }
  });
  const none = resolveMicrophone({ mode: 'dual', configuredDevice: null, defaultDevice: null });

  assert.strictEqual(found.ok, true);
  assert.match(found.detail, /MacBook Pro Microphone/);
  assert.strictEqual(none.ok, false);
  assert.match(none.detail, /none found/);
});

/* ── transcription ───────────────────────────────────────────── */

test('either backend present means transcription works', () => {
  // Parakeet (via uv) is the DEFAULT; whisper.cpp only the fallback. Counting
  // whisper alone nagged every Parakeet-only machine with a Setup dialog on
  // launch — the 2026-08-19 install feedback.
  assert.strictEqual(resolveTranscription({ parakeet: true, whisper: false }).ok, true);
  assert.strictEqual(resolveTranscription({ parakeet: false, whisper: true }).ok, true);
  assert.strictEqual(resolveTranscription({ parakeet: true, whisper: true }).ok, true);
  assert.strictEqual(resolveTranscription({ parakeet: false, whisper: false }).ok, false);
});

test('the transcription detail names which backend is carrying it', () => {
  assert.match(resolveTranscription({ parakeet: true, whisper: false }).detail, /Parakeet/);
  assert.match(resolveTranscription({ parakeet: false, whisper: true }).detail, /whisper\.cpp only/);
  assert.match(resolveTranscription({ parakeet: true, whisper: true }).detail, /fallback ready/);
});

/* ── console summary ─────────────────────────────────────────── */

test('the console summary reports all five lines', () => {
  const out = summariseToConsole({ sox: true, systemAudio: true, parakeet: true, whisper: true, codex: true, mic: true });

  assert.match(out, /sox: {11}OK/);
  assert.match(out, /system audio: {2}OK/);
  assert.match(out, /transcription: OK \(Parakeet, whisper\.cpp fallback ready\)/);
  assert.match(out, /ai summary: {4}OK/);
  assert.match(out, /mic: {11}OK/);
});

test('the console summary marks what is missing', () => {
  const out = summariseToConsole({ sox: false, systemAudio: false, parakeet: false, whisper: true, codex: false, mic: true });

  assert.match(out, /sox: {11}MISSING/);
  assert.match(out, /transcription: OK \(whisper\.cpp only/);
  assert.match(out, /ai summary: {4}MISSING/);
});

test('a Parakeet-only machine reads transcription OK in the summary', () => {
  const out = summariseToConsole({ sox: true, systemAudio: true, parakeet: true, whisper: false, codex: true, mic: true });

  assert.match(out, /transcription: OK \(Parakeet\)/);
  assert.doesNotMatch(out, /transcription: MISSING/);
});

/* ── the dialog ──────────────────────────────────────────────── */

const ALL = { sox: true, parakeet: true, whisper: true, codex: true, mic: true };

test('everything installed reads as info with a single button', () => {
  const d = describeDependencyStatus(ALL, PROVIDER_LINES);

  assert.strictEqual(d.type, 'info');
  assert.strictEqual(d.allReady, true);
  assert.deepStrictEqual(d.buttons, ['OK']);
  assert.match(d.detail, /All dependencies installed!/);
});

test('a missing recording dependency offers to run setup', () => {
  const d = describeDependencyStatus({ ...ALL, sox: false }, PROVIDER_LINES);

  assert.strictEqual(d.type, 'warning');
  assert.strictEqual(d.canRunSetup, true);
  assert.deepStrictEqual(d.buttons, ['Run Setup', 'OK']);
  assert.match(d.detail, /MISSING sox/);
});

test('a missing AI CLI does NOT offer setup, because setup cannot install one', () => {
  // Setup installs sox and a transcriber; the summariser CLIs are separate
  // paid subscriptions. Offering "Run Setup" here sends the user through a
  // script that cannot fix their problem.
  const d = describeDependencyStatus({ ...ALL, codex: false }, PROVIDER_LINES);

  assert.strictEqual(d.canRunSetup, false);
  assert.deepStrictEqual(d.buttons, ['OK']);
  assert.match(d.detail, /AI summarisation needs one of these CLIs/);
  assert.match(d.detail, /@openai\/codex/, 'names how to install one');
  assert.doesNotMatch(d.detail, /brew install sox/, 'no advice for items that are fine');
});

test('missing both kinds offers setup AND explains the CLIs separately', () => {
  const d = describeDependencyStatus(
    { sox: false, parakeet: false, whisper: false, codex: false, mic: true },
    PROVIDER_LINES
  );

  assert.strictEqual(d.canRunSetup, true);
  assert.match(d.detail, /sox: brew install sox/);
  assert.match(d.detail, /Transcription: brew install uv/);
  assert.match(d.detail, /AI summarisation needs one of these CLIs/);
});

test('a Parakeet-only machine is NOT nagged about a missing whisper.cpp', () => {
  // The exact 2026-08-19 report: uv/Parakeet working, whisper absent, and the
  // app still opened a "Setup Required" dialog it could not act on.
  const d = describeDependencyStatus({ ...ALL, whisper: false }, PROVIDER_LINES);

  assert.strictEqual(d.allReady, true);
  assert.strictEqual(d.canRunSetup, false);
  assert.deepStrictEqual(d.buttons, ['OK']);
  assert.match(d.detail, /OK Transcription/);
});

test('a whisper-only machine (no uv) also counts as transcribing', () => {
  const d = describeDependencyStatus({ ...ALL, parakeet: false }, PROVIDER_LINES);

  assert.strictEqual(d.allReady, true);
  assert.strictEqual(d.canRunSetup, false);
});

test('each missing item gets its own fix line', () => {
  const d = describeDependencyStatus(
    { sox: false, parakeet: false, whisper: false, codex: true, mic: false },
    PROVIDER_LINES
  );

  assert.match(d.detail, /sox: brew install sox/);
  assert.match(d.detail, /Transcription: brew install uv \(Parakeet\), or Run Setup/);
  assert.match(d.detail, /Microphone: none found/);
  assert.doesNotMatch(d.detail, /AI summarisation needs/, 'codex is fine, no advice for it');
});

test('a missing microphone alone is a warning with no setup offer', () => {
  const d = describeDependencyStatus({ ...ALL, mic: false }, PROVIDER_LINES);

  assert.strictEqual(d.allReady, false);
  assert.strictEqual(d.canRunSetup, false, 'setup.sh cannot conjure a microphone');
  assert.match(d.detail, /MISSING Microphone/);
});

test('every dependency is listed in a stable order', () => {
  const d = describeDependencyStatus(ALL, PROVIDER_LINES);
  const order = d.detail.split('\n').filter((l) => /^(OK|MISSING) /.test(l));

  assert.deepStrictEqual(order, [
    'OK sox (audio recording)',
    'OK Transcription (Parakeet / whisper.cpp)',
    'OK AI Summarisation (Codex/Claude)',
    'OK Microphone (dual-track)'
  ]);
});

/* ── the setup script launcher ───────────────────────────────── */

test('a dev checkout runs the repo setup.sh, exactly as before', () => {
  const cmd = resolveSetupCommand({
    isPackaged: false,
    repoDir: '/Users/tester/Projects/cxnotes-dev',
    resourcesPath: '/wrong/if/used'
  });

  assert.strictEqual(cmd, 'cd "/Users/tester/Projects/cxnotes-dev" && chmod +x setup.sh && ./setup.sh');
});

test('a packaged app runs the bundled setup-packaged.sh via bash', () => {
  // __dirname in a packaged app points inside app.asar — an archive file that
  // `cd` cannot enter — so the packaged branch must never touch repoDir. And
  // `bash <script>` needs no execute bit, so nothing writes into the signed
  // bundle.
  const cmd = resolveSetupCommand({
    isPackaged: true,
    repoDir: '/Applications/CXNotes.app/Contents/Resources/app.asar',
    resourcesPath: '/Applications/CXNotes.app/Contents/Resources'
  });

  assert.strictEqual(cmd, 'bash "/Applications/CXNotes.app/Contents/Resources/setup-packaged.sh"');
  assert.doesNotMatch(cmd, /app\.asar/, 'must not cd into the archive');
});

test('the Terminal script wraps the command with its quotes escaped', () => {
  const s = buildSetupTerminalScript('cd "/Users/tester/Projects/cxnotes-dev" && chmod +x setup.sh && ./setup.sh');

  assert.match(s, /tell application "Terminal"/);
  assert.match(s, /activate/);
  assert.match(s, /cd \\"\/Users\/tester\/Projects\/cxnotes-dev\\"/);
  assert.match(s, /chmod \+x setup\.sh && \.\/setup\.sh/);
});

test('a path with spaces stays quoted', () => {
  const s = buildSetupTerminalScript('cd "/Users/tester/My Projects/cxnotes-dev" && ./setup.sh');

  assert.match(s, /cd \\"\/Users\/tester\/My Projects\/cxnotes-dev\\"/);
});

test('the fallback message tells the user exactly what to run by hand', () => {
  const m = setupFallbackMessage('bash "/Applications/CXNotes.app/Contents/Resources/setup-packaged.sh"');

  assert.match(m, /Failed to open Terminal/);
  assert.match(m, /bash "\/Applications\/CXNotes\.app\/Contents\/Resources\/setup-packaged\.sh"/);
});
