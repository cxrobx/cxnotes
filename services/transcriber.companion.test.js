'use strict';

// The 2026-09-25 shape, end to end through transcribeSession: Meeting Copilot's
// shared transcript holds only the other side (its mic had died), while
// CXNotes' own mic.wav holds the owner's speech. Before the fix the companion
// transcript was used as-is and the note lost one side of the call.
//
// HOME is pointed at a temp dir BEFORE the modules load: companionTranscript
// resolves ~/.meeting-shared at require time. node --test runs each file in its
// own process, so this cannot leak into other tests.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cxnotes-companion-'));
process.env.HOME = home;

const { transcribeSession } = require('./transcriber');

const SR = 16000;
const OFFSET = 30; // CXNotes started recording 30 s after Meeting Copilot
const THEIR_TURNS = [
  [0, 38], [47, 61], [70, 96], [104, 117], [127, 160], [168, 181], [190, 222], [231, 240]
];
const OWN_TURNS_COMPANION = [[39.5, 45], [62.5, 68.5], [97, 102.5], [118, 125.5], [161.5, 166.5], [182, 188.5], [223, 229.5]];

function writeWav(file, seconds, loudAt) {
  const n = Math.round(seconds * SR);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + n * 2, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(n * 2, 40);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // A quiet room everywhere, speech-level tone inside the loud spans.
    const v = loudAt(t) ? Math.round(6000 * Math.sin(i / 7)) : ((i * 7919) % 41) - 20;
    data.writeInt16LE(v, i * 2);
  }
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

test('companion without a mic side: own mic transcription is merged in on the companion clock', async () => {
  const startedAt = new Date('2026-09-25T14:01:16.555Z');
  const shared = path.join(home, '.meeting-shared');
  fs.mkdirSync(shared, { recursive: true });
  const transcriptFile = path.join(shared, 'live-transcript.jsonl');
  fs.writeFileSync(transcriptFile, THEIR_TURNS.map(([a, b], i) => JSON.stringify({
    id: `m${i}`, text: `They said ${i}`, source: 'meeting', label: '[Meeting]', timestamp: a, duration: b - a, wordCount: 3
  })).join('\n') + '\n');
  fs.writeFileSync(path.join(shared, 'active-session.json'), JSON.stringify({
    app: 'meeting-copilot', pid: process.pid, transcriptFile, startedAt: startedAt.toISOString()
  }));

  const outputDir = path.join(home, 'out');
  const sessionDir = path.join(outputDir, 'recordings', 's1_session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const own = OWN_TURNS_COMPANION.map(([a, b]) => [a - OFFSET, b - OFFSET]);
  writeWav(path.join(sessionDir, 'mic.wav'), 215, (t) => own.some(([a, b]) => t >= a && t < b));
  writeWav(path.join(sessionDir, 'system.wav'), 5, () => true);
  fs.writeFileSync(path.join(sessionDir, 'manifest.json'), JSON.stringify({
    sessionId: 's1',
    startTime: new Date(startedAt.getTime() + OFFSET * 1000).toISOString(),
    tracks: {
      system: { file: 'system.wav', label: 'Sean' },
      mic: { file: 'mic.wav', label: 'Chris', silent: false, silenceTrimmed: { trimmed: true, edge: 'trailing', leadingSec: 0, savedBytes: 0 } }
    }
  }));

  // Stands in for Parakeet: one line per own turn, on the mic.wav clock.
  const transcribeImpl = async (wav, _out, _cb, prefix) => {
    const lines = ['start,end,text', ...own.map(([a, b], i) => `${a * 1000},${b * 1000},"I said ${i}"`)];
    fs.writeFileSync(`${prefix}.csv`, lines.join('\n') + '\n');
    return `${prefix}.csv`;
  };

  const result = await transcribeSession(sessionDir, outputDir, null, { useSharedTranscript: true, transcribeImpl });
  const merged = fs.readFileSync(result.mergedTranscript, 'utf-8');

  assert.match(merged, /Chris: I said 0/, 'the owner\'s side is in the transcript');
  assert.match(merged, /Sean: They said 0/, 'the other side is still the companion\'s');
  // "I said 0" was spoken 39.5 s into the companion's clock.
  const line = merged.split('\n').find((l) => l.includes('I said 0'));
  assert.match(line, /00:00:39|00:00:40|00:39|00:40/, line);

  const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, 'manifest.json'), 'utf-8'));
  assert.strictEqual(manifest.processing.transcription.source, 'companion:meeting-copilot+own-mic');
  assert.strictEqual(manifest.processing.transcription.companionCheck.decision, 'companion+own-mic');
  assert.ok(Math.abs(manifest.processing.transcription.companionCheck.offsetSec - OFFSET) <= 1);
});
