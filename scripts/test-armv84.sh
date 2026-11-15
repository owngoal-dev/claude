#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "$(uname -sm)" != "Darwin arm64" ]]; then
    echo "skipped: the ARMv8.4 emulation is compared against a processor that has the instructions" >&2
    exit 0
fi
output="$(mktemp -d "${TMPDIR:-/tmp}/claude-armv84.XXXXXX")"
trap 'rm -rf -- "$output"' EXIT
xcrun clang -std=c11 -O2 -Wall -Wextra -Werror \
    "$root/shim/armv84.c" "$root/tests/armv84/emulate.c" "$root/tests/armv84/stubs.S" -o "$output/emulate"
"$output/emulate"
