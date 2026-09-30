#!/usr/bin/env node
'use strict';

/**
 * Doctor for the cxnotes-calendar MCP server (`npm run mcp:check`).
 *
 * Drives the Calendar grant up front and tells you exactly how to fix whatever
 * is wrong — the mitigation for the Phase 0 finding that a headless helper can
 * be keyed to a different code signature than the granted one (gotcha #7).
 *
 * Exit codes: 0 = ready (granted), 1 = helper missing, 2 = permission not granted.
 */

const path = require('path');
const { createCalendarSource, helperExists } = require('./calendarFactory');
const { resolveCalendarHelperPath, getPreparedDir, INSTALLED_HELPER_PATH } = require('../shared/paths');

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  console.log('cxnotes-calendar — MCP doctor\n');

  const helperPath = resolveCalendarHelperPath({ repoRoot, preferInstalled: true });
  console.log(`Helper path:   ${helperPath}`);
  console.log(`Installed app: ${helperExists(INSTALLED_HELPER_PATH) ? 'present (preferred — signed)' : 'absent'}`);
  console.log(`Handoff dir:   ${getPreparedDir()}\n`);

  if (!helperExists(helperPath)) {
    console.log('✗ calendar-helper not found.');
    console.log('  Fix: npm run build:calendar');
    process.exit(1);
  }

  let source;
  try {
    ({ source } = createCalendarSource({ repoRoot, wireSignals: false }));
  } catch (err) {
    console.log(`✗ ${err.message}`);
    console.log(`  Fix: ${err.fix || 'npm run build:calendar'}`);
    process.exit(1);
  }

  console.log('Requesting Calendar access (this may surface the macOS prompt)…');
  const state = await source.ensurePermission();
  console.log(`Permission state: ${state}\n`);

  if (state === 'granted') {
    // Smoke-test a real query so the doctor proves end-to-end readiness.
    const upcoming = await source.getUpcomingEvents({ windowMinutes: 120 });
    if (upcoming.error) {
      console.log(`⚠ Calendar query returned: ${upcoming.error}`);
    } else {
      console.log(`✓ Ready. ${upcoming.events.length} meeting(s) in the next 2 hours.`);
    }
    process.exit(0);
  }

  console.log('✗ Calendar access is not granted.');
  console.log('  macOS keys the grant to the helper’s code signature (gotcha #7).');
  console.log('  Fixes:');
  console.log('   • Prefer the installed app’s signed helper: build + install CXNotes,');
  console.log('     then grant Calendar access when the app first asks.');
  console.log('   • Or open System Settings → Privacy & Security → Calendars and enable the helper.');
  process.exit(2);
}

main().catch((err) => {
  console.error('Doctor crashed:', err);
  process.exit(1);
});
