# Changelog

All notable changes to the Simics Target Debug extension will be documented here.

## [Unreleased]

### Added

- The Call Stack view shows the run control context hierarchy: each context
  with child contexts, such as a process of the Linux tracker, is a nested
  session with its threads. Turn it off with `"callStackHierarchy": false`.
  `"callStackCompact": false` gives every context a row of its own.
  Containers with a single thread, such as most processes, show the thread in
  the session above.

### Changed

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
