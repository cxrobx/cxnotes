#!/bin/bash
#
# CXNotes dependency installer for the PACKAGED app.
#
# The repo's setup.sh assumes a source checkout: it clones and compiles
# whisper.cpp, builds the native helpers, and installs the model out of the
# build tree. None of that exists on a user's machine — the helpers already
# ship inside CXNotes.app, and there is no repo to cd into (a packaged app's
# __dirname points inside app.asar, a packed archive file). This script is
# what "Run Setup" launches from an installed app: it installs only what the
# bundle cannot carry, from places a user's Mac can actually get them.
#
# It ships via electron-builder extraResources and is run with `bash`, so it
# never needs an execute bit and nothing writes into the signed bundle.
#
# Idempotent by design, like setup.sh: every step checks before acting, so
# re-running after a partial or failed setup is safe and cheap.
#
# Covered by setup-packaged.test.js, which runs this against stubbed commands.

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

echo "CXNotes - Setup (installed app)"
echo "================================"
blank

[[ "$OSTYPE" == "darwin"* ]] || fatal "This app requires macOS"
has brew || fatal "Homebrew not found. Install it first from: https://brew.sh"

ok "macOS and Homebrew detected"
blank

# ── sox: microphone capture ──────────────────────────────────────────────────

step "📦" "Installing sox (microphone recording)..."
if has sox; then
  ok "sox already installed ($(sox --version | head -n1))"
else
  brew install sox
  ok "sox installed"
fi
blank

# ── Parakeet: the default transcription backend ──────────────────────────────
#
# Parakeet-TDT (via parakeet-mlx) runs through `uv` — installing uv is all the
# app needs. The model is pulled on first use; pre-pulling it here means the
# first meeting does not wait on a 2.3 GB download.

PARAKEET_MODEL="mlx-community/parakeet-tdt-0.6b-v3"

step "🦜" "Setting up Parakeet (default transcription backend)..."
if has uv; then
  ok "uv already installed ($(command -v uv))"
else
  brew install uv
  ok "uv installed"
fi

echo "  Pre-pulling the Parakeet model (parakeet-tdt-0.6b-v3, ~2.3GB)..."
if uvx --from parakeet-mlx python -c \
    "from parakeet_mlx import from_pretrained; from_pretrained('$PARAKEET_MODEL'); print('ok')" \
    > /dev/null 2>&1; then
  ok "Parakeet model ready"
else
  warn "Parakeet model pre-pull failed — it will download on first transcription"
fi
blank

# ── whisper.cpp: the transcription fallback ──────────────────────────────────
#
# Homebrew's whisper-cpp formula ships binaries but NO model, and the app needs
# both (services/transcriber.js verifyInstallation). The base.en model is
# fetched from whisper.cpp's official Hugging Face mirror into Application
# Support — the one models location a packaged app can reach (must match
# getModelsDir() in services/transcriber.js).

step "📦" "Installing whisper.cpp (transcription fallback)..."
if has whisper-cli || has whisper-cpp; then
  ok "whisper.cpp already installed"
else
  brew install whisper-cpp
  ok "whisper.cpp installed"
fi

APP_MODELS_DIR="$HOME/Library/Application Support/CXNotes/models"
WHISPER_MODEL_FILE="ggml-base.en.bin"
WHISPER_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_MODEL_FILE"

step "📥" "Checking for the whisper model..."
if [ -f "$APP_MODELS_DIR/$WHISPER_MODEL_FILE" ]; then
  ok "Whisper model already installed"
else
  step "📥" "Downloading base.en model (~148 MB)..."
  mkdir -p "$APP_MODELS_DIR"
  # Download to a scratch name and move into place only on success — the app
  # tests the model by existence, so a partial file must never wear its name.
  if curl -L --fail --progress-bar \
      -o "$APP_MODELS_DIR/$WHISPER_MODEL_FILE.download" "$WHISPER_MODEL_URL"; then
    mv "$APP_MODELS_DIR/$WHISPER_MODEL_FILE.download" "$APP_MODELS_DIR/$WHISPER_MODEL_FILE"
    ok "Whisper model installed to $APP_MODELS_DIR"
  else
    rm -f "$APP_MODELS_DIR/$WHISPER_MODEL_FILE.download"
    warn "Model download failed — whisper fallback stays unavailable (Parakeet still works)"
  fi
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
echo "       Ollama: brew install ollama && ollama pull qwen3.5:4b  (free, fully local)"
echo "  3. In CXNotes: menu bar icon (right-click) > Refresh Dependencies"
echo "================================"
