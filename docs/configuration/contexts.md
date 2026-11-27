# Selecting contexts

A context is a part of the target that the agent debugs, such as a processor
core or, with OS awareness, a process or a thread.
[Symbol files](/configuration/symbol-files),
[path map rules](/configuration/path-mapping) and
[function breakpoints](/debugging/breakpoints#limit-a-function-breakpoint-to-selected-contexts)
apply to all contexts unless you select some of them. All three select
contexts in the same way.

## Ways to select contexts

- **All contexts** is the default.
- **Listed contexts** are given by their context IDs. Symbol files also take
  context names.
- A **context query** is a TCF context query. The agent finds the contexts
  that match it.

In `launch.json`, symbol files and path map rules have the attributes
`contexts` and `contextQuery` for this:

```json
{ "path": "build/app.elf", "contexts": ["board.mb.cpu0.core[0][0]"] },
{ "path": "build/driver.elf", "contextQuery": "**/HasState=true" }
```

Use one of them, not both. An entry with both is ignored, with an error in
the Debug Console. The older `context`, a single context, still works but is
deprecated; use `contexts` instead.

A function breakpoint has its contexts in its name, see
[Breakpoints](/debugging/breakpoints#limit-a-function-breakpoint-to-selected-contexts).

## Context queries

A context query is evaluated by the agent. Some examples:

| Query                      | Selects                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `**/HasState=true`         | All contexts that can run and be stopped, for example all processors.       |
| `/server/**/HasState=true` | Such contexts below the top-level context named `server`.                   |
| `ID=cpu0`                  | The context with the ID `cpu0`.                                             |
| `ID=cpu0,HasState=true`    | The context with the ID `cpu0`, if it can run and be stopped.               |

The syntax is described with the Context Query service in the
[TCF documentation](https://download.eclipse.org/tools/tcf/tcf-docs/).

## The context picker

While debugging, the commands that need contexts open the same picker. It
first offers:

- The current selection, when you edit something that has contexts or a
  query.
- **All contexts**.
- The context that is selected in the Call Stack view.
- **Pick Contexts...**, which shows a checklist of the contexts of the
  session that can run, such as its processor cores.
- **Context Query...**, which asks for a query.

The checklist and the query have a Back button to the first step.

In the checklist:

- Accepting with nothing checked selects all contexts.
- Checked contexts that are not in the current session stay listed, so they
  are not dropped by accident.
- For symbol files and path map rules, you can type a context that is not
  listed and check it: an ID or a name for symbol files, an ID for path map
  rules.

The [launch configurations editor](/configuration/launch-configurations#symbol-files-and-path-map-tables)
has a **Contexts** column with the same choices.
