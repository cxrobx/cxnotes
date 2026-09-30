# Environment & Setup

## Prerequisites

| Dependency | Purpose | Install |
|------------|---------|---------|
| macOS 13+ | ScreenCaptureKit requires it | — |
| Node.js | Electron runtime | `brew install node` |
| sox | Microphone capture | `brew install sox` |
| Screen Recording grant | **System audio capture** (ScreenCaptureKit) | Granted on first record |
| Xcode CLT (`swift`) | Builds `sck-audio-capture` + `calendar-helper` | `xcode-select --install` |
| whisper.cpp | Local speech-to-text | Built via `setup.sh` |
| Codex CLI | Local note generation CLI | `npm install -g @anthropic-ai/codex` |

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url>
cd cxnotes
npm install

# 2. Install system dependencies
./setup.sh

# 3. setup.sh builds the native helpers; this is the equivalent if you skip it.
#    sck-audio-capture IS the system-audio path — `npm start` does not build it.
npm run build:native

# 4. Download whisper model (if setup.sh didn't)
# Place ggml-base.en.bin in models/

# 5. Install Codex CLI
npm install -g @anthropic-ai/codex

# 6. Launch
npm start
```

## System Audio Capture

System audio — the other side of a call — is captured by **ScreenCaptureKit** via
the `native/sck-audio-capture` Swift helper. It needs **no virtual audio device**
and no change to your output device. The only prerequisite is the macOS
**Screen Recording** grant, which the app prompts for on first record
(System Settings → Privacy & Security → Screen Recording).

Check the state at any time:

```bash
native/sck-audio-capture/.build/release/sck-audio-capture --check
# STATUS: ScreenCaptureKit available and permitted
```

`resolveSystemCaptureMethod()` in `services/recorder.js` is the whole decision,
and it has exactly one success case:

| Condition | Result |
|---|---|
| SCK available **and** permitted | `sck` — records |
| Helper binary not found | Throws: *build it with `npm run build:native`* |
| Grant refused | Throws: *grant Screen Recording, then restart* |
| SCK unavailable | Throws: *requires macOS 13 or later* |

### There is no fallback, deliberately

A sox+BlackHole fallback used to sit behind this. It was removed because it
could not fail loudly. BlackHole is a virtual **cable**: unless system output is
routed into it via a Multi-Output Device it carries nothing, so the fallback
wrote a correctly-sized, digitally-silent WAV and you found out after the
meeting. Across 58 recorded sessions it engaged **once**, and that session was a
total loss (`2026-06-16_21-06-11` — no transcript, no notes).

A refusal before you hit record costs seconds. A silent recording costs the
meeting. So the failure modes above are hard errors with one specific fix each,
rather than a detour.

The same reasoning governs the mid-flight case. If SCK starts but delivers no
bytes within `SCK_START_TIMEOUT_MS` (8s), the session **warns and keeps
recording** — it no longer switches methods. The microphone track is still
worth having, a late SCK can still recover, and `sckSilentWarning()` names the
live output device so the warning is diagnosable. The menu-bar panel also shows
a red `stalled` chip per track while the meeting is still running.

See gotcha #2 and invariant #1.

## Build

```bash
npm run build    # Produces dmg + zip in dist/
```

Build configuration is in `package.json` under `"build"`. The app is signed with hardened runtime and includes microphone entitlements via `entitlements.mac.plist`.

## Re-summarise Existing Recordings

```bash
npm run summaryonly    # Runs summarise-only.js on existing session directories
```
