# claude

Unofficial packaging of [Claude Code](https://code.claude.com/docs/en/overview)
for jailbroken iOS. One patched arm64 executable is packaged for rootless and
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
- Claude's self-installer and updater are disabled. Upgrade through the package
  manager or a newer release from this repository.

The rootless build is device-tested through `--help`, `doctor`, and the complete
API request path. RootHide uses the same binary and the layout used by the
other OwnGoal CLI packages, but still requires validation on a RootHide device.

## Build

On macOS with Xcode, Node.js, `ldid`, and `dpkg`:

```sh
make check
make debs
```

Artifacts are written to `build/Packages`.

This repository's packaging code is MIT licensed. The downloaded Claude Code
payload remains subject to Anthropic's bundled license and legal terms.
