# Settings

Options that are the same for all debug sessions are VS Code settings, in the
user or workspace settings.

| Setting                                           | Default   | Description                                                                              |
| ------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `simics-target-debug.console.open`                | `true`    | Open the Simics CLI after attaching, see [Simics console](/debugging/simics-console).    |
| `simics-target-debug.console.historySessions`     | `3`       | Earlier sessions shown above the Simics CLI.                                             |
| `simics-target-debug.console.editingKeys`         | `true`    | Send editing keys such as Ctrl+P to Simics.                                              |
| `simics-target-debug.callStack.hierarchy`         | `true`    | Groups in the [Call Stack](/debugging/call-stack#layout-settings) view.                  |
| `simics-target-debug.callStack.compact`           | `true`    | A group that is alone in its parent shares the parent's row.                             |
| `simics-target-debug.disassembly.functionHeaders` | `true`    | [Function header rows](/debugging/disassembly#function-headers) in the Disassembly view. |
| `simics-target-debug.tcfTrace.enabled`            | `false`   | Log TCF messages to Output › Simics Target Debug, see [TCF trace](#tcf-trace).           |
| `simics-target-debug.tcfTrace.silence`            | see below | TCF messages left out of the TCF trace.                                                  |

The call stack, disassembly and TCF trace settings are read when a debug
session starts.

## Open the settings

**Simics Target Debug: Open Settings** in the Command Palette shows the
settings of the extension in the Settings editor of VS Code. The **Open
Settings** button in the title of the Consoles view and of the
[launch configurations editor](/configuration/launch-configurations#launch-configurations-editor)
does the same.

To keep the focus in the Simics console when the target stops, turn off the
VS Code setting `debug.focusEditorOnBreak`, see
[Simics console](/debugging/simics-console#stay-in-the-console-when-the-target-stops).

## TCF trace

Turn on `simics-target-debug.tcfTrace.enabled` to log the TCF messages
between VS Code and the agent in Output › Simics Target Debug.
`simics-target-debug.tcfTrace.silence` lists the messages to leave out. The
default silences the agent's `Locator` peer events, such as the heartbeat,
the Simics console (the `CommandLine` service) and the Simics log events:

```json
"simics-target-debug.tcfTrace.silence": [
  "Locator/event/peerHeartBeat",
  "Locator/event/peerAdded",
  "Locator/event/peerRemoved",
  "Locator/event/peerChanged",
  "CommandLine",
  "SimicsLogs/event"
]
```

- Each item is a rule `service/type/name`. It silences the messages of
  `service` that have the type `type` and are called `name`.
- `*` matches anything, and so does a part that is left out: `CommandLine`
  silences all messages of that service.
- The types are `command` (a command C and its results R, P and N, which the
  agent sends back with the command's token), `event` (E) and `flowControl`
  (F). A command's results have its service and name. A rule can have several
  types, separated by commas, such as `Memory/command,event`.
- Flow control messages have no service or name, so only a rule with `*` as
  service and no name, such as `*/flowControl`, silences them.
- A list in the settings replaces the default. Remove a rule to log its
  messages. `[]` logs everything.

In `settings.json`, services and message types are suggested while you type
a rule. The suggested services are those of the Simics TCF agent; any other
service name can be typed too.
