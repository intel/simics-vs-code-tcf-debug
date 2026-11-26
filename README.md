# Simics Target Debug for VS Code

<table border="0">
  <tr>
    <td align="left" border="0" valign="middle">
      <a href="https://github.com/intel/simics-vs-code-tcf-debug/actions/workflows/test.yml"><img src="https://github.com/intel/simics-vs-code-tcf-debug/actions/workflows/test.yml/badge.svg" alt="Tests" align="middle"></a>&nbsp;
      <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" align="middle"></a>&nbsp;
      <a href="https://github.com/intel/simics-vs-code-tcf-debug/actions/workflows/codeql.yml"><img src="https://github.com/intel/simics-vs-code-tcf-debug/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" align="middle"></a>&nbsp;
      <a href="https://scorecard.dev/viewer/?uri=github.com/intel/simics-vs-code-tcf-debug"><img src="https://api.securityscorecards.dev/projects/github.com/intel/simics-vs-code-tcf-debug/badge" alt="OpenSSF Scorecard" align="middle"></a>&nbsp;
      <a href="https://www.bestpractices.dev/projects/16330"><img src="https://www.bestpractices.dev/projects/16330/badge" alt="OpenSSF Best Practices" align="middle"></a>
    </td>
  </tr>
</table>

Debug software running in Simics, or on any other
[TCF](https://download.eclipse.org/tools/tcf/tcf-docs/) agent, from VS Code.
The extension uses only standard TCF services, so Simics-specific features
(the Simics CLI and snapshots) are simply unavailable on other agents.

## Installation

Build the `.vsix` by running
```sh
npm ci
npm run package
```
Then in VS Code run
**Extensions: Install from VSIX...** and select the generated file.

## Getting started

1. Start a TCF agent in Simics. It listens on port 1534 by default:

   ```
   simics> new-tcf-agent
   ```

2. In VS Code, start debugging and select **Simics Target Debug**. Without a
   `launch.json` this attaches to `localhost:1534`. To configure it, add:

   ```json
   {
     "type": "simics-target-debug",
     "request": "attach",
     "name": "Attach to TCF agent",
     "host": "localhost",
     "port": 1534
   }
   ```

**Simics Target Debug: Edit Launch Configurations** edits these
configurations in a form instead of JSON.

## Features

- **Call stack** – processors, and with OS awareness processes and threads,
  shown as a tree. Expand a thread to see its stack. Right-click a frame for
  **Copy Address**.
- **Stepping** – step over, into and out by source line, or by instruction
  in the Disassembly view. Line stepping needs symbol files.
- **Breakpoints** – line, function, data, instruction and logpoints, with
  conditions and hit counts. Function breakpoints can be limited to some
  cores, see below.
- **Variables and watches** – locals, registers, hovers and expressions in
  the Debug Console, evaluated by the agent in the selected frame.
- **Disassembly** – right-click a frame and select **Open Disassembly View**.
- **Target Memory** – a hex editor for target memory: **Simics Target Debug:
  Open Target Memory**, or **Open in Target Memory** on a variable. Supports
  editing, search (Ctrl+F) and go to address (Ctrl+G).
- **Simics CLI** – the Simics command line opens in a terminal after
  attaching. The **Consoles** view in Run and Debug reconnects it.
- **Snapshots** – take, restore and delete Simics snapshots from the
  **Snapshots** view in Run and Debug.

### Function breakpoints for some cores

Run **Simics Target Debug: Add Function Breakpoint in Context...** (also in
the Breakpoints toolbar and a frame's context menu) and choose the cores.
You can also type the scope directly in a function breakpoint:

- `start_kernel @ board.cpu[0], board.cpu[1]` – the listed context IDs
- `start_kernel @? **/HasState=true` – a TCF context query

## Configuration

### Launch configuration

| Attribute        | Default     | Description                                       |
| ---------------- | ----------- | ------------------------------------------------- |
| `host`           | `localhost` | Host of the TCF agent                             |
| `port`           | `1534`      | TCP port of the TCF agent                         |
| `connectTimeout` | `10000`     | Milliseconds to wait for the agent to answer      |
| `symbolFiles`    | `[]`        | Symbol files to load, see [below](#symbol-files)  |
| `pathMap`        | `[]`        | Source path rules, see [below](#path-mapping)     |

### Settings

Options shared by all sessions are VS Code settings. **Simics Target Debug:
Open Settings** shows them.

| Setting (`simics-target-debug.` ...) | Default | Description                                       |
| ------------------------------------ | ------- | ------------------------------------------------- |
| `console.open`                       | `true`  | Open the Simics CLI after attaching               |
| `console.historySessions`            | `3`     | Earlier sessions shown in the Simics CLI          |
| `console.editingKeys`                | `true`  | Send editing keys such as Ctrl+P to Simics        |
| `callStack.hierarchy`                | `true`  | Group threads in the Call Stack view              |
| `callStack.compact`                  | `true`  | A group that is the only child shares its parent's row |
| `disassembly.functionHeaders`        | `true`  | Show function names in the Disassembly view       |
| `tcfTrace.enabled`                   | `false` | Log TCF messages to Output › Simics Target Debug  |
| `tcfTrace.silence`                   | (list)  | `service/type/name` rules for messages not to log |

Call stack, disassembly and trace settings apply to new sessions.

### Symbol files

Load symbol files when attaching, in addition to `add-symbol-file` in Simics:

```json
"symbolFiles": [
  { "path": "${workspaceFolder}/build/firmware.elf" },
  { "path": "build/app.elf", "contexts": ["board.mb.cpu0.core[0][0]"] },
  { "path": "build/driver.elf", "contextQuery": "**/HasState=true", "address": "0x40000000" },
  { "path": "build/module.elf", "address": "0xff000", "absolute": true }
]
```

| Property       | Description                                                                 |
| -------------- | --------------------------------------------------------------------------- |
| `path`         | ELF file as seen by the agent, relative to the workspace folder             |
| `contexts`     | Context IDs or names the symbols apply to (default: all)                    |
| `contextQuery` | A TCF context query instead of `contexts`                                   |
| `address`      | Offset added to all addresses, like `add-symbol-file -relative`             |
| `absolute`     | If `true`, `address` is where the first loadable segment is loaded          |

The **Symbol Files** view in Run and Debug adds, edits, reloads and removes
files during a session, and its save button writes them back to
`launch.json`. Files loaded elsewhere, for example in Simics, are listed
under **Added Elsewhere**.

### Path mapping

If the sources are not at the path in the debug information, map the
compiled path prefix to the local one:

```json
"pathMap": [
  { "source": "/build/firmware", "destination": "${workspaceFolder}/firmware" },
  { "source": "/build/src", "destination": "${workspaceFolder}/cpu0", "contexts": ["cpu0"] }
]
```

Rules apply to all contexts unless `contexts` or `contextQuery` is set. When
a source file is not found, VS Code offers to locate it and creates a rule
for you. The **Path Maps** view in Run and Debug edits, reorders and saves
the rules.

## Limitations

- No exception breakpoints.
- Breakpoints set by other TCF clients or the Simics CLI are not shown.
- Variables and registers are read-only.
- `char *` and `char[]` are not shown as strings.
- No "Restart Frame".
- Only TCP transport.

## Development

Requires Node.js 24 or later and npm. Run the commands from the repository
root.

Install the dependencies:

```sh
npm ci
```

Build, test and package:

```sh
npm run build     # type check and bundle the extension
npm test          # run the unit tests
npm run package   # create simics-target-debug-<version>.vsix
```

Format the code with Prettier before committing:

```sh
npm run format
```

Other useful commands:

```sh
npm run check               # type check and run the unit tests
npm run watch               # rebuild on changes
npm run compile:production  # minified bundle without source maps
```

To develop in VS Code, open the repository, select **Run Extension** in the
Run and Debug view and press F5. This starts `npm run watch` and opens an
Extension Development Host with the extension loaded. **Run Extension
(Clean)** does the same with all other extensions disabled.
