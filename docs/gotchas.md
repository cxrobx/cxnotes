# Known Gotchas — full reference

> **Read on demand.** The always-loaded digest is `.claude/rules/gotchas.md`, one
> short entry per gotcha. This file is the full text: diagnostics, measurements
> and the incidents behind each one. **Numbering is shared with the digest and
> permanent** — code comments cite `gotcha #N`. When a gotcha changes, change it in
> both places.


Organised by category. 24 items, condensed format. Original numbering preserved (gaps intentional; two entries share #20).

## Index

| # | Issue | Category |
|---|-------|----------|
| 1 | system_profiler parsing format | Environment |
| 2 | The BlackHole fallback was REMOVED — it could not fail loudly | Environment |
| 3 | whisper.cpp model path is hardcoded | Environment |
| 4 | Orphaned sox processes on crash | Backend |
| 5 | SCK delivers zero-filled frames with ARK.driver loaded | Environment |
| 6 | "Both tracks silent" — compound failure diagnostic | Backend |
| 7 | EventKit permission prompt timing + per-binary-signature trigger | Environment |
| 8 | MCP-spawned calendar-helper can't inherit the app's Calendar grant | Environment |
| 9 | cxmail calendar source — DB-shape coupling, per-mailbox dedup, floating-vs-UTC dates, no dtend | Integration |
| 10 | `tray.getBounds()` returns off-screen coordinates with an auto-hidden menu bar | Frontend |
| 11 | `.form-group label` outranks `.checkbox-label` — switch styling silently ignored | Frontend |
| 12 | LLM CLIs print usage-limit refusals to stdout with exit 0 — the notice becomes the "summary" | Integration |
| 13 | A comma-separated RGB triplet makes `rgb(var(--x) / var(--a))` invalid — the pane paints NOTHING and looks like great glass | Frontend |
| 14 | A Dock-launched app gets a minimal PATH — `which`/bare `spawn` finds no Homebrew or npm-global binary, and `open -a` from a terminal hides it | Environment |
| 15 | The per-app SCContentFilter records digital silence — and it was introduced as the FIX for #5 | Environment |
| 16 | Nothing checked that the audio was audio: every health check measured file GROWTH, and a zero-filled WAV grows at the byte rate of speech | Backend |
| 17 | The probe is only meaningful in a QUIET capture — and it rides on the SCK filter shape | Backend |
| 18 | "Run Setup" was dead in every packaged build, and the dependency check didn't know Parakeet existed | Environment |
| 19 | The `hidden` property does nothing on an element an author rule gives a `display` to | Frontend |
| 20 | ScreenCaptureKit delivers frames on CHANGE, not on a clock | Backend |
| 20 | The careful path went quiet and the careless one answered in its place | Integration |
| 21 | A mail-derived calendar cannot see anyone who did not RSVP to a meeting you called | Integration |
| 22 | Return does nothing on a focused button while Option is held — Chromium sends no `keypress` | Frontend |
| 23 | The silence trim cut BOTH ends and recorded one total — the track lost its clock, and a companion transcript missing the mic side was filed as complete | Backend |
| 24 | Phone and FaceTime calls are invisible to ScreenCaptureKit, and the probe says the capture is fine | Environment |

---

## Environment

### 1. system_profiler SPAudioDataType Parsing Format
**Symptom**: Audio device detection fails or returns wrong devices
**Cause**: `system_profiler` output uses specific indentation — device names at 8 spaces, properties at 10 spaces
**Solution**: The parser in `utils/audioDevices.js` handles this correctly. Do not change the indent-based parsing logic.
**Pattern**: `utils/audioDevices.js` → `listInputDevices()`

### 2. The sox+BlackHole Fallback Was REMOVED — Do Not Re-Add It
**Symptom**: Recording now *refuses to start* where it previously began and produced a silent `system.wav`. That is the intended behaviour, and the instinct it provokes — "add a fallback so it can always record something" — is the bug being prevented.
**Cause**: BlackHole is a virtual **cable**, not a source. It carries audio only when system output is routed into it through a Multi-Output Device, which is manual configuration the app can neither perform nor reliably verify. So the fallback's failure mode was a correctly-sized, digitally-silent WAV discovered *after* the meeting. Worse, it fired automatically: the mid-flight timeout handed a slow-but-healthy SCK to BlackHole, converting a transient delay into total loss (see the `SCK_START_TIMEOUT_MS` comment — the 3s version did exactly this).
**Evidence (2026-08-10)**: across 58 recorded sessions the fallback engaged **once** — `2026-06-16_21-06-11`. That session: 210s duration, a `system.wav` holding 38s of audio, `"Transcript merge produced no entries — both tracks were empty"`, no transcript, no summary, no export. Lifetime record: zero successful captures, one lost meeting. The incident it was nominally insurance against (gotcha #5's ARK/wedged-`coreaudiod`) was resolved with `sudo killall coreaudiod`, not by falling back.
**What replaced it**: `resolveSystemCaptureMethod()` throws with ONE specific fix per cause — helper missing → `npm run build:native`; grant refused → System Settings; otherwise → requires macOS 13+. Collapsing these into one message is what made the old error name two wrong fixes at once. Mid-flight, `watchSckStartup`'s `onNoAudio` now **warns and keeps recording** (`sckSilentWarning()`), marks the track `silent` in the manifest, and leaves the mic track intact.
**Diagnostic**:
- `native/sck-audio-capture/.build/release/sck-audio-capture --check` → `STATUS: ScreenCaptureKit available and permitted`.
- A silent system track is now always gotcha #5 (SCK starved or wedged), never a routing problem — there is no second path left to confuse it with.
**If you are tempted to re-add it**: the requirement is not "a fallback", it is "never silently record nothing". Any replacement must be able to *prove* it is capturing real audio before the meeting, which the name-matching check the old warning used (`/blackhole|multi-output|aggregate/i` against a device **name**) could not do in either direction.
**Pattern**: `services/recorder.js` → `resolveSystemCaptureMethod()`, `sckSilentWarning()`, `watchSckStartup()`, `SCK_START_TIMEOUT_MS`; `services/dependencies.js` → `resolveSystemAudio()`. Guarded by tests in `utils/audioDevices.test.js` (asserts `findBlackHoleDevice` stays undefined) and `services/dependencies.test.js`.

### 3. whisper.cpp Model Path
**Symptom**: Transcription fails with "model not found"
**Cause**: whisper.cpp expects `ggml-base.en.bin` in the `models/` directory
**Solution**: Run `setup.sh` which downloads the model, or manually place it in `models/`
**Pattern**: `services/transcriber.js`

## Backend

### 4. Orphaned sox Processes on Crash
**Symptom**: sox processes keep running after app crash. Worse follow-on symptom: *new* recordings produce silent or garbled `mic.wav` because multiple sox instances are holding the same mic device open and starving each other.
**Cause**: App crash, force-quit (`pkill -f CXNotes`), or SIGKILL bypasses normal cleanup in `cleanupProcesses()`. New sessions launch fresh sox while orphans still hold Core Audio handles.
**Diagnostic**: `ps aux | grep -v grep | grep 'sox -t coreaudio'` — if you see sox processes writing to **multiple** `recordings/<timestamp>_session/` paths, you have orphans. Each extra entry is one orphan session fighting the current one.
**Recovery**: `pkill -9 sox` clears all orphans. Then `ps aux | grep sox | grep -v grep` should return empty. Safe to run — any in-flight recording from the live app is already compromised if orphans exist.
**Pattern**: `main.js` → `registerProcess()`, `cleanupProcesses()`
**Related**: If `system.wav` is *also* silent from the same session, don't assume this is the cause — see #5 (ARK/SCK) and #6 (compound failure).

## Environment (continued)

### 5. SCK Delivers Zero-Filled Frames — ARK.driver Hijack OR Wedged coreaudiod
> ⚠️ **Partly superseded (noted 2026-09-25).** The *Solution (Cause A)* below — the per-app `including` filter — is itself the failure in #15; `.excluding` ships. The BlackHole bypass in *Recovery* no longer exists (#2). And the "`afplay` gives false-negative zeros" warning holds only for the `.including` shape: under the shipped `.excluding` filter `afplay` is captured (0.999542, #17), which is what the probe relies on. Cause B and `sudo killall coreaudiod` stand.

**Symptom**: `system.wav` has the correct byte size for its duration but `sox -n stat` reports `Maximum amplitude: 0.000000`, `RMS amplitude: 0.000000`. Manifest shows `captureMethod: "sck"` and no error is logged. SCK starts and stops "successfully."
**Cause (A) — ARK display-mix hijack**: Rogue Amoeba's Audio Capture Engine (ACE) installs `ARK.driver` into `coreaudiod`. It sits on the display audio bus, and the legacy `SCContentFilter(display:excludingWindows:)` shape — which uses the display's audio mix — gets starved to silence. BlackHole aggregate devices can cause the same class of issue. Fixed by the per-app filter (see Solution).
**Cause (B) — wedged `coreaudiod` (verified 2026-07-22, distinct from A)**: The per-app filter does NOT make this symptom impossible. The *same* flat-zero `system.wav` can come from a wedged long-running `coreaudiod`, with the per-app filter in place and ARK loaded but innocent. Proof from the incident: capture worked perfectly on 2026-07-20 14:31 (max amplitude 0.999969) **with ARK.driver already loaded**, then every session from 2026-07-21 01:28 on was flat zero — no code change (SCK source untouched since June), no macOS update, no reboot. `coreaudiod` had been up continuously since 2026-07-02, so whatever wedged its audio graph could not self-clear. `sudo killall coreaudiod` fixed it. **Lesson: ARK being *loaded* looks necessary but is NOT sufficient — don't stop at "ARK is present, therefore ARK is the cause."** Suspect a wedge when it worked recently and nothing in software/OS changed.
**Diagnostic**:
- `ps aux | grep -i ARK.driver | grep -v grep` → a coreaudiod subprocess line means ARK is loaded (a lead, not a verdict — see Cause B).
- `sox recordings/<latest>/system.wav -n stat 2>&1 | grep -E 'amplitude|RMS'` → all zeros confirms zero-filled frames (as opposed to a file that simply wasn't written).
- **Timeline the break.** Run `sox` stat over `recordings/*_session/system.wav` chronologically to find the last-good / first-broken boundary, then correlate that window with `git log`, driver bundle mtimes, `last reboot`, the `coreaudiod` start time (`ps -o lstart -p $(pgrep coreaudiod)` — it can restart without a reboot), and Rogue Amoeba daemon plists (`~/Library/Preferences/com.rogueamoeba.*`). NOTE: retention deletes old `.wav`s, so only recent sessions have amplitude to read.
- **⚠️ Do NOT test SCK capture with `afplay` / `sox play` — they give false-negative zeros.** CLI audio players are NOT in the SCK per-app capture set (`SCContentFilter(display:including:apps:)`), so capturing them reads `0.000000` even when SCK works fine. Test with a real GUI app: `open -a "QuickTime Player" tone.wav`, then AppleScript `play front document` while running the helper (`Contents/Resources/sck-audio-capture <out> --sample-rate 16000 --channels 1 --bit-depth 16`). Only a **non-zero** result is trustworthy; a zero from a CLI source proves nothing. (The QuickTime AppleScript triggers a one-time Automation TCC prompt that hangs a non-interactive run until approved.)
- **Permission vs starvation:** if the helper enumerates displays/windows and starts the stream without exit 2 / a `-3801` error, Screen Recording IS granted → zero audio is content-starvation, not a permission/signature problem. The Developer-ID-signed helper keeps its TCC grant across rebuilds, so a rebuild/reinstall does not revoke it.
**Solution (Cause A)**: Use the per-app filter shape — `SCContentFilter(display:including:apps:exceptingWindows:)` with `content.applications` minus own PID. Taps per-app audio directly and bypasses the display-mix hijack. Applied in `native/sck-audio-capture/Sources/AudioCapture.swift`.
**Recovery (Cause B)**: `sudo killall coreaudiod` first — it clears a wedged audio graph and (per 2026-07-22) is often the actual fix, not just a last resort; coreaudiod auto-relaunches. If a genuine ARK hijack persists after that, uninstall Rogue Amoeba's ACE via its uninstaller, or bypass SCK entirely via the BlackHole capture path (sox reads BlackHole's input directly — immune to any SCK/ARK issue).
**Pattern**: `native/sck-audio-capture/Sources/AudioCapture.swift` → `SystemAudioCapture.start()`

## Backend (continued)

### 6. "Both Tracks Silent" — Compound Failure Diagnostic
**Symptom**: Both `system.wav` *and* `mic.wav` are silent in the same session, tempting the (incorrect) conclusion that there's a single deep bug.
**Cause**: In practice this is almost always **two independent failures stacked**: #5 (ARK hijack → silent system track) combined with #4 (orphaned sox → silent mic track). Each has a different fix; neither fix alone resolves the compound symptom.
**Diagnostic ritual** (run *in order* — do not skip):
1. `ps aux | grep -v grep | grep 'sox -t coreaudio'` → if multiple sessions present, you have orphans (see #4). Run `pkill -9 sox` and verify empty.
2. `ps aux | grep -i ARK.driver | grep -v grep` → if present, you're vulnerable to #5. Filter fix should already be in effect from the current binary.
3. `sox recordings/<latest>/system.wav -n stat 2>&1 | grep -E 'amplitude|RMS'` and same for `mic.wav` → zeros vs non-zeros tells you which track(s) are actually silent.
4. **Cross-check with a known-good app**: does QuickTime capture mic audio right now? If yes, any mic failure in CXNotes is app-specific (usually #4). If no, the problem is OS-level and nothing in this codebase will fix it.
**Solution**: Treat the two failures independently. Never assume "both broken" = "one bug." Never propose architectural rewrites until the diagnostic ritual above is complete.

### 7. EventKit Permission Prompt — Triggered by the Helper, Per-Binary-Signature
**Symptom**: First-run users see no Calendar prompt despite enabling calendar suggestions in Settings. Or: re-signed dev builds re-prompt for permission even though the production build was already granted.
**Cause**: The macOS Calendar permission prompt fires the first time `EKEventStore` is opened by a process that has `NSCalendarsUsageDescription` (and on macOS 14+ `NSCalendarsFullAccessUsageDescription`) in its bundle Info.plist. In CXNotes this is the `calendar-helper` Swift CLI, NOT the Electron app — the Electron process never touches EventKit directly. macOS keys the granted/denied decision by the binary's code signature, so re-signing with a different identity (e.g. switching dev provisioning) re-prompts the user.
**Diagnostic**:
- `tccutil` is the wrong tool here; check via Settings → Privacy & Security → Calendars and look for `calendar-helper` as a distinct entry alongside CXNotes.
- `codesign -dv native/calendar-helper/.build/release/calendar-helper 2>&1 | grep TeamIdentifier` — if this changes between builds, expect re-prompts.
**Solution**: Always sign the helper with the same identity used for the parent app (`-`/ad-hoc for local builds, the same Developer ID for distribution). The helper's own `Info.plist` must carry both the legacy and full-access usage strings; missing the macOS-14 string causes the prompt to silently never fire on macOS 14+.
**Pattern**: `native/calendar-helper/Info.plist`, `native/calendar-helper/CalendarHelper.entitlements`, `package.json` `scripts.build:calendar`, `setup.sh` calendar-helper build step.

### 8. MCP-Spawned calendar-helper Can't Inherit the App's Calendar Grant
**Symptom**: The standalone MCP server's calendar tools (`list_upcoming_meetings`, `prepare_meeting`) return a permission error even though the **app** has Calendar access. Spawning the dev helper from a plain `node` parent returns exit 2 (`{"status":"denied"}`) — it never prompts.
**Cause**: This is gotcha #7 from the MCP angle. macOS keys the Calendar (TCC) grant to the helper binary's **code signature**. The packaged app's helper is Developer-ID-signed (`TeamIdentifier=CCYV5HQZCM`) and owns the granted permission; an ad-hoc dev build (`TeamIdentifier=not set`) is a *different file* with a different signature → its own (denied/not-determined) decision. A headless spawn also lacks the GUI responsibility attribution that surfaces the prompt, so it silently returns denied rather than prompting (verified in Phase 0).
**Diagnostic**:
- `npm run mcp:check` — the doctor prints the resolved helper path, whether the installed signed helper is present, the handoff dir, and the live permission state. Exit 0 = ready, 1 = helper missing, 2 = not granted.
- `node -e 'require("child_process").spawn("<helper>", ["request-access"], {stdio:["ignore","inherit","inherit"]})'` — exit 2 = denied, 3 = not-determined, 0 = granted.
**Solution**: `shared/paths.js` `resolveCalendarHelperPath({ preferInstalled: true })` makes the MCP server prefer `/Applications/CXNotes.app/Contents/Resources/calendar-helper` (the signed, grant-carrying binary) over the dev build. Grant Calendar access to the app once (it prompts on first calendar use), then the MCP server rides that grant. Tools surface denial as `{ error, message, fix }` (never a silent empty list); `list_prepared_meetings`/`cancel_prepared_meeting` work without any Calendar access.
**Pattern**: `shared/paths.js` → `resolveCalendarHelperPath()`, `INSTALLED_HELPER_PATH`; `mcp/calendarFactory.js` → `createCalendarSource()`; `mcp/check.js`; `mcp/handlers.js` → `permissionError()`.

## Integration

### 9. cxmail Calendar Source — DB-Shape Coupling, Per-Mailbox Dupes, Floating-vs-UTC Dates, No dtend
**Symptom**: cxmail-sourced meetings stop appearing, appear **multiple times** (once per mailbox), read `Accepted: …` in the title, leak Google-Meet boilerplate into the skeleton, appear at the wrong time, or end instantly.
**Cause**: `CxmailCalendarSource` reads another app's private SQLite (`~/Library/Application Support/com.cxmail.app/cxmail.db`, table `calendar_events`) **one row per (invite × mailbox)**. As of 2026-07-02 the source **normalises** (port of meeting-copilot's `server/src/calendar/cxmail.ts`): fetch → resolve times → group/dedup → emit one clean event per meeting. Coupling points that bite:
1. **Schema drift** — the query now also selects **`event_uid`** (dedup key) and **`created_at`** (winner selection) on top of `summary, dtstart, dtend, source, confidence, rsvp_status, method, raw_ics, organizer_name, organizer_email, location`. If cxmail renames/drops any, the query breaks. We read defensively and surface a typed error (never throw), so the suggester self-disables rather than crashing.
2. **Per-mailbox / reschedule / RSVP dupes** — the same Google invite lands up to **4×** (one per account); reschedules re-send the same `event_uid`; attendee RSVPs come back as separate `METHOD:REPLY` rows (often the ONLY trace of a meeting *you* organised). Dedup keys on `event_uid` (**null-UID `detected` rows fall back to `summary|floor(startMs/60000)`** or every detected meeting collapses into one), **newest `created_at` wins** for time/title, **attendees union** across all rows in the group (a REPLY lists only the responder), and per-field description/location/organiser fall back to the newest row that HAS the value. `cleanTitle` strips `Accepted:/Declined:/Tentative…` prefixes; `cleanDescription` strips Google's `-::~:~::-` block + bare-marker lines; `parseIcsAttendees` drops `CUTYPE=RESOURCE|ROOM`.
3. **Mixed date formats** — cxmail stores `dtstart` either as UTC (`2026-06-17T14:00:00Z`), *floating* local wall-clock (`2026-06-19T10:00:00`), or floating **with a `DTSTART;TZID=…` in `raw_ics`**. `resolveEventTime(value, rawIcs, prop)` resolves each: `Z`→`Date.UTC`; floating+TZID→DST-correct two-pass `Intl.DateTimeFormat`; else→the machine-local `parseCxmailDate` (unchanged). SQLite's `datetime()` treats a floating value as if UTC, so the SQL time filter stays a **coarse** `now - 1 day` lower bound; the **precise** window is applied in JS. Don't tighten the SQL window — it will skew by your UTC offset.
4. **`detected` events have no `dtend`** (all of them) and no attendees. We synthesise `end = start + 60min` and set `meetingWorthy:true` so `meetingFilter` skips its ≥2-attendee gate.
**Diagnostic**:
- `sqlite3 -readonly -json "$HOME/Library/Application Support/com.cxmail.app/cxmail.db" "SELECT id,event_uid,dtstart,dtend,source,confidence,rsvp_status,created_at FROM calendar_events WHERE dismissed=0 ORDER BY dtstart DESC LIMIT 10;"` — confirms the live rows, formats, and the per-mailbox `event_uid` dupes.
- Fewer events than raw rows is EXPECTED (dedup): verified 2026-07-02 the live DB had 83 eligible rows → 61 normalised events; a 4× `…@google.com` invite collapsed to 1 with attendees unioned; 0 titles kept an RSVP prefix; 9 `detected` events survived.
- Low-confidence noise: `detected` events below `cxmailCalendarMinConfidence` (default 0.7) are intentionally dropped. Lower the threshold in Settings if a real meeting is being filtered.
**Solution**: Treat cxmail's DB as read-only foreign data. Keep `CxmailCalendarSource` the only reader, keep all date precision **and dedup** in JS, and never widen the SQL beyond the coarse bound. If cxmail isn't installed, `isAvailable()` is false and `FallbackCalendarSource` uses EventKit.
**Pattern**: `services/calendarSources/cxmailCalendarSource.js` → `resolveEventTime()`, `cleanTitle()`, `cleanDescription()`, `parseIcsAttendees()`, `_dedupKey()`, `_normalizeRows()`, `_buildEvent()`, `_eligibilityClause()`; `fallbackCalendarSource.js`.

## Frontend

### 10. `tray.getBounds()` Returns Off-Screen Coordinates With an Auto-Hidden Menu Bar
**Symptom**: The menu-bar panel opens in a corner of the desktop (bottom-left, or clamped against an edge) instead of hanging under the tray icon. Verified 2026-07-30: the panel landed at (4, 1089) on a single-display Mac.
**Cause**: `tray.getBounds()` is only meaningful while the status item is actually laid out in a visible menu bar. With the menu bar auto-hidden — or before the item has been placed — macOS hands back a garbage origin. The observed value was **x = -9294** on a machine with exactly one 1728pt-wide display, i.e. a point that exists on no screen. Anchoring to it and then clamping to the work area produces a confidently-wrong position rather than an obvious failure.
**Diagnostic**:
- `osascript -e 'tell application "System Events" to tell process "Electron" to get {position, size} of every menu bar item of menu bar 2'` → compare against the display list. A coordinate outside every display's bounds means the tray bounds are unusable.
- `osascript -e 'tell application "System Events" to get {position, size} of every window of process "Electron"'` → where the panel actually landed.
**Solution**: Validate the tray point against `screen.getAllDisplays()` before trusting it. If it falls on no display, ignore it and anchor to the top-right of the work area of the display under the cursor (where menu-bar extras live). Clamp **both** axes so a tall panel is pushed up instead of running off the bottom.
**Pattern**: `main.js` → `panelAnchorFor()`, `positionMenubarPanel()`.
**Related**: The panel's `blur` fires BEFORE the tray's `click`, so a naive toggle closes then instantly re-opens and the icon can never dismiss it — guarded by `panelClosedAt` / `PANEL_REOPEN_GUARD_MS`.

### 11. `.form-group label` Outranks `.checkbox-label` — Switch Styling Silently Ignored
**Symptom**: Toggle rows in the settings window render as an inline checkbox followed by text, with the description on its own line — the flex layout (label left, switch right) appears to have no effect. No error; the CSS simply does nothing.
**Cause**: Specificity. `.form-group label { display: block; }` is (0,1,1); `.checkbox-label { display: flex; }` is (0,1,0), so the block wins and the whole flex layout — including `flex-direction: row-reverse` and the child `flex: 1` — is dead. Every checkbox in this UI is inside a `.form-group`, so it always loses.
**Diagnostic**: `getComputedStyle(label).display` in the renderer returns `"block"` when the rule says `flex`. Measuring with `getBoundingClientRect()` on a pane that is `display:none` returns all zeros — switch to the pane first or the probe is meaningless.
**Solution**: Scope the rules to beat it — `.form-group .checkbox-label` (0,2,0) — rather than reaching for `!important`. Child rules (`span`, `small`) need the same treatment, since `.form-group label small` is (0,1,2).
**Pattern**: `renderer/styles.css` → `.form-group .checkbox-label` block.

### 12. LLM CLIs Print Usage-Limit Refusals to STDOUT With Exit 0 — The Notice Becomes the "Summary"
**Symptom**: A meeting processes end-to-end with no error anywhere — `notes.md` written, session badged **Summarised**, note auto-filed into the correct vault folder — but the note's entire contents are one line of provider error, e.g. `You've hit your session limit · resets 3:20pm (America/New_York)`. Because nothing failed, `manifest.processing.error` is absent and the **reprocess button stays hidden** (its old gate was `!rec.summarised || rec.processingError`), so the broken note is invisible in the UI. Verified 2026-07-31 on a 1h25m ACM session — transcription was perfect, only the summary was the error string.
**Cause**: Both provider CLIs report *policy* refusals (usage limit, quota, auth) as **normal output**: exit code 0, message on stdout, nothing on stderr. `runClaude`/`runCodex` only rejected on non-zero exit, empty output, or (Claude only) an auth-phrase match — so a limit notice satisfied every success condition and was returned as the summary. `generateSessionNotes` then wrote it, and `fileAndExportNotes` filed it.
**Diagnostic**:
- `wc -c` the notes: a real note is ~6–14 KB. Anything under a few hundred bytes is suspect.
- `head -1 recordings/<session>/../processed/<session>/notes.md` — the notice is self-describing.
- Sweep every session: run `detectProviderFailure` (exported from `services/summariser.js`) over each `processed/*/notes.md`. Confirmed 2026-07-31: 62 notes scanned, 0 false positives.
**Solution**: `detectProviderFailure(output, provider)` in `services/summariser.js` is the single judgement, called by BOTH provider wrappers before they resolve. Auth patterns match at any length (they can appear inside a long help dump); **limit** patterns fire only when the output is short (≤400 chars) **and** contains no `##` heading — that pairing is what stops a genuine summary of a meeting *about* rate limits from being rejected. Rejecting lets `runLLM` fall Codex→Claude, and if both refuse the error propagates so the session records a real `processing.error`.
**Second instance — a bad MODEL name (found 2026-08-05):** the same failure shape, a different cause, and one that only became reachable when models were made user-configurable (invariant #19). `claude -p --model bogus-model-y` **exits 0** having printed to stdout:
> `There's an issue with the selected model (bogus-model-y). It may not exist or you may not have access to it. Run --model to pick a different model.`
Short, no `##`, no stderr, exit 0 — it satisfied every success condition and was returned as the summary. Found by deliberately walking the fallback chain with bogus models, NOT by unit tests, which is the argument for exercising the real CLIs when touching this path. Now covered by `PROVIDER_MODEL_PATTERNS`, gated by the same length+heading rule and reported separately from the limit case because **the fix is different — change a model, not wait for a quota**. A typo in the Settings model box, or a plan that does not include the pinned default, is now the most likely way an ordinary user meets this.

**Do NOT** widen the patterns without the length+heading gate — a false positive throws away a good summary the user just paid for in whisper time.
**Recovery**: Re-summarise from the existing transcript (✨ in Settings, or Retry in the menu-bar panel) — the transcript is fine, only the LLM step failed. Never full-reprocess for this; re-running whisper on a long meeting costs many minutes to fix a ~45s step.
**Pattern**: `services/summariser.js` → `detectProviderFailure()`, `runCodex()`, `runClaude()`; `main.js` → `detectPoisonedNote()`, `reusableTranscriptFor()`, `resummariseSession()`. Tested in `services/summariser.test.js`.

### 13. A Comma-Separated RGB Triplet Silently Kills the Whole Background — and the Failure Looks Better Than the Fix
**Symptom**: Every glass pane looks *wonderful* — beautifully translucent, the desktop reading right through it — but small muted text is unreadable, chips are invisible, and the warm charcoal identity is gone in favour of a cool grey wash. Nudging the surface colours changes nothing at all. No console error; the window renders.
**Cause**: The surface tokens were declared comma-separated (`--surface-pane: 28, 26, 23`) and consumed as `rgb(var(--surface-pane) / var(--alpha-pane))`. That expands to `rgb(28, 26, 23 / 0.734)` — legacy comma syntax mixed with slash-alpha, which is **invalid**. CSS does not clamp or partially apply an invalid value: it drops the entire declaration, so the element paints **no background at all**. What you are then looking at is the bare `NSVisualEffectView` with only the alpha-on-white washes on top of it, which is exactly what very good glass is supposed to look like. That is why it survives a screenshot review — the bug is *prettier* than the correct rendering, and the only thing it costs you is the tint that makes text legible. Verified 2026-08-05: shipped to a screenshot, approved, and only caught by a computed-style read.
**Diagnostic**: Never judge this by eye. Read the computed value:
```js
win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.sidebar')).backgroundColor`)
```
`rgba(0, 0, 0, 0)` on an element that declares a background is the whole story. Contrast with a healthy pane: `rgba(46, 43, 38, 0.365)`. Check `body` and any wrapper too — those *should* be `rgba(0, 0, 0, 0)` (invariant #18 forbids them painting), so the same reading means opposite things depending on the element, which is another reason to enumerate rather than spot-check.
**Solution**: Space-separated triplets — `--surface-pane: 28 26 23` — everywhere a token feeds `rgb(var(--x) / var(--y))`. The `--accent-rgb: 10, 132, 255` style token is the *other* convention (consumed as `rgba(var(--accent-rgb), 0.12)`) and is correct as commas; the two cannot be mixed, and a token used both ways has to be duplicated rather than converted.
**Related**: the same class of silent-invalid bites `rgb(35, 32, 28, var(--a))` — legal CSS Color 4, but only if every component is comma-separated. Prefer the slash form uniformly so there is one shape to review.
**Pattern**: `renderer/styles.css` + `renderer/menubar-panel.html` / `meeting-banner.html` / `silence-prompt.html` / `filing-prompt.html` / `pre-record.html` `:root` blocks; `services/glass.js`; invariant #18.

### 14. A Dock-Launched App Has No Homebrew on Its PATH — and Building the App Is What Hides It
**Symptom**: The packaged `.app` reports dependencies missing that are demonstrably installed — "Some dependencies are missing… sox (audio recording)" with `sox --version` working fine in a terminal. Recording fails with `spawn sox ENOENT`, and Settings reports no AI provider even though `codex`/`claude`/`ollama` are all installed. **Works perfectly for whoever built the app, on the machine they built it on.** Reported 2026-08-05 from two other Macs.
**Cause**: macOS gives an app launched from Finder, the Dock or Spotlight the environment inherited from launchd, and `launchctl getenv PATH` is unset by default, so the app gets:
```
/usr/bin:/bin:/usr/sbin:/sbin
```
`/opt/homebrew/bin` and every npm-global bin dir are absent. So `execSync('which sox')`, `spawn('sox', …)`, `which codex|claude|ollama` — every PATH-dependent lookup — fails. Verified: `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin which sox` exits 1 on a Mac where `which sox` returns `/opt/homebrew/bin/sox`.
**Why it never reproduces for the developer**: `open -a CXNotes` run from a terminal **passes the calling shell's environment to the app**, and that is exactly how `scripts/build-and-install.sh` and `.claude/commands/ship.md` launch it. The build machine's app therefore inherits a full developer PATH; every other machine gets the crippled one. The bug is invisible precisely *because* of how the app is shipped.
**This is now checked rather than remembered**: `/ship` step 7 relaunches the installed app under `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin` and requires the dependency summary to come back all-OK, so a regression in binary resolution fails the ship instead of reaching someone else's Mac. (`scripts/build-and-install.sh` was never exposed to the sibling problem — it derives its own directory from `$0` rather than hard-coding one.)
**Diagnostic**:
- `launchctl getenv PATH` → empty means GUI apps get the system default.
- `ps eww -p $(pgrep -f 'CXNotes.app/Contents/MacOS/CXNotes') | tr ' ' '\n' | grep ^PATH=` → if this shows a rich developer PATH, the app was launched from a terminal and **is not** reproducing the user's environment.
- **Reproduce a real Dock launch** — this is the only trustworthy test:
  `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" /Applications/CXNotes.app/Contents/MacOS/CXNotes`
**Solution**: never depend on PATH for an external binary. `utils/binaries.js` `resolveBinary()` searches `$PATH` first (so a developer's deliberate choice still wins) and then the places these tools actually live — Homebrew, `/usr/local/bin`, MacPorts, `~/.local/bin`, and every `~/.nvm/versions/node/*/bin`. Consumers: `main.js` dependency checks, all five `spawn(soxBin(), …)` sites in `services/recorder.js`, and `providerAvailability()`/`runProvider()` in `services/summariser.js`. Invariant #20.
**Related**: `findUv()` and `findWhisperBinary()` were already written with absolute candidates and were never affected — that is the pattern the resolver generalises.
**Landmine when fixing**: bundling whisper-cli into `extraResources` looks like the obvious fix for the transcription half and is wrong — `otool -L` shows it links against six `@rpath` dylibs (libwhisper, libggml, libggml-cpu/-blas/-metal/-base). Shipping the bare 825 KB executable produces a dyld crash on any machine without Homebrew's whisper, which is strictly worse than an honest "not found". Bundle the dylibs and rewrite the rpaths, or don't bundle.
**Pattern**: `utils/binaries.js` → `resolveBinary()`, `resolveBinaryCached()`, `requireBinary()`; `services/recorder.js` → `soxBin()`. Tested in `utils/binaries.test.js`, which asserts resolution under the literal GUI PATH.

### 15. The Per-App SCContentFilter Records Digital Silence — and It Was Introduced as the FIX for #5
**Symptom**: `system.wav` is the correct size for its duration, grows normally throughout, and contains **zero non-zero samples**. No error anywhere; the session transcribes, summarises, badges **Summarised** and files itself into the right vault folder holding one side of a conversation. Confirmed losses: **Jul 7** (Orchid IQ sync), **Aug 13** (an external call — 32,042,880 frames, 0 non-zero), **Aug 14** (NXT Training Academy — 1,573,440 frames, 0 non-zero). Unrecoverable.
**Cause**: `SCContentFilter(display:including:apps:exceptingWindows:)` — the per-app audio tap — returns silence on this machine. Measured head-to-head 2026-08-14 with a 440 Hz tone, ARK.driver loaded throughout, RME Babyface Pro as default output:

| Audio source | `including` (per-app) | `excluding` (display mix) |
|---|---|---|
| running and playing before capture starts | **0.000000** | 0.014282 |
| launched *after* capture starts | **0.000000** | 0.014282 |
| running, audio starts after capture | **0.000000** | 0.014282 |

The installed Aug-7 helper — the same binary that recorded the three lost meetings — measured `0.000000` in the same conditions, so this is not a regression in any later change. **The bitter part: the per-app filter was added as the fix for #5**, on the theory that it bypassed the ARK/ACE display-mix hijack. ARK is loaded during every measurement above and the display-mix shape is unaffected by it, which fits #5's own caveat that ARK being *loaded* looked necessary but was never sufficient — the one #5 incident actually resolved was resolved by `sudo killall coreaudiod`, not by the filter change. So a fix for a misattributed cause silently created a worse failure, and the misattribution is the lesson.
**A second, structural defect of the same shape** (real, but NOT what caused the losses): `content.applications` is snapshotted once at `start()` and frozen for the session, so an app whose *process* begins later is never captured at all. Clicking a meeting link after hitting Record would silence the whole meeting even on a machine where the per-app tap works. Fixed by `refreshFilter()` polling every 4s and calling `updateContentFilter`, which is kept for the `.including` path.
**Diagnostic**:
- The A/B is built in — `--filter-shape including|excluding` on the helper. Capture a known tone both ways and compare `sox <out> -n stat`. Which shape works has now changed twice; **measure, do not reason from this file**.
- ⚠️ Do NOT test with `afplay`/`sox play` — CLI players are not in the per-app capture set and read `0.000000` even when capture works. Use a GUI app (see #5).
- A capture that is fine will show a non-zero `Maximum amplitude` within a couple of seconds; there is no slow path to a real peak.
**Solution**: `.excluding` (the display mix) is the shipped default. `.including` stays reachable via `--filter-shape` as a diagnostic — it is **never** selected automatically, because invariant #1 forbids a silent alternate path.
**Why this can no longer be silent**: the fix for the *filter* is only half of it. See #16 — nothing in the app ever checked that the captured audio was audio, which is what let all four causes reach a finished note.
**Pattern**: `native/sck-audio-capture/Sources/AudioCapture.swift` → `FilterShape`, `buildFilter()`, `refreshFilter()`, `startFilterRefresh()`; `Sources/main.swift` → `--filter-shape`.

## Backend (continued)

### 16. Nothing Checked That the Audio Was Audio — Every Health Check Measured GROWTH
**Symptom**: The app reports unqualified success over a recording that captured nothing. Not one warning fires, `manifest.processing.error` is absent, the reprocess button stays hidden, and the note is auto-filed into the correct client folder. Four different root causes (BlackHole fallback, wedged `coreaudiod`, ARK hijack, per-app filter) produced this identical ending.
**Cause**: **A zero-filled WAV grows at exactly the byte rate of speech.** Every health check in the system was a growth check, so none of them could fail:
- `watchSckStartup` polls `statSync(...).size > 44` — a silent capture passes in the first second.
- `classifyTrackGrowth`/`computeTrackHealth` classify `live` on any size increase — a silent track is permanently `live`.
- `LevelMonitor._readLevel` maps RMS to dB and **clamps anything ≤ -60 dBFS to `0`**, so its `0` cannot distinguish digital silence from a quiet room, a missing file or a read failure.
- The stop path ended with `status = systemSize > 0 ? 'complete' : 'empty'`, which **overwrote** a mid-flight `'silent'` verdict, because a zero-filled file has size > 0.
- `processSession` computed `systemTrim.allSilence` and did nothing with it but `console.warn` — the detection existed and reached no one.
**Solution**: measure samples, not bytes. `LevelMonitor._readPeak` returns the raw integer peak of everything written since the last poll, **tri-state** (`null` = unreadable, and `null` is never evidence of silence). `SignalWatcher` (pure, timer-free, driven by the existing 150 ms poll) reaches a verdict only when the system track has produced no sample above the noise floor **while the mic has proven signal** — the corroboration is what separates "the capture is dead" from "nothing is playing yet", which are otherwise identical. At processing time `measureWavPeak` scans every sample and writes `manifest.tracks.system.silent`.
**The distinction that matters**: `health` is whether the FILE is growing; `signal` is whether it contains audio. They are independent, and the pair that lost three meetings is `health: 'live'` with `signal: 'silent'`.
**⚠️ COVERAGE GAP — single-track mode gets none of the live *passive* protection.** (Narrowed 2026-08-17: the start-of-recording **probe** covers both modes — see #17 — because an active probe needs nothing to corroborate against. What follows still applies to everything mid-meeting.) `SignalWatcher.update` returns immediately when `mode !== 'dual'` (`services/signalWatcher.js`), because a verdict needs a second track to corroborate with: from one track alone, "the capture is dead" and "nothing is playing yet" are genuinely indistinguishable, and a warning that cannot tell them apart trains the user to ignore it. The consequence is that a system-only recording gets **no verdict, and so no menu-bar warning, no panel banner and no in-place restart**. **Do not read that as "restore the verdict and the rest comes back."** The obvious-looking fix — deleting the `mode !== 'dual'` check — gives you the warnings and *silently* no restart: `restartSystemCapture` is defined on `DualTrackRecorder` alone (`services/recorder.js`; the single-track `Recorder` has no restart path, no `_spawnSystemCapture` and no `systemParts`), and `handleDeadSystemSignal` returns at its `if (!(dualRecorder && dualRecorder.isRecording)) return;` guard before ever reaching it. The result looks like protection and recovers nothing. Extending live detection to system-only means building a restart path for `Recorder`, not removing a check. Its only safety net is the `measureWavPeak` scan at processing time — which lands *after* the meeting, when nothing can be done about it. That is a deliberate trade, not an oversight, but it means single-track is materially less protected than dual and the badge/note-header path is all that remains. The panel's "system only" label is the one live surface that says so, which is why it survives in all three places the redundant "dual track" was removed from.
**Two ways this defence disarmed itself, both found by running it against a deliberately-broken capture rather than by unit tests:**
1. **A stray least-significant bit read as audio.** `measureWavPeak` defaulted its threshold to `0`, so a dead capture that emitted a single sample of value **1** (≈ -90 dBFS, over a 1,166,320-sample track) was reported as holding audio — no warning header, no badge. The threshold is now shared with the live watcher (`SILENCE_PEAK_THRESHOLD === DEFAULT_SIGNAL_THRESHOLD === 4`) so the two cannot disagree about what silence is; a test asserts that equality directly.
2. **A restart erased the silent verdict.** `restartSystemCapture` resets the track to `'recording'` — it must, because the replacement may be healthy — which discards a `'silent'` reached before it. A session judged dead, restarted, and stopped before the (deliberately long) second verdict landed ended up labelled **`complete` while holding nothing but zeroes**: the original bug wearing a different hat. No in-flight flag juggling fixes this; `stop()` now MEASURES the file (`resolveFinalTrackStatus(..., {measuredSilent})`) and lets it decide. The scan short-circuits on the first audible sample, so a healthy track costs a few kilobytes and only a genuinely silent one is read through — cheap exactly when the answer does not matter.
**On corroboration**: the mic test is deliberately weak (any signal), because per-poll peaks cannot separate "someone is talking" from "a room exists" — a MacBook Pro's mic measures **2084** in an empty room while real speech a couple of feet away measured **146-441**. Those ranges overlap, so a loudness gate is a guess about gain and distance. Instead the COST of a false verdict is managed: the first one restarts the capture and raises only ambient warnings (menu bar, panel) that clear themselves when audio arrives; a notification waits for a verdict that survives a restart and a five-minute second window. Also note ~42% of polls find no new bytes and yield `null`, so a 45 s window is nearer 75 s in practice.
**Do NOT** judge a track silent from a level of `0`, or from `trimSilence`'s `allSilence` (a proxy — it infers from how small sox made the output). Both are wrong in the direction that costs a meeting.
**Pattern**: `services/signalWatcher.js`; `services/levelMonitor.js` → `_readPeak()`, `retargetTrack()`; `utils/audioProcessing.js` → `measureWavPeak()`; `services/recorder.js` → `resolveFinalTrackStatus()`; `main.js` → `handleDeadSystemSignal()`, `updateTrayTitle()`; `services/silentTrackNotice.js`. Tested in `services/signalWatcher.test.js`, `utils/audioProcessing.test.js`, `services/silentTrackNotice.test.js`.

### 17. The Probe Is Only Meaningful in a QUIET Capture — and It Rides on the Filter Shape
**Symptom (the one to expect)**: capture verification says `alive` on a capture you have reason to doubt, or the mid-meeting probe stops confirming anything once a meeting gets loud. Alternatively, after a change to the ScreenCaptureKit filter shape, EVERY recording starts announcing "System audio is NOT being recorded" on a machine where audio is demonstrably fine.
**Cause**: two separate couplings, both easy to miss because the probe looks self-contained.
1. **Detection is regime-dependent.** A 200-trial-per-level Monte Carlo over broadband noise (`services/captureProbe.js` header) measured single-tone power ratios reaching **71.7** with no probe playing at all, and true-positive detection of a real probe collapsing to **1/50** under loud audio. Neither number is a bug and neither is worth "fixing" in the detector: masking is physics. What makes them harmless is that `verifyCapture` checks for REAL AUDIO first and never consults the probe when the region is loud — audio in the file already proves the capture works, which is the entire proposition. **If you ever make a probe result decide something on its own, you inherit both failure modes.**
2. **The probe source must be visible to the capture filter.** The signature is played with `/usr/bin/afplay`, and gotcha #15's table is exactly why that needed measuring: `afplay` reads **0.000000** through the per-app `.including` filter and **0.999542** through the shipped `.excluding` one. The probe is therefore only valid for as long as `excluding` is the shape. Which shape works has changed twice.
**Diagnostic**:
- Re-run the A/B before trusting a probe verdict after any capture-path change: play a tone with `afplay` while capturing under both `--filter-shape excluding` and `--filter-shape including`, and compare `sox <out> -n stat`. A universal "dead" verdict with working audio means the probe's source is invisible to the current filter, NOT that capture is broken.
- A probe verdict carries its own evidence: `result.detection.tones` reports the measured ratio and recovered amplitude per tone, and `result.peak` the region's peak. `peak: 0` with `verdict: 'dead'` is the real failure; a healthy peak with a failed detection is masking.
**Solution**: keep the audio-first gate in `verifyCapture` (`peak >= AUDIO_PROOF_PEAK` → `alive` regardless of detection), keep `inconclusive` as a real outcome rather than rounding it to a verdict, and keep the probe out of any decision made while the capture is loud.
**Two things that look like tuning knobs and are not**:
- **Amplitude is politeness, not sensitivity.** ScreenCaptureKit taps ahead of the master volume — measured identical capture with output muted and at volume 0 — so turning the probe up buys no detection margin and only makes it louder in somebody's meeting.
- **The ratio floor is a distribution, not an observation.** `_bestWindowFor` takes the MAXIMUM ratio over every window position, an extreme-value statistic that climbs as the search widens. A threshold set just above one measured noise sample is not a threshold: 12 looked safe against a single hardware reading of 9.4 and admitted a 1.5% false-positive rate.
**Pattern**: `services/captureProbe.js` → `detectSignature()`, `_bestWindowFor()`, `DEFAULT_MIN_RATIO`, `PROBE_AMPLITUDE`/`PROBE_AMPLITUDE_LIVE`; `services/probeRunner.js` → `verifyCapture()`, `AUDIO_PROOF_PEAK`. Invariant #23. Tested in `services/captureProbe.test.js`, `services/probeRunner.test.js`.

### 18. "Run Setup" Was Dead in Every Packaged Build — and the Dependency Check Didn't Know Parakeet Existed
**Symptom**: On a fresh Mac the installed app opens a "Setup Required" dialog on every launch even though transcription works, and clicking **Run Setup** opens Terminal onto a failing `cd` — `__dirname` in a packaged app points inside `app.asar`, a packed archive FILE, which `cd` cannot enter. Reported from a real install attempt 2026-08-19 (two screenshots of another agent talking the user out of the button).
**Cause**: two independent defects that compounded. (1) `runSetupScript()` interpolated `__dirname` into a `cd … && ./setup.sh` Terminal command; correct in a dev checkout, meaningless inside a package — and `setup.sh` itself assumes a source checkout (git clone + cmake build of whisper.cpp, swift builds of the helpers), none of which exists on a user's machine. (2) `checkDependencies()` had one transcription field, `whisper`, while Parakeet-via-`uvx` is the DEFAULT transcriber and whisper.cpp only the fallback (`services/transcriber.js`) — so a Parakeet-only machine transcribed fine yet was nagged into a Setup dialog that could not fix anything. Gotcha #14's shape again: invisible to whoever built the app, because a dev run has a real `__dirname` and a full toolchain.
**Also learned here**: `brew install whisper-cpp` alone does NOT make the whisper fallback work — the formula ships binaries and **no model** (verified against 1.8.3: nine binaries, zero `.bin`s, no `/opt/homebrew/share/whisper-cpp/models/`). `verifyInstallation` requires binary AND model, so the model must be downloaded separately into `~/Library/Application Support/CXNotes/models/`.
**Solution**: `resolveSetupCommand({isPackaged, repoDir, resourcesPath})` picks the command — dev keeps the byte-identical `cd repo && ./setup.sh`; packaged runs `bash "<Resources>/setup-packaged.sh"`, a self-contained installer shipped via `extraResources` (brew-only installs + a curl of the model straight into Application Support, downloaded under a scratch name and renamed only on success so a partial file never wears the model's name). `bash <script>` needs no execute bit, so nothing writes into the signed bundle. Transcription is judged by `resolveTranscription({parakeet, whisper})` — either backend present is OK — and the parakeet probe is `findUv()`.
**Pattern**: `services/dependencies.js` → `resolveSetupCommand()`, `resolveTranscription()`, `describeDependencyStatus()`; `main.js` → `runSetupScript()`, `checkDependencies()` (parakeet + transcription), the `audio:preflight` Transcription check; `setup-packaged.sh` (tested by `setup-packaged.test.js`); `package.json` `extraResources`. Tested in `services/dependencies.test.js`.

### 19. The `hidden` Property Does Nothing on an Element an Author Rule Gives a `display` To

**Symptom**: an element the renderer hides by setting `el.hidden = true` stays on screen, with no error and nothing in the console. Found 2026-08-20: the menu-bar panel's red **"⚠️ No system audio"** warning was shown on EVERY recording — the one warning in the app whose whole value is that it is rare (invariant #23: a false alarm is what teaches people to click past the true one). It went unnoticed because the panel's own attendee list had pushed it below the bottom of the window, so the two bugs hid each other.
**Cause**: `hidden` is not a display switch, it is an attribute matched by a **UA stylesheet** rule (`[hidden] { display: none }`). Author rules beat UA rules outright — this is the cascade's origin order, not a specificity contest, so no amount of specificity in the UA rule matters. `.no-audio { display: flex }` therefore wins, permanently, and the same trap catches every `display:`-carrying element the app hides this way.
**Diagnostic**: `getComputedStyle(el).display` on an element whose `hidden` is `true` — anything other than `none` is this bug. `el.hidden` itself reads `true` and is no help.
**Solution**: any rule that sets `display` on an element the code hides must opt back in: `.no-audio[hidden] { display: none; }`. Prefer that to `!important`, and prefer both to the `.hidden` utility class when the code is already using the DOM property. In this panel the two are `.no-audio` and `button.who-more`.
**Pattern**: `renderer/menubar-panel.html` → `.no-audio[hidden]`, `button.who-more[hidden]`.

## #20: ScreenCaptureKit delivers frames on CHANGE, not on a clock

**Symptom**: a slide-capture stream attaches to a window, reports healthy, and writes zero keyframes over 18 seconds against a window that is plainly on screen. No error, no dropped frames, nothing in the log but "capturing".
**Cause**: `SCStream` is change-driven. `minimumFrameInterval` is a *ceiling* on frame rate, not a heartbeat — a window whose content is not moving delivers one frame and then silence. Any stability test phrased as "the same picture N times in a row" therefore cannot fire on the exact thing it is meant to detect: a slide holding still is silence, not repetition.
**Diagnostic**: log every `didOutputSampleBuffer` with its `SCStreamFrameInfo.status`. A static window shows a burst at attach and then nothing; a moving one shows a steady stream. If frames stop arriving the moment the picture settles, this is it.
**Solution**: invert the test into a debounce. Hold the most recent frame, and treat the ABSENCE of a newer one for `stabilityMs` as the picture having settled. Motion keeps pushing the timer out; stillness lets it fire. As a bonus this is also what separates slides from talking heads without any face detection.
**Second trap in the same callback**: SCK interleaves `idle`, `blank` and `suppressed` frames with real ones. Encode without checking `SCStreamFrameInfo.status == .complete` and a "slide" turns out to be a grey rectangle.
**Third trap**: a `CVPixelBuffer` is valid only for the life of the callback, but under a debounce the decision to KEEP a frame happens later. Render a detached `CGImage` inside the callback and carry that; reaching back for the buffer afterwards is a use-after-free.
**Pattern**: `native/sck-slide-capture/Sources/SlideCapture.swift` → `scheduleSettle` / `settle`, `FrameHasher.reduce`.

## Lifecycle Management

- **SUPERSEDED**: When a gotcha is resolved, mark it: `## #N: [Title] ~~SUPERSEDED~~`
- **Numbering**: Original numbers are permanent — gaps are intentional. Never renumber.
- **Categories**: Environment, Backend, Frontend, Security, Deployment

### 20. The Careful Path Went Quiet and the Careless One Answered in Its Place

`services/speakerNames.js` is scrupulous: it renders nothing when it knows
nothing, and tells the model that a wrongly attributed quote is worse than an
unattributed one. On 2026-08-21 it worked exactly as designed — the OCR read no
names, so `speakerTimeline` was `[]` and the block was the empty string.

The note still claimed an attendance list. The roster from
`meetingContext.participants` was being rendered as `- Participants: A, B`
next to a `## Participants` section to fill in, under the instruction "use real
participant names where possible". So the summary asserted that two named people
attended a client meeting. One of them has no attributable line in the whole
transcript, and the dominant voice belonged to a fourth person who was never in
the roster at all.

**Two paths fed the same output and only one had the guard.** Ask of any safety
property: which inputs does it cover, and what else reaches the same sentence?
A guard on the honest path is worth nothing while an unguarded path can answer
the same question.

**The second half is just as important.** The first fix told the model not to
over-list, and it swung the other way: it listed "Charlie" (Chris mis-heard
saying hello) and "Sagan" ("say again") as participants. Refusing to fabricate
is not the same as knowing what to say. The block now also states that a name
appearing once, matching nobody invited and never recurring, is more likely a
mis-transcription than a person.

**Fixed:** `services/meetingContextBlock.js`, verified by re-summarising the real
2026-08-21 session against the real (wrong) roster — the note went from asserting
two absent attendees to "Evan Lewis — addressed in the transcript" plus
"Unidentified Audience participant(s)".

### 21. A Mail-Derived Calendar Cannot See Anyone Who Did Not RSVP to a Meeting You Called

`cxmailCalendarSource` builds its roster from `text/calendar` parts on messages
in the mailbox. For an invitation you RECEIVE that is a `METHOD:REQUEST` and
carries everyone. For one you SEND it is not: the server mails the REQUEST to
the invitees, never back to you, so the only calendar messages that arrive are
`METHOD:REPLY`s — and RFC 5546 says a REPLY carries only the responder's own
`ATTENDEE` line.

So on your own meetings the roster is exactly "the people who replied". Verified
on the 2026-08-21 event: two rows in `calendar_events`, both `METHOD:REPLY`, one
attendee each; no sent invitation anywhere in `[Gmail]/Sent Mail`. Two invitees
never RSVP'd and were invisible, one of them the client principal who did the
most talking.

**No parsing change fixes this — there is no message to parse.** EventKit has
them, because it syncs the event rather than inferring it from mail. Confirmed
against the same event in `Calendar.sqlitedb`: all five participants with live
RSVP status.

**The tell:** a roster that is always a subset of the invite list, and always
exactly the people who accepted. It looks like a complete small meeting.

**Fixed:** `services/calendarSources/attendeeMerge.js` unions EventKit's roster
into cxmail's events, additive only, and refuses to enrich an ambiguous match.
`FallbackCalendarSource.ensurePermission()` settles the EventKit permission while
cxmail is active, so the one-time dialog lands at app start rather than in front
of the Record button. Note this completes the INVITED list; it does not identify
who spoke — that is the speaker-naming path.

### 22. Return Does Nothing on a Focused Button While Option Is Held — Chromium Sends No `keypress`

**Symptom**: in the note menu, arrow onto an item, hold Option so it reads
**Copy Note Path**, press Return: nothing. Release Option and Return works
again. No error, no console output.
**Cause**: a `<button>`'s Return activation is implemented on the `keypress`
event, and Chromium dispatches **no `keypress` at all** for a key struck with
Alt/Option down — only `keydown`. Measured 2026-09-08 in the renderer harness:
plain Return produced `keydown` → `keypress` → `click`; Option+Return produced
`keydown` and stopped. So any keyboard-driven control that shows an Option
variant has a dead keyboard path in exactly the state the variant exists for.
The mouse never noticed, because `click` does not ride on `keypress`.
**Diagnostic**: log `keydown` and `keypress` on `document`. A `keydown` with
`altKey: true` and no `keypress` after it is this.
**Solution**: activate from `keydown` yourself — on Enter/Space, `preventDefault()`
and `btn.click()` the focused item. Cancelling the keydown also suppresses the
browser's own activation, so the plain (no-Option) case fires exactly once
rather than twice; the harness asserts both counts.
**Pattern**: `renderer/menubar-panel.html` → the `noteMenu` `keydown` handler.

### 23. The Silence Trim Cut Both Ends and Recorded One Total — and a Companion Transcript Missing the Mic Side Was Filed as Complete

**Symptom**: 2026-09-25. Meeting Copilot's mic died 28 s into a call, so the
shared transcript CXNotes used in companion mode held only the other side. The
note was filed as a complete record. CXNotes' own `mic.wav` held every word, and
lining it up by hand against the companion's clock needed an unexplained
−59.5 s correction.
**Cause**: two, independent.
1. Companion mode trusted the shared transcript whenever it had *any* segments.
   Nothing compared it with the audio CXNotes had recorded itself.
2. `trimSilence` ran sox's `silence … reverse silence … reverse`: it cut
   leading AND trailing silence, and `silenceTrimmed.savedBytes` was the total.
   The 09-25 mic track lost 43.4 s off its head and 59.5 s off its tail,
   reported as one 102.9 s figure, so nothing could say where sample 0 had
   been. The same trim also shifted each track's offsets relative to the
   other's in CXNotes' own two-track merge (the "known wrinkle" the stitched
   path worked around).
**Solution**: `trimSilence` is trailing-only and records `edge: 'trailing',
leadingSec: 0` (`trimSilenceArgs` has no `silence` effect before the first
`reverse`). Companion mode now goes through `services/companionCoverage.js`:
own mic speech regions from frame energy, the companion clock placed by the
presence file's `startedAt` and checked by fit (own turns must fall between the
other side's; >30 % overlap, or on a wide scan a best that is not clearly
better than typical or has a rival 5 s away, is refused). No companion mic
lines, or a ≥ 60 s companion stretch without one holding ≥ 10 s of own speech
→ CXNotes transcribes its own `mic.wav` and merges it with the companion's
meeting side (`companion:<app>+own-mic`). No fit → its own full two-track
transcription. The decision lands in `manifest.processing.transcription.companionCheck`,
and a deterministic `[!info]` header on the note says the mic side was rebuilt.
Validated on the real 09-25 session: offset 581.9 s against the hand fit's
581.8 s, 18 % overlap.
**Check**: `services/companionCoverage.test.js`, `services/transcriber.companion.test.js`
(fails on the old transcriber), `utils/audioProcessing.test.js` (trim keeps the head).
**Pattern**: `services/companionCoverage.js`, `services/transcriber.js` → `assessCompanion()` / `mergeCompanionWithOwnMic()`,
`utils/audioProcessing.js` → `trimSilence()`, `services/silentTrackNotice.js` → `buildOwnMicNotice()`.


### 24. Phone and FaceTime Calls Are Invisible to ScreenCaptureKit — and the Probe Says the Capture Is Fine

**Symptom**: a note of an iPhone call answered on the Mac, or a FaceTime call, holds only your side. No warning anywhere. `system.wav` holds CXNotes' own start probe, about a second of 440 + 480 Hz ringback, and then nothing.
**Evidence (2026-09-25, T206)**: a voicemail call via handoff + AirPods, session `2026-09-25_19-16-09`. The `callservicesd` log put the call connecting at +12.2 s and ending at +23.4 s; nothing in that window of `system.wav` rose above sox's 0.1% trim threshold (≈ -60 dBFS). A Core Audio process watcher showed why: the ringback comes from the FaceTime **app** (`out=1` for ~5 s), which ScreenCaptureKit hears, but the connected call comes from the **daemon** `avconferenced` (`in=1 out=1` for exactly the 16 s of the call), which it does not — with either filter shape. Meeting Copilot hit the same thing with its per-app filter (its gotcha #20).
**Why nothing caught it**: the start probe plays through `afplay`, which the display mix hears, so capture is judged healthy; the probe then overrules the silence watcher (invariant #23). The capture is genuinely working — it just cannot see the process the call is in.
**Solution**: `native/call-audio-tap`, strictly additive — invariant #26. It watches `avconferenced`'s `kAudioProcessPropertyIsRunningOutput` and taps it only while it reads 1. Through a solo Zoom (mic + camera) and a solo Meet the daemon stayed at 0, so normal meetings never get a tap.
**Landmines** (most inherited from Meeting Copilot, `SystemAudioTap.swift`):
- **Tap-only aggregate.** Listing the output device as a subdevice puts its INPUT streams (a headset mic) ahead of the tap in the buffer list — your voice on the other side's track.
- **`.unmuted` only.** `.mutedWhenTapped` on `avconferenced` mutes the call itself.
- **Permission is invisible.** Without `NSAudioCaptureUsageDescription` in the responsible app's Info.plist the tap delivers exact zeros with `noErr` and no prompt, and a DENIED grant looks the same; no API reads it. Running the helper from a terminal reproduces this, because the terminal is the responsible app — verified: a 22 s segment of an `afplay` tone came back peak 0. The helper emits `silent-tap` after 20 s of zeros during a call; that warning is the only symptom.
- **The first-ever tap blocks.** Measured ~30 s inside `AudioDeviceCreateIOProcIDWithBlock` plus the time the prompt stays up. Hence `--request-access` when the setting is switched on.
- **AirPods drop to a call rate** (16/24 kHz) without the default output device changing. The helper starts a new segment when the aggregate's nominal rate changes, and `effectiveSampleRate` corrects a segment whose frame count disagrees with its header by more than 25%.
- **`IsRunningOutput` means the IO is running, not that anything is audible.** A process playing silence reads 1.
- **The daemon is listed even when idle** (macOS 14.5), so a per-process tap can be built before a call starts; `--request-access` relies on that.
**Check**: `services/callCapture.test.js` (real sox: call at its offset, every other sample bit-identical); the call-audio tests at the end of `services/recorder.test.js` (no call → `system.wav` byte-identical through the real `stop()`). On a device: a voicemail call must put the greeting in the transcript; `manifest.callAudio.segments` must be `[]` for a Meet or Zoom session.
**Pattern**: `native/call-audio-tap/Sources/` (`CallTap.swift`, `main.swift` → `CallWatcher`, `WavWriter.swift`, `CoreAudioProcesses.swift`); `services/callCapture.js`; `services/recorder.js` → `_finishCallAudio()`.
