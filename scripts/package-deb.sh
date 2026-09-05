#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$#" -eq 5 ]] || { echo "usage: $0 <payload> <output> <version> <architecture> <prefix>" >&2; exit 64; }
payload="$1"; output="$2"; version="$3"; architecture="$4"; prefix="$5"
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../configuration/upstream.env
source "$root/configuration/upstream.env"
package_id="${PACKAGE_ID:-wiki.qaq.claude}"

[[ -x "$payload/claude" && -f "$payload/s.dylib" ]] || { echo "error: incomplete payload" >&2; exit 66; }
[[ "$architecture" == iphoneos-arm64 || "$architecture" == iphoneos-arm64e ]] || { echo "error: bad architecture" >&2; exit 64; }
[[ "$prefix" == /var/jb || -z "$prefix" ]] || { echo "error: bad prefix" >&2; exit 64; }
case "$architecture:$prefix" in
iphoneos-arm64:/var/jb | iphoneos-arm64e:) ;;
*) echo "error: architecture and install prefix name different bootstrap layouts" >&2; exit 64 ;;
esac

for tool in ldid dpkg-deb; do command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 69; }; done

staging="$(mktemp -d "${TMPDIR:-/tmp}/claude-deb.XXXXXX")"
temporary="$(dirname "$output")/.$(basename "$output").tmp.$$"
trap 'rm -rf -- "$staging"; rm -f -- "$temporary"' EXIT
chmod 0755 "$staging"
installed="$staging$prefix"
libexec="$installed/usr/libexec/claude"
launcher="$installed/usr/bin/claude"
docs="$installed/usr/share/doc/claude"
mkdir -p "$staging/DEBIAN" "$libexec" "$(dirname "$launcher")" "$docs" "$(dirname "$output")"
/usr/bin/ditto "$payload/claude" "$libexec/claude"
/usr/bin/ditto "$payload/s.dylib" "$libexec/s.dylib"
/usr/bin/ditto "$payload/LICENSE.md" "$docs/LICENSE.md"
/usr/bin/ditto "$payload/UPSTREAM-README.md" "$docs/README.md"
/usr/bin/ditto "$payload/UPSTREAM-SHA256" "$docs/UPSTREAM-SHA256"
sed -e "1s|^#!/bin/sh$|#!$prefix/bin/sh|" -e "s|@PREFIX@|$prefix|g" \
    "$root/packaging/claude.launcher.sh" >"$launcher"
chmod 0755 "$launcher" "$libexec/claude" "$libexec/s.dylib"
ldid -S"$root/packaging/claude.entitlements" -Cadhoc "$libexec/claude"
ldid -S -Cadhoc "$libexec/s.dylib"

# Inspect the signature that ships, not just its source plist.
ldid -e "$libexec/claude" >"$staging/claude-signed.plist"
for entitlement in platform-application com.apple.private.security.no-sandbox \
    com.apple.private.security.storage.AppBundles \
    com.apple.private.security.storage.AppDataContainers; do
    [[ "$(/usr/libexec/PlistBuddy -c "Print :$entitlement" "$staging/claude-signed.plist")" == true ]] || {
        echo "error: signed Claude is missing entitlement: $entitlement" >&2
        exit 65
    }
done
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.private.security.container-required' "$staging/claude-signed.plist")" == false ]] || {
    echo "error: signed Claude requires a data container" >&2
    exit 65
}
rm -f "$staging/claude-signed.plist"

head -n1 "$launcher" | grep -qxF "#!$prefix/bin/sh"
grep -qF "exec $prefix/usr/libexec/claude/claude" "$launcher"
! grep -q '@PREFIX@' "$launcher"
grep -qE '^ *platform (IOS|2)$' < <(vtool -show-build "$libexec/claude")
otool -L "$libexec/claude" | grep -q '@executable_path/s.dylib'

installed_size="$(du -sk "$installed" | awk '{print $1}')"
sed \
    -e "s|@PACKAGE_ID@|$package_id|g" \
    -e "s|@VERSION@|$version|g" \
    -e "s|@ARCHITECTURE@|$architecture|g" \
    -e "s|@MIN_IOS@|$MIN_IOS|g" \
    -e "s|@INSTALLED_SIZE@|$installed_size|g" \
    "$root/packaging/DEBIAN/control" >"$staging/DEBIAN/control"
chmod 0644 "$staging/DEBIAN/control" "$docs"/*
dpkg-deb --root-owner-group -Zzstd -b "$staging" "$temporary" >/dev/null
[[ "$(dpkg-deb -f "$temporary" Package)" == "$package_id" ]]
[[ "$(dpkg-deb -f "$temporary" Architecture)" == "$architecture" ]]
mv -f "$temporary" "$output"
echo "packaged $output"
