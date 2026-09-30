# Changelog

All notable changes to CXNotes will be documented in this file.

## [Unreleased]

### Changed
- 2026-09-30: **Licensed under the Business Source License 1.1 (personal and internal use; Apache-2.0 from 2030-09-30), and nothing about one person's vault is in the code any more.** The filing rules, the folder and content category codes, the user's own names and the auto-discovery folders were literals in `services/noteFiler.js` and `services/summariser.js`. They now come from two settings, `vaultFilingRules` and the new `vaultProfile` (`services/vaultProfile.js`), and both are empty on a fresh install: notes are named without a category and filed by the LLM tier, the Inbox or the catch-all. `summarise-only.js` and `scripts/file-root-notes.js` read the same settings, so a script files and names a note the way the app would. An install that relied on the old built-in rules keeps its behaviour only once those rules are in its settings. See README → *Filing and naming to your own vault*.

### Fixed
- 2026-09-25: **A companion transcript that is missing your side is no longer filed as complete.** Meeting Copilot's mic died 28 s into a call and its shared transcript held only the other side; CXNotes used it as-is while its own `mic.wav` held every word. Companion mode now checks the shared transcript against CXNotes' own mic recording (`services/companionCoverage.js`): when the companion has no mic lines, or a minute-plus stretch without one while you were talking, CXNotes transcribes its own mic track and merges it with the companion's meeting side on the companion's clock — placed from the presence file's `startedAt` and verified by fit, falling back to its own full transcription when the fit is poor. The note says so in a deterministic header. Gotcha #23.
- 2026-09-25: **The silence trim no longer moves the start of a track.** `trimSilence` cut leading *and* trailing silence and recorded one total, so a trimmed track lost its clock (the 09-25 mic track: 43.4 s off the head, 59.5 s off the tail, recorded as 102.9 s). It now trims the tail only and records `edge: 'trailing'`.

### Added
- 2026-09-25: **A durable log file** at `~/Library/Logs/CXNotes/cxnotes.log` (5 MB, three rotations): every main-process console line, timestamped, plus a named trigger for every recording start (`manual`, `meeting-banner-confirm`, `calendar-upcoming`) and a named reason for every stop (`tray-menu`, `menubar-panel`, `settings-window`, `silence-auto-stop`, `silence-prompt-stop-now`, `capture-check-dialog`, `app-quit`), the silence prompt and its answer, and every user deletion. Whisper's stdout echo (transcript text) is kept out of the file.

### Fixed (earlier)
- 2026-08-21: **A meeting summary no longer turns a guest list into an attendance record.** `meetingContext.participants` was rendered into the prompt as `- Participants: A, B` beside the `## Participants` section the model had to fill in, so an invite list became an assertion that those people were there — while the `speakerNames` block, which refuses to guess, correctly said nothing. Two paths fed the same sentence and only one carried the guard. New `services/meetingContextBlock.js` labels the list "Invited (NOT an attendance record)", requires the Participants section to come from the transcript, and warns that a one-off name matching nobody invited is probably a mis-transcription (the first cut of the fix listed "Charlie" and "Sagan" as attendees). Verified by re-summarising the real 2026-08-21 session against its real roster. Gotcha #20.
- 2026-08-21: **Invitees who never RSVP'd are no longer invisible on meetings you organise.** A mail-derived calendar only ever receives `METHOD:REPLY`s for your own invitations, and RFC 5546 puts a single attendee in each, so the roster silently reduced to "whoever accepted". New `services/calendarSources/attendeeMerge.js` completes it from EventKit, which syncs the event itself: additive only, never overriding, and refusing an ambiguous time-and-title match outright. `FallbackCalendarSource` now settles the EventKit permission while cxmail is active (one-time dialog at app start, not at Record), caches the fetched roster for 60s so polling costs no extra helper spawns, and degrades to the un-enriched list on any failure. Gotcha #21.

### Added
- 2026-08-20: **Slide capture, slide OCR, and on-screen speaker names** — the three things a hosted notetaker keeps that a local recorder was throwing away. New `native/sck-slide-capture/` Swift helper, separate from the audio one so slides can never take audio down with them (invariant #24). Captures keyframes from exactly ONE window — the one the meeting audio belongs to — resolving natively (Zoom/Teams/Webex/FaceTime), by window title for browser meetings, or to the window being presented FROM while the user is sharing; anything ambiguous captures nothing and says why in the manifest. `--ocr` reads the keyframes with Vision at processing time, cached to `slides.json`. A periodic sampler writes `screen_text.csv`, which `services/speakerNames.js` turns into a timeline of who the meeting app was SHOWING, matched against the meeting roster. Slide text and speaker names reach the summariser as prompt blocks that follow the markers contract — empty when there is nothing to say, so a session without them produces a byte-identical prompt. New setting `slideCaptureEnabled`, off by default. New diagnostics `--probe`, `--list-windows`, `--window-title`.

### Fixed
- 2026-08-20: **A bled mic track no longer doubles the merged transcript.** An open speaker (or AirPods next to one) puts the remote audio onto the mic track, so whisper transcribed the same speech twice and the merge emitted every line under both labels — which the summariser read as the local user having SAID the remote side's words, filing the note with nothing attributed to them. `services/transcriptMerger.js` now suppresses the mic's copy in two passes: a strict pairing that is safe on every session, and a relaxed containment pass that runs ONLY once the strict pass has proven the track is compromised. Short fragments are dropped only where the bleed is dense, which is what preserved 42 lines of a genuine second conversation the mic also carried. Measured on the 2026-08-20 seminar: 476 of 528 bled entries removed, the unrelated meeting kept intact.

### Added (2026-05-14)
- 2026-05-14: Calendar-aware note-taking suggestions. New `native/calendar-helper/` Swift CLI queries macOS EventKit (request-access / upcoming / current). `services/calendarSuggester.js` polls every 60s, filters events (≥2 attendees, not all-day, not declined, not in user denylist), and fires a pre-meeting banner at a configurable lead time (default 2 min). `services/dismissalRegistry.js` is now the single source of truth for banner dismissals — the meeting detector consults it through the calendar `occurrenceFingerprint` when an enricher hit lines up a Zoom/FaceTime/Meet detection with the current calendar event. Pre-record popup is seeded from the calendar event's title, attendees, and notes when "Take notes" is clicked on an enriched banner. New settings: `calendarSuggestionsEnabled`, `calendarLeadTimeMinutes`, `calendarDenylist`, `calendarDismissedFingerprints`. New entitlement `com.apple.security.personal-information.calendars` + `NSCalendarsUsageDescription` / `NSCalendarsFullAccessUsageDescription` usage strings on both the app and the helper.

### Fixed
- 2026-04-21: System audio silently captured zero-filled frames when Rogue Amoeba's `ARK.driver` was loaded in coreaudiod. Switched `SCContentFilter(display:excludingWindows:)` to the per-app `SCContentFilter(display:including:exceptingWindows:)` shape in `native/sck-audio-capture/Sources/AudioCapture.swift`. SCK no longer pulls from the display-mix audio path that ARK can hijack.

### Added (earlier)
- 2026-04-21: Gotchas #5 (SCK ARK-driver zero-frames) and #6 (compound "both tracks silent" diagnostic ritual) in `.claude/rules/gotchas.md`. Expanded #4 (orphaned sox) with mic-contention failure mode and recovery commands.
- 2026-03-08: Compound documentation infrastructure (CLAUDE.md, .claude/rules/, docs/, /documenter command)

## [1.0.0] - 2026-03-08

### Added
- Dual-track recording (system audio + microphone) with speaker separation
- whisper.cpp transcription with per-track CSV output
- Transcript merger combining tracks with speaker labels (Remote/Me)
- Speaker-aware summarisation via Ollama
- macOS menu bar tray app with settings window
- Audio device detection and preflight checks
- Configurable recording mode (system-only or dual-track)
- Session directory structure with manifest.json
- Auto-cleanup of old recordings (configurable retention)
- macOS entitlements for microphone access
