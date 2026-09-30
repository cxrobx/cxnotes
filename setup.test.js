'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * setup.sh runs against a sandbox: a throwaway HOME, a throwaway working
 * directory, and a PATH whose first entry holds stubs for every external
 * command the script shells out to.
 *
 * A setup script is the one file you cannot test by running it — a real run
 * installs Homebrew packages, clones a repository and compiles whisper.cpp.
 * Stubbing the boundary is what makes its branching testable at all: which
 * things get installed, what is skipped when already present, and the two
 * guards that must exit non-zero.
 *
 * The stubs come first on PATH, so the real git/make/swift in /usr/bin are
 * shadowed and nothing here can touch the machine.
 */

const SETUP = path.resolve(__dirname, 'setup.sh');

/** Commands the script invokes that must never reach the real system. */
const STUBBED = [
  'brew', 'sox', 'cmake', 'git', 'make', 'system_profiler',
  'swift', 'codesign', 'uv', 'uvx'
];

/**
 * Real utilities the script genuinely needs, symlinked in individually.
 *
 * The sandbox PATH is the stub directory and nothing else. An earlier version
 * appended /usr/bin so coreutils would resolve, and that quietly broke the
 * "command is missing" tests: omitting the `swift` stub still found
 * /usr/bin/swift, so the missing-swift case actually ran a real `swift build`.
 * Allow-listing is the only way "missing" can mean missing.
 */
const REAL_UTILITIES = ['mkdir', 'cp', 'grep', 'head', 'bash', 'chmod', 'touch', 'rm'];

function makeSandbox({ present = [], blackhole = true, prebuilt = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-setup-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const log = path.join(root, 'calls.log');

  for (const dir of [bin, home, work]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(log, '');

  for (const util of REAL_UTILITIES) {
    const real = ['/bin', '/usr/bin'].map((d) => path.join(d, util)).find((p) => fs.existsSync(p));
    if (real) fs.symlinkSync(real, path.join(bin, util));
  }

  for (const name of STUBBED) {
    if (!present.includes(name)) continue;
    fs.writeFileSync(path.join(bin, name), stubFor(name, { blackhole, log, work }), {
      mode: 0o755
    });
  }

  // Steer the "already there?" branches by pre-creating files.
  if (prebuilt.whisperRepo) fs.mkdirSync(path.join(work, 'whisper.cpp', 'models'), { recursive: true });
  if (prebuilt.whisperBinary) {
    fs.mkdirSync(path.join(work, 'whisper.cpp', 'build', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(work, 'whisper.cpp', 'build', 'bin', 'whisper-cli'), '');
  }
  if (prebuilt.model) {
    fs.mkdirSync(path.join(work, 'whisper.cpp', 'models'), { recursive: true });
    fs.writeFileSync(path.join(work, 'whisper.cpp', 'models', 'ggml-base.en.bin'), 'MODEL');
  }
  if (prebuilt.appModel) {
    const dir = path.join(home, 'Library', 'Application Support', 'CXNotes', 'models');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ggml-base.en.bin'), 'MODEL');
  }
  if (prebuilt.calendarHelperSource) {
    fs.mkdirSync(path.join(work, 'native', 'calendar-helper'), { recursive: true });
  }
  if (prebuilt.sckHelperSource) {
    fs.mkdirSync(path.join(work, 'native', 'sck-audio-capture'), { recursive: true });
  }

  return { root, bin, home, work, log };
}

function stubFor(name, { blackhole, log, work }) {
  // Log without a trailing space when there are no arguments, so assertions
  // can anchor on the whole line.
  const header =
    `#!/bin/bash\n` +
    `__line="${name}"; [ $# -gt 0 ] && __line="$__line $*"\n` +
    `echo "$__line" >> "${log}"\n`;

  switch (name) {
    case 'system_profiler':
      return (
        header +
        `echo "Audio:"\n` +
        (blackhole ? `echo "        BlackHole 2ch:"\n` : `echo "        MacBook Pro Microphone:"\n`) +
        `exit 0\n`
      );
    case 'sox':
      return header + `echo "sox: SoX v14.4.2"\nexit 0\n`;
    case 'git':
      // A clone has to leave behind something the later steps can look at,
      // or the script runs the rest of its whisper branch against nothing.
      return (
        header +
        `if [ "$1" = "clone" ]; then\n` +
        `  mkdir -p "${work}/whisper.cpp/models"\n` +
        `  printf '#!/bin/bash\\necho stub-download\\n' > "${work}/whisper.cpp/models/download-ggml-model.sh"\n` +
        `  chmod +x "${work}/whisper.cpp/models/download-ggml-model.sh"\n` +
        `fi\nexit 0\n`
      );
    case 'swift':
      // The script checks for the built binary afterwards, so a stub that
      // builds nothing would exercise the failure branch by accident.
      return (
        header +
        `mkdir -p "${work}/native/calendar-helper/.build/release"\n` +
        `touch "${work}/native/calendar-helper/.build/release/calendar-helper"\n` +
        `exit 0\n`
      );
    case 'uvx':
      return header + `exit 0\n`;
    default:
      return header + `exit 0\n`;
  }
}

function runSetup(sandbox, { ostype = 'darwin23' } = {}) {
  const result = spawnSync('bash', [SETUP], {
    cwd: sandbox.work,
    encoding: 'utf-8',
    input: '\n\n',
    env: {
      PATH: sandbox.bin,
      HOME: sandbox.home,
      OSTYPE: ostype,
      TERM: 'dumb'
    }
  });
  return {
    code: result.status,
    // `read -p` writes its prompt to stderr, so prompts are only visible in
    // the combined stream.
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

/** Everything installed, everything already built — the no-op path. */
const FULLY_PROVISIONED = {
  present: STUBBED,
  blackhole: true,
  prebuilt: {
    whisperRepo: true,
    whisperBinary: true,
    model: true,
    appModel: true,
    calendarHelperSource: true,
    sckHelperSource: true
  }
};

/* ── the two hard guards ─────────────────────────────────────── */

test('setup refuses to run anywhere but macOS', () => {
  withSandbox(FULLY_PROVISIONED, (sandbox) => {
    const run = runSetup(sandbox, { ostype: 'linux-gnu' });

    assert.strictEqual(run.code, 1, 'must exit non-zero');
    assert.match(run.stdout, /requires macOS/);
    assert.strictEqual(run.calls.trim(), '', 'must not touch anything before bailing');
  });
});

test('setup stops with a pointer to brew.sh when Homebrew is missing', () => {
  withSandbox({ ...FULLY_PROVISIONED, present: STUBBED.filter((c) => c !== 'brew') }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.strictEqual(run.code, 1);
    assert.match(run.stdout, /Homebrew not found/);
    assert.match(run.stdout, /https:\/\/brew\.sh/, 'says where to get it');
  });
});

/* ── installing what is missing ──────────────────────────────── */

test('setup installs sox when it is absent', () => {
  withSandbox({ ...FULLY_PROVISIONED, present: STUBBED.filter((c) => c !== 'sox') }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.match(run.calls, /^brew install sox$/m);
    assert.strictEqual(run.code, 0);
  });
});

test('setup installs cmake when it is absent', () => {
  withSandbox({ ...FULLY_PROVISIONED, present: STUBBED.filter((c) => c !== 'cmake') }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.match(run.calls, /^brew install cmake$/m);
  });
});

test('setup clones whisper.cpp when the directory is not there', () => {
  withSandbox({ ...FULLY_PROVISIONED, prebuilt: { calendarHelperSource: true } }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.match(run.calls, /^git clone .*whisper\.cpp\.git$/m);
  });
});

test('setup compiles whisper.cpp when no binary exists', () => {
  withSandbox(
    { ...FULLY_PROVISIONED, prebuilt: { whisperRepo: true, model: true, appModel: true } },
    (sandbox) => {
      const run = runSetup(sandbox);

      assert.match(run.calls, /^make$/m, 'make must run for the compile branch');
    }
  );
});

test('setup downloads the model when it is not present', () => {
  withSandbox(
    { ...FULLY_PROVISIONED, prebuilt: { whisperRepo: true, whisperBinary: true } },
    (sandbox) => {
      // The download script lives inside the cloned repo; provide it so the
      // branch can actually run.
      const models = path.join(sandbox.work, 'whisper.cpp', 'models');
      fs.mkdirSync(models, { recursive: true });
      fs.writeFileSync(
        path.join(models, 'download-ggml-model.sh'),
        `#!/bin/bash\necho "download $*" >> "${sandbox.log}"\ntouch "${models}/ggml-base.en.bin"\n`,
        { mode: 0o755 }
      );

      const run = runSetup(sandbox);

      assert.match(run.calls, /^download base\.en$/m);
    }
  );
});

/* ── skipping what is already there ──────────────────────────── */

test('a fully provisioned machine installs nothing and succeeds', () => {
  withSandbox(FULLY_PROVISIONED, (sandbox) => {
    const run = runSetup(sandbox);

    assert.strictEqual(run.code, 0);
    assert.doesNotMatch(run.calls, /brew install/, 'nothing to install');
    assert.doesNotMatch(run.calls, /git clone/, 'nothing to clone');
    assert.doesNotMatch(run.calls, /^make$/m, 'nothing to compile');
    assert.match(run.stdout, /Setup complete/);
  });
});

/* ── system audio: SCK only, no BlackHole anywhere ───────────── */

test('setup never mentions BlackHole, in either direction', () => {
  // Both states, because the old script had a branch for each and both were
  // wrong once the fallback was removed: one told you to install a device that
  // no longer participates in capture, the other confirmed it as a route.
  for (const blackhole of [true, false]) {
    withSandbox({ ...FULLY_PROVISIONED, blackhole }, (sandbox) => {
      const run = runSetup(sandbox);

      assert.doesNotMatch(run.stdout, /BlackHole/i, `blackhole=${blackhole}`);
      assert.doesNotMatch(run.stdout, /Multi-Output/i, `blackhole=${blackhole}`);
      assert.doesNotMatch(run.stdout, /Press Enter/, 'nothing here should block');
      assert.strictEqual(run.code, 0);
    });
  }
});

test('setup builds sck-audio-capture — the only system-audio path', () => {
  // The gap this closes: `npm run build` compiled the helper via prebuild but
  // `./setup.sh && npm start` never did, so a from-source install silently had
  // no system capture. With the fallback gone there is nothing to absorb that.
  withSandbox({ ...FULLY_PROVISIONED, prebuilt: { ...FULLY_PROVISIONED.prebuilt, sckHelperSource: true } }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.match(run.stdout, /sck-audio-capture/, 'names the helper it is building');
    assert.match(run.calls, /swift build -c release/, 'actually invokes the compiler');
    assert.match(run.calls, /codesign .*sck-audio-capture/, 'signs it like calendar-helper');
  });
});

test('a missing swift toolchain warns about system audio but does not fail setup', () => {
  withSandbox(
    { ...FULLY_PROVISIONED, present: STUBBED.filter((c) => c !== 'swift') },
    (sandbox) => {
      const run = runSetup(sandbox);

      assert.match(run.stdout, /swift not available/);
      assert.strictEqual(run.code, 0, 'still a warning, not a hard stop');
    }
  );
});

test('setup points at the Screen Recording grant as the real prerequisite', () => {
  withSandbox(FULLY_PROVISIONED, (sandbox) => {
    const run = runSetup(sandbox);

    assert.match(run.stdout, /Screen Recording/);
  });
});

/* ── the model has to land where the packaged app looks ──────── */

test('setup installs the model into Application Support, not just the repo', () => {
  withSandbox(
    { ...FULLY_PROVISIONED, prebuilt: { whisperRepo: true, whisperBinary: true, model: true } },
    (sandbox) => {
      runSetup(sandbox);

      // Invariant #20: Application Support is the only location reachable from
      // both a dev run and a packaged, Dock-launched app.
      const installed = path.join(
        sandbox.home, 'Library', 'Application Support', 'CXNotes', 'models', 'ggml-base.en.bin'
      );
      assert.ok(fs.existsSync(installed), 'model must reach Application Support');
      assert.ok(
        fs.existsSync(path.join(sandbox.work, 'models', 'ggml-base.en.bin')),
        'and the repo copy must stay, so npm start works untouched'
      );
    }
  );
});

/* ── the Swift helper ────────────────────────────────────────── */

test('setup builds and signs calendar-helper when swift is available', () => {
  withSandbox(FULLY_PROVISIONED, (sandbox) => {
    const run = runSetup(sandbox);

    assert.match(run.calls, /^swift build -c release/m);
    // Gotcha #7: the Calendar grant is keyed to the helper's code signature, so
    // an unsigned helper silently re-prompts.
    assert.match(run.calls, /^codesign .*calendar-helper/m);
  });
});

test('setup warns rather than failing when swift is not installed', () => {
  withSandbox({ ...FULLY_PROVISIONED, present: STUBBED.filter((c) => c !== 'swift') }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.match(run.stdout, /swift not available/);
    assert.strictEqual(run.code, 0);
  });
});

/* ── Parakeet, the default backend ───────────────────────────── */

test('setup pre-pulls the Parakeet model when uv is installed', () => {
  withSandbox(FULLY_PROVISIONED, (sandbox) => {
    const run = runSetup(sandbox);

    assert.match(run.calls, /^uvx --from parakeet-mlx/m);
  });
});

test('setup explains how to get uv when it is missing, and carries on', () => {
  withSandbox({ ...FULLY_PROVISIONED, present: STUBBED.filter((c) => c !== 'uv') }, (sandbox) => {
    const run = runSetup(sandbox);

    assert.match(run.stdout, /'uv' not installed/);
    assert.match(run.stdout, /astral\.sh\/uv\/install\.sh/, 'gives the install command');
    assert.match(run.stdout, /falls back to whisper\.cpp/, 'says what happens instead');
    assert.strictEqual(run.code, 0);
  });
});
