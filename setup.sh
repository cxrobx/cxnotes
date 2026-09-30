#!/bin/bash
#
# CXNotes dependency installer.
#
# Idempotent by design: every step checks for what it needs before doing
# anything, so re-running after a partial or failed setup is safe and cheap.
#
# Only two conditions are fatal — not macOS, and no Homebrew — because every
# later step depends on one or the other. Everything else degrades to a warning
# and lets setup finish, since a missing Swift toolchain or a missing `uv` costs
# you one optional capability rather than the app.
#
# Covered by setup.test.js, which runs this against stubbed commands.

# ── output helpers ───────────────────────────────────────────────────────────

step()  { echo "$1 $2"; }
ok()    { echo "✅ $1"; }
warn()  { echo "⚠️  $1"; }
blank() { echo ""; }

fatal() {
  echo "❌ $1"
  exit 1
}

has() { command -v "$1" &> /dev/null; }

# ── preconditions ────────────────────────────────────────────────────────────

echo "CXNotes - Setup"
echo "================================"
blank

[[ "$OSTYPE" == "darwin"* ]] || fatal "This app requires macOS"
has brew || fatal "Homebrew not found. Install from: https://brew.sh"

ok "macOS and Homebrew detected"
blank

# ── sox: microphone capture ──────────────────────────────────────────────────

step "📦" "Installing sox..."
if has sox; then
  ok "sox already installed ($(sox --version | head -n1))"
else
  brew install sox
  ok "sox installed successfully"
fi
blank

# ── sck-audio-capture: THE system-audio path ─────────────────────────────────
#
# There is no BlackHole check here any more, and no virtual audio device to
# configure. System audio is ScreenCaptureKit, full stop — the sox+BlackHole
# fallback was removed because it could not fail loudly (it recorded silence
# whenever system output was not routed through a Multi-Output Device).
#
# Which makes this build step load-bearing rather than optional: without the
# binary there is nothing left to fall back TO, and recording refuses to start.
# `npm run build` gets here via prebuild, but `npm start` does not, so a
# from-source install that skipped this had no working capture at all.
#
# Mirrors package.json's `build:sck`. Kept in step with it by hand, the same
# way the calendar-helper block below mirrors `build:calendar`.

SCK_HELPER_DIR="native/sck-audio-capture"
SCK_HELPER_BINARY="$SCK_HELPER_DIR/.build/release/sck-audio-capture"

step "🔨" "Building sck-audio-capture (system audio via ScreenCaptureKit)..."
if [ ! -d "$SCK_HELPER_DIR" ]; then
  warn "$SCK_HELPER_DIR/ not found"
elif ! has swift; then
  warn "swift not available — install Xcode Command Line Tools to build sck-audio-capture"
else
  ( cd "$SCK_HELPER_DIR" && swift build -c release \
    && codesign -f -s - \
      --identifier com.christopherrobinson.sck-audio-capture .build/release/sck-audio-capture )

  if [ -f "$SCK_HELPER_BINARY" ]; then
    ok "sck-audio-capture built and signed"
  else
    warn "sck-audio-capture build did not produce a binary — system audio will not record"
  fi
fi
blank

# ── cmake: required to compile whisper.cpp ───────────────────────────────────

step "📦" "Checking for cmake..."
if has cmake; then
  ok "cmake already installed"
else
  step "📥" "Installing cmake..."
  brew install cmake
  ok "cmake installed"
fi
blank

# ── whisper.cpp: the transcription fallback ──────────────────────────────────

WHISPER_CMAKE_BINARY="whisper.cpp/build/bin/whisper-cli"
WHISPER_LEGACY_BINARY="whisper.cpp/main"

step "📦" "Setting up whisper.cpp..."
if [ -d "whisper.cpp" ]; then
  ok "whisper.cpp directory already exists"
else
  step "📥" "Cloning whisper.cpp repository..."
  git clone https://github.com/ggerganov/whisper.cpp.git
fi

# Either build layout counts as compiled: CMake puts the binary under
# build/bin/whisper-cli, the older Makefile produced ./main.
if [ -f "$WHISPER_CMAKE_BINARY" ] || [ -f "$WHISPER_LEGACY_BINARY" ]; then
  ok "whisper.cpp binary already compiled"
else
  step "🔨" "Compiling whisper.cpp..."
  # A subshell, so a failed cd cannot leave the rest of setup running in the
  # wrong directory.
  ( cd whisper.cpp && make )

  if [ -f "$WHISPER_CMAKE_BINARY" ]; then
    ok "whisper.cpp compiled successfully (CMake build)"
  elif [ -f "$WHISPER_LEGACY_BINARY" ]; then
    ok "whisper.cpp compiled successfully (Makefile build)"
  else
    echo "❌ whisper.cpp did not build - the errors above say why"
  fi
fi
blank

# ── the whisper model ────────────────────────────────────────────────────────

WHISPER_MODEL="whisper.cpp/models/ggml-base.en.bin"

step "📥" "Checking for whisper model..."
if [ -f "$WHISPER_MODEL" ]; then
  ok "Whisper model already downloaded"
else
  step "📥" "Downloading base.en model (this may take a while)..."
  ( cd whisper.cpp && bash ./models/download-ggml-model.sh base.en )
  ok "Whisper model downloaded"
fi
blank

# Install the model where BOTH a dev run and the packaged app can find it.
#
# The repo's own models/ directory is unreachable from inside a packaged .app
# (__dirname points into the bundle, and a Dock-launched app's cwd is /), and
# the model is ~141 MB so it cannot be bundled. Application Support is the one
# location that works for both — must match getModelsDir() in
# services/transcriber.js.
APP_MODELS_DIR="$HOME/Library/Application Support/CXNotes/models"
mkdir -p "$APP_MODELS_DIR" models

if [ -f "$APP_MODELS_DIR/ggml-base.en.bin" ]; then
  ok "Model already installed for the app"
else
  step "📋" "Installing model to $APP_MODELS_DIR ..."
  cp "$WHISPER_MODEL" "$APP_MODELS_DIR/"
  ok "Model installed"
fi

# Keep the repo copy too, so `npm start` works without touching Application
# Support and the standalone scripts behave as before.
if [ ! -f "models/ggml-base.en.bin" ]; then
  cp "$WHISPER_MODEL" models/
fi
blank

# ── calendar-helper: the EventKit CLI ────────────────────────────────────────
#
# Signed with an explicit identifier because macOS keys the Calendar permission
# grant to the binary's code signature — an unsigned or differently-signed
# helper is a different file to TCC and re-prompts (gotcha #7).

CALENDAR_HELPER_DIR="native/calendar-helper"
CALENDAR_HELPER_BINARY="$CALENDAR_HELPER_DIR/.build/release/calendar-helper"

step "🔨" "Building calendar-helper (EventKit CLI)..."
if [ ! -d "$CALENDAR_HELPER_DIR" ]; then
  warn "$CALENDAR_HELPER_DIR/ not found"
elif ! has swift; then
  warn "swift not available — install Xcode Command Line Tools to build calendar-helper"
else
  ( cd "$CALENDAR_HELPER_DIR" && swift build -c release \
      -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
      -Xlinker "$PWD/Info.plist" \
    && codesign -f -s - --entitlements CalendarHelper.entitlements \
      --identifier com.christopherrobinson.calendar-helper .build/release/calendar-helper )

  if [ -f "$CALENDAR_HELPER_BINARY" ]; then
    ok "calendar-helper built and signed"
  else
    warn "calendar-helper build did not produce a binary"
  fi
fi
blank

# ── Parakeet: the default transcription backend ──────────────────────────────
#
# Parakeet-TDT (via parakeet-mlx) is the default transcriber — best local
# accuracy on meeting speech, fully on-device. Runs via `uv`; whisper.cpp stays
# as the automatic fallback. Force whisper with CXNOTES_TRANSCRIBER=whisper.

PARAKEET_MODEL="mlx-community/parakeet-tdt-0.6b-v3"

step "🦜" "Setting up Parakeet (default transcription backend)..."
if has uv; then
  echo "  uv found: $(command -v uv)"
  echo "  Pre-pulling the Parakeet model (parakeet-tdt-0.6b-v3, ~2.3GB)..."
  if uvx --from parakeet-mlx python -c \
      "from parakeet_mlx import from_pretrained; from_pretrained('$PARAKEET_MODEL'); print('ok')" \
      > /dev/null 2>&1; then
    echo "  ✅ Parakeet model ready."
  else
    echo "  ⚠️  Parakeet model pre-pull failed — it will download on first transcription."
  fi
else
  echo "  ⚠️  'uv' not installed — Parakeet needs it; transcription falls back to whisper.cpp."
  echo "      Install:  curl -LsSf https://astral.sh/uv/install.sh | sh"
fi
blank

# ── what to do next ──────────────────────────────────────────────────────────

echo "================================"
ok "Setup complete!"
blank
echo "Still to do:"
echo "  1. Grant Screen Recording the first time you record - System Settings >"
echo "     Privacy & Security > Screen Recording. That grant is the ONLY way"
echo "     the other side of a call gets captured; without it, recording"
echo "     refuses to start rather than saving a silent track."
echo "  2. Install ONE summarisation CLI (pick per Settings > Notes & filing):"
echo "       Codex:  npm install -g @openai/codex          (OpenAI subscription)"
echo "       Claude: npm install -g @anthropic-ai/claude-code  (Anthropic subscription)"
echo "       Ollama: brew install ollama && ollama pull llama3.2  (free, fully local)"
echo "  3. Start it with: npm start"
echo "  4. The icon appears in the menu bar - click it to record"
blank
echo "Something not working? README.md has the troubleshooting section."
echo "================================"
