#!/usr/bin/env node
'use strict';

/**
 * British-English spelling gate (invariant #4).
 *
 * Scans the JS/HTML source surface for American spellings of words this codebase
 * standardises British. Runs as `pretest`, so `npm test` fails if a regression
 * slips in.
 *
 * Deliberate exclusions (NOT violations — external API keys / framework data):
 *   - `organizer`           — EventKit's event.organizer key (calendar-helper JSON)
 *   - `canceled`            — Electron dialog result.canceled property
 *   - `initialize`/`finalize` — conventional/pervasive; out of this gate's scope
 *   - `-behavior`           — CSS property names (`overscroll-behavior`,
 *                             `scroll-behavior`); a hyphen in front means it is
 *                             a spelling the browser chose, not one we did
 * The `organiz(?!er)` lookahead lets the verb "organise" be enforced while the
 * EventKit `organizer` noun passes.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// [regex, britishForm]. Case-insensitive. JS regex → lookahead supported.
const RULES = [
  [/\bsummariz(e|es|ed|ing|ation|er)\b/i, 'summarise / summariser'],
  [/\borganiz(?!er)(e|es|ed|ing|ation)\b/i, 'organise / organisation'],
  [/(?<!-)\bbehavior\b/i, 'behaviour'],
];

const SCAN_DIRS = ['services', 'mcp', 'shared', 'renderer'];
const SCAN_FILES = [
  'main.js',
  'preload.js',
  'preload-meeting-banner.js',
  'preload-prerecord.js',
  'preload-silence-prompt.js',
  'preload-filing-prompt.js',
  'summarise-only.js',
];
const EXTS = new Set(['.js', '.html']);

function gatherFiles() {
  const files = [];
  for (const f of SCAN_FILES) {
    const p = path.join(REPO_ROOT, f);
    if (fs.existsSync(p)) files.push(p);
  }
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/node_modules/.test(p)) walk(p);
      } else if (EXTS.has(path.extname(e.name))) {
        files.push(p);
      }
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(REPO_ROOT, d));
  return files;
}

function main() {
  const hits = [];
  for (const file of gatherFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const [re, british] of RULES) {
        if (re.test(line)) {
          hits.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: use "${british}" → ${line.trim().slice(0, 100)}`);
        }
      }
    });
  }

  if (hits.length) {
    console.error('British-English gate FAILED (invariant #4):\n');
    hits.forEach((h) => console.error('  ' + h));
    console.error(`\n${hits.length} American spelling(s) found. Use British English.`);
    process.exit(1);
  }
  console.log('British-English gate: OK');
}

main();
