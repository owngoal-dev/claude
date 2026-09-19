#!/usr/bin/env bash
# Validate a newer npm stable release before changing either pinned input.
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/configuration/upstream.env"
mode="${1:-apply}"
[[ "$mode" == apply || "$mode" == --check ]] || {
    echo "usage: $0 [--check]" >&2
    exit 64
}

metadata="$(npm view "$UPSTREAM_PACKAGE@latest" version dist.integrity --json)"
candidate="$(node -e '
    const metadata = JSON.parse(process.argv[1]);
    if (!/^\d+\.\d+\.\d+$/.test(metadata.version) ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata["dist.integrity"]))
        throw new Error("latest must have a stable version and SHA-512 integrity");
    const latest = metadata.version.split(".").map(Number);
    const current = process.argv[2].split(".").map(Number);
    const difference = latest.findIndex((part, index) => part !== current[index]);
    if (difference >= 0 && latest[difference] > current[difference])
        console.log(metadata.version + " " + metadata["dist.integrity"]);
' "$metadata" "$UPSTREAM_VERSION")"
if [[ -z "$candidate" ]]; then
    echo "no newer stable release than $UPSTREAM_VERSION"
    exit 0
fi
read -r version integrity <<<"$candidate"
echo "candidate: $UPSTREAM_PACKAGE@$version"
if [[ "$mode" == --check ]]; then
    exit 1
fi

candidate_root="$(mktemp -d "${TMPDIR:-/tmp}/claude-upstream.XXXXXX")"
trap 'rm -rf -- "$candidate_root"' EXIT
cp -R "$root/configuration" "$root/scripts" "$root/packaging" "$root/shim" "$root/docs" "$root/makefile" "$candidate_root/"
python3 - "$candidate_root" "$version" "$integrity" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
path = root / "configuration/upstream.env"
replacements = {"UPSTREAM_VERSION": sys.argv[2], "UPSTREAM_INTEGRITY": sys.argv[3]}
lines = path.read_text().splitlines()
for key, value in replacements.items():
    matches = [index for index, line in enumerate(lines) if line.startswith(key + "=")]
    if len(matches) != 1:
        raise SystemExit(f"expected exactly one {key}")
    lines[matches[0]] = f"{key}={value}"
path.write_text("\n".join(lines) + "\n")
(root / "configuration/version.txt").write_text(sys.argv[2] + "\n")
PY

# Keep the reviewed graph/match counts: a new binary layout requires review.
# A failed download, patch, signature or package check leaves the pin untouched.
make -C "$candidate_root" check debs
cp "$candidate_root/configuration/upstream.env" "$root/configuration/upstream.env"
cp "$candidate_root/configuration/version.txt" "$root/configuration/version.txt"
echo "validated and pinned Claude Code $version"
