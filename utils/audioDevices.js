const { execSync, spawnSync } = require('child_process');
const os = require('os');

/*
 * `findBlackHoleDevice()` used to live here, backing a sox+BlackHole fallback
 * for system audio. Both are gone: BlackHole is a virtual cable, so unless the
 * user routed system output through a Multi-Output Device it carried nothing,
 * and the fallback wrote a correctly-sized silent WAV instead of failing. See
 * `resolveSystemCaptureMethod()` in services/recorder.js — ScreenCaptureKit is
 * now the only system-audio path, and its absence is an error, not a detour.
 */

/** Delay before the second enumeration attempt when the first finds nothing. */
const ENUMERATION_RETRY_DELAY_MS = 750;

/** Synchronous sleep — enumeration callers are synchronous end to end. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * List all available audio input devices with metadata
 *
 * Parses system_profiler SPAudioDataType output to find devices with input channels.
 *
 * A transient audio-graph state (wake from sleep, a coreaudiod restart,
 * Continuity device churn) can make system_profiler momentarily report no
 * devices at all. A Mac always has at least its built-in microphone, so an
 * empty list is treated as a blip: retry once after a short pause rather
 * than letting a single bad read report the microphone as missing.
 *
 * @param {{retryDelayMs?: number, _exec?: Function, _sleep?: Function}} [opts] - test injection points
 * @returns {Array<{name: string, channels: number, sampleRate: string, transport: string, isDefault: boolean}>}
 */
function listInputDevices({ retryDelayMs = ENUMERATION_RETRY_DELAY_MS, _exec = execSync, _sleep = sleepSync } = {}) {
  const first = listInputDevicesOnce(_exec);
  if (first.length > 0) return first;

  console.warn(`No audio input devices found — retrying once in ${retryDelayMs}ms (transient enumeration blip?)`);
  _sleep(retryDelayMs);
  return listInputDevicesOnce(_exec);
}

/** Single enumeration attempt: run system_profiler and parse its output. */
function listInputDevicesOnce(exec) {
  try {
    const output = exec('system_profiler SPAudioDataType 2>&1', { encoding: 'utf-8' });

    const devices = [];

    let currentDevice = null;
    let hasInputChannels = false;
    let inputChannels = 0;
    let sampleRate = '';
    let transport = '';
    let isDefault = false;

    const lines = output.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Device name line: indented by 8 spaces, followed by colon
      // e.g. "        MacBook Pro Microphone:"
      const deviceMatch = line.match(/^        (\S.+?):\s*$/);
      if (deviceMatch) {
        // Save previous device if it had input channels
        if (currentDevice && hasInputChannels && inputChannels > 0) {
          devices.push({
            name: currentDevice,
            channels: inputChannels,
            sampleRate: sampleRate,
            transport: transport,
            isDefault: isDefault
          });
        }

        currentDevice = deviceMatch[1];
        hasInputChannels = false;
        inputChannels = 0;
        sampleRate = '';
        transport = '';
        isDefault = false;
        continue;
      }

      if (!currentDevice) continue;

      // Parse device properties (indented by 10+ spaces)
      // e.g. "          Input Channels: 1"
      const propMatch = line.match(/^\s{10,}(.+?):\s+(.+)$/);
      if (propMatch) {
        const key = propMatch[1].trim().toLowerCase();
        const value = propMatch[2].trim();

        if (key === 'input channels') {
          hasInputChannels = true;
          inputChannels = parseInt(value, 10) || 0;
        } else if (key === 'current samplerate') {
          sampleRate = value;
        } else if (key === 'transport') {
          transport = value;
        } else if (key === 'default input device') {
          isDefault = value.toLowerCase() === 'yes';
        }
      }
    }

    // Don't forget the last device
    if (currentDevice && hasInputChannels && inputChannels > 0) {
      devices.push({
        name: currentDevice,
        channels: inputChannels,
        sampleRate: sampleRate,
        transport: transport,
        isDefault: isDefault
      });
    }

    return devices;

  } catch (err) {
    console.error('Failed to list input devices:', err.message);
    return [];
  }
}

/**
 * Find the default microphone device
 *
 * @returns {{name: string, channels: number, sampleRate: string}|null}
 */
function findDefaultMicrophone() {
  const devices = listInputDevices();

  if (devices.length === 0) return null;

  // First try: device marked as default
  const defaultDevice = devices.find(d => d.isDefault);
  if (defaultDevice) return defaultDevice;

  // Fallback: first non-BlackHole, non-virtual input device
  const physicalDevice = devices.find(d =>
    !d.name.toLowerCase().includes('blackhole') &&
    !d.name.toLowerCase().includes('virtual') &&
    !d.name.toLowerCase().includes('aggregate')
  );
  if (physicalDevice) return physicalDevice;

  // Last resort: first device that isn't BlackHole
  const nonBlackhole = devices.find(d => !d.name.toLowerCase().includes('blackhole'));
  return nonBlackhole || devices[0];
}

/**
 * Find the name of the current default *output* device.
 *
 * Used to make `sckSilentWarning()` diagnosable. A silent system track means
 * something different depending on where audio was going: a physical output
 * points at SCK itself being starved or wedged (gotcha #5), while a virtual or
 * aggregate output suggests there was no real signal on the bus to capture.
 *
 * Note: system_profiler does not list an aggregate/multi-output device's
 * sub-devices, so this reports the name only — it deliberately does not try to
 * infer anything about what sits behind that device.
 *
 * @param {object} [deps]
 * @param {Function} [deps._exec] - Injected exec (for tests)
 * @returns {string|null} Device name, or null if it could not be determined
 */
function findDefaultOutputDevice({ _exec = execSync } = {}) {
  try {
    const output = _exec('system_profiler SPAudioDataType 2>&1', { encoding: 'utf-8' });
    const lines = output.split('\n');

    let currentDevice = null;

    for (const line of lines) {
      // Device name line: indented by exactly 8 spaces (see gotcha #1)
      const deviceMatch = line.match(/^        (\S.+?):\s*$/);
      if (deviceMatch) {
        currentDevice = deviceMatch[1];
        continue;
      }

      if (!currentDevice) continue;

      // Properties are indented 10+ spaces
      const propMatch = line.match(/^\s{10,}(.+?):\s+(.+)$/);
      if (propMatch) {
        const key = propMatch[1].trim().toLowerCase();
        const value = propMatch[2].trim().toLowerCase();
        if (key === 'default output device' && value === 'yes') {
          return currentDevice;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Verify that a named input device is available
 *
 * @param {string} deviceName - The device name to verify
 * @returns {boolean} True if device is found in input device list
 */
function verifyInputDevice(deviceName) {
  const devices = listInputDevices();
  return devices.some(d => d.name === deviceName);
}

/**
 * Check if ScreenCaptureKit is available on this system
 *
 * Requires macOS 13.0+ (Ventura). Optionally checks permission status
 * by running the sck-audio-capture binary with --check flag.
 *
 * @param {string} [sckBinaryPath] - Path to sck-audio-capture binary
 * @returns {{available: boolean, permitted: boolean|null, reason?: string}}
 */
function checkSckAvailable(sckBinaryPath) {
  // Check macOS version >= 13
  const release = os.release(); // e.g. "22.0.0" for macOS 13.0
  const majorVersion = parseInt(release.split('.')[0], 10);
  // Darwin 22.x = macOS 13 (Ventura)
  if (majorVersion < 22) {
    return { available: false, permitted: null, reason: 'macOS 13.0+ required for ScreenCaptureKit' };
  }

  // Check binary exists
  if (!sckBinaryPath) {
    return { available: false, permitted: null, reason: 'SCK binary path not provided' };
  }

  const fs = require('fs');
  if (!fs.existsSync(sckBinaryPath)) {
    return { available: false, permitted: null, reason: 'SCK binary not found' };
  }

  // Check permission by running --check
  try {
    const result = spawnSync(sckBinaryPath, ['--check'], {
      timeout: 10000,
      encoding: 'utf-8'
    });

    if (result.status === 0) {
      return { available: true, permitted: true };
    } else if (result.status === 2) {
      return { available: true, permitted: false, reason: 'Screen Recording permission not granted' };
    } else {
      const stderr = (result.stderr || '').trim();
      return { available: false, permitted: null, reason: stderr || 'SCK check failed' };
    }
  } catch (err) {
    return { available: false, permitted: null, reason: `SCK check error: ${err.message}` };
  }
}

module.exports = {
  listInputDevices,
  findDefaultMicrophone,
  findDefaultOutputDevice,
  verifyInputDevice,
  checkSckAvailable
};
