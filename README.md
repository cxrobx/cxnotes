# CXNotes

A macOS menu-bar app that records meetings, transcribes them locally, and writes
speaker-aware notes into an Obsidian vault.

Everything that touches audio happens on the machine. Recording is local,
transcription is local, and the only text that leaves is whatever you send to a
summarisation CLI you have already installed and logged into yourself.

Source available under the [Business Source License 1.1](LICENSE): free for personal
use and for use inside your own organisation, Apache-2.0 from 2030-09-30.

---

## What it does

Click the menu-bar icon and it captures two separate audio tracks: everything
coming out of your speakers (the other people on the call) and everything going
into your microphone (you). Keeping them apart is the whole trick — it is what
lets the notes say who said what, without any speaker-diarisation guesswork.

When you stop, it transcribes both tracks, interleaves them into one timestamped
transcript labelled `Remote:` and `Me:`, and asks a local or CLI-based model for
structured notes. The result is filed into the right folder of your vault.

```
  ┌─ system audio ──► ScreenCaptureKit ──► system.wav ──┐
  │                   (or BlackHole + sox)              │
  │                                                     ├──► merged transcript ──► notes.md ──► vault
  └─ microphone ────► sox ─────────────────► mic.wav ───┘
                                             ▲
                                    Parakeet or whisper.cpp,
                                     both entirely on-device
```

### Beyond the basic loop

- **Calendar-aware.** Reads upcoming meetings from CXMail's store or macOS
  EventKit, offers a one-click record with the title, attendees and agenda
  already filled in, and lists what is coming up in the tray menu.
- **Live markers.** `⌘⇧M` timestamps a moment while you are recording. Flagged
  moments get their own section in the summary.
- **Auto-filing.** Notes are routed to a vault folder by a deterministic scorer,
  falling back to the model, falling back to a triage prompt, falling back to a
  catch-all. A note is never lost to a filing failure.
- **Silence auto-stop.** Judges silence per-track, so one dead capture cannot
  keep a finished meeting recording for hours. Always prompts; never stops
  silently.
- **Provider fallback.** Codex → Claude → Ollama, configurable, with a guard
  that catches usage-limit and bad-model refusals which the CLIs print to stdout
  with a zero exit code.
- **An MCP server** (`mcp/`) that can prepare meetings ahead of time with the app
  closed, handing off through the filesystem.

## Requirements

| | |
|---|---|
| macOS | 13 Ventura or newer (ScreenCaptureKit) |
| Node.js | 20+ (24+ to run the test suite) |
| Homebrew | for sox and cmake |
| BlackHole 2ch | only as a fallback if ScreenCaptureKit is unavailable |
| A summariser | one of `codex`, `claude`, or `ollama` |

Apple Silicon is strongly preferred — transcription runs several times faster
than real time on it.

## Install

```bash
npm install
./setup.sh        # sox, cmake, whisper.cpp + model, Swift helpers, Parakeet
npm start
```

`setup.sh` is idempotent — re-running it after a partial or failed install is
safe. It pauses if BlackHole is missing, because installing that driver also
requires a manual Audio MIDI Setup step it cannot do for you.

Then install **one** summariser:

```bash
npm install -g @openai/codex               # OpenAI subscription
npm install -g @anthropic-ai/claude-code   # Anthropic subscription
brew install ollama && ollama pull llama3.2  # free, never leaves the machine
```

### The BlackHole step, if you need it

ScreenCaptureKit handles system audio on its own and needs no routing. BlackHole
is only the fallback, and installing it is not enough by itself — system output
has to be *routed through* it:

1. Open **Audio MIDI Setup**
2. Create a **Multi-Output Device**
3. Tick both your speakers and **BlackHole 2ch**
4. Select that Multi-Output Device as your system output

Skipping step 4 is the single most common reason a system track comes back
silent: the driver is installed, so everything reports healthy, and nothing is
being fed into it.

## Using it

**Left-click** the menu-bar icon for the panel — start/stop, the next meeting,
live levels, per-track health, markers, and recent notes with where they were
filed. **Right-click** for the full menu.

While recording, the menu bar shows elapsed time and a live level meter per
track. A track that stops producing audio turns red *during* the meeting rather
than being discovered afterwards.

### What you get

```
recordings/2026-08-07_14-23-45_session/
  manifest.json         session metadata, track health, filing decision
  system.wav  mic.wav   the two raw tracks
  markers.json          moments you flagged
  meeting-skeleton.md   your own live notes, if a calendar event seeded it

processed/2026-08-07_14-23-45_session/
  system_transcript.txt  mic_transcript.txt
  merged_transcript.txt  speaker-labelled and timestamped
  notes.md               the summary, also exported to the vault
```

### Filing and naming to your own vault

Out of the box a note is exported as `<Who|Topic> <MM.DD.YY>.md` and filed by
the summariser's best guess, into `Inbox/` when it is unsure, or into
`Meetings/` when there is nothing to go on. CXNotes ships with no folders,
clients or names of its own. Everything that is true of only your vault goes in
two settings, in `~/Library/Application Support/cxnotes/config.json` (quit the
app before editing; it reads them at start-up):

```json
{
  "vaultFilingRules": [
    { "id": "acme", "destination": "Projects/Clients/Acme/Meetings",
      "keywords": ["acme", "acme consulting"], "people": ["dominic"] }
  ],
  "vaultProfile": {
    "selfNames": ["alex", "alex doe"],
    "filingStopwords": ["alex"],
    "categoryByDestination": [
      { "folder": "Projects/Clients/Acme/Meetings", "code": "ACM" }
    ],
    "categoryByContent": [
      { "code": "BD", "keywords": ["business development", "biz dev"] }
    ],
    "discoveryGroups": [
      { "parent": "Projects/Clients", "subdirs": ["Meetings", "Calls"] }
    ]
  }
}
```

- `vaultFilingRules`: a keyword or person that points a note at a folder.
- `selfNames`: you, so your own name never takes up room in a filename.
- `filingStopwords`: words in every filename that say nothing about where a
  note belongs, usually your first name.
- `categoryByDestination`: the short code a folder stamps on a filename
  (`ACM Dominic 09.08.26.md`). The longest matching folder wins.
- `categoryByContent`: codes a note in an uncoded folder can earn from its
  title or attendees. First match wins, so list specific codes first.
- `discoveryGroups`: parent folders whose children are filing destinations
  without a rule each, so a new client is just a new folder.

Every field is optional, and a malformed entry is ignored rather than breaking
an export.

## Development

```bash
npm start          # run from source
npm test           # 497 tests, plain node --test, no framework
npm run build      # Swift helpers, then a signed .app + dmg
npm run summaryonly <transcript>   # re-summarise without re-transcribing
npm run mcp:check  # diagnose the MCP server's calendar permissions
```

The test suite needs **Node 24+** — on Node 20 the glob in the test script
matches nothing and it silently reports zero tests. `npm test` also runs a
British-English spelling gate first.

### Layout

| Path | |
|---|---|
| `main.js` | Electron main process — tray, windows, IPC, recording orchestration |
| `renderer/` | Settings window, menu-bar panel, prompts, and their preloads |
| `services/` | Everything with logic in it, and where the tests live |
| `services/calendarSources/` | CXMail and EventKit adapters behind one interface |
| `utils/` | Audio device enumeration, binary resolution, WAV repair |
| `native/` | Two Swift CLIs: ScreenCaptureKit capture, EventKit calendar |
| `mcp/` | Standalone MCP server — no Electron, no ports, stdio only |
| `shared/` | Paths and helpers used by both the app and the MCP server |
| `scripts/` | Maintenance and one-off tooling |

Most of the interesting logic is deliberately pure and Electron-free so it can be
tested without launching an app. The Electron files are meant to be thin.

### Before changing anything

Read `.claude/rules/architecture.md` and `.claude/rules/gotchas.md` (short
digests; the full text of each entry is in `docs/architecture.md` and
`docs/gotchas.md`). They hold the invariants that are not obvious from the code
and the failures that have already cost someone a debugging session — silent ScreenCaptureKit zero-fill,
orphaned sox processes starving the microphone, a Dock-launched app having no
Homebrew on its PATH, and a CSS mistake that makes a broken pane look *better*
than a correct one.

## Troubleshooting

| Symptom | Look at |
|---|---|
| System track silent, correct file size | gotchas #5 — ScreenCaptureKit zero-fill has two distinct causes |
| Both tracks silent | gotchas #6 — usually two independent failures stacked |
| Microphone silent on a new recording | gotchas #4 — orphaned sox from a previous crash |
| Dependencies "missing" that are installed | gotchas #14 — a Dock-launched app has a minimal PATH |
| Notes contain a provider error instead of a summary | gotchas #12 — re-summarise, do not re-transcribe |
| Calendar meetings not appearing | gotchas #9 — CXMail store shape and confidence threshold |

## Privacy

Audio never leaves the machine. Recording, transcription and merging are all
local, and transcripts are deleted on your retention schedule while notes are
kept indefinitely.

Summarisation is the one step that may involve a network call, and only through
a CLI you installed and authenticated yourself — your account, your terms.
Choosing Ollama keeps that step local too, at which point nothing leaves the
machine at any stage.
