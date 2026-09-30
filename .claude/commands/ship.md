---
description: Build, package & install the CXNotes Electron app
---

# Ship CXNotes

Rebuild the Electron menu-bar app (with its native Swift helpers), package a DMG, and install to
/Applications. Standing rule: always rebuild before relaunching after code changes.

**Working directory: the repository root.**

⚠️ Not `~/Projects/notes4chris`. That is the archived pre-2026-08-07 tree (`cxrobx/cxnotes-legacy`),
it still contains a complete, buildable copy of this app, and this file pointed at it until
2026-08-17. Building there succeeds — it just silently ships code from before the repo was rebuilt.
Confirm you are in the right tree before step 1; `git remote -v` should say `cxrobx/cxnotes`.

`npm run build` runs `prebuild` → `build:native` first, which `swift build -c release` + codesigns
every native helper (`sck-audio-capture`, `sck-slide-capture`, `call-audio-tap`, `calendar-helper`), then `electron-builder` produces the
DMG + zip in `dist/`. Requires Xcode/Swift toolchain and a prior `whisper.cpp` build (`./setup.sh`).

## Steps

Run in order. Stop and report if any step fails.

0. **Check nothing is recording.** Step 1 kills the app, and killing it mid-meeting destroys a
   recording that cannot be taken again. This is the one step with an irreversible failure mode.
   ```bash
   ps aux | grep -v grep | grep -E 'sox -t coreaudio|sck-audio-capture|call-audio-tap'   # expect NO output
   ```
   Any output means a recording is in flight — **stop and ask** before going further.

1. **Quit the running app + clear orphaned recorders** (gotcha #4 — orphaned `sox` starves the mic):
   ```bash
   osascript -e 'tell application "CXNotes" to quit' 2>/dev/null || true
   sleep 2
   pkill -f "CXNotes.app/Contents/MacOS/CXNotes" 2>/dev/null || true
   pkill -f "electron \." 2>/dev/null || true
   pkill -9 sox 2>/dev/null || true
   sleep 1
   ```
   Ask it to quit before killing it: `before-quit` is what drains the app's child processes
   (invariant #21), and a SIGTERM that skips it re-creates the orphans step 0 just checked for.
   The patterns are anchored to the real binary paths on purpose — a bare `pkill -f CXNotes`
   matches the full command line of *any* process, including the shell running this command.

2. **Build + package** (clean `dist/` first so the DMG is fresh):
   ```bash
   rm -rf dist/ && npm run build
   ```

3. **Install the built app** — derive the version so the DMG/volume names stay correct across bumps:
   ```bash
   VERSION="$(node -p "require('./package.json').version")"
   DMG="dist/CXNotes-${VERSION}-arm64.dmg"
   VOL="/Volumes/CXNotes ${VERSION}-arm64"
   hdiutil attach "$DMG" -nobrowse -quiet
   rm -rf "/Applications/CXNotes.app"
   cp -R "${VOL}/CXNotes.app" /Applications/
   hdiutil detach "$VOL" -quiet
   ```

4. **Check what actually got packaged.** The `build.files` glob is `**/*` with a short exclusion
   list, so anything new at the repo root ships unless it is named there.
   ```bash
   ls -lh /Applications/CXNotes.app/Contents/Resources/app.asar | awk '{print $5}'   # expect ~14M
   npx --yes asar list /Applications/CXNotes.app/Contents/Resources/app.asar | grep -E '<a module you just changed>'
   ```
   A figure far above ~14 MB means something large was swept in. Found 2026-08-17: `.claude/worktrees/`
   (a 548 MB checkout of an old branch) was being packaged into every build — **587 MB of asar, 93%
   of it junk**, plus a stale duplicate of the whole source tree inside the app. It hid for a long
   time because the blanket `!**/*.md` already excluded the rules docs, leaving only worktree `.js`
   that nothing loads and nobody would see without listing the asar. `!.claude` is excluded now; the
   general lesson is that this glob fails open, so check the size rather than assuming.

   Also confirm the modules you changed are present — the point of shipping is that your code is
   in there, and an over-eager exclusion is as easy to write as a missing one.

5. **Relaunch**:
   ```bash
   open -a CXNotes
   ```

6. **Verify beyond the build.** It is a menu-bar app (LSUIElement, no dock icon), so check the
   process is alive, the menu-bar item exists, and no `sox` orphans linger:
   ```bash
   pgrep -f "CXNotes.app/Contents/MacOS/CXNotes" >/dev/null && echo "app running" || echo "APP NOT RUNNING"
   ps aux | grep -v grep | grep -c 'sox -t coreaudio'   # expect 0 when idle
   osascript -e 'tell application "System Events" to tell process "CXNotes" to count of menu bar items of menu bar 2'
   ```
   First launch after a re-signed native `calendar-helper` may re-prompt for Calendar access
   (gotcha #7 — TCC keys on the helper's code signature).

7. **Verify the way a real user launches it** (gotcha #14). `open -a CXNotes` run from a terminal
   passes the calling shell's environment to the app, so the app you just tested had a full
   developer PATH and **a passing step 6 says nothing about what anyone else gets**. That is exactly
   how the missing-dependency bug reached two other Macs. Reproduce a Finder/Dock launch:
   ```bash
   osascript -e 'tell application "CXNotes" to quit' 2>/dev/null; sleep 2
   LOG=$(mktemp /tmp/cxnotes-dock-XXXX.log)
   (env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" \
     /Applications/CXNotes.app/Contents/MacOS/CXNotes > "$LOG" 2>&1 &)
   sleep 20
   sed -n '/Checking Dependencies/,/^====/p' "$LOG"
   pkill -f "/Applications/CXNotes.app/Contents/MacOS/CXNotes"; sleep 2
   open -a CXNotes            # leave it running normally
   ```
   Background it to a log rather than piping — the app never exits, so a pipe into `sed` hangs
   forever. Every line of the summary should read OK: sox, system audio, transcription, ai summary,
   mic. (Transcription is OK when either backend is — Parakeet via uv, or whisper.cpp.)
   Anything reported missing here is missing for real users even though it resolves fine in your shell.

Report: the packaged version, the asar size, whether the app process is running, the `sox` orphan
count, and whether the dependency summary passed under the minimal Dock PATH.
