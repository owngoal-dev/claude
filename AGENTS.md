# Claude iOS packaging invariants

- Treat the npm integrity as the pinned upstream input. Patches are generic: they validate the Mach-O and standalone-graph layout structurally instead of pinning per-release counts, and stop instead of guessing when a layout or source shape is not recognised.
- Patch the large Bun Mach-O in place. Do not use `vtool` or `install_name_tool` to rewrite it: their LINKEDIT rebuild does not preserve this standalone executable.
- Keep the executable and `s.dylib` adjacent and load the shim through `@executable_path`; neither payload may contain a rootless or RootHide physical path.
- When source text changes, disable the paired application bytecode and clear its stored source hashes. Editing the displayed source alone does not change executed JSC bytecode.
- JIT is deliberately disabled. The iOS runtime also removes `SharedArrayBuffer`, so `scripts/patch-source.mjs` renames every whole `SharedArrayBuffer` token to a padded `ArrayBuffer` and rewrites every `Atomics.wait` call. It fails on a declaration or assignment of `SharedArrayBuffer` and on any wait call that is not the zero-valued sleep shape. Extend its rules and `scripts/test-patch-source.mjs` together; never loosen a rejection to make a release pass.
- RootHide processes spawned by this unlinked Mach-O need physical bootstrap paths. Derive them with `jbroot` in the launcher; rootless uses `/var/jb`.
- Claude's updater must remain disabled because it would replace the patched, signed package payload with a macOS build.
- `Follow upstream` checks npm daily and validates both packages in a temporary
  tree before changing the pin. A patch failure keeps the previous pin and
  requires inspecting the new binary. The synchronous wait patch tolerates
  minified identifier renames but still requires the zero-valued wait shape.
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
