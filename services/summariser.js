const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { resolveCollision } = require('./noteFiler');
const { getVaultProfile, selfNameSet } = require('./vaultProfile');
const { renderMarkersBlock } = require('./markers');
const { renderSlidesBlock } = require('./slideText');
const { renderSpeakerBlock } = require('./speakerNames');
const { renderContextBlock } = require('./meetingContextBlock');
const { resolveBinaryCached } = require('../utils/binaries');
const {
  PROVIDERS,
  normalisePreference,
  resolveProviderOrder,
  describeNoProviderAvailable,
  resolveModel,
} = require('./llmProviders');

const LLM_TIMEOUT = 300000; // 5 minutes (large transcripts need more time)

/**
 * Provider models are pinned in services/llmProviders.js and may be overridden
 * per provider from Settings.
 *
 * Why pinned at all: each CLI runs against an isolated/partial config
 * (`prepareCodex` writes its own minimal `config.toml` and never copies
 * `~/.codex/config.toml`), so WITHOUT an explicit model flag it silently falls
 * back to whatever its own default happens to be — summary quality would then
 * drift with a CLI upgrade.
 *
 * The Codex model must be one the INSTALLED codex-cli can run, not merely one
 * the account has: `~/.codex/config.toml` asks for `gpt-5.6-sol`, which
 * codex-cli 0.140.0 rejects with a 400 ("requires a newer version of Codex")
 * — every summary would then quietly land on the next provider. Check with
 * `echo hi | codex exec -m <model> --skip-git-repo-check --ephemeral`
 * before bumping.
 */
const CODEX_REASONING_EFFORT = 'high';

/**
 * Vault convention: `<CATEGORY> <Who|Topic> <MM.DD.YY>.md`, short enough to
 * read untruncated in Obsidian's file explorer. Was 120, which let a single
 * name run to a title plus three attendees plus the date.
 */
const OBSIDIAN_FILENAME_LIMIT = 40;

/*
 * The category tables and the user's own names are NOT in this file — they
 * describe one person's vault, so they come from the vault profile
 * (`services/vaultProfile.js`, the `vaultProfile` setting), read at call time:
 *
 * - `categoryByDestination`: folder -> category code, longest matching prefix
 *   wins.
 * - `categoryByContent`: codes the catch-all (`Meetings/`) and any
 *   unrecognised folder can carry, inferred from CONTENT — the one place the
 *   convention allows it, because the folder says nothing. Whole-token match
 *   over title + participants; first hit wins, so specific codes are listed
 *   above general ones. No hit → NO prefix. There is deliberately no default
 *   code: a fallback stamps itself on everything that matched nothing, which
 *   makes it the only code that never had to be earned.
 * - `selfNames`: the user attends everything, so naming them in the filename
 *   says nothing.
 */

/** Roles the transcriber emits that are not people. */
const NON_PEOPLE = new Set([
  'audience', 'audience speaker', 'speaker', 'unknown', 'unknown speaker',
  'remote speaker', 'local speaker', 'participant', 'participants',
  'everyone', 'all', 'team', 'guest', 'host', 'others', 'n/a', 'none',
]);

const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor', 'sir', 'rev',
  'mr.', 'mrs.', 'ms.', 'dr.',
]);

const TITLE_STOPWORDS = new Set([
  'call', 'calls', 'meeting', 'meetings', 'notes', 'note', 'summary',
  'w', 'with', 'and', 'the', 'a', 'an', 'for', 'on', 'of', 'to', 're',
  'talk', 'chat', 'session', 'catch', 'up', 'recording', 'transcript',
  'discussion', 'convo', 'conversation', 'untitled',
]);

const CALENDAR_CRUFT =
  /^(accepted|declined|tentative|invitation|updated invitation|canceled|cancelled)\s*[:-]?\s*/i;

const TOPIC_ALIASES = {
  'business development': 'Biz Dev',
  'biz dev': 'Biz Dev',
  development: 'Dev',
  dev: 'Dev',
  e2e: 'E2E',
  kickoff: 'Kickoff',
  'kick off': 'Kickoff',
  sync: 'Sync',
  demo: 'Demo',
  therapy: 'Therapy',
};

/** Titles that beat the counterpart's name in the middle slot. */
const TITLE_KEEP = new Set(['therapy', 'dev', 'kickoff', 'sync', 'demo', 'e2e']);

/**
 * Auth failures the CLIs print to STDOUT while exiting 0.
 */
const PROVIDER_AUTH_PATTERN =
  /not logged in|please run \/login|invalid api key|authentication failed|credentials? (are )?(invalid|expired)/i;

/**
 * Usage/quota refusals the CLIs also print to STDOUT while exiting 0 — a
 * failure wearing a success costume. Without this guard the notice becomes
 * the "summary": on 2026-07-31 a 1h25m meeting was transcribed fine, then
 * summarised, filed to the vault, and marked complete as the single line
 * "You've hit your session limit · resets 3:20pm (America/New_York)".
 */
const PROVIDER_LIMIT_PATTERNS = [
  /hit your (session|usage|rate|weekly|monthly) limit/i,
  /usage limit (reached|exceeded)/i,
  /rate.?limit(ed|ing| exceeded| reached)/i,
  /quota (exceeded|exhausted|reached)/i,
  /too many requests/i,
  /resets? (at )?\d{1,2}(:\d{2})?\s*(am|pm)/i,
  /insufficient (credit|balance|quota)/i,
  /upgrade (your plan|to continue)/i,
];

/**
 * Model-selection refusals, which are ALSO printed to stdout with exit 0.
 *
 * Verified 2026-08-05: `claude -p --model bogus` exits 0 having printed
 * "There's an issue with the selected model (bogus). It may not exist or you
 * may not have access to it." — no heading, ~150 chars, so without this it
 * satisfies every success condition and becomes the note, exactly like the
 * usage-limit incident of 2026-07-31.
 *
 * This matters more since models became user-configurable: a typo in the model
 * box, or a plan that does not include the pinned default, is now a reachable
 * way to poison every note. Gated by the same length + no-heading rule as the
 * limit patterns, so a meeting that genuinely discusses model access is safe.
 */
const PROVIDER_MODEL_PATTERNS = [
  /issue with the selected model/i,
  /model .{0,40}(does not exist|doesn't exist|not found|is not available|may not exist)/i,
  /(unknown|invalid|unsupported|unrecognized|unrecognised) model/i,
  /you may not have access to it/i,
];

/**
 * A real note runs to thousands of characters of "## " sections, so a short,
 * headingless output is the only shape a limit notice can take.
 */
const MAX_FAILURE_OUTPUT_CHARS = 400;

/**
 * Decide whether a provider's exit-0 output is actually a failure notice.
 *
 * Pure and exported so the same judgement is reused everywhere: the shared
 * provider runner below (so it covers every provider, including any added
 * later), and the app's scan for already-poisoned notes.
 *
 * @param {string} output - Trimmed provider stdout
 * @param {string} provider - Display name ("Codex" / "Claude" / "Ollama")
 * @returns {string|null} A failure message, or null if the output looks real
 */
function detectProviderFailure(output, provider = 'The AI provider') {
  const text = (output || '').trim();
  if (!text) return null;

  // Auth failures are unconditional — they were already caught at any length
  // and the wording can appear inside a longer help dump.
  if (PROVIDER_AUTH_PATTERN.test(text)) {
    return `${provider} CLI is not authenticated. Run "${provider.toLowerCase()}" in a terminal to log in.`;
  }

  // Requiring BOTH "short" and "no markdown headings" is what keeps a meeting
  // that genuinely DISCUSSES rate limits from being rejected as a failure.
  if (text.length > MAX_FAILURE_OUTPUT_CHARS || text.includes('##')) return null;

  for (const pattern of PROVIDER_LIMIT_PATTERNS) {
    if (pattern.test(text)) {
      return `${provider} hit a usage limit: ${text.split('\n')[0].slice(0, 200)}`;
    }
  }

  // Named separately from the limit case because the fix is different: the
  // user has to change a model, not wait for a quota to reset.
  for (const pattern of PROVIDER_MODEL_PATTERNS) {
    if (pattern.test(text)) {
      return `${provider} rejected the requested model: ${text.split('\n')[0].slice(0, 200)}`;
    }
  }

  return null;
}

/**
 * Format a date for inclusion in an LLM prompt.
 *
 * Accepts an ISO string or a directory-name timestamp like "2026-03-17_18-02-27".
 * Returns e.g. "Monday 17 March 2026 at 18:02" (UK style) or null on failure.
 */
function formatDateForPrompt(value) {
  if (!value) return null;

  // Normalise directory-name timestamps: "2026-03-17_18-02-27" → "2026-03-17T18:02:27"
  const normalised = String(value).replace(
    /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$/,
    '$1T$2:$3:$4'
  );

  const date = new Date(normalised);
  if (Number.isNaN(date.getTime())) return null;

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const dayName = dayNames[date.getDay()];
  const day = date.getDate();
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${dayName} ${day} ${month} ${year} at ${hours}:${minutes}`;
}

/**
 * Is a provider's CLI on PATH?
 *
 * Presence only — it cannot tell whether the CLI is authenticated or in
 * quota. Those surface later as an exit-0 refusal, which is exactly what
 * `detectProviderFailure` exists to convert into a real failure so the next
 * provider gets a turn.
 *
 * @param {string} id - Provider id from llmProviders.js
 * @returns {boolean}
 */
function isProviderAvailable(id) {
  const provider = PROVIDERS[id];
  if (!provider) return false;
  // NOT `which` — these are npm-global binaries living in Homebrew or an nvm
  // version dir, none of which are on a Dock-launched app's PATH. Using `which`
  // here reported "no provider installed" on every Mac except the build machine
  // (see utils/binaries.js).
  return Boolean(resolveBinaryCached(provider.bin));
}

/** Availability of every known provider, for the settings UI and runLLM. */
function providerAvailability() {
  const available = {};
  for (const id of Object.keys(PROVIDERS)) {
    available[id] = isProviderAvailable(id);
  }
  return available;
}

/** @returns {boolean} Kept as named helpers — main.js preflight imports these. */
function isCodexAvailable() {
  return isProviderAvailable('codex');
}

function isClaudeAvailable() {
  return isProviderAvailable('claude');
}

/**
 * Per-provider spawn specifications.
 *
 * Everything the providers do differently lives here; everything they do the
 * same lives in `runProvider` below. Before this split, `runCodex` and
 * `runClaude` were two near-identical 80-line copies of the same
 * spawn/stdin/timeout/exit-check/detectProviderFailure dance, and adding a
 * third provider meant a third copy.
 *
 * Each spec returns { bin, args, env, cwd, postProcess }.
 */
const PROVIDER_SPECS = {
  /**
   * Codex CLI — `codex exec` against an isolated HOME.
   *
   * The isolated home exists so a slow/failing MCP server in the user's own
   * `~/.codex/config.toml` cannot hang a meeting summary. Because that minimal
   * config REPLACES the user's, the model and reasoning effort must be passed
   * as flags rather than inherited.
   */
  codex(model) {
    // A stable dir under the real home — Codex refuses to run with HOME in /tmp.
    const realHome = os.homedir();
    const isolatedHome = path.join(realHome, '.cache', 'cxnotes-codex');
    const codexDir = path.join(isolatedHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });

    // Minimal config (no MCP servers, to avoid startup latency).
    fs.writeFileSync(path.join(codexDir, 'config.toml'), '[mcp_servers]\n', 'utf-8');

    // Carry the real auth across into the isolated home.
    const realAuth = path.join(realHome, '.codex', 'auth.json');
    if (fs.existsSync(realAuth)) {
      fs.copyFileSync(realAuth, path.join(codexDir, 'auth.json'));
    }

    const env = { PATH: process.env.PATH || '', HOME: isolatedHome };
    for (const key of ['CODEX_TOKEN', 'OPENAI_API_KEY']) {
      if (process.env[key]) env[key] = process.env[key];
    }

    return {
      bin: 'codex',
      args: [
        'exec',
        '-m', model,
        '-c', `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
        '--full-auto',
        '--skip-git-repo-check',
        '--ephemeral',
      ],
      env,
      cwd: isolatedHome,
      // Codex decorates stdout; strip colour then pull the assistant turn out.
      postProcess: (stdout) => extractContent(stripAnsi(stdout).trim()),
    };
  },

  /**
   * Claude CLI — `claude -p` (print mode).
   *
   * Inherits the full env so the CLI finds its auth/config in ~/.claude/, minus
   * the nested-session blockers that stop it launching from inside Claude Code.
   */
  claude(model) {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    return {
      bin: 'claude',
      args: ['-p', '--model', model, '--output-format', 'text', '--no-session-persistence'],
      env,
      cwd: os.homedir(),
      postProcess: (stdout) => stdout.trim(),
    };
  },

  /**
   * Ollama — a fully local model, the only option that needs no subscription
   * and the only one where the transcript never leaves the machine
   * (invariant #5).
   *
   * `ollama run <model>` reads the prompt from stdin and writes the reply to
   * stdout. If the model has not been pulled it will pull it on first use,
   * which can take minutes — that is why the shared timeout is generous.
   * Progress/spinner output goes to stderr, so stdout stays clean.
   */
  ollama(model) {
    return {
      bin: 'ollama',
      args: ['run', model],
      // Local daemon; it needs the real env to find OLLAMA_HOST if set.
      env: { ...process.env },
      cwd: os.homedir(),
      postProcess: (stdout) => stripAnsi(stdout).trim(),
    };
  },
};

/**
 * Run a prompt through one provider.
 *
 * The single place the spawn/stdin/timeout/exit/failure-detection sequence
 * lives. Rejects on anything that is not a usable summary, INCLUDING an exit-0
 * policy refusal (gotcha #12) — rejecting is what lets `runLLM` try the next
 * provider instead of writing the notice into the note.
 *
 * @param {string} id - Provider id
 * @param {string} prompt
 * @param {string} model
 * @returns {Promise<string>} The response text
 */
async function runProvider(id, prompt, model) {
  const provider = PROVIDERS[id];
  const buildSpec = PROVIDER_SPECS[id];
  if (!provider || !buildSpec) {
    throw new Error(`Unknown summarisation provider "${id}"`);
  }

  const label = provider.label;
  // Spec building can touch the filesystem (Codex writes its config), so a
  // failure here is the provider's failure, not a crash.
  let spec;
  try {
    spec = buildSpec(model);
  } catch (err) {
    throw new Error(`Failed to prepare ${label}: ${err.message}`);
  }

  return new Promise((resolve, reject) => {
    // Absolute path, for the same reason isProviderAvailable does not use `which`.
    const binPath = resolveBinaryCached(spec.bin) || spec.bin;
    const proc = spawn(binPath, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    // The child may exit before we finish writing the prompt.
    proc.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') throw err;
    });

    // end(data) writes + closes atomically, handling backpressure.
    proc.stdin.end(prompt, 'utf-8');

    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) { /* already dead */ }
      reject(new Error(`${label} timed out after ${LLM_TIMEOUT / 1000}s`));
    }, LLM_TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      let content;
      try {
        content = spec.postProcess(stdout) || '';
      } catch (err) {
        reject(new Error(`${label} produced unreadable output: ${err.message}`));
        return;
      }

      if (code !== 0 && !content) {
        reject(new Error(`${label} failed (exit ${code}): ${truncateError(stderr.trim())}`));
        return;
      }

      if (!content) {
        reject(new Error(`${label} returned empty output`));
        return;
      }

      // Auth/limit notices arrive on stdout with exit 0 — reject so runLLM
      // moves on rather than treating the notice as the summary.
      const failure = detectProviderFailure(content, label);
      if (failure) {
        reject(new Error(failure));
        return;
      }

      resolve(content);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start ${label}: ${err.message}`));
    });
  });
}

/**
 * Strip ANSI escape codes from text
 */
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Extract meaningful error from Codex stderr
 */
function truncateError(err) {
  const lines = err.split('\n');
  const errorLines = [];
  for (const line of lines) {
    if (line.startsWith('--------') || line.startsWith('session id:') || line.startsWith('user')) break;
    const stripped = line.trim();
    if (stripped && !stripped.startsWith('Reading prompt from stdin')) {
      errorLines.push(stripped);
    }
  }
  if (errorLines.length) return errorLines.join(' ').slice(0, 300);
  return err.slice(0, 300);
}

/**
 * Extract AI response content from Codex CLI output
 */
function extractContent(text) {
  const match = text.match(/\bassistant\s*\n/);
  if (match) {
    text = text.slice(match.index + match[0].length);
  }

  const fenced = text.match(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();

  return text.trim();
}

/**
 * Export generated notes to an Obsidian vault.
 *
 * Keeps the app's internal notes copy intact and writes a vault-friendly
 * Markdown file using a stable name when reprocessing an existing session.
 *
 * @param {string} notesPath - Path to the generated markdown notes
 * @param {string} vaultDir - Obsidian vault directory
 * @param {object} [options]
 * @param {string} [options.title] - Preferred title for the exported note
 * @param {string} [options.startTime] - ISO timestamp used in the filename
 * @param {string} [options.existingPath] - Existing export path to overwrite
 * @param {string} [options.subdirectory] - Vault-relative folder to file the
 *   note into (auto-filing). Collision-suffixed so it never overwrites a
 *   neighbour; omitted = legacy flat root export (stable name, overwrites).
 * @returns {string|null} Exported file path, or null when no vault is configured
 */
function exportNotesToObsidian(notesPath, vaultDir, options = {}) {
  if (!vaultDir) {
    return null;
  }

  if (!fs.existsSync(notesPath)) {
    throw new Error(`Notes file not found: ${notesPath}`);
  }

  const resolvedVaultDir = path.resolve(vaultDir);
  if (!fs.existsSync(resolvedVaultDir)) {
    fs.mkdirSync(resolvedVaultDir, { recursive: true });
  }

  const exportPath = resolveObsidianExportPath(resolvedVaultDir, notesPath, options);
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  fs.copyFileSync(notesPath, exportPath);

  console.log(`Obsidian export complete: ${exportPath}`);
  return exportPath;
}

/**
 * Resolve the target vault path for an exported note.
 */
function resolveObsidianExportPath(vaultDir, notesPath, options) {
  if (options.existingPath) {
    return path.resolve(options.existingPath);
  }

  const filename = buildObsidianFilename(notesPath, options);

  if (options.subdirectory) {
    // Filed exports get a collision suffix — an auto-filed note must never
    // clobber an existing note in the destination folder. The legacy flat
    // export keeps its stable-name overwrite semantics untouched.
    const targetDir = path.join(vaultDir, options.subdirectory);
    return path.join(targetDir, resolveCollision(targetDir, filename));
  }

  return path.join(vaultDir, filename);
}

/**
 * The category code for a vault-relative destination folder.
 *
 * Derived from the FOLDER, never the content, so it is always re-derivable —
 * which is what makes a refile able to re-stamp the name (see main.js).
 */
function categoryForDestination(subdirectory) {
  const dir = String(subdirectory || '').replace(/^\/+|\/+$/g, '');
  let best = null;
  for (const [prefix, code] of getVaultProfile().categoryByDestination) {
    if (dir === prefix || dir.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best[0].length) best = [prefix, code];
    }
  }
  return best ? best[1] : '';
}

/**
 * The category code the CONTENT earns, for folders that say nothing.
 *
 * Whole-token, case-insensitive, over the title and the participants list.
 * Returns '' when nothing matches — the empty string is the answer, not a
 * placeholder for one.
 */
function categoryForContent(title, participants) {
  const haystack = ` ${[title, participants].filter(Boolean).join(' ')} `
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  for (const [code, keywords] of getVaultProfile().categoryByContent) {
    if (keywords.some((kw) => haystack.includes(` ${kw} `))) return code;
  }
  return '';
}

/**
 * The category for a note: the folder's code, else whatever the content
 * earns, else nothing.
 */
function resolveCategory({ subdirectory, title, participants } = {}) {
  return categoryForDestination(subdirectory) || categoryForContent(title, participants);
}

/**
 * Re-stamp a filename's category for a new destination folder.
 *
 * The category is a function of the folder, so a note that moves folders MUST
 * be renamed too — otherwise a note filed to Inbox as `ACM Dominic 06.17.26.md`
 * and later moved to another client's folder keeps saying ACM forever, and the
 * convention quietly stops being re-derivable.
 *
 * Moving INTO a folder with no code of its own (the catch-all) is the one
 * case where the existing lead survives — if it is a content code. The
 * content has not changed, so a content code stays; a folder code is
 * stripped, because the folder it described is no longer true.
 */
function restampCategoryForDestination(filename, subdirectory) {
  const folderCode = categoryForDestination(subdirectory);
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  const lead = stem.split(' ')[0];
  const profile = getVaultProfile();
  const contentCategories = new Set(profile.categoryByContent.map(([code]) => code));
  const knownCategories = new Set(
    profile.categoryByDestination.map(([, code]) => code).concat([...contentCategories])
  );
  const hasLead = knownCategories.has(lead);
  const rest = hasLead ? stem.slice(lead.length).trim() : stem;
  const code = folderCode || (hasLead && contentCategories.has(lead) ? lead : '');
  return `${[code, rest].filter(Boolean).join(' ')}${ext}`;
}

/**
 * Counterpart first names. The user is dropped; so is a list that is mostly
 * raw usernames, which name nobody (`zorro4, marlowe321, jules.s`).
 */
function stripSelf(participants) {
  const selfNames = selfNameSet();
  const named = String(participants || '')
    .split(/[,;/\n]|\band\b/i)
    .map((p) => p.replace(/\(.*?\)/g, '').trim())
    .filter(Boolean)
    .filter((p) => p.split(/\s+/).length <= 4 && p.length <= 40)
    .filter((p) => !selfNames.has(p.toLowerCase()) && !NON_PEOPLE.has(p.toLowerCase()));

  if (!named.length) return [];
  const isUsername = (n) => /\d/.test(n) || n.includes('.') || n.includes('@');
  if (named.filter(isUsername).length * 2 > named.length) return [];

  const out = [];
  const seen = new Set();
  for (const person of named.filter((n) => !isUsername(n))) {
    const first = firstNameOf(person);
    if (first && !seen.has(first.toLowerCase())) {
      seen.add(first.toLowerCase());
      out.push(first);
    }
  }
  return out;
}

function firstNameOf(name) {
  for (const raw of name.split(/\s+/)) {
    const token = raw.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9'-]+$/g, '');
    if (!token || HONORIFICS.has(token.toLowerCase())) continue;
    return token === token.toUpperCase() ? token : token[0].toUpperCase() + token.slice(1);
  }
  return '';
}

/** `First` · `First, First` · `First et al` */
function formatPeople(people) {
  if (people.length === 1) return people[0];
  if (people.length === 2) return `${people[0]}, ${people[1]}`;
  return `${people[0]} et al`;
}

/** Drop the calendar client's `Accepted: ` / `Invitation: ` prefix. */
function cleanCalendarTitle(title) {
  return String(title || '').replace(CALENDAR_CRUFT, '').trim();
}

/**
 * Title content words, minus anything the rest of the name already says.
 * `Call w Dominic` next to a `Dominic` people slot contributes nothing.
 */
function dedupeTitleAgainstPeople(title, people, category) {
  const drop = new Set([...TITLE_STOPWORDS, ...selfNameSet()]);
  for (const p of people) drop.add(p.toLowerCase());
  drop.add(String(category).toLowerCase());

  // A content-earned code already says what earned it; those words must not
  // be repeated in the topic (`BD Biz Dev Planning`).
  let cleaned = cleanCalendarTitle(title);
  const earned = getVaultProfile().categoryByContent.find(([code]) => code === category);
  for (const kw of earned ? earned[1] : []) {
    cleaned = cleaned.replace(new RegExp(`(^|[^a-z0-9])${kw.replace(/\s+/g, '[\\s_-]+')}(?![a-z0-9])`, 'gi'), '$1');
  }

  const tokens = cleaned
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z0-9:&'/]/g, ''))
    .filter((t) => t && !drop.has(t.toLowerCase()) && !/^\d+$/.test(t));

  const phrase = tokens.join(' ').toLowerCase();
  if (TOPIC_ALIASES[phrase]) return TOPIC_ALIASES[phrase];

  return tokens
    .slice(0, 3)
    .map((t) => TOPIC_ALIASES[t.toLowerCase()] || t[0].toUpperCase() + t.slice(1))
    .join(' ');
}

/**
 * Build an Obsidian-friendly filename from note metadata.
 *
 *   `<CATEGORY> <Who|Topic> <MM.DD.YY>.md`
 *
 * The date is last and never truncated, so it survives sidebar clipping.
 */
function buildObsidianFilename(notesPath, options) {
  const rawTitle = normaliseExportTitle(options.title || path.basename(notesPath, '.md'));
  const category = resolveCategory({
    subdirectory: options.subdirectory,
    title: rawTitle,
    participants: options.participants,
  });
  const people = stripSelf(options.participants);
  const topic = dedupeTitleAgainstPeople(rawTitle, people, category);
  const timestamp = formatTimestampForFilename(options.startTime);

  // A named counterpart wins, except where the title says more than the name
  // does — a therapy session is a therapy session whoever ran it.
  let middle;
  if (topic && TITLE_KEEP.has(topic.toLowerCase())) middle = topic;
  else if (people.length) middle = formatPeople(people);
  else middle = topic;

  const build = (mid) => [category, mid, timestamp].filter(Boolean).join(' ');

  // The compression ladder from the convention: `et al` → drop the second
  // attendee → truncate the topic. The literal `Meeting` is NOT on it — it
  // used to sit ahead of truncation, and since it always fits, every topic
  // over budget became the word "Meeting" (a job interview was filed as
  // `<CODE> Meeting <date>.md`). It is only for a middle that is genuinely empty.
  const candidates = [middle];
  if (people.length === 2) candidates.push(`${people[0]} et al`, people[0]);
  candidates.push(topic);
  for (const mid of candidates) {
    if (mid && `${build(mid)}.md`.length <= OBSIDIAN_FILENAME_LIMIT) return `${build(mid)}.md`;
  }
  const room = OBSIDIAN_FILENAME_LIMIT - '.md'.length - (build('x').length - 1);
  return `${build(truncateMiddle(middle || 'Meeting', room))}.md`;
}

/**
 * Convert a title into a filesystem-safe form.
 */
function normaliseExportTitle(value) {
  return String(value || '')
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+notes?$/i, '')
    .replace(/[_-]+transcript$/i, '')
    .replace(/[_-]+session$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Format a timestamp for a note filename in local time.
 */
function formatTimestampForFilename(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);

  return `${month}.${day}.${year}`;
}

/**
 * Fit the middle slot into `room` characters.
 *
 * Only the middle is ever cut — the category and the date are the fields
 * you scan by, so they are never what gets eaten. Whole words first; a single
 * word wider than the room is sliced, because the alternative is a name with
 * no middle at all (`ACM 07.31.26.md`), which the old whole-name truncation
 * produced when the category was the only word that fit.
 */
function truncateMiddle(middle, room) {
  const words = String(middle).trim().split(/\s+/).filter(Boolean);
  const kept = [];
  for (const word of words) {
    if (kept.concat(word).join(' ').length > room) break;
    kept.push(word);
  }
  if (kept.length) return kept.join(' ');
  return (words[0] || 'Meeting').slice(0, Math.max(room, 3));
}

/**
 * How the prompt should talk about when the meeting happened.
 *
 * Both prompt builders need exactly this pair and used to compute it with two
 * identical copies of the same three expressions, which is how the two prompts
 * would eventually have drifted into dating notes differently.
 *
 * @param {string|Date|null} when - anything formatDateForPrompt understands
 * @returns {{dateInstruction: string, dateTitle: string}}
 */
function dateFraming(when) {
  const formatted = when ? formatDateForPrompt(when) : null;

  if (!formatted) {
    return {
      dateInstruction: `Infer the meeting date if it's mentioned or implied.`,
      dateTitle: 'Meeting Notes [Include inferred date]'
    };
  }

  // The title wants the date alone — drop the leading weekday and the trailing
  // time that formatDateForPrompt includes for the instruction.
  const bare = formatted.replace(/^\w+ /, '').replace(/ at .*$/, '');
  return {
    dateInstruction: `This meeting was recorded on ${formatted}. Use this date in the title.`,
    dateTitle: `Meeting Notes [${bare}]`
  };
}

/** Session directories are named `YYYY-MM-DD_HH-MM-SS_session`. */
const SESSION_STAMP = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_session/;

/**
 * Generate meeting notes from a single-track transcript.
 *
 * The older of the two paths: one unlabelled speaker stream, so the notes it
 * asks for are topic-shaped rather than speaker-shaped. Dual-track recordings
 * go through generateSessionNotes instead, which can attribute who said what.
 *
 * @param {string} transcriptPath - transcript to read
 * @param {Function} [progressCallback] - receives provider progress
 * @param {object} [llmOpts] - provider/model options (invariant #19)
 * @returns {Promise<string>} path to the notes written beside the transcript
 */
async function generateNotes(transcriptPath, progressCallback, llmOpts = {}) {
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`No transcript at ${transcriptPath}`);
  }

  const transcript = fs.readFileSync(transcriptPath, 'utf-8');
  if (!transcript.trim()) {
    throw new Error('That transcript has no text in it, so there is nothing to summarise.');
  }

  const outputPath = transcriptPath.replace('_transcript.txt', '_notes.md');
  console.log(`Summarising ${transcriptPath}`);

  const stamp = transcriptPath.match(SESSION_STAMP);
  const { dateInstruction, dateTitle } = dateFraming(stamp ? stamp[1] : null);

  const prompt = `You write clear, structured notes from a meeting transcript. Read it and produce well-organised notes with accurate detail and concise wording. ${dateInstruction}

Use these sections where the transcript supports them, and leave out any that it does not:

## ${dateTitle}

## Meeting Purpose
What the meeting was for.

## Key Takeaways
The decisions and outcomes that matter.

## Topics Discussed
Organised by topic.

## Problems / Blockers
Issues raised.

## Solutions / Proposals
What was suggested in response.

## Action Items
- [ ] One line per commitment, naming the owner where the transcript identifies one.

## Next Steps
What happens after this meeting.

Write in plain UK English. Use the real names, figures and technical detail the transcript contains, and add nothing it does not support — an absent section is better than an invented one.

---

TRANSCRIPT:
${transcript}

---

Write the notes now, following the structure above.`;

  const notes = await runLLM(prompt, progressCallback, llmOpts);
  fs.writeFileSync(outputPath, notes, 'utf-8');
  console.log(`Notes generated successfully: ${outputPath}`);
  return outputPath;
}

/**
 * Generate speaker-aware meeting notes from a merged dual-track transcript
 *
 * @param {string} mergedTranscriptPath - Path to merged speaker-labeled transcript
 * @param {object} manifest - Session manifest object
 * @param {Function} [progressCallback] - Optional callback for progress updates
 * @returns {Promise<string>} Path to generated notes markdown file
 */
async function generateSessionNotes(mergedTranscriptPath, manifest, progressCallback, llmOpts = {}) {
  if (!fs.existsSync(mergedTranscriptPath)) {
    throw new Error(`Merged transcript not found: ${mergedTranscriptPath}`);
  }

  const transcript = fs.readFileSync(mergedTranscriptPath, 'utf-8');
  if (transcript.trim().length === 0) {
    throw new Error('Merged transcript is empty. Cannot generate notes.');
  }

  const outputDir = path.dirname(mergedTranscriptPath);
  const outputPath = path.join(outputDir, 'notes.md');

  const systemLabel = manifest.tracks.system.label || 'Remote';
  const micLabel = manifest.tracks.mic.label || 'Me';
  const ctx = manifest.meetingContext || {};

  console.log(`Generating speaker-aware notes from: ${mergedTranscriptPath}`);
  console.log(`Speakers: ${systemLabel} (system), ${micLabel} (mic)`);
  if (ctx.title) console.log(`Meeting context: ${ctx.title}`);

  // Title, invite list and agenda — everything known BEFORE anyone spoke. The
  // invite list is rendered as "Invited", never "Participants", and carries an
  // explicit instruction not to become the attendance list: it is a guest list,
  // and a guest list read as a register is how a note claims someone was in a
  // room they were never in. See services/meetingContextBlock.js.
  const contextBlock = renderContextBlock(ctx, { systemLabel });

  // Live markers the user dropped mid-meeting (manifest.markers, written from
  // <sessionDir>/markers.json at stop). Empty list → empty string, so a session
  // with no markers produces a byte-identical prompt to before the feature.
  const markersBlock = renderMarkersBlock(manifest.markers, { speakerLabel: micLabel });
  if (manifest.markers && manifest.markers.length) {
    console.log(`Including ${manifest.markers.length} live marker(s) in the summary prompt`);
  }

  // Text read off any slides that were captured. Same contract as markers:
  // nothing captured → empty string → a prompt byte-identical to before the
  // feature existed.
  const slidesBlock = renderSlidesBlock(manifest.slideText);
  if (manifest.slideText && manifest.slideText.length) {
    console.log(`Including ${manifest.slideText.length} slide keyframe(s) in the summary prompt`);
  }

  // Names the meeting app was showing, if the window was captured. Same
  // empty-string contract as markers and slides.
  const speakerBlock = renderSpeakerBlock(manifest.speakerTimeline, { systemLabel });
  if (manifest.speakerTimeline && manifest.speakerTimeline.length) {
    console.log(`Including ${manifest.speakerTimeline.length} on-screen speaker name(s) in the summary prompt`);
  }

  const { dateInstruction, dateTitle } = dateFraming(manifest.startTime);

  const prompt = `You create clear and structured meeting notes from a dual-track transcript. The transcript has two speakers:
- "${systemLabel}" — the remote participant(s) heard through system audio
- "${micLabel}" — the local user speaking into their microphone
${contextBlock}${markersBlock}${slidesBlock}${speakerBlock}
Read the transcript and produce well-organised, speaker-aware notes with accurate detail and concise wording. ${dateInstruction}

Use the following sections when they apply:

## ${dateTitle}

## Participants
List only the speakers the transcript itself supports — someone who speaks, or whom a speaker addresses by name. This is a record of who was in the meeting, so do not pad it from an invite list, and mark anyone you could not identify as unidentified rather than guessing at a name.

## Meeting Purpose
Brief summary of what this meeting was about.

## Key Takeaways
The most important outcomes or decisions.

## Topics Discussed
Organised by topic, noting who raised each point.

## Action Items
All action items with owner attribution:
- [ ] [Owner] Action item description

## My Commitments
Things "${micLabel}" agreed to do or follow up on.

## Their Commitments
Things "${systemLabel}" agreed to do or follow up on.

## Problems / Blockers
Any issues raised, noting who raised them.

## Solutions / Proposals
Solutions discussed, noting who proposed them.

## Next Steps
Agreed next steps and timeline.

Write in plain UK English. Keep each section brief but complete. Do not invent details that aren't supported by the transcript. Attribute statements and commitments to the correct speaker.

---

TRANSCRIPT:
${transcript}

---

Generate comprehensive speaker-aware meeting notes following the format above. Be concise but thorough.`;

  const notes = await runLLM(prompt, progressCallback, llmOpts);
  fs.writeFileSync(outputPath, notes, 'utf-8');
  console.log(`Notes generated successfully: ${outputPath}`);
  return outputPath;
}

/**
 * Run a prompt through the user's chosen LLM provider, falling back in order.
 *
 * The order comes from `resolveProviderOrder` — `auto` (the default, and the
 * behaviour that shipped before the setting existed) is Codex → Claude →
 * Ollama, filtered to what is actually installed. A named preference goes
 * first and the rest remain as fallback, unless `strict` is set, which is the
 * only way to guarantee the transcript reaches nothing else.
 *
 * Every provider is tried before giving up, and the LAST error is reported
 * with the full trail — "Codex hit a usage limit, then Claude is not
 * authenticated" is diagnosable; "summarisation failed" is not.
 *
 * @param {string} prompt
 * @param {Function} [progressCallback]
 * @param {object} [opts]
 * @param {string} [opts.provider='auto'] - 'auto' or a provider id
 * @param {boolean} [opts.strict=false] - Do not fall back past the preference
 * @param {object} [opts.models] - Per-provider model overrides, blank = pinned
 * @returns {Promise<string>} Response text
 */
async function runLLM(prompt, progressCallback, opts = {}) {
  const preference = normalisePreference(opts.provider);
  const strict = Boolean(opts.strict);
  const available = providerAvailability();
  const order = resolveProviderOrder(preference, available, { strict });

  if (!order.length) {
    throw new Error(describeNoProviderAvailable(preference, available, { strict }));
  }

  if (progressCallback) progressCallback(10);

  const failures = [];
  for (const id of order) {
    const label = PROVIDERS[id].label;
    const model = resolveModel(id, opts.models);
    try {
      console.log(`Using ${label} for summarisation (model: ${model})...`);
      const result = await runProvider(id, prompt, model);
      if (progressCallback) progressCallback(100);
      return result;
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
      const remaining = order.length - failures.length;
      if (remaining > 0) {
        console.warn(`${label} failed, falling back: ${err.message}`);
      }
    }
  }

  throw new Error(`Summarisation failed. ${failures.join(' | ')}`);
}

module.exports = {
  buildObsidianFilename,
  categoryForContent,
  categoryForDestination,
  cleanCalendarTitle,
  dedupeTitleAgainstPeople,
  detectProviderFailure,
  exportNotesToObsidian,
  formatPeople,
  resolveCategory,
  restampCategoryForDestination,
  stripSelf,
  generateNotes,
  generateSessionNotes,
  isCodexAvailable,
  isClaudeAvailable,
  isProviderAvailable,
  providerAvailability,
  runLLM,
};
