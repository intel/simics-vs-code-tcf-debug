import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { suggestSymbolPaths } from "../src/symbolPath";

test("suggests workspace-relative and absolute symbol paths", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tcf-symbol-path-"));
    try {
        await fs.mkdir(path.join(workspace, "build"));
        await fs.mkdir(path.join(workspace, "backup"));
        await fs.writeFile(path.join(workspace, "build", "firmware.elf"), "");
        await fs.writeFile(path.join(workspace, "build", "other.elf"), "");

        assert.deepEqual(await suggestSymbolPaths("b", workspace), [
            { path: "backup", directory: true },
            { path: "build", directory: true },
        ]);
        assert.deepEqual(await suggestSymbolPaths("build/fi", workspace), [
            { path: path.join("build", "firmware.elf"), directory: false },
        ]);
        assert.deepEqual(await suggestSymbolPaths(path.join(workspace, "build") + path.sep), [
            { path: path.join(workspace, "build", "firmware.elf"), directory: false },
            { path: path.join(workspace, "build", "other.elf"), directory: false },
        ]);
        assert.deepEqual(await suggestSymbolPaths("build/fi"), []);
        assert.deepEqual(await suggestSymbolPaths("agent-only/firmware.elf", workspace), []);
    } finally {
        await fs.rm(workspace, { recursive: true, force: true });
    }
});
