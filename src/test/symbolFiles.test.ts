import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    applySymbolFiles,
    collectForeignSymbolFiles,
    describeForeignSymbolFile,
    formatSymbolFileAddress,
    parseSymbolFilesConfig,
} from "../symbolFiles";
import { MemoryMapService, MemoryRegionProperties } from "../tcf/services/memoryMap";

// No setting gives no files and no errors. A setting that is not a list
// is an error.
test("parseSymbolFilesConfig accepts no entries", () => {
    assert.deepEqual(parseSymbolFilesConfig(undefined), {
        files: [],
        errors: [],
    });
    assert.deepEqual(parseSymbolFilesConfig(null), { files: [], errors: [] });
    assert.deepEqual(parseSymbolFilesConfig({ path: "/a.elf" }), {
        files: [],
        errors: ['"symbolFiles" must be a list of { "path": ... } entries'],
    });
});

// Context, context query and address (number or hex string) are read.
test("parseSymbolFilesConfig reads valid entries", () => {
    const { files, errors } = parseSymbolFilesConfig([
        { path: "/a.elf" },
        { path: "/b.elf", context: "cpu0", address: 4096 },
        { path: "/c.elf", contextQuery: "Name=cpu*", address: " 0xFFFF0000 " },
        { path: "/d.elf", address: "0x123456789abcdef0" },
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(files, [
        {
            path: "/a.elf",
            context: "",
            contextQuery: undefined,
            address: undefined,
        },
        {
            path: "/b.elf",
            context: "cpu0",
            contextQuery: undefined,
            address: 4096n,
        },
        {
            path: "/c.elf",
            context: "",
            contextQuery: "Name=cpu*",
            address: 0xffff0000n,
        },
        {
            path: "/d.elf",
            context: "",
            contextQuery: undefined,
            address: 0x123456789abcdef0n,
        },
    ]);
});

// Each bad entry is dropped with its own error message. Addresses must be
// safe integers or hex/decimal strings, and non-negative when absolute.
test("parseSymbolFilesConfig reports invalid entries", () => {
    const { files, errors } = parseSymbolFilesConfig([
        {},
        { path: "" },
        { path: "/a.elf", context: 1 },
        { path: "/a.elf", contextQuery: "" },
        { path: "/a.elf", address: -1, absolute: true },
        { path: "/a.elf", address: 1.5 },
        { path: "/a.elf", address: "0x" },
        { path: "/a.elf", address: "-16", absolute: true },
        { path: "/a.elf", address: 2 ** 53 },
        null,
    ]);
    assert.deepEqual(files, []);
    const offset = 'is ignored, "address" must be an integer' + ' or a string like "0x1000" or "-0x1000"';
    const absolute = 'is ignored, an absolute "address" must be a non-negative integer' + ' or a string like "0x1000"';
    assert.deepEqual(errors, [
        'symbolFiles[0] is ignored, it needs a non-empty "path" string',
        'symbolFiles[1] is ignored, it needs a non-empty "path" string',
        'symbolFiles[2] is ignored, "context" must be a string',
        'symbolFiles[3] is ignored, "contextQuery" must be a non-empty string',
        `symbolFiles[4] ${absolute}`,
        `symbolFiles[5] ${offset}`,
        `symbolFiles[6] ${offset}`,
        `symbolFiles[7] ${absolute}`,
        `symbolFiles[8] ${offset}`,
        'symbolFiles[9] is ignored, it needs a non-empty "path" string',
    ]);
});

// Files for the same context share one MemoryMap.set. A missing file only
// gives a warning, since the agent may run on another host.
test("applySymbolFiles sets one memory map per context", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simics-target-debug-test-"));
    const present = path.join(dir, "present.elf");
    fs.writeFileSync(present, "");
    const calls: [string, MemoryRegionProperties[]][] = [];
    const service = {
        set: async (contextId: string, regions: MemoryRegionProperties[]) => {
            calls.push([contextId, regions]);
        },
    } as unknown as MemoryMapService;
    const warnings: string[] = [];

    await applySymbolFiles(
        service,
        [
            { path: present, context: "" },
            { path: "/missing/kernel.elf", context: "cpu0", address: 0x1000n },
            { path: present, context: "", contextQuery: "Name=cpu1" },
        ],
        (message) => warnings.push(message),
    );

    assert.deepEqual(calls, [
        [
            "",
            [
                { ID: "vscode-symbol-file-1", FileName: present },
                {
                    ID: "vscode-symbol-file-3",
                    FileName: present,
                    ContextQuery: "Name=cpu1",
                },
            ],
        ],
        [
            "cpu0",
            [
                {
                    ID: "vscode-symbol-file-2",
                    FileName: "/missing/kernel.elf",
                    BaseAddress: 0x1000n,
                },
            ],
        ],
    ]);
    assert.deepEqual(warnings, ["Symbol file /missing/kernel.elf does not exist on this host"]);
});

// "address" is an offset by default, like add-symbol-file -relative, so it
// may be negative. "absolute" opts in to a load address and needs an address.
test("parseSymbolFilesConfig reads offsets and absolute addresses", () => {
    const { files, errors } = parseSymbolFilesConfig([
        { path: "/a.elf", address: "0x1000" },
        { path: "/b.elf", address: "-0x300000" },
        { path: "/c.elf", address: -16 },
        { path: "/d.elf", address: "0xff000", absolute: true },
        { path: "/e.elf", address: "0x1000", absolute: false },
        { path: "/f.elf", absolute: true },
        { path: "/g.elf", address: "0x1000", absolute: "yes" },
        { path: "/h.elf", address: "-" },
    ]);
    assert.deepEqual(files, [
        { path: "/a.elf", context: "", contextQuery: undefined, address: 0x1000n },
        { path: "/b.elf", context: "", contextQuery: undefined, address: -0x300000n },
        { path: "/c.elf", context: "", contextQuery: undefined, address: -16n },
        { path: "/d.elf", context: "", contextQuery: undefined, address: 0xff000n, absolute: true },
        { path: "/e.elf", context: "", contextQuery: undefined, address: 0x1000n },
    ]);
    assert.deepEqual(errors, [
        'symbolFiles[5] is ignored, "absolute" requires an "address" to load the file at',
        'symbolFiles[6] is ignored, "absolute" must be true or false',
        'symbolFiles[7] is ignored, "address" must be an integer or a string like "0x1000" or "-0x1000"',
    ]);
});

// An offset is sent as BaseAddress (the standard property Simics uses for
// add-symbol-file -relative), an absolute load address as Addr.
test("applySymbolFiles sends offsets as BaseAddress and absolute addresses as Addr", async () => {
    const calls: [string, MemoryRegionProperties[]][] = [];
    const service = {
        set: async (contextId: string, regions: MemoryRegionProperties[]) => {
            calls.push([contextId, regions]);
        },
    } as unknown as MemoryMapService;

    await applySymbolFiles(
        service,
        [
            { path: "/a.elf", context: "", address: -0x300000n },
            { path: "/b.elf", context: "", address: 0xff000n, absolute: true },
        ],
        () => {},
    );

    assert.deepEqual(calls, [
        [
            "",
            [
                { ID: "vscode-symbol-file-1", FileName: "/a.elf", BaseAddress: -0x300000n },
                { ID: "vscode-symbol-file-2", FileName: "/b.elf", Addr: 0xff000n },
            ],
        ],
    ]);
});

test("formatSymbolFileAddress shows offsets with a sign", () => {
    assert.equal(formatSymbolFileAddress({}), undefined);
    assert.equal(formatSymbolFileAddress({ address: 0x1000n }), "+0x1000");
    assert.equal(formatSymbolFileAddress({ address: -0x300000n }), "-0x300000");
    assert.equal(formatSymbolFileAddress({ address: 0xff000n, absolute: true }), "0xff000");
});

// The region IDs get the given prefix, so a session can recognize its own
// regions in MemoryMap.get results.
test("applySymbolFiles uses the ID prefix", async () => {
    const calls: [string, MemoryRegionProperties[]][] = [];
    const service = {
        set: async (contextId: string, regions: MemoryRegionProperties[]) => {
            calls.push([contextId, regions]);
        },
    } as unknown as MemoryMapService;

    await applySymbolFiles(service, [{ path: "/a.elf", context: "" }], () => {}, [], "vscode-symbol-file-abc-");

    assert.deepEqual(calls, [["", [{ ID: "vscode-symbol-file-abc-1", FileName: "/a.elf" }]]]);
});

// Files are grouped by name over all contexts, leaving out own regions and
// regions without a file. Equal regions in several contexts are listed once.
test("collectForeignSymbolFiles groups regions of other clients and the target by file", () => {
    const files = collectForeignSymbolFiles(
        [
            {
                context: "cpu0",
                regions: [
                    { ID: "own-1", FileName: "/own.elf" },
                    {
                        ID: "eclipse-1",
                        FileName: "/app.elf",
                        BaseAddress: -0x1000n,
                    },
                    { FileName: "/kernel.elf", relocation: 0x2000 },
                    { Addr: 0x1000, Size: 0x100 },
                ],
            },
            {
                context: "cpu1",
                regions: [
                    { FileName: "/kernel.elf", relocation: 0x2000 },
                    {
                        FileName: "/lib.so",
                        Addr: 0x40000,
                        Size: 0x1000,
                        Offs: 0,
                        SectionName: ".text",
                    },
                    {
                        FileName: "/lib.so",
                        Addr: 0x3f000,
                        Size: 0x800,
                        SectionName: ".data",
                    },
                ],
            },
        ],
        (region) => region.ID === "own-1",
    );
    assert.deepEqual(files, [
        {
            path: "/app.elf",
            contexts: ["cpu0"],
            ids: ["eclipse-1"],
            regions: [{ offset: "-0x1000" }],
        },
        {
            path: "/kernel.elf",
            contexts: ["cpu0", "cpu1"],
            ids: [],
            regions: [{ offset: "+0x2000" }],
        },
        {
            path: "/lib.so",
            contexts: ["cpu1"],
            ids: [],
            regions: [
                { addr: "0x40000", size: "0x1000", section: ".text" },
                { addr: "0x3f000", size: "0x800", section: ".data" },
            ],
        },
    ]);
});

test("describeForeignSymbolFile shows contexts, relocation and lowest address", () => {
    assert.deepEqual(
        describeForeignSymbolFile({
            path: "/app.elf",
            contexts: ["cpu0"],
            ids: ["x-1"],
            regions: [{ offset: "-0x1000" }],
        }),
        {
            description: "cpu0 -0x1000",
            tooltip: "/app.elf\nMapped in: cpu0\nRegion ID: x-1\n  relocated by -0x1000",
        },
    );
    assert.deepEqual(
        describeForeignSymbolFile(
            {
                path: "/lib.so",
                contexts: ["p1", "p2"],
                ids: [],
                regions: [
                    { addr: "0x40000", size: "0x1000", section: ".text" },
                    { addr: "0x3f000", size: "0x800" },
                    { addr: "0x50000" },
                ],
            },
            2,
        ),
        {
            description: "2 contexts @ 0x3f000",
            tooltip: "/lib.so\nMapped in: p1, p2\n  0x40000+0x1000 .text\n  0x3f000+0x800\n  ... 1 more regions",
        },
    );
    assert.equal(
        describeForeignSymbolFile({
            path: "/a.elf",
            contexts: ["c"],
            ids: [],
            regions: [{}],
        }).description,
        "c",
    );
});
