Unofficial packaging of [Claude Code](https://code.claude.com/docs/en/overview) @VERSION@ for iOS on custom firmware.

## Download

| bootstrap | asset |
| --- | --- |
| rootless (Dopamine, palera1n rootless) | `wiki.qaq.claude_@VERSION@_iphoneos-arm64.deb` |
| RootHide Dopamine | `wiki.qaq.claude_@VERSION@_iphoneos-arm64e.deb` |

The architecture identifies the bootstrap layout, not the CPU. Check with `dpkg --print-architecture`.

Requires iOS @MIN_IOS_MAJOR@ or newer. Run `claude` in a terminal and use `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; browser login is opened with `uiopen`.

## Compatibility

- JavaScriptCore JIT is disabled.
- File-system events are stubbed; settings and external file changes are not hot-reloaded.
- Worker-backed hooks and cross-thread cancellation are not supported.
- `claude install`, `claude update`, and automatic updates are disabled; use the package manager.
- macOS Keychain access is disabled. OAuth credentials, saved API keys and device
  keys use private local files in the current bootstrap's `var/lib/claude/<uid>/`
  directory. RootHide paths are resolved with `jbroot` at launch.
- Credential directories use mode `0700` and files use `0600`. Files are plaintext;
  existing keychain credentials are not migrated, so authenticate again.

The earlier rootless package was tested on-device through `--help`, `doctor`, DNS/TLS/HTTP, and the API error path. This update is build-verified; device testing of this version and RootHide validation remain pending.

The repository's packaging code is MIT. The bundled Claude Code executable remains subject to Anthropic's included license and legal terms. Verify downloads with `SHA256SUMS`.

**Packaging changes:** https://github.com/owngoal-dev/claude/commits/@TAG@

This packaging revision keeps upstream Claude Code @UPSTREAM_VERSION@ and replaces macOS
keychain storage with bootstrap-local files. It preserves Darwin platform
detection: a Linux-spoof experiment showed that the compiled macOS credential
selector still chooses the keychain.

Validation passed for source patches, both launcher layouts, isolated extracted
credential methods (OAuth/API key read/write, refresh save, deletion, permissions,
corruption and symlink refusal), and both signed deb packages. A temporary macOS
executable copy exited under the strict host sandbox; full iOS login, refresh and
logout still need device validation. Existing host binaries and credentials were
not used for testing.
