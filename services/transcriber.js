const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { mergeTranscripts, parseCsvTranscript } = require('./transcriptMerger');
const {
  checkForProvider, readSharedTranscript, writeCompanionOutputs, convertToCSV, entriesToCSV, shiftEntries
} = require('./companionTranscript');
const { speechRegionsFromWav, offsetWindow, decideCompanionPath } = require('./companionCoverage');
const { getAppSupportRoot } = require('../shared/paths');

/**
 * Where a PACKAGED app keeps its bundled resources, or null in a dev run.
 *
 * `process.resourcesPath` is only meaningful inside a packaged app; in a dev
 * run under plain node it is undefined, and under `electron .` it points into
 * the Electron framework rather than at our own files. Callers therefore treat
 * null as "not packaged" and fall back to the repo-relative paths.
 */
function bundledResourcesDir() {
  const dir = process.resourcesPath;
  if (!dir || typeof dir !== 'string') return null;
  // A dev `electron .` run has resourcesPath inside node_modules/electron.
  if (dir.includes(`${path.sep}node_modules${path.sep}electron`)) return null;
  return dir;
}

/**
 * `~/Library/Application Support/CXNotes/models` — the one model location that
 * works for BOTH a dev run and a packaged app.
 *
 * The whisper model is ~141 MB, so bundling it into the .app is not an option;
 * and the repo's own `models/` directory is unreachable once packaged. Reuses
 * the frozen app-support name from shared/paths.js rather than repeating the
 * literal, so a rename cannot split the two (invariant #12's reasoning).
 */
function getModelsDir() {
  return path.join(getAppSupportRoot(), 'models');
}

/**
 * Find whisper.cpp binary
 *
 * Searches the places this binary is actually installed, in priority order.
 *
 * PACKAGING NOTE: the two `./whisper.cpp/…` entries resolve against
 * `process.cwd()`, which for an app launched from the Dock is `/` — they only
 * ever matched because a dev run happens to have the repo as its cwd. And
 * `__dirname` inside a packaged app points into the bundle, where whisper.cpp
 * has never existed. So on any machine other than the one that built the app,
 * every repo-relative candidate missed and transcription failed.
 *
 * WHY THE BINARY IS NOT BUNDLED: it would be the obvious fix, and it is wrong.
 * `otool -L` shows whisper-cli links against six @rpath dylibs (libwhisper,
 * libggml, libggml-cpu/-blas/-metal/-base). Copying the 825 KB executable into
 * `extraResources` without them yields a dyld crash on any machine that lacks
 * Homebrew's whisper — strictly worse than the honest "not found" below, since
 * a crash diagnoses nothing. Bundling properly means shipping the dylibs and
 * rewriting the rpaths, which is a real piece of work and not done here. The
 * resourcesPath entry stays so a future build that DOES bundle correctly is
 * found first.
 *
 * @returns {string} Path to whisper binary
 * @throws {Error} If whisper.cpp binary not found
 */
function whisperBinaryCandidates(home = process.env.HOME) {
  const resources = bundledResourcesDir();
  return [
    // Bundled with the app — the only candidate that survives distribution.
    ...(resources ? [path.join(resources, 'whisper-cli')] : []),

    // Homebrew, under either name, on either architecture. This is what an
    // ordinary install actually resolves to.
    '/opt/homebrew/bin/whisper-cpp',
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cpp',
    '/usr/local/bin/whisper-cli',
    '/opt/homebrew/bin/whisper',
    '/usr/local/bin/whisper',
    ...(home ? [path.join(home, '.local/bin/whisper')] : []),

    // Dev-only, and last on purpose: these resolve against process.cwd(), which
    // is `/` for a Dock-launched app, and __dirname points inside the bundle.
    './whisper.cpp/build/bin/whisper-cli',
    './whisper.cpp/main',
    path.join(__dirname, '../whisper.cpp/build/bin/whisper-cli'),
    path.join(__dirname, '../whisper.cpp/main')
  ];
}

const WHISPER_BINARY_HELP = [
  'whisper.cpp not found.',
  'Easiest fix (installs the binary and its libraries):',
  '  brew install whisper-cpp',
  'Or build it from the CXNotes repo:',
  '  ./setup.sh'
].join('\n');

/**
 * First candidate that exists on disk, resolved to an absolute path.
 *
 * Shared by the binary and model lookups, which are the same search with
 * different lists — and both have to `path.resolve` before testing, because the
 * dev-only candidates are relative.
 *
 * @param {string[]} candidates
 * @param {string} label - what is being looked for, for the log line
 * @param {{existsSync: Function}} [fsImpl]
 * @returns {string|null}
 */
function firstExisting(candidates, label, fsImpl = fs) {
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!fsImpl.existsSync(resolved)) continue;
    console.log(`Found ${label} at: ${resolved}`);
    return resolved;
  }
  return null;
}

function findWhisperBinary({ fsImpl = fs, home = process.env.HOME } = {}) {
  const found = firstExisting(whisperBinaryCandidates(home), 'whisper binary', fsImpl);
  if (found) return found;
  throw new Error(WHISPER_BINARY_HELP);
}

/**
 * Locate a usable whisper model on this machine.
 *
 * Searches the places a model is actually kept, best quality first.
 *
 * @returns {string} Path to model file
 * @throws {Error} If model file not found
 */
const BASE_MODEL = 'ggml-base.en.bin';

/** VoiceInk keeps a large-v3-turbo locally; reusing it beats our base.en. */
const VOICEINK_MODELS_DIR =
  'Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels';

function whisperModelCandidates(home = process.env.HOME) {
  const resources = bundledResourcesDir();
  return [
    // Best quality first: if VoiceInk is installed, borrow its larger model
    // rather than transcribing with base.en.
    ...(home
      ? [
          path.join(home, VOICEINK_MODELS_DIR, 'ggml-large-v3-turbo.bin'),
          path.join(home, VOICEINK_MODELS_DIR, 'ggml-large-v3-turbo-q5_0.bin')
        ]
      : []),

    // Where a packaged install actually keeps it. The model is ~141 MB, far too
    // large to bundle, so setup.sh downloads it here and both a dev run and a
    // packaged app can reach it.
    path.join(getModelsDir(), BASE_MODEL),

    // Bundled, if a build ever chooses to ship one.
    ...(resources ? [path.join(resources, 'models', BASE_MODEL)] : []),

    `/opt/homebrew/share/whisper-cpp/models/${BASE_MODEL}`,
    ...(home ? [path.join(home, '.whisper/models', BASE_MODEL)] : []),

    // Dev-only, and last for the same reason as the binary candidates.
    `./models/${BASE_MODEL}`,
    `./whisper.cpp/models/${BASE_MODEL}`,
    path.join(__dirname, '..', 'models', BASE_MODEL),
    path.join(__dirname, '..', 'whisper.cpp', 'models', BASE_MODEL)
  ];
}

function whisperModelHelp() {
  const dir = getModelsDir();
  return [
    'Whisper model not found.',
    'Run ./setup.sh in the CXNotes repo, which installs it to:',
    `  ${dir}/${BASE_MODEL}`,
    'Or place it there yourself:',
    '  git clone https://github.com/ggerganov/whisper.cpp.git',
    '  cd whisper.cpp && bash ./models/download-ggml-model.sh base.en',
    `  mkdir -p "${dir}"`,
    `  cp models/${BASE_MODEL} "${dir}/"`
  ].join('\n');
}

function findWhisperModel({ fsImpl = fs, home = process.env.HOME } = {}) {
  const found = firstExisting(whisperModelCandidates(home), 'whisper model', fsImpl);
  if (found) return found;
  throw new Error(whisperModelHelp());
}

/**
 * Turn one audio track into text.
 *
 * @param {string} wavPath - Path to WAV audio file
 * @param {string} outputDir - Base directory for output
 * @param {Function} [progressCallback] - Optional callback for progress updates (0-100)
 * @param {string} [outputPrefix] - Optional output prefix (defaults to basename-derived)
 * @param {boolean} [outputCsv=false] - Also output CSV format for merging
 * @returns {Promise<string>} Path to generated transcript file
 * @throws {Error} If transcription fails
 */
async function transcribe(wavPath, outputDir, progressCallback, outputPrefix, outputCsv = false) {
  // Verify input file exists
  if (!fs.existsSync(wavPath)) {
    throw new Error(`No audio at ${wavPath}`);
  }

  // Ensure processed directory exists
  const processedDir = path.join(outputDir, 'processed');
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }

  // Generate output filename
  const prefix = outputPrefix || path.join(processedDir, `${path.basename(wavPath, '.wav')}_transcript`);

  console.log(`Starting transcription: ${wavPath}`);
  console.log(`Output prefix: ${prefix}`);

  // Parakeet (NVIDIA Parakeet-TDT via parakeet-mlx) is the DEFAULT backend —
  // best local accuracy on meeting speech, fully on-device. Falls back to
  // whisper.cpp if `uv` is unavailable or Parakeet fails. Force whisper with
  // CXNOTES_TRANSCRIBER=whisper.
  const forceWhisper = (process.env.CXNOTES_TRANSCRIBER || '').toLowerCase() === 'whisper';
  if (!forceWhisper && findUv()) {
    try {
      return await transcribeWithParakeet(wavPath, prefix, outputCsv, progressCallback);
    } catch (err) {
      console.warn(`[transcriber] Parakeet failed (${err.message}) — falling back to whisper.cpp`);
    }
  }
  return transcribeWithWhisper(wavPath, prefix, outputCsv, progressCallback);
}

/**
 * Transcribe a single WAV with whisper.cpp (the fallback backend).
 * @returns {Promise<string>} Path to the generated .txt transcript
 */
/** Minimum time whisper is given, however small the file. */
const WHISPER_MIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Extra time granted per this many megabytes of audio. */
const WHISPER_MB_PER_STEP = 20;

/** Time granted per step. */
const WHISPER_MS_PER_STEP = 10 * 60 * 1000;

/**
 * How long whisper gets before it is killed.
 *
 * Scaled by file size rather than fixed, because transcription time tracks
 * audio length almost linearly and a fixed ceiling either kills long meetings
 * or lets a wedged process hang for hours. Generous on purpose: the cost of
 * being wrong is a lost recording.
 *
 * @param {number} bytes
 * @returns {number} milliseconds
 */
function whisperTimeoutMs(bytes) {
  const megabytes = bytes / (1024 * 1024);
  const steps = Math.ceil(megabytes / WHISPER_MB_PER_STEP);
  return Math.max(WHISPER_MIN_TIMEOUT_MS, steps * WHISPER_MS_PER_STEP);
}

/**
 * The whisper.cpp command line.
 *
 * `-ocsv` is what makes dual-track merging possible — the merger needs per-line
 * timings, which the plain text output does not carry.
 *
 * @param {{modelPath: string, wavPath: string, prefix: string, outputCsv: boolean}} opts
 * @returns {string[]}
 */
function whisperArgs({ modelPath, wavPath, prefix, outputCsv }) {
  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-otxt',
    '-of', prefix,
    '--print-progress',
    '--language', 'en',
    '--threads', '4',
    '--processors', '2'
  ];
  if (outputCsv) args.push('-ocsv');
  return args;
}

/**
 * Latest percentage whisper has reported, or null if it has not said yet.
 *
 * Reads the accumulated stderr rather than one chunk, because a progress line
 * can be split across reads.
 *
 * @param {string} stderr
 * @returns {number|null}
 */
function parseWhisperProgress(stderr) {
  const matches = [...String(stderr).matchAll(/progress\s*=\s*(\d+)%/g)];
  if (matches.length === 0) return null;
  return parseInt(matches[matches.length - 1][1], 10);
}

/**
 * Run whisper.cpp over one track.
 *
 * Resolves with the transcript path. Every failure route rejects with a message
 * naming what went wrong, because this is the step most likely to fail on a
 * machine that is missing something.
 */
function transcribeWithWhisper(wavPath, prefix, outputCsv, progressCallback) {
  const whisperBin = findWhisperBinary();
  const modelPath = findWhisperModel();

  const sizeBytes = fs.statSync(wavPath).size;
  const timeoutMs = whisperTimeoutMs(sizeBytes);
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
  console.log(`Whisper timeout: ${Math.round(timeoutMs / 60000)} minutes for ${sizeMB} MB file`);

  return new Promise((resolve, reject) => {
    const whisper = spawn(whisperBin, whisperArgs({ modelPath, wavPath, prefix, outputCsv }));

    let settled = false;
    let stderrData = '';
    let lastProgress = null;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      fn(arg);
    };

    const timeoutHandle = setTimeout(() => {
      whisper.kill('SIGKILL');
      finish(reject, new Error(
        `whisper.cpp timed out after ${Math.round(timeoutMs / 60000)} minutes (file: ${sizeMB} MB)`
      ));
    }, timeoutMs);

    whisper.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
      if (!progressCallback) return;

      const progress = parseWhisperProgress(stderrData);
      if (progress === null || progress === lastProgress) return;
      lastProgress = progress;
      progressCallback(progress);
    });

    whisper.stdout.on('data', (chunk) => {
      console.log(`whisper stdout: ${chunk.toString().trim()}`);
    });

    whisper.on('error', (err) => {
      finish(reject, new Error(`Failed to start whisper.cpp: ${err.message}`));
    });

    whisper.on('close', (code) => {
      if (settled) return;

      if (code !== 0) {
        finish(reject, new Error(`whisper.cpp failed with exit code ${code}\n${stderrData}`));
        return;
      }

      const transcriptPath = `${prefix}.txt`;
      if (!fs.existsSync(transcriptPath)) {
        finish(reject, new Error(`Transcript file not created: ${transcriptPath}`));
        return;
      }
      if (fs.statSync(transcriptPath).size === 0) {
        finish(reject, new Error('Transcript file is empty. Audio may be silent or corrupted.'));
        return;
      }

      console.log(`Transcription complete: ${transcriptPath}`);
      finish(resolve, transcriptPath);
    });
  });
}

/** Locate the `uvx` runner (Parakeet runs via uv with PEP-723 inline deps). */
function findUv() {
  const candidates = [
    path.join(process.env.HOME || '', '.local/bin/uvx'),
    '/opt/homebrew/bin/uvx',
    '/usr/local/bin/uvx',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/** Same model setup.sh / setup-packaged.sh pre-pull. */
const PARAKEET_MODEL = 'mlx-community/parakeet-tdt-0.6b-v3';

/**
 * Transcribe a single WAV with Parakeet (parakeet-mlx via uvx), writing the
 * whisper-compatible outputs CXNotes expects: `${prefix}.txt` and, when
 * outputCsv, `${prefix}.csv` in whisper's `start_ms,end_ms,"text"` format so
 * the dual-track merger keeps working unchanged.
 * @returns {Promise<string>} Path to the generated .txt transcript
 */
function transcribeWithParakeet(wavPath, prefix, outputCsv, progressCallback) {
  const uvx = findUv();
  if (!uvx) return Promise.reject(new Error('uv/uvx not found'));

  return new Promise((resolve, reject) => {
    const outDir = path.dirname(prefix);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    // parakeet-mlx writes <output-dir>/<wav-basename>.json
    const jsonOut = path.join(outDir, `${path.basename(wavPath, '.wav')}.json`);

    const fileSizeMB = fs.statSync(wavPath).size / (1024 * 1024);
    const timeoutMs = Math.max(5 * 60 * 1000, Math.ceil(fileSizeMB / 20) * 10 * 60 * 1000);

    console.log(`Parakeet transcription: ${wavPath} -> ${prefix}.txt`);
    // Pin the model: `uvx` resolves the newest parakeet-mlx, so relying on
    // the CLI's default would let an upstream release silently swap it.
    const model = process.env.PARAKEET_MODEL || PARAKEET_MODEL;
    const args = ['parakeet-mlx', wavPath, '--model', model, '--output-format', 'json', '--output-dir', outDir];
    const proc = spawn(uvx, args, { env: process.env });
    let settled = false;
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`Parakeet timed out after ${Math.round(timeoutMs / 60000)} min`));
    }, timeoutMs);

    if (progressCallback) progressCallback(10);
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to start uvx parakeet-mlx: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`parakeet-mlx exited ${code}\n${stderr.slice(-500)}`));
        return;
      }
      try {
        if (!fs.existsSync(jsonOut)) throw new Error(`Parakeet JSON not created: ${jsonOut}`);
        const result = JSON.parse(fs.readFileSync(jsonOut, 'utf-8'));
        const sentences = Array.isArray(result.sentences) ? result.sentences : [];

        // .txt — one sentence per line (mirrors whisper -otxt segmentation).
        const txtBody = sentences.length
          ? sentences.map((s) => (s.text || '').trim()).filter(Boolean).join('\n')
          : (result.text || '').trim();
        fs.writeFileSync(`${prefix}.txt`, txtBody + '\n', 'utf-8');

        // .csv — whisper format: start_ms,end_ms,"text" (for dual-track merge).
        if (outputCsv) {
          const rows = sentences.map((s) => {
            const start = Math.round((s.start || 0) * 1000);
            const end = Math.round((s.end || 0) * 1000);
            // Collapse whitespace (sentences are single-line) and wrap in one
            // quote pair WITHOUT doubling internal quotes — transcriptMerger's
            // parseCsvTranscript strips exactly one outer pair and does not
            // un-escape, so inner quotes must pass through verbatim.
            const text = (s.text || '').trim().replace(/\s+/g, ' ');
            return `${start},${end},"${text}"`;
          });
          fs.writeFileSync(`${prefix}.csv`, rows.join('\n') + '\n', 'utf-8');
        }

        try { fs.unlinkSync(jsonOut); } catch { /* best effort */ }
        if (progressCallback) progressCallback(100);

        const txtPath = `${prefix}.txt`;
        if (fs.statSync(txtPath).size === 0) {
          reject(new Error('Transcript file is empty. Audio may be silent or corrupted.'));
          return;
        }
        console.log(`Parakeet transcription complete: ${txtPath}`);
        resolve(txtPath);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Decide whether the companion transcript can stand in for this session's
 * own, from CXNotes' own mic.wav. Never throws: a check that cannot run keeps
 * the old behaviour (trust the companion) and says why.
 */
function assessCompanion({ segments, provider, manifest, sessionDir }) {
  try {
    const mic = manifest.tracks && manifest.tracks.mic;
    if (!mic || !mic.file) {
      return { decision: 'companion', reason: 'no mic track in this session', offsetSec: null };
    }
    const micWav = path.join(sessionDir, mic.file);
    const ownRegions = fs.existsSync(micWav) ? speechRegionsFromWav(micWav) : null;
    const window = offsetWindow({
      companionStartedAt: provider.startedAt,
      recordingStartTime: manifest.startTime,
      micTrim: mic.silenceTrimmed
    });
    return decideCompanionPath({ segments, micSilent: Boolean(mic.silent), ownRegions, window });
  } catch (err) {
    return { decision: 'companion', reason: `check failed: ${err.message}`, offsetSec: null };
  }
}

/**
 * The companion's meeting side plus CXNotes' own mic transcription, on the
 * companion's clock, merged through the normal merger (labels, bleed
 * suppression). If the own mic transcription fails, the companion's
 * transcript is used alone, as before — a one-sided note beats none, and the
 * manifest records that it happened.
 */
async function mergeCompanionWithOwnMic({
  segments, provider, manifest, manifestPath, sessionDir, processedDir, outputDir, offsetSec, progressCallback,
  transcribeImpl = transcribe
}) {
  const t = manifest.processing.transcription;
  const micWav = path.join(sessionDir, manifest.tracks.mic.file);
  const ownPrefix = path.join(processedDir, 'mic_own_transcript');
  try {
    console.log('[Transcriber] Transcribing own mic track to fill the companion\'s mic side...');
    await transcribeImpl(micWav, outputDir, (p) => {
      if (progressCallback) progressCallback(Math.round(p * 0.9));
    }, ownPrefix, true);
    const own = parseCsvTranscript(`${ownPrefix}.csv`);

    const systemCsvPath = path.join(processedDir, 'system_transcript.csv');
    const micCsvPath = path.join(processedDir, 'mic_transcript.csv');
    const mergedPath = path.join(processedDir, 'merged_transcript.txt');
    fs.writeFileSync(systemCsvPath, convertToCSV(segments, 'meeting'), 'utf-8');
    fs.writeFileSync(micCsvPath, entriesToCSV(shiftEntries(own, offsetSec)), 'utf-8');

    const systemLabel = manifest.tracks.system.label || 'Remote';
    const micLabel = manifest.tracks.mic.label || 'Me';
    mergeTranscripts(systemCsvPath, micCsvPath, mergedPath, systemLabel, micLabel);

    t.system = systemCsvPath;
    t.mic = micCsvPath;
    t.merged = mergedPath;
    t.source = `companion:${provider.app}+own-mic`;
    t.ownMicLines = own.length;
    console.log(`[Transcriber] Merged ${own.length} own mic line(s) with the companion's meeting side (offset ${offsetSec}s)`);
  } catch (err) {
    console.error(`[Transcriber] Own mic transcription failed (${err.message}) — using the companion transcript alone`);
    writeCompanionOutputs(segments, processedDir);
    t.system = path.join(processedDir, 'system_transcript.csv');
    t.mic = path.join(processedDir, 'mic_transcript.csv');
    t.merged = path.join(processedDir, 'merged_transcript.txt');
    t.source = `companion:${provider.app}`;
    t.companionCheck = { ...t.companionCheck, decision: 'companion', reason: `${t.companionCheck.reason}; own mic transcription failed: ${err.message}` };
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  if (progressCallback) progressCallback(100);
  return { systemTranscript: t.system, micTranscript: t.mic, mergedTranscript: t.merged };
}

/**
 * Transcribe a dual-track session
 *
 * Transcribes both system and mic tracks, then merges them into
 * a speaker-labeled transcript.
 *
 * @param {string} sessionDir - Path to session directory (containing manifest.json)
 * @param {string} outputDir - Base output directory
 * @param {Function} [progressCallback] - Optional callback with progress (0-100)
 * @returns {Promise<{systemTranscript: string|null, micTranscript: string|null, mergedTranscript: string}>}
 */
async function transcribeSession(sessionDir, outputDir, progressCallback, options = {}) {
  // Read manifest
  const manifestPath = path.join(sessionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Session manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const sessionId = manifest.sessionId;

  // Create processed directory for this session
  const processedDir = path.join(outputDir, 'processed', `${sessionId}_session`);
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }

  // Companion mode — use the shared transcript from meeting-copilot if it
  // really carries both sides. It is checked against CXNotes' own mic.wav
  // first (services/companionCoverage.js): on 2026-09-25 the companion's mic
  // had died and its transcript held only the other side, while mic.wav held
  // every word Chris said.
  const useShared = options.useSharedTranscript !== false;
  let companionCheck = null;
  if (useShared) {
    const provider = checkForProvider();
    if (provider) {
      const segments = readSharedTranscript(provider.transcriptFile);
      if (segments.length > 0) {
        // Log segment count and time range for visibility, especially in late-start scenarios
        // where meeting-copilot started after CXNotes (partial transcript)
        const earliest = Math.min(...segments.map(s => s.timestamp));
        const latest = Math.max(...segments.map(s => s.timestamp + (s.duration || 10)));
        console.log(`[Transcriber] Companion transcript from ${provider.app}: ${segments.length} segments (${Math.round(earliest)}s – ${Math.round(latest)}s)`);

        companionCheck = assessCompanion({ segments, provider, manifest, sessionDir });
        console.log(`[Transcriber] Companion check: ${companionCheck.decision} — ${companionCheck.reason}${companionCheck.offsetSec !== null ? ` (offset ${companionCheck.offsetSec}s)` : ''}`);

        if (!manifest.processing) manifest.processing = {};
        if (!manifest.processing.transcription) manifest.processing.transcription = {};
        manifest.processing.transcription.companionCheck = companionCheck;

        if (companionCheck.decision === 'companion') {
          writeCompanionOutputs(segments, processedDir);
          manifest.processing.transcription.system = path.join(processedDir, 'system_transcript.csv');
          manifest.processing.transcription.mic = path.join(processedDir, 'mic_transcript.csv');
          manifest.processing.transcription.merged = path.join(processedDir, 'merged_transcript.txt');
          manifest.processing.transcription.source = `companion:${provider.app}`;
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

          if (progressCallback) progressCallback(100);

          return {
            systemTranscript: manifest.processing.transcription.system,
            micTranscript: manifest.processing.transcription.mic,
            mergedTranscript: manifest.processing.transcription.merged
          };
        }

        if (companionCheck.decision === 'companion+own-mic') {
          return await mergeCompanionWithOwnMic({
            segments, provider, manifest, manifestPath, sessionDir, processedDir, outputDir,
            offsetSec: companionCheck.offsetSec, progressCallback,
            transcribeImpl: options.transcribeImpl || transcribe
          });
        }
        // 'own': fall through to CXNotes' own two-track transcription.
      } else {
        console.log('[Transcriber] Companion transcript empty, falling back to whisper');
      }
    }
  }

  let systemTranscript = null;
  let micTranscript = null;
  let systemCsvPath = null;
  let micCsvPath = null;

  // Transcribe both tracks in parallel (0-90% progress)
  // Each track reports its own progress; we report max(system, mic) capped at 90%
  let systemProgress = 0;
  let micProgress = 0;
  const reportProgress = () => {
    if (progressCallback) {
      const combined = Math.round(Math.max(systemProgress, micProgress) * 0.9);
      progressCallback(combined);
    }
  };

  // Check if tracks are usable — trust actual file content over manifest status
  // (manifest status may be stale from an unclean shutdown)
  const systemWav = path.join(sessionDir, manifest.tracks.system.file);
  const micWav = path.join(sessionDir, manifest.tracks.mic.file);
  const systemUsable = fs.existsSync(systemWav) && fs.statSync(systemWav).size > 44;
  const micUsable = fs.existsSync(micWav) && fs.statSync(micWav).size > 44;

  // Defensive: real recording manifests carry a processing.transcription block,
  // but a minimal/older manifest may not — lazy-create it so the assignments
  // below never throw and reject an otherwise-successful transcription+merge.
  manifest.processing = manifest.processing || {};
  manifest.processing.transcription = manifest.processing.transcription || {};

  const systemPromise = systemUsable
    ? (async () => {
        const systemPrefix = path.join(processedDir, 'system_transcript');
        console.log('Transcribing system track...');
        systemTranscript = await transcribe(systemWav, outputDir, (p) => {
          systemProgress = p;
          reportProgress();
        }, systemPrefix, true);
        systemCsvPath = `${systemPrefix}.csv`;
        manifest.processing.transcription.system = systemTranscript;
      })()
    : Promise.resolve();

  const micPromise = micUsable
    ? (async () => {
        const micPrefix = path.join(processedDir, 'mic_transcript');
        console.log('Transcribing mic track...');
        micTranscript = await transcribe(micWav, outputDir, (p) => {
          micProgress = p;
          reportProgress();
        }, micPrefix, true);
        micCsvPath = `${micPrefix}.csv`;
        manifest.processing.transcription.mic = micTranscript;
      })()
    : Promise.resolve();

  const results = await Promise.allSettled([systemPromise, micPromise]);

  if (results[0].status === 'rejected') {
    console.error('System track transcription failed:', results[0].reason.message);
  }
  if (results[1].status === 'rejected') {
    console.error('Mic track transcription failed:', results[1].reason.message);
  }

  // Merge transcripts (90-100% progress)
  if (progressCallback) progressCallback(90);
  console.log('Merging transcripts...');

  const mergedPath = path.join(processedDir, 'merged_transcript.txt');
  const systemLabel = manifest.tracks.system.label || 'Remote';
  const micLabel = manifest.tracks.mic.label || 'Me';

  try {
    mergeTranscripts(systemCsvPath, micCsvPath, mergedPath, systemLabel, micLabel);
  } catch (mergeErr) {
    throw new Error(`Failed to merge transcripts: ${mergeErr.message}`);
  }
  manifest.processing.transcription.merged = mergedPath;
  if (companionCheck) manifest.processing.transcription.source = 'own';

  // Update manifest
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  if (progressCallback) progressCallback(100);

  return {
    systemTranscript,
    micTranscript,
    mergedTranscript: mergedPath
  };
}

/**
 * Report whether whisper can run, and why not if it cannot.
 *
 * Reports rather than throws: this backs the settings window's dependency row,
 * where "not installed, and here is the command that fixes it" is the useful
 * answer. The first failure short-circuits, so the message names the thing that
 * is actually missing instead of the last thing checked.
 *
 * @param {{fsImpl?: object, home?: string}} [opts]
 * @returns {{installed: boolean, binaryPath: string|null, modelPath: string|null, error: string|null}}
 */
function verifyInstallation(opts = {}) {
  const result = { installed: false, binaryPath: null, modelPath: null, error: null };

  for (const [key, find] of [
    ['binaryPath', findWhisperBinary],
    ['modelPath', findWhisperModel]
  ]) {
    try {
      result[key] = find(opts);
    } catch (err) {
      result.error = err.message;
      return result;
    }
  }

  result.installed = true;
  return result;
}

module.exports = {
  assessCompanion,
  transcribe,
  whisperTimeoutMs,
  whisperArgs,
  parseWhisperProgress,
  transcribeSession,
  findUv,
  findWhisperBinary,
  findWhisperModel,
  verifyInstallation
};
