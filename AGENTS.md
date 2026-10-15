# Claude iOS packaging invariants

- Treat the npm integrity as the pinned upstream input. Patches are generic: they validate the Mach-O and standalone-graph layout structurally instead of pinning per-release counts, and stop instead of guessing when a layout or source shape is not recognised.
- Patch the large Bun Mach-O in place. Do not use `vtool` or `install_name_tool` to rewrite it: their LINKEDIT rebuild does not preserve this standalone executable.
- Keep the executable and `s.dylib` adjacent and load the shim through `@executable_path`; neither payload may contain a rootless or RootHide physical path.
- When source text changes, disable the paired application bytecode and clear its stored source hashes. Editing the displayed source alone does not change executed JSC bytecode.
- JIT is deliberately disabled. The iOS runtime also removes `SharedArrayBuffer`, so `scripts/patch-source.mjs` renames every whole `SharedArrayBuffer` token to a padded `ArrayBuffer` and rewrites every `Atomics.wait` call. It fails on a declaration or assignment of `SharedArrayBuffer` and on any wait call that is not the zero-valued sleep shape. Extend its rules and `scripts/test-patch-source.mjs` together; never loosen a rejection to make a release pass.
- RootHide processes spawned by this unlinked Mach-O need physical bootstrap paths. Derive them with `jbroot` in the launcher; rootless uses `/var/jb`.
- Claude's updater must remain disabled because it would replace the patched, signed package payload with a macOS build.
- macOS keychain access stays disabled. `scripts/patch-credentials.mjs` selects
  file storage for OAuth, API keys and device keys and guards residual security
  commands. Keep filesystem read options forwarded: the upstream facade drops
  `flag`, which would defeat `O_NOFOLLOW`. Credentials live in the launcher's
  physical bootstrap `var/lib/claude/<uid>` directory, with modes 0700/0600.
  Do not globally spoof Linux: the Darwin build's credential selectors are
  already compiled unconditionally, while other platform decisions still vary.
  Host smoke tests use only the repository download and disposable files;
  never run an installed Claude or read its existing login to validate a patch.
- `Follow upstream` checks npm daily and validates both packages in a temporary
  tree before changing the pin. A patch failure keeps the previous pin and
  requires inspecting the new binary. The synchronous wait patch tolerates
  minified identifier renames and a fresh `new Int32Array(new
  SharedArrayBuffer(n))` buffer but still requires the zero-valued wait shape.
  Credential discovery is structural for the same reason: 2.1.300 imported a
  null-returning `diskless()?null:dir()` guard instead of the directory, and
  added a diskless guard before the device-key keychain default. Prefer
  matching a role (guards then the keychain return) over a fixed body.
- `docs/depiction.json` owns native Details. Pages uses the pinned shared
  `owngoal-packages` updater to generate Changelog from GitHub Releases, including
  after successful `Release` workflow completion. Banners are optional for CLIs.

## RootHide signing and launcher checks

RootHide's official Developer README requires both
`com.apple.private.security.storage.AppBundles` and
`com.apple.private.security.storage.AppDataContainers`, in addition to the
platform and no-sandbox entitlements. Keep these in the executable signature
and verify the extracted signature after packaging; a correct package layout
alone does not establish access to RootHide's app-container installation path.
Source: https://github.com/roothide/Developer/blob/main/README.md

For payloads that do not use vroot, the launcher exports physical bootstrap
PATH, SHELL and default CA/browser paths. Preserve explicit CA/browser settings
and already physical or custom SHELL paths. Host launcher tests simulate the
path boundary and verify argv/exit status; they do not prove that iOS loads the
binary. Test the installed package from both zsh and fish on a RootHide device.
Do not add vroot to a payload while retaining a launcher that exports physical
paths: the filesystem view must remain consistent across the boundary.
