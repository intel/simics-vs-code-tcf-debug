# Changelog

All notable changes to the Simics Target Debug extension will be documented here.

## [Unreleased]

### Changed

- In TCF Launch Configurations, the Start, Duplicate and Delete buttons
  above the form, and the Add and Delete All buttons above the list, stay
  visible when you scroll.

### Fixed

- The file pickers for symbol files now offer the standard file dialog, a `..` entry, and pick files in the
  current folder ([#29](https://github.com/intel/simics-vs-code-tcf-debug/issues/29)).

- The Start button in TCF Launch Configurations is no longer disabled while
  any Simics Target Debug session runs, only for configurations that connect
  to an agent (host and port) that already has a session.

## [0.5.0] - 2026-11-02

Initial release.
