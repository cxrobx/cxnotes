'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * setup-packaged.sh runs against the same sandbox recipe as setup.test.js: a
 * throwaway HOME, and a PATH whose only entries are stubs for every external
 * command the script shells out to. See setup.test.js for why allow-listing
 * the PATH is the only way "missing" can mean missing.
 *
 * What is DIFFERENT from setup.sh, and what these tests pin down: no git, no
 * cmake, no swift — a user's machine has no repo to build from. The script may
 * only install from Homebrew and download the model over curl, and a failed
 * or partial download must never leave a file wearing the model's name,
 * because the app tests for the model by existence alone.
 */

const SETUP = path.resolve(__dirname, 'setup-packaged.sh');

/** Commands the script invokes that must never reach the real system. */
const STUBBED = ['brew', 'sox', 'uv', 'uvx', 'curl', 'whisper-cli', 'whisper-cpp'];

/** Real utilities the script genuinely needs, symlinked in individually. */
const REAL_UTILITIES = ['mkdir', 'mv', 'rm', 'head', 'bash'];

const MODEL_REL = path.join('Library', 'Application Support', 'CXNotes', 'models', 'ggml-base.en.bin');

function makeSandbox({ present = [], curlFails = false, prebuilt = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-setup-pkg-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const log = path.join(root, 'calls.log');

  for (const dir of [bin, home]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(log, '');

  for (const util of REAL_UTILITIES) {
    const real = ['/bin', '/usr/bin'].map((d) => path.join(d, util)).find((p) => fs.existsSync(p));
    if (real) fs.symlinkSync(real, path.join(bin, util));
  }

  for (const name of STUBBED) {
    if (!present.includes(name)) continue;
    fs.writeFileSync(path.join(bin, name), stubFor(name, { curlFails, log }), { mode: 0o755 });
  }

  if (prebuilt.appModel) {
    const modelPath = path.join(home, MODEL_REL);
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, 'MODEL');
  }

  return { root, bin, home, log };
}

function stubFor(name, { curlFails, log }) {
  const header =
    `#!/bin/bash\n` +
    `__line="${name}"; [ $# -gt 0 ] && __line="$__line $*"\n` +
    `echo "$__line" >> "${log}"\n`;

  switch (name) {
    case 'sox':
      return header + `echo "sox: SoX v14.4.2"\nexit 0\n`;
    case 'curl':
      if (curlFails) return header + `exit 22\n`;
      // Honour `-o <file>` the way the script uses it, so the download branch
      // has a real artefact to rename into place.
      return (
        header +
        `out=""; prev=""\n` +
        `for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done\n` +
        `[ -n "$out" ] && echo MODEL > "$out"\n` +
        `exit 0\n`
      );
    default:
      return header + `exit 0\n`;
  }
}

function runSetup(sandbox, { ostype = 'darwin23' } = {}) {
  const result = spawnSync('bash', [SETUP], {
    encoding: 'utf-8',
    env: {
      PATH: sandbox.bin,
      HOME: sandbox.home,
      OSTYPE: ostype,
      TERM: 'dumb'
    }
  });
  return {
    code: result.status,
    stdout: (result.stdout || '') + (result.stderr || ''),
    calls: fs.readFileSync(sandbox.log, 'utf-8')
  };
}

function withSandbox(opts, fn) {
  const sandbox = makeSandbox(opts);
  try {
    return fn(sandbox);
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
}

/** Everything installed, model already in Application Support — the no-op path. */
const FULLY_PROVISIONED = {
  present: STUBBED,
  prebuilt: { appModel: true }
};

/* ── the two hard guards ─────────────────────────────────────── */

test('packaged setup refuses to run anywhere but macOS', () => {
  withSandbox(FULLY_PROVISIONED, (sandbox) => {
    const run = runSetup(sandbox, { ostype: 'linux-gnu' });

    assert.strictEqual(run.code, 1, 'must exit non-zero');
    assert.match(run.stdout, /requires macOS/);
    assert.strictEqual(run.calls.trim(), '', 'must not touch anything before bailing');
  });
});

test('packaged setup stops with a pointer to brew.sh when Homebrew is missing', () => {
  withSandbox({ ...FULLY_PROVISIONED, present: STUBBED.filter((c) => c !== 'brew') }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.strictEqual(run.code, 1);
    assert.match(run.stdout, /Homebrew not found/);
    assert.match(run.stdout, /https:\/\/brew\.sh/, 'says where to get it');
  });
});

/* ── idempotence ─────────────────────────────────────────────── */

test('a fully provisioned machine installs and downloads nothing', () => {
  withSandbox(FULLY_PROVISIONED, (sandbox) => {
    const run = runSetup(sandbox);

    assert.strictEqual(run.code, 0);
    assert.doesNotMatch(run.calls, /brew install/, 're-running must be free');
    assert.doesNotMatch(run.calls, /^curl/m, 'model already present, no download');
    assert.match(run.stdout, /Setup complete!/);
  });
});

/* ── the install branches ────────────────────────────────────── */

test('a bare machine gets sox, uv, whisper-cpp and the model', () => {
  withSandbox({ present: ['brew', 'curl'] }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.strictEqual(run.code, 0);
    assert.match(run.calls, /brew install sox/);
    assert.match(run.calls, /brew install uv/);
    assert.match(run.calls, /brew install whisper-cpp/);
    assert.match(run.calls, /curl .*huggingface\.co.*ggml-base\.en\.bin/);

    const modelPath = path.join(sandbox.home, MODEL_REL);
    assert.ok(fs.existsSync(modelPath), 'model lands under Application Support');
    assert.ok(!fs.existsSync(`${modelPath}.download`), 'the scratch name must not linger');
  });
});

test('uv present but whisper missing installs only the whisper half', () => {
  withSandbox({ present: ['brew', 'sox', 'uv', 'uvx', 'curl'] }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.strictEqual(run.code, 0);
    assert.doesNotMatch(run.calls, /brew install sox/);
    assert.doesNotMatch(run.calls, /brew install uv/);
    assert.match(run.calls, /brew install whisper-cpp/);
  });
});

/* ── the download failure ────────────────────────────────────── */

test('a failed model download warns and leaves NO file wearing the model name', () => {
  // The app tests the model by existence (services/transcriber.js), so a
  // partial download under the real name would pass verification and then
  // crash whisper mid-meeting. The scratch-name-then-rename dance is the
  // guarantee this test pins.
  withSandbox({ present: STUBBED, curlFails: true }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.strictEqual(run.code, 0, 'a missing fallback is a warning, not a failure');
    assert.match(run.stdout, /Model download failed/);
    assert.match(run.stdout, /Parakeet still works/);

    const modelPath = path.join(sandbox.home, MODEL_REL);
    assert.ok(!fs.existsSync(modelPath), 'no model file may exist');
    assert.ok(!fs.existsSync(`${modelPath}.download`), 'and no scratch remnant either');
  });
});

/* ── what the script must never do ───────────────────────────── */

test('the packaged script never clones or compiles anything', () => {
  withSandbox({ present: ['brew', 'curl'] }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.strictEqual(run.code, 0);
    assert.doesNotMatch(run.calls, /git|cmake|make|swift/, 'no repo, nothing to build');
  });
});
