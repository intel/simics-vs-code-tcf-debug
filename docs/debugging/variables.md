# Variables and expressions

The agent does all parsing and evaluation of variables and expressions.
Values are read when the thread is suspended and are refreshed after each
resume or step.

## Local variables

The **Locals** scope in the Variables view lists the local variables and
arguments of the selected stack frame.

- Values are formatted using their type: integers, characters, booleans,
  enumerators (by name), floating point numbers and pointers. Structs, unions
  and arrays are summarized as `{...}` and `[N]`.
- Structs, unions, arrays and non-null pointers can be expanded. Pointers to
  structs expand directly to the members. Arrays with more than 100 elements
  are shown in pages.

To see what a pointer points to, or where any other variable is stored,
right-click it and select **Open in Target Memory**, see
[Target Memory](/debugging/target-memory).

## Registers

The **Registers** scope shows the registers of the selected frame as a tree.
Register groups without a readable value (for example Simics register groups)
are shown as expandable groups. Registers with fields can be expanded to show
the fields.

## Watch, hover and the Debug Console

Watch expressions, hovers and expressions typed in the Debug Console are
evaluated in the selected frame. **Add to Watch** and **Copy as Expression**
use a readable expression such as `s->corners[2].x`.

## Limitations

- Variables and registers are read-only, there is no **Set Value**.
- `char *` and `char[]` are not shown as strings; expand them to see the
  characters.
