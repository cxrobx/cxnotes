#!/usr/bin/env node
'use strict';

/**
 * Re-summarise a transcript that already exists, from the command line.
 *
 *   npm run summaryonly <transcript-file-path>
 *
 * Useful when a summary needs regenerating but the audio does not — a provider
 * refusal that poisoned the notes (gotcha #12), or a prompt change worth
 * re-running over an old meeting. Whisper is the expensive step and this skips
 * it entirely.
 *
 * Deliberately shares the app's configuration rather than holding its own: same
 * provider (invariant #19), same vault (invariant #17), same summariser. A
 * re-summarise from the terminal must not quietly produce something the app
 * would not have.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  generateNotes,
  generateSessionNotes,
  exportNotesToObsidian,
  providerAvailability
} = require('./services/summariser');
const { resolveVaultDirectoryForScript } = require('./services/vaultLocator');
const { readStoredLlmOptions, describeNoProviderAvailable } = require('./services/llmProviders');
const { readStoredProfile, setVaultProfile } = require('./services/vaultProfile');

/** Only consulted when this install has never configured a vault. */
const LEGACY_VAULT_DIRECTORY = path.join(os.homedir(), 'Documents', 'CX');

/** `[MM:SS - MM:SS] Speaker: …` — the shape transcriptMerger writes. */
const SPEAKER_LINE = /\[\d{2,}:\d{2}\s*-\s*\d{2,}:\d{2}\]\s+\S+:/;

/**
 * Whether this transcript carries speaker labels, and so deserves the
 * speaker-aware prompt rather than the flat one.
 */
function isMergedTranscript(transcript) {
  return SPEAKER_LINE.test(transcript);
}

/** Labels a merged transcript implies when there is no manifest to read. */
function minimalManifest() {
  return {
    tracks: {
      system: { label: 'Remote' },
      mic: { label: 'Me' }
    }
  };
}

/** Read the transcript, refusing early on the two cases that cannot summarise. */
function readTranscript(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`No transcript at ${transcriptPath}`);
  }

  const transcript = fs.readFileSync(transcriptPath, 'utf-8');
  if (!transcript.trim()) {
    throw new Error('That transcript has no text in it.');
  }

  return transcript;
}

async function generateSummary(transcriptPath) {
  // Availability and the error text both come from the registry, so this script
  // cannot disagree with the app about which providers exist or how to install
  // them (invariant #19).
  const available = providerAvailability();
  if (!Object.values(available).some(Boolean)) {
    throw new Error(describeNoProviderAvailable('auto', available));
  }

  const transcript = readTranscript(transcriptPath);

  console.log(`Reading transcript: ${transcriptPath}`);
  console.log(`Transcript length: ${transcript.length} characters`);

  const llmOpts = readStoredLlmOptions();
  // Name the exported note the way the app would (category codes, own names).
  setVaultProfile(readStoredProfile().profile);
  const merged = isMergedTranscript(transcript);

  console.log(
    merged
      ? 'Detected merged dual-track transcript — using speaker-aware summarisation\n'
      : 'Detected single-track transcript — using standard summarisation\n'
  );

  const notesPath = merged
    ? await generateSessionNotes(transcriptPath, minimalManifest(), undefined, llmOpts)
    : await generateNotes(transcriptPath, undefined, llmOpts);

  // Null is a valid answer: the export is skipped and the notes still exist
  // beside the transcript, which is the whole point of this script.
  const vaultDir = resolveVaultDirectoryForScript({ preferPaths: [LEGACY_VAULT_DIRECTORY] });

  const obsidianPath = exportNotesToObsidian(notesPath, vaultDir, {
    title: path
      .basename(transcriptPath, path.extname(transcriptPath))
      .replace(/_transcript$/i, ''),
    startTime: fs.statSync(transcriptPath).birthtime.toISOString()
  });

  const rule = '='.repeat(80);
  console.log(rule);
  console.log(fs.readFileSync(notesPath, 'utf-8'));
  console.log(`\n${rule}`);
  console.log(`\nSummary generated and saved to: ${notesPath}`);
  console.log(
    obsidianPath
      ? `Obsidian export written to: ${obsidianPath}`
      : 'No vault configured — skipped the Obsidian export.'
  );
}

async function main() {
  const [transcriptPath] = process.argv.slice(2);

  if (!transcriptPath) {
    console.error('Usage: npm run summaryonly <transcript-file-path>');
    process.exit(1);
  }

  try {
    await generateSummary(transcriptPath);
  } catch (err) {
    console.error('\nError:', err.message);
    process.exit(1);
  }
}

main();
