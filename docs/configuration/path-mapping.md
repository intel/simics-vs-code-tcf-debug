# Path mapping

When the sources are not at the path compiled into the debug information, for
example when the target software was built on another machine or in a
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

## How the rules are used

- On attach the rules are sent to the agent. The agent then matches
  breakpoints set on host paths against the compiled paths.
- Source paths reported by the agent (call stack, moved breakpoints) are
  mapped to host paths by VS Code. The configured rules are tried in order,
  followed by rules the agent has from elsewhere (for example added with the
  Simics command `add-pathmap-entry`). The first mapped file that exists on
  the host is used. Mapped frames show the compiled path in the Call Stack
  tooltip.

A prefix only matches at a path separator, so `/build/src` maps
`/build/src/a.c` but not `/build/src2/a.c`. Both `/` and `\` are accepted in
compiled paths. Invalid rules are reported in the Debug Console and ignored.

## Rules for selected contexts

Rules apply to **all contexts by default**. To scope a rule, set either
`contexts` to a list of exact context IDs or `contextQuery` to a TCF query,
see [Selecting contexts](/configuration/contexts):

```json
"pathMap": [
  {
    "source": "/build/src",
    "destination": "${workspaceFolder}/cpu0",
    "contexts": ["cpu0"]
  },
  {
    "source": "/build/src",
    "destination": "${workspaceFolder}/workers",
    "contextQuery": "/server/**/HasState=true"
  }
]
```

`"contexts": ["cpu0"]` and `"contextQuery": "ID=cpu0"` are equivalent. Set
only one of them per rule; to select an ID together with additional criteria,
use a query such as `ID=cpu0,HasState=true`.

Source lookups are context-specific, so identical compiled paths in different
contexts can resolve to different host files. General queries are evaluated
by the agent's `ContextQuery` service; exact `ID=...` filters work without
it.

## Locate a source file

When a call stack frame's source file is not found on this host, VS Code
shows a placeholder for it instead of offering to create the file, and asks
whether to locate the file. You can also run **Simics Target Debug: Locate
Source File...** from the Command Palette.

Pick the file on this host, and a path map rule is made from the part of the
two paths that differs, for example `/build` → `/home/me` for `/build/fw/a.c`
and `/home/me/fw/a.c`. Before the new rule is applied, choose its contexts
with the [context picker](/configuration/contexts#the-context-picker). The
context of the frame is offered first.

The rule is used at once for the rest of the session, including breakpoints,
and can be saved to the configuration's `pathMap` in `launch.json`.

## The Path Maps view

During a debug session, **Path Maps** in Run and Debug lists the session's
rules in matching order, with the compiled prefix on the left and the host
destination and contexts beside it.

- Use **+** to add a rule.
- Click a rule to edit its paths and contexts, or use its trash button to
  remove it. The contexts are chosen with the
  [context picker](/configuration/contexts#the-context-picker).
- The context menu has **Move Rule Up** and **Move Rule Down** to change the
  priority.

Changes apply immediately and refresh the call stack. Rules created by
**Locate Source File...** appear here too.

Rules that the agent has but this session did not add, for example from
`add-pathmap-entry` in Simics or from another client, are listed read-only
under **Added Elsewhere**. A rule for another host is listed too, but marked
as not used.

## Save to the debug configuration

The view's **Save Path Map to Debug Configuration** button replaces `pathMap`
in the current session's named configuration in `.vscode/launch.json` after
confirmation, including contexts, removals and ordering. Workspace
destinations are saved using `${workspaceFolder}`. Rules under **Added
Elsewhere** are not saved.

Saving requires a workspace launch configuration with a unique name. Changes
that are not saved only apply to the running session.

## Limitations

Rules added in Simics while attached apply to new breakpoints only.
