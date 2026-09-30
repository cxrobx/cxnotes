const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveBinaryCached } = require('./binaries');
const { DEFAULT_SIGNAL_THRESHOLD } = require('../services/signalWatcher');

/**
 * Peak at or below which a track counts as having recorded nothing.
 *
 * Imported rather than redeclared: the live watcher and the processing-time
 * scan must agree on what silence is, or a track can be judged dead while it is
 * happening and fine afterwards (or the reverse).
 */
const SILENCE_PEAK_THRESHOLD = DEFAULT_SIGNAL_THRESHOLD;

/**
 * Trim TRAILING silence from a WAV file using sox.
 *
 * Trailing only, never leading (2026-09-25). A leading trim moves sample 0 of
 * the file away from the moment the recording started, so every offset in the
 * file stops meaning "seconds since start". The two tracks were each trimmed by
 * their own amount, and the result recorded only the TOTAL bytes removed, so
 * nothing could put them back on one clock: the 09-25 mic track lost 43.4 s off
 * its head and 59.5 s off its tail, reported as one 102.9 s figure, and lining
 * it up against Meeting Copilot's transcript needed a hand-fitted correction.
 * The tail can go freely; nothing after it has an offset to preserve.
 *
 * Gracefully degrades — resolves (never rejects) so the pipeline
 * continues with the untrimmed file on any error.
 *
 * @param {string} inputFile - Absolute path to the WAV file
 * @param {object} [options]
 * @param {number} [options.threshold=0.1] - Silence threshold (% amplitude)
 * @param {number} [options.minDuration=0.5] - Minimum silence duration (seconds)
 * @param {number} [options.minOutputBytes=1024] - Files smaller than this after trim are considered all-silence
 * @param {Function} [options.registerProcess] - Optional callback to register spawned process for cleanup
 * @returns {Promise<{trimmed: boolean, allSilence?: boolean, originalSize?: number, trimmedSize?: number, savedBytes?: number, edge?: 'trailing', leadingSec?: 0}>}
 */
function trimSilence(inputFile, options = {}) {
  const {
    threshold = 0.1,
    minDuration = 0.5,
    minOutputBytes = 1024,
    registerProcess
  } = options;

  return new Promise((resolve) => {
    // Verify input file exists
    if (!fs.existsSync(inputFile)) {
      console.warn(`trimSilence: input file not found: ${inputFile}`);
      resolve({ trimmed: false });
      return;
    }

    const originalSize = fs.statSync(inputFile).size;
    const dir = path.dirname(inputFile);
    const ext = path.extname(inputFile);
    const base = path.basename(inputFile, ext);
    const tmpFile = path.join(dir, `${base}_trimmed${ext}`);

    const args = trimSilenceArgs(inputFile, tmpFile, { threshold, minDuration });

    // Absolute path — a Dock-launched app has no Homebrew on its PATH, so the
    // bare name ENOENTs (invariant #20). This function degrades gracefully, so
    // the bug showed up not as an error but as silence never being trimmed.
    const soxPath = resolveBinaryCached('sox');
    if (!soxPath) {
      console.warn('[audioProcessing] sox not found — skipping silence trim');
      resolve({ trimmed: false, reason: 'sox-not-found' });
      return;
    }

    const proc = spawn(soxPath, args);

    if (registerProcess) {
      registerProcess(proc);
    }

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('error', (err) => {
      console.warn(`trimSilence: sox spawn error: ${err.message}`);
      // Clean up temp file if it was partially written
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      resolve({ trimmed: false });
    });

    proc.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`trimSilence: sox exited with code ${code}: ${stderr.trim()}`);
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        resolve({ trimmed: false });
        return;
      }

      try {
        const trimmedSize = fs.statSync(tmpFile).size;

        // All-silence guard: if output is too small, keep original
        if (trimmedSize < minOutputBytes) {
          console.log(`trimSilence: output too small (${trimmedSize} bytes) — likely all silence, keeping original`);
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
          resolve({ trimmed: false, allSilence: true, originalSize });
          return;
        }

        // Replace original with trimmed version
        fs.renameSync(tmpFile, inputFile);

        const savedBytes = originalSize - trimmedSize;
        const savedPct = ((savedBytes / originalSize) * 100).toFixed(1);
        console.log(`trimSilence: ${path.basename(inputFile)} — ${savedPct}% trimmed (${(savedBytes / 1024).toFixed(0)} KB saved)`);

        resolve({
          trimmed: true,
          originalSize,
          trimmedSize,
          savedBytes,
          // Recorded so a reader never has to guess which end the bytes came
          // from: sample 0 is still the moment the recording started.
          edge: 'trailing',
          leadingSec: 0
        });
      } catch (err) {
        console.warn(`trimSilence: post-processing error: ${err.message}`);
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        resolve({ trimmed: false });
      }
    });
  });
}

/**
 * sox arguments for a trailing-only trim: reverse, cut the (now leading)
 * silence, reverse back. There is deliberately no `silence` effect before the
 * first `reverse` — that would trim the head (see `trimSilence`).
 */
function trimSilenceArgs(inputFile, outputFile, { threshold = 0.1, minDuration = 0.5 } = {}) {
  return [
    inputFile,
    '-r', '16000', '-b', '16', '-c', '1',
    outputFile,
    'reverse',
    'silence', '1', `${minDuration}`, `${threshold}%`,
    'reverse'
  ];
}

/**
 * Repair a WAV file whose RIFF/data size headers are zero (e.g. from an
 * unclean SCK shutdown).  Calculates the correct sizes from the actual
 * file length and patches the header in-place.
 *
 * @param {string} wavPath - Absolute path to the WAV file
 * @returns {boolean} true if the header was repaired, false if no repair was needed
 */
function repairWavHeader(wavPath) {
  if (!fs.existsSync(wavPath)) return false;

  const fd = fs.openSync(wavPath, 'r+');
  try {
    const header = Buffer.alloc(44);
    const bytesRead = fs.readSync(fd, header, 0, 44, 0);
    if (bytesRead < 44) return false;

    // Verify this is a RIFF/WAVE file
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      return false;
    }

    const riffSize = header.readUInt32LE(4);
    const dataSize = header.readUInt32LE(40);

    // Only repair if both size fields are zero (placeholder header)
    if (riffSize !== 0 || dataSize !== 0) return false;

    const fileSize = fs.fstatSync(fd).size;
    const actualDataSize = fileSize - 44;
    if (actualDataSize <= 0) return false;

    // Patch RIFF chunk size (offset 4) = fileSize - 8
    const buf4 = Buffer.alloc(4);
    buf4.writeUInt32LE(fileSize - 8, 0);
    fs.writeSync(fd, buf4, 0, 4, 4);

    // Patch data chunk size (offset 40)
    buf4.writeUInt32LE(actualDataSize, 0);
    fs.writeSync(fd, buf4, 0, 4, 40);

    console.log(`WAV header repaired: ${path.basename(wavPath)} (data size: ${(actualDataSize / (1024 * 1024)).toFixed(2)} MB)`);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Scan a whole WAV and report the largest absolute sample in it.
 *
 * The definitive answer to "did this track record anything", asked once at
 * processing time over every sample rather than sampled from a poll. Nothing
 * else in the pipeline asks it: `trimSilence` infers all-silence from how small
 * sox made the output, which is a proxy, and it already computed that inference
 * and threw it away in a `console.warn`.
 *
 * Reads in chunks so a two-hour meeting (~230 MB) does not land in memory at
 * once, and stops early on the first real sample — a healthy track exits after
 * a few kilobytes, so the full scan only ever runs on the tracks that are
 * genuinely silent, which are the ones worth being sure about.
 *
 * The threshold is NOT zero, and that matters. A capture that is dead can still
 * emit a stray least-significant bit — an observed run produced a whole track
 * whose peak was exactly **1** (≈ -90 dBFS, inaudible by any measure), and with
 * a zero threshold that single sample marked the track as holding audio. The
 * warning header and the badge both hang off this call, so a zero threshold
 * silently disarms the last line of defence. The default matches
 * `signalWatcher.DEFAULT_SIGNAL_THRESHOLD` so the live judgement and this one
 * cannot disagree about what silence is.
 *
 * **`peak` is exact only when `silent` is true.** The scan stops at the first
 * sample that settles the question, so on a track that holds audio `peak` is
 * merely the first proof found, not the loudest moment in the meeting — do not
 * read it as a level measurement. When the answer is "silent" the whole file has
 * been read and `peak` is the true maximum, which is the case anyone
 * investigating actually cares about.
 *
 * @param {string} wavPath
 * @param {object} [options]
 * @param {number} [options.threshold=4] - Peak at or below this counts as silent
 * @returns {{peak: number, samples: number, silent: boolean}|null} null if unreadable
 */
function measureWavPeak(wavPath, { threshold = SILENCE_PEAK_THRESHOLD } = {}) {
  const HEADER_BYTES = 44;
  const CHUNK_BYTES = 1024 * 1024;

  let fd;
  try {
    fd = fs.openSync(wavPath, 'r');
    const fileSize = fs.fstatSync(fd).size;
    const dataBytes = fileSize - HEADER_BYTES;
    if (dataBytes <= 0) return { peak: 0, samples: 0, silent: true };

    const buffer = Buffer.alloc(CHUNK_BYTES);
    let offset = HEADER_BYTES;
    let peak = 0;
    let samples = 0;

    while (offset < fileSize) {
      const want = Math.min(CHUNK_BYTES, fileSize - offset) & ~1;
      if (want <= 0) break;

      const read = fs.readSync(fd, buffer, 0, want, offset);
      if (read <= 0) break;
      offset += read;

      let i = 0;
      for (; i + 1 < read; i += 2) {
        const sample = Math.abs(buffer.readInt16LE(i));
        if (sample > peak) peak = sample;
        // Stop at the FIRST audible sample, not at the end of the chunk. This
        // runs on every stop, and the difference on a two-hour meeting is a
        // couple of kilobytes against ~230 MB.
        if (peak > threshold) break;
      }
      samples += Math.floor(i / 2);

      if (peak > threshold) break; // proven to hold audio; no need to read on
    }

    return { peak, samples, silent: peak <= threshold };
  } catch (err) {
    console.warn(`measureWavPeak: could not read ${wavPath}: ${err.message}`);
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

module.exports = { trimSilence, trimSilenceArgs, repairWavHeader, measureWavPeak, SILENCE_PEAK_THRESHOLD };
