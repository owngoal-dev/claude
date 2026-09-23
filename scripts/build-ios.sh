#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../configuration/upstream.env
source "$root/configuration/upstream.env"

for tool in xcrun node ldid otool vtool lipo; do
    command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 69; }
done

source_dir="$root/build/upstream/package"
payload="$root/build/payload"
[[ -x "$source_dir/claude" ]] || { echo "error: run scripts/fetch-upstream.sh first" >&2; exit 66; }
rm -rf -- "$payload"
mkdir -p "$payload"
/usr/bin/ditto "$source_dir/claude" "$payload/claude"
/usr/bin/ditto "$source_dir/LICENSE.md" "$payload/LICENSE.md"
/usr/bin/ditto "$source_dir/README.md" "$payload/UPSTREAM-README.md"
(cd "$source_dir" && shasum -a 256 claude) >"$payload/UPSTREAM-SHA256"

node "$root/scripts/patch-binary.mjs" "$payload/claude" "$MIN_IOS"

sdk="$(xcrun --sdk iphoneos --show-sdk-path)"
xcrun clang -target "arm64-apple-ios$MIN_IOS" -isysroot "$sdk" -dynamiclib \
    "$root/shim/compat.c" -framework CoreFoundation \
    -Wl,-install_name,@executable_path/s.dylib \
    -Wl,-compatibility_version,1.0 -Wl,-current_version,1.0 \
    -Wl,-reexport_library,"$sdk/usr/lib/libSystem.tbd" \
    -o "$payload/s.dylib"

grep -qE '^ *platform (IOS|2)$' < <(vtool -show-build "$payload/claude")
[[ "$(lipo -archs "$payload/claude")" == arm64 ]]
otool -L "$payload/claude" | grep -q '@executable_path/s.dylib'
nm -gU "$payload/s.dylib" | grep -q ' T _FSEventStreamCreate$'
nm -gU "$payload/s.dylib" | grep -q ' T ___clear_cache$'
chmod 0755 "$payload/claude" "$payload/s.dylib"
echo "built Claude Code $UPSTREAM_VERSION payload ($(du -sh "$payload" | cut -f1))"
