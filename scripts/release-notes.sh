#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$#" -eq 1 ]] || { echo "usage: $0 <tag>" >&2; exit 64; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../configuration/upstream.env
source "$root/configuration/upstream.env"
version="$(tr -d '[:space:]' <"$root/configuration/version.txt")"
sed \
    -e "s|@VERSION@|$version|g" \
    -e "s|@TAG@|$1|g" \
    -e "s|@MIN_IOS_MAJOR@|${MIN_IOS%%.*}|g" \
    "$root/packaging/release-notes.md"
