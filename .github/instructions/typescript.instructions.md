---
description: "Formatting rules for TypeScript code: run Prettier on every file you create or change."
applyTo: "**/*.{ts,tsx}"
---

# TypeScript formatting

The repo uses Prettier. The config is in `.prettierrc.json`:
120 columns, 4-space indent. Prettier defaults apply otherwise
(double quotes, semicolons, trailing commas, `(x) => ...` with parens).

All TypeScript files in `src/` and `test/` are Prettier-formatted.
After you create or change a `.ts` or `.tsx` file, run Prettier on it:

```
npx prettier --write ./src/path/to/file.ts
```

Read the file back first if you just created it, so the shell does not
see an empty file. `npm run format` formats all files in the repo,
except those listed in `.prettierignore`.
