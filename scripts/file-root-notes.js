#!/usr/bin/env node
'use strict';

/**
 * One-time sweep: file loose CXNotes-format notes at the vault ROOT into
 * their proper folders using the same classifier as the live export path
 * (services/noteFiler.js — deterministic → LLM → Inbox/catch-all tiers).
 *
 * Only files matching the CXNotes export shape ("<title> MM.DD.YY.md")
 * are touched; everything else at the root is left alone. Unsure notes go to
 * Inbox/ (no pop-up — this is a CLI). Kept for reuse after the one-time run.
 *
 * Usage:
 *   node scripts/file-root-notes.js --dry-run    # print planned moves only
 *   node scripts/file-root-notes.js              # move for real
 *   node scripts/file-root-notes.js --vault <dir> [--dry-run]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { classifyNote, resolveCollision } = require('../services/noteFiler');
const { runLLM } = require('../services/summariser');
const { readStoredLlmOptions } = require('../services/llmProviders');
const { resolveVaultDirectoryForScript } = require('../services/vaultLocator');
const { readStoredProfile, setVaultProfile } = require('../services/vaultProfile');

const EXPORT_NAME_RE = /\s\d{2}\.\d{2}\.\d{2}\.md$/;

/** The pre-configurable default; only used if this install never set a vault. */
const LEGACY_VAULT_DIRECTORY = path.join(os.homedir(), 'Documents', 'CX');

/**
 * `runLLM` bound to the provider the APP is configured to use, since noteFiler
 * calls it as `runLLM(prompt)`. Read once per run — a sweep should not change
 * provider halfway through because Settings was touched mid-flight.
 */
const STORED_LLM_OPTIONS = readStoredLlmOptions();

// The app's own filing rules and vault profile, so a sweep files and names
// notes exactly as the app would.
const STORED_PROFILE = readStoredProfile();
setVaultProfile(STORED_PROFILE.profile);
function filingRunLLM(prompt) {
  return runLLM(prompt, undefined, STORED_LLM_OPTIONS);
}

function parseArgs(argv) {
  // `--vault` stays an explicit override; with none given, resolve the SAME
  // vault the app exports to (configured setting → detection) so a sweep can
  // never tidy a different vault than the one being filled.
  const args = { dryRun: false, vaultDir: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--vault' && argv[i + 1]) args.vaultDir = path.resolve(argv[++i]);
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  args.vaultDir = resolveVaultDirectoryForScript({
    overridePath: args.vaultDir,
    preferPaths: [LEGACY_VAULT_DIRECTORY]
  });
  return args;
}

function moveNote(fromPath, targetDir, dryRun) {
  const filename = resolveCollision(targetDir, path.basename(fromPath));
  const toPath = path.join(targetDir, filename);
  if (dryRun) return toPath;
  fs.mkdirSync(targetDir, { recursive: true });
  try {
    fs.renameSync(fromPath, toPath);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(fromPath, toPath);
    fs.unlinkSync(fromPath);
  }
  return toPath;
}

async function main() {
  const { dryRun, vaultDir } = parseArgs(process.argv);

  if (!vaultDir) {
    console.error(
      'No vault configured. Set one in CXNotes Settings → Notes & filing, or pass --vault <dir>.'
    );
    process.exit(1);
  }

  if (!fs.existsSync(vaultDir)) {
    console.error(`Vault not found: ${vaultDir}`);
    process.exit(1);
  }

  const looseNotes = fs.readdirSync(vaultDir)
    .filter((name) => EXPORT_NAME_RE.test(name))
    .filter((name) => {
      try {
        return fs.statSync(path.join(vaultDir, name)).isFile();
      } catch (err) {
        return false;
      }
    });

  console.log(`Vault: ${vaultDir}`);
  console.log(`Loose CXNotes-format notes at root: ${looseNotes.length}${dryRun ? ' (dry run)' : ''}\n`);

  const summary = { deterministic: 0, llm: 0, 'catch-all': 0, inbox: 0, skipped: 0 };

  for (const name of looseNotes) {
    const notePath = path.join(vaultDir, name);
    // The export filename is "<title> <participants> MM.DD.YY" — the stem is
    // both title and participant list, so feed it to both signals (people
    // rules fire on the names embedded in it).
    const stem = name.replace(/\.md$/i, '').replace(/\s\d{2}\.\d{2}\.\d{2}$/, '');
    let notesExcerpt = '';
    try {
      notesExcerpt = fs.readFileSync(notePath, 'utf-8').slice(0, 1500);
    } catch (err) {
      // Classify on the filename alone
    }

    const filing = await classifyNote(
      { title: stem, participants: stem, notesExcerpt },
      { vaultDir, rules: STORED_PROFILE.filingRules, runLLM: filingRunLLM }
    );

    if (!filing) {
      summary.skipped += 1;
      console.log(`SKIP   ${name} (classifier unavailable)`);
      continue;
    }

    const toPath = moveNote(notePath, filing.destinationDir, dryRun);
    summary[filing.method] = (summary[filing.method] || 0) + 1;
    const verb = dryRun ? 'WOULD MOVE' : 'MOVED';
    console.log(`${verb}  ${name}`);
    console.log(`        → ${path.relative(vaultDir, toPath)}  [${filing.method}] ${filing.reason}`);
  }

  console.log('\nSummary:');
  for (const [method, count] of Object.entries(summary)) {
    if (count) console.log(`  ${method}: ${count}`);
  }
  if (!looseNotes.length) console.log('  nothing to do — vault root is clean');
}

main().catch((err) => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
