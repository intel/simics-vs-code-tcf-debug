---
name: docs-screenshots
description: "How to make the screenshots of the user guide (docs/images/) again with the script in scripts/docs-screenshots/, check them, update the page texts that describe them, and present the result to the user for review. Use when a change alters how the extension looks in VS Code (its views, buttons, command titles, the Target Memory view or the launch configurations editor), when a docs page needs a new or different picture, or when asked to update, regenerate or retake the documentation screenshots or images."
---

# Screenshots of the user guide

The pictures in `docs/images/` are screenshots of VS Code with this extension.
A script makes them, never a person, so that they can be made again when the
UI changes. The files are in `scripts/docs-screenshots/`:

- `run.sh` – the entry point, `npm run docs:screenshots`. It builds the
  extension, downloads the latest stable VS Code, and runs the capture in a
  sandbox.
- `capture.mjs` – drives VS Code with `playwright-core` and takes the
  pictures, one block of code per picture. It prints what each picture shows
  as text.
- `agent.mjs` – a stand-in TCF agent with a made-up target, so no Simics is
  needed.
- `workspace/` – the example workspace that VS Code opens.
- `vscode.mjs` – starts VS Code, and has the settings it runs with.

Nothing in a picture may come from a real target or from the machine that
makes it. This is what the sandbox is for: it shows the workspace as
`/home/user/server`, hides `/home` and `/tmp`, and has no network. Never run
`capture.mjs` in another way, and never edit a picture by hand.

## Requirements

Linux with `bwrap`, `xvfb-run`, `pngquant`, `curl` and `tar`, and `npm ci`
done. The script needs network access to look up and download VS Code for
x86_64. To use another VS Code, for example on another kind of machine or
without network access, set `VSCODE_BIN` to the `code` executable of an
unpacked one. If something is missing, tell the user. Do not work around the
sandbox.

## Steps

1. Run `npm run docs:screenshots`. It takes a minute or two, and longer when
   it first downloads a VS Code version (about 1 GB unpacked) into
   `.tmp/docs-screenshots/`.
2. If it fails, see [When the capture fails](#when-the-capture-fails), fix
   the cause and run it again.
3. Read the list at the end of the output. Each picture is `unchanged`,
   `changed` or `new`. Unchanged pictures are left exactly as committed: the
   same view differs in a few pixels between runs, so at most 10 clearly
   different pixels count as unchanged. On a machine with other fonts, all
   pictures change. That is fine, but say so in the review.
4. Read `.tmp/docs-screenshots/capture.log`:
   - `unknown commands:` should say `none`. If not, see below.
   - Every `badge N ... covers:` line says `nothing`.
   - The text under `--- <view>` and `=== <picture>` is what the picture
     shows. Check that it is what the page says.
5. Look at every changed and new picture, next to the committed one in
   `.tmp/docs-screenshots/before/`. Check that:
   - it shows what the page describes, and no text that matters is cut off,
   - each numbered mark is on the right element and covers nothing,
   - it shows only example data, such as `/home/user/server`,
     `localhost:1534` and `simics-lab.example.com`: no title bar, no real
     path, user name or host name.
6. Update the text of the pages, see the table below. The pages name buttons
   "from the left": the order is on the `title buttons:` lines of the log.
7. Run `npm run docs:build`.
8. Present the result for review, see the next section.

| Picture                     | Page                                          | Text that describes it                         |
| --------------------------- | --------------------------------------------- | ---------------------------------------------- |
| `overview.png`              | `docs/getting-started.md`                     | The numbered list below it                     |
| `call-stack.png`            | `docs/debugging/call-stack.md`                | The two text trees of the example above it     |
| `breakpoints.png`           | `docs/debugging/breakpoints.md`               | The sentence that names the two marked buttons |
| `target-memory.png`         | `docs/debugging/target-memory.md`             | The numbered list below it                     |
| `snapshots.png`             | `docs/debugging/snapshots.md`                 | The buttons, from the left                     |
| `consoles.png`              | `docs/debugging/simics-console.md`            | The buttons                                    |
| `context-picker.png`        | `docs/configuration/contexts.md`              | The list of what the picker offers             |
| `launch-configurations.png` | `docs/configuration/launch-configurations.md` | The numbered list below it                     |
| `symbol-files.png`          | `docs/configuration/symbol-files.md`          | The buttons, from the left                     |
| `path-maps.png`             | `docs/configuration/path-mapping.md`          | The buttons, from the left                     |

## Present the result for review

Do this every time, also when the pictures look right to you. A person sees
things in a picture that a check of its text does not find. Do not commit
before the user has answered.

Write the user a message with:

1. One line for each changed and new picture: a link to the file, and what
   differs from the committed picture, in words. Then the pictures that did
   not change.
2. The VS Code version of the pictures, from the first line of the log.
3. What you changed in the text of the pages, and why.
4. What you changed in `scripts/docs-screenshots/`, and why.
5. What you could not check, and what looks odd to you, also if you are not
   sure that it is wrong.
6. How to look at the pictures: the Source Control view shows each changed
   picture before and after, and `npm run docs:develop` shows them in the
   pages.

Then ask the user to approve the pictures or to say what to change. After a
change, run the script again and present again. Commit when the user has
approved, see the `git-commit-message` skill.

## When the capture fails

The log has a `FAILED:` line and, under `=== at failure`, what the window
showed. `.tmp/docs-screenshots/out/failure.png` is the window at that moment,
and `out/raw/` has the pictures taken until then. `docs/images/` is not
touched by a run that fails.

- `command "..." not found` – a command title changed in `package.json`. Use
  the new title in `capture.mjs`.
- A timeout that names a selector – a label, a view or a control changed.
  `capture.mjs` finds elements by their labels and by CSS classes of VS Code
  and of the webviews in `src/webview/`. Update the selector.
- `badge N covers ...` – a numbered mark would hide something. The lines
  before it list what each other place covers. Pick a free one in the
  `callouts([...])` call of that picture.
- `callout N is outside the picture` – the marked element moved out of the
  area that the picture shows.
- `unknown commands: Service.command` (not a failure) – the extension sent a
  TCF command that the stand-in agent does not know, and got "not supported".
  If a picture needs its data, add a handler to `handlers` in `agent.mjs`. The
  `tcf` skill has the reply formats.
- `agent errors:` – a handler in `agent.mjs` threw. Fix it.

## Changing what the pictures show

- **Another picture.** Add a block to `capture.mjs` that brings VS Code into
  the state to show and ends with `shot("<name>", <area>)`, and use it in the
  page as `![what it shows](../images/<name>.png)`. The pictures have two
  pixels per point. A picture that is narrower than the page needs
  `{width=N}` after it, with half its pixel width, or it is shown twice as
  large as the others. Add the picture to the table above.
- **Numbered marks.** `callouts([[number, element, place], ...], area)` draws
  them. Explain each number in a list below the picture.
- **The example target.** Its contexts, call stacks, variables, memory and
  snapshots are in `agent.mjs`, the source file and `launch.json` in
  `workspace/`. Keep all of it made up, and in step with the examples in the
  text of the pages.
- **A picture that is no longer needed.** Remove its block, its file and its
  use in the page. The list at the end of a run names files in `docs/images/`
  that the run did not make.

Things to know when you change `capture.mjs`:

- Screenshots do not show what happens on hover. To show the buttons of a
  view or of a row, give the list the keyboard focus, as the view pictures do.
  `park()` moves the pointer to the title bar, where it hovers nothing.
- The title bar, the top 30 points of the window, says "Extension Development
  Host". Keep it out of every picture.
- A picture must look the same in every run. Wait for things to settle
  (`scrollbarsFaded()`), and put VS Code into a state that does not depend on
  timing. Settings that help with that go into `SETTINGS` in `vscode.mjs`.
  Run the script twice to check: both runs must end with the same list, with
  the same number of pixels for each changed picture.
