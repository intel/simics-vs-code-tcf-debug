---
name: git-commit-message
description: Rules for writing git commit messages and stg patch messages - short subject line, blank line, body wrapped at 72 columns, and a body that explains why the change is made rather than what it does. Use when writing or editing a commit message (git commit, stg new -m, stg edit -m, stg refresh -m) or when asked to update a patch message.
---

# Git commit messages

## Format

- **Subject line**: at most 50 characters, never more than 72.
  - Imperative mood: "Add", "Fix", "Remove", not "Added" or "Fixes".
    It should complete the sentence "If applied, this commit will ...".
  - Capital first letter, no period at the end.
- **Blank line** between subject and body.
- **Body**: wrap at 72 columns. Only leave out the body for trivial
  changes, such as a typo fix.
- Plain text. No Markdown headings; simple `-` lists are fine.
- Put issue references (for example a Jira key) in the body, not in
  the subject.

## Content: explain why, not what

The diff already shows what changed. The message must tell the reader
why the change is needed:

- What problem, bug or need led to the change?
- Why this solution? If there were other options, say briefly why they
  were not chosen.
- Side effects, limits, or anything a reviewer may find surprising.

Describe what changed only as much as the reader needs to follow the
reasons. Do not list the changed files or functions.

## Style: short and simple

In most cases, keep the message fairly short: a few short paragraphs
at most, one point per sentence. Use very basic English: common words,
short sentences, no jargon or fancy phrases. Readers may not have
English as their first language.

Bad (only says what changed):

```
Update .prettierrc.json and package.json

Remove singleQuote from .prettierrc.json. Change the format script
to prettier --write . and add .prettierignore.
```

Good (says why):

```
Use double quotes and format the whole repo

Double quotes are Prettier's default and what Python and C use, so
code looks the same across languages. Formatting the whole repo keeps
JSON, YAML and CSS files consistent too, not only TypeScript.
```

## Check before you finish

Print the message and check that no line is longer than 72 characters
(the command should print nothing):

```bash
git log -1 --format=%B | awk 'length > 72'
git log -1 --format=%B $(stg id <patch>) | awk 'length > 72'   # stg patch
```

Also check that the subject line is at most 50 characters.
