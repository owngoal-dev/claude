# claude

Unofficial packaging of [Claude Code](https://code.claude.com/docs/en/overview)
for iOS on custom firmware. One patched arm64 executable is packaged for rootless and
RootHide bootstraps.

## Install

Download the package matching `dpkg --print-architecture` from
[Releases](../../releases):

| bootstrap | package architecture |
| --- | --- |
| rootless | `iphoneos-arm64` |
| RootHide | `iphoneos-arm64e` |

Requires iOS 15 or later. Run `claude` in a terminal and authenticate with
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Browser login uses `uiopen`.

## Current compatibility

- JIT is disabled; Claude runs through JavaScriptCore's interpreter.
- File-system event delivery is stubbed, so settings and files are not hot-reloaded.
- `SharedArrayBuffer` is downgraded to `ArrayBuffer`; worker-backed hooks and
  cross-thread cancellation are not supported in this first build.
- Self-hosted runner logs use the upstream synchronous-write fallback. A
  blocked log destination can pause the runner; keep stdout and stderr draining.
- Claude's self-installer and updater are disabled. Upgrade through the package
  manager or a newer release from this repository.
- macOS Keychain access is disabled on iOS. OAuth credentials, saved API keys,
  and device keys use local files under the current jailbreak bootstrap:
  `/var/jb/var/lib/claude/<uid>/` on rootless, or
  `$(jbroot /)/var/lib/claude/<uid>/` on RootHide. The launcher resolves the
  physical path at runtime and sets `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
  Each user directory has mode `0700`; credential files have mode `0600`.
  These files are plaintext, not encrypted by the system keychain. Ordinary
  settings and session history keep their existing locations. Existing
  keychain credentials are not migrated; authenticate again on iOS.

The package keeps Darwin platform detection. Spoofing `process.platform` or
the platform detector as Linux does not enable Linux credential storage in the
pinned macOS build: its keychain selectors are already compiled unconditionally.
A global spoof would also change unrelated platform decisions and may select
Linux `/proc` paths or Linux tools. The patch therefore switches the credential
backends explicitly and rejects unrecognised source shapes on upgrade.

The rootless build is device-tested through `--help`, `doctor`, and the complete
API request path. RootHide uses the same binary and the layout used by the
other OwnGoal CLI packages, but still requires validation on a RootHide device.
The file credential patch requires fresh device validation of login, token
refresh, and logout; host tests do not establish iOS runtime compatibility.

## Build

On macOS with Xcode, Node.js, `ldid`, and `dpkg`:

```sh
make check
make debs
```

The build installs the pinned Acorn parser with `npm ci`. To smoke-test the
patched credential methods using disposable files, run
`node scripts/smoke-credentials.mjs build/upstream/package/claude` after fetching
the upstream package. This executes extracted methods with isolated file I/O,
not the CLI or an existing login. An optional macOS executable smoke test is
`python3 scripts/smoke-macos.py build/upstream/package/claude`; it patches only a
temporary copy and runs inside a sandbox denying network, keychain IPC, and
reads of user files. If that sandbox prevents startup, do not relax it to test
against an installed Claude or real credentials.

Artifacts are written to `build/Packages`.

`Follow upstream` checks npm's latest stable release daily at 00:00 UTC and
can also be run manually. It builds and validates both packages before updating
the version and integrity pins, then dispatches `Release` on the new tag.
If the standalone binary layout changes, or the source contains a shape the
patcher cannot rewrite safely, the update stops for review and keeps the
previous pin. Run
`scripts/follow-upstream.sh --check` to check for a newer version without changing files (exit 1 means an
update is available).

This repository's packaging code is MIT licensed. The downloaded Claude Code
payload remains subject to Anthropic's bundled license and legal terms.
