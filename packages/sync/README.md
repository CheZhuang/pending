# @agentree/sync (Task C)

Decides which context is relevant to which session. Pure functions only: no
SQLite access, no filesystem access, no permission decisions.

- `toRootedPath(nativePath, roots, cwd?)` maps native paths onto `{ rootId, path }`
  (longest matching root; outside-workspace and ambiguous paths are dropped).
- `extractTouches(event, roots)` reads file activity from observed events.
  Adapters should prefer `payload.touches: [{ path, rootId?, access: 'read' | 'write' }]`;
  Claude Code `tool_name`/`tool_input.file_path` and Codex `changes[].path` are also understood.
- `deriveFocus({ sessionId, events, roots, declaration? })` builds a weighted focus:
  declared scopes (1.0) > modified files (0.9) > read files (0.6) > folders of
  modified files (0.4) > touched roots (0.2). Older files decay to half weight.
  `declaration.mode: 'override'` ignores inferred activity.
- `relevance(knowledge, focus)` returns the best match over the location
  `scope` and the `impactScope` (`via: 'location' | 'impact'`), or `undefined`
  when unrelated. Matching is segment-aware, root-aware, and tasks only match
  the same task id.

Relevance is not access: a high score never grants a read or write, and a
relevant Finding is still only a Finding.

Tests: `npx -y node@24 --import tsx --test packages/sync/src/*.test.ts`
