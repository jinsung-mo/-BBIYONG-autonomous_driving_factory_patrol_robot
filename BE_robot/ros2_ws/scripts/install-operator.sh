#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$HOME/.local/bin"
TARGET="$TARGET_DIR/bbiyong"
mkdir -p "$TARGET_DIR"
if [[ -e "$TARGET" && ! -L "$TARGET" ]]; then
  echo "Refusing to replace non-symlink: $TARGET" >&2
  exit 2
fi
ln -sfn "$ROOT/scripts/bbiyong" "$TARGET"
echo "Installed $TARGET"
echo "Add $HOME/.local/bin to PATH if the bbiyong command is not found."
