const fs = require('fs');

/**
 * Audio Level Monitor
 *
 * Polls WAV files being written and computes RMS audio levels.
 * Works by reading the trailing bytes of each file and computing
 * a dB-scaled level from 16-bit PCM data.
 *
 * No changes needed to the recording processes — we just read
 * the files they're writing.
 */
class LevelMonitor {
  /**
   * @param {Function} callback - Called with { trackName: level (0-1), ... }
   * @param {number} [intervalMs=150] - Polling interval in ms
   */
  constructor(callback, intervalMs = 150) {
    this.callback = callback;
    this.intervalMs = intervalMs;
    this.tracks = {};
    this.interval = null;
  }

  /**
   * Register a WAV file to monitor
   *
   * @param {string} name - Track identifier (e.g. 'system', 'mic')
   * @param {string} filePath - Path to the WAV file being written
   */
  addTrack(name, filePath) {
    this.tracks[name] = { path: filePath, peakOffset: null };
  }

  /**
   * Point an existing track at a new file, preserving its identity.
   *
   * Used when system capture restarts onto a fresh part file: the track keeps
   * its name (so levels, health and the panel carry on referring to the same
   * thing) but the peak scan has to begin again from the new file's header
   * rather than from an offset that belonged to the old one.
   *
   * @param {string} name
   * @param {string} filePath
   */
  retargetTrack(name, filePath) {
    if (!this.tracks[name]) return;
    this.tracks[name] = { path: filePath, peakOffset: null };
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this._poll(), this.intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.tracks = {};
  }

  /** @private */
  _poll() {
    const levels = {};
    const peaks = {};

    for (const [name, track] of Object.entries(this.tracks)) {
      levels[name] = this._readLevel(track.path);
      peaks[name] = this._readPeak(track);
    }

    this.callback(levels, peaks);
  }

  /**
   * Raw integer peak of everything written since the last peak read.
   *
   * Separate from `_readLevel` because the two answer different questions and
   * only one of them can answer "is this track digitally silent". `_readLevel`
   * maps RMS to dB and clamps anything at or below -60 dBFS to `0`, so a `0`
   * there means "quieter than -60 dB" — which is also what a quiet room, a
   * muted mic and a completely dead capture all look like. This returns the
   * largest absolute 16-bit sample value seen, so `0` means every sample was
   * exactly zero, and nothing else does.
   *
   * Tri-state on purpose: `null` is "could not read", never "silent". Conflating
   * an unreadable file with a silent one is the trap invariant #10 exists to
   * document, and here it would be worse — it would report a healthy capture as
   * dead and restart it.
   *
   * Reads from where the last read finished rather than a fixed trailing window,
   * so no samples are skipped between polls. Capped so that a long stall
   * followed by a flush cannot read a hundred megabytes in one tick.
   *
   * @param {{path: string, peakOffset: ?number}} track - mutated: offset advances
   * @returns {number|null} Peak absolute sample (0-32768), or null if unreadable
   * @private
   */
  _readPeak(track) {
    const WAV_HEADER = 44;
    const MAX_SCAN_BYTES = 1024 * 1024;

    let fd;
    try {
      fd = fs.openSync(track.path, 'r');
      const fileSize = fs.fstatSync(fd).size;

      // First sight of this file: start at the end of the header. A track is
      // never judged on bytes written before the monitor was watching it.
      if (track.peakOffset == null) track.peakOffset = WAV_HEADER;

      // The file was replaced or truncated under us — rewind rather than read
      // from an offset past the end and conclude silence from zero bytes.
      if (track.peakOffset > fileSize) track.peakOffset = WAV_HEADER;

      const available = fileSize - track.peakOffset;
      if (available <= 0) return null; // nothing new — no evidence either way

      const readLength = Math.min(available, MAX_SCAN_BYTES) & ~1; // whole samples
      if (readLength <= 0) return null;

      const buffer = Buffer.alloc(readLength);
      fs.readSync(fd, buffer, 0, readLength, track.peakOffset);
      track.peakOffset += readLength;

      let peak = 0;
      for (let i = 0; i < readLength; i += 2) {
        const sample = Math.abs(buffer.readInt16LE(i));
        if (sample > peak) peak = sample;
      }
      return peak;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Read the last ~100ms of a 16kHz 16-bit mono WAV and compute RMS level.
   *
   * @param {string} filePath
   * @returns {number} Level between 0 and 1
   * @private
   */
  _readLevel(filePath) {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const stats = fs.fstatSync(fd);
      const fileSize = stats.size;

      // 100ms of 16kHz 16-bit mono = 3200 bytes
      const WAV_HEADER = 44;
      const chunkSize = 3200;
      const dataSize = fileSize - WAV_HEADER;

      if (dataSize <= 0) {
        return 0;
      }

      const readLength = Math.min(chunkSize, dataSize);
      const readStart = WAV_HEADER + dataSize - readLength;

      const buffer = Buffer.alloc(readLength);
      fs.readSync(fd, buffer, 0, readLength, readStart);

      // Compute RMS from 16-bit signed PCM samples
      let sumSquares = 0;
      const sampleCount = Math.floor(readLength / 2);

      if (sampleCount === 0) return 0;

      for (let i = 0; i < sampleCount; i++) {
        const sample = buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
      }

      const rms = Math.sqrt(sumSquares / sampleCount);

      // Convert to dB, map -60dB..0dB → 0..1
      const db = 20 * Math.log10(Math.max(rms, 0.000001));
      return Math.max(0, Math.min(1, (db + 60) / 60));
    } catch {
      return 0;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
}

module.exports = { LevelMonitor };
