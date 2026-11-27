# Disassembly

When the agent offers the `Disassembly` service, open a stack frame's context
menu and select **Open Disassembly View**. The view shows decoded
instructions, and opcode bytes when the agent provides them. It works without
source files.

The view shows the code of the context of the frame it was opened from, so
several CPUs can be inspected.

Click left of an instruction to set an
[instruction breakpoint](/debugging/breakpoints#instruction-breakpoints).
While the view has focus, the step commands
[step by instruction](/debugging/stepping).

## Function headers

Function entries get a header row, like in `objdump`, when the agent offers
the `Symbols` service. VS Code shows the header through its source line
support, which puts the line number first:

- `22: dummy-prog1.c: <start>` gives the source line and file of the entry.
- `1: <start>` is shown when there is no line information.

Double-clicking a header opens a read-only document with the header on that
line. Inlined functions get no header.

The headers need the VS Code setting `debug.disassemblyView.showSourceCode`,
which is on by default. Turn them off with the setting
`simics-target-debug.disassembly.functionHeaders`, see
[Settings](/configuration/settings), to save the symbol lookups.

## Instruction sets with variable length

On instruction sets with variable length (x86), the instructions before an
address have to be found by decoding from an earlier address, which can get
out of step with the real instructions. The extension keeps decoding in step
with addresses known to start an instruction: PCs where a context stopped,
and line starts from the debug information.

## Speed

Some agents take long per request, for example with slow symbol lookup in
large modules, so the disassembly is cached per context. Code rarely changes,
so the cache is kept when stepping. After a resume or a memory write, cached
instructions are only used once their opcode bytes are found unchanged in
target memory. A memory map change clears the cache.
