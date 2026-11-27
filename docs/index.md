---
layout: home

hero:
  name: Simics Target Debug
  text: Debug targets through a TCF agent
  tagline: A VS Code debugger extension that connects to a TCF agent, such as the Simics TCF agent.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/intel/simics-vs-code-tcf-debug

features:
  - title: Call stack
    details: Processors and, with OS awareness, the processes and threads of the operating system, in a tree that follows the structure of the target.
    link: /debugging/call-stack
  - title: Breakpoints
    details: Source line, function, data and instruction breakpoints, with conditions, hit counts and logpoints. Function breakpoints can be limited to selected contexts.
    link: /debugging/breakpoints
  - title: Variables and expressions
    details: Local variables, registers, watch expressions and hovers, evaluated by the agent in the selected frame.
    link: /debugging/variables
  - title: Disassembly
    details: Decoded instructions with function headers, instruction breakpoints and stepping by instruction.
    link: /debugging/disassembly
  - title: Target Memory
    details: A hex view to inspect, edit and search the memory of a thread or a physical memory space.
    link: /debugging/target-memory
  - title: Simics console
    details: The Simics command line in a VS Code terminal, on the connection of the debug session.
    link: /debugging/simics-console
  - title: Snapshots
    details: Take, restore and delete Simics snapshots from a view in Run and Debug.
    link: /debugging/snapshots
  - title: Symbol files
    details: Load symbol files from the debug configuration or during a session, for all contexts or for selected ones.
    link: /configuration/symbol-files
  - title: Path mapping
    details: Map the source paths in the debug information to the files on your host.
    link: /configuration/path-mapping
---
