# Symbol files

Symbol files can be loaded from the debug configuration instead of (or in
addition to) `add-symbol-file` in Simics. They can also be added, edited and
removed in the **Symbol Files** view while debugging.

## In the debug configuration

```json
{
  "type": "simics-target-debug",
  "request": "attach",
  "name": "Attach to TCF agent",
  "port": 1534,
  "symbolFiles": [
    { "path": "${workspaceFolder}/build/firmware.elf" },
    { "path": "build/app.elf", "contexts": ["board.mb.cpu0.core[0][0]"] },
    { "path": "build/driver.elf", "contextQuery": "**/HasState=true", "address": "0x40000000" },
    { "path": "build/module.elf", "address": "0xff000", "absolute": true }
  ]
}
```

| Property       | Description                                                                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`         | The symbol file (ELF with debug information), as seen by the agent. Relative paths are relative to the workspace folder.                                                                                                                             |
| `contexts`     | IDs or names of the contexts the symbols apply to.                                                                                                                                                                                                   |
| `contextQuery` | A TCF context query selecting the contexts the symbols apply to, for example `**/HasState=true` for all processors. Use it instead of `contexts`, not with it.                                                                                       |
| `address`      | Relocation offset added to all addresses in the file, like the Simics command `add-symbol-file -relative`. It may be negative, for example `"-0x1000"`. If not set, the addresses in the file are used. With `absolute`, a load address instead.    |
| `absolute`     | If `true`, `address` is a load address: the symbols are relocated so that the loadable segment with the lowest file offset (normally the first one, see `readelf -lW`) is at this address.                                                           |

Without `contexts` and `contextQuery` the symbols apply to all contexts, see
[Selecting contexts](/configuration/contexts). A file for several contexts is
added to each of them.

The agent removes the symbol files when the debug session ends. The
[path map](/configuration/path-mapping) rules also apply to the paths of
symbol files.

## Relocation

The two ways of relocating differ in what the address refers to. For a file
whose first loadable segment is linked at 0x3ff000, with `.text` at 0x400000:

- `"address": "-0x300000"` subtracts 0x300000 from every address in the file,
  so `.text` ends up at 0x100000.
- `"address": "0xff000", "absolute": true` gives the same result by placing
  that segment at 0xff000. The value must be the segment address, not the
  `.text` address.

## Add symbol files while debugging

To add a symbol file after attaching, open **Symbol Files** in Run and Debug
and use its **+** button, or run **Simics Target Debug: Add Symbol File...**
from the Command Palette. Enter:

- The path as seen by the agent. Relative paths are resolved against the
  debug session's workspace folder. As you type the path, local files and
  folders are suggested; select a folder to list it, or `..` for its parent
  folder. **Browse for a File...** and **Browse for a Folder...** open the
  file dialog. Enter a path directly if the file is only available to the
  agent.
- The contexts the symbols apply to, with the
  [context picker](/configuration/contexts#the-context-picker).
- How the symbols are placed: the file addresses, a relocation offset (like
  `-relative`), or an absolute load address.

The same view lets you change the files:

- The pencil action on a file edits its path, contexts, or load address.
- The reload and remove actions on a file reload or remove its mapping.
- The view's reload button clears and reapplies all symbol mappings so the
  agent can load updated files.

New entries and edits affect only the running session unless they are saved,
see below.

If a configured file is missing on the VS Code host at startup, a warning
offers to update its path using the file picker. The file may still exist on
a remote TCF agent, so the warning can be dismissed.

## Save to the debug configuration

Use **Save Symbol Files to Debug Configuration** (the save button in the
Symbol Files view, also available in the Command Palette) to keep the
session's current list. After confirmation, it replaces `symbolFiles` in the
active session's uniquely named workspace configuration in
`.vscode/launch.json`, including removals, contexts, context queries,
relocation offsets, and absolute load addresses.

- Saving an empty list clears the configured symbol files.
- Paths are saved as reported by the session, since symbol files are opened
  on the agent and may not exist on this host.
- Other configuration properties and surrounding comments are preserved.

## Files added elsewhere

Files that are in the agent's memory maps but were not added by this session,
for example with `add-symbol-file` in Simics, by OS awareness, or by another
client, are listed read-only under **Added Elsewhere** in the Symbol Files
view. They are grouped by file.

The description shows the context, or the number of contexts, and the
relocation offset or lowest mapped address. The tooltip lists the contexts,
the region IDs set by other clients, and the mapped regions.

## When the memory map changes

When the agent reports that the memory map changed while the target is
suspended, for example after `add-symbol-file` in Simics, the call stack and
variables are refreshed. The Symbol Files view is refreshed on any memory map
change.

## Function breakpoints in a symbol file

Right-click a symbol file that has contexts or a context query to add a
function breakpoint in them, see
[Breakpoints](/debugging/breakpoints#add-a-function-breakpoint-from-a-symbol-file).
