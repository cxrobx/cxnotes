'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Export-path + failure-detection surface only — no child_process / LLM involvement.
const {
  exportNotesToObsidian,
  detectProviderFailure,
  buildObsidianFilename,
  categoryForContent,
  categoryForDestination,
  cleanCalendarTitle,
  dedupeTitleAgainstPeople,
  formatPeople,
  resolveCategory,
  restampCategoryForDestination,
  stripSelf,
} = require('./summariser');
const { setVaultProfile } = require('./vaultProfile');
const { FIXTURE_PROFILE } = require('./vaultProfile.fixture');

// Category codes and own names come from the vault profile, not the module.
setVaultProfile(FIXTURE_PROFILE);

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n4c-export-'));
  const vaultDir = path.join(root, 'vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  const notesPath = path.join(root, 'notes.md');
  fs.writeFileSync(notesPath, '# Meeting Notes\nHello.', 'utf-8');
  return { root, vaultDir, notesPath };
}

test('flat legacy export: stable name at the vault root, overwrites on re-export', () => {
  const { vaultDir, notesPath } = makeFixture();
  const options = { title: 'NXT Sync', participants: 'Chris, Tony', startTime: '2026-07-20T10:00:00' };

  const first = exportNotesToObsidian(notesPath, vaultDir, options);
  assert.equal(path.dirname(first), vaultDir, 'flat export lands at the root');
  assert.equal(path.basename(first), 'Tony 07.20.26.md');

  fs.writeFileSync(notesPath, 'updated', 'utf-8');
  const second = exportNotesToObsidian(notesPath, vaultDir, options);
  assert.equal(second, first, 'no collision suffix without a subdirectory');
  assert.equal(fs.readFileSync(second, 'utf-8'), 'updated', 'overwrote in place');
});

test('subdirectory export: files under the vault-relative folder, creating it', () => {
  const { vaultDir, notesPath } = makeFixture();
  const exported = exportNotesToObsidian(notesPath, vaultDir, {
    title: 'NXT Sync',
    startTime: '2026-07-20T10:00:00',
    subdirectory: 'Projects/CXVentures/Clients/NXT/Meetings'
  });

  assert.equal(
    path.dirname(exported),
    path.join(vaultDir, 'Projects/CXVentures/Clients/NXT/Meetings'),
    'created + used the destination folder'
  );
  assert.ok(fs.existsSync(exported));
});

test('subdirectory export: collision gets a " 2" suffix instead of overwriting', () => {
  const { vaultDir, notesPath } = makeFixture();
  const options = {
    title: 'NXT Sync',
    startTime: '2026-07-20T10:00:00',
    subdirectory: 'Meetings'
  };

  const first = exportNotesToObsidian(notesPath, vaultDir, options);
  const second = exportNotesToObsidian(notesPath, vaultDir, options);

  assert.notEqual(second, first);
  assert.equal(path.basename(second), 'NXT Sync 07.20.26 2.md');
  assert.ok(fs.existsSync(first) && fs.existsSync(second), 'both notes kept');
});

test('existingPath wins unconditionally, even over subdirectory', () => {
  const { root, vaultDir, notesPath } = makeFixture();
  const existing = path.join(root, 'somewhere', 'Existing Note.md');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, 'old', 'utf-8');

  const exported = exportNotesToObsidian(notesPath, vaultDir, {
    title: 'NXT Sync',
    existingPath: existing,
    subdirectory: 'Projects/CXVentures/Clients/NXT/Meetings'
  });

  assert.equal(exported, path.resolve(existing), 'reprocess overwrites in place');
  assert.equal(fs.readFileSync(existing, 'utf-8'), '# Meeting Notes\nHello.');
});

test('no vault configured → null; missing notes file → throws', () => {
  const { notesPath } = makeFixture();
  assert.equal(exportNotesToObsidian(notesPath, null), null);
  assert.throws(() => exportNotesToObsidian('/not/a/file.md', '/tmp'), /Notes file not found/);
});

/**
 * Provider-failure detection.
 *
 * The incident: on 2026-07-31 a 1h25m meeting transcribed cleanly, then
 * `claude -p` printed "You've hit your session limit · resets 3:20pm
 * (America/New_York)" to STDOUT and exited 0. Nothing rejected it, so the
 * notice became the summary — written to notes.md, marked complete, and
 * auto-filed into the ACM client folder in the vault.
 */

test('detectProviderFailure: catches the exact incident output', () => {
  const incident = "You've hit your session limit · resets 3:20pm (America/New_York)";
  const failure = detectProviderFailure(incident, 'Claude');

  assert.ok(failure, 'the limit notice must be rejected, not treated as a summary');
  assert.match(failure, /Claude/);
  assert.match(failure, /usage limit/i);
});

test('detectProviderFailure: catches other provider limit phrasings', () => {
  const notices = [
    'Usage limit reached. Try again later.',
    'You have hit your weekly limit',
    'Error: rate limit exceeded',
    'quota exceeded for this organisation',
    'Too many requests, please slow down',
    'Insufficient credit remaining on your account',
    'Upgrade your plan to continue',
    'Limit reached · resets at 9pm'
  ];

  for (const notice of notices) {
    assert.ok(detectProviderFailure(notice, 'Codex'), `should reject: ${notice}`);
  }
});

test('detectProviderFailure: catches auth failures at any length', () => {
  // Auth notices can arrive inside a long help dump, so they are NOT
  // length-gated — this preserves the pre-existing behaviour.
  const longAuthDump = 'Welcome to Claude.\n'.repeat(50) + '\nYou are not logged in. Please run /login';

  const failure = detectProviderFailure(longAuthDump, 'Claude');
  assert.ok(failure);
  assert.match(failure, /not authenticated/i);
});

test('detectProviderFailure: passes a real summary through', () => {
  const realNote = [
    '## Meeting Notes [31 July 2026]',
    '',
    '## Participants',
    '- Chris',
    '- Dominic',
    '',
    '## Key Takeaways',
    '- The partner portal MVP is mostly built.'
  ].join('\n');

  assert.equal(detectProviderFailure(realNote, 'Codex'), null);
});

test('detectProviderFailure: does NOT reject a meeting ABOUT rate limits', () => {
  // The false positive this guard must avoid: a genuine, useful summary of a
  // meeting that happens to discuss API rate limits and quotas.
  const noteAboutLimits = [
    '## Meeting Notes [31 July 2026]',
    '',
    '## Key Takeaways',
    '- We hit our usage limit on the vendor API twice this week.',
    '- Quota exceeded errors are spiking; too many requests during batch jobs.',
    '- Action: raise the rate limit with the vendor before the next release.'
  ].join('\n');

  assert.equal(
    detectProviderFailure(noteAboutLimits, 'Claude'),
    null,
    'markdown headings mark this as a real note despite the limit vocabulary'
  );
});

test('detectProviderFailure: ignores long headingless prose mentioning limits', () => {
  // Over the length gate but with no headings — still a real answer, so the
  // guard must not fire. Length alone is the discriminator here.
  const longProse = 'We discussed the rate limit at length. '.repeat(20);

  assert.ok(longProse.length > 400);
  assert.equal(detectProviderFailure(longProse, 'Claude'), null);
});

test('detectProviderFailure: handles empty and nullish output', () => {
  // Emptiness is handled by the callers' own "empty output" rejection; this
  // function must simply not throw or claim a false positive.
  assert.equal(detectProviderFailure('', 'Codex'), null);
  assert.equal(detectProviderFailure('   \n  ', 'Codex'), null);
  assert.equal(detectProviderFailure(null, 'Codex'), null);
  assert.equal(detectProviderFailure(undefined, 'Codex'), null);
});

test('detectProviderFailure: names the provider it was given', () => {
  const notice = 'You have hit your usage limit';

  assert.match(detectProviderFailure(notice, 'Codex'), /^Codex/);
  assert.match(detectProviderFailure(notice, 'Claude'), /^Claude/);
});

/**
 * Vault filename convention: `<CATEGORY> <Who|Topic> <MM.DD.YY>.md`.
 *
 * The old shape put the title first and allowed 120 chars, which produced
 * names like `ACM AI Portal Sync Chris, Dominic, Michael 07.31.26.md` — the
 * date, the field you actually scan by, was the first thing Obsidian's
 * sidebar truncated away.
 */

test('categoryForDestination: derived from the folder, never the content', () => {
  assert.equal(categoryForDestination('Projects/CXVentures/Clients/ACM/Meetings'), 'ACM');
  assert.equal(categoryForDestination('Projects/CXVentures/Ventures/Artist Advisory/Calls'), 'AA');
  assert.equal(categoryForDestination('Areas/Music/Sync'), 'SYNC', 'longest prefix wins over Areas/Music');
  assert.equal(categoryForDestination('Areas/Music/Production Calls'), 'MUS');
  assert.equal(categoryForDestination('Meetings'), '', 'the catch-all has no code of its own');
  assert.equal(categoryForDestination(undefined), '', 'flat root export');
});

test('categoryForContent: the catch-all earns a code from content, or none', () => {
  // CXV used to be the fallback for anything that matched nothing, which put
  // it on job interviews and seminars. Now every code has to be earned.
  assert.equal(categoryForContent('Orchid IQ sync', 'Dominic'), 'OIQ');
  assert.equal(categoryForContent('TeacherHero curriculum review', 'Alexis'), 'TH');
  assert.equal(categoryForContent('Acme Consulting portal', ''), 'ACM');
  assert.equal(categoryForContent('business-development pipeline', ''), 'BD');
  assert.equal(categoryForContent('CX Ventures planning', ''), 'CXV');
  assert.equal(categoryForContent('CX Ventures Orchid IQ sync', ''), 'OIQ', 'the specific code beats CXV');
  assert.equal(categoryForContent('Interview with Northwind', ''), '', 'no evidence, no prefix');
  assert.equal(categoryForContent('Fulton County Seminar', 'Bruce, Amy'), '');
  assert.equal(categoryForContent('Withdrawal', ''), '', 'whole-token: "oiq" inside a word is not a match');
});

test('resolveCategory: the folder wins, then the content, then nothing', () => {
  assert.equal(
    resolveCategory({ subdirectory: 'Projects/CXVentures/Clients/ACM/Meetings', title: 'Orchid IQ sync' }),
    'ACM',
    'a folder code is never overridden by content'
  );
  assert.equal(resolveCategory({ subdirectory: 'Meetings', title: 'Orchid IQ sync' }), 'OIQ');
  assert.equal(resolveCategory({ subdirectory: 'Meetings', title: 'Interview with Northwind' }), '');
  assert.equal(resolveCategory({}), '');
});

test('stripSelf: Chris is never named — he attends everything', () => {
  assert.deepEqual(stripSelf('Chris, Dominic'), ['Dominic']);
  assert.deepEqual(stripSelf('cxuser, Remi'), ['Remi']);
  assert.deepEqual(stripSelf('Chris'), [], 'self-only yields nothing');
  assert.deepEqual(stripSelf(''), []);
});

test('stripSelf: first names only, honorifics skipped, non-people rejected', () => {
  assert.deepEqual(stripSelf('Chris, Phillip Archer'), ['Phillip']);
  assert.deepEqual(stripSelf('Chris, Mr Lewis'), ['Lewis']);
  assert.deepEqual(stripSelf('Chris, Audience, Unknown speaker'), []);
  assert.deepEqual(stripSelf('Dominic, dominic, Chris'), ['Dominic'], 'deduplicated');
});

test('stripSelf: a roster of raw usernames names nobody, so the slot is dropped', () => {
  // This is the 82-char `Ai Skill Sharing zorro4, marlowe321, Phillip Archer,
  // cxuser, jules.s 07.22.26.md` case — 3 of 4 non-self entries are handles.
  assert.deepEqual(stripSelf('zorro4, marlowe321, Phillip Archer, cxuser, jules.s'), []);
  assert.deepEqual(
    stripSelf('Chris, Dominic, zorro4'),
    ['Dominic'],
    'a minority of usernames is filtered out, not fatal to the whole slot'
  );
});

test('formatPeople: one, two, then et al', () => {
  assert.equal(formatPeople(['Dominic']), 'Dominic');
  assert.equal(formatPeople(['Dominic', 'Michael']), 'Dominic, Michael');
  assert.equal(formatPeople(['Michael', 'Dominic', 'Amy']), 'Michael et al');
});

test('cleanCalendarTitle strips the invite prefix', () => {
  assert.equal(cleanCalendarTitle('Accepted: ACM Portal Sync'), 'ACM Portal Sync');
  assert.equal(cleanCalendarTitle('Invitation: Kickoff'), 'Kickoff');
  assert.equal(cleanCalendarTitle('ACM Portal Sync'), 'ACM Portal Sync');
});

test('dedupeTitleAgainstPeople: a title that only repeats the name contributes nothing', () => {
  assert.equal(dedupeTitleAgainstPeople('Call w Dominic', ['Dominic'], 'ACM'), '');
  assert.equal(dedupeTitleAgainstPeople('ACM', [], 'ACM'), '', 'the category is not repeated');
  assert.equal(dedupeTitleAgainstPeople('ACM Development', [], 'ACM'), 'Dev', 'topic alias applied');
  assert.equal(dedupeTitleAgainstPeople('business-development', [], 'CXV'), 'Biz Dev');
});

test('buildObsidianFilename: <CATEGORY> <Who> <MM.DD.YY>.md', () => {
  const name = buildObsidianFilename('/tmp/notes.md', {
    title: 'Call w Dominic',
    participants: 'Chris, Dominic',
    startTime: '2026-06-17T14:00:00',
    subdirectory: 'Projects/CXVentures/Clients/ACM/Meetings'
  });
  assert.equal(name, 'ACM Dominic 06.17.26.md');
});

test('buildObsidianFilename: two counterparts named, three become et al', () => {
  const base = {
    title: 'ACM AI Portal Sync',
    startTime: '2026-07-31T14:00:00',
    subdirectory: 'Projects/CXVentures/Clients/ACM/Meetings'
  };
  assert.equal(
    buildObsidianFilename('/tmp/notes.md', { ...base, participants: 'Chris, Dominic, Michael' }),
    'ACM Dominic, Michael 07.31.26.md'
  );
  assert.equal(
    buildObsidianFilename('/tmp/notes.md', { ...base, participants: 'Chris, Dominic, Michael, Amy' }),
    'ACM Dominic et al 07.31.26.md'
  );
});

test('buildObsidianFilename: an allowlisted title beats the counterpart name', () => {
  assert.equal(
    buildObsidianFilename('/tmp/notes.md', {
      title: 'Therapy',
      participants: 'Chris, Aaron',
      startTime: '2026-05-01T14:00:00',
      subdirectory: 'Areas/Personal'
    }),
    'PER Therapy 05.01.26.md'
  );
});

test('buildObsidianFilename: falls back to a topic when nobody is named', () => {
  assert.equal(
    buildObsidianFilename('/tmp/notes.md', {
      title: 'AI Skill Sharing',
      participants: 'zorro4, marlowe321, cxuser, jules.s',
      startTime: '2026-07-22T14:00:00',
      subdirectory: 'Meetings'
    }),
    'AI Skill Sharing 07.22.26.md'
  );
});

test('buildObsidianFilename: 40-char budget, and the date is never truncated', () => {
  const name = buildObsidianFilename('/tmp/notes.md', {
    title: 'Quarterly Partner Portal Architecture Review And Roadmap Planning',
    participants: 'Chris',
    startTime: '2026-07-31T14:00:00',
    subdirectory: 'Projects/CXVentures/Clients/ACM/Meetings'
  });
  assert.ok(name.length <= 40, `expected <= 40 chars, got ${name.length}: ${name}`);
  assert.ok(name.endsWith(' 07.31.26.md'), `date must survive: ${name}`);
  // The old ladder put the literal `Meeting` ahead of truncation, so this
  // exact input produced `ACM Meeting 07.31.26.md` — and this test passed.
  assert.equal(name, 'ACM Quarterly Partner Portal 07.31.26.md', 'the topic is truncated, not erased');
});

test('buildObsidianFilename: an over-long topic is cut, never replaced by "Meeting"', () => {
  // The real 2026-09-08 case: no roster (manual start), a title whose three
  // content words overflow the budget by four characters. It was filed as
  // `CXV Meeting 09.08.26.md` — a name that says nothing, for an interview.
  assert.equal(
    buildObsidianFilename('/tmp/notes.md', {
      title: 'Interview with Northwind | Christopher Robinson',
      participants: '',
      startTime: '2026-09-08T14:00:00',
      subdirectory: 'Meetings'
    }),
    'Interview Northwind 09.08.26.md'
  );
});

test('buildObsidianFilename: a single word wider than the room is sliced, not dropped', () => {
  // Whole-name truncation kept the category (it fit) and lost the middle,
  // producing `CXV 07.31.26.md`. Only the middle is ever cut now.
  const name = buildObsidianFilename('/tmp/notes.md', {
    title: 'Supercalifragilisticexpialidociousnessimoquantification',
    participants: '',
    startTime: '2026-07-31T14:00:00',
    subdirectory: 'Projects/CXVentures/Clients/ACM/Meetings'
  });
  assert.equal(name, 'ACM Supercalifragilisticexpi 07.31.26.md');
  assert.equal(name.length, 40);
});

test('buildObsidianFilename: no prefix when neither folder nor content earns one', () => {
  assert.equal(
    buildObsidianFilename('/tmp/notes.md', {
      title: 'Fulton County Seminar',
      participants: '',
      startTime: '2026-08-20T14:00:00',
      subdirectory: 'Meetings'
    }),
    'Fulton County Seminar 08.20.26.md'
  );
  assert.equal(
    buildObsidianFilename('/tmp/notes.md', {
      title: 'CX Ventures planning',
      participants: '',
      startTime: '2026-07-07T14:00:00',
      subdirectory: 'Meetings'
    }),
    'CXV Planning 07.07.26.md',
    'the words that earned the code are not repeated in the topic'
  );
});

test('buildObsidianFilename: never emits an empty middle slot', () => {
  const name = buildObsidianFilename('/tmp/notes.md', {
    title: 'Meeting',
    participants: 'Chris',
    startTime: '2026-07-31T14:00:00',
    subdirectory: 'Meetings'
  });
  assert.equal(name, 'Meeting 07.31.26.md');
});

test('restampCategoryForDestination: a refile re-derives the code', () => {
  // The filing prompt moves an Inbox note into a client folder; without the
  // re-stamp it would keep saying CXV forever.
  assert.equal(
    restampCategoryForDestination('CXV Dominic 06.17.26.md', 'Projects/CXVentures/Clients/ACM/Meetings'),
    'ACM Dominic 06.17.26.md'
  );
  assert.equal(
    restampCategoryForDestination('ACM Dominic 06.17.26 - transcript.md', 'Projects/CXVentures/Clients/QRS/Meetings'),
    'QRS Dominic 06.17.26 - transcript.md'
  );
  assert.equal(
    restampCategoryForDestination('Legacy Note 06.17.26.md', 'Areas/Music/Production Calls'),
    'MUS Legacy Note 06.17.26.md',
    'an unstamped legacy name gets a code prepended, not mangled'
  );
  assert.equal(
    restampCategoryForDestination('ACM Dominic 06.17.26.md', 'Projects/CXVentures/Clients/ACM/Meetings'),
    'ACM Dominic 06.17.26.md',
    'idempotent'
  );
});

test('restampCategoryForDestination: moving into the catch-all keeps a content code, drops a folder code', () => {
  assert.equal(
    restampCategoryForDestination('OIQ Dominic 07.07.26.md', 'Meetings'),
    'OIQ Dominic 07.07.26.md',
    'the content has not changed, so the code it earned survives'
  );
  assert.equal(
    restampCategoryForDestination('MUS Jam 07.07.26.md', 'Meetings'),
    'Jam 07.07.26.md',
    'a folder code describes a folder the note is no longer in'
  );
  assert.equal(
    restampCategoryForDestination('Interview Northwind 09.08.26.md', 'Inbox'),
    'Interview Northwind 09.08.26.md',
    'an unprefixed name stays unprefixed'
  );
});

/* ── model-selection refusals (gotcha #12, second instance) ───────────────── */

test('detectProviderFailure: catches a bad model name — verbatim CLI output', () => {
  // Captured 2026-08-05 from `claude -p --model bogus-model-y`, which EXITS 0.
  const actual =
    "There's an issue with the selected model (bogus-model-y). It may not exist " +
    'or you may not have access to it. Run --model to pick a different model.';
  const result = detectProviderFailure(actual, 'Claude');
  assert.ok(result, 'must be rejected, or it becomes the note');
  assert.match(result, /rejected the requested model/);
  assert.match(result, /Claude/);
});

test('detectProviderFailure: catches other model-refusal phrasings', () => {
  const samples = [
    'Error: model "gpt-9" does not exist',
    'Unknown model: llama9',
    'The model gpt-42 is not available on your plan.',
    'invalid model specified',
  ];
  for (const s of samples) {
    assert.ok(detectProviderFailure(s, 'Codex'), `should reject: ${s}`);
  }
});

test('detectProviderFailure: does NOT reject a real summary discussing models', () => {
  // The length + no-heading gate is what protects this.
  const realNote = [
    '## Summary',
    'We debated which model to standardise on. Ali noted that an unknown model',
    'string had been failing in staging, and that the model does not exist in',
    'the eu-west region yet.',
    '',
    '## Action Items',
    '- Ali to confirm model availability by Friday',
  ].join('\n');
  assert.strictEqual(detectProviderFailure(realNote, 'Claude'), null);
});
