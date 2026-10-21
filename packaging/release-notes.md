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
- Self-hosted runner logs use upstream's synchronous-write fallback; a blocked
  log destination can pause the runner.
- `claude install`, `claude update`, and automatic updates are disabled; use the package manager.
- macOS Keychain access is disabled. OAuth credentials, saved API keys and device
  keys use private local files in the current bootstrap's `var/lib/claude/<uid>/`
  directory. RootHide paths are resolved with `jbroot` at launch.
- Credential directories use mode `0700` and files use `0600`. Files are plaintext;
  existing keychain credentials are not migrated, so authenticate again.

Both signed package layouts pass build validation. RootHide is smoke-tested in
vphone guests on iOS 26.6.2 and 27.0.1: root/mobile, zsh/fish, version/help,
doctor, updater refusal, credential directory permissions, and a complete
streaming request to a local mock API. The native command entrypoint fixes a
direct shebang launch failure from fish. The earlier rootless package was
tested on-device through `--help`, `doctor`, DNS/TLS/HTTP, and the API error path.

The repository's packaging code is MIT. The bundled Claude Code executable remains subject to Anthropic's included license and legal terms. Verify downloads with `SHA256SUMS`.

**Packaging changes:** https://github.com/owngoal-dev/claude/commits/@TAG@

The payload is Claude Code @UPSTREAM_VERSION@. Validation also covers source
patches, native entrypoint arguments and exit status, and isolated credential
methods (OAuth/API key read/write, refresh save, deletion, permissions,
corruption and symlink refusal). Real-account login, token refresh, and logout
remain untested; the smoke tests use fixture tokens and disposable files.
