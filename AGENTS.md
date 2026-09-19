# Claude iOS packaging invariants

- Treat the npm integrity and every expected standalone-graph count as part of the pinned upstream input. Stop instead of guessing when any value changes.
- Patch the large Bun Mach-O in place. Do not use `vtool` or `install_name_tool` to rewrite it: their LINKEDIT rebuild does not preserve this standalone executable.
- Keep the executable and `s.dylib` adjacent and load the shim through `@executable_path`; neither payload may contain a rootless or RootHide physical path.
- When source text changes, disable the paired application bytecode and clear its stored source hashes. Editing the displayed source alone does not change executed JSC bytecode.
- JIT is deliberately disabled. The iOS runtime also removes `SharedArrayBuffer`, so keep the fixed-size source compatibility patch and its exact match-count checks together.
- RootHide processes spawned by this unlinked Mach-O need physical bootstrap paths. Derive them with `jbroot` in the launcher; rootless uses `/var/jb`.
- Claude's updater must remain disabled because it would replace the patched, signed package payload with a macOS build.
- `Follow upstream` checks npm daily and validates both packages in a temporary
  tree before changing the pin. Keep the reviewed graph and match counts; a
  mismatch requires inspecting the new binary, never accepting observed counts
  automatically. The synchronous wait patch tolerates minified identifier
  renames but still requires the exact zero-valued wait shape and match count.
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
