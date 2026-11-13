#!/usr/bin/env bash
# Downloads the pinned Stockfish release into .engine/ and checks its SHA-256.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/tools/stockfish.lock"
version=$(grep '^version=' "$lock" | cut -d= -f2)
case "$(uname -s)-$(uname -m)" in
  Darwin-*) key=macos ;;
  Linux-x86_64) key=linux-x86_64 ;;
  Linux-aarch64) key=linux-arm64 ;;
  *) echo "unsupported platform" >&2; exit 1 ;;
esac
read -r asset sha < <(grep "^$key=" "$lock" | cut -d= -f2)
dest="$root/.engine"
if [[ -x "$dest/stockfish" && -f "$dest/VERSION" && "$(cat "$dest/VERSION")" == "$version $sha" ]]; then
  echo "stockfish $version already installed"; exit 0
fi
tmp="$(mktemp -d)"
curl -fsSL -o "$tmp/$asset" "https://github.com/official-stockfish/Stockfish/releases/download/$version/$asset"
echo "$sha  $tmp/$asset" | shasum -a 256 -c -
mkdir -p "$tmp/x" && tar -xzf "$tmp/$asset" -C "$tmp/x"
bin="$(find "$tmp/x" -type f -name 'stockfish*' -perm -u+x | head -1)"
[[ -n "$bin" ]] || { echo "no binary found in $asset" >&2; exit 1; }
rm -rf "$dest" && mkdir -p "$dest"
cp "$bin" "$dest/stockfish" && chmod +x "$dest/stockfish"
echo "$version $sha" > "$dest/VERSION"
rm -rf "$tmp"
echo "installed stockfish $version ($asset)"
