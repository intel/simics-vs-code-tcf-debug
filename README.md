# Simics Target Debug for VS Code

<table border="0">
  <tr>
    <td align="left" border="0" valign="middle">
      <a href="https://github.com/intel/simics-vs-code-tcf-debug/actions/workflows/test.yml"><img src="https://github.com/intel/simics-vs-code-tcf-debug/actions/workflows/test.yml/badge.svg" alt="Tests" align="middle"></a>&nbsp;
      <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" align="middle"></a>&nbsp;
      <a href="https://scorecard.dev/viewer/?uri=github.com/intel/simics-vs-code-tcf-debug"><img src="https://api.securityscorecards.dev/projects/github.com/intel/simics-vs-code-tcf-debug/badge" alt="OpenSSF Scorecard" align="middle"></a>&nbsp;
      <a href="https://www.bestpractices.dev/projects/16330"><img src="https://www.bestpractices.dev/projects/16330/badge" alt="OpenSSF Best Practices" align="middle"></a>
    </td>
  </tr>
</table>

A VS Code debugger extension that connects to a
[TCF](https://download.eclipse.org/tools/tcf/tcf-docs/) agent, for example the
Simics TCF agent. It only uses standard TCF services (`Locator`, `RunControl`,
`Registers`, `LineNumbers`, `Symbols`, `StackTrace`, `Breakpoints`,
`Expressions`, `Memory`), so it should work with any agent that follows the TCF
pspecification.

The extension implements the VS Code Debug Adapter Protocol (DAP) in-process
and translates DAP requests to TCF commands:

| VS Code (DAP)            | TCF                                                        |
|--------------------------|------------------------------------------------------------|
| attach                   | TCP connection + `Locator.Hello`                           |
| threads                  | `RunControl` contexts with `HasState`                      |
| pause / continue         | `RunControl.suspend` / `RunControl.resume`                 |
| step over / into / out   | `RunControl.resume` with a step mode, see below            |
| stopped / continued      | `contextSuspended`, `containerSuspended`, `contextResumed`, `containerResumed` events |
| call stack               | `StackTrace.getChildrenRange` / `getChildren` / `getContext`, see below |
| Locals scope             | `Expressions.getChildren` of the selected frame, see below |
| watch / hover / Debug Console | `Expressions.create` / `evaluate` in the selected frame |
| Registers scope          | `Registers.getChildren` / `getContext` / `get` for the selected frame, hierarchical |
| disassembly              | `Disassembly.disassemble` in the frame's context    |
| breakpoints              | `Breakpoints.add` / `change` / `remove`, `status` events, see below |
| Target Memory (custom requests) | `Memory.get` / `set` / `getChildren` / `getContext`, `memoryChanged` events, search in the adapter, see below |

Register contexts without a readable value (for example Simics register groups)
are shown as expandable groups. Registers with fields can be expanded to show
the fields.

### Variables and expressions

Variables work like in the Eclipse TCF client; the agent does all parsing and
evaluation:

- The Locals scope lists what `Expressions.getChildren(<frame ID>)` returns:
  local variables and arguments of the frame.
- Values are evaluated by the agent (`Expressions.evaluate`) and formatted
  using the value's type class and the type from the `Symbols` service:
  integers, characters, booleans, enumerators (by name), floating point and
  pointers. Structs, unions and arrays are summarized as `{...}` and `[N]`.
- Structs, unions, arrays and non-null pointers can be expanded. The children
  are new expressions built from the parent expression and member symbol IDs,
  for example `(parent).${<member symbol ID>}`, `(parent)[3]` and
  `*(parent)`; pointers to structs expand directly to the members. Arrays with
  more than 100 elements are shown in pages.
- Watch expressions, hovers and expressions typed in the Debug Console are
  evaluated in the selected frame. "Add to Watch" and "Copy as Expression" use
  a readable expression such as `s->corners[2].x`.

Values are read when the thread is suspended and are refreshed after each
resume or step.

### Call stack

The call stack of a suspended thread comes from the `StackTrace` service. VS
Code first loads the top frame and then the rest in pages ("Load More Stack
Frames"), which uses `getChildrenRange`; agents without it fall back to
`getChildren`.

For each frame the function name and source line are taken from the frame's
`FuncID` and `CodeArea` when the agent reports them (inlined frames), otherwise
they are looked up with `Symbols.findByAddr` and `LineNumbers.mapToSource`. For
caller frames the address before the return address is used, so the frame
shows the line of the call. Frames without source are shown dimmed, and frames
without a known function show the address instead. To get the address of any
frame (the PC, or the return address for caller frames), right-click it and
select **Copy Address**. A last frame without return address (IP 0), where the
agent stopped unwinding, is left out.

Selecting a frame shows the local variables and registers of that frame, as
unwound by the agent.
Without the `StackTrace` service, or if it fails, a single frame for the PC is
shown.

### Disassembly

When the agent offers the `Disassembly` service, open a stack frame's context
menu and select **Open Disassembly View**. The view shows decoded instructions
and opcode bytes when the agent provides them. It works without source files;
the frame's reference keeps its TCF context so multiple CPUs can be inspected.
Plain address references use the first suspended thread.

The service decodes a byte range, so on instruction sets with variable length
(x86) the instructions before an address have to be found by decoding from
an earlier address, which can get out of step with the real instructions.
The adapter keeps decoding in step with addresses known to start an
instruction: PCs where a context stopped (the most recent 4096 per context,
dropped when the memory map changes) and line starts from the
`LineNumbers` service. Decoding starts at such an address shortly before the
range when there is one, and restarts at one when a decoded instruction runs
over it. Otherwise, start addresses up to 15 bytes later are tried until
decoding lands on the next known address.

The agent decodes from the start of the function (or line area) containing
the requested address and stops at its end, so the adapter keeps requesting
from where each reply ended until the range is covered. When the instructions
before an address cannot be decoded up to it (unreadable memory), they are
returned with address `-1`, which VS Code skips, so instructions it already
shows there are kept instead of being replaced by `??`.

Some agents take long per request (slow symbol lookup in large modules), so
replies are cached per context. Code rarely changes, so the cache is kept when
stepping. After a resume or a memory write, cached replies are only used once a
single `Memory.get` shows that their opcode bytes are unchanged; a memory map
change clears the cache.

Function entries get a header row, like `objdump`, when the agent offers the
`Symbols` service. VS Code shows it through its source line support, which
puts the line number first: `22: dummy-prog1.c: <start>` gives the source
line and file of the entry (from `LineNumbers`), or `1: <start>` without
line information. It needs `debug.disassemblyView.showSourceCode` (default on);
double-clicking it opens a read-only document with the header on that line. The
documents come from a file system (scheme `simics-target-debug-function`)
because VS Code fails to re-render rows whose document comes from a content
provider. Inlined functions get no header. A function is looked up once
(`Symbols.findByAddr` and `getContext`) and covers all its instructions;
results are kept until the memory map changes. Code without symbols needs a
lookup per instruction, so at most 64 lookups are made per request, nearest the
requested address first. Turn them off with `"disassemblyFunctionHeaders":
false` (under **Advanced** in the launch configurations editor).

### Stepping

Steps are sent to the thread's own run control context:

| VS Code      | TCF resume mode (default)  | TCF resume mode (instruction granularity) |
|--------------|----------------------------|-------------------------------------------|
| Step Over    | `RM_STEP_OVER_LINE` (3)    | `RM_STEP_OVER` (1)                        |
| Step Into    | `RM_STEP_INTO_LINE` (4)    | `RM_STEP_INTO` (2)                        |
| Step Out     | `RM_STEP_OUT` (5)          | `RM_STEP_OUT` (5)                         |

Line stepping requires that the agent knows the symbol files for the target,
for example loaded with `add-symbol-file` in Simics or with `symbolFiles` in
the debug configuration. If the context does not
support line stepping (its `CanResume` bit set) instruction stepping is used
instead. The Simics agent itself falls back to instruction stepping when there
is no line information for the current PC.

A line step only completes when execution reaches another line, so stepping
over a line that loops forever keeps the target running until it is paused.

A line can have several code addresses (for example several line table rows
for one statement), and the agent plants a line breakpoint at all of them. A
step from the first address then stops at the next one on the same line with
reason "breakpoint"; step again to continue.

### Breakpoints

Breakpoints are kept in sync with the agent's breakpoint table: adding,
editing and removing breakpoints in VS Code sends `Breakpoints.add`, `change`
and `remove`. Breakpoints apply to all contexts the agent debugs, except
instruction breakpoints, see below.

| VS Code                         | TCF breakpoint properties                          |
|---------------------------------|----------------------------------------------------|
| Source line breakpoint          | `File` (path as in VS Code), `Line`, `Column`      |
| Function breakpoint             | `Location` = the function name (any expression the agent accepts) |
| Data breakpoint (Breakpoints view: "Add Data Breakpoint at Address") | `Location` = address, `Size`, `AccessMode` read/write |
| Instruction breakpoint (click left of an instruction in the Disassembly view) | `Location` = address, `ContextIds` = the process and its threads |
| Condition                       | `Condition`, evaluated by the agent                |
| Hit count `N` or `>= N`         | `IgnoreCount` = N - 1 (break from the N:th hit)    |
| Logpoint                        | a normal breakpoint, see below                     |

A breakpoint is shown as verified when the agent reports at least one planted
instance in its status. The line is moved to where the agent planted it, for
example from a line without code to the next line with code. Errors from the
agent (unknown file, line without code, invalid expression) are shown on the
breakpoint.

Logpoints are planted as breakpoints. When one is hit, the adapter prints the
message to the Debug Console, with `{expression}` evaluated by the agent's
`Expressions` service, and resumes the target. A step that is interrupted by
a logpoint stops there.

Function breakpoints stop at the first instruction of the function. The
reference TCF agent also supports a non-standard `SkipPrologue` property which
is not used, to stay within the TCF specification.

An address only has a meaning in one address space, so an instruction
breakpoint is limited to the process of the context shown in the Disassembly
view (its `ProcessID`). `ContextIds` lists the process and all its threads:
with OS awareness the Simics agent plants breakpoints per thread (a process
has no breakpoint group), while the reference agent plants them in the
process. The list is updated with `Breakpoints.change` when threads are
created or exit. Without OS awareness the process of a CPU context is the CPU
itself. Agents that do not support `ContextIds` get the breakpoint in all
contexts.

### Target Memory

**Simics Target Debug: Open Target Memory** (also in the debug toolbar) opens a
hex view of target memory. **Open in Target Memory** in the Variables view
context menu shows what a pointer points to, or where any other variable is
stored, with the variable's bytes selected. **New Target Memory View** (in the
editor title bar of the view) opens another one. Unreadable bytes are shown as
`??`. The webview talks to the extension, which uses custom DAP requests
(`src/tcfRequests.ts`) to access the agent's memory through the debug adapter.

- The view shows the memory of the focused thread, or of a physical memory
  context (a Memory context with the `physical` access type, for example a
  Simics memory space) selected in the drop-down list. Physical memory
  contexts have full names like the threads in the call stack, for example
  `board.mb.phys_mem`.
- Enter an address (`0x1000`, or decimal) or an expression (`&buffer`,
  `$sp`) evaluated in the selected frame, and press Enter to go there. Ctrl+G
  moves to the address box. Ctrl+G and Ctrl+F are keybindings of the view
  (`simics-target-debug.targetMemory.goto` / `.find`), active while it is the
  active editor, so they replace VS Code's Go to Line and Find there. Scroll
  anywhere in the address space.
- Memory is read again automatically when the target stops, when another
  thread gets the focus and when the agent reports `Memory.memoryChanged`.
  Bytes that changed are shown in red. The refresh button reads memory again
  on demand. While the target runs, thread memory is dimmed and cannot be
  changed; physical memory can still be read.
- Group 1, 2, 4 or 8 bytes. Groups are shown as numbers in little (default)
  or big endian. The number of bytes per row is fixed or fits the width.
- Edit memory by typing hex digits over the groups, or text in the text
  column. Click a digit, or move with Left/Right, to put the caret on it;
  typing replaces just that digit. Up/Down keep the digit, Ctrl+Left/Right
  move by group and Shift+arrows select. Changed bytes are shown underlined
  until written: an Apply/Discard bar appears (Enter/Escape). Backspace moves
  back one digit and restores its original value.
- Ctrl+F finds hex numbers (in the selected byte order, so `12345678` in
  little endian is the bytes `78 56 34 12`; single bytes such as `de ad be ef`
  are a byte sequence), ASCII text, or an 8 to 64-bit integer. The search can
  be limited to aligned addresses, for example to find an 8-byte integer only
  at multiples of 8, and to a range (by default the low 1 TiB). Enter and
  Shift+Enter search forward and backward from the selection and wrap around
  in the range. The buttons next to the range fields set it to start or end at
  the cursor; a hint offers that when the cursor is outside the range.
- The search runs in the debug adapter (`tcfFindMemory`), which reads 64 KiB
  chunks with several reads in flight and reports progress with
  `tcfFindMemoryProgress` events; MMIO is not read (`BlockMemoryMappedIO`).
- The data inspector shows the bytes at the cursor as integers and floating
  point numbers. Right-click for copy (hex, text or address) commands; they
  act on the right-clicked entry, or on the selection if it is in it.

### Simics console

When the agent has the Simics `CommandLine` service, the Simics command line
opens in a terminal named **Simics CLI** after attaching. Its options are
under `consoles.simicsCli`, or **Console** in the launch configurations
editor:

```json
"consoles": {
    "simicsCli": { "open": true, "historySessions": 3, "editingKeys": true }
}
```

- `open`: open the console after attaching. When off, open it from the
  Consoles view. When on, the Debug Console does not open at start.
- Simics does all line editing, history and tab completion.
- The console uses the debug session's connection. When the session ends,
  it stays open, read-only and grayed out.
- The **Consoles** view in the Run and Debug side bar lists the console of
  each agent and its state. Click it to show it, or to connect it when it
  is not open or disconnected.
- The next session with the same agent shows the output of earlier
  sessions above the command line, also after a window reload.
  `historySessions` sets how many; 0 turns it off. **Clear History** in the
  Consoles view deletes them.
- Ctrl+C copies the selection and stops the simulation. Ctrl+D is not sent.
- `editingKeys` sends Ctrl+E, F, G, K, P, R, W (and Ctrl+_ on Windows) to
  Simics instead of VS Code while the console has focus. The lock button in
  the Consoles view switches it and saves it in launch.json.
- **Stay in Console** keeps the focus in the console when the target stops,
  so that Enter repeats for example `step-line`. It sets
  `debug.focusEditorOnBreak` in the workspace settings.
- Simics log messages are shown in the console. The console's TCF traffic is
  left out of the `"traceTcf": true` log unless `traceTcfSilence` is changed,
  see [TCF trace](#tcf-trace).

## Building

Requirements: Node.js (>= 20) and npm.

```sh
npm ci                          # install dependencies from package-lock.json
npm run build                   # type check and bundle the extension into out/
npm run check                   # type check and run the unit tests
npm run package                 # build and package simics-target-debug-<version>.vsix
```

Use `npm run watch` while developing, or `npm run compile:production` for a
minified bundle without source maps. `npm run package` builds a production-ready
`.vsix` file.

## Installation

Clone the repository, then run these commands from its root directory:

```sh
npm ci
npm run package
```

Install the generated `.vsix` file in VS Code:

1. Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> to open the Command Palette.
2. Run `Extensions: Install from VSIX...`.
3. Select the generated `.vsix` file.

## Running

1. Start a TCF agent, for example in Simics:

   ```
   simics> new-tcf-agent
   ```

   This listens on TCP port 1534 by default. Use
   `new-tcf-agent parameters = "TCP::<port>"` to select another port.

2. Open this folder in VS Code and press F5 ("Run Extension"). This builds the
   extension, watches for changes, and starts an Extension Development Host.
   Alternatively install the `.vsix` with "Extensions: Install from VSIX...".

3. In the Extension Development Host, start debugging with a launch
   configuration like:

   ```json
   {
     "type": "simics-target-debug",
     "request": "attach",
     "name": "Attach to TCF agent",
     "host": "localhost",
     "port": 1534
   }
   ```

   Without a `launch.json`, selecting the "Simics Target Debug" debugger
   attaches to `localhost:1534`.

Configuration attributes:

| Attribute                    | Default     | Description                                          |
|------------------------------|-------------|------------------------------------------------------|
| `host`                       | `localhost` | Host of the TCF agent                                |
| `port`                       | `1534`      | TCP port of the TCF agent                            |
| `connectTimeout`             | `10000`     | Milliseconds to wait for the agent's `Locator.Hello` |
| `pathMap`                    | `[]`        | Source path mapping rules, see below                 |
| `symbolFiles`                | `[]`        | Symbol files to load, see below                      |
| `traceTcf`                   | `false`     | Log TCF messages to Output › Simics Target Debug     |
| `traceTcfSilence`            | see below   | TCF messages left out of the `traceTcf` log          |
| `disassemblyFunctionHeaders` | `true`      | Function header rows in the Disassembly view         |

### TCF trace

`"traceTcf": true` logs the TCF messages between VS Code and the agent in
Output › Simics Target Debug. `traceTcfSilence` lists the messages to leave
out. The default silences the agent's `Locator` peer events, such as the
heartbeat, and the Simics console (the `CommandLine` service):

```json
"traceTcfSilence": [
  { "service": "Locator", "type": ["event"], "name": "peerHeartBeat" },
  { "service": "Locator", "type": ["event"], "name": "peerAdded" },
  { "service": "Locator", "type": ["event"], "name": "peerRemoved" },
  { "service": "Locator", "type": ["event"], "name": "peerChanged" },
  { "service": "CommandLine", "type": ["*"], "name": "*" }
]
```

- An item silences the messages of `service` that have one of the types in
  `type` and are called `name`. `"*"` matches anything, and is used if `type`
  or `name` is left out.
- The types are `command` (a command C and its results R, P and N, which the
  agent sends back with the command's token), `event` (E) and `flowControl`
  (F). A command's results have its service and name.
- Flow control messages have no service or name, so only items with `"*"`
  for both silence them.
- A list in `launch.json` replaces the default. `[]` logs everything.

### Launch configurations editor

**Simics Target Debug: Edit Launch Configurations** in the Command Palette
opens the `simics-target-debug` configurations of `.vscode/launch.json` in a
form, like the Settings editor: the configuration names on the left, the
attributes of the selected one on the right. With several workspace folders it
asks which folder to use, and it creates `launch.json` if there is none. The
buttons in the editor title switch between the form and the text of
`launch.json`, and **Open With...** on `launch.json` offers the form too.

- Each change is written to `launch.json` and saved at once. Only the changed
  value is rewritten, so comments, formatting and other debug types are kept.
- Text boxes write their value when they lose focus or Enter is pressed.
  **Reset** removes an attribute, so its default is used.
- A list with a default, like `traceTcfSilence`, shows the default items while
  it is not set. The first change writes the changed list to `launch.json`.
- In the `traceTcfSilence` table, **Type** is a dropdown with a checkbox for
  each message type. Checking `*` unchecks the others. Checking **Flow Control**
  sets **Service** and **Name** to `*`. New rows get `*` as type and name.
  **Service** suggests `*` and the services of the Simics TCF agent while you
  type, or with its arrow button; any other service name can be typed too.
- **Add**, **Duplicate** and **Delete** manage whole configurations. New names
  are made unique.
- Changes made in the text editor show up in the form at once. While
  `launch.json` has syntax errors the form is read-only.
- The fields come from `configurationAttributes` in `package.json`, so new
  attributes appear without changes to the form. Of VS Code's own options
  only `internalConsoleOptions` (when to open the Debug Console) is shown,
  under **Advanced** at the end, with `connectTimeout`,
  `disassemblyFunctionHeaders`, `traceTcf` and `traceTcfSilence`. The Simics console options
  and **Stay in Console** are under **Console**, just before **Advanced**.
  Others, like
  `preLaunchTask`, are listed under **Other Attributes** when set, and can be
  edited in the text.

Attributes in the `launch` section of a `.code-workspace` file are not shown.

### Symbol files

Symbol files can be loaded from the debug configuration instead of (or in
addition to) `add-symbol-file` in Simics:

```json
{
  "type": "simics-target-debug",
  "request": "attach",
  "name": "Attach to TCF agent",
  "port": 1534,
  "symbolFiles": [
    { "path": "${workspaceFolder}/build/firmware.elf" },
    { "path": "build/app.elf", "context": "board.mb.cpu0.core[0][0]" },
    { "path": "build/driver.elf", "contextQuery": "**/HasState=true", "address": "0x40000000" },
    { "path": "build/module.elf", "address": "0xff000", "absolute": true }
  ]
}
```

| Property       | Description |
|----------------|-------------|
| `path`         | The symbol file (ELF with debug information), as seen by the agent. Relative paths are relative to the workspace folder. |
| `context`      | ID or name of the context the symbols apply to. |
| `contextQuery` | A TCF context query selecting the contexts the symbols apply to, for example `**/HasState=true` for all processors. |
| `address`      | Relocation offset added to all addresses in the file, like the Simics command `add-symbol-file -relative`. It may be negative, for example `"-0x1000"`. If not set, the addresses in the file are used. With `absolute`, a load address instead, see below. |
| `absolute`     | If `true`, `address` is a load address: the symbols are relocated so that the loadable segment with the lowest file offset (normally the first one, see `readelf -lW`) is at this address. |

Without `context` and `contextQuery` the symbols apply to all contexts. Both
can be combined.

The two ways of relocating differ in what the address refers to. For a file
whose first loadable segment is linked at 0x3ff000, with `.text` at 0x400000:

- `"address": "-0x300000"` subtracts 0x300000 from every address in the file,
  so `.text` ends up at 0x100000.
- `"address": "0xff000", "absolute": true` gives the same result by placing
  that segment at 0xff000. The value must be the segment address, not the
  `.text` address.

This works like "Load symbols" in the Eclipse TCF client: each file becomes a
memory map region that is sent to the agent with `MemoryMap.set` when
attaching, for the given context or for all contexts (`""`) with a
`ContextQuery`. The region has the `FileName`, plus the standard `BaseAddress`
property for an offset (which is what Simics `add-symbol-file -relative` uses
too) or `Addr` for an absolute load address. The agent removes the regions
when the debug session ends. File names in the memory map are translated with
the path map rules, so `pathMap` also applies to symbol files.

To add a symbol file after attaching, open **Symbol Files** in Run and Debug
and use its **+** button (or **Simics Target Debug: Add Symbol File...** in the
Command Palette). Enter the path as seen by the agent, an optional context
ID/name and context query, and how the symbols are placed: the file addresses,
a relocation offset (like `-relative`), or an absolute load address. Relative
paths are resolved against the debug session's workspace folder. As you type
the path, local files and folders are suggested; select a folder to browse it,
or enter a path directly if the file is only available to the agent. The
context picker suggests cores returned by the agent's
`ContextQuery.query("HasState=true")` (or stateful RunControl contexts if that
service is unavailable). Selecting one uses its ID; you can also enter a name
directly or select **All contexts**. New entries are added to those from
`symbolFiles` for the running session only unless explicitly saved. Use the
pencil action on a file in the Symbol Files view to edit its path, context,
context query, or load address. The same view lets you reload or remove a
mapping. If a configured file is missing on the VS Code host at startup, a
warning offers to update its path using the file picker. The file may still
exist on a remote TCF agent, so the warning can be dismissed. Mapping edits
affect only the current session unless explicitly saved.
The view's reload button clears and reapplies all symbol mappings so the
agent can load updated files; removing the last file for a context clears
that context's map.

Use **Save Symbol Files to Debug Configuration** (the save button in the
Symbol Files view, also available in the Command Palette) to persist the
session's current list. After confirmation, it replaces `symbolFiles` in
the active session's uniquely named workspace configuration in
`.vscode/launch.json`, including removals, context IDs, context queries,
relocation offsets, and absolute load addresses. Saving an empty list clears
the configured symbol files. Paths are saved as reported by the session,
since symbol files are opened on the agent and may not exist on this host.
Other configuration properties and surrounding comments are preserved.

Files that are in the agent's memory maps but were not added by this
session, for example with `add-symbol-file` in Simics, by OS awareness, or by
another client, are listed read-only under **Added Elsewhere** in the
Symbol Files view. They are read with `MemoryMap.get` for the memory context
(`ProcessID`) of each core or thread, and grouped by file. The description
shows the context, or the number of contexts, and the relocation offset or
lowest mapped address; the tooltip lists the contexts, the region IDs set by
other clients, and the mapped regions. The session's own regions are
recognized by their `ID`, which is unique per debug session.

When the agent reports that the memory map changed while the target is
suspended, for example after `add-symbol-file` in Simics, the call stack and
variables are refreshed. The Symbol Files view is refreshed on any memory map
change.

### Path mapping

When the sources are not at the path compiled into the debug information,
for example when the target software was built on another machine or in a
container, add `pathMap` rules that map a compiled path prefix (`source`) to
the path prefix on this host (`destination`):

```json
{
  "type": "simics-target-debug",
  "request": "attach",
  "name": "Attach to TCF agent",
  "port": 1534,
  "pathMap": [
    { "source": "/build/firmware", "destination": "${workspaceFolder}/firmware" },
    { "source": "C:\\work\\libs", "destination": "/home/me/libs" }
  ]
}
```

This works like the path map in the Eclipse TCF client:

- On attach the rules are sent to the agent with `PathMap.set`. The agent then
  matches breakpoints set on host paths against the compiled paths.
- Source paths reported by the agent (call stack, moved breakpoints) are mapped
  to host paths by VS Code. The configured rules are tried in order, followed
  by rules the agent has from elsewhere (`PathMap.get`, for example added with
  the Simics command `add-pathmap-entry`). The first mapped file that exists on
  the host is used. Mapped frames show the compiled path in the Call Stack
  tooltip.
- For breakpoints, rules the agent has from elsewhere are applied in reverse by
  VS Code, since the agent only uses the client's own rules for breakpoints.
  With agents without the `PathMap` service, the configured rules are applied
  in reverse as well.

A prefix only matches at a path separator, so `/build/src` maps
`/build/src/a.c` but not `/build/src2/a.c`. Both `/` and `\` are accepted in
compiled paths. Invalid rules are reported in the Debug Console and ignored.

Rules apply to **all contexts by default**. To scope a rule, set either
`context` to an exact context ID or `contextQuery` to a TCF query:

```json
"pathMap": [
  {
    "source": "/build/src",
    "destination": "${workspaceFolder}/cpu0",
    "context": "cpu0"
  },
  {
    "source": "/build/src",
    "destination": "${workspaceFolder}/workers",
    "contextQuery": "/server/**/HasState=true"
  }
]
```

Both options use the protocol's `ContextQuery` property in `PathMap.set`.
For example, `context: "cpu0"` is sent as `ContextQuery: "ID=cpu0"`;
`contextQuery: "ID=cpu0"` is equivalent. IDs containing punctuation are
quoted and escaped as TCF query values. Set only one scope field per rule;
to select an ID together with additional criteria, use a query such as
`ID=cpu0,HasState=true`.

Source lookups and their caches are context-specific, including rules
reported by `PathMap.get`, so identical compiled paths in different contexts
can resolve to different host files. General queries are evaluated by the
agent's `ContextQuery` service; exact `ID=...` filters work without it.
Unscoped breakpoint requests leave scoped rules to the agent's `PathMap`
service rather than applying one context's mapping globally. Without that
service, scoped reverse mapping requires a context-bearing source and
breakpoint `ContextIds` support; an unsafe global mapping is rejected.

When a call stack frame's source file is not found on this host, VS Code
shows a placeholder for it instead of offering to create the file, and asks
whether to locate the file. You can also run **Simics Target Debug: Locate
Source File...** from the Command Palette. Pick the file on this host, and a
path map rule is made from the part of the two paths that differs, for example
`/build` → `/home/me` for `/build/fw/a.c` and `/home/me/fw/a.c`. The rule is
used at once for the rest of the session, including breakpoints, and can be
saved to the configuration's `pathMap` in launch.json. Before applying the
new rule, choose **All contexts**, **Context ID** (prefilled with the frame's
context ID), or **Context query**.

During a Simics Target Debug session, **Run and Debug > Path Maps** lists the
session's rules in matching order, with the compiled prefix on the left and the
host destination and scope beside it. Use **+** to add a rule, click a rule to
edit its paths and scope, or use its trash button to remove it.
The context menu has **Move Rule
Up/Down** to change priority. Changes apply immediately and refresh the call
stack; rules created by **Locate Source File...** appear here too.

The view's **Save Path Map to Debug Configuration** button replaces `pathMap`
in the current session's named configuration in `.vscode/launch.json` after
confirmation, including scopes, removals and ordering. Workspace destinations are
saved using `${workspaceFolder}`. Saving requires a workspace launch
configuration with a unique name; session-only changes do not modify it.
The view manages this debug client's rules, not rules installed separately
on the agent (for example with `add-pathmap-entry`).

## Source layout

- `src/extension.ts` – VS Code entry point, registers the `simics-target-debug`
  debug type.
- `src/tcfDebugSession.ts` – DAP implementation (no `vscode` dependency, so it
  can also be run as a standalone debug adapter later).
- `src/breakpointManager.ts` – keeps the agent's breakpoint table in sync with
  VS Code.
- `src/variables.ts` – local variables and expressions through the
  `Expressions` and `Symbols` services.
- `src/pathMapper.ts` – path mapping between compiled and host paths.
- `src/symbolFiles.ts` – symbol files from the debug configuration, sent to
  the agent's memory map.
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
- `src/launchSettings/` – the TCF Launch Configurations editor: reading and editing
  `launch.json` (`launchJson.ts`), form fields from `package.json`
  (`schema.ts`), the custom editor (`editorProvider.ts`) and the form in its
  webview (`webview/`).
- `src/tcf/channel.ts` – TCF TCP channel: framing, escaping, tokens, events.
- `src/tcf/json.ts` – JSON parsing that keeps 64-bit integers exact (`bigint`).
- `src/tcf/services/` – typed wrappers for TCF services.
- `src/test/` – unit tests (`node:test`), they need no TCF agent.

## Current limitations

- No exception breakpoints.
- Breakpoints created by other TCF clients (or the Simics CLI) are not shown.
- Variables and registers are read-only, there is no "Set Value".
- `char *` and `char[]` are not shown as strings; expand them to see the
  characters.
- No "Restart Frame".
- Path map rules are read when attaching; changing them requires a new debug
  session. Rules added in Simics while attached apply to new breakpoints only.
- Only TCP transport.
