#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../configuration/upstream.env
source "$root/configuration/upstream.env"

for tool in npm node tar; do
    command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 69; }
done

download="$root/build/downloads/$UPSTREAM_VERSION"
source_dir="$root/build/upstream"
stamp="$UPSTREAM_PACKAGE@$UPSTREAM_VERSION $UPSTREAM_INTEGRITY"
if [[ -f "$source_dir/.stamp" && "$(cat "$source_dir/.stamp")" == "$stamp" && -x "$source_dir/package/claude" ]]; then
    echo "upstream $UPSTREAM_VERSION is already fetched"
    exit 0
fi

mkdir -p "$download"
metadata="$(npm pack "$UPSTREAM_PACKAGE@$UPSTREAM_VERSION" --pack-destination "$download" --json)"
archive="$(node -e 'const x=JSON.parse(process.argv[1])[0]; process.stdout.write(x.filename)' "$metadata")"
integrity="$(node -e 'const x=JSON.parse(process.argv[1])[0]; process.stdout.write(x.integrity)' "$metadata")"
[[ "$integrity" == "$UPSTREAM_INTEGRITY" ]] || {
    echo "error: npm integrity changed: $integrity" >&2
    exit 65
}

rm -rf -- "$source_dir"
mkdir -p "$source_dir"
tar -xzf "$download/$archive" -C "$source_dir"
[[ -x "$source_dir/package/claude" ]] || { echo "error: native package has no claude executable" >&2; exit 65; }
actual_version="$(node -p 'require(process.argv[1]).version' "$source_dir/package/package.json")"
[[ "$actual_version" == "$UPSTREAM_VERSION" ]] || { echo "error: package version is $actual_version" >&2; exit 65; }
printf '%s\n' "$stamp" >"$source_dir/.stamp"
echo "fetched $UPSTREAM_PACKAGE@$UPSTREAM_VERSION"
