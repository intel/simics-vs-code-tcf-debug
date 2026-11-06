---
name: tcf
description: TCF (Target Communication Framework) protocol and service reference for this extension's TCF client (src/tcf/), and a CLI to run TCF commands on a live agent. Use when adding or changing TCF commands, events or service wrappers, reading TCF traces, looking up what a TCF service command takes and returns, or checking what a running TCF agent (e.g. Simics on localhost:1534) really replies.
argument-hint: TCF service, command, event, wire protocol
---

# TCF-cli tool for the Simics VS Code debugger

This extension is a TCF *client*. It connects over TCP to a TCF agent (usually
the Simics TCF agent), and translates DAP requests to TCF commands and TCF
events to DAP events. It provides no services of its own.

## Official documentation

Fetch the spec page before adding or changing a command: do not guess argument
order, reply fields or property names.

- [TCF Specification](https://download.eclipse.org/tools/tcf/tcf-docs/TCF%20Specification.html)
  (wire protocol, `Locator.Hello`),
  [Syntax Rules Notation](https://download.eclipse.org/tools/tcf/tcf-docs/TCF%20Syntax%20Rules%20Notation.html),
  [Error Report Format](https://download.eclipse.org/tools/tcf/tcf-docs/TCF%20Error%20Report%20Format.html),
  [Context Identifiers](https://download.eclipse.org/tools/tcf/tcf-docs/TCF%20Context%20Identifier%20Explanation.html),
  [TCF Services](https://download.eclipse.org/tools/tcf/tcf-docs/TCF%20Services.html).
- Service pages:
  `https://download.eclipse.org/tools/tcf/tcf-docs/TCF%20Service%20-%20<Name>.html`,
  with the readable name (`Run Control`, `Stack Trace`, `Line Numbers`,
  `Memory Map`, `Path Map`, `Context Query`). The Java API at the end lists the
  wire name (`NAME`) and property names (`PROP_*`).
- Raw HTML, also when the site is down:
  `https://gitlab.eclipse.org/eclipse/tcf/tcf/-/raw/master/docs/<file name>`.
  The web fetch drops anchors, so find them there (`#Cmd<Name>`, `#Events`,
  `#prop<Name>`, some with typos such as `#propeEnabled`).
- Where the spec is vague, the reference agent shows the real behavior:
  <https://gitlab.eclipse.org/eclipse/tcf/tcf.agent>
  (`agent/tcf/services/*.c`).

When answering, link every claim to where it is defined or implemented, with
verified line numbers: the spec page with its anchor, the reference agent on
GitLab, or workspace-relative links into this repo (the links in this skill are
relative to the skill file).

## Protocol basics

- TCP; the Simics tcf-agent listens on port 1534 by default. A message is
  zero-terminated fields, each one JSON value. Binary data is base64 (this
  client never announces `ZeroCopy`).
- Message types (`•` = zero byte):
  `C • <token> • <service> • <command> • <args...>`,
  `R • <token> • <results...>` (final), `P` (progress), `N • <token>` (unknown
  service or command, or sent before the channel is connected),
  `E • <service> • <event> • <args...>`, `F` (flow control). Replies are
  matched to commands by token only.
- Both peers send `E • Locator • Hello • <service names>` first. Check the
  peer's list before using optional services such as `ContextQuery`.
- Most replies start with an error report: empty or `null` on success (parsed
  as `undefined`), else an object with `Code`, `Format`, `Params`, ... Some
  replies put it in a later field (for example `Memory.get`), so read the reply
  syntax on the service page.
- Addresses and PCs are 64-bit integers as plain JSON numbers, which lose
  precision in `JSON.parse`.

## Contexts

- A context ID is an opaque string; do not parse it. The same ID is valid
  across services, each with its own properties of it.
- Walk hierarchies with `getChildren(<parent>)` and `getContext(<ID>)`.
  `RunControl` and `Memory` take `""` as the root; `Registers` and `StackTrace`
  are rooted in `RunControl` contexts. `ContextQuery.query` selects contexts,
  e.g. `**/HasState=true`.
- `containerSuspended • <ID> • <PC> • <reason> • <state data> • <IDs>` replaces
  `contextSuspended` for all `<IDs>`, but PC, reason and state data are only
  for the trigger `<ID>`; get the others with `getState` (`getMinState` has no
  PC). `containerResumed` is the same for resume.
- In Simics, all contexts with state run or stop together, so the agent sends
  only `containerSuspended`/`containerResumed`, listing every context with
  `HasState`. It also sends them while the simulation keeps running: around a
  proxy lock, and as a pair to refresh clients (e.g. after loading a snapshot).
  The trigger is a context asked to suspend (step, breakpoint), else the OS
  awareness node or the stopping CPU.
- Simics `getState`: `suspended` is the state of the whole simulation. A PC
  that cannot be read comes back as 0 without `PCError`.

## Services

Each standard service has a spec page (see above) with its commands, events
and properties, and a wrapper class in
[src/tcf/services/](../../../src/tcf/services/). Check both before using a
service.

The Simics tcf-agent also has specific services, which are not on the Eclipse
site, and require access to the Simics source.

## This repo's TCF client

The client is in [src/tcf/](../../../src/tcf/): `TcfChannel` in channel.ts,
JSON with `bigint` in json.ts, one wrapper per service in services/. Their doc
comments explain which call to use.

To add a command or event: read its spec page, add a method to the service
wrapper, pick `command` or `sendCommand` from the reply syntax, use `bigint`
for addresses, check `hasService` if the service is optional, and add a unit
test.

## Running commands on a live agent

[scripts/tcf-cli.ts](../../../scripts/tcf-cli.ts) connects to an agent with the
extension's `TcfChannel` and service wrappers. Use it when the user asks what
an agent replies, or to check a reply shape before coding against it.
`npm run -s compile:tcf-cli -- --help` lists the options, `help()` the helpers.

- One-off: `npm run -s compile:tcf-cli -- [--host H] [--port P] -e '<js>'`,
  where the JavaScript is the body of an async function with the helpers in
  scope, or a `.js` file path instead of `-e`.
- Session: `npm run -s compile:tcf-cli` starts a REPL with top-level `await`.
  Run it in async mode and send one line at a time with `waitForOutput`.
- Helpers: `cmd(service, command, ...args)` (checks the error report),
  `raw(...)` (all fields unchecked), `services()`, `contexts()`,
  `tree(service, root)`, wrappers
  `rc bp mem mmap regs st expr sym lines pmap dis cl`, `print` (keeps 64-bit
  integers), `hex`.
- Events are recorded from connecting on: `events()`, `mark()`,
  `waitEvent(service, event, timeoutMs, after)`; take `mark()` before the
  command that triggers the event. `live()` and `trace()` print as messages
  come. Timeouts are 10 s (`--timeout MS`).
- Example: `npm run -s compile:tcf-cli -- -e 'await tree("RunControl", "")'`

Reading is fine. Ask the user every time before anything that changes the
target or the session: `resume`, `suspend`, `set` commands, adding or changing
breakpoints, and Simics-specific commands that are not plain reads. An open VS
Code debug session keeps working, but sees the effects.
