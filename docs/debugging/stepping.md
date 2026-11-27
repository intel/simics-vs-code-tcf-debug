# Stepping

**Step Over** and **Step Into** step by source line, and **Step Out** steps
out of the current function. When VS Code asks for instruction granularity,
as it does while the Disassembly view has focus, Step Over and Step Into step
by instruction instead.

## What line stepping needs

Line stepping requires that the agent knows the symbol files for the target,
for example loaded with `add-symbol-file` in Simics or with
[`symbolFiles`](/configuration/symbol-files) in the debug configuration.

If the context does not support line stepping, instruction stepping is used
instead. The Simics agent itself falls back to instruction stepping when
there is no line information for the current PC.

## Things to know

- A line step only completes when execution reaches another line, so
  stepping over a line that loops forever keeps the target running until it
  is paused.
- A line can have several code addresses (for example several line table
  rows for one statement), and the agent plants a line breakpoint at all of
  them. A step from the first address then stops at the next one on the same
  line with reason "breakpoint"; step again to continue.
- A step that is interrupted by a [logpoint](/debugging/breakpoints#logpoints)
  stops there.

The TCF resume mode used for each step is listed in
[TCF services](/reference/tcf-services#stepping).
