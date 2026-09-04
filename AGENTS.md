# Claude iOS packaging invariants

- Treat the npm integrity and every expected standalone-graph count as part of the pinned upstream input. Stop instead of guessing when any value changes.
- Patch the large Bun Mach-O in place. Do not use `vtool` or `install_name_tool` to rewrite it: their LINKEDIT rebuild does not preserve this standalone executable.
- Keep the executable and `s.dylib` adjacent and load the shim through `@executable_path`; neither payload may contain a rootless or RootHide physical path.
- When source text changes, disable the paired application bytecode and clear its stored source hashes. Editing the displayed source alone does not change executed JSC bytecode.
- JIT is deliberately disabled. The iOS runtime also removes `SharedArrayBuffer`, so keep the fixed-size source compatibility patch and its exact match-count checks together.
- RootHide processes spawned by this unlinked Mach-O need physical bootstrap paths. Derive them with `jbroot` in the launcher; rootless uses `/var/jb`.
- Claude's updater must remain disabled because it would replace the patched, signed package payload with a macOS build.
