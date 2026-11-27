# Limitations

- No exception breakpoints.
- Breakpoints created by other TCF clients (or the Simics CLI) are not shown.
- Variables and registers are read-only, there is no **Set Value**.
- `char *` and `char[]` are not shown as strings; expand them to see the
  characters.
- No **Restart Frame**.
- The `pathMap` rules of the debug configuration are read when attaching. Use
  the [Path Maps view](/configuration/path-mapping#the-path-maps-view) to
  change the rules of a running session. Rules added in Simics while attached
  apply to new breakpoints only.
- Only TCP transport.
