# Agent guide

Notes for AI coding agents (and developers) working on this repository. The
user guide is the documentation site in `docs/`. The [README](README.md) is
an overview that links to it, and is shown on the extension's Marketplace
page. Keep implementation details here instead.

## Commands

Requirements: Node.js (>= 24) and npm.

```sh
npm ci                     # install dependencies from package-lock.json
npm run build              # type check and bundle the extension into out/
npm run check              # type check and run the unit tests
npm test                   # bundle and run the unit tests only
npm run test:fuzz          # run the fuzzing tests
npm run package            # build simics-target-debug-<version>.vsix
npm run watch              # rebuild on changes
npm run compile:production # minified bundle without source maps
npm run docs:develop       # serve the documentation site with hot reload
npm run docs:build         # build the site, fails on dead links between pages
npx prettier --write <file>
```

## Conventions

- Format every TypeScript file you create or change with Prettier, see
  [.github/instructions/typescript.instructions.md](.github/instructions/typescript.instructions.md).
- The user guide is a VitePress site with one Markdown page per feature in
  `docs/`, and the sidebar in `docs/.vitepress/config.mts`. When a change is
  visible to users, update its page. Describe how to use the feature there,
  not how it works inside.
- Unit tests use `node:test` and need no TCF agent. `npm test` only bundles
  and runs `src/test/**/*.test.ts`; the root `test/` folder is neither run nor
  type checked. Add tests in `src/test/`.
- Options that are the same for all sessions are VS Code settings, not
  `launch.json` attributes. `sessionSettings()` in `src/settings.ts` maps them
  to `TcfAttachArguments`, and `resolveDebugConfiguration` overwrites
  `launch.json` values with them.
- Only standard TCF services and properties are used, so the extension works
  with any agent that follows the TCF specification. Simics-only services
  (`CommandLine`, `SimUtils`, `SimicsLogs`) are optional and degrade
  gracefully.
- Fields of the launch configurations editor come from
  `configurationAttributes` in `package.json`; a new attribute needs no form
  changes.
- Commit messages: see the `git-commit-message` skill in `.github/skills/`.
  Commits need a `Signed-off-by` line, see [CONTRIBUTING.md](CONTRIBUTING.md).
- For TCF protocol details and a CLI to query a live agent, see the `tcf`
  skill in `.github/skills/`.

## Source layout

- `src/extension.ts` – VS Code entry point, registers the `simics-target-debug`
  debug type.
- `src/tcfDebugSession.ts` – DAP implementation (no `vscode` dependency, so it
  can also be run as a standalone debug adapter later).
- `src/contextSession.ts` – adapter of the child sessions that show the
  threads of a container context; passes requests on to the root session's
  adapter.
- `src/contextSessionManager.ts` – starts the child sessions in VS Code and
  maps them to their root session for the extension's views and commands.
- `src/breakpointManager.ts` – keeps the agent's breakpoint table in sync with
  VS Code.
- `src/variables.ts` – local variables and expressions through the
  `Expressions` and `Symbols` services.
- `src/pathMapper.ts` – path mapping between compiled and host paths.
- `src/symbolFiles.ts` – symbol files from the debug configuration, sent to
  the agent's memory map.
- `src/settings.ts` – VS Code settings passed to the debug adapter.
- `src/targetMemory/` – Target Memory panels and commands (extension side).
- `src/webview/targetMemory/` – Target Memory UI (React), bundled to
  `out/target-memory.{js,css}`.
- `src/shared/targetMemory/` – code shared by the Target Memory extension
  side, webview and debug adapter: messages, formatting, search needles and
  the memory search.
- `src/tcfRequests.ts` – custom DAP requests used by the Target Memory view.
- `src/simicsConsole.ts` – the Simics console: keys to `CommandLine` key
  presses, events to VT text (no `vscode` dependency).
- `src/simicsConsoleManager.ts` – the Simics CLI terminals and their commands.
- `src/consolesView.ts` – the Consoles view.
- `src/snapshots.ts` – Simics snapshots in the adapter, and the custom
  requests of the Snapshots view (no `vscode` dependency).
- `src/snapshotsView.ts` – the Snapshots view and its commands.
- `src/launchSettings/` – the launch configurations editor: reading and
  editing `launch.json` (`launchJson.ts`), form fields from `package.json`
  (`schema.ts`), the custom editor (`editorProvider.ts`) and the form in its
  webview (`src/webview/launchSettings/`).
- `src/tcf/channel.ts` – TCF TCP channel: framing, escaping, tokens, events.
- `src/tcf/json.ts` – JSON parsing that keeps 64-bit integers exact (`bigint`).
- `src/tcf/traceSilence.ts` – the `tcfTrace.silence` rules.
- `src/tcf/services/` – typed wrappers for TCF services.
- `src/test/` – unit tests.

## DAP to TCF mapping

The extension implements the VS Code Debug Adapter Protocol (DAP) in-process
and translates DAP requests to TCF commands:

| VS Code (DAP)                 | TCF                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| attach                        | TCP connection + `Locator.Hello`                                                                                          |
| threads                       | `RunControl` contexts with `HasState`, grouped in a session per container context                                         |
| pause / continue              | `RunControl.suspend` / `RunControl.resume`                                                                                |
| step over / into / out        | `RunControl.resume` with a step mode                                                                                      |
| stopped / continued           | `contextSuspended`, `containerSuspended`, `contextResumed`, `containerResumed` events                                     |
| call stack                    | `StackTrace.getChildrenRange` / `getChildren` / `getContext`                                                              |
| Locals scope                  | `Expressions.getChildren` of the selected frame                                                                           |
| watch / hover / Debug Console | `Expressions.create` / `evaluate` in the selected frame                                                                   |
| Registers scope               | `Registers.getChildren` / `getContext` / `get` for the selected frame, hierarchical                                       |
| disassembly                   | `Disassembly.disassemble` in the frame's context                                                                          |
| breakpoints                   | `Breakpoints.add` / `change` / `remove`, `status` events                                                                  |
| Target Memory (custom)        | `Memory.get` / `set` / `getChildren` / `getContext`, `memoryChanged` events, search in the adapter                        |
| Snapshots view (custom)       | Simics `SimUtils.getSnapshotIDs` / `takeSnapshot` / `restoreSnapshot` / `deleteSnapshot`, `snapshotsChanged` events       |
| Simics console                | Simics `CommandLine` service over the debug session's connection                                                          |

Register contexts without a readable value (for example Simics register
groups) are shown as expandable groups. Registers with fields can be expanded
to show the fields.

### Variables and expressions

Variables work like in the Eclipse TCF client; the agent does all parsing and
evaluation.

- The Locals scope lists what `Expressions.getChildren(<frame ID>)` returns.
- Values are evaluated with `Expressions.evaluate` and formatted using the
  value's type class and the type from the `Symbols` service.
- Children are new expressions built from the parent expression and member
  symbol IDs, for example `(parent).${<member symbol ID>}`, `(parent)[3]` and
  `*(parent)`; pointers to structs expand directly to the members. Arrays with
  more than 100 elements are paged.
- "Add to Watch" and "Copy as Expression" use a readable expression such as
  `s->corners[2].x`.

### Call stack

- Threads are grouped into a child debug session per container context
  (`src/contextSession.ts`, `src/contextSessionManager.ts`). All sessions
  share the root session's adapter, breakpoints and Debug Console.
- Frames come from `StackTrace.getChildrenRange` in pages; agents without it
  fall back to `getChildren`. Without `StackTrace`, or if it fails, a single
  frame for the PC is shown.
- Function and line come from the frame's `FuncID` and `CodeArea` when
  reported (inlined frames), otherwise from `Symbols.findByAddr` and
  `LineNumbers.mapToSource`. Caller frames use the address before the return
  address, so they show the line of the call.
- A last frame with IP 0, where the agent stopped unwinding, is left out.

### Disassembly

- Frame references keep their TCF context so several CPUs can be inspected.
  Plain address references use the first suspended thread.
- On variable-length instruction sets (x86) decoding is kept in step with
  addresses known to start an instruction: PCs where a context stopped (the
  most recent 4096 per context, dropped when the memory map changes) and line
  starts from `LineNumbers`. Decoding starts at such an address shortly before
  the range when there is one, and restarts at one when a decoded instruction
  runs over it. Otherwise, start addresses up to 15 bytes later are tried
  until decoding lands on the next known address.
- The agent decodes from the start of the function (or line area) containing
  the address and stops at its end, so the adapter keeps requesting from where
  each reply ended. Instructions before an address that cannot be decoded up
  to it (unreadable memory) are returned with address `-1`, which VS Code
  skips, so it keeps the instructions it already shows.
- Replies are cached per context and kept when stepping. After a resume or a
  memory write, cached replies are only reused once a single `Memory.get`
  shows that their opcode bytes are unchanged; a memory map change clears the
  cache.
- Function header rows use VS Code's source line support. The documents come
  from a file system (scheme `simics-target-debug-function`) because VS Code
  fails to re-render rows whose document comes from a content provider. A
  function is looked up once (`Symbols.findByAddr` and `getContext`); results
  are kept until the memory map changes. Code without symbols needs a lookup
  per instruction, so at most 64 lookups are made per request, nearest the
  requested address first. Inlined functions get no header.

### Stepping

Steps are sent to the thread's own run control context:

| VS Code   | TCF resume mode (default) | TCF resume mode (instruction granularity) |
| --------- | ------------------------- | ----------------------------------------- |
| Step Over | `RM_STEP_OVER_LINE` (3)   | `RM_STEP_OVER` (1)                        |
| Step Into | `RM_STEP_INTO_LINE` (4)   | `RM_STEP_INTO` (2)                        |
| Step Out  | `RM_STEP_OUT` (5)         | `RM_STEP_OUT` (5)                         |

If the context does not support line stepping (its `CanResume` bit is not
set), instruction stepping is used. The Simics agent itself falls back to
instruction stepping when there is no line information for the PC. A line
with several code addresses gets a line breakpoint at each, so a step can stop
on the same line with reason "breakpoint".

### Breakpoints

| VS Code                | TCF breakpoint properties                                         |
| ---------------------- | ----------------------------------------------------------------- |
| Source line breakpoint | `File` (path as in VS Code), `Line`, `Column`                     |
| Function breakpoint    | `Location` = the function name (any expression the agent accepts) |
| Data breakpoint        | `Location` = address, `Size`, `AccessMode` read/write             |
| Instruction breakpoint | `Location` = address, `ContextIds` = the process and its threads  |
| Scoped function bp     | `ContextIds` (` @ ` suffix) or `ContextQuery` (` @? ` suffix)     |
| Condition              | `Condition`, evaluated by the agent                               |
| Hit count `N` / `>= N` | `IgnoreCount` = N - 1                                             |
| Logpoint               | a normal breakpoint; the adapter prints and resumes               |

- A breakpoint is verified when the agent's status reports at least one
  planted instance; the line is moved to where it was planted.
- The reference agent's non-standard `SkipPrologue` is not used.
- The ` @ ` suffix holds exact TCF context IDs, saved with the breakpoint, so
  IDs containing commas cannot be used. Scoped breakpoints are never planted
  globally when the agent lacks `ContextIds` / `ContextQuery` support.
- Editing a breakpoint's contexts replaces it with a new one with the same
  enabled state, condition, hit count and log message. VS Code does not tell
  extensions which breakpoint is selected in the Breakpoints panel, so the
  command asks when there is more than one.
- Instruction breakpoints are limited to the frame's `ProcessID`. With OS
  awareness the Simics agent plants breakpoints per thread (a process has no
  breakpoint group), while the reference agent plants them in the process, so
  `ContextIds` lists the process and all its threads and is updated with
  `Breakpoints.change` as threads come and go. Agents without `ContextIds`
  get the breakpoint in all contexts.

### Target Memory

- The webview talks to the extension, which uses custom DAP requests
  (`src/tcfRequests.ts`) to reach the agent through the debug adapter.
- Physical memory contexts are Memory contexts with the `physical` access
  type, for example a Simics memory space.
- Search runs in the adapter (`tcfFindMemory`): 64 KiB chunks with several
  reads in flight, progress through `tcfFindMemoryProgress` events, MMIO not
  read (`BlockMemoryMappedIO`).
- Ctrl+G and Ctrl+F are keybindings of the view
  (`simics-target-debug.targetMemory.goto` / `.find`).

### Symbol files

Works like "Load symbols" in the Eclipse TCF client:

- Each file becomes a memory map region sent with `MemoryMap.set` when
  attaching, for each listed context, or for all contexts (`""`) with a
  `ContextQuery`. `MemoryMap.set` takes a single context, so a file with
  several contexts is set in each one's map.
- The region has `FileName`, plus `BaseAddress` for an offset (as Simics
  `add-symbol-file -relative` uses) or `Addr` for an absolute load address.
  The agent removes the regions when the session ends.
- File names in the memory map are translated with the path map rules.
- The session's own regions are recognized by their `ID`, unique per session.
  Regions from elsewhere are read with `MemoryMap.get` for the `ProcessID` of
  each core or thread.
- The context picker lists `ContextQuery.query("HasState=true")`, or stateful
  RunControl contexts without that service.
- Saving rewrites `symbolFiles` of the uniquely named configuration in
  `.vscode/launch.json`, keeping other properties and comments.

### Path mapping

Works like the path map in the Eclipse TCF client:

- On attach the rules are sent with `PathMap.set`; the agent matches host
  breakpoint paths against compiled paths.
- Agent-reported paths are mapped to host paths by the extension: configured
  rules first, then rules from `PathMap.get`. The first mapped file that
  exists on the host wins.
- The agent only uses the client's own rules for breakpoints, so rules from
  elsewhere are applied in reverse by the extension. Without the `PathMap`
  service the configured rules are applied in reverse as well.
- Scopes use the `ContextQuery` property of `PathMap.set`:
  `contexts: ["cpu0"]` is sent as `ContextQuery: "ID=cpu0"`. A query cannot select one
  of several IDs, so a rule with several contexts becomes one agent rule per
  context. IDs with punctuation are quoted and escaped.
- Lookups and caches are per context. General queries are evaluated by the
  agent's `ContextQuery` service; exact `ID=...` filters work without it.
  Unscoped breakpoint requests leave scoped rules to the agent. Without
  `PathMap`, scoped reverse mapping requires a context-bearing source and
  breakpoint `ContextIds` support; an unsafe global mapping is rejected.

### TCF trace

`tcfTrace.silence` rules are `service/type/name`. Types are `command` (a
command C and its results R, P and N, matched by token, with the command's
service and name), `event` (E) and `flowControl` (F). Flow control messages
have no service or name, so only `*/flowControl` silences them.

## Known limitations

- No exception breakpoints.
- Breakpoints created by other TCF clients (or the Simics CLI) are not shown.
- Variables and registers are read-only, there is no "Set Value".
- `char *` and `char[]` are not shown as strings.
- No "Restart Frame".
- Path map rules from the agent are read when attaching; rules added in
  Simics while attached apply to new breakpoints only.
- Only TCP transport.
