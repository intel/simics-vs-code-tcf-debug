# Simics Target Debug for VS Code

<table border="0">
  <tr>
    <td align="left" border="0" valign="middle">
      <a href="https://github.com/intel/simics-vs-code-tcf-debug/actions/workflows/test.yml"><img src="https://github.com/intel/simics-vs-code-tcf-debug/actions/workflows/test.yml/badge.svg" alt="Tests" align="middle"></a>&nbsp;
      <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" align="middle"></a>&nbsp;
      <a href="https://github.com/intel/simics-vs-code-tcf-debug/actions/workflows/codeql.yml"><img src="https://github.com/intel/simics-vs-code-tcf-debug/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" align="middle"></a>&nbsp;
      <a href="https://scorecard.dev/viewer/?uri=github.com/intel/simics-vs-code-tcf-debug"><img src="https://api.securityscorecards.dev/projects/github.com/intel/simics-vs-code-tcf-debug/badge" alt="OpenSSF Scorecard" align="middle"></a>&nbsp;
      <a href="https://www.bestpractices.dev/projects/16330"><img src="https://www.bestpractices.dev/projects/16330/badge" alt="OpenSSF Best Practices" align="middle"></a>
    </td>
  </tr>
</table>

Debug software running in Simics, or on any other
[TCF](https://download.eclipse.org/tools/tcf/tcf-docs/) agent, from VS Code.
The extension uses only standard TCF services, so Simics-specific features
(the Simics CLI and snapshots) are simply unavailable on other agents.

## Documentation

The user guide is at <https://intel.github.io/simics-vs-code-tcf-debug/>.
Start with [Getting started][getting-started], which shows how to install
the extension, start a TCF agent in Simics and attach to it.

## Features

- **[Call stack][call-stack]** – processors, and with OS awareness processes
  and threads, shown as a tree.
- **[Stepping][stepping]** – step over, into and out by source line, or by
  instruction in the Disassembly view.
- **[Breakpoints][breakpoints]** – line, function, data, instruction and
  logpoints, with conditions and hit counts. Function breakpoints can be
  limited to some cores.
- **[Variables and expressions][variables]** – locals, registers, hovers and
  expressions in the Debug Console, evaluated by the agent in the selected
  frame.
- **[Disassembly][disassembly]** – the instructions of a stack frame's code,
  with instruction breakpoints.
- **[Target Memory][target-memory]** – a hex editor for target memory, with
  search and go to address.
- **[Simics console][simics-console]** – the Simics command line in a
  terminal.
- **[Snapshots][snapshots]** – take, restore and delete Simics snapshots.

A debug session is set up with a [launch configuration][launch], which can
load [symbol files][symbol-files] and [map source paths][path-mapping].
Options shared by all sessions are [settings][settings]. See also the
[limitations][limitations].

## Development

Requires Node.js 24 or later and npm. Run the commands from the repository
root.

Install the dependencies:

```sh
npm ci
```

Build, test and package:

```sh
npm run build     # type check and bundle the extension
npm test          # run the unit tests
npm run package   # create simics-target-debug-<version>.vsix
```

Format the code with Prettier before committing:

```sh
npm run format
```

Other useful commands:

```sh
npm run check               # type check and run the unit tests
npm run watch               # rebuild on changes
npm run compile:production  # minified bundle without source maps
```

To develop in VS Code, open the repository, select **Run Extension** in the
Run and Debug view and press F5. This starts `npm run watch` and opens an
Extension Development Host with the extension loaded. **Run Extension
(Clean)** does the same with all other extensions disabled.

### Documentation

The user guide is a [VitePress](https://vitepress.dev/) site, built from the
Markdown files in `docs/`.

```sh
npm run docs:develop       # serve the site, pages reload when edited
npm run docs:build         # build the site into docs/.vitepress/dist/
npm run docs:screenshots   # make the pictures in docs/images/ again
```

The pictures are screenshots made by a script. When the UI changes, make
them again as
[.github/skills/docs-screenshots/SKILL.md](.github/skills/docs-screenshots/SKILL.md)
describes.


<!-- REFERENCES -->
[getting-started]: https://intel.github.io/simics-vs-code-tcf-debug/getting-started.html
[call-stack]: https://intel.github.io/simics-vs-code-tcf-debug/debugging/call-stack.html
[stepping]: https://intel.github.io/simics-vs-code-tcf-debug/debugging/stepping.html
[breakpoints]: https://intel.github.io/simics-vs-code-tcf-debug/debugging/breakpoints.html
[variables]: https://intel.github.io/simics-vs-code-tcf-debug/debugging/variables.html
[disassembly]: https://intel.github.io/simics-vs-code-tcf-debug/debugging/disassembly.html
[target-memory]: https://intel.github.io/simics-vs-code-tcf-debug/debugging/target-memory.html
[simics-console]: https://intel.github.io/simics-vs-code-tcf-debug/debugging/simics-console.html
[snapshots]: https://intel.github.io/simics-vs-code-tcf-debug/debugging/snapshots.html
[launch]: https://intel.github.io/simics-vs-code-tcf-debug/configuration/launch-configurations.html
[symbol-files]: https://intel.github.io/simics-vs-code-tcf-debug/configuration/symbol-files.html
[path-mapping]: https://intel.github.io/simics-vs-code-tcf-debug/configuration/path-mapping.html
[settings]: https://intel.github.io/simics-vs-code-tcf-debug/configuration/settings.html
[limitations]: https://intel.github.io/simics-vs-code-tcf-debug/reference/limitations.html
