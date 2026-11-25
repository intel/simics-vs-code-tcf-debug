# Changelog

All notable changes to the Simics Target Debug extension will be documented here.

## [Unreleased]

### Added

- The Call Stack view shows the run control context hierarchy: each context
  with child contexts, such as a process of the Linux tracker, is a nested
  session with its threads. Turn it off with the setting
  `simics-target-debug.callStack.hierarchy`. Turning off
  `simics-target-debug.callStack.compact` gives every context a row of its
  own. Containers with a single thread, such as most processes, show the
  thread in the session above.
- **Simics Target Debug: Open Settings** shows the extension's settings in
  the Settings editor. The Consoles view and TCF Launch Configurations have
  a gear button for it.
- Snapshots view in the Run and Debug side bar: take, restore and delete
  Simics snapshots, one at a time or all at once. New snapshots get a
  name of your own, or one picked like `take-snapshot` does. It uses the
  Simics `SimUtils` service, and is disabled when the agent does not have
  its snapshot commands.
- The Path Maps view lists the agent's rules from elsewhere, for example
  added with `add-pathmap-entry` in Simics, read-only under
  **Added Elsewhere**, like the Symbol Files view does.
- A path map rule can apply to several contexts: `pathMap` rules take a
  `contexts` list of context IDs. Each context is sent to the agent as a rule
  of its own. The old `context` is deprecated.
- Function breakpoints can be scoped with a TCF context query, written as
  `start_kernel @? **/HasState=true`. It is sent as the `ContextQuery`
  breakpoint property. **Add Function Breakpoint...** in Symbol Files also
  works for files with a context query.
- A symbol file can apply to several contexts: `symbolFiles` entries take
  a `contexts` list of IDs or names. The file is added to the memory map of
  each context.

### Changed

- Options that are the same for every session are settings instead of
  launch configuration attributes, and are ignored in `launch.json`:
  `consoles.simicsCli.*` are `simics-target-debug.console.*`,
  `disassemblyFunctionHeaders` is
  `simics-target-debug.disassembly.functionHeaders`, and `traceTcf` and
  `traceTcfSilence` are `simics-target-debug.tcfTrace.enabled` and
  `simics-target-debug.tcfTrace.silence`. The Consoles view's lock button
  saves Editing Keys in the settings.
- The TCF trace silence rules are `"service/type/name"` strings instead of
  objects, so the Settings editor can edit them. settings.json suggests
  services and message types.
  Stay in Console is gone from TCF Launch Configurations,
  turn off `debug.focusEditorOnBreak` instead.
- Symbol files, function breakpoints and path map rules pick their contexts
  the same way: a menu with all contexts, the selected call-stack context, a
  checklist of contexts, or a context query. In TCF Launch Configurations,
  the Contexts column of Symbol Files and Path Map chooses all contexts, a
  list of contexts, or a query, and can pick contexts from a running session
  to the agent.
- The `context` of a symbol file is deprecated, use `contexts`. A symbol file
  can no longer have both contexts and a `contextQuery`.
- In TCF Launch Configurations, the Start, Duplicate and Delete buttons
  above the form, and the Add and Delete All buttons above the list, stay
  visible when you scroll.

### Fixed

- Source breakpoints no longer get a `target=` prefix on their file name
  when the agent has a path map rule for the target file system, such as
  `add-pathmap-entry "target=/host" ...` for binaries found by the Linux
  tracker. Such breakpoints never resolved.
- The file pickers for symbol files now offer the standard file dialog, a `..` entry, and pick files in the
  current folder ([#29](https://github.com/intel/simics-vs-code-tcf-debug/issues/29)).

- The Start button in TCF Launch Configurations is no longer disabled while
  any Simics Target Debug session runs, only for configurations that connect
  to an agent (host and port) that already has a session.

## [0.5.0] - 2026-11-02

Initial release.
