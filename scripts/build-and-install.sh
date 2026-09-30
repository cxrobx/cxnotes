#!/bin/bash
# Build CXNotes and install to /Applications
# Triggered automatically after git push via Claude Code hook

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "[build-and-install] Killing running instances..."
pkill -f "CXNotes" 2>/dev/null || true
pkill -f "electron \." 2>/dev/null || true
sleep 1

echo "[build-and-install] Building..."
rm -rf dist/
npm run build 2>&1

echo "[build-and-install] Installing to /Applications..."
DMG="dist/CXNotes-1.0.0-arm64.dmg"
VOLUME="/Volumes/CXNotes 1.0.0-arm64"

hdiutil attach "$DMG" -nobrowse -quiet
rm -rf "/Applications/CXNotes.app"
cp -R "$VOLUME/CXNotes.app" /Applications/
hdiutil detach "$VOLUME" -quiet

echo "[build-and-install] Launching..."
open /Applications/CXNotes.app

echo "[build-and-install] Done."
