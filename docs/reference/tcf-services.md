# TCF services

The extension implements the VS Code Debug Adapter Protocol (DAP) and
translates DAP requests to commands of the
[Target Communication Framework](https://download.eclipse.org/tools/tcf/tcf-docs/)
(TCF). The debugger uses standard TCF services, so it should work with any
agent that follows the TCF specification. The
[Simics console](/debugging/simics-console) and
[snapshots](/debugging/snapshots) need services that only the Simics agent
has.

Turn on the [TCF trace](/configuration/settings#tcf-trace) to see the
messages between VS Code and the agent.

## VS Code features

| VS Code (DAP)                 | TCF                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| attach                        | TCP connection + `Locator.Hello`                                                      |
| threads                       | `RunControl` contexts with `HasState`, see [Call stack](/debugging/call-stack)        |
| pause / continue              | `RunControl.suspend` / `RunControl.resume`                                            |
| step over / into / out        | `RunControl.resume` with a step mode, see [below](#stepping)                          |
| stopped / continued           | `contextSuspended`, `containerSuspended`, `contextResumed`, `containerResumed` events |
| call stack                    | `StackTrace.getChildrenRange` / `getChildren` / `getContext`                          |
| Locals scope                  | `Expressions.getChildren` of the selected frame                                       |
| watch / hover / Debug Console | `Expressions.create` / `evaluate` in the selected frame                               |
| Registers scope               | `Registers.getChildren` / `getContext` / `get` for the selected frame                 |
| disassembly                   | `Disassembly.disassemble` in the frame's context                                      |
| breakpoints                   | `Breakpoints.add` / `change` / `remove`, `status` events, see [below](#breakpoints)   |
| Target Memory                 | `Memory.get` / `set` / `getChildren` / `getContext`, `memoryChanged` events           |
| symbol files                  | `MemoryMap.set` / `get`                                                               |
| path mapping                  | `PathMap.set` / `get`                                                                 |
| context queries               | `ContextQuery.query`                                                                  |
| Simics console                | Simics `CommandLine` service                                                          |
| Snapshots                     | Simics `SimUtils.getSnapshotIDs` / `takeSnapshot` / `restoreSnapshot` / `deleteSnapshot`, `snapshotsChanged` events |

## Stepping

Steps are sent to the thread's own run control context.

| VS Code   | TCF resume mode (default) | TCF resume mode (instruction granularity) |
| --------- | ------------------------- | ----------------------------------------- |
| Step Over | `RM_STEP_OVER_LINE` (3)   | `RM_STEP_OVER` (1)                        |
| Step Into | `RM_STEP_INTO_LINE` (4)   | `RM_STEP_INTO` (2)                        |
| Step Out  | `RM_STEP_OUT` (5)         | `RM_STEP_OUT` (5)                         |

## Breakpoints

| VS Code                 | TCF breakpoint properties                                         |
| ----------------------- | ----------------------------------------------------------------- |
| Source line breakpoint  | `File` (path as in VS Code), `Line`, `Column`                     |
| Function breakpoint     | `Location` = the function name (any expression the agent accepts) |
| Data breakpoint         | `Location` = address, `Size`, `AccessMode` read/write             |
| Instruction breakpoint  | `Location` = address, `ContextIds` = the process and its threads  |
| Condition               | `Condition`, evaluated by the agent                               |
| Hit count `N` or `>= N` | `IgnoreCount` = N - 1 (break from the N:th hit)                   |
| Logpoint                | a normal breakpoint, the message is printed by the extension      |

The contexts of a
[scoped function breakpoint](/debugging/breakpoints#limit-a-function-breakpoint-to-selected-contexts)
are sent as the breakpoint's `ContextIds`, and a context query as its
`ContextQuery`.
